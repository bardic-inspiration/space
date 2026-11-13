// The bundled examples: core's kit and rulesets, as they come with the
// pinned dependency, and the studio's own example folder. Held in memory;
// this is what opens first, and all another browser than Chromium gets (S4).

import { MemoryFiles } from './files.ts';

const core = import.meta.glob('../../node_modules/rpg-core/{kit,rulesets}/**/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const studio = import.meta.glob('../../examples/studio/**/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function exampleFiles(): MemoryFiles {
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(core)) files[path.slice(path.indexOf('rpg-core/') + 'rpg-core/'.length)] = text;
  for (const [path, text] of Object.entries(studio)) files[path.slice(path.indexOf('examples/') + 'examples/'.length)] = text;
  return new MemoryFiles(files, 'Examples');
}
