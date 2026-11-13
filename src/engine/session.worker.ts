// The session worker: the one interactive match. It plays to the end,
// explains a decision, branches, and replays. A newer `play` supersedes an
// older one, and a cancelled request is answered as cancelled.

import { CompileError, type Snapshot } from '../core.ts';
import { CompiledCache } from './cache.ts';
import type { SessionReply, SessionRequest } from './protocol.ts';
import { branch, decisionAt, play, replayLog, snapshotsOf } from './session.ts';

const scope = self as unknown as { onmessage: (event: MessageEvent<SessionRequest>) => void; postMessage(message: SessionReply): void };
const compiled = new CompiledCache(4);
/** Snapshots of the logs this worker has played or been shown, by variant hash and log hash. */
const snapshots = new Map<string, Snapshot[]>();
const cancelled = new Set<number>();
const queue: Exclude<SessionRequest, { type: 'cancel' }>[] = [];
let draining = false;

const remember = (key: string, taken: Snapshot[]) => {
  snapshots.delete(key);
  snapshots.set(key, taken);
  while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
};

function answer(request: Exclude<SessionRequest, { type: 'cancel' }>): SessionReply {
  const { id } = request;
  try {
    const input = compiled.get(request.hash, request.input);
    const known = (logHash: string, log: Parameters<typeof snapshotsOf>[1]) => {
      const key = `${request.hash}:${logHash}`;
      if (!snapshots.has(key)) remember(key, snapshotsOf(input, log));
      return snapshots.get(key)!;
    };
    switch (request.type) {
      case 'play': {
        const played = play(input, request.seed);
        remember(`${request.hash}:${played.record.logHash}`, played.snapshots);
        return { id, type: 'played', log: played.log, record: played.record };
      }
      case 'decision':
        return { id, type: 'decision', decision: decisionAt(input, request.log, request.seq, known(request.logHash, request.log), request.bind) };
      case 'branch': {
        const played = branch(input, request.log, request.seq, request.steps, known(request.logHash, request.log), request.binds);
        remember(`${request.hash}:${played.record.logHash}`, played.snapshots);
        return { id, type: 'played', log: played.log, record: played.record };
      }
      case 'replay': {
        const result = replayLog(input, request.log);
        return { id, type: 'replayed', ok: result.ok, ...(result.ok ? {} : { error: result.error }) };
      }
    }
  } catch (error) {
    if (error instanceof CompileError) return { id, type: 'errors', errors: error.issues };
    return { id, type: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

function drain() {
  draining = true;
  // One request per task, so a `cancel` or a newer `play` that arrived meanwhile is seen first.
  setTimeout(() => {
    const request = queue.shift();
    if (request) scope.postMessage(cancelled.delete(request.id) ? { id: request.id, type: 'cancelled' } : answer(request));
    if (queue.length > 0) drain();
    else draining = false;
  }, 0);
}

scope.onmessage = ({ data }) => {
  if (data.type === 'cancel') {
    cancelled.add(data.id);
    return;
  }
  if (data.type === 'play') {
    for (const waiting of queue) if (waiting.type === 'play') cancelled.add(waiting.id);
  }
  queue.push(data);
  if (!draining) drain();
};
