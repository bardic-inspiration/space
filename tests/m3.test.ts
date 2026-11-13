// M3: Build and forks. The map editor's model, entity placement, errors on
// the right line of the right file, and forks that regenerate.

import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { compileMetrics, type MetricsDoc } from '../src/analyze/metrics.ts';
import { addEntity, addLink, deleteEntity, entityIndex, removeLink, setField } from '../src/build/entities.ts';
import { blankMap, checkModel, cloneModel, fill, paintRect, readMap, resize, setCell, valueAt, writeMap } from '../src/build/mapedit.ts';
import { CompileError, loadMap, type MapDoc } from '../src/core.ts';
import { compileInput, variantHash, type Compiled } from '../src/engine/input.ts';
import { branch, decisionAt, play, replayLog } from '../src/engine/session.ts';
import { decisionsOf } from '../src/log/cursor.ts';
import { bindPresentation } from '../src/present/presentation.ts';
import type { PresentationDoc } from '../src/present/types.ts';
import { chainOf, forkPath, listForks, regenerate, saveFork, stepsOf, toSteps, type ForkDoc } from '../src/project/forks.ts';
import { Project, diffLines, type FileIssue } from '../src/project/project.ts';
import { exampleProject } from './helpers.ts';

const RULESET = 'dnd-5e-2024-slice';
const fresh = () => Project.open(exampleProject());
const compiledOf = (project: Project, ruleset: string, variant: string) => compileInput(project.resolve(ruleset, variant)!.input);

/** The issues a variant has, placed in files: what the editor shows. */
function issuesOf(project: Project, ruleset: string, variant: string): FileIssue[] {
  const resolved = project.resolve(ruleset, variant)!;
  if (resolved.issues.length > 0) return resolved.issues;
  try {
    compileInput(resolved.input);
    return [];
  } catch (error) {
    if (!(error instanceof CompileError)) throw error;
    return project.locate(resolved, error.issues);
  }
}
const lineWith = (text: string, needle: string) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;

describe('the map editor', async () => {
  const project = await fresh();
  const base = project.variant(RULESET, '@pack-ambush')!;
  project.createVariant(RULESET, 'painted', base);
  const registry = compiledOf(project, RULESET, '@pack-ambush').registry;
  const source = project.text(`rulesets/${RULESET}/maps/rocky-pass.yaml`)!;

  test('a file read and written with nothing changed is the same file', () => {
    expect(writeMap(source, readMap(parse(source) as MapDoc, registry), registry)).toBe(source);
    const table = project.text('rulesets/holdem/maps/table.yaml')!;
    const holdem = compiledOf(project, 'holdem', '@four-handed').registry;
    expect(writeMap(table, readMap(parse(table) as MapDoc, holdem), holdem)).toBe(table);
  });

  test('a painted map loads with `loadMap`, round-trips through its file unchanged, and plays', async () => {
    const model = readMap(parse(source) as MapDoc, registry);
    setCell(model, registry, 0, 0, 'terrain', 'rock');
    paintRect(model, registry, { x: 20, y: 10 }, { x: 22, y: 12 }, 'terrain', 'difficult');
    fill(model, registry, 13, 6, 'terrain', 'open');
    setCell(model, registry, 3, 3, 'terrain', 'rock');
    setCell(model, registry, 3, 3, 'terrain', 'open');
    model.places.gate = { at: [25, 0] };
    model.places.camp = { at: [1, 9], size: [3, 2] };
    expect(valueAt(model, registry, 21, 11, 'terrain')).toBe('difficult');
    expect(valueAt(model, registry, 14, 7, 'terrain')).toBe('open');
    const text = writeMap(source, model, registry);
    // Written as a picture, keeping the file's symbols and its comments.
    expect(text).toContain("  - '#.........................'");
    expect(text).toContain("'\"': { terrain: difficult }    # scrub: Difficult Terrain");
    expect(text).not.toContain('cells:');
    const loaded = loadMap(registry, parse(text));
    expect(loaded.places).toEqual({ gate: { x: 25, y: 0 }, camp: { x: 1, y: 9, width: 3, height: 2 } });
    expect(loaded.blocksMove).toContainEqual({ x: 0, y: 0 });
    expect(writeMap(text, readMap(parse(text) as MapDoc, registry), registry)).toBe(text);
    project.writeShadow(RULESET, 'painted', 'maps/rocky-pass.yaml', text);
    expect(project.effective(RULESET, 'painted', 'maps/rocky-pass.yaml')).toBe(`studio/variants/${RULESET}/painted/files/maps/rocky-pass.yaml`);
    const compiled = compiledOf(project, RULESET, 'painted');
    expect(compiled.scenario.map!.cells.length).toBe(loaded.cells.length);
    expect(play(compiled, 1).record.outcome.result).toBe('win');
    expect(await variantHash(project.resolve(RULESET, 'painted')!.input)).not.toBe(await variantHash(project.resolve(RULESET, '@pack-ambush')!.input));
    // The base file is as it was, and the diff shows the change.
    expect(project.text(`rulesets/${RULESET}/maps/rocky-pass.yaml`)).toBe(source);
    expect(diffLines(source, text).filter((line) => line.op !== ' ').length).toBeGreaterThan(4);
  });

  test('a new symbol is added when a cell holds what the legend lacks, and `cells` is the fallback', () => {
    const junk = compiledOf(project, 'junkyard', '@yard').registry;
    const model = blankMap(junk, 'lot');
    setCell(model, junk, 2, 1, 'ground', 'wreck');
    const text = writeMap(undefined, model, junk);
    expect(parse(text)).toMatchObject({ format: 2, map: { id: 'lot' }, legend: { '.': {}, '#': { ground: 'wreck' } } });
    expect(loadMap(junk, parse(text)).blocksMove).toEqual([{ x: 2, y: 1 }]);
  });

  test('the size changes from any edge, within what the ruleset allows', () => {
    const model = readMap(parse(source) as MapDoc, registry);
    expect(resize(model, registry, 'left', 2)).toBeNull();
    expect([model.width, model.height]).toEqual([28, 14]);
    expect(valueAt(model, registry, 13, 3, 'terrain')).toBe('rock');
    expect(resize(model, registry, 'top', -1)).toBeNull();
    expect(valueAt(model, registry, 13, 2, 'terrain')).toBe('rock');
    const checkers = compiledOf(project, 'checkers', '@standard').registry;
    const board = readMap(project.doc<MapDoc>('rulesets/checkers/maps/board.yaml')!, checkers);
    expect(resize(board, checkers, 'right', 1)).toMatch(/at most 8 by 8/);
    expect(board.width).toBe(8);
  });

  test('checkers is played on its standard map and no other: its editor is read-only', () => {
    expect(compiledOf(project, 'checkers', '@standard').registry.space.map).toEqual({ standard: 'board', only: true });
  });

  test('a cell that breaks a `space.checks` rule is marked with the rule\'s message, and a missing required place is reported', async () => {
    const held = await fresh();
    held.createVariant(RULESET, 'strict', held.variant(RULESET, '@pack-ambush')!);
    const rules = held.text(`rulesets/${RULESET}/ruleset.yaml`)!.replace(
      "  blocksSight: \"cell.terrain == 'rock'\"\n",
      "  blocksSight: \"cell.terrain == 'rock'\"\n  checks:\n    - { that: \"cell.terrain != 'difficult'\", message: no scrub on this ground }\n  places: [gate]\n",
    );
    held.writeShadow(RULESET, 'strict', 'ruleset.yaml', rules);
    // The shadowed rules refuse the shipped map, in the map's own file.
    const refused = issuesOf(held, RULESET, 'strict');
    expect(refused.map((issue) => issue.message)).toEqual(expect.arrayContaining(['no scrub on this ground', 'the ruleset needs every map to have a place called "gate"']));
    expect(refused.every((issue) => issue.file === `rulesets/${RULESET}/maps/rocky-pass.yaml`)).toBe(true);
    const strict = compileInput({ ...held.resolve(RULESET, 'strict')!.input, scenario: { ...(held.resolve(RULESET, 'strict')!.input.scenario as object), map: undefined, space: { width: 4, height: 4, places: { gate: { at: [0, 0] } } } } }).registry;
    const model = blankMap(strict, 'yard');
    delete model.places.gate;
    setCell(model, strict, 2, 1, 'terrain', 'difficult');
    setCell(model, strict, 3, 3, 'terrain', 'rock');
    const checked = checkModel(model, strict);
    expect(checked.marks).toEqual([{ x: 2, y: 1, message: 'no scrub on this ground' }]);
    expect(checked.issues.map((issue) => issue.message)).toContain('the ruleset needs every map to have a place called "gate"');
    // The map is drawn and saved either way.
    expect(checked.map.cells).toHaveLength(2);
    expect(() => loadMap(strict, parse(writeMap(undefined, model, strict)))).toThrow(CompileError);
    model.places.gate = { at: [0, 0] };
    setCell(model, strict, 2, 1, 'terrain', 'open');
    expect(checkModel(model, strict).issues).toEqual([]);
    expect(loadMap(strict, parse(writeMap(undefined, cloneModel(model), strict))).places.gate).toEqual({ x: 0, y: 0 });
  });
});

describe('entity placement', async () => {
  const project = await fresh();
  const compiled = compiledOf(project, RULESET, '@worg-vs-scout');
  const source = project.text(`rulesets/${RULESET}/scenarios/worg-vs-scout.yaml`)!;
  project.createVariant(RULESET, 'moved', project.variant(RULESET, '@worg-vs-scout')!);
  const write = (text: string) => project.writeShadow(RULESET, 'moved', 'scenarios/worg-vs-scout.yaml', text);

  test('moving, adding, linking and deleting rewrite the scenario and keep its comments', () => {
    const worg = entityIndex(compiled.scenario, 'worg');
    let text = setField(source, worg, 'pos', [5, 5]);
    text = addEntity(text, { id: 'club', kind: 'weapon', fields: { name: 'Club', ability: 'str', dice: 1, die: 4, damageType: 'bludgeoning' } });
    text = addLink(text, { rel: 'wields', from: 'worg', to: 'club' });
    // Nothing but the lines that changed is touched.
    expect(diffLines(source, text).filter((line) => line.op === '-')).toHaveLength(1);
    expect(diffLines(source, text).filter((line) => line.op === '+')).toHaveLength(3);
    write(text);
    const edited = compiledOf(project, RULESET, 'moved');
    const start = edited.scenario.setup.find((event) => event.t === 'create' && event.id === 'worg') as unknown as { fields: { pos: unknown } };
    expect(start.fields.pos).toEqual({ x: 5, y: 5 });
    expect(edited.scenario.setup.some((event) => event.t === 'link' && event.to === 'club')).toBe(true);
    expect(play(edited, 1).record.outcome.result).toBe('win');
    text = removeLink(text, { rel: 'wields', from: 'worg', to: 'club' });
    text = deleteEntity(text, entityIndex(edited.scenario, 'club'), 'club');
    write(text);
    expect(compiledOf(project, RULESET, 'moved').scenario.setup.some((event) => event.t === 'create' && event.id === 'club')).toBe(false);
    expect(text).toBe(setField(source, worg, 'pos', [5, 5]));
  });

  test('core\'s refusals come back on the entity', () => {
    const pack = compiledOf(project, RULESET, '@pack-ambush');
    project.createVariant(RULESET, 'stuck', project.variant(RULESET, '@pack-ambush')!);
    const text = project.text(`rulesets/${RULESET}/scenarios/pack-ambush.yaml`)!;
    project.writeShadow(RULESET, 'stuck', 'scenarios/pack-ambush.yaml', setField(text, entityIndex(pack.scenario, 'scout'), 'speed', 31));
    const issues = issuesOf(project, RULESET, 'stuck');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('speed must be a multiple of 5 feet');
    expect(issues[0].file).toBe(`studio/variants/${RULESET}/stuck/files/scenarios/pack-ambush.yaml`);
    expect(issues[0].line).toBe(lineWith(project.text(issues[0].file)!, 'id: scout'));
  });
});

describe('a compile error is shown on the right line of the right file', async () => {
  const project = await fresh();
  const dir = (variant: string) => `studio/variants/${RULESET}/${variant}/files`;
  const shadow = (variant: string, rel: string, change: (text: string) => string, from = '@pack-ambush') => {
    if (!project.variant(RULESET, variant)) project.createVariant(RULESET, variant, project.variant(RULESET, from)!);
    project.writeShadow(RULESET, variant, rel, change(project.text(project.effective(RULESET, variant, rel))!));
    return `${dir(variant)}/${rel}`;
  };
  const only = (variant: string): FileIssue => {
    const issues = issuesOf(project, RULESET, variant);
    expect(issues.length, JSON.stringify(issues)).toBeGreaterThan(0);
    return issues[0];
  };

  test('the ruleset', () => {
    const file = shadow('e-rules', 'ruleset.yaml', (text) => text.replace('blocksMove: "cell.terrain == \'rock\'"', 'blocksMove: "cell.terrane == \'rock\'"'));
    const issue = only('e-rules');
    expect(issue).toMatchObject({ file, path: 'ruleset.space.blocksMove', line: lineWith(project.text(file)!, 'cell.terrane') });
  });

  test('an extension', () => {
    project.createVariant(RULESET, 'e-ext', project.variant(RULESET, '@worg-vs-scout')!);
    project.writeVariant(RULESET, 'e-ext', { ...project.variant(RULESET, 'e-ext')!.doc, extensions: ['second-wind'], behaviors: ['default', 'second-wind'] });
    expect(issuesOf(project, RULESET, 'e-ext')).toEqual([]);
    const file = shadow('e-ext', 'extensions/second-wind.yaml', (text) => text.replace('extends: { id: dnd-5e-2024-slice', 'extends: { id: some-other-game'));
    expect(only('e-ext')).toMatchObject({ file, line: lineWith(project.text(file)!, 'some-other-game') });
  });

  test('a behavior set, in the set that wrote the score', () => {
    const file = shadow('e-behave', 'behaviors/bold.yaml', () => [
      'format: 2', 'behaviorSet: { id: bold }', `ruleset: { id: ${RULESET}, version: 0.4.0 }`, 'behaviors:', '  packHunter:', '    scores:', '      attack: 100', '      bump: actor.nerve * 2', '',
    ].join('\n'));
    project.writeVariant(RULESET, 'e-behave', { ...project.variant(RULESET, 'e-behave')!.doc, behaviors: ['default', 'bold'] });
    const issue = only('e-behave');
    expect(issue.message).toMatch(/unknown intent "bump"/);
    expect(issue).toMatchObject({ file, path: 'behaviors.packHunter.scores.bump', line: 8 });
    // A score the default set wrote is shown there, not in the overlay.
    project.writeShadow(RULESET, 'e-behave', 'behaviors/bold.yaml', project.text(file)!.replace('      bump: actor.nerve * 2\n', ''));
    shadow('e-behave', 'behaviors/default.yaml', (text) => text.replace('      attack: 100\n      opportunityAttack: 100', '      attack: actor.nerve\n      opportunityAttack: 100'));
    expect(only('e-behave')).toMatchObject({ file: `${dir('e-behave')}/behaviors/default.yaml`, line: lineWith(project.text(`${dir('e-behave')}/behaviors/default.yaml`)!, 'actor.nerve') });
  });

  test('a map', () => {
    const file = shadow('e-map', 'maps/rocky-pass.yaml', (text) => text.replace("'#': { terrain: rock }", "'#': { terrain: lava }"));
    expect(only('e-map')).toMatchObject({ file, path: 'map.legend.#.terrain', line: lineWith(project.text(file)!, 'terrain: lava') });
  });

  test('a scenario', () => {
    const file = shadow('e-scene', 'scenarios/pack-ambush.yaml', (text) => text.replace('when: "game.round > 40"', 'when: "game.rond > 40"'));
    const text = project.text(file)!;
    expect(text).toContain('game.rond');
    expect(only('e-scene')).toMatchObject({ file, line: lineWith(text, 'game.rond') });
  });

  test('the variant\'s own file: a binding, a map, a key the format lacks, YAML that does not parse', () => {
    project.createVariant(RULESET, 'e-own', project.variant(RULESET, '@pack-ambush')!);
    const file = `studio/variants/${RULESET}/e-own/variant.yaml`;
    const doc = project.variant(RULESET, 'e-own')!.doc;
    project.writeVariant(RULESET, 'e-own', { ...doc, bind: { pack: 'coward' } });
    expect(only('e-own')).toMatchObject({ file, path: 'bind.pack', line: lineWith(project.text(file)!, 'coward') });
    project.writeVariant(RULESET, 'e-own', { ...doc, map: 'nowhere' });
    expect(only('e-own')).toMatchObject({ file, path: 'scenario.map', line: lineWith(project.text(file)!, 'nowhere') });
    project.write(file, `${project.text(file)!}colour: red\n`);
    expect(project.variantIssues(RULESET, 'e-own')[0]).toMatchObject({ file, message: 'unknown key "colour"' });
    project.write(file, 'format: 1\nvariant: { id: e-own\n');
    expect(project.variantIssues(RULESET, 'e-own')[0].file).toBe(file);
  });

  test('a presentation file and a metrics file', () => {
    const compiled = compiledOf(project, RULESET, '@pack-ambush');
    const path = `studio/presentation/${RULESET}/default.yaml`;
    project.write(path, project.text(path)!.replace('at: "self.pos"', 'at: "self.position"'));
    const presentation = bindPresentation(project.doc<PresentationDoc>(path), compiled);
    const placed = presentation.issues.map((issue) => project.place(path, issue.path.split('.'), issue));
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ file: path, path: 'instruments.creature.at', line: lineWith(project.text(path)!, 'self.position') });
    const metrics = `studio/metrics/${RULESET}.yaml`;
    project.write(metrics, project.text(metrics)!.replace('value: "game.round"', 'value: "game.rund"'));
    const checked = compileMetrics(compiled, project.doc<MetricsDoc>(metrics)!);
    expect(checked.issues.map((issue) => project.place(metrics, issue.path.split('.'), issue))[0]).toMatchObject({ file: metrics, line: lineWith(project.text(metrics)!, 'game.rund') });
  });
});

describe('forks', async () => {
  const project = await fresh();
  const resolved = project.resolve(RULESET, '@pack-ambush')!;
  const compiled: Compiled = compileInput(resolved.input);
  const hash = await variantHash(resolved.input);
  const parent = play(compiled, 7);
  const decisions = decisionsOf(parent.log);
  const playSeed = (seed: string) => play(compiled, seed);
  const branchOff = (from: { log: typeof parent.log }, seq: number, steps: Parameters<typeof branch>[3], binds: Record<string, string>) => branch(compiled, from.log, seq, steps, [], binds);

  test('a fork that chooses the option the match chose reproduces the parent\'s log', () => {
    for (const seq of [decisions[0], decisions[40], decisions.at(-1)!]) {
      const entry = parent.log[seq] as unknown as { intent: string; params: Record<string, never> };
      const again = branch(compiled, parent.log, seq, { choose: { intent: entry.intent, params: entry.params } }, parent.snapshots);
      expect(again.record.logHash).toBe(parent.record.logHash);
      expect(again.log).toEqual(parent.log);
    }
    // And with no steps at all, the seat's behavior chooses the same again.
    expect(branch(compiled, parent.log, decisions[25], {}, parent.snapshots).record.logHash).toBe(parent.record.logHash);
    expect(replayLog(compiled, parent.log)).toEqual({ ok: true });
  });

  test('a fork with a referee\'s ground change, a new binding and another choice is saved, reloaded, and regenerates to its logHash', async () => {
    const at = decisions.find((seq) => {
      const info = decisionAt(compiled, parent.log, seq, parent.snapshots);
      return info.options.length > 2 && info.options.some((option) => option.intent === 'move');
    })!;
    const info = decisionAt(compiled, parent.log, at, parent.snapshots);
    const other = info.options.find((_, index) => index !== info.chosen && info.options[index].intent === 'move')!;
    const steps = {
      author: { seat: 'referee', changes: [{ ground: { at: [9, 6] as [number, number], layer: 'terrain', value: 'difficult' } }] },
      bind: { ranger: 'defender', pack: 'hunter' },
      choose: other,
    };
    const forked = branch(compiled, parent.log, at, steps, parent.snapshots);
    expect(forked.record.logHash).not.toBe(parent.record.logHash);
    expect(forked.log.slice(0, at)).toEqual(parent.log.slice(0, at));
    expect(forked.log[at]).toMatchObject({ t: 'ground', by: 'referee', at: { x: 9, y: 6 }, value: 'difficult' });
    expect(forked.log[at + 1]).toMatchObject({ t: 'intent', intent: other.intent, params: other.params });
    expect(forked.record.seats.pack.driver).toBe('hunter');
    expect(replayLog(compiled, forked.log)).toEqual({ ok: true });

    const doc: ForkDoc = { format: 1, fork: { id: 'scout-flees', title: 'The scout runs instead' }, variant: { id: '@pack-ambush', hash }, seed: 7, parent: null, at, steps: toSteps(steps), logHash: forked.record.logHash };
    saveFork(project, RULESET, doc);
    expect(project.has(forkPath(RULESET, '@pack-ambush', 'scout-flees'))).toBe(true);
    const reloaded = listForks(project, RULESET, '@pack-ambush');
    expect(reloaded).toEqual([doc]);
    expect(stepsOf(reloaded[0])).toEqual(steps);
    const { runs } = await regenerate(chainOf(reloaded, 'scout-flees'), playSeed, branchOff);
    expect(runs).toHaveLength(2);
    expect(runs[1].record.logHash).toBe(doc.logHash);

    // A fork of a fork does the same, and keeps its parent's bindings.
    const later = decisionsOf(forked.log).find((seq) => seq > at + 60 && (forked.log[seq] as { of: number }).of > 1)!;
    const there = decisionAt(compiled, forked.log, later, forked.snapshots, steps.bind);
    const second = { choose: there.options[(there.chosen + 1) % there.options.length] };
    const grandchild = branch(compiled, forked.log, later, second, forked.snapshots, steps.bind);
    expect(grandchild.record.logHash).not.toBe(forked.record.logHash);
    const child: ForkDoc = { format: 1, fork: { id: 'and-then' }, variant: { id: '@pack-ambush', hash }, seed: 7, parent: 'scout-flees', at: later, steps: toSteps(second), logHash: grandchild.record.logHash };
    saveFork(project, RULESET, child);
    const all = listForks(project, RULESET, '@pack-ambush');
    expect(chainOf(all, 'and-then').map((fork) => fork.fork.id)).toEqual(['scout-flees', 'and-then']);
    const again = await regenerate(chainOf(all, 'and-then'), playSeed, branchOff);
    expect(again.runs).toHaveLength(3);
    expect(again.runs[2].record.logHash).toBe(child.logHash);
    expect(again.binds).toEqual(steps.bind);
  });

  test('a referee change needs a referee seat, and an illegal choice is refused', () => {
    expect(() => branch(compiled, parent.log, decisions[3], { choose: { intent: 'move', params: { actor: 'worg', to: { x: 0, y: 0 } } } })).toThrow(/not a legal option/);
    const checkers = compiledOf(project, 'checkers', '@standard');
    const game = play(checkers, 1);
    expect(() => branch(checkers, game.log, decisionsOf(game.log)[2], { author: { seat: 'red', changes: [] } })).toThrow(/not a referee/);
  });
});
