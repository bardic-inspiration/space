// The presentation file (spec 7): how a ruleset looks and reads. Every part
// is optional (S10), and none of it ever reaches a run (S20).

import type { Registry, Scenario, SpaceMap, State, Value } from '../core.ts';
import type { Issue } from '../engine/protocol.ts';

export type Expr = string | number | boolean;
export type AtDoc = Expr | { place: string; offset?: [number, number] } | { cell: Expr };
export type ColorDoc = string | { by: string };

export interface LayerLookDoc {
  values?: Record<string, { color?: string; pattern?: 'hatch' | 'dots'; raise?: number }>;
  ramp?: string[];
  domain?: [number, number];
}

/** One entry under `instruments`: something the ruleset declares, bound to a form the studio draws. */
export interface InstrumentDoc {
  form: string;
  of?: string;
  at?: AtDoc;
  color?: ColorDoc;
  dim?: Expr;
  layers?: Record<string, LayerLookDoc>;
  places?: Record<string, { label?: string; color?: string }>;
  checker?: string;
  label?: string;
  icon?: string;
  count?: Expr;
  unit?: number;
  cards?: Expr;
  face?: { rank?: Expr; suit?: Expr; text?: Expr };
  back?: boolean;
}

export type SentenceDoc = string | { text: string; then?: string[] };
export type SentenceGroup = 'intent' | 'signal' | 'set' | 'global' | 'create' | 'destroy' | 'link' | 'unlink' | 'ground';

export interface SectionDoc {
  on: { global: string } | { signal: string };
  title: string;
}

export interface PresentationDoc {
  format: number;
  presentation: { ruleset: string; title?: string };
  instruments?: Record<string, InstrumentDoc>;
  colors?: Record<string, Record<string, string>>;
  outcome?: string;
  sections?: SectionDoc[];
  sentences?: Partial<Record<SentenceGroup, Record<string, SentenceDoc>>>;
}

/** What an instrument is checked against: one compiled variant. */
export interface CheckContext {
  registry: Registry;
  scenario: Scenario;
  /** Reports a refusal at a path under the instrument, e.g. `.at`. */
  issue(path: string, message: string): void;
}

/** Reads a value from a state: an instrument's `count`, `cards`, `at` or `dim`. `id` is the entity it is `of`. */
export type Reader = (state: State, id?: string, vars?: Record<string, unknown>) => Value;

/** A point on the board, in the map's coordinates: cell `(x, y)` is the square from `(x, y)` to `(x + 1, y + 1)`. */
export interface BoardPoint {
  x: number;
  y: number;
}

/** Where a component lies, before the container says where that is. */
export type Where = { cell: { x: number; y: number } } | { place: string; offset: [number, number] };

/** Inline markup for a log row: text, or an element with a class the stylesheet knows. Forms build these. */
export type InlineNode = string | { class: string; style?: Record<string, string>; title?: string; children?: InlineNode[] };

/** What a form is handed to lay itself out on one state. */
export interface Frame {
  registry: Registry;
  scenario: Scenario;
  state: State;
  /** The map at this state; absent when the ruleset has no space. */
  map?: SpaceMap;
  /** The container's answer to where a cell or a place is; null when the map lacks it. */
  locate(where: Where): BoardPoint | null;
  /** The color of an entity's value of a field, under `colors` or the palette. */
  colorBy(field: string, value: Value): string;
}

/** Something a form put on the board that can be pointed at. */
export interface Pick {
  instrument: string;
  /** The entity the instrument is `of`, when it has one. */
  entity?: string;
  label: string;
}

export interface ItemBase {
  /** Stable across states, so the board can animate a thing from where it was. */
  key: string;
  instrument: string;
  entity?: string;
  /** Where it lies on the board; null when it has no place there and is listed in the tray. */
  point: BoardPoint | null;
  label: string;
  dim: boolean;
}

export type { Issue };
