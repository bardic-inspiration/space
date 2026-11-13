// From a resolved variant to a compiled run. A `RunInput` is plain data, so
// it crosses `postMessage`; a registry and a match do not, so the page, the
// session worker and every batch worker each compile the same input.

import {
  CORE_COMMIT, RandomSeat, UtilitySeat, bindSeats, compile, compileBehaviors, loadScenario,
  type Behaviors, type Registry, type Scenario, type Seat,
} from '../core.ts';
import { createStudioHost } from '../host/studioHost.ts';

/** What core takes to play a variant (spec 4.2). Appearance is never part of it (S20). */
export interface RunInput {
  kit: unknown;
  ruleset: unknown;
  extensions: unknown[];
  /** Behavior sets, in merge order. */
  behaviors: unknown[];
  /** With the variant's map and limits applied. */
  scenario: unknown;
  /** Every map document of the ruleset, by id. */
  maps: Record<string, unknown>;
  /** Seat to behavior name, or `random`. */
  bind: Record<string, string>;
}

export interface Compiled {
  registry: Registry;
  behaviors: Behaviors;
  scenario: Scenario;
  /** A driver for every seat, under the input's bindings with `over` laid on top. */
  seats(over?: Record<string, string>): Record<string, Seat>;
}

/** Compiles an input, or throws core's `CompileError`. The same four calls in every thread. */
export function compileInput(input: RunInput): Compiled {
  const registry = compile({ kit: input.kit, base: input.ruleset, extensions: input.extensions });
  const behaviors = compileBehaviors(registry, input.behaviors);
  const scenario = loadScenario(registry, input.scenario, { maps: input.maps, host: createStudioHost });
  const seats = (over: Record<string, string> = {}) => {
    const bind = { ...input.bind, ...over };
    return bindSeats(scenario, behaviors, Object.fromEntries(
      Object.entries(bind).map(([seat, name]): [string, string | Seat] => [seat, name === 'random' ? new RandomSeat() : name]),
    ));
  };
  seats();
  return { registry, behaviors, scenario, seats };
}

/** JSON with every object's keys sorted, so equal data gives equal text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The first 16 hex digits of SHA-256 over a text. */
export async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The variant hash (S8): a name for everything that decides how a match
 * plays, the core commit included. It names a batch, and a record carries it.
 */
export const variantHash = (input: RunInput, core: string = CORE_COMMIT): Promise<string> =>
  digest(canonical({ core, input }));

/** What drives a seat, for display: a behavior's name, or `random`. */
export const driverOf = (seat: Seat | undefined): string => (seat instanceof UtilitySeat ? seat.behavior.name : seat?.name ?? 'random');
