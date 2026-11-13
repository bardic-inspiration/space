// Entity placement (spec 11): edits to a scenario document, made on its YAML
// so the file keeps its comments and its shape.

import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import type { Scenario } from '../core.ts';

const out = (doc: Document) => doc.toString({ lineWidth: 0, flowCollectionPadding: true });
const flow = <T>(doc: Document, value: T) => {
  const node = doc.createNode(value) as unknown as { flow?: boolean; items?: { value?: { flow?: boolean } }[] };
  node.flow = true;
  return node;
};

/** Where an entity is in a scenario's `entities` list. An entity with no id of its own is found by the id core gave it. */
export function entityIndex(scenario: Scenario, id: string): number {
  return scenario.setup.filter((event) => event.t === 'create').findIndex((event) => event.t === 'create' && event.id === id);
}

function entities(doc: Document): YAMLSeq<YAMLMap> {
  if (!isSeq(doc.get('entities'))) doc.set('entities', doc.createNode([]));
  return doc.get('entities') as YAMLSeq<YAMLMap>;
}

/** Rewrites one field of an entity: a `cell` field as `[x, y]`, or as a place's name. */
export function setField(text: string, index: number, field: string, value: unknown): string {
  const doc = parseDocument(text);
  const entity = entities(doc).items[index];
  if (!isMap(entity)) throw new Error(`the scenario has no entity ${index}`);
  if (!isMap(entity.get('fields'))) entity.set('fields', flow(doc, {}));
  (entity.get('fields') as YAMLMap).set(field, Array.isArray(value) || (value !== null && typeof value === 'object') ? flow(doc, value) : value);
  return out(doc);
}

export function addEntity(text: string, entity: { id?: string; kind: string; fields: Record<string, unknown> }): string {
  const doc = parseDocument(text);
  const node = flow(doc, { ...(entity.id ? { id: entity.id } : {}), kind: entity.kind, fields: entity.fields });
  for (const item of node.items ?? []) if (item.value && typeof item.value === 'object') item.value.flow = true;
  entities(doc).add(node as never);
  return out(doc);
}

/** Removes an entity, and every link to or from it. */
export function deleteEntity(text: string, index: number, id: string): string {
  const doc = parseDocument(text);
  entities(doc).delete(index);
  const links = doc.get('links');
  if (isSeq(links)) {
    for (let i = links.items.length - 1; i >= 0; i--) {
      const link = (links.items[i] as YAMLMap).toJSON() as { from: string; to: string };
      if (link.from === id || link.to === id) links.delete(i);
    }
  }
  return out(doc);
}

export interface LinkDoc {
  rel: string;
  from: string;
  to: string;
}

export function addLink(text: string, link: LinkDoc): string {
  const doc = parseDocument(text);
  if (!isSeq(doc.get('links'))) doc.set('links', doc.createNode([]));
  (doc.get('links') as YAMLSeq).add(flow(doc, link));
  return out(doc);
}

export function removeLink(text: string, link: LinkDoc): string {
  const doc = parseDocument(text);
  const links = doc.get('links');
  if (!isSeq(links)) return text;
  const at = links.items.findIndex((item) => JSON.stringify((item as YAMLMap).toJSON()) === JSON.stringify(link));
  if (at >= 0) links.delete(at);
  return out(doc);
}

/** A scenario's links, as written. */
export const linksOf = (doc: unknown): LinkDoc[] => ((doc as { links?: LinkDoc[] } | undefined)?.links ?? []);
