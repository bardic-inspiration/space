// Batches on disk (spec 10.1): a variant hash and a seed range. `batch.yaml`
// says what was run, and `records.jsonl` holds one line per seed, in seed
// order. A record holds no clock and no machine, so a batch run again on the
// same core gives the same file (S12).

import { parse, stringify } from 'yaml';
import { CORE_COMMIT } from '../core.ts';
import { canonical, digest } from '../engine/input.ts';
import type { Project } from '../project/project.ts';
import { STUDIO_FORMAT } from '../project/schemas.ts';
import { failed, type BatchRecord, type MetricsDoc } from './metrics.ts';

export interface BatchDoc {
  format: number;
  variant: { id: string; hash: string };
  ruleset: string;
  core: string;
  seeds: { from: number; to: number };
  /** A hash of the metric definitions the records were measured with. */
  metrics: string;
  ran?: string;
}

export interface Batch {
  /** Its folder: `studio/batches/<ruleset>/<variant>/<hash>`. */
  path: string;
  doc: BatchDoc;
  records: BatchRecord[];
}

export const batchPath = (ruleset: string, variant: string, hash: string): string => `studio/batches/${ruleset}/${variant}/${hash}`;
export const metricsPath = (ruleset: string): string => `studio/metrics/${ruleset}.yaml`;
export const seedsOf = (range: { from: number; to: number }): string[] =>
  Array.from({ length: Math.max(0, range.to - range.from + 1) }, (_, index) => String(range.from + index));

/** A hash of the metric definitions, so a batch knows when they changed under it. */
export const metricsHash = (doc: MetricsDoc | null): Promise<string> => digest(canonical(doc?.metrics ?? {}));

export const recordsText = (records: BatchRecord[]): string => records.map((record) => `${JSON.stringify(record)}\n`).join('');
export const parseRecords = (text: string | undefined): BatchRecord[] =>
  (text ?? '').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as BatchRecord];
    } catch {
      return [];
    }
  });

/** Every batch of a ruleset in the project. */
export function listBatches(project: Project, ruleset: string): Batch[] {
  return project.under(`studio/batches/${ruleset}`).filter((path) => path.endsWith('/batch.yaml')).flatMap((file) => {
    const { doc } = project.studioDoc<BatchDoc>('batch', file);
    const path = file.slice(0, -'/batch.yaml'.length);
    return doc ? [{ path, doc, records: parseRecords(project.text(`${path}/records.jsonl`)) }] : [];
  });
}

/** Writes a batch: what was run, and the records in, in seed order. */
export function writeBatch(project: Project, doc: BatchDoc, records: BatchRecord[], ran?: string): Batch {
  const path = batchPath(doc.ruleset, doc.variant.id, doc.variant.hash);
  const order = new Map(seedsOf(doc.seeds).map((seed, index) => [seed, index]));
  const sorted = [...records].filter((record) => order.has(record.seed)).sort((a, b) => order.get(a.seed)! - order.get(b.seed)!);
  const held = { ...doc, format: STUDIO_FORMAT, core: doc.core || CORE_COMMIT, ...(ran ? { ran } : {}) };
  project.write(`${path}/batch.yaml`, stringify(held));
  project.write(`${path}/records.jsonl`, recordsText(sorted));
  return { path, doc: held, records: sorted };
}

/** The seeds of a range that a batch has no record for yet: what a resumed batch still plays. */
export function missingSeeds(range: { from: number; to: number }, records: BatchRecord[]): string[] {
  const have = new Set(records.map((record) => record.seed));
  return seedsOf(range).filter((seed) => !have.has(seed));
}

export type Stale = 'variant' | 'core' | 'metrics';

/**
 * Why a batch is stale: its variant no longer resolves to its hash, the core
 * commit differs, or the metric definitions changed. Stale batches stay
 * readable and are marked; running again replaces them.
 */
export function staleness(batch: Batch, now: { hash?: string; metrics: string }): Stale[] {
  const why: Stale[] = [];
  if (now.hash !== batch.doc.variant.hash) why.push('variant');
  if (batch.doc.core !== CORE_COMMIT) why.push('core');
  if (now.metrics !== batch.doc.metrics) why.push('metrics');
  return why;
}

/** A numeric column of a batch: a metric, or a field of core's record. */
export interface Column {
  key: string;
  label: string;
  read(record: BatchRecord): number | boolean | string | null;
}

export function columnsOf(batches: Batch[]): Column[] {
  const fields: Column[] = [
    { key: 'decisions', label: 'decisions', read: (record) => (failed(record) ? null : record.decisions) },
    { key: 'events', label: 'events', read: (record) => (failed(record) ? null : record.events) },
    { key: 'forced', label: 'forced', read: (record) => (failed(record) ? null : record.forced) },
    { key: 'options.mean', label: 'options (mean)', read: (record) => (failed(record) ? null : record.options.mean) },
    { key: 'options.max', label: 'options (max)', read: (record) => (failed(record) ? null : record.options.max) },
  ];
  const names = new Set<string>();
  for (const batch of batches) for (const record of batch.records) if (!failed(record)) for (const name of Object.keys(record.metrics)) names.add(name);
  return [...fields, ...[...names].map((name): Column => ({ key: `metric.${name}`, label: name, read: (record) => (failed(record) ? null : record.metrics[name] ?? null) }))];
}

/** The numbers a column holds across records, with booleans as 0 and 1. */
export const numbersOf = (column: Column, records: BatchRecord[]): number[] =>
  records.flatMap((record) => {
    const value = column.read(record);
    return typeof value === 'number' ? [value] : typeof value === 'boolean' ? [Number(value)] : [];
  });

export { parse as parseYaml };
