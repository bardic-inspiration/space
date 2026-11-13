// A log row as a sentence. A template from the presentation file is filled
// from the entry's own fields; without one, a generic sentence is built from
// them. An entity renders as its instrument does, a value written to a
// `cards` binding as its faces, and a cell as `(x, y)`.

import type { GameEvent, Registry, State, Value, ValueType } from '../core.ts';
import { descendantSignal, type LogTree } from '../log/tree.ts';
import type { Presentation } from './presentation.ts';
import { plain, readPath, type Part, type Typed } from './template.ts';
import type { InlineNode, SentenceGroup } from './types.ts';

const ref = (kind: string): ValueType => ({ k: 'ref', kind });

interface Described {
  group?: SentenceGroup;
  key?: string;
  scope: Record<string, Typed>;
  /** Types of the members of `params`, `args` or `fields`. */
  members: Record<string, Map<string, ValueType>>;
  /** The state entity fields are read from: as the entry left it, or before a `destroy`. */
  state: State;
}

/** What an entry holds, as a template's scope: `seat`, `intent`, `params.*`, `args.*`, `id`, `field`, `key`, `value`, `was`, `at`, `layer`. */
function describe(entry: GameEvent, registry: Registry, before: State, after: State): Described {
  const scope: Record<string, Typed> = { seq: { value: entry.seq } };
  const members: Described['members'] = {};
  const out = (group?: SentenceGroup, key?: string, state = after): Described => ({ group, key, scope, members, state });
  switch (entry.t) {
    case 'intent': {
      const spec = registry.intents.get(entry.intent);
      Object.assign(scope, { seat: { value: entry.seat }, intent: { value: entry.intent }, params: { value: entry.params }, of: { value: entry.of ?? null } });
      members.params = new Map(spec?.params.map((param) => [param.name, param.type]));
      return out('intent', entry.intent);
    }
    case 'signal':
      Object.assign(scope, { name: { value: entry.name }, args: { value: entry.args } });
      members.args = new Map(registry.signals.get(entry.name)?.params);
      return out('signal', entry.name);
    case 'set': {
      const kind = (after.entities[entry.id] ?? before.entities[entry.id])?.kind ?? '';
      const spec = registry.kinds.get(kind)?.fields.get(entry.field);
      const type = entry.key === undefined ? spec?.type : spec?.type.k === 'map' ? spec.type.val : undefined;
      const held = before.entities[entry.id]?.fields[entry.field];
      const was = entry.key === undefined ? held : (held as Record<string, Value> | undefined)?.[entry.key];
      Object.assign(scope, {
        id: { value: entry.id, type: ref(kind) }, kind: { value: kind }, field: { value: entry.field }, key: { value: entry.key ?? null },
        value: { value: entry.value, type }, was: { value: was, type },
      });
      return out('set', `${kind}.${entry.field}`);
    }
    case 'global': {
      const type = registry.globals.get(entry.field)?.type;
      Object.assign(scope, { field: { value: entry.field }, value: { value: entry.value, type }, was: { value: before.game[entry.field], type } });
      return out('global', entry.field);
    }
    case 'create':
      Object.assign(scope, { id: { value: entry.id, type: ref(entry.kind) }, kind: { value: entry.kind }, fields: { value: entry.fields }, values: { value: entry.fields } });
      members.fields = members.values = new Map([...(registry.kinds.get(entry.kind)?.fields ?? [])].map(([name, field]) => [name, field.type]));
      return out('create', entry.kind);
    case 'destroy': {
      const kind = before.entities[entry.id]?.kind ?? '';
      Object.assign(scope, { id: { value: entry.id, type: ref(kind) }, kind: { value: kind } });
      return out('destroy', kind, before);
    }
    case 'link':
    case 'unlink': {
      const relation = registry.relations.get(entry.rel);
      Object.assign(scope, { rel: { value: entry.rel }, from: { value: entry.from, type: relation && ref(relation.from) }, to: { value: entry.to, type: relation && ref(relation.to) } });
      return out(entry.t, entry.rel);
    }
    case 'ground': {
      const type = registry.cellLayers.get(entry.layer)?.type;
      const key = `${entry.at.x},${entry.at.y}`;
      Object.assign(scope, { at: { value: entry.at, type: { k: 'cell' } }, layer: { value: entry.layer }, value: { value: entry.value, type }, was: { value: before.ground?.[key]?.[entry.layer], type } });
      return out('ground', entry.layer);
    }
    case 'roll':
      Object.assign(scope, { n: { value: entry.n }, d: { value: entry.d }, values: { value: entry.values }, total: { value: entry.values.reduce((sum, value) => sum + value, 0) } });
      return out();
    case 'end':
      Object.assign(scope, { outcome: { value: entry.outcome } });
      return out();
    case 'seed':
      Object.assign(scope, { seed: { value: entry.seed } });
      return out();
  }
}

export interface SentenceContext {
  registry: Registry;
  presentation: Presentation;
  tree: LogTree;
  /** The state after the first `count` entries. */
  stateAt(count: number): State;
}

/** A value as a log row shows it. */
function show(found: Typed, described: Described, ctx: SentenceContext): InlineNode[] {
  const { value, type } = found;
  if (value === undefined || value === null) return [];
  if (type?.k === 'ref' && typeof value === 'string') return [ctx.presentation.inlineEntity(value, described.state)];
  if (type?.k === 'list' && type.of.k === 'ref' && Array.isArray(value)) {
    return value.flatMap((id, index) => [...(index > 0 ? [', '] : []), ctx.presentation.inlineEntity(String(id), described.state)]);
  }
  return [plain(value)];
}

/** Reads a path, giving the members of `params`, `args` and `fields` their declared types. */
function read(path: string[], described: Described, ctx: SentenceContext): Typed {
  const types = described.members[path[0]];
  if (types && path.length > 1) {
    const holder = described.scope[path[0]].value as Record<string, Value> | undefined;
    return readPath(['$', ...path.slice(2)], { $: { value: holder?.[path[1]], type: types.get(path[1]) } }, ctx.registry, described.state);
  }
  return readPath(path, described.scope, ctx.registry, described.state);
}

function fillInline(parts: Part[], described: Described, ctx: SentenceContext): InlineNode[] {
  return parts.flatMap((part): InlineNode[] => {
    if ('text' in part) return [part.text];
    const found = read(part.path, described, ctx);
    if (part.then !== undefined) return found.value === true ? [part.then] : [];
    // A value written to a field an instrument is bound to is drawn as that instrument draws it.
    if (part.path.length === 1 && part.path[0] === 'value') {
      const bound = written(described, ctx, found.value);
      if (bound) return [bound];
    }
    return show(found, described, ctx);
  });
}

function written(described: Described, ctx: SentenceContext, value: Value | undefined): InlineNode | null {
  if (value === undefined) return null;
  const { scope, group } = described;
  if (group === 'set' && scope.key.value === null) {
    return ctx.presentation.inlineValue({ kind: String(scope.kind.value), field: String(scope.field.value), entity: String(scope.id.value) }, value, described.state);
  }
  return group === 'global' ? ctx.presentation.inlineValue({ global: String(scope.field.value) }, value, described.state) : null;
}

const pairs = (values: Record<string, Value>, holder: string, described: Described, ctx: SentenceContext): InlineNode[] =>
  Object.keys(values).flatMap((name, index) => [index === 0 ? ' ' : ', ', `${name} `, ...show(read([holder, name], described, ctx), described, ctx)]);

/** The sentence an entry gets with no template: built from its own fields, e.g. *set worg.hp 12*. */
function generic(entry: GameEvent, described: Described, ctx: SentenceContext): InlineNode[] {
  const value = () => {
    const found = described.scope.value;
    return written(described, ctx, found.value) ? [written(described, ctx, found.value)!] : show(found, described, ctx);
  };
  switch (entry.t) {
    case 'seed': return [`seed ${entry.seed}`];
    case 'global': return [`set game.${entry.field} `, ...value()];
    case 'create': return ['create ', ...show(described.scope.id, described, ctx), ` (${entry.kind})`];
    case 'set': return [`set ${entry.id}.${entry.field}${entry.key === undefined ? '' : `.${entry.key}`} `, ...value()];
    case 'destroy': return ['destroy ', ...show(described.scope.id, described, ctx)];
    case 'ground': return [`ground (${entry.at.x}, ${entry.at.y}) ${entry.layer} ${plain(entry.value)}`];
    case 'link': case 'unlink':
      return [`${entry.t} ${entry.rel} `, ...show(described.scope.from, described, ctx), ' → ', ...show(described.scope.to, described, ctx)];
    case 'roll': return [`roll ${entry.n}d${entry.d}: ${entry.values.join(' + ')}${entry.values.length > 1 ? ` = ${described.scope.total.value}` : ''}`];
    case 'intent': return [`${entry.seat}: ${entry.intent}`, ...pairs(entry.params, 'params', described, ctx)];
    case 'signal': return [entry.name, ...pairs(entry.args, 'args', described, ctx)];
    case 'end': return ['end:', ...Object.entries(entry.outcome).map(([name, held]) => ` ${name} ${plain(held)}`)];
  }
}

/** One log row's sentence. */
export function sentenceOf(entry: GameEvent, ctx: SentenceContext): InlineNode[] {
  const described = describe(entry, ctx.registry, ctx.stateAt(entry.seq), ctx.stateAt(entry.seq + 1));
  const template = described.group && described.key !== undefined ? ctx.presentation.sentences[described.group].get(described.key) : undefined;
  if (!template) return generic(entry, described, ctx);
  const nodes = fillInline(template.text, described, ctx);
  // `then` appends the sentence of the first descendant signal of each name, so a decision reads as its result.
  const results = template.then.flatMap((name) => {
    const signal = descendantSignal(ctx.tree, entry.seq, name);
    return signal ? [sentenceOf(signal, ctx)] : [];
  });
  results.forEach((result, index) => nodes.push(index === 0 ? ': ' : ', ', ...result));
  return nodes;
}

/** A section's title for the entry that opened it. */
export function titleOf(parts: Part[], entry: GameEvent, ctx: Omit<SentenceContext, 'tree'>): string {
  const described = describe(entry, ctx.registry, ctx.stateAt(entry.seq), ctx.stateAt(entry.seq + 1));
  const flat = (node: InlineNode): string => (typeof node === 'string' ? node : (node.children ?? []).map(flat).join(''));
  return fillInline(parts, described, { ...ctx, tree: { roots: [], bySeq: [], sections: [] } }).map(flat).join('');
}

/** A sentence as plain text, for a tooltip or a test. */
export const textOf = (nodes: InlineNode[]): string =>
  nodes.map((node): string => (typeof node === 'string' ? node : textOf(node.children ?? []))).join('');
