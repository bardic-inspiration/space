// Node-side loading for the tests: core's checkout, as it sits in node_modules.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MemoryFiles } from '../src/project/files.ts';

export const CORE_ROOT = fileURLToPath(new URL('../node_modules/rpg-core/', import.meta.url));
export const EXAMPLES_ROOT = fileURLToPath(new URL('../examples/', import.meta.url));

function walk(root: string, dir: string, into: Record<string, string>): void {
  for (const name of readdirSync(`${root}${dir}`).sort()) {
    const path = dir ? `${dir}/${name}` : name;
    if (statSync(`${root}${path}`).isDirectory()) walk(root, path, into);
    else if (/\.(yaml|jsonl)$/.test(name)) into[path] = readFileSync(`${root}${path}`, 'utf8');
  }
}

/** The files of a core checkout that make a project: the kit and the rulesets. */
export function coreFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  walk(CORE_ROOT, 'kit', files);
  walk(CORE_ROOT, 'rulesets', files);
  return files;
}

/** The studio's bundled examples: core's files and the shipped `studio/` folder. */
export function exampleFiles(): Record<string, string> {
  const files = coreFiles();
  walk(EXAMPLES_ROOT, 'studio', files);
  return files;
}

export const coreProject = () => new MemoryFiles(coreFiles());
export const exampleProject = () => new MemoryFiles(exampleFiles());

export const recordedMatches = (): { ruleset: string; scenario: string; seed: string; logHash: string; version: string }[] =>
  readFileSync(`${CORE_ROOT}data/matches.jsonl`, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
