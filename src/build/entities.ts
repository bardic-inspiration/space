// Entity placement (spec 11): edits to a scenario document. Each changes the
// text of the one node it is about, so the file keeps its comments and its
// shape (see `yamledit.ts`).

import type { Scenario } from '../core.ts';
import { appendItem, removeItem, setKey } from '../project/yamledit.ts';
import { parse } from 'yaml';

/** Where an entity is in a scenario's `entities` list. An entity with no id of its own is found by the id core gave it. */
export function entityIndex(scenario: Scenario, id: string): number {
  return scenario.setup.filter((event) => event.t === 'create').findIndex((event) => event.t === 'create' && event.id === id);
}

/** Rewrites one field of an entity: a `cell` field as `[x, y]`, or as a place's name. */
export function setField(text: string, index: number, field: string, value: unknown): string {
  const entity = (parse(text) as { entities?: { fields?: unknown }[] }).entities?.[index];
  if (!entity) throw new Error(`the scenario has no entity ${index}`);
  return entity.fields === undefined ? setKey(text, ['entities', index], 'fields', { [field]: value }) : setKey(text, ['entities', index, 'fields'], field, value);
}

export function addEntity(text: string, entity: { id?: string; kind: string; fields: Record<string, unknown> }): string {
  return appendItem(text, 'entities', { ...(entity.id ? { id: entity.id } : {}), kind: entity.kind, fields: entity.fields });
}

export interface LinkDoc {
  rel: string;
  from: string;
  to: string;
}

/** A scenario's links, as written. */
export const linksOf = (doc: unknown): LinkDoc[] => ((doc as { links?: LinkDoc[] } | undefined)?.links ?? []);

/** Removes an entity, and every link to or from it. */
export function deleteEntity(text: string, index: number, id: string): string {
  let next = text;
  const links = linksOf(parse(text));
  for (let at = links.length - 1; at >= 0; at--) if (links[at].from === id || links[at].to === id) next = removeItem(next, 'links', at);
  return removeItem(next, 'entities', index);
}

export const addLink = (text: string, link: LinkDoc): string => appendItem(text, 'links', { rel: link.rel, from: link.from, to: link.to });

export function removeLink(text: string, link: LinkDoc): string {
  const at = linksOf(parse(text)).findIndex((held) => held.rel === link.rel && held.from === link.from && held.to === link.to);
  return at < 0 ? text : removeItem(text, 'links', at);
}
