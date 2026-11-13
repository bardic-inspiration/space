// Forks on disk (spec 9.1). A fork leaves a match at a decision and is stored
// as what was done there, not as a log: its log is regenerated from the
// parent's, and checked against `logHash`.

import { stringify } from 'yaml';
import type { Authored, GameEvent, MatchRecord, Value } from '../core.ts';
import type { ForkSteps } from '../engine/session.ts';
import type { Project } from './project.ts';
import { STUDIO_FORMAT } from './schemas.ts';

export type ForkStep =
  | { author: { seat: string; changes: Authored[] } }
  | { bind: Record<string, string> }
  | { choose: { intent: string; params: Record<string, Value> } };

export interface ForkDoc {
  format: number;
  fork: { id: string; title?: string };
  variant: { id: string; hash: string };
  seed: string | number;
  /** Another fork's id, when this one leaves a fork. */
  parent?: string | null;
  /** The `seq` of the decision it leaves at. */
  at: number;
  steps: ForkStep[];
  logHash?: string;
}

export const forkPath = (ruleset: string, variant: string, fork: string): string => `studio/forks/${ruleset}/${variant}/${fork}.yaml`;

/** The steps as the engine takes them. Applied in this order when present: referee changes, bindings, the choice. */
export function stepsOf(doc: Pick<ForkDoc, 'steps'>): ForkSteps {
  const steps: ForkSteps = {};
  for (const step of doc.steps) {
    if ('author' in step) steps.author = step.author;
    else if ('bind' in step) steps.bind = { ...steps.bind, ...step.bind };
    else steps.choose = step.choose;
  }
  return steps;
}

export const toSteps = (steps: ForkSteps): ForkStep[] => [
  ...(steps.author && steps.author.changes.length > 0 ? [{ author: steps.author }] : []),
  ...(steps.bind && Object.keys(steps.bind).length > 0 ? [{ bind: steps.bind }] : []),
  ...(steps.choose ? [{ choose: steps.choose }] : []),
];

export function listForks(project: Project, ruleset: string, variant: string): ForkDoc[] {
  return project.under(`studio/forks/${ruleset}/${variant}`).flatMap((path) => {
    const { doc } = project.studioDoc<ForkDoc>('fork', path);
    return doc ? [doc] : [];
  });
}

export function saveFork(project: Project, ruleset: string, doc: ForkDoc): void {
  project.write(forkPath(ruleset, doc.variant.id, doc.fork.id), stringify({ ...doc, format: STUDIO_FORMAT }, { flowCollectionPadding: true }));
}

/** A fork and the forks it descends from, the first fork off the match first. */
export function chainOf(forks: ForkDoc[], id: string): ForkDoc[] {
  const chain: ForkDoc[] = [];
  for (let at = forks.find((fork) => fork.fork.id === id); at; at = at.parent ? forks.find((fork) => fork.fork.id === at!.parent) : undefined) {
    if (chain.includes(at)) throw new Error(`the fork "${at.fork.id}" is its own ancestor`);
    chain.unshift(at);
  }
  if (chain.length === 0) throw new Error(`there is no fork "${id}"`);
  return chain;
}

export interface Played {
  log: GameEvent[];
  record: MatchRecord;
}

/**
 * Regenerates a fork's log: the match, then each fork of the chain in turn.
 * `play` and `branch` are the session worker's, or the engine's own in a
 * test. Returns the log of every link, the last being the fork asked for.
 */
export async function regenerate(
  chain: ForkDoc[],
  play: (seed: string) => Promise<Played> | Played,
  branch: (parent: Played, seq: number, steps: ForkSteps, binds: Record<string, string>) => Promise<Played> | Played,
): Promise<{ runs: Played[]; binds: Record<string, string> }> {
  const runs = [await play(String(chain[0].seed))];
  let binds: Record<string, string> = {};
  for (const fork of chain) {
    const steps = stepsOf(fork);
    runs.push(await branch(runs.at(-1)!, fork.at, steps, binds));
    binds = { ...binds, ...steps.bind };
  }
  return { runs, binds };
}
