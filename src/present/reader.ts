// Readers: an instrument's bindings (`count`, `cards`, `at`, `dim`) are CEL,
// checked with `compileExpression` like any rule and evaluated on the state
// at the cursor (S18). They read facts and give an instrument no rules.

import { CompileError, compileExpression, type State, type Value } from '../core.ts';
import type { CheckContext, Expr, Reader } from './types.ts';

interface Options {
  /** The kind the instrument is `of`: the expression sees one entity of it as `self`. */
  of?: string;
  /** The type the value must have, in the format's notation. */
  expect?: string | string[];
  /** Further variables, by type. */
  vars?: Record<string, string>;
}

/**
 * Compiles a binding, or reports why not and returns undefined. A plain read
 * of a stored field (`self.pos`, `game.board`) skips CEL when it is
 * evaluated, which is most of what a board draws at every cursor move.
 */
export function reader(ctx: CheckContext, source: Expr, path: string, options: Options = {}): { read: Reader; type: string } | undefined {
  const vars = { ...(options.of ? { self: options.of } : {}), ...options.vars };
  const wanted = options.expect === undefined ? [undefined] : Array.isArray(options.expect) ? options.expect : [options.expect];
  let expression;
  let refusal: CompileError | undefined;
  for (const expect of wanted) {
    try {
      expression = compileExpression(ctx.registry, source, { vars, expect });
      break;
    } catch (error) {
      if (!(error instanceof CompileError)) throw error;
      refusal ??= error;
    }
  }
  if (!expression) {
    for (const issue of refusal!.issues) ctx.issue(path, issue.message);
    return undefined;
  }
  const { scenario } = ctx;
  const text = String(source).trim();
  const own = /^(!?)self\.([A-Za-z_]\w*)$/.exec(text);
  if (own && options.of && ctx.registry.kinds.get(options.of)?.fields.has(own[2])) {
    const [, not, field] = own;
    return { type: expression.type, read: (state, id) => {
      const value = state.entities[id!]?.fields[field] ?? null;
      return not ? !value : value;
    } };
  }
  const global = /^game\.([A-Za-z_]\w*)$/.exec(text);
  if (global && ctx.registry.globals.has(global[1])) return { type: expression.type, read: (state) => state.game[global[1]] ?? null };

  // Anything else is evaluated, once per state and entity.
  let seen: State | undefined;
  let held = new Map<string, Value>();
  return {
    type: expression.type,
    read: (state, id, given) => {
      if (seen !== state) {
        seen = state;
        held = new Map();
      }
      const key = given ? `${id}|${JSON.stringify(given)}` : id ?? '';
      if (!held.has(key)) held.set(key, expression.evaluate(state, scenario, { vars: { ...(options.of ? { self: id } : {}), ...given } }));
      return held.get(key)!;
    },
  };
}

/** The stored field or global a binding reads directly, when it is one: `self.hole` is `{ field: 'hole' }`. */
export function boundField(source: Expr | undefined): { field: string } | { global: string } | undefined {
  const text = String(source ?? '').trim();
  const own = /^self\.([A-Za-z_]\w*)$/.exec(text);
  if (own) return { field: own[1] };
  const global = /^game\.([A-Za-z_]\w*)$/.exec(text);
  return global ? { global: global[1] } : undefined;
}
