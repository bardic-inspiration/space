// A batch worker: one seed per job. It plays the match, measures it, and
// answers one record. A match that throws is a record with `error`.

import { CompileError } from '../core.ts';
import { runJob } from '../analyze/metrics.ts';
import { CompiledCache } from './cache.ts';
import type { BatchReply, BatchRequest } from './protocol.ts';

const scope = self as unknown as { onmessage: (event: MessageEvent<BatchRequest>) => void; postMessage(message: BatchReply): void };
const compiled = new CompiledCache(4);

scope.onmessage = ({ data }) => {
  const { id, hash } = data;
  if (!data.input && !compiled.has(hash)) return scope.postMessage({ id, type: 'need-input' });
  try {
    scope.postMessage({ id, type: 'record', record: runJob(compiled.get(hash, data.input), hash, data.seed, data.metrics) });
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    scope.postMessage({ id, type: 'errors', errors: error.issues });
  }
};
