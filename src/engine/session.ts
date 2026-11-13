// What the session worker does, apart from the messages: play a match to its
// end, explain a decision of it, and branch it. Kept free of the worker so
// Node's tests run the same code.

import {
  Match, RuleError, UtilitySeat, fork, hashLog, replay, summarize,
  type Authored, type Decision, type Explanation, type GameEvent, type MatchRecord, type Option, type Seat, type Snapshot, type Value,
} from '../core.ts';
import { driverOf, type Compiled } from './input.ts';

/** A snapshot is kept every this many decisions, so a fork never replays far. */
export const SNAPSHOT_EVERY = 32;

export interface Played {
  log: GameEvent[];
  record: MatchRecord;
  snapshots: Snapshot[];
}

/** One step of a fork (spec 9.1). Applied in this order when present: author, bind, choose. */
export interface ForkSteps {
  author?: { seat: string; changes: Authored[] };
  bind?: Record<string, string>;
  choose?: { intent: string; params: Record<string, Value> };
}

export interface DecisionInfo {
  seat: string;
  /** What drives the seat: a behavior's name, or `random`. */
  driver: string;
  options: Option[];
  /** The bound behavior's utility for each option; null for a seat that plays at random. */
  scores: number[] | null;
  /** The index of the option the log chose, or -1 when the entry is a referee's ruling. */
  chosen: number;
  explanation: Explanation;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const drivers = (seats: Record<string, Seat>) => Object.fromEntries(Object.entries(seats).map(([id, seat]) => [id, driverOf(seat)]));

/** Plays a match on from where it stands to its end, keeping a snapshot every `SNAPSHOT_EVERY` decisions. */
function finish(compiled: Compiled, match: Match, seats: Record<string, Seat>, snapshots: Snapshot[], decided: number): Played {
  for (let count = decided; ; count++) {
    const decision = match.advance();
    if (!decision) break;
    if (count % SNAPSHOT_EVERY === 0) snapshots.push(match.snapshot());
    match.step(seats);
  }
  return { log: match.log, record: summarize(compiled.registry, compiled.scenario, match.log, drivers(seats)), snapshots };
}

const decisionsIn = (log: readonly GameEvent[], until = log.length) => {
  let count = 0;
  for (let i = 0; i < until; i++) if (log[i].t === 'intent') count += 1;
  return count;
};

/** Plays one seed to the end. */
export function play(compiled: Compiled, seed: string | number): Played {
  return finish(compiled, new Match(compiled.registry, compiled.scenario, seed), compiled.seats(), [], 0);
}

/** The latest snapshot that is not yet past entry `seq`. */
const before = (snapshots: Snapshot[], seq: number): Snapshot | undefined => {
  let found: Snapshot | undefined;
  for (const snapshot of snapshots) if (snapshot.log.length <= seq && (!found || snapshot.log.length > found.log.length)) found = snapshot;
  return found;
};

/** The match as it stood when the decision at `seq` was about to be made. */
function forkAt(compiled: Compiled, log: readonly GameEvent[], seq: number, snapshots: Snapshot[]): Match {
  return fork(compiled.registry, compiled.scenario, log, seq, { from: before(snapshots, seq) });
}

/** The decision at `seq` of a log: its options, how the seat's behavior scores them, and why they are what they are. */
export function decisionAt(compiled: Compiled, log: readonly GameEvent[], seq: number, snapshots: Snapshot[] = [], bind?: Record<string, string>): DecisionInfo {
  const entry = log[seq];
  const match = forkAt(compiled, log, seq, snapshots);
  const decision = match.advance();
  if (!decision) throw new RuleError(`the match had ended by entry ${seq}`);
  const seat = compiled.seats(bind)[decision.seat];
  return {
    seat: decision.seat,
    driver: driverOf(seat),
    options: decision.options,
    scores: seat instanceof UtilitySeat ? match.scores(seat.behavior, decision.seat, decision.options) : null,
    chosen: entry.t === 'intent' && entry.of !== undefined ? indexOfOption(decision, entry) : -1,
    explanation: match.explain(),
  };
}

const indexOfOption = (decision: Decision, wanted: { intent: string; params: unknown }) =>
  decision.options.findIndex((option) => option.intent === wanted.intent && same(option.params, wanted.params));

/**
 * A branch: the parent's log up to the decision at `seq`, the steps, then
 * play to the end. `binds` are the bindings in force on the parent, when it
 * is itself a fork that changed them.
 */
export function branch(compiled: Compiled, log: readonly GameEvent[], seq: number, steps: ForkSteps, snapshots: Snapshot[] = [], binds: Record<string, string> = {}): Played {
  const match = forkAt(compiled, log, seq, snapshots);
  const kept = snapshots.filter((snapshot) => snapshot.log.length <= seq);
  if (steps.author) match.author(steps.author.seat, steps.author.changes);
  const seats = compiled.seats({ ...binds, ...steps.bind });
  if (steps.choose) {
    const decision = match.advance();
    const index = decision ? indexOfOption(decision, steps.choose) : -1;
    if (!decision || index < 0) throw new RuleError(`${steps.choose.intent} with these params is not a legal option at entry ${seq}`);
    // Choosing what the parent chose, with nothing else changed, leaves the seat's stream where the parent left it.
    const parent = log[seq];
    const again = parent.t === 'intent' && parent.seat === decision.seat && parent.intent === steps.choose.intent && same(parent.params, steps.choose.params);
    match.submit(index, again && !steps.author ? parent.rng : undefined);
  }
  return finish(compiled, match, seats, kept, decisionsIn(match.log));
}

/** Puts a stored log back through the rules: ok, or the first entry that differs. */
export function replayLog(compiled: Compiled, log: readonly GameEvent[]): { ok: true } | { ok: false; error: string } {
  try {
    replay(compiled.registry, compiled.scenario, log);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Snapshots for a log this thread did not play: one replay, kept every `SNAPSHOT_EVERY` decisions. */
export function snapshotsOf(compiled: Compiled, log: readonly GameEvent[]): Snapshot[] {
  const snapshots: Snapshot[] = [];
  let count = 0;
  let from: Snapshot | undefined;
  for (const entry of log) {
    if (entry.t !== 'intent') continue;
    if (count++ % SNAPSHOT_EVERY !== 0) continue;
    from = replay(compiled.registry, compiled.scenario, log, { until: entry.seq, from }).snapshot();
    snapshots.push(from);
  }
  return snapshots;
}

export { hashLog };
