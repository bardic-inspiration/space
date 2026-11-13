// M1: Run. Presentation files and their defaults, the four forms, the log
// tree, the cursor, and what the inspector is told about a decision.

import { describe, expect, test } from 'vitest';
import { hashLog, type GameEvent } from '../src/core.ts';
import { compileInput, type Compiled } from '../src/engine/input.ts';
import { decisionAt, play, type Played } from '../src/engine/session.ts';
import { createStudioHost } from '../src/host/studioHost.ts';
import { StateCache, decisionsOf } from '../src/log/cursor.ts';
import { buildTree, flatten, type TreeNode } from '../src/log/tree.ts';
import { bindPresentation, type Presentation } from '../src/present/presentation.ts';
import { sentenceOf, textOf, titleOf } from '../src/present/sentences.ts';
import type { PresentationDoc } from '../src/present/types.ts';
import { Project } from '../src/project/project.ts';
import { checkDoc } from '../src/project/schemas.ts';
import type { CardsItem } from '../src/forms/cards.ts';
import type { ChipsItem } from '../src/forms/chips.ts';
import { exampleProject } from './helpers.ts';

const project = await Project.open(exampleProject());
const compiledFor = (ruleset: string, variant: string): Compiled => compileInput(project.resolve(ruleset, variant)!.input);
const presentationDoc = (ruleset: string, id = 'default') => project.doc<PresentationDoc>(`studio/presentation/${ruleset}/${id}.yaml`);

function opened(compiled: Compiled, presentation: Presentation, played: Played) {
  const cache = new StateCache(played.log);
  const stateAt = (count: number) => cache.at(count);
  const openers = presentation.sections.map((section) => ({
    on: section.on, title: (entry: GameEvent) => titleOf(section.title, entry, { registry: compiled.registry, presentation, stateAt }),
  }));
  const tree = buildTree(played.log, 1 + compiled.scenario.setup.length, openers);
  return { cache, tree, sentence: (entry: GameEvent) => textOf(sentenceOf(entry, { registry: compiled.registry, presentation, tree, stateAt })) };
}

describe('with no presentation file', () => {
  const all = project.rulesets().flatMap((ruleset) => project.variants(ruleset).filter((variant) => variant.base).map((variant) => [ruleset, variant.id] as const));
  test('core ships six scenarios', () => expect(all).toHaveLength(6));

  test.each(all)('%s %s opens and plays', (ruleset, variant) => {
    const compiled = compiledFor(ruleset, variant);
    const presentation = bindPresentation(undefined, compiled);
    expect(presentation.issues).toEqual([]);
    const played = play(compiled, 1);
    const { cache, tree, sentence } = opened(compiled, presentation, played);
    // Every state of the match lays out, and every row reads as a sentence.
    for (const count of [0, Math.floor(played.log.length / 2), played.log.length]) {
      for (const { items } of presentation.layout(cache.at(count))) expect(Array.isArray(items)).toBe(true);
    }
    for (const entry of played.log.slice(0, 400)) expect(sentence(entry).length).toBeGreaterThan(0);
    expect(tree.roots[0].kind).toBe('setup');
    expect(tree.roots.at(-1)!.kind).toBe('end');
    // A ruleset with a space has its map, and nothing says a number is a stack or a list a hand.
    expect(Boolean(presentation.container)).toBe(compiled.registry.hasSpace);
    expect(presentation.components.every((instrument) => instrument.form.id === 'token')).toBe(true);
  });

  test('the junkyard gets a token for bots and piles, colored by seat where there is one', () => {
    const presentation = bindPresentation(undefined, compiledFor('junkyard', '@yard'));
    expect(presentation.components.map((instrument) => instrument.name).sort()).toEqual(['bot', 'pile']);
    expect(presentation.components.find((instrument) => instrument.name === 'bot')!.bound.doc.color).toEqual({ by: 'seat' });
  });
});

describe('the shipped presentation files', () => {
  const shipped = [['dnd-5e-2024-slice', 'default', '@pack-ambush'], ['holdem', 'default', '@four-handed'], ['holdem', 'ledger', '@four-handed'], ['checkers', 'default', '@standard']] as const;

  test.each(shipped)('%s/%s is a valid file and binds with nothing refused', (ruleset, id, variant) => {
    const doc = presentationDoc(ruleset, id);
    expect(checkDoc('presentation', doc)).toEqual([]);
    expect(bindPresentation(doc, compiledFor(ruleset, variant), id).issues).toEqual([]);
  });

  test('between them they use all four forms', () => {
    const forms = new Set(shipped.flatMap(([ruleset, id, variant]) => {
      const presentation = bindPresentation(presentationDoc(ruleset, id), compiledFor(ruleset, variant));
      return [presentation.container!, ...presentation.components].map((instrument) => instrument.form.id);
    }));
    expect([...forms].sort()).toEqual(['cards', 'chips', 'map', 'token']);
  });

  test('a refused part is reported by path and falls back', () => {
    const doc = structuredClone(presentationDoc('dnd-5e-2024-slice')!);
    doc.instruments!.creature.at = 'self.nowhere';
    doc.instruments!.bogus = { form: 'dice' };
    doc.instruments!.ground.layers!.lava = {};
    doc.sentences!.signal!['no.such'] = 'x';
    const presentation = bindPresentation(doc, compiledFor('dnd-5e-2024-slice', '@pack-ambush'));
    const paths = presentation.issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['instruments.creature.at', 'instruments.bogus.form', 'instruments.ground.layers.lava', 'sentences.signal.no.such']));
    expect(presentation.container).toBeDefined();
  });
});

describe('hold \'em', () => {
  const compiled = compiledFor('holdem', '@four-handed');
  const played = play(compiled, 1);
  const felt = bindPresentation(presentationDoc('holdem'), compiled);
  const ledger = bindPresentation(presentationDoc('holdem', 'ledger'), compiled, 'ledger');
  const cache = new StateCache(played.log);
  // A moment in the first hand with the flop down.
  const flop = played.log.find((entry) => entry.t === 'global' && entry.field === 'board' && (entry.value as number[]).length === 3)!.seq + 1;

  test('the table is a plane with its places, and the overlay has nothing to ask', () => {
    expect(compiled.scenario.map!.grid).toBe('none');
    expect(Object.keys(compiled.scenario.map!.places).sort()).toEqual(['board', 'chair0', 'chair1', 'chair2', 'chair3', 'pot']);
    expect(compiled.scenario.world.ground).toBeUndefined();
  });

  test('each chair has a stack and two hole cards, and the board and the pot fill', () => {
    const layout = new Map(felt.layout(cache.at(flop)).map(({ instrument, items }) => [instrument.name, items]));
    const stacks = layout.get('stack') as ChipsItem[];
    const holes = layout.get('hole') as CardsItem[];
    expect(stacks).toHaveLength(4);
    expect(holes).toHaveLength(4);
    expect(new Set(stacks.map((item) => `${item.point!.x},${item.point!.y}`)).size).toBe(4);
    for (const hole of holes) {
      expect(hole.faces).toHaveLength(2);
      expect(hole.hidden).toBe(true);
      expect(hole.faces[0].rank).toMatch(/^([2-9]|10|J|Q|K|A)$/);
      expect(['clubs', 'diamonds', 'hearts', 'spades']).toContain(hole.faces[0].suit);
    }
    expect((layout.get('community') as CardsItem[])[0].faces).toHaveLength(3);
    expect((layout.get('pot') as ChipsItem[])[0].count).toBeGreaterThan(0);
    expect(stacks.reduce((sum, item) => sum + item.count, 0) + (layout.get('pot') as ChipsItem[])[0].count).toBe(4000);
    // Before the first deal the board is empty, and so is the pot.
    const start = new Map(felt.layout(cache.at(1 + compiled.scenario.setup.length)).map(({ instrument, items }) => [instrument.name, items]));
    expect((start.get('community') as CardsItem[])[0].faces).toHaveLength(0);
    expect((start.get('pot') as ChipsItem[])[0].count).toBe(0);
  });

  test('a second presentation file looks different and changes nothing that is played', () => {
    const a = JSON.stringify(felt.layout(cache.at(flop)).map(({ items }) => items));
    const b = JSON.stringify(ledger.layout(cache.at(flop)).map(({ items }) => items));
    expect(a).not.toBe(b);
    expect((ledger.layout(cache.at(flop)).find(({ instrument }) => instrument.name === 'community')!.items[0] as CardsItem).faces[0].text).toMatch(/^\d+[cdhs]$/);
    // Appearance is not part of a run (S20): the input has no place for it, so the log cannot move.
    expect(JSON.stringify(project.resolve('holdem', '@four-handed')!.input)).not.toContain('instruments');
    expect(play(compiled, 1).record.logHash).toBe(played.record.logHash);
  });

  test('a dealt hand reads as its faces in the log', () => {
    const { sentence } = opened(compiled, felt, played);
    const dealt = played.log.find((entry) => entry.t === 'set' && entry.field === 'hole' && (entry.value as number[]).length === 2)!;
    expect(sentence(dealt)).toMatch(/^(north|east|south|west) is dealt ([2-9JQKA]|10)[♣♦♥♠]([2-9JQKA]|10)[♣♦♥♠]$/);
  });
});

describe('the pack ambush', () => {
  const compiled = compiledFor('dnd-5e-2024-slice', '@pack-ambush');
  const presentation = bindPresentation(presentationDoc('dnd-5e-2024-slice'), compiled);
  const played = play(compiled, 1);

  test('rock and Difficult Terrain are on the map, with their looks', () => {
    const map = compiled.scenario.map!;
    const terrain = new Set(map.cells.map((cell) => cell.values.terrain));
    expect([...terrain].sort()).toEqual(['difficult', 'rock']);
    const layers = (presentation.container!.bound as unknown as { layers: { name: string; values: Map<string, { color: string; raise?: number; pattern?: string }> }[] }).layers;
    expect(layers[0].values.get('rock')).toMatchObject({ color: '#5c5c5c', raise: 0.6 });
    expect(layers[0].values.get('difficult')).toMatchObject({ pattern: 'hatch' });
  });

  test('a closed corner removes a diagonal from `neighbors`, and a decision shows the call', () => {
    const map = compiled.scenario.map!;
    const host = createStudioHost(map);
    const open = createStudioHost({ ...map, corners: 'open' });
    const cut = map.blocksMove.flatMap((rock) => [{ x: rock.x - 1, y: rock.y }, { x: rock.x + 1, y: rock.y }])
      .find((cell) => host.inBounds(cell) && host.neighbors(cell).length < open.neighbors(cell).length);
    expect(cut).toBeDefined();
    const seq = decisionsOf(played.log).find((at) => (played.log[at] as { intent: string }).intent === 'move')!;
    const calls = decisionAt(compiled, played.log, seq, played.snapshots).explanation.intents.flatMap((intent) => [
      ...intent.domains.flatMap((domain) => domain.calls), ...intent.candidates.flatMap((candidate) => candidate.gates.flatMap((gate) => gate.calls)),
    ]);
    expect(calls.some((call) => call.fn === 'neighbors')).toBe(true);
  });

  test('an attack reads as its result, and tokens take their side\'s color', () => {
    const { sentence, cache } = opened(compiled, presentation, played);
    const attack = played.log.find((entry) => entry.t === 'intent' && entry.intent === 'attack')!;
    expect(sentence(attack)).toMatch(/^\w+ → [\w ]+ → \w+: (hit(, critical)?|miss)$/);
    const tokens = presentation.layout(cache.at(played.log.length)).find(({ instrument }) => instrument.name === 'creature')!.items as unknown as { color: string; entity: string; dim: boolean }[];
    expect(tokens.find((token) => token.entity === 'worg')!.color).toBe('#b5483a');
    expect(tokens.find((token) => token.entity === 'scout')!.color).toBe('#3a6fb5');
    expect(tokens.some((token) => token.dim)).toBe(true);
  });

  test('sections are rounds, then turns', () => {
    const { tree } = opened(compiled, presentation, played);
    const round = tree.sections[0];
    expect(round.title).toBe('Round 1');
    const turn = round.children.find((node) => node.kind === 'section')!;
    expect(turn.title).toMatch(/'s turn$/);
    expect(flatten(tree, new Set(), new Set()).length).toBe(played.log.length - (1 + compiled.scenario.setup.length) + 1 + tree.bySeq.filter(Boolean).length - played.log.length
      + [...walk(tree.roots)].filter((node) => node.kind === 'section').length);
  });
});

function* walk(nodes: TreeNode[]): Generator<TreeNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children);
  }
}

describe('the mage duel', () => {
  const compiled = compiledFor('dnd-5e-2024-slice', '@mage-duel');
  const games = Array.from({ length: 40 }, (_, index) => play(compiled, index + 1));

  test('the ground changes at the `ground` entries and changes back when scrubbed before them', () => {
    const played = games.find((game) => game.record.byType.ground > 0)!;
    expect(played).toBeDefined();
    const cache = new StateCache(played.log);
    const write = played.log.find((entry) => entry.t === 'ground')! as Extract<GameEvent, { t: 'ground' }>;
    const terrainAt = (count: number) => createStudioHost(compiled.scenario.mapAt(cache.at(count))!).cellAt(write.at).terrain;
    expect(terrainAt(write.seq)).toBe('open');
    expect(terrainAt(write.seq + 1)).toBe('difficult');
    expect(terrainAt(played.log.length)).toBe('difficult');
    expect(terrainAt(write.seq)).toBe('open');
    // Core hands back the same map for the same ground, so the board redraws only when it changes.
    expect(compiled.scenario.mapAt(cache.at(write.seq - 1))).toBe(compiled.scenario.mapAt(cache.at(write.seq)));
    expect(compiled.scenario.mapAt(cache.at(write.seq + 1))).not.toBe(compiled.scenario.mapAt(cache.at(write.seq)));
  });

  test('a Counterspell at a Shield at an attack is nested three decisions deep', () => {
    // The shipped behaviors never counter a Shield, so the variant `dagger-duel` binds one that does.
    const brawl = compiledFor('dnd-5e-2024-slice', 'dagger-duel');
    const chain = (node: TreeNode | undefined): string[] => {
      const names: string[] = [];
      for (let at = node; at; at = at.parent) if (at.entry?.t === 'intent') names.unshift(at.entry.intent);
      return names;
    };
    const played = play(brawl, 1);
    const tree = buildTree(played.log, 1 + brawl.scenario.setup.length);
    const counter = played.log.find((entry) => entry.t === 'intent' && entry.intent === 'counterspell'
      && chain(tree.bySeq[entry.seq]).join(' > ') === 'attack > castWard > counterspell')!;
    expect(counter).toBeDefined();
    // Each decision sits under the one that prompted it.
    let depth = 0;
    for (let at = tree.bySeq[counter.seq]; at.parent; at = at.parent) depth += 1;
    expect(depth).toBeGreaterThanOrEqual(2);
  });
});

describe('the cursor', () => {
  const compiled = compiledFor('junkyard', '@yard');
  const played = play(compiled, 1);

  test('the state at any cursor is the fold of the log up to it', () => {
    const cache = new StateCache(played.log);
    expect(played.log.length).toBeGreaterThan(2000);
    const final = cache.at(played.log.length);
    expect(final.ended).toEqual(played.record.outcome);
    // Out of order, across keyframes, and back: each is what a fresh fold gives.
    for (const count of [0, 1, 255, 256, 257, 1000, 3, 2047, 2048, played.log.length - 1, 600]) {
      expect(cache.at(count)).toEqual(new StateCache(played.log).at(count));
    }
    expect(hashLog(played.log)).toBe(played.record.logHash);
  });
});

describe('the inspector\'s decision', () => {
  test.each([['dnd-5e-2024-slice', '@worg-vs-scout'], ['checkers', '@standard'], ['holdem', '@four-handed']])('%s %s: every decision lists as many options as `of`, with the one chosen among them', (ruleset, variant) => {
    const compiled = compiledFor(ruleset, variant);
    const played = play(compiled, 2);
    const decisions = decisionsOf(played.log).slice(0, 60);
    expect(decisions.length).toBeGreaterThan(10);
    for (const seq of decisions) {
      const entry = played.log[seq] as Extract<GameEvent, { t: 'intent' }>;
      const info = decisionAt(compiled, played.log, seq, played.snapshots);
      expect(info.options).toHaveLength(entry.of!);
      expect(info.chosen).toBeGreaterThanOrEqual(0);
      expect(info.options[info.chosen]).toEqual({ intent: entry.intent, params: entry.params });
      expect(info.seat).toBe(entry.seat);
      if (info.scores) expect(info.scores).toHaveLength(entry.of!);
      // The legal candidates of the explanation are the options, in order.
      const legal = info.explanation.intents.flatMap((intent) => intent.candidates.filter((candidate) => candidate.legal));
      expect(legal).toHaveLength(entry.of!);
    }
  });
});
