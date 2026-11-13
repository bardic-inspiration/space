// Build (spec 11). Everything it changes is written to the variant in hand;
// editing on a base variant first asks for a new variant's name. Painting the
// ground in play is not Build: that is a referee change in a fork.

import { useEffect, useMemo, useRef, useState } from 'react';
import { addEntity, addLink, deleteEntity, entityIndex, linksOf, removeLink, setField } from '../build/entities.ts';
import {
  blankMap, checkModel, cloneModel, fill, paintRect, readMap, requiredPlace, resize, setCell, valueAt, writeMap, type Edge, type MapModel,
} from '../build/mapedit.ts';
import { showType, type MapDoc, type ScenarioDoc, type Value } from '../core.ts';
import { diffLines, type VariantDoc } from '../project/project.ts';
import { Editor } from './Editor.tsx';
import { show } from './Inline.tsx';
import { studio, useStudio } from './studio.ts';

const TABS = ['Variant', 'Map', 'Entities', 'Files'] as const;
type Tab = (typeof TABS)[number];

// ── Variants and run settings ───────────────────────────────────────────────

function Ordered({ label, all, chosen, onChange }: { label: string; all: string[]; chosen: string[]; onChange(next: string[]): void }) {
  const move = (id: string, by: number) => {
    const at = chosen.indexOf(id);
    const next = [...chosen];
    next.splice(at, 1);
    next.splice(Math.max(0, at + by), 0, id);
    onChange(next);
  };
  return (
    <label><span>{label}</span>
      <span>
        {[...chosen, ...all.filter((id) => !chosen.includes(id))].map((id) => (
          <span key={id} style={{ marginRight: 8, whiteSpace: 'nowrap' }}>
            <input type="checkbox" aria-label={`${label} ${id}`} checked={chosen.includes(id)} onChange={() => onChange(chosen.includes(id) ? chosen.filter((held) => held !== id) : [...chosen, id])} /> {id}
            {chosen.includes(id) && chosen.length > 1 && <> <button onClick={() => move(id, -1)} title="Earlier">↑</button><button onClick={() => move(id, 1)} title="Later">↓</button></>}
          </span>
        ))}
        {all.length === 0 && <span className="hint">none</span>}
      </span>
    </label>
  );
}

function VariantTab() {
  const project = useStudio((state) => state.project)!;
  const ruleset = useStudio((state) => state.ruleset);
  const variant = useStudio((state) => state.variant);
  const resolved = useStudio((state) => state.resolved);
  const compiled = useStudio((state) => state.compiled);
  useStudio((state) => state.revision);
  const [diff, setDiff] = useState<string | null>(null);
  if (!resolved) return null;
  const info = resolved.variant;
  const doc = info.doc;
  const change = (patch: Partial<VariantDoc>) => studio.updateVariant((held) => {
    const next = { ...held, ...patch } as Record<string, unknown>;
    for (const [key, value] of Object.entries(next)) if (value === undefined || (Array.isArray(value) && value.length === 0 && key === 'extensions') || (key === 'bind' && Object.keys(value as object).length === 0)) delete next[key];
    return next as unknown as VariantDoc;
  });
  const ask = (text: string, initial: string) => window.prompt(text, initial)?.trim().replace(/[^A-Za-z0-9_-]+/g, '-');
  const seats = Object.entries((project.doc<ScenarioDoc>(resolved.sources.scenario)?.seats) ?? {});
  const behaviors = compiled ? [...compiled.behaviors.byName.keys()] : [];
  const shadows = project.shadows(ruleset, variant);
  const variantPath = `${project.variantDir(ruleset, variant)}/variant.yaml`;
  return (
    <div>
      <div className="row">
        <b>{info.title}</b><span className="hint">{info.base ? 'a scenario as written: read-only' : `studio/variants/${ruleset}/${variant}`}</span>
      </div>
      <div className="row">
        <button onClick={() => { const id = ask('A new variant of this one. Its id:', `${info.scenario}-variant`); if (id) try { project.createVariant(ruleset, id, info); void studio.select(ruleset, id); } catch (error) { studio.set({ error: (error as Error).message }); } }}>{info.base ? 'New variant' : 'Duplicate'}</button>
        {!info.base && <button onClick={() => { const id = ask('Rename this variant to:', variant); if (id && id !== variant) try { project.renameVariant(ruleset, variant, id); void studio.select(ruleset, id); } catch (error) { studio.set({ error: (error as Error).message }); } }}>Rename</button>}
        {!info.base && <button onClick={() => { if (window.confirm(`Delete the variant "${variant}" and its files?`)) { project.deleteVariant(ruleset, variant); void studio.select(ruleset); } }}>Delete</button>}
        {!info.base && <><button disabled={!studio.canUndo(variantPath)} onClick={() => studio.undo(variantPath)}>Undo</button><button disabled={!studio.canRedo(variantPath)} onClick={() => studio.undo(variantPath, true)}>Redo</button></>}
      </div>
      <h4>Run settings</h4>
      <div className="form">
        {!info.base && <label><span>Title</span><input aria-label="Title" defaultValue={doc.variant.title ?? ''} key={variant} onBlur={(event) => event.target.value !== (doc.variant.title ?? '') && change({ variant: { ...doc.variant, title: event.target.value || undefined } })} /></label>}
        <label><span>Scenario</span>
          <select aria-label="Scenario" value={doc.scenario} onChange={(event) => change({ scenario: event.target.value, bind: undefined })}>
            {project.ids(ruleset, variant, 'scenarios').map((id) => <option key={id}>{id}</option>)}
          </select>
        </label>
        <label><span>Map</span>
          <select aria-label="Map" value={doc.map ?? ''} onChange={(event) => change({ map: event.target.value || undefined })}>
            <option value="">the scenario’s own</option>
            {project.ids(ruleset, variant, 'maps').map((id) => <option key={id}>{id}</option>)}
          </select>
        </label>
        <Ordered label="Extensions" all={project.ids(ruleset, variant, 'extensions')} chosen={doc.extensions ?? []} onChange={(extensions) => change({ extensions })} />
        <Ordered label="Behavior sets" all={project.ids(ruleset, variant, 'behaviors')} chosen={doc.behaviors ?? ['default']} onChange={(sets) => sets.length > 0 && change({ behaviors: sets })} />
        {seats.filter(([, seat]) => !seat.referee).map(([seat, spec]) => (
          <label key={seat}><span>Seat {seat}</span>
            <select aria-label={`Seat ${seat}`} value={doc.bind?.[seat] ?? ''} onChange={(event) => {
              const bind = { ...doc.bind };
              if (event.target.value) bind[seat] = event.target.value;
              else delete bind[seat];
              change({ bind });
            }}>
              <option value="">{spec.behavior ? `the scenario’s: ${spec.behavior}` : 'the scenario’s: random'}</option>
              <option value="random">random</option>
              {behaviors.map((name) => <option key={name}>{name}</option>)}
            </select>
          </label>
        ))}
        <label><span>Decision limit</span><input aria-label="Decision limit" type="number" min={1} placeholder="the scenario’s" defaultValue={doc.limits?.maxDecisions ?? ''} key={`${variant}-limit`}
          onBlur={(event) => change({ limits: event.target.value ? { maxDecisions: Number(event.target.value) } : undefined })} /></label>
        <label><span>Seeds</span><span>
          <input aria-label="Seeds from" type="number" defaultValue={doc.seeds?.from ?? 1} key={`${variant}-from`} style={{ width: 70 }} onBlur={(event) => change({ seeds: { from: Number(event.target.value), to: doc.seeds?.to ?? 40 } })} /> to{' '}
          <input aria-label="Seeds to" type="number" defaultValue={doc.seeds?.to ?? 40} key={`${variant}-to`} style={{ width: 70 }} onBlur={(event) => change({ seeds: { from: doc.seeds?.from ?? 1, to: Number(event.target.value) } })} />
        </span></label>
      </div>
      {!info.base && (
        <>
          <h4>Shadowed files</h4>
          {shadows.length === 0 && <p className="hint">None. A behavior change is an overlay set, and a map swap is the `map` line; a whole-file shadow is for what those cannot say.</p>}
          {shadows.map((rel) => (
            <div key={rel}><button onClick={() => setDiff(diff === rel ? null : rel)}>{diff === rel ? '▾' : '▸'} {rel}</button> <span className="hint">{project.has(`rulesets/${ruleset}/${rel}`) ? 'shadows the base file' : 'added: the base has no such file'}</span>
              {diff === rel && (
                <div className="diff" data-testid="diff">
                  {diffLines(project.text(`rulesets/${ruleset}/${rel}`) ?? '', project.text(`${project.variantDir(ruleset, variant)}/files/${rel}`) ?? '').filter((line, index, all) => line.op !== ' ' || all.slice(Math.max(0, index - 2), index + 3).some((near) => near.op !== ' '))
                    .map((line, index) => <div key={index} className={line.op === '+' ? 'add' : line.op === '-' ? 'del' : ''}>{line.op} {line.line}</div>)}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ── The map editor ──────────────────────────────────────────────────────────

type Tool = 'brush' | 'rectangle' | 'fill' | 'eyedropper' | 'point' | 'area' | 'move';

function MapTab() {
  const project = useStudio((state) => state.project)!;
  const ruleset = useStudio((state) => state.ruleset);
  const variant = useStudio((state) => state.variant);
  const resolved = useStudio((state) => state.resolved);
  const compiled = useStudio((state) => state.compiled);
  const revision = useStudio((state) => state.revision);
  const registry = compiled?.registry;
  const scenarioDoc = resolved ? (resolved.input.scenario as ScenarioDoc) : undefined;
  const mapId = resolved?.variant.doc.map ?? scenarioDoc?.map ?? (scenarioDoc?.space ? undefined : registry?.space.map?.standard);
  const rel = mapId === undefined ? undefined : `maps/${mapId}.yaml`;
  const file = rel === undefined ? undefined : studio.document(rel);
  const [tool, setTool] = useState<Tool>('brush');
  const layers = registry ? [...registry.cellLayers.values()] : [];
  const [layerName, setLayer] = useState('');
  const layer = layers.find((held) => held.name === layerName) ?? layers[0];
  const [value, setValue] = useState<Value>(null);
  const [place, setPlace] = useState('');
  const model = useRef<MapModel | null>(null);
  const [, redraw] = useState(0);
  const only = registry?.space.map?.only === true;
  const gridded = registry?.space.grid === 'square';

  // The model follows the file: a save, an undo, another variant.
  useEffect(() => {
    const doc = file?.text === undefined ? undefined : studio.parsed<MapDoc>(file.path);
    model.current = doc && registry ? readMap(doc, registry) : null;
    preview();
    redraw((count) => count + 1);
    return () => studio.set({ preview: null, marks: [] });
  }, [file?.path, file?.text, registry, revision]);

  const values: Value[] = !layer || !registry ? [] : layer.type.k === 'enum' ? registry.enums.get(layer.type.name)! : layer.type.k === 'bool' ? [false, true] : [];
  useEffect(() => { if (layer) setValue(values.find((held) => held !== layer.default) ?? (layer.default as Value)); }, [layer?.name, registry]);

  const checked = model.current && registry ? checkModel(model.current, registry) : null;
  function preview() {
    if (!model.current || !registry) return studio.set({ preview: null, marks: [] });
    const made = checkModel(model.current, registry);
    studio.set({ preview: made.map, marks: made.marks });
  }
  /** Every edit is checked and saved either way, so work in progress is not lost. */
  const save = () => {
    if (!model.current || !registry || rel === undefined) return;
    studio.writeDocument(rel, writeMap(file?.text, model.current, registry));
  };

  useEffect(() => {
    if (only || !registry) return undefined;
    let start: { x: number; y: number } | null = null;
    let before: MapModel | null = null;
    let moving: string | null = null;
    studio.tool = (event) => {
      const held = model.current;
      if (!held) return false;
      const at = gridded ? event.cell : { x: Math.round(event.point.x * 4) / 4, y: Math.round(event.point.y * 4) / 4 };
      if (!at) return event.type !== 'down';
      if (tool === 'point' || tool === 'area' || tool === 'move') {
        const name = place.trim();
        if (event.type === 'down') {
          start = at;
          moving = tool === 'move' ? Object.keys(held.places).find((id) => {
            const [x, y] = held.places[id].at;
            const [w, h] = held.places[id].size ?? (gridded ? [1, 1] : [0.5, 0.5]);
            return at.x >= x - (gridded ? 0 : 0.25) && at.y >= y - (gridded ? 0 : 0.25) && at.x < x + w && at.y < y + h;
          }) ?? null : null;
          return true;
        }
        if (!start) return true;
        if (tool === 'move' && moving) held.places[moving] = { ...held.places[moving], at: [at.x, at.y] };
        else if (tool === 'point' && name && event.type === 'up') held.places[name] = { at: [at.x, at.y] };
        else if (tool === 'area' && name) {
          const [x0, y0, x1, y1] = [Math.min(start.x, at.x), Math.min(start.y, at.y), Math.max(start.x, at.x), Math.max(start.y, at.y)];
          held.places[name] = { at: [x0, y0], size: [x1 - x0 + (gridded ? 1 : 0), y1 - y0 + (gridded ? 1 : 0)] };
        }
        preview();
        if (event.type === 'up') { start = null; save(); }
        return true;
      }
      if (!layer || !gridded) return false;
      if (tool === 'eyedropper') {
        if (event.type === 'down') setValue(valueAt(held, registry, at.x, at.y, layer.name));
        return true;
      }
      if (event.type === 'down') { start = at; before = cloneModel(held); }
      if (!start) return true;
      if (tool === 'brush') setCell(held, registry, at.x, at.y, layer.name, value);
      else if (tool === 'fill' && event.type === 'down') fill(held, registry, at.x, at.y, layer.name, value);
      else if (tool === 'rectangle' && before) {
        held.cells = cloneModel(before).cells;
        paintRect(held, registry, start, at, layer.name, value);
      }
      preview();
      if (event.type === 'up') { start = null; before = null; save(); }
      return true;
    };
    return () => { studio.tool = null; };
  }, [tool, layer?.name, value, place, registry, only, gridded, rel, file?.text]);

  if (!registry || !resolved) return null;
  if (!registry.hasSpace) return <p className="hint">This ruleset declares no space, so it has no map.</p>;
  const newMap = (from?: MapModel) => {
    const id = window.prompt('A new map document. Its id:', `${resolved.variant.scenario}-map`)?.trim().replace(/[^a-z0-9-]+/g, '-');
    if (!id) return;
    const made = from ? { ...cloneModel(from), id, title: undefined } : blankMap(registry, id);
    if (studio.writeDocument(`maps/${id}.yaml`, writeMap(undefined, made, registry))) studio.updateVariant((doc) => ({ ...doc, map: id }));
  };
  const inline = scenarioDoc?.space;
  if (rel === undefined || !model.current) {
    return (
      <div>
        <p className="hint">{inline ? 'This scenario writes its map inline. The editor works on a map document: make one from it, and the variant plays on that instead.' : 'This scenario names no map.'}</p>
        {!only && <button onClick={() => newMap(inline && compiled?.scenario.map ? readMap({ format: 2, map: { id: 'inline' }, ruleset: { id: registry.id, version: registry.version }, width: inline.width, height: inline.height, cells: inline.cells, places: inline.places } as MapDoc, registry) : undefined)}>{inline ? 'Make a map document from it' : 'New map'}</button>}
      </div>
    );
  }
  const held = model.current;
  const grow = (edge: Edge, by: number) => {
    const refusal = resize(held, registry, edge, by);
    if (refusal) return studio.set({ error: refusal });
    preview();
    save();
  };
  const saved = file!.path;
  return (
    <div>
      <div className="row"><b>{held.title ?? held.id}</b><span className="hint">{file!.path} · {held.width} by {held.height}</span></div>
      {only && <div className="readonly" data-testid="map-readonly">Read-only: {registry.id} is played on its standard map, “{registry.space.map!.standard}”, and no other, so there is nothing here to edit.</div>}
      {!only && (
        <>
          <div className="row">
            <button disabled={!studio.canUndo(saved)} onClick={() => studio.undo(saved)}>Undo</button>
            <button disabled={!studio.canRedo(saved)} onClick={() => studio.undo(saved, true)}>Redo</button>
            <button onClick={() => newMap()}>New map</button><button onClick={() => newMap(held)}>Copy as a new map</button>
          </div>
          {gridded ? (
            <>
              <h4>Paint</h4>
              <div className="row palette">
                {(['brush', 'rectangle', 'fill', 'eyedropper'] as Tool[]).map((id) => <button key={id} className={tool === id ? 'on' : ''} onClick={() => setTool(id)}>{id}</button>)}
              </div>
              {layers.length === 0 ? <p className="hint">This ruleset declares no cell layers: its cells hold nothing to paint.</p> : (
                <div className="row palette">
                  <select aria-label="Layer" value={layer?.name} onChange={(event) => setLayer(event.target.value)}>{layers.map((spec) => <option key={spec.name} value={spec.name}>{spec.name}</option>)}</select>
                  {values.length > 0
                    ? values.map((option) => <button key={String(option)} className={value === option ? 'on' : ''} onClick={() => setValue(option)}>{String(option)}{option === layer?.default ? ' (default)' : ''}</button>)
                    : layer?.type.k === 'string' ? <input aria-label="Value" value={String(value ?? '')} onChange={(event) => setValue(event.target.value)} />
                      : <input aria-label="Value" type="number" value={Number(value ?? 0)} onChange={(event) => setValue(Number(event.target.value))} />}
                </div>
              )}
            </>
          ) : <p className="hint">A plane without a grid has places and a size, and no paint tools.</p>}
          <h4>Size</h4>
          <div className="row">
            {(['left', 'right', 'top', 'bottom'] as Edge[]).map((edge) => <span key={edge}>{edge} <button aria-label={`Grow ${edge}`} onClick={() => grow(edge, 1)}>+</button><button aria-label={`Shrink ${edge}`} onClick={() => grow(edge, -1)}>−</button></span>)}
          </div>
          <h4>Places</h4>
          <div className="row palette">
            <input aria-label="Place name" placeholder="name" value={place} onChange={(event) => setPlace(event.target.value.replace(/[^A-Za-z0-9_]/g, ''))} size={10} />
            {(['point', 'area', 'move'] as Tool[]).map((id) => <button key={id} className={tool === id ? 'on' : ''} onClick={() => setTool(id)} title={id === 'point' ? 'Click to put the named place at a point' : id === 'area' ? 'Drag out the named place as an area' : 'Drag a place to move it'}>{id === 'point' ? 'add a point' : id === 'area' ? 'drag out an area' : 'move'}</button>)}
          </div>
          <ul className="plain places">
            {Object.entries(held.places).map(([name, spot]) => (
              <li key={name}><b>{name}</b> <span className="hint">at ({spot.at.join(', ')}){spot.size ? `, ${spot.size.join(' by ')}` : ''}</span>
                {requiredPlace(registry, name) ? <span className="hint">required by the ruleset</span> : <button onClick={() => { delete held.places[name]; preview(); save(); }}>Delete</button>}
                <button onClick={() => { const to = window.prompt('Rename the place to:', name)?.replace(/[^A-Za-z0-9_]/g, ''); if (to && to !== name && !requiredPlace(registry, name)) { held.places[to] = held.places[name]; delete held.places[name]; preview(); save(); } }} disabled={requiredPlace(registry, name)}>Rename</button>
              </li>
            ))}
            {(registry.space.places ?? []).filter((name) => !(name in held.places)).map((name) => <li key={name} className="stale">{name}: missing, and the ruleset needs every map to have it</li>)}
          </ul>
        </>
      )}
      {checked && checked.issues.length > 0 && (
        <div data-testid="map-issues">
          <h4>What core refuses</h4>
          <ul className="plain">{checked.issues.map((issue, index) => <li key={index} className="stale">{issue.path.replace(/^cell\.(\d+),(\d+)/, '($1, $2)')}: {issue.message}</li>)}</ul>
          <p className="hint">The map is saved either way, so work in progress is not lost; a variant whose map fails cannot be run.</p>
        </div>
      )}
    </div>
  );
}

// ── Entities ────────────────────────────────────────────────────────────────

function EntitiesTab() {
  const project = useStudio((state) => state.project)!;
  const resolved = useStudio((state) => state.resolved);
  const compiled = useStudio((state) => state.compiled);
  const selection = useStudio((state) => state.selection);
  const issues = useStudio((state) => state.issues);
  useStudio((state) => state.revision);
  const [kind, setKind] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [id, setId] = useState('');
  const [link, setLink] = useState({ rel: '', other: '' });
  const rel = resolved ? `scenarios/${resolved.variant.scenario}.yaml` : '';
  const file = resolved ? studio.document(rel) : undefined;
  const registry = compiled?.registry;
  const scenario = compiled?.scenario;
  const doc = file ? project.doc<ScenarioDoc>(file.path) : undefined;
  const start = useMemo(() => (compiled ? studio.startState(compiled) : null), [compiled]);
  const tokens = useMemo(() => new Map((registry ? [...registry.kinds.values()] : []).flatMap((spec) => {
    const cells = [...spec.fields.values()].filter((field) => field.type.k === 'cell');
    return cells.length === 1 ? [[spec.name, cells[0].name] as const] : [];
  })), [registry]);

  // Drag a token to move it: its cell field is rewritten, or set to a place's name when dropped on a point place with Alt held.
  useEffect(() => {
    if (!scenario || !start || !file?.text) return undefined;
    let dragging: string | null = null;
    studio.tool = (event) => {
      if (event.type === 'down') {
        dragging = event.pick?.entity ?? null;
        if (dragging) studio.selectEntity(dragging);
        return dragging !== null;
      }
      if (event.type === 'up' && dragging && event.cell) {
        const entity = start.entities[dragging];
        const field = entity && tokens.get(entity.kind);
        const index = entityIndex(scenario, dragging);
        const place = Object.entries(scenario.map?.places ?? {}).find(([, spot]) => spot.width === undefined && spot.x === event.cell!.x && spot.y === event.cell!.y)?.[0];
        if (field && index >= 0) studio.writeDocument(rel, setField(file.text!, index, field, event.alt && place ? place : [event.cell.x, event.cell.y]));
        dragging = null;
      }
      return true;
    };
    return () => { studio.tool = null; };
  }, [scenario, start, file?.text, rel, tokens]);

  if (!registry || !scenario || !file?.text || !start || !doc) return null;
  const spec = registry.kinds.get(kind) ?? [...registry.kinds.values()][0];
  const selected = selection?.entity && start.entities[selection.entity] ? selection.entity : undefined;
  const parse = (type: { k: string }, text: string): unknown => {
    if (type.k === 'int' || type.k === 'number') return Number(text);
    if (type.k === 'bool') return text === 'true';
    if (type.k === 'cell') return text.split(',').map((part) => Number(part.trim()));
    if (type.k === 'list' || type.k === 'map') return JSON.parse(text);
    return text;
  };
  const add = () => {
    try {
      const given = Object.fromEntries([...spec.fields.values()].filter((field) => (fields[field.name] ?? '') !== '').map((field) => [field.name, parse(field.type, fields[field.name])]));
      studio.writeDocument(rel, addEntity(file.text!, { id: id || undefined, kind: spec.name, fields: given }));
      setId('');
    } catch (error) {
      studio.set({ error: `That value does not parse: ${(error as Error).message}` });
    }
  };
  const relations = [...registry.relations].filter(([, relation]) => selected && (relation.from === start.entities[selected].kind || relation.to === start.entities[selected].kind));
  const chosen = relations.find(([name]) => name === link.rel) ?? relations[0];
  const forward = chosen && selected ? chosen[1].from === start.entities[selected].kind : true;
  const others = chosen ? Object.keys(start.entities).filter((other) => start.entities[other].kind === (forward ? chosen[1].to : chosen[1].from)) : [];
  const refused = issues.filter((issue) => issue.file === file.path);
  return (
    <div>
      <p className="hint">{file.path} · Drag a token on the board to move it. Hold Alt and drop it on a point place to stand it there by name.</p>
      <div className="row"><button disabled={!studio.canUndo(file.path)} onClick={() => studio.undo(file.path)}>Undo</button><button disabled={!studio.canRedo(file.path)} onClick={() => studio.undo(file.path, true)}>Redo</button></div>
      {refused.length > 0 && <ul className="plain" data-testid="entity-issues">{refused.map((issue, index) => <li key={index} className="stale">{issue.path}: {issue.message}</li>)}</ul>}
      {selected && (
        <>
          <h4>{selected} <span className="hint">{start.entities[selected].kind}</span></h4>
          <div className="row"><button onClick={() => { studio.writeDocument(rel, deleteEntity(file.text!, entityIndex(scenario, selected), selected)); studio.selectEntity(undefined); }}>Delete this entity</button></div>
          <ul className="plain">
            {linksOf(doc).filter((held) => held.from === selected || held.to === selected).map((held, index) => (
              <li key={index}>{held.rel}: {held.from} → {held.to} <button onClick={() => studio.writeDocument(rel, removeLink(file.text!, held))}>Remove</button></li>
            ))}
          </ul>
          {chosen && (
            <div className="row">
              <select aria-label="Relation" value={chosen[0]} onChange={(event) => setLink({ rel: event.target.value, other: '' })}>{relations.map(([name]) => <option key={name}>{name}</option>)}</select>
              <span>{forward ? 'to' : 'from'}</span>
              <select aria-label="Other entity" value={link.other} onChange={(event) => setLink({ rel: chosen[0], other: event.target.value })}><option value="">…</option>{others.map((other) => <option key={other}>{other}</option>)}</select>
              <button disabled={!link.other} onClick={() => studio.writeDocument(rel, addLink(file.text!, { rel: chosen[0], from: forward ? selected : link.other, to: forward ? link.other : selected }))}>Add the link</button>
            </div>
          )}
        </>
      )}
      <h4>Add an entity</h4>
      <div className="form">
        <label><span>Kind</span><select aria-label="Kind" value={spec.name} onChange={(event) => { setKind(event.target.value); setFields({}); }}>{[...registry.kinds.keys()].map((name) => <option key={name}>{name}</option>)}</select></label>
        <label><span>Id</span><input aria-label="Entity id" placeholder="given one when empty" value={id} onChange={(event) => setId(event.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} /></label>
        {[...spec.fields.values()].map((field) => {
          const type = field.type;
          const required = field.default === undefined && field.init === undefined;
          const set = (text: string) => setFields({ ...fields, [field.name]: text });
          const options = type.k === 'enum' ? registry.enums.get(type.name)! : type.k === 'seat' ? Object.keys(doc.seats) : type.k === 'bool' ? ['true', 'false']
            : type.k === 'ref' ? Object.keys(start.entities).filter((other) => start.entities[other].kind === type.kind) : null;
          return (
            <label key={field.name} title={showType(type)}><span>{field.name}{required ? ' *' : ''}</span>
              {options
                ? <select aria-label={field.name} value={fields[field.name] ?? ''} onChange={(event) => set(event.target.value)}><option value="">{required ? '…' : `default: ${show(field.default) || 'computed'}`}</option>{options.map((option) => <option key={option}>{option}</option>)}</select>
                : <input aria-label={field.name} type={type.k === 'int' || type.k === 'number' ? 'number' : 'text'} value={fields[field.name] ?? ''} onChange={(event) => set(event.target.value)}
                    placeholder={type.k === 'cell' ? 'x, y' : type.k === 'list' || type.k === 'map' ? `${showType(type)} as JSON` : required ? showType(type) : `default: ${field.init ? 'computed' : show(field.default)}`} />}
            </label>
          );
        })}
      </div>
      {spec.checks.length > 0 && <p className="hint">Every {spec.name} must pass: {spec.checks.map((check) => check.message).join('; ')}.</p>}
      <button className="primary" onClick={add}>Add the {spec.name}</button>
    </div>
  );
}

// ── YAML editors ────────────────────────────────────────────────────────────

function FilesTab({ open, line }: { open: string | null; line?: number }) {
  const project = useStudio((state) => state.project)!;
  const ruleset = useStudio((state) => state.ruleset);
  const variant = useStudio((state) => state.variant);
  const issues = useStudio((state) => state.issues);
  useStudio((state) => state.revision);
  const [chosen, setChosen] = useState<string>('ruleset.yaml');
  const base = variant.startsWith('@');
  const studioFiles = [
    ...(base ? [] : [`${project.variantDir(ruleset, variant)}/variant.yaml`]),
    ...project.under(`studio/presentation/${ruleset}`), ...(project.has(`studio/metrics/${ruleset}.yaml`) ? [`studio/metrics/${ruleset}.yaml`] : []),
  ];
  // A path from the errors list is a file; find the document or the studio file it is.
  useEffect(() => {
    if (!open) return;
    const prefix = `${project.variantDir(ruleset, variant)}/files/`;
    setChosen(open.startsWith(prefix) ? open.slice(prefix.length) : open.startsWith(`rulesets/${ruleset}/`) ? open.slice(`rulesets/${ruleset}/`.length) : open);
  }, [open, line]);
  const isStudio = chosen.startsWith('studio/') || chosen.startsWith('kit/');
  const file = isStudio ? { path: chosen, text: project.text(chosen), shadowed: true } : studio.document(chosen);
  const readOnly = chosen.startsWith('kit/');
  return (
    <div>
      <div className="files">
        <div className="group">The ruleset’s documents{base ? '' : ' · bold: shadowed or added by this variant'}</div>
        {project.documents(ruleset, variant).map((rel) => <button key={rel} className={`${chosen === rel ? 'on' : ''}${studio.document(rel).shadowed ? ' shadow' : ''}`} onClick={() => setChosen(rel)}>{rel}</button>)}
        <div className="group">The studio’s files, edited in place</div>
        {studioFiles.map((path) => <button key={path} className={chosen === path ? 'on' : ''} onClick={() => setChosen(path)}>{path}</button>)}
        {!project.has(studio.presentationPath('default')) && <button onClick={() => { const path = studio.presentationPath('default'); studio.writeFile(path, `format: 1\npresentation: { ruleset: ${studio.state.compiled?.registry.id ?? ruleset} }\n`); setChosen(path); }}>+ write a presentation file</button>}
        {!project.has(`studio/metrics/${ruleset}.yaml`) && <button onClick={() => { const path = `studio/metrics/${ruleset}.yaml`; studio.writeFile(path, 'format: 1\nmetrics: {}\n'); setChosen(path); }}>+ write a metrics file</button>}
      </div>
      <p className="hint" data-testid="editing">{file.path}{isStudio ? '' : file.shadowed ? ' · this variant’s own' : ' · a base file: saving writes a shadow in the variant'}{readOnly ? ' · read-only' : ''}</p>
      <Editor name={`${variant}:${chosen}`} text={file.text ?? ''} issues={issues.filter((issue) => issue.file === file.path)} line={open && line ? line : undefined} readOnly={readOnly}
        onChange={(text) => (isStudio ? studio.writeFile(chosen, text, { soon: true }) : studio.writeDocument(chosen, text, { soon: true }))} />
    </div>
  );
}

export function BuildPanel() {
  const [tab, setTab] = useState<Tab>('Variant');
  const [goto, setGoto] = useState<{ file: string; line?: number; at: number } | null>(null);
  useEffect(() => {
    const onGoto = (event: Event) => {
      const issue = (event as CustomEvent<{ file: string; line?: number }>).detail;
      if (!issue.file) return;
      setTab('Files');
      setGoto({ ...issue, at: Date.now() });
    };
    window.addEventListener('studio:goto', onGoto);
    return () => window.removeEventListener('studio:goto', onGoto);
  }, []);
  return (
    <div className="panel build">
      <div className="tabs">{TABS.map((name) => <button key={name} className={tab === name ? 'on' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
      {tab === 'Variant' && <VariantTab />}
      {tab === 'Map' && <MapTab />}
      {tab === 'Entities' && <EntitiesTab />}
      {tab === 'Files' && <FilesTab open={goto?.file ?? null} line={goto?.line} />}
    </div>
  );
}
