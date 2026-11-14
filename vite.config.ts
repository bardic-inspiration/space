import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import type { TestProjectInlineConfiguration } from 'vitest/config';

// The core commit the studio is built against: the pin in package.json (S3).
const pin = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> })
  .dependencies['rpg-core'];
export const CORE_COMMIT = pin.slice(pin.indexOf('#') + 1);

// Core's schema checker builds validators with `new Function`, so the page and its workers allow `unsafe-eval`.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:";
const csp: Plugin = {
  name: 'studio-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

// Core ships TypeScript with no build, so it is transformed with the studio's own sources.
const project = (name: string, include: string[], testTimeout: number, hookTimeout?: number): TestProjectInlineConfiguration => ({
  extends: true,
  test: { name, include, testTimeout, ...(hookTimeout && { hookTimeout }), server: { deps: { inline: ['rpg-core'] } } },
});

export default defineConfig({
  base: './',
  plugins: [react(), csp],
  define: { __CORE_COMMIT__: JSON.stringify(CORE_COMMIT) },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: {
    projects: [
      project('unit', ['tests/*.test.ts'], 120000),
      project('browser', ['tests/browser/*.test.ts'], 240000, 120000),
    ],
  },
});
