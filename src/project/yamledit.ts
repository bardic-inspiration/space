// Edits to a YAML file as text. A document that is parsed and written out
// again loses its layout: aligned comments, the line breaks of a long entry,
// the spacing inside brackets. So a tool that changes one thing replaces the
// text of that one node, and leaves every other byte of the file alone.

import { isMap, isScalar, isSeq, parseDocument, stringify, type Node, type YAMLMap, type YAMLSeq } from 'yaml';

/** A value in flow style, as core's files write theirs: `{ a: 1, at: [2, 6] }`. */
export function flow(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return entries.length === 0 ? '{}' : `{ ${entries.map(([key, item]) => `${key === '' || /^[\w./-]+$/.test(key) ? key || "''" : `'${key.replace(/'/g, "''")}'`}: ${flow(item)}`).join(', ')} }`;
  }
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const end = text.indexOf('\n', at);
  return end < 0 ? text.length : end + 1;
};
const top = (text: string) => {
  const doc = parseDocument(text);
  return isMap(doc.contents) ? doc.contents : undefined;
};
const pairOf = (map: YAMLMap | undefined, key: string) => map?.items.find((item) => isScalar(item.key) && String(item.key.value) === key);

/**
 * Sets a top-level key to a block of text (`key: ...`, with no newline at its
 * end), or removes it with `null`. A new key goes at the end of the file.
 */
export function setTop(text: string, key: string, block: string | null): string {
  const pair = pairOf(top(text), key);
  if (!pair) {
    if (block === null) return text;
    return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${block}\n`;
  }
  const from = lineStart(text, (pair.key as Node).range![0]);
  const value = pair.value as Node | null;
  const valueEnd = value?.range ? value.range[1] : (pair.key as Node).range![1] + 1;
  if (block === null) return text.slice(0, from) + text.slice(lineEnd(text, valueEnd));
  return text.slice(0, from) + block + text.slice(valueEnd);
}

/** The node a path of keys and indices reaches, from the top of a document. */
export function nodeAt(text: string, path: (string | number)[]): Node | undefined {
  let node: Node | null | undefined = parseDocument(text).contents as Node | null;
  for (const step of path) {
    if (isMap(node)) node = pairOf(node, String(step))?.value as Node | undefined;
    else if (isSeq(node)) node = node.items[Number(step)] as Node | undefined;
    else return undefined;
  }
  return node ?? undefined;
}

/** Replaces the text of the node at a path. Undefined when the path names nothing. */
export function replaceAt(text: string, path: (string | number)[], with_: string): string | undefined {
  const node = nodeAt(text, path);
  return node?.range ? text.slice(0, node.range[0]) + with_ + text.slice(node.range[1]) : undefined;
}

/** Sets a key of the map at a path, adding it when the map lacks it. The map may be written in flow or in block style. */
export function setKey(text: string, path: (string | number)[], key: string, value: unknown): string {
  const replaced = replaceAt(text, [...path, key], flow(value));
  if (replaced !== undefined) return replaced;
  const map = nodeAt(text, path);
  if (!isMap(map) || !map.range) throw new Error(`there is no ${path.join('.')} to write ${key} in`);
  if (map.flow) {
    const close = text.lastIndexOf('}', map.range[1] - 1);
    const empty = map.items.length === 0;
    return `${text.slice(0, close).trimEnd()}${empty ? ' ' : ', '}${key}: ${flow(value)} ${text.slice(close)}`;
  }
  const indent = ' '.repeat(map.range[0] - lineStart(text, map.range[0]));
  const at = lineEnd(text, map.range[1] - 1);
  return `${text.slice(0, at)}${indent}${key}: ${flow(value)}\n${text.slice(at)}`;
}

/** Adds an item, in flow style, to the list under a top-level key; the key is added when the file has none. */
export function appendItem(text: string, key: string, item: unknown): string {
  const seq = nodeAt(text, [key]);
  if (!isSeq(seq) || !seq.range || seq.items.length === 0 || seq.flow) {
    const held = isSeq(seq) ? (seq.toJSON() as unknown[]) : [];
    return setTop(text, key, `${key}:\n${[...held, item].map((one) => `  - ${flow(one)}`).join('\n')}`);
  }
  const last = seq.items[seq.items.length - 1] as Node;
  const first = seq.items[0] as Node;
  const dash = text.lastIndexOf('-', first.range![0]);
  const indent = ' '.repeat(dash - lineStart(text, dash));
  const at = lineEnd(text, last.range![1] - 1);
  return `${text.slice(0, at)}${at > 0 && text[at - 1] !== '\n' ? '\n' : ''}${indent}- ${flow(item)}\n${text.slice(at)}`;
}

/** Removes one item of the list under a top-level key, with the lines it was written on. */
export function removeItem(text: string, key: string, index: number): string {
  const seq = nodeAt(text, [key]) as YAMLSeq | undefined;
  if (!isSeq(seq) || !seq.items[index]) return text;
  if (seq.flow) return setTop(text, key, `${key}: ${flow((seq.toJSON() as unknown[]).filter((_, at) => at !== index))}`);
  const item = seq.items[index] as Node;
  const from = lineStart(text, text.lastIndexOf('-', item.range![0]));
  return text.slice(0, from) + text.slice(lineEnd(text, item.range![1] - 1));
}
