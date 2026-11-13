// The cursor's state cache (spec 6.3). The state at a cursor is the fold of
// the log up to it, kept cheap by a keyframe every 256 entries and `apply`
// from the nearest one.

import { apply, emptyState, type GameEvent, type State } from '../core.ts';

export const KEYFRAME_EVERY = 256;

export class StateCache {
  readonly log: readonly GameEvent[];
  /** `keyframes[k]` is the state after `k * KEYFRAME_EVERY` entries. */
  private readonly keyframes: State[] = [emptyState()];
  /** The last state asked for: stepping forward from it is one `apply`. */
  private last = { at: 0, state: this.keyframes[0] };
  /** The few states asked for most recently, so a look one entry back does not start again from a keyframe. */
  private readonly recent = new Map<number, State>();

  constructor(log: readonly GameEvent[]) {
    this.log = log;
  }

  /** The state after the first `count` entries: `fold(log.slice(0, count))`. */
  at(count: number): State {
    const target = Math.max(0, Math.min(this.log.length, Math.floor(count)));
    const held = this.recent.get(target);
    if (held) return held;
    while ((this.keyframes.length - 1) * KEYFRAME_EVERY + KEYFRAME_EVERY <= target) {
      const from = (this.keyframes.length - 1) * KEYFRAME_EVERY;
      let state = this.keyframes[this.keyframes.length - 1];
      for (let i = from; i < from + KEYFRAME_EVERY; i++) state = apply(state, this.log[i]);
      this.keyframes.push(state);
    }
    const frame = Math.floor(target / KEYFRAME_EVERY);
    let from = frame * KEYFRAME_EVERY;
    let state = this.keyframes[frame];
    if (this.last.at <= target && this.last.at >= from) ({ at: from, state } = this.last);
    for (let i = from; i < target; i++) state = apply(state, this.log[i]);
    this.last = { at: target, state };
    this.recent.set(target, state);
    if (this.recent.size > 48) this.recent.delete(this.recent.keys().next().value!);
    return state;
  }
}

/** The `seq` of every decision a seat made: an `intent` entry with `of`. */
export const decisionsOf = (log: readonly GameEvent[]): number[] =>
  log.flatMap((entry) => (entry.t === 'intent' && entry.of !== undefined ? [entry.seq] : []));
