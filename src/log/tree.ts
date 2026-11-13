// The log tree (spec 9), built from the log alone: Setup, sections opened by
// what the presentation file marks as structural, entries nested under their
// `cause`, and End.

import type { GameEvent } from '../core.ts';

export interface Opener {
  /** A signal's name, or a global's. */
  on: { signal: string } | { global: string };
  /** The section's title for the entry that opened it. */
  title(entry: GameEvent): string;
}

export interface TreeNode {
  id: string;
  kind: 'setup' | 'section' | 'entry' | 'end';
  /** The entry this row is; absent for Setup and a section. */
  entry?: GameEvent;
  title?: string;
  /** How deep the section's opener is in the presentation's list; 0 is outermost. */
  level?: number;
  /** The first `seq` this node covers, and the last. */
  first: number;
  last: number;
  parent?: TreeNode;
  children: TreeNode[];
}

export interface LogTree {
  roots: TreeNode[];
  /** Each entry's node, by `seq`. */
  bySeq: TreeNode[];
  /** The outermost sections, for the timeline's bands. */
  sections: TreeNode[];
}

const opens = (opener: Opener, entry: GameEvent): boolean =>
  ('signal' in opener.on ? entry.t === 'signal' && entry.name === opener.on.signal : entry.t === 'global' && entry.field === opener.on.global);

/** `setupCount` is `1 + scenario.setup.length`: the seed and the scenario's own writes. */
export function buildTree(log: readonly GameEvent[], setupCount: number, openers: Opener[] = []): LogTree {
  const roots: TreeNode[] = [];
  const bySeq: TreeNode[] = [];
  const open: TreeNode[] = [];
  const attach = (node: TreeNode, parent: TreeNode | undefined) => {
    node.parent = parent;
    (parent ? parent.children : roots).push(node);
    for (let up = parent; up; up = up.parent) up.last = Math.max(up.last, node.last);
  };
  const setup: TreeNode = { id: 'setup', kind: 'setup', title: 'Setup', first: 0, last: 0, children: [] };
  if (log.length > 0) attach(setup, undefined);

  for (const entry of log) {
    const node: TreeNode = { id: `e${entry.seq}`, kind: entry.t === 'end' ? 'end' : 'entry', entry, first: entry.seq, last: entry.seq, children: [] };
    bySeq[entry.seq] = node;
    if (entry.seq < setupCount) attach(node, setup);
    else if (entry.t === 'end') attach(node, undefined);
    else if (entry.cause !== undefined && bySeq[entry.cause]) attach(node, bySeq[entry.cause]);
    else {
      const level = openers.findIndex((opener) => opens(opener, entry));
      if (level >= 0) {
        // A new section closes any open one at its level or deeper.
        while (open.length > 0 && open[open.length - 1].level! >= level) open.pop();
        const section: TreeNode = { id: `s${entry.seq}`, kind: 'section', title: openers[level].title(entry), level, first: entry.seq, last: entry.seq, children: [] };
        attach(section, open[open.length - 1]);
        open.push(section);
      }
      attach(node, open[open.length - 1]);
    }
  }
  return { roots, bySeq, sections: roots.filter((node) => node.kind === 'section') };
}

export interface Row {
  node: TreeNode;
  depth: number;
}

/** The rows on show: every node whose ancestors are all open. Setup is folded unless opened. */
export function flatten(tree: LogTree, closed: ReadonlySet<string>, opened: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const isOpen = (node: TreeNode) => (node.kind === 'setup' ? opened.has(node.id) : !closed.has(node.id));
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.children.length > 0 && isOpen(node)) walk(node.children, depth + 1);
    }
  };
  walk(tree.roots, 0);
  return rows;
}

/** The row that shows entry `seq`: its own, or the nearest ancestor on show. -1 before the first entry. */
export function rowOf(tree: LogTree, rows: Row[], seq: number): number {
  let node: TreeNode | undefined = tree.bySeq[seq];
  const index = new Map(rows.map((row, at) => [row.node, at]));
  for (; node; node = node.parent) {
    const at = index.get(node);
    if (at !== undefined) return at;
  }
  return -1;
}

/** The first descendant signal of a name under an entry, in log order: what `then` appends to an intent's sentence. */
export function descendantSignal(tree: LogTree, seq: number, name: string): GameEvent | undefined {
  let found: GameEvent | undefined;
  const walk = (node: TreeNode) => {
    for (const child of node.children) {
      if (child.entry?.t === 'signal' && child.entry.name === name && (!found || child.entry.seq < found.seq)) found = child.entry;
      walk(child);
    }
  };
  const root = tree.bySeq[seq];
  if (root) walk(root);
  return found;
}
