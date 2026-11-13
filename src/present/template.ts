// Templates: an instrument's label, a place's name, a section's title, and
// the log's sentences. `{path}` is replaced by a value read from what the
// template is given, and `{flag ? 'text'}` writes the text when the value is
// true. A template is not CEL and computes nothing (S11).

import type { Registry, State, Value, ValueType } from '../core.ts';

export type Part = { text: string } | { path: string[]; then?: string };

export function parseTemplate(source: string): Part[] {
  const parts: Part[] = [];
  const pattern = /\{([^{}]*)\}/g;
  let last = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index) });
    const flag = /^\s*([\w.#-]+)\s*\?\s*(['"])(.*)\2\s*$/.exec(match[1]);
    if (flag) parts.push({ path: flag[1].split('.'), then: flag[3] });
    else parts.push({ path: match[1].trim().split('.') });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last) });
  return parts;
}

/** A value and what the ruleset says it is, so an entity can be told from a string. */
export interface Typed {
  value: Value | undefined;
  type?: ValueType;
}

/** Reads a path from a scope. A step from an entity goes into its stored fields, read from `state`. */
export function readPath(path: string[], scope: Record<string, Typed>, registry: Registry, state: State): Typed {
  let at: Typed | undefined = scope[path[0]];
  for (let i = 1; i < path.length && at && at.value !== undefined; i++) {
    const step = path[i];
    const { value, type } = at as Typed;
    if (type?.k === 'ref' && typeof value === 'string') {
      const entity = state.entities[value];
      const spec = registry.kinds.get(type.kind)?.fields.get(step);
      at = step === 'id' ? { value } : step === 'kind' ? { value: type.kind } : { value: entity?.fields[step], type: spec?.type };
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner: ValueType | undefined = type?.k === 'map' ? type.val : type?.k === 'cell' ? { k: 'int' } : undefined;
      at = { value: (value as Record<string, Value>)[step], type: inner };
    } else if (Array.isArray(value) && /^\d+$/.test(step)) {
      at = { value: value[Number(step)], type: type?.k === 'list' ? type.of : undefined };
    } else at = undefined;
  }
  return at ?? { value: undefined };
}

/** A value as plain words. */
export function plain(value: Value | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(plain).join(', ');
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 2 && 'x' in value && 'y' in value) return `(${value.x}, ${value.y})`;
    return keys.map((key) => `${key} ${plain((value as Record<string, Value>)[key])}`).join(', ');
  }
  return String(value);
}

/** A template filled in as plain text: a label, a place's name, a title. */
export function fill(parts: Part[], scope: Record<string, Typed>, registry: Registry, state: State): string {
  return parts.map((part) => {
    if ('text' in part) return part.text;
    const { value } = readPath(part.path, scope, registry, state);
    return part.then === undefined ? plain(value) : value === true ? part.then : '';
  }).join('');
}

/** The paths a template reads, for checking it against what its entry holds. */
export const pathsOf = (parts: Part[]): string[][] => parts.flatMap((part) => ('path' in part ? [part.path] : []));
