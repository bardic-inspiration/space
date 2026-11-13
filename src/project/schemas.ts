// JSON Schemas for the studio's own documents. Each carries `format: 1`, and
// an unknown key is refused, as in core.

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { Issue } from '../engine/protocol.ts';

export const STUDIO_FORMAT = 1;

const closed = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const record = (value: unknown) => ({ type: 'object', additionalProperties: value });
const text = { type: 'string' };
const id = { type: 'string', pattern: '^[A-Za-z0-9@][A-Za-z0-9_.-]*$' };
const expr = { type: ['string', 'number', 'boolean'] };
const format = { const: STUDIO_FORMAT };
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const colorBy = { anyOf: [color, closed({ by: text }, ['by'])] };
const at = {
  anyOf: [expr, closed({ place: text, offset: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, ['place']), closed({ cell: expr }, ['cell'])],
};
const look = closed({ color, pattern: { enum: ['hatch', 'dots'] }, raise: { type: 'number', minimum: 0 } });
const layer = closed({
  values: record(look),
  ramp: { type: 'array', items: color, minItems: 2 },
  domain: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
});

const instrument = closed({
  form: text, of: text, at, color: colorBy, dim: expr,
  // map
  layers: record(layer), places: record(closed({ label: text, color })), checker: color,
  // token
  label: text, icon: text,
  // chips
  count: expr, unit: { type: 'number', exclusiveMinimum: 0 },
  // cards
  cards: expr, face: closed({ rank: expr, suit: expr, text: expr }), back: { type: 'boolean' },
}, ['form']);

const sentence = { anyOf: [text, closed({ text, then: { type: 'array', items: text } }, ['text'])] };

const schemas = {
  project: closed({ format, title: text, core: text }, ['format']),
  variant: closed({
    format,
    variant: closed({ id, title: text, notes: text }, ['id']),
    ruleset: text, scenario: text,
    extensions: { type: 'array', items: text }, behaviors: { type: 'array', items: text, minItems: 1 },
    bind: record(text), map: text,
    limits: closed({ maxDecisions: { type: 'integer', minimum: 1 } }),
    seeds: closed({ from: { type: 'integer' }, to: { type: 'integer' } }, ['from', 'to']),
  }, ['format', 'variant', 'ruleset', 'scenario']),
  presentation: closed({
    format,
    presentation: closed({ ruleset: text, title: text }, ['ruleset']),
    instruments: record(instrument),
    colors: record(record(color)),
    outcome: text,
    sections: {
      type: 'array',
      items: closed({ on: { anyOf: [closed({ global: text }, ['global']), closed({ signal: text }, ['signal'])] }, title: text }, ['on', 'title']),
    },
    sentences: closed({
      intent: record(sentence), signal: record(sentence), set: record(sentence), global: record(sentence),
      create: record(sentence), destroy: record(sentence), link: record(sentence), unlink: record(sentence), ground: record(sentence),
    }),
  }, ['format', 'presentation']),
  metrics: closed({
    format,
    metrics: record(closed({
      value: expr, when: expr, fold: { enum: ['sum', 'count', 'mean', 'min', 'max', 'last', 'cells'] },
      at: { anyOf: [closed({ signal: text }, ['signal']), closed({ entry: text }, ['entry'])] },
    }, ['value'])),
  }, ['format', 'metrics']),
  batch: closed({
    format,
    variant: closed({ id, hash: text }, ['id', 'hash']),
    ruleset: text, core: text,
    seeds: closed({ from: { type: 'integer' }, to: { type: 'integer' } }, ['from', 'to']),
    metrics: text, ran: text,
  }, ['format', 'variant', 'ruleset', 'core', 'seeds', 'metrics']),
  fork: closed({
    format,
    fork: closed({ id, title: text }, ['id']),
    variant: closed({ id, hash: text }, ['id', 'hash']),
    seed: { type: ['string', 'integer'] },
    parent: { type: ['string', 'null'] },
    at: { type: 'integer', minimum: 0 },
    steps: {
      type: 'array',
      items: {
        anyOf: [
          closed({ author: closed({ seat: text, changes: { type: 'array', items: { type: 'object' } } }, ['seat', 'changes']) }, ['author']),
          closed({ bind: record(text) }, ['bind']),
          closed({ choose: closed({ intent: text, params: { type: 'object' } }, ['intent', 'params']) }, ['choose']),
        ],
      },
    },
    logHash: text,
  }, ['format', 'fork', 'variant', 'seed', 'at', 'steps']),
};

export type StudioDoc = keyof typeof schemas;

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)])) as Record<StudioDoc, ValidateFunction>;

function issuesOf(prefix: string, errors: ErrorObject[] | null | undefined): Issue[] {
  const all = (errors ?? []).filter((error) => error.keyword !== 'anyOf');
  const paths = [...new Set(all.map((error) => error.instancePath))];
  const issues: Issue[] = [];
  for (const path of paths) {
    // The deepest errors are about what the author meant.
    if (paths.some((other) => other !== path && other.startsWith(`${path}/`))) continue;
    const messages = new Set(all.filter((error) => error.instancePath === path).map((error) =>
      (error.keyword === 'additionalProperties' ? `unknown key "${error.params.additionalProperty}"` : error.message ?? error.keyword)));
    issues.push({ path: `${prefix}${path.replace(/\//g, '.')}`, message: [...messages].join('; ') });
  }
  return issues;
}

/** Why a parsed document is not a studio document of this kind; empty when it is one. */
export function checkDoc(kind: StudioDoc, doc: unknown): Issue[] {
  const validate = validators[kind];
  return validate(doc) ? [] : issuesOf(kind, validate.errors);
}
