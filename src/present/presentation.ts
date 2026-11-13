// A presentation file bound to one compiled variant. Each part is checked
// against the ruleset; a part that is refused falls back to its default, so
// a ruleset with no file at all is fully usable (S10).

import type { Registry, Scenario, SpaceMap, State, Value } from '../core.ts';
import { FORMS, PALETTE, isContainer, type Bound, type ContainerForm, type Form } from '../forms/index.ts';
import { parseTemplate, type Part } from './template.ts';
import type { Frame, InlineNode, InstrumentDoc, Issue, ItemBase, PresentationDoc, SentenceGroup, Where } from './types.ts';

export interface Instrument {
  name: string;
  form: Form;
  bound: Bound;
}

export interface Sentence {
  text: Part[];
  then: string[];
}

export interface Section {
  on: { global: string } | { signal: string };
  title: Part[];
}

export interface Presentation {
  /** The file's id under `studio/presentation/<ruleset>/`, or `default` when there is none. */
  id: string;
  registry: Registry;
  scenario: Scenario;
  container?: Instrument & { form: ContainerForm };
  components: Instrument[];
  /** The key of an outcome that batches are split by, when the file names one. */
  outcome?: string;
  sections: Section[];
  sentences: Record<SentenceGroup, Map<string, Sentence>>;
  /** Refusals, by path into the file. Each refused part fell back to its default. */
  issues: Issue[];
  /** `map` stands in for the scenario's own: a map being edited, drawn before it is saved or sound. */
  frame(state: State, map?: SpaceMap): Frame;
  /** Every instrument's items for one state: the container first. */
  layout(state: State, map?: SpaceMap): { instrument: Instrument; items: ItemBase[] }[];
  /** An entity as its instrument draws it inline: a token as a chip in its color. */
  inlineEntity(id: string, state: State): InlineNode;
  /** A value written to a field or global that an instrument is bound to, as that instrument draws it. */
  inlineValue(at: { kind: string; field: string; entity: string } | { global: string }, value: Value, state: State): InlineNode | null;
}

/** The instruments a ruleset gets with no file: a map when it has a space, and a token for every kind with exactly one cell field. */
export function defaultInstruments(registry: Registry): Record<string, InstrumentDoc> {
  const instruments: Record<string, InstrumentDoc> = {};
  if (registry.hasSpace) instruments.map = { form: 'map' };
  for (const kind of registry.kinds.values()) {
    const cells = [...kind.fields.values()].filter((field) => field.type.k === 'cell');
    if (cells.length !== 1) continue;
    instruments[kind.name] = {
      form: 'token', of: kind.name, at: `self.${cells[0].name}`,
      label: kind.fields.get('name')?.type.k === 'string' ? '{name}' : '{id}',
      ...(kind.fields.has('seat') ? { color: { by: 'seat' } } : {}),
    };
  }
  return instruments;
}

const GROUPS: SentenceGroup[] = ['intent', 'signal', 'set', 'global', 'create', 'destroy', 'link', 'unlink', 'ground'];

export function bindPresentation(doc: PresentationDoc | undefined, compiled: { registry: Registry; scenario: Scenario }, id = 'default'): Presentation {
  const { registry, scenario } = compiled;
  const issues: Issue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  if (doc && doc.presentation.ruleset !== registry.id) issue('presentation.ruleset', `written for ${doc.presentation.ruleset}, but the ruleset is ${registry.id}`);

  // Instruments. One that is refused is left out; with none listed, the defaults stand in.
  const bindAll = (docs: Record<string, InstrumentDoc>, report: boolean): Instrument[] => Object.entries(docs).flatMap(([name, instrument]) => {
    const form = FORMS[instrument.form];
    const at = `instruments.${name}`;
    if (!form) {
      if (report) issue(`${at}.form`, `there is no form "${instrument.form}": the forms are ${Object.keys(FORMS).join(', ')}`);
      return [];
    }
    const bound = form.check(name, instrument, { registry, scenario, issue: (path, message) => report && issue(`${at}${path}`, message) });
    return bound ? [{ name, form, bound }] : [];
  });
  const listed = doc?.instruments && Object.keys(doc.instruments).length > 0;
  const fallback = defaultInstruments(registry);
  let instruments = listed ? bindAll(doc!.instruments!, true) : bindAll(fallback, false);
  const containers = instruments.filter((instrument) => isContainer(instrument.form));
  if (containers.length > 1) issue(`instruments.${containers[1].name}`, 'a ruleset has one map');
  // The others need a stage to stand on: a ruleset with a space always has its map.
  if (containers.length === 0 && registry.hasSpace) instruments = [...bindAll({ map: fallback.map }, false), ...instruments];
  const container = instruments.find((instrument) => isContainer(instrument.form)) as Presentation['container'];
  const components = instruments.filter((instrument) => !isContainer(instrument.form));

  // Colors: what the file gives, then the palette by first appearance in the scenario.
  const colors = new Map<string, Map<string, string>>();
  const colorBy = (field: string, value: Value): string => {
    let known = colors.get(field);
    if (!known) {
      colors.set(field, known = new Map());
      const given = doc?.colors?.[field] ?? {};
      let next = 0;
      for (const event of scenario.setup) {
        if (event.t !== 'create' || !(field in event.fields)) continue;
        const key = String(event.fields[field]);
        if (!known.has(key)) known.set(key, given[key] ?? PALETTE[next++ % PALETTE.length]);
      }
      for (const [key, color] of Object.entries(given)) known.set(key, color);
    }
    const key = String(value);
    if (!known.has(key)) known.set(key, PALETTE[known.size % PALETTE.length]);
    return known.get(key)!;
  };

  const sections: Section[] = (doc?.sections ?? []).flatMap((section, index) => {
    if ('global' in section.on && !registry.globals.has(section.on.global)) issue(`sections.${index}.on.global`, `the ruleset declares no global "${section.on.global}"`);
    else if ('signal' in section.on && !registry.signals.has(section.on.signal)) issue(`sections.${index}.on.signal`, `the ruleset declares no signal "${section.on.signal}"`);
    else return [{ on: section.on, title: parseTemplate(section.title) }];
    return [];
  });

  const known: Record<SentenceGroup, (key: string) => string | null> = {
    intent: (key) => (registry.intents.has(key) ? null : `the ruleset declares no intent "${key}"`),
    signal: (key) => (registry.signals.has(key) ? null : `the ruleset declares no signal "${key}"`),
    set: (key) => {
      const [kind, field] = key.split('.');
      const spec = registry.kinds.get(kind);
      return !spec ? `the ruleset declares no kind "${kind}"` : spec.fields.has(field ?? '') ? null : `${kind} has no field "${field}"`;
    },
    global: (key) => (registry.globals.has(key) ? null : `the ruleset declares no global "${key}"`),
    create: (key) => (registry.kinds.has(key) ? null : `the ruleset declares no kind "${key}"`),
    destroy: (key) => (registry.kinds.has(key) ? null : `the ruleset declares no kind "${key}"`),
    link: (key) => (registry.relations.has(key) ? null : `the ruleset declares no relation "${key}"`),
    unlink: (key) => (registry.relations.has(key) ? null : `the ruleset declares no relation "${key}"`),
    ground: (key) => (registry.cellLayers.has(key) ? null : `the ruleset declares no cell layer "${key}"`),
  };
  const sentences = Object.fromEntries(GROUPS.map((group) => [group, new Map<string, Sentence>()])) as Presentation['sentences'];
  for (const group of GROUPS) {
    for (const [key, sentence] of Object.entries(doc?.sentences?.[group] ?? {})) {
      const reason = known[group](key);
      if (reason) {
        issue(`sentences.${group}.${key}`, reason);
        continue;
      }
      const then = typeof sentence === 'string' ? [] : sentence.then ?? [];
      const unknown = then.find((signal) => !registry.signals.has(signal));
      if (unknown !== undefined) issue(`sentences.${group}.${key}.then`, `the ruleset declares no signal "${unknown}"`);
      sentences[group].set(key, { text: parseTemplate(typeof sentence === 'string' ? sentence : sentence.text), then: unknown === undefined ? then : [] });
    }
  }

  const frame = (state: State, given?: SpaceMap): Frame => {
    const map = given ?? scenario.mapAt(state);
    return {
      registry, scenario, state, map, colorBy,
      locate: (where: Where) => (container && map ? container.form.locate(container.bound, map, where) : null),
    };
  };
  const tokenOf = (kind: string) => components.find((instrument) => instrument.form.id === 'token' && instrument.bound.of === kind);
  const reads = (instrument: Instrument, field: string, of: string | undefined) => {
    const source = String(instrument.bound.doc.cards ?? instrument.bound.doc.count ?? '').trim();
    return instrument.bound.of === of && source === (of === undefined ? `game.${field}` : `self.${field}`);
  };

  return {
    id, registry, scenario, container, components, outcome: doc?.outcome, sections, sentences, issues, frame,
    layout(state, map) {
      const at = frame(state, map);
      return (container ? [container, ...components] : components).map((instrument) => ({ instrument, items: instrument.form.layout(instrument.bound, at) }));
    },
    inlineEntity(entity, state) {
      const kind = state.entities[entity]?.kind;
      const token = kind === undefined ? undefined : tokenOf(kind);
      return token?.form.inline(token.bound, frame(state), { entity }) ?? { class: 'i-id', children: [entity] };
    },
    inlineValue(at, value, state) {
      const instrument = components.find((candidate) => ('global' in at ? reads(candidate, at.global, undefined) : reads(candidate, at.field, at.kind)));
      return instrument?.form.inline(instrument.bound, frame(state), { value, entity: 'entity' in at ? at.entity : undefined }) ?? null;
    },
  };
}

/** The key batches are split by: the file's, else `winner` when outcomes have one, otherwise `result`. */
export const outcomeKey = (presentation: Pick<Presentation, 'outcome'> | undefined, outcomes: Record<string, Value>[]): string =>
  presentation?.outcome ?? (outcomes.some((outcome) => 'winner' in outcome) ? 'winner' : 'result');
