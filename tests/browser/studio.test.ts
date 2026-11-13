// The built site in headless Chromium: matches played in workers, the board
// drawn with WebGL, and the three modes driven as a designer would.
//   npm run build && npm run test:browser

import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Studio } from '../../src/ui/studio.ts';
import type { Board } from '../../src/board/board.ts';
import { recordedMatches } from '../helpers.ts';

declare const studio: Studio;
declare const boards: Map<string, Board>;
declare const FolderFiles: new (handle: FileSystemDirectoryHandle) => import('../../src/project/files.ts').ProjectFiles;

const root = fileURLToPath(new URL('../../', import.meta.url));
const shots = `${root}tests/browser/shots/`;
const recorded = recordedMatches();
const hashOf = (ruleset: string, scenario: string, seed: number) => recorded.find((record) => record.ruleset === ruleset && record.scenario === scenario && record.seed === String(seed))!.logHash;

let server: PreviewServer;
let browser: Browser;
let page: Page;
const errors: string[] = [];

beforeAll(async () => {
  if (!existsSync(`${root}dist/index.html`)) throw new Error('the site is not built: run `npm run build` first');
  mkdirSync(shots, { recursive: true });
  server = await preview({ root, preview: { port: 4188, strictPort: true }, logLevel: 'silent' });
  // Software WebGL, so the board draws on a machine with no GPU.
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('dialog', (dialog) => void dialog.accept(dialog.type() === 'prompt' ? dialogAnswer : undefined));
  await page.goto('http://localhost:4188/');
  await page.waitForFunction(() => studio.state.match !== null);
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.httpServer.close(resolve));
});

/** What the next prompt is answered with. */
let dialogAnswer = 'test-variant';
const select = (ruleset: string, variant: string) => page.evaluate(async ([r, v]) => {
  await studio.select(r, v);
  return studio.state.match?.record.logHash;
}, [ruleset, variant]);
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
/** How much of the board's canvas is not background: a board that drew nothing is all one color. */
const inked = (name = 'main') => page.evaluate(async (board) => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))));
  const canvas = document.querySelector<HTMLCanvasElement>(`[data-board="${board}"] canvas`)!;
  const copy = document.createElement('canvas');
  copy.width = 300;
  copy.height = 180;
  const context = copy.getContext('2d')!;
  boards.get(board)!.invalidate();
  await new Promise((resolve) => requestAnimationFrame(() => {
    context.drawImage(canvas, 0, 0, 300, 180);
    resolve(null);
  }));
  const pixels = context.getImageData(0, 0, 300, 180).data;
  const colors = new Set<number>();
  for (let i = 0; i < pixels.length; i += 4) colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
  return colors.size;
}, name);

describe('M0', () => {
  test('the built site plays a match in a worker, and its record is core\'s', async () => {
    expect(await select('checkers', '@standard')).toBe(hashOf('checkers', 'standard', 1));
    const policy = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'));
    expect(policy).toContain("'unsafe-eval'");
    expect(errors).toEqual([]);
  });
});

describe('M1: Run', () => {
  const scenarios = [['checkers', 'standard'], ['dnd-5e-2024-slice', 'mage-duel'], ['dnd-5e-2024-slice', 'pack-ambush'], ['dnd-5e-2024-slice', 'worg-vs-scout'], ['holdem', 'four-handed'], ['junkyard', 'yard']];

  test.each(scenarios)('%s/%s opens and plays with no presentation file, and with its own', async (ruleset, scenario) => {
    const folder = ruleset === 'dnd-5e-2024-slice' ? ruleset : ruleset;
    expect(await select(folder, `@${scenario}`)).toBe(hashOf(ruleset, scenario, 1));
    for (const look of ['none', 'default']) {
      await page.evaluate((id) => {
        studio.setLook(id);
        studio.setCursor(Math.floor(studio.state.match!.log.length / 2));
      }, look);
      expect(await inked(), `${scenario} with look ${look}`).toBeGreaterThan(3);
      expect(await page.evaluate(() => studio.state.issues)).toEqual([]);
    }
    expect(await page.locator('.log-row').count()).toBeGreaterThan(5);
    await page.screenshot({ path: `${shots}run-${scenario}.png` });
    expect(errors).toEqual([]);
  });

  test('hold \'em: the table has its places and no overlay, and a second look changes the picture and not the match', async () => {
    const hash = await select('holdem', '@four-handed');
    await page.evaluate(() => {
      const { log } = studio.state.match!;
      studio.setCursor(log.find((entry) => entry.t === 'global' && entry.field === 'board' && (entry.value as number[]).length === 3)!.seq + 1);
      studio.stepDecision(1);
    });
    await page.waitForFunction(() => studio.state.decision?.info);
    await expect.poll(() => page.locator('.decision').innerText()).toContain('The debug overlay is unavailable');
    expect(await page.locator('.tray').count()).toBe(0);
    const felt = await page.locator('[data-board="main"] canvas').screenshot();
    const variantHash = await page.evaluate(() => studio.state.hash);
    await page.selectOption('select[aria-label="Look"]', 'ledger');
    await settle();
    const ledger = await page.locator('[data-board="main"] canvas').screenshot();
    expect(felt.equals(ledger)).toBe(false);
    expect(await page.evaluate(() => [studio.state.hash, studio.state.match!.record.logHash])).toEqual([variantHash, hash]);
    await page.selectOption('select[aria-label="Look"]', 'default');
  });

  test('at a decision the inspector lists as many options as `of`, with the one the log chose', async () => {
    await select('dnd-5e-2024-slice', '@pack-ambush');
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+ArrowRight');
      await page.waitForFunction(() => studio.state.decision?.info && studio.state.decision.seq === studio.state.cursor);
      const of = await page.evaluate(() => (studio.state.match!.log[studio.state.cursor] as { of: number }).of);
      await expect.poll(() => page.locator('[data-testid="options"] .option').count()).toBe(of);
      expect(await page.locator('[data-testid="options"] .option.chosen').count()).toBe(1);
    }
  });

  test('the overlay draws the host calls of a move, and themes and tilt redraw the board', async () => {
    await page.evaluate(() => {
      const match = studio.state.match!;
      studio.setCursor(match.decisions.find((seq) => (match.log[seq] as { intent?: string }).intent === 'move')!);
    });
    await page.waitForFunction(() => studio.state.decision?.info);
    await page.locator('.intent-head', { hasText: 'move' }).click();
    const before = await page.locator('[data-board="main"] canvas').screenshot();
    await page.locator('.candidate.domain').first().click();
    await settle();
    expect(await page.evaluate(() => studio.state.overlay!.some((call) => call.fn === 'neighbors'))).toBe(true);
    expect((await page.locator('[data-board="main"] canvas').screenshot()).equals(before)).toBe(false);
    await page.screenshot({ path: `${shots}overlay.png` });
    await page.getByRole('button', { name: 'Dark' }).click();
    await page.getByRole('button', { name: 'Tilt' }).click();
    await settle();
    await page.screenshot({ path: `${shots}dark-tilt.png` });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.getByRole('button', { name: 'Light' }).click();
    await page.getByRole('button', { name: 'Tilt' }).click();
  });

  test('the mage duel\'s ground changes at its `ground` entries, and back when scrubbed before them', async () => {
    await select('dnd-5e-2024-slice', '@mage-duel');
    const seed = await page.evaluate(async () => {
      for (let seed = 1; seed <= 40; seed++) {
        await studio.play(String(seed));
        if (studio.state.match!.record.byType.ground) return seed;
      }
      return 0;
    });
    expect(seed).toBeGreaterThan(0);
    const shotsAt = async (offset: number) => {
      await page.evaluate((by) => {
        const write = studio.state.match!.log.find((entry) => entry.t === 'ground')!;
        studio.setCursor(write.seq + by);
        studio.selectEntity(undefined, (write as { at: { x: number; y: number } }).at);
      }, offset);
      await settle();
      return page.locator('.inspector').innerText();
    };
    expect(await shotsAt(0)).toMatch(/terrain\s+open/);
    expect(await shotsAt(1)).toMatch(/terrain\s+difficult \(the map has open\)/);
    expect(await shotsAt(0)).toMatch(/terrain\s+open/);
  });

  test('the junkyard: scrubbing the whole timeline keeps up', async () => {
    await select('junkyard', '@yard');
    const measured = await page.evaluate(async () => {
      const total = studio.state.match!.log.length;
      const board = boards.get('main')!;
      const steps = 240;
      // What a cursor move costs in script: the fold, the layout, the panels, and the board's update, up to the draw call.
      let shown = 0;
      const show = board.show.bind(board);
      board.show = (...given) => { shown += 1; show(...given); };
      const scripted = performance.now();
      for (let i = 0; i <= steps; i++) {
        const before = shown;
        studio.setCursor(Math.round((i / steps) * total));
        for (let turn = 0; shown === before && turn < 100; turn++) await Promise.resolve();
      }
      const script = (performance.now() - scripted) / (steps + 1);
      // And with a frame drawn for each.
      const drawn = board.frames;
      const started = performance.now();
      for (let i = steps; i >= 0; i--) {
        studio.setCursor(Math.round((i / steps) * total));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const frame = (performance.now() - started) / (steps + 1);
      board.show = show;
      return { total, script, frame, frames: board.frames - drawn, moves: shown };
    });
    console.log(`junkyard scrub: ${measured.total} entries; ${measured.script.toFixed(1)} ms of script a cursor move; a frame every ${measured.frame.toFixed(1)} ms with software WebGL`);
    expect(measured.total).toBeGreaterThan(2000);
    expect(measured.frames).toBeGreaterThan(100);
    // 60 frames a second leaves 16.7 ms a frame. Script must fit well inside it; the frame itself is the GPU's, and headless has none.
    expect(measured.script).toBeLessThan(8);
  });
});

describe('M2: Analyze', () => {
  test('a folder opens as a project, a batch runs across the pool, and nothing outside studio/ is written', async () => {
    const result = await page.evaluate(async () => {
      // A checkout of core, in the browser's private file system: the same API a folder on disk is read through.
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(`core-${Date.now()}`, { create: true });
      const examples = (studio.state.project!.files as unknown as { files: Map<string, string> }).files;
      const base = [...examples].filter(([path]) => !path.startsWith('studio/'));
      for (const [path, text] of base) {
        const parts = path.split('/');
        let at = dir;
        for (const part of parts.slice(0, -1)) at = await at.getDirectoryHandle(part, { create: true });
        const writable = await (await at.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
      }
      const files = new FolderFiles(dir);
      await studio.open(files);
      const opened = { rulesets: studio.state.project!.rulesets(), saves: studio.state.project!.files.saves, studioBefore: (await files.list(['studio'])).length };
      await studio.select('dnd-5e-2024-slice', '@worg-vs-scout');
      studio.set({ mode: 'analyze' });
      await studio.runBatch({ from: 1, to: 40 });
      await studio.state.project!.saved();
      const after = await files.list(['kit', 'rulesets', 'studio']);
      const unchanged = (await Promise.all(base.map(async ([path, text]) => (await files.read(path)) === text))).every(Boolean);
      const records = (await files.read(after.find((path) => path.endsWith('records.jsonl'))!))!.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { seed: string; logHash: string });
      return { opened, written: after.filter((path) => path.startsWith('studio/')).map((path) => path.replace(/\/[0-9a-f]{16}\//, '/<hash>/')), others: after.filter((path) => !path.startsWith('studio/')).length, baseCount: base.length, unchanged, records };
    });
    expect(result.opened).toEqual({ rulesets: ['checkers', 'dnd-5e-2024-slice', 'holdem', 'junkyard'], saves: true, studioBefore: 0 });
    expect(result.written.sort()).toEqual(['studio/batches/dnd-5e-2024-slice/@worg-vs-scout/<hash>/batch.yaml', 'studio/batches/dnd-5e-2024-slice/@worg-vs-scout/<hash>/records.jsonl', 'studio/project.yaml']);
    expect(result.others).toBe(result.baseCount);
    expect(result.unchanged).toBe(true);
    expect(result.records.map((record) => [record.seed, record.logHash])).toEqual(Array.from({ length: 40 }, (_, index) => [String(index + 1), hashOf('dnd-5e-2024-slice', 'worg-vs-scout', index + 1)]));
    await page.evaluate(() => studio.openExamples());
    await page.waitForFunction(() => studio.state.match !== null && studio.state.project!.name === 'Examples');
  });

  test('100 junkyard matches across the pool', async () => {
    await select('junkyard', '@yard');
    const timed = await page.evaluate(async () => {
      studio.set({ mode: 'analyze' });
      const started = performance.now();
      const batch = await studio.runBatch({ from: 1, to: 100 });
      return { seconds: (performance.now() - started) / 1000, records: batch!.records.length, workers: studio.batchPool.workerCount, cores: navigator.hardwareConcurrency };
    });
    console.log(`100 junkyard matches: ${timed.seconds.toFixed(1)} s on ${timed.workers} workers (${timed.cores} cores)`);
    expect(timed.records).toBe(100);
    // The spec's bound is 10 seconds on 8 workers; scaled to the workers this machine gives.
    expect(timed.seconds).toBeLessThan((10 * 8) / timed.workers);
  });

  test('a batch cancelled halfway and resumed is the batch run through', async () => {
    await select('checkers', '@standard');
    const result = await page.evaluate(async () => {
      const running = studio.runBatch({ from: 1, to: 40 });
      await new Promise<void>((resolve) => {
        const stop = studio.subscribe(() => {
          if ((studio.state.progress?.done ?? 0) >= 12) { stop(); resolve(); }
        });
      });
      studio.cancelBatch();
      const partial = (await running)!.records.length;
      const whole = (await studio.runBatch({ from: 1, to: 40 }))!;
      return { partial, text: studio.state.project!.text(`${whole.path}/records.jsonl`)!, seeds: whole.records.map((record) => record.seed) };
    });
    expect(result.partial).toBeGreaterThanOrEqual(12);
    expect(result.partial).toBeLessThan(40);
    expect(result.seeds).toEqual(Array.from({ length: 40 }, (_, index) => String(index + 1)));
    const hashes = result.text.split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { logHash: string }).logHash);
    expect(hashes).toEqual(Array.from({ length: 40 }, (_, index) => hashOf('checkers', 'standard', index + 1)));
  });

  test('two variants of the pack ambush compare side by side, a heatmap draws, and an outlier opens in Run', async () => {
    for (const variant of ['@pack-ambush', 'pack-hunters', 'open-field']) {
      await select('dnd-5e-2024-slice', variant);
      await page.evaluate(async () => {
        studio.set({ mode: 'analyze' });
        await studio.runBatch({ from: 1, to: 30 });
      });
    }
    expect(await page.locator('.batch').count()).toBe(3);
    await page.getByRole('button', { name: 'Compare' }).click();
    await expect.poll(() => page.locator('[data-testid="compare"] svg[aria-label="Outcome split"]').count()).toBe(3);
    expect(await page.locator('[data-testid="compare"] table tbody tr').count()).toBeGreaterThan(6);
    await page.screenshot({ path: `${shots}compare.png` });

    // The `deaths` heatmap, on the rocky pass and beside the open field.
    await page.locator('.batch[data-batch="pack-hunters"] input').uncheck();
    await page.getByRole('button', { name: 'Heatmaps' }).click();
    const plain = await inked('main');
    await page.getByRole('button', { name: 'deaths', exact: true }).click();
    await page.waitForSelector('[data-board="partner"] canvas');
    await settle();
    expect(await inked('main')).toBeGreaterThan(plain);
    await page.screenshot({ path: `${shots}heatmap.png` });
    await page.getByRole('button', { name: 'deaths', exact: true }).click();

    await page.locator('.batch[data-batch="open-field"] input').uncheck();
    await page.getByRole('button', { name: 'Outliers' }).click();
    const row = page.locator('[data-testid="outliers"] tbody tr').first();
    const seed = await row.locator('td').first().innerText();
    await row.click();
    await page.waitForFunction((wanted) => studio.state.mode === 'run' && studio.state.match?.seed === wanted && !studio.state.running, seed);
    expect(await page.evaluate(() => [studio.state.variant, studio.state.notice])).toEqual(['@pack-ambush', expect.stringMatching(/regenerated to its record's logHash/)]);
  });

  test('editing a metric marks the batch stale', async () => {
    await page.evaluate(() => studio.set({ mode: 'analyze', notice: null }));
    expect(await page.locator('.batch .stale').count()).toBe(0);
    await page.getByRole('button', { name: 'Metrics' }).click();
    expect(await page.locator('[data-testid="metric-values"]').innerText()).toMatch(/rounds\s+int\s+\d+/);
    await page.evaluate(() => {
      const path = 'studio/metrics/dnd-5e-2024-slice.yaml';
      studio.writeFile(path, studio.state.project!.text(path)!.replace('value: "game.round"', 'value: "game.round * 2"'));
    });
    await expect.poll(() => page.locator('.batch .stale').count()).toBe(3);
    expect(await page.locator('.batch .stale').first().innerText()).toContain('the metrics changed');
  });
});

describe('M3: Build and forks', () => {
  test('checkers\' map editor is read-only', async () => {
    await select('checkers', '@standard');
    await page.evaluate(() => studio.set({ mode: 'build' }));
    await page.locator('.tabs button', { hasText: 'Map' }).click();
    expect(await page.locator('[data-testid="map-readonly"]').innerText()).toContain('no other');
    expect(await page.getByRole('button', { name: 'brush' }).count()).toBe(0);
  });

  test('a map painted on the board is saved as a shadow in a new variant, and plays', async () => {
    await select('dnd-5e-2024-slice', '@pack-ambush');
    await page.evaluate(() => studio.set({ mode: 'build' }));
    await page.locator('.tabs button', { hasText: 'Map' }).click();
    await page.getByRole('button', { name: 'rock', exact: true }).click();
    dialogAnswer = 'walled';
    const cell = async (x: number, y: number) => page.evaluate(([cx, cy]) => boards.get('main')!.toClient({ x: cx + 0.5, y: cy + 0.5 }), [x, y]);
    const [from, to] = [await cell(2, 1), await cell(5, 1)];
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => studio.state.variant === 'walled' && studio.state.hash !== null && studio.state.compiled?.scenario.map?.blocksMove.some((held) => held.x === 3 && held.y === 1));
    const saved = await page.evaluate(() => studio.state.project!.text('studio/variants/dnd-5e-2024-slice/walled/files/maps/rocky-pass.yaml'));
    expect(saved).toContain("  - '..####....................'");
    expect(await page.evaluate(() => studio.state.issues)).toEqual([]);
    // Undo, per document, takes the stroke back; redo puts it on again.
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(() => !studio.state.project!.has('studio/variants/dnd-5e-2024-slice/walled/files/maps/rocky-pass.yaml'));
    await page.getByRole('button', { name: 'Redo' }).click();
    await page.waitForFunction(() => studio.state.compiled?.scenario.map?.blocksMove.some((held) => held.x === 3 && held.y === 1));
    await page.screenshot({ path: `${shots}map-editor.png` });
    await page.evaluate(() => studio.set({ mode: 'run' }));
    await page.waitForFunction(() => studio.state.match?.hash === studio.state.hash);
    expect(await page.evaluate(() => studio.state.match!.record.outcome.result)).toBe('win');
  });

  test('a token dragged on the board moves its entity in the scenario', async () => {
    await page.evaluate(() => studio.set({ mode: 'build' }));
    await page.locator('.tabs button', { hasText: 'Entities' }).click();
    const at = async (x: number, y: number) => page.evaluate(([cx, cy]) => boards.get('main')!.toClient({ x: cx + 0.5, y: cy + 0.5 }), [x, y]);
    const [from, to] = [await at(4, 5), await at(3, 9)];
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => studio.state.project!.has('studio/variants/dnd-5e-2024-slice/walled/files/scenarios/pack-ambush.yaml') && studio.state.hash !== null);
    expect(await page.evaluate(() => studio.state.project!.text('studio/variants/dnd-5e-2024-slice/walled/files/scenarios/pack-ambush.yaml'))).toContain('pos: [3, 9], attacksPerAction: 2');
    expect(await page.locator('.right').innerText()).toContain('scout');
  });

  test('an error typed into a document shows on its line, and the last good compile stays on the board', async () => {
    await page.locator('.tabs button', { hasText: 'Files' }).click();
    await page.locator('.files button', { hasText: 'behaviors/default.yaml' }).click();
    const good = await page.evaluate(() => studio.state.hash);
    await page.evaluate(() => {
      const view = (document.querySelector('.editor') as unknown as { view: { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } }).view;
      const at = view.state.doc.toString().indexOf('attack: 100');
      view.dispatch({ changes: { from: at, to: at + 'attack: 100'.length, insert: 'attack: actor.nerve' }, userEvent: 'input' });
    });
    await page.waitForFunction(() => studio.state.issues.length > 0);
    const issue = await page.evaluate(() => studio.state.issues[0]);
    const text = await page.evaluate((file) => studio.state.project!.text(file)!, issue.file);
    expect(issue.file).toBe('studio/variants/dnd-5e-2024-slice/walled/files/behaviors/default.yaml');
    expect(issue.line).toBe(text.split('\n').findIndex((line) => line.includes('actor.nerve')) + 1);
    expect(await page.evaluate(() => [studio.state.hash, studio.state.compiled !== null])).toEqual([null, true]);
    await expect.poll(() => page.locator('.cm-lint-marker-error').count()).toBeGreaterThan(0);
    expect(await page.locator('.issues').innerText()).toContain('cannot be run');
    await page.screenshot({ path: `${shots}error.png` });
    await page.evaluate(() => {
      const view = (document.querySelector('.editor') as unknown as { view: { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } }).view;
      const at = view.state.doc.toString().indexOf('attack: actor.nerve');
      view.dispatch({ changes: { from: at, to: at + 'attack: actor.nerve'.length, insert: 'attack: 100' }, userEvent: 'input' });
    });
    await page.waitForFunction(() => studio.state.issues.length === 0 && studio.state.hash !== null);
    expect(good).toBeTruthy();
  });

  test('a fork made in Run opens beside its parent, is saved, and regenerates to its logHash', async () => {
    await select('dnd-5e-2024-slice', '@pack-ambush');
    await page.evaluate(() => {
      studio.set({ mode: 'run' });
      const match = studio.state.match!;
      studio.setCursor(match.decisions.find((seq) => (match.log[seq] as { intent?: string; of?: number }).intent === 'move' && (match.log[seq] as { of: number }).of > 3)!);
    });
    await page.waitForFunction(() => studio.state.decision?.info);
    const parent = await page.evaluate(() => studio.state.match!.record.logHash);
    // Another option, a referee's ground change, and a new binding.
    await page.locator('[data-testid="options"] .option:not(.chosen)').first().click();
    await page.getByRole('button', { name: 'terrain difficult' }).click();
    const spot = await page.evaluate(() => boards.get('main')!.toClient({ x: 9.5, y: 6.5 }));
    await page.mouse.click(spot.x, spot.y);
    await page.selectOption('select[aria-label="Bind pack"]', 'hunter');
    await page.getByRole('button', { name: 'Run the fork' }).click();
    await page.waitForFunction(() => studio.state.branch !== null && !studio.state.running);
    expect(await page.locator('[data-board="partner"]').count()).toBe(1);
    const forked = await page.evaluate(() => ({ hash: studio.state.branch!.record.logHash, at: studio.state.branch!.fork!.at, first: studio.state.branch!.log[studio.state.branch!.fork!.at] }));
    expect(forked.hash).not.toBe(parent);
    expect(forked.first).toMatchObject({ t: 'ground', by: 'referee', at: { x: 9, y: 6 } });
    await page.screenshot({ path: `${shots}fork.png` });
    await page.fill('input[aria-label="Fork id"]', 'scout-flees');
    await page.getByRole('button', { name: 'Save the fork' }).click();
    expect(await page.evaluate(() => studio.state.project!.text('studio/forks/dnd-5e-2024-slice/@pack-ambush/scout-flees.yaml'))).toContain(`logHash: ${forked.hash}`);

    // A fork of the fork, then both regenerated from what was saved.
    await page.evaluate(() => {
      const branch = studio.state.branch!;
      studio.setCursor(branch.decisions.find((seq) => seq > branch.fork!.at + 40 && (branch.log[seq] as { of: number }).of > 2)!);
    });
    await page.waitForFunction(() => studio.state.decision?.info && studio.state.decision.seq === studio.state.cursor);
    await page.locator('[data-testid="options"] .option:not(.chosen)').first().click();
    await page.getByRole('button', { name: 'Run the fork' }).click();
    await page.waitForFunction((was) => studio.state.branch !== null && !studio.state.running && studio.state.branch.record.logHash !== was, forked.hash);
    const second = await page.evaluate(() => studio.state.branch!.record.logHash);
    await page.fill('input[aria-label="Fork id"]', 'and-then');
    await page.getByRole('button', { name: 'Save the fork' }).click();
    await select('dnd-5e-2024-slice', '@pack-ambush');
    for (const [id, hash] of [['scout-flees', forked.hash], ['and-then', second]]) {
      await page.evaluate((fork) => studio.openFork(fork), id);
      expect(await page.evaluate(() => [studio.state.branch!.record.logHash, studio.state.notice])).toEqual([hash, expect.stringContaining('regenerated to its logHash')]);
    }
    expect(errors).toEqual([]);
  });
});
