// Inline markup from the forms and the sentence templates, as React.

import type { ReactNode } from 'react';
import type { InlineNode } from '../present/types.ts';

export function Inline({ nodes }: { nodes: InlineNode[] }): ReactNode {
  return nodes.map((node, index) => (typeof node === 'string'
    ? node
    : <span key={index} className={node.class} style={node.style} title={node.title}>{node.children && <Inline nodes={node.children} />}</span>));
}

/** A stored value as an inspector shows it. */
export function show(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (typeof value === 'object') {
    const held = value as Record<string, unknown>;
    if (Object.keys(held).length === 2 && 'x' in held && 'y' in held) return `(${held.x}, ${held.y})`;
    return `{ ${Object.entries(held).map(([key, item]) => `${key}: ${show(item)}`).join(', ')} }`;
  }
  return String(value);
}
