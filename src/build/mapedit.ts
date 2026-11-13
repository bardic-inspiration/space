// The map editor's model (spec 11). A map document is read into a size, the
// cells that differ from their defaults, and the places; edits change that;
// and it is written back as a picture, `rows` and `legend`, keeping the
// file's own symbols (S13).

import { Scalar, isMap, parseDocument, type YAMLMap } from 'yaml';
import type { MapDoc, Registry, SpaceMap, Value } from '../core.ts';
import { buildMap, fitsRuleset } from 'rpg-core/src/runtime/map.ts';
import type { Mark } from '../board/board.ts';

export interface MapModel {
  id: string;
  title?: string;
  ruleset: { id: string; version: string };
  width: number;
  height: number;
  /** `"x,y"` to the layers of that cell that are not at their default. */
  cells: Map<string, Record<string, Value>>;
  places: Record<string, { at: [number, number]; size?: [number, number] }>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (values: Record<string, Value>) => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));

/** The values of a cell without the ones that are the layer's default: two cells that hold the same are then equal. */
function trimmed(registry: Registry, values: Record<string, unknown>): Record<string, Value> {
  return sorted(Object.fromEntries(Object.entries(values).filter(([layer, value]) => !same(registry.cellLayers.get(layer)?.default, value))) as Record<string, Value>);
}

/** Reads a map document as core does: the picture, with listed cells over it. */
export function readMap(doc: MapDoc, registry: Registry): MapModel {
  const rows = doc.rows ?? [];
  const cells = new Map<string, Record<string, Value>>();
  rows.forEach((row, y) => [...row].forEach((symbol, x) => {
    const values = trimmed(registry, doc.legend?.[symbol] ?? {});
    if (Object.keys(values).length > 0) cells.set(`${x},${y}`, values);
  }));
  for (const { at: [x, y], ...values } of doc.cells ?? []) {
    const held = trimmed(registry, values);
    if (Object.keys(held).length > 0) cells.set(`${x},${y}`, held);
    else cells.delete(`${x},${y}`);
  }
  return {
    id: doc.map.id, title: doc.map.title, ruleset: doc.ruleset,
    width: doc.width ?? (rows[0] ? [...rows[0]].length : registry.space.width ?? 8),
    height: doc.height ?? (rows.length || (registry.space.height ?? 8)),
    cells, places: structuredClone(doc.places ?? {}),
  };
}

export const cloneModel = (model: MapModel): MapModel => ({ ...model, cells: new Map([...model.cells].map(([key, values]) => [key, { ...values }])), places: structuredClone(model.places) });

/** A new, empty map document for a ruleset. */
export function blankMap(registry: Registry, id: string): MapModel {
  const [width, height] = registry.space.size?.min ?? [registry.space.width ?? 12, registry.space.height ?? 8];
  return {
    id, ruleset: { id: registry.id, version: registry.version }, width: Math.max(width, registry.space.width ?? 0), height: Math.max(height, registry.space.height ?? 0),
    cells: new Map(), places: Object.fromEntries((registry.space.places ?? []).map((name, index): [string, { at: [number, number] }] => [name, { at: [index, 0] }])),
  };
}

// ── Paint tools: each writes one layer's value ─────────────────────────────

export const valueAt = (model: MapModel, registry: Registry, x: number, y: number, layer: string): Value =>
  model.cells.get(`${x},${y}`)?.[layer] ?? (registry.cellLayers.get(layer)?.default as Value);

export function setCell(model: MapModel, registry: Registry, x: number, y: number, layer: string, value: Value): void {
  if (x < 0 || y < 0 || x >= model.width || y >= model.height) return;
  const key = `${x},${y}`;
  const held = { ...model.cells.get(key) };
  if (same(registry.cellLayers.get(layer)?.default, value)) delete held[layer];
  else held[layer] = value;
  if (Object.keys(held).length === 0) model.cells.delete(key);
  else model.cells.set(key, sorted(held));
}

export function paintRect(model: MapModel, registry: Registry, a: { x: number; y: number }, b: { x: number; y: number }, layer: string, value: Value): void {
  for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) setCell(model, registry, x, y, layer, value);
  }
}

/** Fills the cells joined to a cell, edge to edge, that hold the value it holds. */
export function fill(model: MapModel, registry: Registry, x: number, y: number, layer: string, value: Value): void {
  const from = valueAt(model, registry, x, y, layer);
  if (same(from, value)) return;
  const queue = [[x, y]];
  while (queue.length > 0) {
    const [cx, cy] = queue.pop()!;
    if (cx < 0 || cy < 0 || cx >= model.width || cy >= model.height || !same(valueAt(model, registry, cx, cy, layer), from)) continue;
    setCell(model, registry, cx, cy, layer, value);
    queue.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

// ── Size and places ───────────────────────────────────────────────────────

export type Edge = 'left' | 'right' | 'top' | 'bottom';

/** Grows or shrinks the map from an edge, within what the ruleset's `space.size` allows. Returns why not, when it does not. */
export function resize(model: MapModel, registry: Registry, edge: Edge, by: number): string | null {
  const width = model.width + (edge === 'left' || edge === 'right' ? by : 0);
  const height = model.height + (edge === 'top' || edge === 'bottom' ? by : 0);
  let refusal: string | null = null;
  if (width < 1 || height < 1) return 'a map is at least one cell';
  if (!fitsRuleset(registry, width, height, (_path, message) => { refusal = message; }, 'size')) return refusal;
  const [dx, dy] = [edge === 'left' ? by : 0, edge === 'top' ? by : 0];
  const cells = new Map<string, Record<string, Value>>();
  for (const [key, values] of model.cells) {
    const [x, y] = key.split(',').map(Number);
    if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height) cells.set(`${x + dx},${y + dy}`, values);
  }
  for (const place of Object.values(model.places)) {
    const [w, h] = place.size ?? [0, 0];
    place.at = [Math.max(0, Math.min(width - Math.max(1, w), place.at[0] + dx)), Math.max(0, Math.min(height - Math.max(1, h), place.at[1] + dy))];
  }
  Object.assign(model, { width, height, cells });
  return null;
}

/** Whether a place may be deleted: one the ruleset requires of every map may not. */
export const requiredPlace = (registry: Registry, name: string): boolean => (registry.space.places ?? []).includes(name);

// ── Checking ──────────────────────────────────────────────────────────────

export interface Checked {
  /** The map as a host is given it, for drawing, whether or not it passes. */
  map: SpaceMap;
  /** Cells that fail a `space.checks` rule, each with the rule's message. */
  marks: Mark[];
  /** Everything core refuses about the map: a failed check, a missing required place, a size out of bounds. */
  issues: { path: string; message: string }[];
}

/** Checks a model as `loadMap` checks a document, and builds the map either way: work in progress is drawn, not lost. */
export function checkModel(model: MapModel, registry: Registry): Checked {
  const issues: Checked['issues'] = [];
  const marks: Mark[] = [];
  const report = (path: string, message: string) => {
    issues.push({ path, message });
    const cell = /^cell\.(\d+),(\d+)/.exec(path);
    if (cell) marks.push({ x: Number(cell[1]), y: Number(cell[2]), message });
  };
  fitsRuleset(registry, model.width, model.height, report, 'size');
  const cells = [...model.cells].map(([key, values]) => {
    const [x, y] = key.split(',').map(Number);
    return { x, y, values, path: `cell.${key}` };
  });
  const map = buildMap(registry, model.width, model.height, { cells: registry.space.grid === 'square' ? cells : [], places: model.places }, report, model.id);
  return { map, marks, issues };
}

// ── Writing ───────────────────────────────────────────────────────────────

const SYMBOLS = '#"~^*+=:;,%&@$oOxX0123456789abcdefghijklmnpqrstuvwyzABCDEFGHIJKLMNPQRSTUVWYZ';

const quoted = (text: string): Scalar => {
  const scalar = new Scalar(text);
  scalar.type = Scalar.QUOTE_SINGLE;
  return scalar;
};

/**
 * A map document's text for a model. A grid map is written as a picture,
 * keeping the symbols the file already has and adding new ones as needed; a
 * map with more distinct cells than there are symbols is written with
 * `cells`. A plane without a grid is a size and places. Comments are kept.
 */
export function writeMap(text: string | undefined, model: MapModel, registry: Registry): string {
  const doc = parseDocument(text ?? '{}');
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  const meta = doc.createNode({ id: model.id, ...(model.title ? { title: model.title } : {}) }) as YAMLMap;
  meta.flow = true;
  const rules = doc.createNode(model.ruleset) as YAMLMap;
  rules.flow = true;
  if (!doc.has('format')) doc.set('format', 2);
  if (!same(doc.get('map') && (doc.toJS() as MapDoc).map, { id: model.id, ...(model.title ? { title: model.title } : {}) })) doc.set('map', meta);
  if (!doc.has('ruleset')) doc.set('ruleset', rules);

  const gridded = registry.space.grid === 'square';
  const was = doc.toJS() as MapDoc;
  const picture = (): { legend: Record<string, Record<string, Value>>; rows: string[] } | null => {
    const legend = new Map<string, string>();
    const taken = new Set<string>();
    for (const [symbol, values] of Object.entries(was.legend ?? {})) {
      const key = JSON.stringify(trimmed(registry, values));
      if (!legend.has(key)) legend.set(key, symbol);
      taken.add(symbol);
    }
    const used = new Map<string, string>();
    const symbolFor = (values: Record<string, Value>): string | null => {
      const key = JSON.stringify(values);
      if (!used.has(key)) {
        let symbol = legend.get(key);
        if (symbol === undefined) {
          symbol = key === '{}' && !taken.has('.') ? '.' : [...SYMBOLS].find((candidate) => !taken.has(candidate));
          if (symbol === undefined) return null;
          taken.add(symbol);
        }
        used.set(key, symbol);
      }
      return used.get(key)!;
    };
    const rows: string[] = [];
    for (let y = 0; y < model.height; y++) {
      let row = '';
      for (let x = 0; x < model.width; x++) {
        const symbol = symbolFor(model.cells.get(`${x},${y}`) ?? {});
        if (symbol === null) return null;
        row += symbol;
      }
      rows.push(row);
    }
    // The legend keeps the file's order, then the new symbols; ones no cell uses any more are dropped.
    const order = [...Object.keys(was.legend ?? {}).filter((symbol) => [...used.values()].includes(symbol)), ...[...used.values()].filter((symbol) => !(symbol in (was.legend ?? {})))];
    const bySymbol = new Map([...used].map(([key, symbol]) => [symbol, JSON.parse(key) as Record<string, Value>]));
    return { legend: Object.fromEntries(order.map((symbol) => [symbol, bySymbol.get(symbol)!])), rows };
  };

  const drawn = gridded ? picture() : null;
  if (drawn) {
    if (!same(was.legend, drawn.legend)) {
      const legend = doc.createNode({}) as YAMLMap;
      for (const [symbol, values] of Object.entries(drawn.legend)) {
        const entry = doc.createNode(values) as YAMLMap;
        entry.flow = true;
        legend.add({ key: quoted(symbol), value: entry });
      }
      doc.set('legend', legend);
    }
    if (!same(was.rows, drawn.rows)) {
      const rows = doc.createNode([]) as unknown as { items: Scalar[] };
      rows.items = drawn.rows.map(quoted);
      doc.set('rows', rows);
    }
    for (const key of ['width', 'height', 'cells']) doc.delete(key);
  } else {
    for (const key of ['legend', 'rows']) doc.delete(key);
    doc.set('width', model.width);
    doc.set('height', model.height);
    if (gridded) {
      const cells = doc.createNode([...model.cells].map(([key, values]) => ({ at: key.split(',').map(Number), ...values }))) as unknown as { items: YAMLMap[] };
      for (const cell of cells.items) cell.flow = true;
      doc.set('cells', cells);
    } else doc.delete('cells');
  }
  if (Object.keys(model.places).length === 0) doc.delete('places');
  else if (!same(was.places, model.places)) {
    const places = doc.createNode(model.places) as YAMLMap<Scalar, YAMLMap>;
    for (const item of places.items) if (item.value) item.value.flow = true;
    doc.set('places', places);
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: true });
}
