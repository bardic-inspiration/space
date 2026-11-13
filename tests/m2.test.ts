// M2: Analyze. The project folder, variants, batch records, metrics, and the
// statistics behind the views.

import { describe, expect, test } from 'vitest';
import { missingSeeds, listBatches, metricsHash, metricsPath, recordsText, seedsOf, staleness, writeBatch, columnsOf, numbersOf } from '../src/analyze/batches.ts';
import { compileMetrics, failed, measure, runJob, type BatchRecord, type MetricsDoc } from '../src/analyze/metrics.ts';
import { histogram, outliers, quantile, shares, sumCells, summarize, wilson } from '../src/analyze/stats.ts';
import { CORE_COMMIT } from '../src/core.ts';
import { poolSize } from '../src/engine/client.ts';
import { compileInput, variantHash } from '../src/engine/input.ts';
import { play } from '../src/engine/session.ts';
import { MemoryFiles, guard } from '../src/project/files.ts';
import { Project } from '../src/project/project.ts';
import { coreFiles, exampleProject, recordedMatches } from './helpers.ts';

const RULESET = 'dnd-5e-2024-slice';

describe('a checkout of core as a project', () => {
  test('opens, and nothing outside studio/ is written', async () => {
    const files = new MemoryFiles(coreFiles(), 'core');
    const project = await Project.open(files);
    expect(project.rulesets()).toEqual(['checkers', RULESET, 'holdem', 'junkyard']);
    // Opening writes nothing at all.
    expect(files.written).toEqual([]);
    const resolved = project.resolve(RULESET, '@worg-vs-scout')!;
    const compiled = compileInput(resolved.input);
    const hash = await variantHash(resolved.input);
    writeBatch(project, { format: 1, variant: { id: '@worg-vs-scout', hash }, ruleset: RULESET, core: CORE_COMMIT, seeds: { from: 1, to: 3 }, metrics: await metricsHash(null) },
      seedsOf({ from: 1, to: 3 }).map((seed) => runJob(compiled, hash, seed, null)));
    project.createVariant(RULESET, 'mine', resolved.variant);
    project.writeShadow(RULESET, 'mine', 'maps/rocky-pass.yaml', project.text(`rulesets/${RULESET}/maps/rocky-pass.yaml`)!);
    await project.saved();
    expect(files.written.length).toBeGreaterThan(3);
    expect(files.written.every((path) => path.startsWith('studio/'))).toBe(true);
    for (const [path, text] of Object.entries(coreFiles())) expect(files.files.get(path)).toBe(text);
    // The first write notes the core commit in use.
    expect(project.doc<{ core: string }>('studio/project.yaml')!.core).toBe(CORE_COMMIT);
  });

  test('a write outside studio/ is refused', async () => {
    const project = await Project.open(new MemoryFiles(coreFiles()));
    expect(() => project.write('rulesets/checkers/ruleset.yaml', 'x')).toThrow(/only under studio/);
    expect(() => guard('studio/../rulesets/x.yaml')).toThrow();
    expect(() => project.remove('kit/patterns.yaml')).toThrow();
  });

  test('a project last used with another core says so', async () => {
    const project = await Project.open(new MemoryFiles({ ...coreFiles(), 'studio/project.yaml': 'format: 1\ncore: abc1234\n' }));
    expect(project.staleCore).toBe('abc1234');
  });
});

describe('batches of the base variants', () => {
  const recorded = recordedMatches();
  const scenarios = [...new Set(recorded.map((record) => `${record.ruleset}/${record.scenario}`))];

  test.each(scenarios)('%s over seeds 1 to 40 reproduces every logHash in core\'s data', async (name) => {
    const project = await Project.open(exampleProject());
    const [ruleset, scenario] = name.split('/');
    const resolved = project.resolve(ruleset, `@${scenario}`)!;
    const compiled = compileInput(resolved.input);
    const hash = await variantHash(resolved.input);
    const metrics = project.doc<MetricsDoc>(metricsPath(ruleset)) ?? null;
    const records = seedsOf({ from: 1, to: 40 }).map((seed) => runJob(compiled, hash, seed, metrics));
    const want = new Map(recorded.filter((record) => record.ruleset === ruleset && record.scenario === scenario).map((record) => [record.seed, record.logHash]));
    expect(want.size).toBe(40);
    for (const record of records) {
      expect(failed(record)).toBe(false);
      expect((record as { logHash: string }).logHash, `seed ${record.seed}`).toBe(want.get(record.seed));
      expect(record.variant).toBe(hash);
      expect((record as { errors?: unknown }).errors).toBeUndefined();
    }
  });
});

describe('a batch', async () => {
  const project = await Project.open(exampleProject());
  const resolved = project.resolve(RULESET, '@pack-ambush')!;
  const compiled = compileInput(resolved.input);
  const hash = await variantHash(resolved.input);
  const metrics = project.doc<MetricsDoc>(metricsPath(RULESET))!;
  const digest = await metricsHash(metrics);
  const range = { from: 1, to: 12 };
  const doc = { format: 1, variant: { id: '@pack-ambush', hash }, ruleset: RULESET, core: CORE_COMMIT, seeds: range, metrics: digest };
  const all = seedsOf(range).map((seed) => runJob(compiled, hash, seed, metrics));

  test('cancelled halfway and resumed gives the same records.jsonl as one run through', async () => {
    const through = await Project.open(exampleProject());
    writeBatch(through, doc, all, 'now');
    const resumed = await Project.open(exampleProject());
    // The pool hands seeds to workers out of order, and a cancel leaves some unplayed.
    const first = writeBatch(resumed, doc, [all[4], all[0], all[2], all[1], all[7]]);
    const todo = missingSeeds(range, listBatches(resumed, RULESET)[0].records);
    expect(todo).toEqual(['4', '6', '7', '9', '10', '11', '12']);
    writeBatch(resumed, doc, [...first.records, ...todo.reverse().map((seed) => runJob(compiled, hash, seed, metrics))], 'later');
    const path = `${first.path}/records.jsonl`;
    expect(resumed.text(path)).toBe(through.text(path));
    expect(resumed.text(path)).toBe(recordsText(all));
    // A record holds no clock: the same batch again is the same file.
    expect(recordsText(seedsOf(range).map((seed) => runJob(compiled, hash, seed, metrics)))).toBe(recordsText(all));
  });

  test('records carry the metrics, and a `deaths` heatmap lies on the rocky pass', () => {
    const map = compiled.scenario.map!;
    expect(map.id).toBe('rocky-pass');
    for (const record of all) {
      if (failed(record)) throw new Error(record.error);
      expect(record.metrics.rounds).toBeGreaterThan(0);
      expect(record.metrics.damage).toBeGreaterThan(0);
      expect(Object.keys(record.cells).sort()).toEqual(['deaths', 'ground', 'occupancy']);
    }
    const deaths = sumCells(all.map((record) => (failed(record) ? undefined : record.cells.deaths)));
    expect(Object.keys(deaths).length).toBeGreaterThan(3);
    const rock = new Set(map.blocksMove.map((cell) => `${cell.x},${cell.y}`));
    for (const key of Object.keys(deaths)) {
      const [x, y] = key.split(',').map(Number);
      expect(x >= 0 && y >= 0 && x < map.width && y < map.height && !rock.has(key)).toBe(true);
    }
    // Ten creatures stand somewhere at every decision.
    const first = all[0] as Exclude<BatchRecord, { error: string }>;
    expect(Object.values(first.cells.occupancy).reduce((sum, count) => sum + count, 0)).toBe(first.decisions * 10);
  });

  test('editing a metric marks the batch stale, and so does a changed variant', async () => {
    const batch = writeBatch(await Project.open(exampleProject()), doc, all);
    expect(staleness(batch, { hash, metrics: digest })).toEqual([]);
    const edited = structuredClone(metrics);
    edited.metrics.rounds.value = 'game.round + 1';
    expect(staleness(batch, { hash, metrics: await metricsHash(edited) })).toEqual(['metrics']);
    expect(staleness(batch, { hash: 'another', metrics: digest })).toEqual(['variant']);
    expect(staleness({ ...batch, doc: { ...batch.doc, core: 'old' } }, { hash, metrics: digest })).toEqual(['core']);
  });

  test('two variants, one with another behavior bound and one on another map, compare, and an outlier opens with a matching logHash', async () => {
    const batches = [{ path: 'base', doc, records: all }];
    for (const id of ['pack-hunters', 'open-field']) {
      const other = project.resolve(RULESET, id)!;
      expect(other.issues).toEqual([]);
      const otherHash = await variantHash(other.input);
      expect(otherHash).not.toBe(hash);
      const otherCompiled = compileInput(other.input);
      const records = seedsOf(range).map((seed) => runJob(otherCompiled, otherHash, seed, metrics));
      expect(recordsText(records)).not.toBe(recordsText(all));
      batches.push({ path: id, doc: { ...doc, variant: { id, hash: otherHash } }, records });
      if (id === 'open-field') expect(otherCompiled.scenario.map!.id).toBe('open-field');
      else expect((records[0] as { seats: Record<string, { driver: string }> }).seats.pack.driver).toBe('hunter');
    }
    const columns = columnsOf(batches);
    expect(columns.map((column) => column.label)).toEqual(expect.arrayContaining(['decisions', 'events', 'rounds', 'damage', 'bigHits']));
    for (const batch of batches) expect(numbersOf(columns.find((column) => column.label === 'damage')!, batch.records)).toHaveLength(12);
    // The record furthest from the middle of its batch opens in Run as the same match.
    const decisions = numbersOf(columns[0], all);
    const far = all[decisions.indexOf(Math.max(...decisions))] as { seed: string; logHash: string };
    expect(play(compiled, far.seed).record.logHash).toBe(far.logHash);
  });

  test('a metric that is refused is reported by path, and one that throws records null', () => {
    const checked = compileMetrics(compiled, { format: 1, metrics: {
      good: { value: 'game.round' },
      typo: { value: 'game.rounds' },
      noFold: { at: { signal: 'hp.lose' }, value: 'amount' },
      noSignal: { at: { signal: 'hp.vanish' }, value: '1', fold: 'sum' },
      cellNoFold: { value: 'all.creature.first().pos' },
      throws: { at: { signal: 'hp.lose' }, value: 'amount / (amount - amount)', fold: 'sum' },
    } });
    expect(checked.issues.map((issue) => issue.path)).toEqual(['metrics.typo.value', 'metrics.noFold.fold', 'metrics.noSignal.at.signal', 'metrics.cellNoFold.fold']);
    expect(checked.types.good).toBe('int');
    const measured = measure(compiled, checked, play(compiled, 1).log);
    expect(measured.metrics.good).toBeGreaterThan(0);
    expect(measured.metrics.throws).toBeNull();
    expect(measured.errors!.throws).toBeTruthy();
    expect(measured.errors!.typo).toBeTruthy();
  });

  test('a match that throws is a record with `error`, and the batch goes on', () => {
    const broken = { ...compiled, seats: () => { throw new Error('the seat fell over'); } };
    const record = runJob(broken as never, hash, '5', null);
    expect(record).toEqual({ ruleset: RULESET, version: compiled.registry.version, scenario: 'pack-ambush', seed: '5', variant: hash, error: 'the seat fell over' });
  });
});

describe('statistics', () => {
  test('a Wilson interval, shares, quantiles, a histogram of 20 bins, and outliers beyond 1.5 IQR', () => {
    const [low, high] = wilson(25, 40);
    expect(low).toBeCloseTo(0.4705, 3);
    expect(high).toBeCloseTo(0.7574, 3);
    expect(wilson(0, 0)).toEqual([0, 0]);
    expect(shares(['a', 'b', 'a', 'a']).map((share) => [share.value, share.count, share.share])).toEqual([['a', 3, 0.75], ['b', 1, 0.25]]);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(summarize([1, 2, 3, 4]).median).toBe(2.5);
    const made = histogram(Array.from({ length: 100 }, (_, index) => index));
    expect(made.bins).toHaveLength(20);
    expect(made.bins.every((count) => count === 5)).toBe(true);
    expect(outliers([10, 11, 12, 11, 10, 12, 11, 50])).toEqual([7]);
  });

  test('the pool is one less than the cores, at least 1 and at most 8', () => {
    expect([1, 2, 4, 8, 9, 64].map((cores) => poolSize(cores))).toEqual([1, 1, 3, 7, 8, 8]);
  });
});
