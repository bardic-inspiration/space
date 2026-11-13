// A worker's compiled inputs, by variant hash, the most recent few kept.

import { compileInput, type Compiled, type RunInput } from './input.ts';

export class CompiledCache {
  private readonly held = new Map<string, Compiled>();
  private readonly keep: number;
  constructor(keep: number) {
    this.keep = keep;
  }

  has(hash: string): boolean {
    return this.held.has(hash);
  }

  /** The compiled input for a hash; compiles `input` when the hash is new. Throws core's `CompileError`. */
  get(hash: string, input?: RunInput): Compiled {
    let compiled = this.held.get(hash);
    if (compiled) this.held.delete(hash);
    else {
      if (!input) throw new Error(`no input was given for variant ${hash}`);
      compiled = compileInput(input);
    }
    this.held.set(hash, compiled);
    while (this.held.size > this.keep) this.held.delete(this.held.keys().next().value!);
    return compiled;
  }
}
