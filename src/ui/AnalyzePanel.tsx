// Analyze (spec 10): batches arranged so variants can be compared at a
// glance, with every number leading back to a match you can watch.

import { useEffect, useMemo, useState } from 'react';
import { HistogramChart, OutcomeBar, fmt } from '../analyze/Charts.tsx';
import { columnsOf, metricsPath, numbersOf, type Batch, type Column } from '../analyze/batches.ts';
import { failed, measure, type BatchRecord } from '../analyze/metrics.ts';
import { histogram, outliers, shares, sumCells, summarize } from '../analyze/stats.ts';
import type { Heat } from '../board/board.ts';
import { PALETTE } from '../forms/form.ts';
import { outcomeKey } from '../present/presentation.ts';
import type { Scene } from './BoardView.tsx';
import { Editor } from './Editor.tsx';
import { show } from './Inline.tsx';
import { studio, useStudio } from './studio.ts';

const TABS = ['Table', 'Outcomes', 'Distributions', 'Compare', 'Outliers', 'Heatmaps', 'Metrics'] as const;
type Tab = (typeof TABS)[number];

const nameOf = (batch: Batch) => `${studio.state.project?.variant(batch.doc.ruleset, batch.doc.variant.id)?.title ?? batch.doc.variant.id}`;
const outcomeOf = (record: BatchRecord, key: string) => (failed(record) ? 'error' : show(record.outcome[key] ?? record.outcome.result ?? ''));

function useSelected(): Batch[] {
  const batches = useStudio((state) => state.batches);
  const selected = useStudio((state) => state.selectedBatches);
  return useMemo(() => selected.flatMap((path) => batches.filter((batch) => batch.path === path)), [batches, selected]);
}

/** The heatmap on the board: a cell metric summed over a batch, over its own variant's map; two batches on one color scale. */
export function useHeat(): { scenes: (Scene | null)[]; heats: (Heat | null)[]; captions: [string?, string?] } {
  const mode = useStudio((state) => state.mode);
  const heat = useStudio((state) => state.heat);
  const look = useStudio((state) => state.look);
  const revision = useStudio((state) => state.revision);
  const selected = useSelected();
  const [scenes, setScenes] = useState<(Scene | null)[]>([]);
  const shown = selected.slice(0, 2);
  const key = shown.map((batch) => batch.path).join('|');
  useEffect(() => {
    let live = true;
    if (mode !== 'analyze') return undefined;
    void Promise.all(shown.map((batch) => studio.sceneOf(batch.doc.variant.id))).then((found) => {
      if (live) setScenes(found.map((scene) => scene && { presentation: scene.presentation, state: scene.start }));
    });
    return () => { live = false; };
  }, [mode, key, look, revision]);
  return useMemo(() => {
    const cells = shown.map((batch) => (heat ? sumCells(batch.records.map((record) => (failed(record) ? undefined : record.cells[heat.metric]))) : null));
    const sizes = scenes.map((scene) => scene && `${scene.presentation.scenario.map?.width}x${scene.presentation.scenario.map?.height}`);
    // Two heatmaps share a color scale when their maps are the same size.
    const shared = cells.length === 2 && sizes[0] === sizes[1] ? Math.max(0, ...cells.flatMap((held) => Object.values(held ?? {}))) : undefined;
    return {
      scenes: scenes.length === shown.length ? scenes : [],
      heats: cells.map((held) => (held ? { cells: held, max: shared } : null)),
      captions: shown.length === 2 ? [nameOf(shown[0]), nameOf(shown[1])] : [shown[0] && heat ? `${nameOf(shown[0])} · ${heat.metric}` : undefined],
    };
  }, [scenes, heat, key]);
}

function BatchList() {
  const batches = useStudio((state) => state.batches);
  const selected = useStudio((state) => state.selectedBatches);
  const progress = useStudio((state) => state.progress);
  const hash = useStudio((state) => state.hash);
  const variant = useStudio((state) => state.variant);
  useStudio((state) => state.metricsHash);
  const [range, setRange] = useState(studio.seedRange());
  useEffect(() => setRange(studio.seedRange()), [variant]);
  useEffect(() => { void studio.refreshHashes(); }, [variant, hash]);
  const elapsed = progress ? (performance.now() - progress.startedAt) / 1000 : 0;
  return (
    <>
      <div className="row">
        <span>Seeds</span>
        <input aria-label="From seed" type="number" value={range.from} onChange={(event) => setRange({ ...range, from: Number(event.target.value) })} style={{ width: 64 }} />
        <span>to</span>
        <input aria-label="To seed" type="number" value={range.to} onChange={(event) => setRange({ ...range, to: Number(event.target.value) })} style={{ width: 64 }} />
        {progress
          ? <><progress value={progress.done} max={progress.total} /><span data-testid="progress">{progress.done} of {progress.total} · {elapsed.toFixed(1)} s</span><button onClick={() => studio.cancelBatch()}>Cancel</button></>
          : <button className="primary" disabled={!hash} onClick={() => void studio.runBatch(range)}>Run a batch of this variant</button>}
        <span className="hint">{studio.batchPool.workerCount} workers</span>
      </div>
      {batches.length === 0 && <p className="hint">No batches yet. A batch is this variant over a seed range; its records are saved under studio/batches/.</p>}
      {batches.map((batch) => {
        const stale = studio.staleOf(batch);
        return (
          <label key={batch.path} className="batch" data-batch={batch.doc.variant.id}>
            <input type="checkbox" checked={selected.includes(batch.path)} onChange={() => studio.toggleBatch(batch.path)} />
            <span><b>{nameOf(batch)}</b> <span className="hint">{batch.doc.variant.id} · {batch.doc.variant.hash} · seeds {batch.doc.seeds.from} to {batch.doc.seeds.to} · {batch.records.length} records</span></span>
            {stale.length > 0 && <span className="stale" title="Stale batches stay readable; running again replaces them">stale: {stale.map((why) => (why === 'variant' ? 'the variant changed' : why === 'core' ? 'another core' : 'the metrics changed')).join(', ')}</span>}
          </label>
        );
      })}
    </>
  );
}

function matches(filter: string, columns: Column[], record: BatchRecord, outcome: string): boolean {
  const text = filter.trim();
  if (!text) return true;
  const test = /^([\w.() ]+?)\s*(<=|>=|!=|=|<|>)\s*(.+)$/.exec(text);
  if (!test) return JSON.stringify(record).toLowerCase().includes(text.toLowerCase());
  const [, name, op, wanted] = test;
  const column = columns.find((held) => held.label === name.trim() || held.key === name.trim());
  const value = name.trim() === 'outcome' ? outcome : name.trim() === 'seed' ? Number(record.seed) : column?.read(record);
  if (value === undefined || value === null) return false;
  const [a, b] = typeof value === 'number' ? [value, Number(wanted)] : [String(value), wanted.trim()];
  return op === '=' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
}

/** One row per record. A row opens that match in Run. */
function Table({ batch, columns, outcome }: { batch: Batch; columns: Column[]; outcome: string }) {
  const [sort, setSort] = useState<{ key: string; down: boolean }>({ key: 'seed', down: false });
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => {
    const read = (record: BatchRecord): number | string => {
      if (sort.key === 'seed') return Number(record.seed);
      if (sort.key === 'outcome') return outcomeOf(record, outcome);
      const value = columns.find((column) => column.key === sort.key)?.read(record);
      return typeof value === 'boolean' ? Number(value) : value ?? -Infinity;
    };
    return batch.records.filter((record) => matches(filter, columns, record, outcomeOf(record, outcome)))
      .sort((a, b) => ((read(a) < read(b) ? -1 : read(a) > read(b) ? 1 : 0) * (sort.down ? -1 : 1)));
  }, [batch, sort, filter, columns, outcome]);
  const head = (key: string, label: string) => <th key={key} onClick={() => setSort({ key, down: sort.key === key ? !sort.down : false })}>{label}{sort.key === key ? (sort.down ? ' ↓' : ' ↑') : ''}</th>;
  return (
    <>
      <div className="row"><input aria-label="Filter" placeholder="Filter: text, or a test such as  decisions > 150  or  outcome = monsters" value={filter} onChange={(event) => setFilter(event.target.value)} style={{ flex: 1 }} /><span className="hint">{rows.length} of {batch.records.length}</span></div>
      <div className="scroll">
        <table className="grid" data-testid="batch-table">
          <thead><tr>{head('seed', 'seed')}{head('outcome', outcome)}{columns.map((column) => head(column.key, column.label))}</tr></thead>
          <tbody>
            {rows.map((record) => (
              <tr key={record.seed} onClick={() => void studio.openRecord(batch, record)} title="Open this match in Run">
                <td>{record.seed}</td><td>{failed(record) ? <span className="stale" title={record.error}>error</span> : outcomeOf(record, outcome)}</td>
                {columns.map((column) => { const value = column.read(record); return <td key={column.key}>{typeof value === 'number' ? fmt(value) : show(value)}</td>; })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Outcomes({ batches, outcome }: { batches: Batch[]; outcome: string }) {
  const order = [...new Set(batches.flatMap((batch) => batch.records.map((record) => outcomeOf(record, outcome))))].sort();
  return (
    <div>
      {batches.map((batch) => (
        <div key={batch.path} className="card" style={{ marginBottom: 8 }}>
          <h4>{nameOf(batch)} · {batch.records.length} matches · split by {outcome}</h4>
          <OutcomeBar shares={shares(batch.records.map((record) => outcomeOf(record, outcome)))} order={order} />
        </div>
      ))}
    </div>
  );
}

const numeric = (columns: Column[], batches: Batch[]) => columns.filter((column) => batches.some((batch) => numbersOf(column, batch.records).length > 0));

function Distributions({ batch, columns }: { batch: Batch; columns: Column[] }) {
  return (
    <div className="cards">
      {numeric(columns, [batch]).map((column) => {
        const values = numbersOf(column, batch.records);
        return <div key={column.key} className="card"><h4>{column.label}</h4><HistogramChart histogram={histogram(values)} summary={summarize(values)} /></div>;
      })}
    </div>
  );
}

/** Two or more batches side by side: outcome bars on one scale, histograms on shared axes, and each metric's mean and median with the difference from the first. */
function Compare({ batches, columns, outcome }: { batches: Batch[]; columns: Column[]; outcome: string }) {
  if (batches.length < 2) return <p className="hint">Select two or more batches to compare them. Comparison is between distributions: the same seed under two variants is not a matched pair, because the matches diverge at the first different decision.</p>;
  const order = [...new Set(batches.flatMap((batch) => batch.records.map((record) => outcomeOf(record, outcome))))].sort();
  const held = numeric(columns, batches);
  const delta = (value: number, base: number) => {
    const by = value - base;
    return <span className={by > 0 ? 'delta-up' : by < 0 ? 'delta-down' : 'hint'}> ({by >= 0 ? '+' : ''}{fmt(by)})</span>;
  };
  return (
    <div data-testid="compare">
      {batches.map((batch) => (
        <div key={batch.path}><b>{nameOf(batch)}</b> <span className="hint">{batch.records.length} matches</span>
          <OutcomeBar shares={shares(batch.records.map((record) => outcomeOf(record, outcome)))} order={order} />
        </div>
      ))}
      <table className="grid">
        <thead><tr><th>metric</th>{batches.map((batch) => <th key={batch.path}>{nameOf(batch)}: mean</th>)}{batches.map((batch) => <th key={batch.path}>median</th>)}</tr></thead>
        <tbody>
          {held.map((column) => {
            const sums = batches.map((batch) => summarize(numbersOf(column, batch.records)));
            return (
              <tr key={column.key}><td>{column.label}</td>
                {sums.map((sum, index) => <td key={`m${index}`}>{fmt(sum.mean)}{index > 0 && delta(sum.mean, sums[0].mean)}</td>)}
                {sums.map((sum, index) => <td key={`d${index}`}>{fmt(sum.median)}{index > 0 && delta(sum.median, sums[0].median)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="cards" style={{ marginTop: 10 }}>
        {held.map((column) => {
          const all = batches.map((batch) => numbersOf(column, batch.records));
          const range: [number, number] = [Math.min(...all.flat()), Math.max(...all.flat())];
          const histograms = all.map((values) => histogram(values, 20, range));
          const top = Math.max(1, ...histograms.flatMap((made) => made.bins));
          return (
            <div key={column.key} className="card"><h4>{column.label}</h4>
              {histograms.map((made, index) => <HistogramChart key={index} histogram={made} summary={summarize(all[index])} top={top} color={PALETTE[index % PALETTE.length]} height={46} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Per metric, the records beyond 1.5 times the interquartile range, and every record that ended at the decision limit or with an error. */
function Outliers({ batch, columns }: { batch: Batch; columns: Column[] }) {
  const found = useMemo(() => {
    const rows: { record: BatchRecord; why: string }[] = [];
    for (const record of batch.records) {
      if (failed(record)) rows.push({ record, why: `error: ${record.error}` });
      else if (record.outcome.result === 'limit') rows.push({ record, why: 'ended at the decision limit' });
    }
    for (const column of numeric(columns, [batch])) {
      const records = batch.records.filter((record) => typeof column.read(record) === 'number');
      const values = records.map((record) => column.read(record) as number);
      const { median } = summarize(values);
      for (const index of outliers(values)) rows.push({ record: records[index], why: `${column.label} ${fmt(values[index])} (median ${fmt(median)})` });
    }
    return rows;
  }, [batch, columns]);
  if (found.length === 0) return <p className="hint">No record of this batch lies beyond 1.5 times the interquartile range of any metric, and none ended at the limit or with an error.</p>;
  return (
    <div className="scroll">
      <table className="grid" data-testid="outliers">
        <thead><tr><th>seed</th><th style={{ textAlign: 'left' }}>why</th></tr></thead>
        <tbody>{found.map(({ record, why }, index) => <tr key={index} onClick={() => void studio.openRecord(batch, record)} title="Open this match in Run"><td>{record.seed}</td><td style={{ textAlign: 'left' }}>{why}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Heatmaps({ batches }: { batches: Batch[] }) {
  const heat = useStudio((state) => state.heat);
  const names = [...new Set(batches.flatMap((batch) => batch.records.flatMap((record) => (failed(record) ? [] : Object.keys(record.cells)))))];
  if (names.length === 0) return <p className="hint">These batches hold no cell metric. A cell metric has a `cell` value and `fold: cells`; `occupancy` and `ground` are built in for any ruleset with tokens on a grid.</p>;
  return (
    <div>
      <div className="row">
        <span>Draw on the board:</span>
        {names.map((name) => <button key={name} className={heat?.metric === name ? 'on' : ''} onClick={() => studio.set({ heat: heat?.metric === name ? null : { metric: name } })}>{name}</button>)}
      </div>
      <p className="hint">A cell metric summed over a batch, drawn over its variant’s map. With two batches selected, a split board shows both on one color scale when their maps are the same size.</p>
      {heat && batches.slice(0, 2).map((batch) => {
        const cells = sumCells(batch.records.map((record) => (failed(record) ? undefined : record.cells[heat.metric])));
        const top = Object.entries(cells).sort((a, b) => b[1] - a[1]).slice(0, 5);
        return <p key={batch.path}><b>{nameOf(batch)}</b>: {Object.keys(cells).length} cells, {Object.values(cells).reduce((sum, count) => sum + count, 0)} in all. Most: {top.map(([cell, count]) => `(${cell.replace(',', ', ')}) ${count}`).join(' · ') || 'none'}</p>;
      })}
    </div>
  );
}

/** The metrics editor checks each expression as it is typed and shows its type, and its value on the match open in Run. */
function Metrics() {
  const ruleset = useStudio((state) => state.ruleset);
  const metrics = useStudio((state) => state.metrics);
  const match = useStudio((state) => state.match);
  const issues = useStudio((state) => state.issues);
  useStudio((state) => state.revision);
  const path = metricsPath(ruleset);
  const text = studio.state.project?.text(path) ?? 'format: 1\nmetrics: {}\n';
  const measured = useMemo(() => {
    if (!metrics || !match) return null;
    try {
      return measure(match.compiled, metrics, match.log);
    } catch {
      return null;
    }
  }, [metrics, match]);
  return (
    <div>
      <table className="grid" data-testid="metric-values">
        <thead><tr><th>metric</th><th>type</th><th>on seed {match?.seed ?? '–'}</th></tr></thead>
        <tbody>
          {Object.entries(metrics?.types ?? {}).map(([name, type]) => (
            <tr key={name}><td>{name}</td><td>{type}</td>
              <td>{measured ? (name in measured.metrics ? show(measured.metrics[name]) : name in measured.cells ? `${Object.keys(measured.cells[name]).length} cells` : measured.errors?.[name] ?? '') : ''}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{path} · CEL, checked against the ruleset like any rule. Editing it marks this ruleset’s batches stale.</p>
      <Editor name={path} text={text} issues={issues.filter((issue) => issue.file === path)} onChange={(next) => studio.writeFile(path, next, { soon: true })} />
    </div>
  );
}

export function AnalyzePanel() {
  const presentation = useStudio((state) => state.presentation);
  const selected = useSelected();
  const [tab, setTab] = useState<Tab>('Table');
  const columns = useMemo(() => columnsOf(selected), [selected]);
  const outcome = outcomeKey(presentation ?? undefined, selected.flatMap((batch) => batch.records.flatMap((record) => (failed(record) ? [] : [record.outcome]))));
  const first = selected[0];
  return (
    <div className="panel analyze">
      <h2>Batches</h2>
      <BatchList />
      <div className="tabs">{TABS.map((name) => <button key={name} className={tab === name ? 'on' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
      {tab === 'Metrics' ? <Metrics />
        : !first ? <p className="hint">Select a batch to read it.</p>
          : tab === 'Table' ? <Table batch={first} columns={columns} outcome={outcome} />
            : tab === 'Outcomes' ? <Outcomes batches={selected} outcome={outcome} />
              : tab === 'Distributions' ? <Distributions batch={first} columns={columns} />
                : tab === 'Compare' ? <Compare batches={selected} columns={columns} outcome={outcome} />
                  : tab === 'Outliers' ? <Outliers batch={first} columns={columns} />
                    : <Heatmaps batches={selected} />}
    </div>
  );
}
