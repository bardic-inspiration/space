// What tokens, chips and cards share: the kind they are `of`, where they lie
// (`at`), their `color`, and `dim`.

import type { Value } from '../core.ts';
import { reader } from '../present/reader.ts';
import { fill, parseTemplate, type Part, type Typed } from '../present/template.ts';
import type { BoardPoint, CheckContext, Frame, InstrumentDoc, Reader } from '../present/types.ts';
import type { Bound } from './form.ts';

export interface Common extends Bound {
  at: { cell: Reader } | { place: Part[]; offset: [number, number] } | null;
  color: { fixed: string } | { by: string } | null;
  dim?: Reader;
}

/** Checks the parts every component has. Undefined when `of` names no kind, since nothing else can then be read. */
export function checkCommon(name: string, doc: InstrumentDoc, ctx: CheckContext): Common | undefined {
  const kind = doc.of === undefined ? undefined : ctx.registry.kinds.get(doc.of);
  if (doc.of !== undefined && !kind) {
    ctx.issue('.of', `the ruleset declares no kind "${doc.of}"`);
    return undefined;
  }
  let at: Common['at'] = null;
  if (doc.at !== undefined) {
    if (typeof doc.at === 'object' && 'place' in doc.at) at = { place: parseTemplate(doc.at.place), offset: doc.at.offset ?? [0, 0] };
    else {
      const cell = reader(ctx, typeof doc.at === 'object' ? doc.at.cell : doc.at, '.at', { of: doc.of, expect: 'cell' });
      if (cell) at = { cell: cell.read };
    }
  }
  let color: Common['color'] = null;
  if (typeof doc.color === 'string') color = { fixed: doc.color };
  else if (doc.color) {
    if (!kind) ctx.issue('.color', 'coloring by a field needs `of`: the kind whose field it is');
    else if (!kind.fields.has(doc.color.by)) ctx.issue('.color.by', `${kind.name} has no field "${doc.color.by}"`);
    else color = { by: doc.color.by };
  }
  const dim = doc.dim === undefined ? undefined : reader(ctx, doc.dim, '.dim', { of: doc.of, expect: 'bool' })?.read;
  return { name, of: doc.of, doc, at, color, dim };
}

/** The entities an instrument has one component for: the live ones of its kind, or the match itself. */
export const subjects = (bound: Bound, frame: Frame): (string | undefined)[] =>
  (bound.of === undefined ? [undefined] : Object.keys(frame.state.entities).filter((id) => frame.state.entities[id].kind === bound.of));

/** An entity's stored fields as a template's scope. */
export function fieldScope(bound: Bound, frame: Frame, id: string | undefined): Record<string, Typed> {
  const scope: Record<string, Typed> = { id: { value: id } };
  const kind = bound.of === undefined ? undefined : frame.registry.kinds.get(bound.of);
  const entity = id === undefined ? undefined : frame.state.entities[id];
  for (const [field, value] of Object.entries(entity?.fields ?? {})) scope[field] = { value, type: kind?.fields.get(field)?.type };
  return scope;
}

/** Where a component lies on the board; null when it has no `at`, or the map lacks its place. */
export function pointOf(bound: Common, frame: Frame, id: string | undefined): BoardPoint | null {
  if (!bound.at) return null;
  if ('cell' in bound.at) {
    const cell = bound.at.cell(frame.state, id) as { x: number; y: number } | null;
    return cell ? frame.locate({ cell }) : null;
  }
  return frame.locate({ place: fill(bound.at.place, fieldScope(bound, frame, id), frame.registry, frame.state), offset: bound.at.offset });
}

export function colorOf(bound: Common, frame: Frame, id: string | undefined, fallback: string): string {
  if (!bound.color) return fallback;
  if ('fixed' in bound.color) return bound.color.fixed;
  const value = id === undefined ? null : frame.state.entities[id]?.fields[bound.color.by] ?? null;
  return frame.colorBy(bound.color.by, value as Value);
}

export const isDim = (bound: Common, frame: Frame, id: string | undefined): boolean => bound.dim?.(frame.state, id) === true;

/** Whether the ruleset hides the field or global a binding reads from some seats. Hidden values are shown, and marked (S14). */
export function hiddenBinding(ctx: CheckContext, of: string | undefined, source: unknown): boolean {
  const text = String(source ?? '').trim();
  const own = /^self\.([A-Za-z_]\w*)$/.exec(text);
  if (own && of) return ctx.registry.kinds.get(of)?.fields.get(own[1])?.visible !== undefined;
  const global = /^game\.([A-Za-z_]\w*)$/.exec(text);
  return global ? ctx.registry.globals.get(global[1])?.visible !== undefined : false;
}
