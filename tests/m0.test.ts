// M0: the pipe. The studio's host is held to core's contract, and core's
// recorded matches reproduce through the studio's engine and host.

import { describe, expect, test } from 'vitest';
import { compareHosts, createGridHost, loadMap, patchedForTest, type SpaceMap } from './support.ts';
import { compileInput, variantHash } from '../src/engine/input.ts';
import { play } from '../src/engine/session.ts';
import { createStudioHost } from '../src/host/studioHost.ts';
import { Project } from '../src/project/project.ts';
import { coreProject, recordedMatches } from './helpers.ts';

const project = await Project.open(coreProject());

/** Every map and inline space under core's rulesets, as a host is given it. */
function shippedMaps(): { name: string; map: SpaceMap; compiled: ReturnType<typeof compileInput> }[] {
  const found: { name: string; map: SpaceMap; compiled: ReturnType<typeof compileInput> }[] = [];
  for (const ruleset of project.rulesets()) {
    const variants = project.variants(ruleset);
    const compiled = variants.map((variant) => compileInput(project.resolve(ruleset, variant.id)!.input));
    variants.forEach((variant, index) => {
      const map = compiled[index].scenario.map;
      if (map) found.push({ name: `${ruleset}/${variant.scenario}`, map, compiled: compiled[index] });
    });
    for (const id of project.ids(ruleset, undefined, 'maps')) {
      found.push({ name: `${ruleset}/maps/${id}`, map: loadMap(compiled[0].registry, project.doc(`rulesets/${ruleset}/maps/${id}.yaml`)), compiled: compiled[0] });
    }
  }
  return found;
}

describe('the geometry host', () => {
  const maps = shippedMaps().filter(({ map }) => map.grid === 'square');
  test('there are maps to check', () => expect(maps.length).toBeGreaterThanOrEqual(6));

  test.each(maps.map((entry) => [entry.name, entry] as const))('agrees with the reference on %s', (_name, { map }) => {
    expect(compareHosts(createStudioHost(map), createGridHost(map), map)).toEqual([]);
  });

  test.each(maps.map((entry) => [entry.name, entry] as const))('agrees with the reference on %s under random ground writes', (name, { map, compiled }) => {
    for (const patched of patchedForTest(compiled.registry, map, name)) {
      expect(compareHosts(createStudioHost(patched), createGridHost(patched), patched)).toEqual([]);
    }
  });

  test('answers off the map without throwing', () => {
    const { map } = maps[0];
    const host = createStudioHost(map);
    const far = { x: -5, y: map.height + 3 };
    expect(host.inBounds(far)).toBe(false);
    expect(host.neighbors(far)).toEqual([]);
    expect(host.cellsWithin(far, map.unit)).toEqual([]);
    expect(host.distance(far, { x: 0, y: 0 })).toBeGreaterThan(0);
    expect(typeof host.lineOfSight(far, { x: 0, y: 0 })).toBe('boolean');
  });
});

describe('parity with core\'s recorded matches', () => {
  const recorded = recordedMatches();
  test('core ships 240 records', () => expect(recorded).toHaveLength(240));

  const byScenario = new Map<string, typeof recorded>();
  for (const record of recorded) byScenario.set(`${record.ruleset}/${record.scenario}`, [...(byScenario.get(`${record.ruleset}/${record.scenario}`) ?? []), record]);

  test.each([...byScenario])('%s reproduces every logHash', (name, records) => {
    const [rulesetId, scenario] = name.split('/');
    const ruleset = project.rulesets().find((folder) => (project.doc<{ ruleset: { id: string } }>(`rulesets/${folder}/ruleset.yaml`))!.ruleset.id === rulesetId)!;
    const compiled = compileInput(project.resolve(ruleset, `@${scenario}`)!.input);
    for (const record of records) {
      const played = play(compiled, record.seed);
      expect(played.record.logHash, `seed ${record.seed}`).toBe(record.logHash);
      expect(played.record.version).toBe(record.version);
    }
  });
});

describe('the variant hash', () => {
  test('is 16 hex digits, the same for the same input, and changes with the core commit', async () => {
    const input = project.resolve('checkers', '@standard')!.input;
    const hash = await variantHash(input);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(await variantHash(structuredClone(input))).toBe(hash);
    expect(await variantHash(input, 'another-commit')).not.toBe(hash);
    expect(await variantHash({ ...input, bind: { red: 'random' } })).not.toBe(hash);
  });
});
