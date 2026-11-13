// Metrics: CEL expressions over a match, in the language of the rules (S15).
// Each is compiled with `compileExpression` against the variant's registry
// and refused with the errors a rule gets. A batch worker evaluates them by
// walking the finished log once with `apply`.

import {
  CompileError, apply, compileExpression, emptyState, playMatch, showType,
  type Expression, type GameEvent, type MatchRecord, type State, type Value,
} from '../core.ts';
import type { Compiled } from '../engine/input.ts';
import type { Issue } from '../engine/protocol.ts';

export type Fold = 'sum' | 'count' | 'mean' | 'min' | 'max' | 'last' | 'cells';
export const FOLDS: Fold[] = ['sum', 'count', 'mean', 'min', 'max', 'last', 'cells'];
export const ENTRY_TYPES = ['seed', 'global', 'create', 'set', 'destroy', 'ground', 'link', 'unlink', 'roll', 'end', 'intent', 'signal'];

export interface MetricDoc {
  value: string | number | boolean;
  /** When it is sampled. Absent: once, on the final state. */
  at?: { signal: string } | { entry: string };
  /** A bool in the same scope; the sample is skipped when it is false. */
  when?: string | boolean;
  fold?: Fold;
}

export interface MetricsDoc {
  format: number;
  metrics: Record<string, MetricDoc>;
}

export type MetricValue = number | boolean | string | null;

/** One line of `records.jsonl`: core's record, the variant hash, and what the metrics measured. */
export type BatchRecord = (MatchRecord & {
  variant: string;
  metrics: Record<string, MetricValue>;
  /** Per cell metric: `"x,y"` to a count. */
  cells: Record<string, Record<string, number>>;
  /** A metric that could not be evaluated, with core's message. */
  errors?: Record<string, string>;
}) | FailedRecord;

/** A match that threw: no outcome, and core's message. */
export interface FailedRecord {
  ruleset: string;
  version: string;
  scenario: string;
  seed: string;
  variant: string;
  error: string;
}

export const failed = (record: BatchRecord): record is FailedRecord => 'error' in record;

interface Metric {
  name: string;
  value: Expression;
  when?: Expression;
  signal?: string;
  entry?: string;
  fold?: Fold;
  cells: boolean;
}

export interface CompiledMetrics {
  metrics: Metric[];
  /** Each metric's type, for the editor. */
  types: Record<string, string>;
  issues: Issue[];
  /** The kinds whose entities stand on the grid, for the built-in `occupancy`. */
  tokens: { kind: string; field: string }[];
  grid: boolean;
}

const NUMERIC = new Set(['int', 'number']);
const SCALAR = new Set(['int', 'number', 'bool', 'string']);

/** The kinds a default token stands for: those with exactly one `cell` field. */
export function tokenKinds(compiled: Pick<Compiled, 'registry'>): { kind: string; field: string }[] {
  return [...compiled.registry.kinds.values()].flatMap((kind) => {
    const cells = [...kind.fields.values()].filter((field) => field.type.k === 'cell');
    return cells.length === 1 ? [{ kind: kind.name, field: cells[0].name }] : [];
  });
}

/** Checks a metrics document against a compiled variant. A metric that is refused is left out, with its reasons. */
export function compileMetrics(compiled: Pick<Compiled, 'registry' | 'scenario'>, doc: MetricsDoc | null): CompiledMetrics {
  const { registry } = compiled;
  const issues: Issue[] = [];
  const metrics: Metric[] = [];
  const types: Record<string, string> = {};
  for (const [name, metric] of Object.entries(doc?.metrics ?? {})) {
    const path = `metrics.${name}`;
    const before = issues.length;
    const issue = (at: string, message: string) => issues.push({ path: `${path}${at}`, message });
    let vars: Record<string, string> = {};
    let signal: string | undefined;
    let entry: string | undefined;
    if (metric.at && 'signal' in metric.at) {
      signal = metric.at.signal;
      const spec = registry.signals.get(signal);
      if (!spec) issue('.at.signal', `the ruleset declares no signal "${signal}"`);
      else vars = Object.fromEntries([...spec.params].map(([param, type]) => [param, showType(type)]));
    } else if (metric.at) {
      entry = metric.at.entry;
      if (!ENTRY_TYPES.includes(entry)) issue('.at.entry', `"${entry}" is not a type of log entry`);
    }
    const expr = (source: string | number | boolean, at: string, expect?: string): Expression | undefined => {
      try {
        return compileExpression(registry, source, { vars, expect });
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        for (const found of error.issues) issue(at, found.message);
        return undefined;
      }
    };
    const value = issues.length === before ? expr(metric.value, '.value') : undefined;
    const when = metric.when === undefined || issues.length > before ? undefined : expr(metric.when, '.when', 'bool');
    if (value) {
      types[name] = value.type;
      const cells = value.type === 'cell' || value.type === 'list<cell>';
      if (metric.fold === 'cells' && !cells) issue('.fold', `\`cells\` folds a cell, and the value is ${value.type}`);
      else if (cells && metric.fold !== 'cells') issue('.fold', 'a cell value needs `fold: cells`');
      else if (!cells && !SCALAR.has(value.type)) issue('.value', `a metric is a number, a bool or a string, not ${value.type}`);
      else if (metric.at && !metric.fold) issue('.fold', 'a metric sampled more than once needs a fold');
      else if (metric.fold && ['sum', 'mean', 'min', 'max'].includes(metric.fold) && !NUMERIC.has(value.type)) {
        issue('.fold', `\`${metric.fold}\` folds a number, and the value is ${value.type}`);
      }
    }
    if (issues.length === before && value) {
      metrics.push({ name, value, when, signal, entry, fold: metric.fold, cells: metric.fold === 'cells' });
    }
  }
  return { metrics, types, issues, tokens: tokenKinds(compiled), grid: compiled.scenario.map?.grid === 'square' };
}

const bump = (into: Record<string, number>, cell: { x: number; y: number }) => {
  const key = `${cell.x},${cell.y}`;
  into[key] = (into[key] ?? 0) + 1;
};

function folded(fold: Fold | undefined, samples: Value[]): MetricValue {
  if (!fold || fold === 'last') return (samples.at(-1) ?? null) as MetricValue;
  if (fold === 'count') return samples.filter((sample) => sample !== false).length;
  const numbers = samples as number[];
  if (fold === 'sum') return numbers.reduce((sum, sample) => sum + sample, 0);
  if (numbers.length === 0) return null;
  if (fold === 'mean') return numbers.reduce((sum, sample) => sum + sample, 0) / numbers.length;
  return fold === 'min' ? Math.min(...numbers) : Math.max(...numbers);
}

export interface Measured {
  metrics: Record<string, MetricValue>;
  cells: Record<string, Record<string, number>>;
  errors?: Record<string, string>;
}

/** Evaluates the metrics on one finished log, walking it once. */
export function measure(compiled: Pick<Compiled, 'scenario'>, checked: CompiledMetrics, log: readonly GameEvent[]): Measured {
  const { scenario } = compiled;
  const samples = new Map<Metric, Value[]>();
  const cells: Record<string, Record<string, number>> = {};
  const errors: Record<string, string> = {};
  const builtIn = checked.grid && checked.tokens.length > 0;
  if (builtIn) Object.assign(cells, { occupancy: {}, ground: {} });
  for (const metric of checked.metrics) {
    if (metric.cells) cells[metric.name] = {};
    else samples.set(metric, []);
  }
  for (const issue of checked.issues) errors[issue.path.split('.')[1]] ??= issue.message;

  const sample = (metric: Metric, state: State, vars?: Record<string, unknown>) => {
    if (metric.name in errors) return;
    try {
      if (metric.when && metric.when.evaluate(state, scenario, { vars }) !== true) return;
      const value = metric.value.evaluate(state, scenario, { vars });
      if (!metric.cells) samples.get(metric)!.push(value);
      else for (const cell of Array.isArray(value) ? value : [value]) bump(cells[metric.name], cell as { x: number; y: number });
    } catch (error) {
      errors[metric.name] = (error as Error).message.split('\n')[0];
    }
  };
  const bySignal = checked.metrics.filter((metric) => metric.signal !== undefined);
  const byEntry = checked.metrics.filter((metric) => metric.entry !== undefined);
  const kinds = new Map(checked.tokens.map(({ kind, field }) => [kind, field]));

  let state = emptyState();
  for (const entry of log) {
    state = apply(state, entry);
    if (entry.t === 'signal') for (const metric of bySignal) if (metric.signal === entry.name) sample(metric, state, entry.args);
    for (const metric of byEntry) if (metric.entry === entry.t) sample(metric, state);
    if (!builtIn) continue;
    if (entry.t === 'ground') bump(cells.ground, entry.at);
    else if (entry.t === 'intent' && entry.of !== undefined) {
      for (const entity of Object.values(state.entities)) {
        const field = kinds.get(entity.kind);
        if (field) bump(cells.occupancy, entity.fields[field] as { x: number; y: number });
      }
    }
  }
  for (const metric of checked.metrics) if (metric.signal === undefined && metric.entry === undefined) sample(metric, state);

  const metrics: Record<string, MetricValue> = {};
  for (const [metric, taken] of samples) metrics[metric.name] = metric.name in errors ? null : folded(metric.fold, taken);
  for (const name of Object.keys(errors)) {
    metrics[name] ??= null;
    delete cells[name];
  }
  return { metrics, cells, ...(Object.keys(errors).length > 0 ? { errors } : {}) };
}

const checkedFor = new WeakMap<object, Map<string, CompiledMetrics>>();

/** A compiled variant's metrics, compiled once per definition. */
export function metricsFor(compiled: Compiled, doc: MetricsDoc | null): CompiledMetrics {
  let held = checkedFor.get(compiled);
  if (!held) checkedFor.set(compiled, held = new Map());
  const key = JSON.stringify(doc?.metrics ?? {});
  let checked = held.get(key);
  if (!checked) held.set(key, checked = compileMetrics(compiled, doc));
  return checked;
}

/** One batch job: play a seed, measure it, and answer one record. A match that throws is a record with `error`. */
export function runJob(compiled: Compiled, hash: string, seed: string, doc: MetricsDoc | null): BatchRecord {
  const { registry, scenario } = compiled;
  try {
    const { record, log } = playMatch(registry, scenario, seed, compiled.seats());
    return { ...record, variant: hash, ...measure(compiled, metricsFor(compiled, doc), log) };
  } catch (error) {
    if (error instanceof CompileError) throw error;
    return { ruleset: registry.id, version: registry.version, scenario: scenario.doc.scenario.id, seed, variant: hash, error: (error as Error).message };
  }
}
