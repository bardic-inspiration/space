import { defineWorkspace } from 'vitest/config';

// Core ships TypeScript with no build, so it is transformed with the studio's own sources.
const shared = { extends: './vite.config.ts', test: { server: { deps: { inline: ['rpg-core'] } } } };

export default defineWorkspace([
  { ...shared, test: { ...shared.test, name: 'unit', include: ['tests/*.test.ts'], testTimeout: 120000 } },
  { ...shared, test: { ...shared.test, name: 'browser', include: ['tests/browser/*.test.ts'], testTimeout: 240000, hookTimeout: 120000 } },
]);
