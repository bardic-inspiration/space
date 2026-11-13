// Run (spec 9): a cursor on a finished log. The transport moves it, the
// timeline scrubs it, the log tree and the inspector read the state at it.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { compileExpression, type Candidate, type GameEvent, type HostCall, type Option, type State } from '../core.ts';
import { describeCall } from '../board/overlay.ts';
import type { DecisionInfo } from '../engine/session.ts';
import { flatten, rowOf, type Row } from '../log/tree.ts';
import { Inline, show } from './Inline.tsx';
import { studio, useStudio, type Watched } from './studio.ts';

const ROW = 22;

// ── Transport and timeline ──────────────────────────────────────────────────

function Timeline({ watched, cursor }: { watched: Watched; cursor: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useStudio((state) => state.theme);
  const branch = useStudio((state) => state.branch);
  const revision = useStudio((state) => state.revision);
  const [width, setWidth] = useState(600);
  const forks = useMemo(() => studio.forks().filter((fork) => String(fork.seed) === watched.seed && (fork.parent ?? null) === (watched.fork?.id ?? null)), [watched, revision]);

  useLayoutEffect(() => {
    const element = canvas.current!;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current!;
    const scale = window.devicePixelRatio || 1;
    const height = 34;
    element.width = width * scale;
    element.height = height * scale;
    const context = element.getContext('2d')!;
    context.scale(scale, scale);
    const style = getComputedStyle(element);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const x = (seq: number) => (seq / Math.max(1, watched.log.length)) * width;
    context.clearRect(0, 0, width, height);
    // A band per outermost section.
    watched.tree.sections.forEach((section, index) => {
      context.fillStyle = color(index % 2 === 0 ? '--band' : '--band-alt');
      context.fillRect(x(section.first), 0, x(section.last + 1) - x(section.first), height);
    });
    // A tick per decision.
    context.fillStyle = color('--muted');
    for (const seq of watched.decisions) context.fillRect(Math.round(x(seq)), 12, 1, 12);
    // Where each fork leaves, and where the open branch parts from its parent.
    context.fillStyle = color('--accent');
    for (const at of [...forks.map((fork) => fork.at), ...(branch?.fork ? [branch.fork.at] : [])]) {
      context.beginPath();
      context.moveTo(x(at) - 5, 0);
      context.lineTo(x(at) + 5, 0);
      context.lineTo(x(at), 9);
      context.fill();
    }
    context.fillStyle = color('--ink');
    context.fillRect(Math.round(x(cursor)) - 1, 0, 2, height);
  }, [watched, cursor, width, theme, forks, branch]);

  const scrub = (event: React.PointerEvent) => {
    const bounds = canvas.current!.getBoundingClientRect();
    studio.pause();
    studio.setCursor(((event.clientX - bounds.left) / bounds.width) * watched.log.length);
  };
  return (
    <canvas
      ref={canvas} className="timeline" role="slider" aria-label="Timeline" aria-valuemin={0} aria-valuemax={watched.log.length} aria-valuenow={cursor}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); scrub(event); }}
      onPointerMove={(event) => event.buttons === 1 && scrub(event)}
    />
  );
}

export function Transport() {
  useStudio((state) => state.match);
  useStudio((state) => state.branch);
  useStudio((state) => state.focus);
  const cursor = useStudio((state) => state.cursor);
  const playing = useStudio((state) => state.playing);
  const speed = useStudio((state) => state.speed);
  const watched = studio.watched;
  if (!watched) return <div className="transport">No match is open. Pick a seed and play it.</div>;
  const decision = watched.decisions.filter((seq) => seq < cursor).length;
  return (
    <div className="transport">
      <div className="row">
        <button onClick={() => studio.stepDecision(-1)} title="Previous decision (Shift+←)">⏮</button>
        <button onClick={() => studio.step(-1)} title="Back one event (←)">◀</button>
        <button className="play" onClick={() => studio.toggle()} title="Play or pause (Space)">{playing ? 'Pause' : 'Play'}</button>
        <button onClick={() => studio.step(1)} title="Forward one event (→)">▶</button>
        <button onClick={() => studio.stepDecision(1)} title="Next decision (Shift+→)">⏭</button>
        <label>Speed
          <select aria-label="Speed" value={speed} onChange={(event) => studio.set({ speed: Number(event.target.value) })}>
            {[1, 2, 4, 8, 16, 32, 64].map((value) => <option key={value} value={value}>{value}/s</option>)}
          </select>
        </label>
        <span className="count" data-testid="cursor">event {cursor} of {watched.log.length} · decision {decision} of {watched.decisions.length}</span>
      </div>
      <Timeline watched={watched} cursor={cursor} />
    </div>
  );
}

// ── The log tree ────────────────────────────────────────────────────────────

function LogRow({ row, watched, at, open }: { row: Row; watched: Watched; at: boolean; open: boolean }) {
  const { node, depth } = row;
  const entry = node.entry;
  const fold = node.children.length > 0;
  const onToggle = (event: React.MouseEvent) => {
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent('studio:fold', { detail: node.id }));
  };
  const onClick = () => {
    studio.pause();
    // Clicking a row moves the cursor to just after it; a decision, to just before it, where the seat chose.
    if (!entry) return studio.setCursor(node.kind === 'setup' ? node.last + 1 : node.first);
    studio.setCursor(entry.t === 'intent' && entry.of !== undefined ? entry.seq : entry.seq + 1);
    const state = watched.cache.at(entry.seq + 1);
    const named = [entry.t === 'set' || entry.t === 'create' ? entry.id : undefined, entry.t === 'intent' ? Object.values(entry.params).find((value) => typeof value === 'string' && state.entities[value]) as string | undefined : undefined]
      .find((id) => id !== undefined && state.entities[id]);
    if (entry.t === 'ground') studio.selectEntity(undefined, entry.at);
    else if (named) studio.selectEntity(named);
  };
  return (
    <div className={`log-row t-${entry?.t ?? node.kind}${at ? ' at' : ''}${entry?.by ? ' referee' : ''}`} style={{ paddingLeft: 6 + depth * 14, height: ROW }} onClick={onClick} data-seq={entry?.seq}>
      <span className="fold" onClick={fold ? onToggle : undefined}>{fold ? (open ? '▾' : '▸') : ''}</span>
      {entry
        ? <><span className="sentence"><Inline nodes={studio.sentence(watched, entry)} /></span>{entry.t === 'intent' && entry.of !== undefined && <span className="of" title="Legal options it chose among">1 of {entry.of}</span>}{entry.by && <span className="by" title="A referee's">referee</span>}</>
        : <span className="section-title">{node.title}{node.kind === 'setup' ? ` · ${node.children.length} entries` : ''}</span>}
    </div>
  );
}

export function LogPanel() {
  useStudio((state) => state.match);
  useStudio((state) => state.branch);
  useStudio((state) => state.focus);
  const cursor = useStudio((state) => state.cursor);
  const watched = studio.watched;
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const view = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const toggle = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const flip = (held: Set<string>) => {
        const next = new Set(held);
        if (!next.delete(id)) next.add(id);
        return next;
      };
      if (id === 'setup') setOpened(flip);
      else setClosed(flip);
    };
    window.addEventListener('studio:fold', toggle);
    return () => window.removeEventListener('studio:fold', toggle);
  }, []);
  useEffect(() => { setClosed(new Set()); setOpened(new Set()); }, [watched?.tree]);
  useLayoutEffect(() => {
    const element = view.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [watched === null]);

  const rows = useMemo(() => (watched ? flatten(watched.tree, closed, opened) : []), [watched?.tree, closed, opened]);
  const current = watched && cursor > 0 ? rowOf(watched.tree, rows, cursor - 1) : -1;
  // The row at the cursor is kept in view.
  useLayoutEffect(() => {
    const element = view.current;
    if (!element || current < 0) return;
    const top = current * ROW;
    if (top < element.scrollTop + ROW || top > element.scrollTop + element.clientHeight - ROW * 2) element.scrollTop = Math.max(0, top - element.clientHeight / 2);
  }, [current, watched]);

  if (!watched) return <div className="panel"><h2>Log</h2><p className="hint">No match is open.</p></div>;
  const first = Math.max(0, Math.floor(scroll / ROW) - 8);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 8);
  return (
    <div className="panel log">
      <h2>Log <span className="hint">{watched.record.ruleset}@{watched.record.version} · {watched.record.scenario} · seed {watched.seed}{watched.fork ? ' · fork' : ''}</span></h2>
      {studio.state.branch && (
        <div className="row">
          <button className={studio.state.focus === 'match' ? 'on' : ''} onClick={() => studio.set({ focus: 'match' })}>Parent</button>
          <button className={studio.state.focus === 'branch' ? 'on' : ''} onClick={() => studio.set({ focus: 'branch' })}>Fork</button>
          <button onClick={() => studio.closeBranch()}>Close the fork</button>
        </div>
      )}
      <div className="log-view" ref={view} onScroll={(event) => setScroll(event.currentTarget.scrollTop)} data-rows={rows.length}>
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          <div style={{ position: 'absolute', top: first * ROW, left: 0, right: 0 }}>
            {rows.slice(first, last).map((row, index) => <LogRow key={row.node.id} row={row} watched={watched} at={first + index === current} open={row.node.kind === 'setup' ? opened.has(row.node.id) : !closed.has(row.node.id)} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The inspector ───────────────────────────────────────────────────────────

function Fields({ rows }: { rows: [string, string, boolean?][] }) {
  return (
    <table className="fields"><tbody>
      {rows.map(([name, value, changed]) => <tr key={name} className={changed ? 'changed' : ''}><th>{name}</th><td>{value}</td></tr>)}
    </tbody></table>
  );
}

function EntityInspector({ watched, id, state, before }: { watched: Watched; id: string; state: State; before: State }) {
  const entity = state.entities[id];
  const { registry, scenario } = watched.compiled;
  const derived = useMemo(() => {
    if (!entity) return [];
    const kind = registry.kinds.get(entity.kind)!;
    return [...kind.derived.keys()].map((name): [string, string] => {
      try {
        return [name, show(compileExpression(registry, `self.${name}`, { vars: { self: entity.kind } }).evaluate(state, scenario, { vars: { self: id } }))];
      } catch (error) {
        return [name, `(${(error as Error).message.split('\n')[0]})`];
      }
    });
  }, [entity, state, id]);
  if (!entity) return <p className="hint"><b>{id}</b> does not exist at this point of the match.</p>;
  const links = Object.entries(state.links).flatMap(([rel, pairs]) => pairs.filter(([from, to]) => from === id || to === id).map(([from, to]) => `${rel}: ${from} → ${to}`));
  return (
    <>
      <h3>{id} <span className="hint">{entity.kind}</span></h3>
      <Fields rows={Object.entries(entity.fields).map(([name, value]) => [name, show(value), JSON.stringify(before.entities[id]?.fields[name]) !== JSON.stringify(value)])} />
      {derived.length > 0 && <><h4>Derived</h4><Fields rows={derived} /></>}
      {links.length > 0 && <><h4>Links</h4><ul className="plain">{links.map((link) => <li key={link}>{link}</li>)}</ul></>}
    </>
  );
}

function CellInspector({ watched, cell, state }: { watched: Watched; cell: { x: number; y: number }; state: State }) {
  const { scenario } = watched.compiled;
  const now = scenario.mapAt(state);
  const document = scenario.map;
  if (!now || !document || now.grid !== 'square') return null;
  const at = (map: typeof now) => map.cells.find((held) => held.x === cell.x && held.y === cell.y)?.values ?? map.defaults;
  const [held, written] = [at(now), at(document)];
  const blocked = (list: { x: number; y: number }[]) => list.some((other) => other.x === cell.x && other.y === cell.y);
  return (
    <>
      <h3>Cell ({cell.x}, {cell.y})</h3>
      <Fields rows={[
        ...Object.entries(held).map(([layer, value]): [string, string, boolean] => [layer, `${show(value)}${written[layer] !== value ? ` (the map has ${show(written[layer])})` : ''}`, written[layer] !== value]),
        ['blocks movement', String(blocked(now.blocksMove))], ['blocks sight', String(blocked(now.blocksSight))],
      ]} />
    </>
  );
}

const optionText = (option: Option) => `${option.intent}${Object.keys(option.params).length > 0 ? ` ${Object.entries(option.params).map(([name, value]) => `${name} ${show(value)}`).join(', ')}` : ''}`;

/** The debug overlay's list (spec 8.1): intents, their candidates, legal ones first, each gate marked, and the host calls behind each. */
function Overlay({ info }: { info: DecisionInfo }) {
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const draw = (key: string, calls: HostCall[]) => {
    setPicked(key);
    studio.set({ overlay: calls });
  };
  return (
    <div className="overlay-list">
      <h4>Debug overlay <button onClick={() => { setPicked(null); studio.set({ overlay: null }); }}>Clear</button></h4>
      {info.explanation.intents.map((intent) => {
        const legal = intent.candidates.filter((candidate) => candidate.legal);
        const candidates: Candidate[] = [...legal, ...intent.candidates.filter((candidate) => !candidate.legal)];
        return (
          <div key={intent.intent} className="intent">
            <button className="intent-head" onClick={() => setOpen(open === intent.intent ? null : intent.intent)}>
              {open === intent.intent ? '▾' : '▸'} {intent.intent} <span className="hint">{legal.length} legal of {candidates.length}</span>
            </button>
            {open === intent.intent && (
              <>
                {intent.domains.filter((domain) => domain.calls.length > 0).slice(0, 30).map((domain, index) => (
                  <button key={`d${index}`} className={`candidate domain${picked === `${intent.intent}:d${index}` ? ' on' : ''}`} onClick={() => draw(`${intent.intent}:d${index}`, domain.calls)}>
                    domain of <b>{domain.param}</b> · {domain.size} values · {domain.calls.length} host calls
                  </button>
                ))}
                {candidates.slice(0, 200).map((candidate, index) => {
                  const key = `${intent.intent}:${index}`;
                  return (
                    <div key={key} className={`candidate${candidate.legal ? ' legal' : ''}${picked === key ? ' on' : ''}`}>
                      <button onClick={() => draw(key, candidate.gates.flatMap((gate) => gate.calls))}>
                        {candidate.legal ? '✓' : '✗'} {Object.entries(candidate.params).map(([name, value]) => `${name} ${show(value)}`).join(', ') || '(no params)'}
                      </button>
                      {picked?.startsWith(key) && candidate.gates.map((gate, at) => (
                        <button key={at} className={`gate ${gate.result}${picked === `${key}/${at}` ? ' on' : ''}`} onClick={() => draw(`${key}/${at}`, gate.calls)} title={gate.error ?? gate.calls.map(describeCall).join('\n')}>
                          <i>{gate.result}</i> <code>{gate.source}</code>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {candidates.length > 200 && <p className="hint">{candidates.length - 200} more candidates are not listed.</p>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** At a decision: pick another option, change a binding, or make a referee's change. The branch opens beside its parent. */
function ForkControls({ info, watched }: { info: DecisionInfo; watched: Watched }) {
  const draft = useStudio((state) => state.draft);
  const tool = useStudio((state) => state.refereeTool);
  const { registry, scenario, behaviors } = watched.compiled;
  const referee = studio.refereeSeat();
  const mutable = [...registry.cellLayers.values()].filter((layer) => layer.mutable);
  const seats = Object.keys(scenario.doc.seats).filter((seat) => !scenario.doc.seats[seat].referee);
  const valuesOf = (layer: (typeof mutable)[number]) => (layer.type.k === 'enum' ? registry.enums.get(layer.type.name)! : layer.type.k === 'bool' ? [true, false] : []);
  useEffect(() => {
    studio.tool = tool ? (event) => {
      if (event.type === 'down' && event.cell) studio.paintGround(event.cell);
      return true;
    } : null;
    return () => { studio.tool = null; };
  }, [tool]);
  const changes = draft.author?.changes ?? [];
  const touched = Boolean(draft.choose || changes.length > 0 || Object.keys(draft.bind ?? {}).length > 0);
  return (
    <div className="fork">
      <h4>Fork here</h4>
      <div className="binds"><span className="hint">Bind for the rest of the match: </span>
        {seats.map((seat) => (
          <span key={seat} className="bind">{seat}
            <select aria-label={`Bind ${seat}`} value={draft.bind?.[seat] ?? ''} onChange={(event) => {
              const bind = { ...draft.bind };
              if (event.target.value) bind[seat] = event.target.value;
              else delete bind[seat];
              studio.setDraft({ ...draft, bind });
            }}>
              <option value="">as played</option>
              <option value="random">random</option>
              {[...behaviors.byName.keys()].map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </span>
        ))}
      </div>
      {mutable.length === 0 ? <p className="hint">This ruleset has no mutable layer, so there is no ground for a referee to change.</p>
        : !referee ? <p className="hint">A referee change needs a referee seat, and this scenario has none.</p>
          : (
            <div className="referee">
              <span>Referee: paint </span>
              {mutable.flatMap((layer) => valuesOf(layer).map((value) => (
                <button key={`${layer.name}:${value}`} className={tool?.layer === layer.name && tool.value === value ? 'on' : ''}
                  onClick={() => studio.set({ refereeTool: tool?.layer === layer.name && tool.value === value ? null : { layer: layer.name, value } })}>
                  {layer.name} {String(value)}
                </button>
              )))}
              {changes.length > 0 && <span className="hint"> {changes.length} {changes.length === 1 ? 'change' : 'changes'} <button onClick={() => studio.setDraft({ ...draft, author: undefined })}>Clear</button></span>}
              {tool && <p className="hint">Click cells on the board to write them.</p>}
            </div>
          )}
      <div className="row">
        <button className="primary" disabled={!touched} onClick={() => void studio.runFork()}>Run the fork</button>
        {draft.choose ? <span className="hint">chooses {optionText(draft.choose)}</span> : <span className="hint">the seat’s behavior chooses, unless you pick an option above</span>}
      </div>
    </div>
  );
}

function DecisionInspector({ watched }: { watched: Watched }) {
  const decision = useStudio((state) => state.decision);
  const draft = useStudio((state) => state.draft);
  if (!decision) return null;
  const entry = watched.log[decision.seq] as Extract<GameEvent, { t: 'intent' }>;
  const info = decision.info;
  if (!info) return <div className="decision"><h3>Decision</h3><p className="hint">{decision.error ?? `${entry.seat} chose among ${entry.of} options…`}</p></div>;
  const grid = watched.compiled.scenario.map?.grid === 'square';
  const best = info.scores ? Math.max(...info.scores) : null;
  return (
    <div className="decision">
      <h3>Decision <span className="hint">entry {decision.seq}</span></h3>
      <Fields rows={[['seat', info.seat], ['driven by', info.driver], ['options', String(info.options.length)]]} />
      <div className="options" data-testid="options">
        {info.options.map((option, index) => (
          <button key={index} className={`option${index === info.chosen ? ' chosen' : ''}${draft.choose && JSON.stringify(draft.choose) === JSON.stringify(option) ? ' on' : ''}`}
            onClick={() => studio.setDraft({ ...draft, choose: draft.choose && JSON.stringify(draft.choose) === JSON.stringify(option) ? undefined : option })} title="Choose this in a fork">
            <span className="score">{info.scores ? info.scores[index].toFixed(info.scores[index] % 1 ? 1 : 0) : '·'}</span>
            <span className={best !== null && info.scores![index] === best ? 'best' : ''}>{optionText(option)}</span>
            {index === info.chosen && <i> chosen</i>}
          </button>
        ))}
      </div>
      <ForkControls info={info} watched={watched} />
      {grid ? <Overlay info={info} /> : <p className="hint">The debug overlay is unavailable: this map has no grid, so core asks no spatial question of it.</p>}
    </div>
  );
}

function BranchBar({ watched }: { watched: Watched }) {
  const branch = useStudio((state) => state.branch);
  const revision = useStudio((state) => state.revision);
  const variant = useStudio((state) => state.variant);
  const [id, setId] = useState('');
  const forks = useMemo(() => studio.forks(), [revision, variant]);
  return (
    <div className="forks">
      {branch?.fork && (
        <form className="row" onSubmit={(event) => { event.preventDefault(); if (id) studio.saveBranch(id); }}>
          <span>{branch.fork.id ? `Fork “${branch.fork.id}”` : 'An unsaved fork'} leaves at entry {branch.fork.at}.</span>
          {!branch.fork.id && <><input aria-label="Fork id" placeholder="fork id" value={id} onChange={(event) => setId(event.target.value.replace(/[^A-Za-z0-9_-]/g, '-'))} size={12} /><button type="submit" disabled={!id}>Save the fork</button></>}
        </form>
      )}
      {forks.length > 0 && (
        <label>Saved forks
          <select aria-label="Saved forks" value="" onChange={(event) => event.target.value && void studio.openFork(event.target.value)}>
            <option value="">Open…</option>
            {forks.map((fork) => <option key={fork.fork.id} value={fork.fork.id}>{fork.fork.title ?? fork.fork.id} · seed {fork.seed} · entry {fork.at}{fork.parent ? ` · of ${fork.parent}` : ''}</option>)}
          </select>
        </label>
      )}
      <span className="hint">{watched.fork ? '' : ''}</span>
    </div>
  );
}

export function Inspector() {
  const mode = useStudio((state) => state.mode);
  useStudio((state) => state.match);
  useStudio((state) => state.branch);
  useStudio((state) => state.focus);
  const cursor = useStudio((state) => state.cursor);
  const selection = useStudio((state) => state.selection);
  const hash = useStudio((state) => state.hash);
  const variant = useStudio((state) => state.variant);
  const compiled = useStudio((state) => state.compiled);
  const watched = mode === 'run' ? studio.watched : null;
  if (!watched) {
    if (!compiled) return <div className="panel"><h2>Inspector</h2></div>;
    const start = studio.startState(compiled);
    return (
      <div className="panel inspector">
        <h2>Inspector</h2>
        {selection?.entity && start.entities[selection.entity] && (
          <Fields rows={[['id', selection.entity], ['kind', start.entities[selection.entity].kind], ...Object.entries(start.entities[selection.entity].fields).map(([name, value]): [string, string] => [name, show(value)])]} />
        )}
        {!selection?.entity && <p className="hint">Select a token on the board.</p>}
      </div>
    );
  }
  const state = watched.cache.at(cursor);
  const before = watched.cache.at(Math.max(0, cursor - 1));
  const record = watched.record;
  return (
    <div className="panel inspector">
      <h2>Inspector</h2>
      <BranchBar watched={watched} />
      <DecisionInspector watched={watched} />
      {selection?.entity && <EntityInspector watched={watched} id={selection.entity} state={state} before={before} />}
      {selection?.cell && <CellInspector watched={watched} cell={selection.cell} state={state} />}
      <h3>Match</h3>
      <Fields rows={[
        ['ruleset', `${record.ruleset}@${record.version}`], ['scenario', record.scenario], ['map', watched.compiled.scenario.map?.id ?? (watched.compiled.scenario.map ? 'inline' : 'none')],
        ['variant', `${variant} · ${watched.hash}${hash && hash !== watched.hash ? ' (changed since)' : ''}`], ['seed', watched.seed],
        ['outcome', show(record.outcome)], ['decisions', `${record.decisions} (${record.forced} forced)`], ['options', `mean ${record.options.mean}, max ${record.options.max}`],
        ['events', String(record.events)], ['entities', `${record.entities.start} at the start, ${record.entities.end} at the end`], ['logHash', record.logHash],
        ...Object.entries(record.seats).map(([seat, held]): [string, string] => [`seat ${seat}`, `${held.driver} · ${held.decisions} decisions`]),
      ]} />
    </div>
  );
}
