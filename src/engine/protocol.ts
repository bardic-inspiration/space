// The messages between the page and its workers. Everything here is plain
// data. Every request carries an id, and the input with its variant hash: a
// worker compiles an input once per hash and keeps the last few.

import type { GameEvent, MatchRecord } from '../core.ts';
import type { BatchRecord, MetricsDoc } from '../analyze/metrics.ts';
import type { RunInput } from './input.ts';
import type { DecisionInfo, ForkSteps } from './session.ts';

export interface Issue {
  path: string;
  message: string;
}

interface Base {
  id: number;
  hash: string;
  /** Absent when the worker is known to hold this hash already. */
  input?: RunInput;
}

export type SessionRequest =
  | (Base & { type: 'play'; seed: string })
  | (Base & { type: 'decision'; log: GameEvent[]; logHash: string; seq: number; bind?: Record<string, string> })
  | (Base & { type: 'branch'; log: GameEvent[]; logHash: string; seq: number; steps: ForkSteps; binds?: Record<string, string> })
  | (Base & { type: 'replay'; log: GameEvent[] })
  | { type: 'cancel'; id: number };

export type SessionReply = { id: number } & (
  | { type: 'played'; log: GameEvent[]; record: MatchRecord }
  | { type: 'decision'; decision: DecisionInfo }
  | { type: 'replayed'; ok: boolean; error?: string }
  | { type: 'errors'; errors: Issue[] }
  | { type: 'error'; error: string }
  | { type: 'cancelled' }
);

export type BatchRequest = Base & { type: 'job'; seed: string; metrics: MetricsDoc | null };

export type BatchReply = { id: number } & (
  | { type: 'record'; record: BatchRecord }
  | { type: 'errors'; errors: Issue[] }
  | { type: 'need-input' }
);
