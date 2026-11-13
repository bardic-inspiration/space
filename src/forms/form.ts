// A form is the studio's only knowledge of a kind of instrument (S17). Each
// is one module with one interface: check a binding against the registry,
// draw on the board from a state, draw inline in a log row, and answer a
// pick. The board and the log know forms only through it, so a fifth form is
// one new module and a line in `index.ts`.

import type * as THREE from 'three';
import type { SpaceMap, Value } from '../core.ts';
import type { BoardPoint, CheckContext, Frame, InlineNode, InstrumentDoc, ItemBase, Pick, Where } from '../present/types.ts';

export interface Theme {
  background: string;
  plane: string;
  grid: string;
  ink: string;
  muted: string;
  face: string;
  accent: string;
  good: string;
  bad: string;
  dim: string;
}

/** What the board lends a form to draw with. */
export interface BoardKit {
  /** The form's own group in the scene. Board `(x, y)` is three's `(x, height, y)`. */
  group: THREE.Group;
  theme(): Theme;
  /** A flat label facing the camera. Textures are shared by text and color. */
  label(text: string, options?: { size?: number; color?: string; plate?: string }): THREE.Sprite;
  /** A canvas texture, painted once per key and theme. */
  texture(key: string, width: number, height: number, paint: (context: CanvasRenderingContext2D, width: number, height: number) => void): THREE.Texture;
  /** Moves an object to a position: sliding there while a match plays, at once when scrubbing. */
  glide(object: THREE.Object3D, to: { x: number; y: number; z: number }, animate: boolean): void;
  /** Flashes a square of the ground, as a cell that changed. */
  flash(cell: { x: number; y: number }): void;
  /** Whether a map layer is switched off in the layer panel. */
  layerHidden(layer: string): boolean;
}

/** A form's drawing on one board. */
export interface Drawn<Item> {
  update(items: Item[], options: { animate: boolean }): void;
  /** What lies at a point of the board, if anything of this instrument does. */
  pick(point: BoardPoint): Pick | null;
  dispose(): void;
}

export interface Bound {
  name: string;
  /** The kind it stands for one entity of, when it has one. */
  of?: string;
  doc: InstrumentDoc;
}

/** What a log row asks a form to draw inline: the entity an instrument is of, or a value written to its binding. */
export type Subject = { entity: string } | { value: Value; entity?: string };

export interface Form<B extends Bound = Bound, Item extends ItemBase = ItemBase> {
  id: string;
  role: 'container' | 'component';
  /** Checks a binding against the compiled ruleset. Reports every refusal; undefined when it cannot be drawn. */
  check(name: string, doc: InstrumentDoc, ctx: CheckContext): B | undefined;
  /** What the instrument shows in one state, as plain data. */
  layout(bound: B, frame: Frame): Item[];
  /** Puts the instrument on a board. */
  mount(bound: B, kit: BoardKit): Drawn<Item>;
  inline(bound: B, frame: Frame, subject: Subject): InlineNode | null;
}

/** A container also answers where a cell or a place is, which is all a component needs to know of it. */
export interface ContainerForm<B extends Bound = Bound, Item extends ItemBase = ItemBase> extends Form<B, Item> {
  role: 'container';
  locate(bound: B, map: SpaceMap, where: Where): BoardPoint | null;
}

/** The fixed categorical palette, in the order values take colors from it. */
export const PALETTE = ['#3a6fb5', '#b5483a', '#3f9b6b', '#c28a2c', '#7a5bb0', '#2f9aa8', '#b04f8a', '#6c7a2e', '#8a6a4f', '#5c6b7a'];
export const RAMP = ['#f2e9c9', '#d9a441', '#b5483a'];

export const mix = (a: string, b: string, t: number): string => {
  const part = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => Math.round(part(a, at) + (part(b, at) - part(a, at)) * t).toString(16).padStart(2, '0')).join('')}`;
};

/** A color along a ramp, for `t` from 0 to 1. */
export function ramp(colors: string[], t: number): string {
  const at = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (colors.length - 1);
  const low = Math.min(colors.length - 2, Math.floor(at));
  return mix(colors[low], colors[low + 1], at - low);
}
