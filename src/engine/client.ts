// The page's side of the workers: the session worker as promises, and the
// batch pool as a queue of seeds.

import type { GameEvent, MatchRecord } from '../core.ts';
import type { BatchRecord, MetricsDoc } from '../analyze/metrics.ts';
import type { RunInput } from './input.ts';
import type { BatchReply, BatchRequest, Issue, SessionReply, SessionRequest } from './protocol.ts';
import type { DecisionInfo, ForkSteps } from './session.ts';

/** Core refused the input: every reason, by path. */
export class InputErrors extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
    this.issues = issues;
  }
}
export class Cancelled extends Error {}

export interface Run {
  hash: string;
  input: RunInput;
}

type Unsent<T> = T extends unknown ? Omit<T, 'id' | 'hash' | 'input'> : never;

export class SessionClient {
  private readonly worker: Worker;
  private next = 1;
  private readonly waiting = new Map<number, { resolve(reply: SessionReply): void }>();
  private latestPlay = 0;

  constructor(worker: Worker = new Worker(new URL('./session.worker.ts', import.meta.url), { type: 'module' })) {
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<SessionReply>) => {
      this.waiting.get(event.data.id)?.resolve(event.data);
      this.waiting.delete(event.data.id);
    };
  }

  private async ask(run: Run, request: Unsent<Exclude<SessionRequest, { type: 'cancel' }>>): Promise<SessionReply> {
    const id = this.next++;
    if (request.type === 'play') {
      if (this.latestPlay) this.cancel(this.latestPlay);
      this.latestPlay = id;
    }
    const reply = await new Promise<SessionReply>((resolve) => {
      this.waiting.set(id, { resolve });
      this.worker.postMessage({ ...request, id, hash: run.hash, input: run.input } as SessionRequest);
    });
    if (reply.type === 'errors') throw new InputErrors(reply.errors);
    if (reply.type === 'error') throw new Error(reply.error);
    if (reply.type === 'cancelled') throw new Cancelled('cancelled');
    return reply;
  }

  cancel(id: number): void {
    if (this.waiting.has(id)) this.worker.postMessage({ type: 'cancel', id } satisfies SessionRequest);
  }

  async play(run: Run, seed: string | number): Promise<{ log: GameEvent[]; record: MatchRecord }> {
    const reply = await this.ask(run, { type: 'play', seed: String(seed) });
    if (reply.type !== 'played') throw new Error(`unexpected ${reply.type}`);
    return { log: reply.log, record: reply.record };
  }

  async decision(run: Run, log: GameEvent[], logHash: string, seq: number, bind?: Record<string, string>): Promise<DecisionInfo> {
    const reply = await this.ask(run, { type: 'decision', log, logHash, seq, bind });
    if (reply.type !== 'decision') throw new Error(`unexpected ${reply.type}`);
    return reply.decision;
  }

  async branch(run: Run, log: GameEvent[], logHash: string, seq: number, steps: ForkSteps, binds?: Record<string, string>): Promise<{ log: GameEvent[]; record: MatchRecord }> {
    const reply = await this.ask(run, { type: 'branch', log, logHash, seq, steps, binds });
    if (reply.type !== 'played') throw new Error(`unexpected ${reply.type}`);
    return { log: reply.log, record: reply.record };
  }

  async replay(run: Run, log: GameEvent[]): Promise<{ ok: boolean; error?: string }> {
    const reply = await this.ask(run, { type: 'replay', log });
    if (reply.type !== 'replayed') throw new Error(`unexpected ${reply.type}`);
    return { ok: reply.ok, error: reply.error };
  }

  dispose(): void {
    this.worker.terminate();
  }
}

export interface BatchHandle {
  /** Resolves with the records in, in seed order, when the batch finishes or is cancelled. */
  done: Promise<{ records: BatchRecord[]; cancelled: boolean }>;
  cancel(): void;
}

/** How many workers the pool runs: one core is left for the page. */
export const poolSize = (cores: number = navigator.hardwareConcurrency || 2): number => Math.max(1, Math.min(8, cores - 1));

export class BatchPool {
  private readonly workers: Worker[] = [];
  /** The hashes each worker holds, mirroring the worker's own cache of four. */
  private readonly holds: string[][] = [];
  private readonly size: number;
  private readonly make: () => Worker;
  private busy = false;

  constructor(size: number = poolSize(), make: () => Worker = () => new Worker(new URL('./batch.worker.ts', import.meta.url), { type: 'module' })) {
    this.size = size;
    this.make = make;
  }

  get workerCount(): number {
    return this.size;
  }

  /** Plays one seed per job from a shared queue. `onRecord` is called as each record comes in. */
  run(run: Run, seeds: string[], metrics: MetricsDoc | null, onRecord?: (record: BatchRecord, done: number, total: number) => void): BatchHandle {
    if (this.busy) throw new Error('the pool is already running a batch');
    this.busy = true;
    while (this.workers.length < Math.min(this.size, Math.max(1, seeds.length))) {
      this.workers.push(this.make());
      this.holds.push([]);
    }
    const queue = [...seeds];
    const records = new Map<string, BatchRecord>();
    let stopped = false;
    let active = 0;
    let finish!: (value: { records: BatchRecord[]; cancelled: boolean }) => void;
    let fail!: (error: Error) => void;
    const done = new Promise<{ records: BatchRecord[]; cancelled: boolean }>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const settle = () => {
      if (active > 0 || (!stopped && queue.length > 0)) return;
      this.busy = false;
      finish({ records: seeds.flatMap((seed) => (records.has(seed) ? [records.get(seed)!] : [])), cancelled: stopped });
    };
    const feed = (index: number) => {
      const worker = this.workers[index];
      const seed = stopped ? undefined : queue.shift();
      if (seed === undefined) return settle();
      active += 1;
      const send = (withInput: boolean) => {
        if (withInput) this.holds[index] = [...this.holds[index].filter((hash) => hash !== run.hash), run.hash].slice(-4);
        worker.postMessage({ type: 'job', id: index, hash: run.hash, seed, metrics, ...(withInput ? { input: run.input } : {}) } satisfies BatchRequest);
      };
      worker.onerror = (event) => {
        this.busy = false;
        stopped = true;
        fail(new Error(event.message));
      };
      worker.onmessage = (event: MessageEvent<BatchReply>) => {
        const reply = event.data;
        if (reply.type === 'need-input') return send(true);
        active -= 1;
        if (reply.type === 'errors') {
          stopped = true;
          this.busy = false;
          return fail(new InputErrors(reply.errors));
        }
        records.set(seed, reply.record);
        onRecord?.(reply.record, records.size, seeds.length);
        feed(index);
      };
      send(!this.holds[index].includes(run.hash));
    };
    this.workers.forEach((_, index) => feed(index));
    if (seeds.length === 0) settle();
    return { done, cancel: () => { stopped = true; settle(); } };
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.holds.length = 0;
  }
}
