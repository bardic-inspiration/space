// The map: the one container of v1 (S19). It is an instrument, with rules in
// core's `space` and a look of its own, and the stage the others stand on.
// It draws the plane, the grid when there is one, the cell layers and the
// places, and answers where a cell or a place is.

import * as THREE from 'three';
import type { SpaceMap, Value } from '../core.ts';
import type { BoardPoint, CheckContext, Frame, InstrumentDoc, ItemBase, Where } from '../present/types.ts';
import { PALETTE, RAMP, ramp, type BoardKit, type Bound, type ContainerForm, type Drawn } from './form.ts';

interface ValueLook {
  color: string;
  pattern?: 'hatch' | 'dots';
  raise?: number;
}

export interface LayerLook {
  name: string;
  type: 'values' | 'number';
  mutable: boolean;
  default: Value;
  /** For an enum, bool or string: the look of each value. The default value has none and draws nothing. */
  values: Map<string, ValueLook>;
  ramp: string[];
  domain?: [number, number];
}

export interface BoundMap extends Bound {
  layers: LayerLook[];
  places: Record<string, { label?: string; color?: string }>;
  checker?: string;
}

export interface MapItem extends ItemBase {
  map: SpaceMap;
}

/** How high a cell that blocks movement stands when its look gives no height. */
const BLOCKED_RAISE = 0.6;
const FLAT = 0.02;

function check(name: string, doc: InstrumentDoc, ctx: CheckContext): BoundMap | undefined {
  const { registry } = ctx;
  if (!registry.hasSpace) {
    ctx.issue('', 'the ruleset declares no space, so it has no map');
    return undefined;
  }
  if (doc.of !== undefined) ctx.issue('.of', 'a map is one per ruleset: it has no `of`');
  if (doc.at !== undefined) ctx.issue('.at', 'a map is the stage: it has no `at`');
  for (const layer of Object.keys(doc.layers ?? {})) {
    if (!registry.cellLayers.has(layer)) ctx.issue(`.layers.${layer}`, `the ruleset declares no cell layer "${layer}"`);
  }
  const layers = [...registry.cellLayers.values()].map((spec): LayerLook => {
    const given = doc.layers?.[spec.name];
    const numeric = spec.type.k === 'int' || spec.type.k === 'number';
    const known = spec.type.k === 'enum' ? registry.enums.get(spec.type.name)! : spec.type.k === 'bool' ? ['true', 'false'] : undefined;
    for (const value of Object.keys(given?.values ?? {})) {
      if (numeric) ctx.issue(`.layers.${spec.name}.values`, 'a number layer takes a `ramp` and a `domain`, not values');
      else if (known && !known.includes(value)) ctx.issue(`.layers.${spec.name}.values.${value}`, `"${value}" is not a value of this layer`);
    }
    if (!numeric && (given?.ramp || given?.domain)) ctx.issue(`.layers.${spec.name}`, 'a `ramp` is for a number layer');
    // Other values take colors from the palette in declaration order; the default draws nothing.
    const values = new Map<string, ValueLook>();
    let next = 0;
    for (const value of known ?? []) {
      if (value === String(spec.default)) continue;
      const look = given?.values?.[value];
      values.set(value, { color: look?.color ?? PALETTE[next % PALETTE.length], pattern: look?.pattern, raise: look?.raise });
      next += 1;
    }
    for (const [value, look] of Object.entries(given?.values ?? {})) {
      if (!values.has(value) && !known) values.set(value, { color: look.color ?? PALETTE[next++ % PALETTE.length], pattern: look.pattern, raise: look.raise });
    }
    return { name: spec.name, type: numeric ? 'number' : 'values', mutable: spec.mutable, default: spec.default, values, ramp: given?.ramp ?? RAMP, domain: given?.domain };
  });
  const places = ctx.scenario.map?.places;
  for (const place of Object.keys(doc.places ?? {})) {
    if (places && !(place in places) && !(registry.space.places ?? []).includes(place)) ctx.issue(`.places.${place}`, `the map has no place called "${place}"`);
  }
  return { name, doc, layers, places: doc.places ?? {}, checker: doc.checker };
}

/** The look of one layer value: a string layer's unlisted values take palette colors as they are met. */
export function lookOf(layer: LayerLook, value: Value, domain?: [number, number]): ValueLook | undefined {
  if (JSON.stringify(value) === JSON.stringify(layer.default)) return undefined;
  if (layer.type === 'number') {
    const [low, high] = layer.domain ?? domain ?? [0, 1];
    return { color: ramp(layer.ramp, high === low ? 1 : (Number(value) - low) / (high - low)) };
  }
  const key = String(value);
  if (!layer.values.has(key)) layer.values.set(key, { color: PALETTE[layer.values.size % PALETTE.length] });
  return layer.values.get(key);
}

/** The lowest and highest value of a number layer on a map: its ramp runs over the values present. */
export function domainOf(layer: LayerLook, map: SpaceMap): [number, number] {
  const values = [Number(map.defaults[layer.name]), ...map.cells.map((cell) => Number(cell.values[layer.name]))];
  return [Math.min(...values), Math.max(...values)];
}

function locate(_bound: BoundMap, map: SpaceMap, where: Where): BoardPoint | null {
  if ('cell' in where) return { x: where.cell.x + 0.5, y: where.cell.y + 0.5 };
  const place = map.places[where.place];
  if (!place) return null;
  // A point place on a grid is a cell, and its centre is where things stand.
  const half = map.grid === 'square' && place.width === undefined ? 0.5 : 0;
  return { x: place.x + (place.width ?? 0) / 2 + half + where.offset[0], y: place.y + (place.height ?? 0) / 2 + half + where.offset[1] };
}

const layout = (bound: BoundMap, frame: Frame): MapItem[] =>
  (frame.map ? [{ key: bound.name, instrument: bound.name, point: { x: 0, y: 0 }, label: frame.map.id ?? 'map', dim: false, map: frame.map }] : []);

function mount(bound: BoundMap, kit: BoardKit): Drawn<MapItem> {
  const ground = new THREE.Group();
  const cells = new THREE.Group();
  const places = new THREE.Group();
  kit.group.add(ground, cells, places);
  let drawn: SpaceMap | undefined;
  let shape = '';
  let hidden = '';
  const box = new THREE.BoxGeometry(1, 1, 1);
  const empty = (group: THREE.Group) => {
    for (const child of [...group.children]) {
      group.remove(child);
      const mesh = child as THREE.Mesh;
      if (mesh.geometry && mesh.geometry !== box) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((one) => one.dispose());
      else if (material && !(material as THREE.SpriteMaterial).map) material.dispose();
    }
  };

  const drawGround = (map: SpaceMap) => {
    empty(ground);
    empty(places);
    const theme = kit.theme();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(map.width, map.height), new THREE.MeshBasicMaterial({ color: theme.plane }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(map.width / 2, -0.01, map.height / 2);
    ground.add(plane);
    if (map.grid === 'square') {
      if (bound.checker) {
        const dark = [];
        for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if ((x + y) % 2 === 0) dark.push({ x, y });
        const squares = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: bound.checker }), dark.length);
        const matrix = new THREE.Matrix4();
        const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
        dark.forEach((cell, index) => squares.setMatrixAt(index, matrix.compose(new THREE.Vector3(cell.x + 0.5, 0, cell.y + 0.5), flat, new THREE.Vector3(1, 1, 1))));
        ground.add(squares);
      }
      const points: number[] = [];
      for (let x = 0; x <= map.width; x++) points.push(x, 0.005, 0, x, 0.005, map.height);
      for (let y = 0; y <= map.height; y++) points.push(0, 0.005, y, map.width, 0.005, y);
      const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: theme.grid }));
      lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      ground.add(lines);
    } else {
      const edge = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: theme.grid }));
      edge.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, map.width, 0, 0, map.width, 0, map.height, 0, 0, map.height], 3));
      ground.add(edge);
    }
    // Places: outlines with labels. A point is drawn as a small square about it.
    const unit = map.grid === 'square' ? 1 : 0;
    for (const [name, place] of Object.entries(map.places)) {
      const look = bound.places[name];
      const color = look?.color ?? theme.accent;
      const [w, h] = [place.width ?? unit, place.height ?? unit];
      const [x0, y0, x1, y1] = w === 0 ? [place.x - 0.25, place.y - 0.25, place.x + 0.25, place.y + 0.25] : [place.x, place.y, place.x + w, place.y + h];
      const outline = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color, dashSize: 0.16, gapSize: 0.1 }));
      outline.geometry.setAttribute('position', new THREE.Float32BufferAttribute([x0, 0.02, y0, x1, 0.02, y0, x1, 0.02, y1, x0, 0.02, y1, x0, 0.02, y0], 3));
      outline.computeLineDistances();
      places.add(outline);
      const label = kit.label(look?.label ?? name, { size: 0.3, color });
      label.position.set((x0 + x1) / 2, 0.05, y0 - 0.22);
      places.add(label);
    }
  };

  const drawCells = (map: SpaceMap) => {
    empty(cells);
    const theme = kit.theme();
    const blocked = new Set(map.blocksMove.map((cell) => `${cell.x},${cell.y}`));
    const matrix = new THREE.Matrix4();
    const upright = new THREE.Quaternion();
    for (const layer of bound.layers) {
      if (kit.layerHidden(layer.name)) continue;
      const domain = layer.type === 'number' ? domainOf(layer, map) : undefined;
      const shown = map.cells.flatMap((cell) => {
        const look = lookOf(layer, cell.values[layer.name], domain);
        return look ? [{ cell, look }] : [];
      });
      if (shown.length === 0) continue;
      const mesh = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: '#ffffff' }), shown.length);
      const hatch: number[] = [];
      shown.forEach(({ cell, look }, index) => {
        const height = look.raise ?? (blocked.has(`${cell.x},${cell.y}`) ? BLOCKED_RAISE : FLAT);
        mesh.setMatrixAt(index, matrix.compose(new THREE.Vector3(cell.x + 0.5, height / 2, cell.y + 0.5), upright, new THREE.Vector3(0.98, height, 0.98)));
        mesh.setColorAt(index, new THREE.Color(look.color));
        const top = height + 0.004;
        if (look.pattern === 'hatch') {
          for (const t of [0.25, 0.5, 0.75]) hatch.push(cell.x + t, top, cell.y + 0.04, cell.x + 0.04, top, cell.y + t, cell.x + 0.96, top, cell.y + t, cell.x + t, top, cell.y + 0.96);
        } else if (look.pattern === 'dots') {
          for (const [dx, dy] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) hatch.push(cell.x + dx - 0.05, top, cell.y + dy, cell.x + dx + 0.05, top, cell.y + dy);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      cells.add(mesh);
      if (hatch.length > 0) {
        const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: theme.ink, transparent: true, opacity: 0.45 }));
        lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(hatch, 3));
        cells.add(lines);
      }
    }
  };

  return {
    update([item], { animate }) {
      const map = item?.map;
      if (!map) {
        empty(ground);
        empty(cells);
        empty(places);
        drawn = undefined;
        shape = '';
        return;
      }
      const theme = kit.theme();
      const now = `${map.grid}|${map.width}|${map.height}|${JSON.stringify(map.places)}|${theme.plane}|${theme.grid}`;
      const off = bound.layers.filter((layer) => kit.layerHidden(layer.name)).map((layer) => layer.name).join();
      if (now !== shape) drawGround(map);
      // The ground is drawn again only when the map's identity changes: core hands back the same object for the same ground.
      if (map !== drawn || now !== shape || off !== hidden) {
        if (animate && drawn && now === shape) {
          const before = new Map(drawn.cells.map((cell) => [`${cell.x},${cell.y}`, JSON.stringify(cell.values)]));
          for (const cell of map.cells) if (before.get(`${cell.x},${cell.y}`) !== JSON.stringify(cell.values)) kit.flash(cell);
        }
        drawCells(map);
      }
      drawn = map;
      shape = now;
      hidden = off;
    },
    pick(point) {
      if (!drawn) return null;
      for (const [name, place] of Object.entries(drawn.places)) {
        const unit = drawn.grid === 'square' ? 1 : 0;
        const [w, h] = [place.width ?? unit, place.height ?? unit];
        const [x0, y0, x1, y1] = w === 0 ? [place.x - 0.25, place.y - 0.25, place.x + 0.25, place.y + 0.25] : [place.x, place.y, place.x + w, place.y + h];
        if (drawn.grid === 'none' && point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1) return { instrument: bound.name, label: `place ${bound.places[name]?.label ?? name}` };
      }
      return null;
    },
    dispose() {
      empty(ground);
      empty(cells);
      empty(places);
      box.dispose();
    },
  };
}

export const mapForm: ContainerForm<BoundMap, MapItem> = {
  id: 'map', role: 'container', check, layout, mount, locate,
  inline: () => null,
};
