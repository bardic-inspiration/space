// The project folder (spec 4): base files as core lays them out, and the
// studio's folder beside them. A project is read whole into memory when it
// opens; reads are then synchronous, and a write goes to memory and to the
// folder. Nothing outside `studio/` is ever written (S6).

import { LineCounter, isMap, isScalar, isSeq, parse, parseDocument, type Document, type Node } from 'yaml';
import { CORE_COMMIT } from '../core.ts';
import type { RunInput } from '../engine/input.ts';
import type { Issue } from '../engine/protocol.ts';
import { guard, type ProjectFiles } from './files.ts';
import { STUDIO_FORMAT, checkDoc, type StudioDoc } from './schemas.ts';

/** An issue placed in a file: what the editor and the errors list show. */
export interface FileIssue {
  file: string;
  /** 1-based. */
  line?: number;
  path: string;
  message: string;
}

export interface VariantDoc {
  format: number;
  variant: { id: string; title?: string; notes?: string };
  ruleset: string;
  scenario: string;
  extensions?: string[];
  behaviors?: string[];
  bind?: Record<string, string>;
  map?: string;
  limits?: { maxDecisions?: number };
  seeds?: { from: number; to: number };
}

export interface VariantInfo {
  id: string;
  title: string;
  ruleset: string;
  scenario: string;
  /** True for the implicit variant of a scenario: the scenario as written, with the default behaviors. */
  base: boolean;
  doc: VariantDoc;
}

/** Which file each part of an input was read from. */
export interface Sources {
  kit: string;
  ruleset: string;
  extensions: string[];
  behaviors: string[];
  scenario: string;
  maps: Record<string, string>;
  /** The variant's own file; absent for a base variant. */
  variant?: string;
}

export interface Resolved {
  variant: VariantInfo;
  input: RunInput;
  sources: Sources;
  /** What kept the input from being read at all: a missing file, YAML that does not parse. */
  issues: FileIssue[];
}

/** The id of a scenario's base variant. */
export const baseId = (scenario: string): string => `@${scenario}`;
const idOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.yaml$/, '');

export class Project {
  readonly files: ProjectFiles;
  private readonly texts = new Map<string, string>();
  private readonly parsed = new Map<string, { text: string; doc: unknown; error?: FileIssue }>();
  private pending: Promise<void> = Promise.resolve();
  /** Bumped on every write, so views know to look again. */
  revision = 0;
  /** The core commit the project was last used with, when it differs from this build's. */
  staleCore?: string;

  private constructor(files: ProjectFiles) {
    this.files = files;
  }

  static async open(files: ProjectFiles): Promise<Project> {
    const project = new Project(files);
    const paths = (await files.list(['kit', 'rulesets', 'studio'])).filter((path) => /\.(yaml|jsonl)$/.test(path));
    await Promise.all(paths.map(async (path) => {
      const text = await files.read(path);
      if (text !== undefined) project.texts.set(path, text);
    }));
    if (project.rulesets().length === 0) throw new Error('this folder has no rulesets/<id>/ruleset.yaml: it is not a project');
    const meta = project.doc<{ core?: string }>('studio/project.yaml');
    if (meta?.core && meta.core !== CORE_COMMIT) project.staleCore = meta.core;
    return project;
  }

  get name(): string {
    return this.files.name;
  }

  /** Notes the core commit in use. Called before the first write of a session, not on open: opening changes nothing. */
  private stamp(): void {
    const path = 'studio/project.yaml';
    const meta = this.doc<{ title?: string; core?: string }>(path);
    if (meta?.core === CORE_COMMIT) return;
    this.put(path, `format: ${STUDIO_FORMAT}\ntitle: ${JSON.stringify(meta?.title ?? this.name)}\ncore: ${CORE_COMMIT}\n`);
  }

  // ── Files ───────────────────────────────────────────────────────────────

  text(path: string): string | undefined {
    return this.texts.get(path);
  }

  has(path: string): boolean {
    return this.texts.has(path);
  }

  /** Every held path under a folder. */
  under(folder: string): string[] {
    const prefix = folder.endsWith('/') ? folder : `${folder}/`;
    return [...this.texts.keys()].filter((path) => path.startsWith(prefix)).sort();
  }

  private put(path: string, text: string): void {
    guard(path);
    this.texts.set(path, text);
    this.revision += 1;
    this.pending = this.pending.then(() => this.files.write(path, text)).catch((error) => console.error(error));
  }

  write(path: string, text: string): void {
    guard(path);
    if (path !== 'studio/project.yaml') this.stamp();
    this.put(path, text);
  }

  remove(path: string): void {
    guard(path);
    for (const held of [...this.texts.keys()]) if (held === path || held.startsWith(`${path}/`)) this.texts.delete(held);
    this.revision += 1;
    this.pending = this.pending.then(() => this.files.remove(path)).catch((error) => console.error(error));
  }

  /** Resolves once every write so far has reached the folder. */
  saved(): Promise<void> {
    return this.pending;
  }

  /** A file parsed as YAML. A file that does not parse is `undefined`, and `parseIssue` says why. */
  doc<T = unknown>(path: string): T | undefined {
    const text = this.texts.get(path);
    if (text === undefined) return undefined;
    let held = this.parsed.get(path);
    if (!held || held.text !== text) {
      held = { text, doc: undefined };
      try {
        held.doc = parse(text);
      } catch (error) {
        const found = error as { message: string; linePos?: { line: number }[] };
        held.error = { file: path, line: found.linePos?.[0]?.line, path: '', message: found.message.split('\n')[0] };
      }
      this.parsed.set(path, held);
    }
    return held.doc as T | undefined;
  }

  parseIssue(path: string): FileIssue | undefined {
    this.doc(path);
    return this.parsed.get(path)?.error;
  }

  /** A studio document, schema-checked. */
  studioDoc<T>(kind: StudioDoc, path: string): { doc?: T; issues: FileIssue[] } {
    if (!this.has(path)) return { issues: [] };
    const doc = this.doc<T>(path);
    const broken = this.parseIssue(path);
    if (broken) return { issues: [broken] };
    const issues = checkDoc(kind, doc).map((issue) => this.place(path, issue.path.split('.').slice(1), issue));
    return issues.length > 0 ? { issues } : { doc, issues };
  }

  // ── The layout ──────────────────────────────────────────────────────────

  rulesets(): string[] {
    return [...this.texts.keys()].flatMap((path) => /^rulesets\/([^/]+)\/ruleset\.yaml$/.exec(path)?.[1] ?? []).sort();
  }

  rulesetTitle(ruleset: string): string {
    return this.doc<{ ruleset?: { title?: string } }>(`rulesets/${ruleset}/ruleset.yaml`)?.ruleset?.title ?? ruleset;
  }

  variantDir(ruleset: string, variant: string): string {
    return `studio/variants/${ruleset}/${variant}`;
  }

  /** The file that stands for `rel` (a path under the ruleset's folder) in a variant: its shadow when it has one (S7). */
  effective(ruleset: string, variant: string | undefined, rel: string): string {
    const shadow = variant && !variant.startsWith('@') ? `${this.variantDir(ruleset, variant)}/files/${rel}` : undefined;
    return shadow && this.has(shadow) ? shadow : `rulesets/${ruleset}/${rel}`;
  }

  /** The ids of the documents in one of a ruleset's folders, as a variant sees them: the base's and its own. */
  ids(ruleset: string, variant: string | undefined, folder: 'extensions' | 'behaviors' | 'maps' | 'scenarios'): string[] {
    const own = variant && !variant.startsWith('@') ? this.under(`${this.variantDir(ruleset, variant)}/files/${folder}`) : [];
    return [...new Set([...this.under(`rulesets/${ruleset}/${folder}`), ...own].filter((path) => path.endsWith('.yaml')).map(idOf))].sort();
  }

  /** Every document a variant is made of, as paths under the ruleset's folder. */
  documents(ruleset: string, variant: string | undefined): string[] {
    const folders = ['extensions', 'behaviors', 'maps', 'scenarios'] as const;
    return ['ruleset.yaml', ...folders.flatMap((folder) => this.ids(ruleset, variant, folder).map((id) => `${folder}/${id}.yaml`))];
  }

  variants(ruleset: string): VariantInfo[] {
    const bases = this.ids(ruleset, undefined, 'scenarios').map((scenario): VariantInfo => {
      const title = this.doc<{ scenario?: { title?: string } }>(`rulesets/${ruleset}/scenarios/${scenario}.yaml`)?.scenario?.title ?? scenario;
      return { id: baseId(scenario), title, ruleset, scenario, base: true, doc: { format: STUDIO_FORMAT, variant: { id: baseId(scenario) }, ruleset, scenario } };
    });
    const own = this.under(`studio/variants/${ruleset}`).filter((path) => path.endsWith('/variant.yaml')).flatMap((path): VariantInfo[] => {
      const { doc } = this.studioDoc<VariantDoc>('variant', path);
      const folder = path.split('/')[3];
      return doc && doc.ruleset === ruleset ? [{ id: folder, title: doc.variant.title ?? folder, ruleset, scenario: doc.scenario, base: false, doc }] : [];
    });
    return [...bases, ...own];
  }

  variant(ruleset: string, id: string): VariantInfo | undefined {
    return this.variants(ruleset).find((variant) => variant.id === id);
  }

  /** The issues of a variant's own file: YAML that does not parse, or a key the format does not have. */
  variantIssues(ruleset: string, id: string): FileIssue[] {
    return id.startsWith('@') ? [] : this.studioDoc('variant', `${this.variantDir(ruleset, id)}/variant.yaml`).issues;
  }

  // ── From a variant to a run (spec 4.2) ──────────────────────────────────

  resolve(ruleset: string, id: string): Resolved | undefined {
    const variant = this.variant(ruleset, id);
    if (!variant) return undefined;
    const issues: FileIssue[] = [...this.variantIssues(ruleset, id)];
    const variantFile = variant.base ? undefined : `${this.variantDir(ruleset, id)}/variant.yaml`;
    const read = (rel: string, what: string): { path: string; doc: unknown } => {
      const path = rel === 'kit' ? 'kit/patterns.yaml' : this.effective(ruleset, id, rel);
      if (!this.has(path)) issues.push({ file: variantFile ?? path, path: '', message: `${what} is missing: there is no ${path}` });
      const broken = this.parseIssue(path);
      if (broken) issues.push(broken);
      return { path, doc: this.doc(path) };
    };
    const doc = variant.doc;
    const kit = read('kit', 'the pattern kit');
    const rules = read('ruleset.yaml', 'the ruleset');
    const extensions = (doc.extensions ?? []).map((extension) => read(`extensions/${extension}.yaml`, `the extension "${extension}"`));
    const behaviors = (doc.behaviors ?? ['default']).map((set) => read(`behaviors/${set}.yaml`, `the behavior set "${set}"`));
    const scenarioFile = read(`scenarios/${doc.scenario}.yaml`, `the scenario "${doc.scenario}"`);
    const maps: Record<string, unknown> = {};
    const mapFiles: Record<string, string> = {};
    for (const mapId of this.ids(ruleset, id, 'maps')) {
      const file = read(`maps/${mapId}.yaml`, `the map "${mapId}"`);
      const named = (file.doc as { map?: { id?: string } } | undefined)?.map?.id ?? mapId;
      maps[named] = file.doc;
      mapFiles[named] = file.path;
    }
    // The variant's map and limits are laid on the scenario before it is loaded.
    let scenario = scenarioFile.doc;
    if (scenario && typeof scenario === 'object' && (doc.map !== undefined || doc.limits)) {
      const { space, ...rest } = scenario as Record<string, unknown>;
      scenario = {
        ...(doc.map === undefined ? { ...rest, ...(space === undefined ? {} : { space }) } : { ...rest, map: doc.map }),
        ...(doc.limits ? { limits: { ...(rest.limits as object | undefined), ...doc.limits } } : {}),
      };
    }
    return {
      variant,
      input: {
        kit: kit.doc, ruleset: rules.doc, extensions: extensions.map((file) => file.doc), behaviors: behaviors.map((file) => file.doc),
        scenario, maps, bind: { ...doc.bind },
      },
      sources: {
        kit: kit.path, ruleset: rules.path, extensions: extensions.map((file) => file.path), behaviors: behaviors.map((file) => file.path),
        scenario: scenarioFile.path, maps: mapFiles, variant: variantFile,
      },
      issues,
    };
  }

  // ── Errors (spec 4.3) ───────────────────────────────────────────────────

  /** An issue against a path inside one file, with the line of the YAML node it names. */
  place(file: string, segments: string[], issue: Issue): FileIssue {
    const text = this.texts.get(file);
    if (text === undefined) return { file, path: issue.path, message: issue.message };
    return { file, line: lineOf(text, segments), path: issue.path, message: issue.message };
  }

  /** Maps each of core's issue paths to a file and a line: `scenario.entities.3.fields.pos` to the scenario's file, and so on. */
  locate(resolved: Resolved, found: Issue[]): FileIssue[] {
    const { sources, variant } = resolved;
    return found.map((issue) => {
      const [head, ...rest] = issue.path.split('.');
      switch (head) {
        case 'kit': return this.place(sources.kit, rest, issue);
        case 'ruleset': return this.place(sources.ruleset, rest, issue);
        case 'extensions': return this.place(sources.extensions[Number(rest[0])] ?? sources.ruleset, rest.slice(1), issue);
        case 'behaviors': {
          // Structure is refused by set (`behaviors.0...`); a score or goal by name, and the last set that wrote it is the one to show.
          if (/^\d+$/.test(rest[0] ?? '')) return this.place(sources.behaviors[Number(rest[0])] ?? sources.ruleset, rest.slice(1), issue);
          const path = ['behaviors', ...rest];
          const wrote = [...sources.behaviors].reverse().find((file) => hasNode(this.texts.get(file) ?? '', path))
            ?? [...sources.behaviors].reverse().find((file) => hasNode(this.texts.get(file) ?? '', path.slice(0, 2)));
          return this.place(wrote ?? sources.behaviors[0] ?? sources.ruleset, path, issue);
        }
        case 'scenario': {
          if (rest[0] === 'map' && variant.doc.map !== undefined && sources.variant) return this.place(sources.variant, ['map'], issue);
          // A failed kind check names the entity by id, not by its place in the list.
          if (rest[0] === 'entities' && rest[1] !== undefined && !/^\d+$/.test(rest[1])) {
            const entities = (this.doc<{ entities?: { id?: string }[] }>(sources.scenario)?.entities ?? []);
            const index = entities.findIndex((entity) => entity.id === rest.slice(1).join('.'));
            return this.place(sources.scenario, index < 0 ? ['entities'] : ['entities', String(index)], issue);
          }
          return this.place(sources.scenario, rest, issue);
        }
        case 'map': {
          const named = variant.doc.map ?? (resolved.input.scenario as { map?: string } | undefined)?.map
            ?? (resolved.input.ruleset as { space?: { map?: { standard?: string } } } | undefined)?.space?.map?.standard;
          const file = named === undefined ? undefined : sources.maps[named];
          return file ? this.place(file, rest, issue) : this.place(sources.scenario, ['map'], issue);
        }
        case 'bind':
          return sources.variant ? this.place(sources.variant, ['bind', ...rest], issue) : this.place(sources.scenario, ['seats', ...rest], issue);
        default: return { file: sources.variant ?? sources.scenario, path: issue.path, message: issue.message };
      }
    });
  }

  // ── Variants (spec 4.1, 11) ─────────────────────────────────────────────

  createVariant(ruleset: string, id: string, from: VariantInfo, title?: string): VariantInfo {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('a variant id is letters, digits, - and _');
    if (this.has(`${this.variantDir(ruleset, id)}/variant.yaml`)) throw new Error(`there is already a variant "${id}"`);
    if (!from.base) {
      const source = `${this.variantDir(ruleset, from.id)}/files/`;
      for (const path of this.under(source)) this.write(`${this.variantDir(ruleset, id)}/files/${path.slice(source.length)}`, this.texts.get(path)!);
    }
    const { variant: _was, format: _format, ...rest } = from.doc;
    this.writeVariant(ruleset, id, { format: STUDIO_FORMAT, variant: { id, ...(title ? { title } : {}) }, ...rest });
    return this.variant(ruleset, id)!;
  }

  /** Rewrites a variant's file, keeping its comments. */
  writeVariant(ruleset: string, id: string, doc: VariantDoc): void {
    const path = `${this.variantDir(ruleset, id)}/variant.yaml`;
    this.write(path, rewrite(this.texts.get(path), doc as unknown as Record<string, unknown>));
  }

  renameVariant(ruleset: string, id: string, to: string): void {
    const from = this.variant(ruleset, id);
    if (!from || from.base) throw new Error('only a saved variant can be renamed');
    this.createVariant(ruleset, to, from, from.doc.variant.title);
    this.deleteVariant(ruleset, id);
  }

  deleteVariant(ruleset: string, id: string): void {
    if (id.startsWith('@')) throw new Error('a base variant cannot be deleted');
    this.remove(this.variantDir(ruleset, id));
  }

  /** The shadowed files of a variant, as paths under the ruleset's folder. */
  shadows(ruleset: string, id: string): string[] {
    const prefix = `${this.variantDir(ruleset, id)}/files/`;
    return id.startsWith('@') ? [] : this.under(prefix).map((path) => path.slice(prefix.length));
  }

  /** Writes a document of the variant: a shadow of the base file at the same path, or a file the base does not have. */
  writeShadow(ruleset: string, id: string, rel: string, text: string): void {
    if (id.startsWith('@')) throw new Error('a base variant is read-only: make a variant first');
    this.write(`${this.variantDir(ruleset, id)}/files/${rel}`, text);
  }
}

// ── YAML nodes ────────────────────────────────────────────────────────────

/** The deepest node a dotted path reaches. A key may itself hold dots (`turn.start`), so the longest key that matches wins. */
function walk(doc: Document, segments: string[]): { node: Node | null; reached: number } {
  let node = doc.contents as Node | null;
  let last = node;
  let i = 0;
  while (i < segments.length && node) {
    if (isMap(node)) {
      let next: { key: Node; value: Node | null; used: number } | undefined;
      for (let j = segments.length; j > i && !next; j--) {
        const key = segments.slice(i, j).join('.');
        const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === key);
        if (pair) next = { key: pair.key as Node, value: pair.value as Node | null, used: j };
      }
      if (!next) break;
      last = next.key;
      node = next.value;
      i = next.used;
    } else if (isSeq(node) && /^\d+$/.test(segments[i]) && node.items[Number(segments[i])]) {
      node = node.items[Number(segments[i])] as Node;
      last = node;
      i += 1;
    } else break;
  }
  return { node: last, reached: i };
}

/** The 1-based line of the node a dotted path names, or of the deepest part of it the text has. */
export function lineOf(text: string, segments: string[]): number | undefined {
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  const { node } = walk(doc, segments);
  return node?.range ? counter.linePos(node.range[0]).line : undefined;
}

export function hasNode(text: string, segments: string[]): boolean {
  if (!text) return false;
  return walk(parseDocument(text), segments).reached === segments.length;
}

/** A document's text with its top-level keys set to `values`; keys absent from `values` are dropped. Comments are kept. */
export function rewrite(text: string | undefined, values: Record<string, unknown>): string {
  const doc = parseDocument(text ?? '{}');
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  const map = doc.contents as unknown as { items: { key: unknown }[] };
  for (const item of [...map.items]) {
    const key = isScalar(item.key) ? String(item.key.value) : '';
    if (!(key in values) || values[key] === undefined) doc.delete(key);
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && JSON.stringify(doc.get(key, false) && (doc.toJS() as Record<string, unknown>)[key]) !== JSON.stringify(value)) doc.set(key, value);
  }
  return doc.toString({ lineWidth: 110, flowCollectionPadding: true });
}

/** A line-by-line difference of two texts: the lines of each, marked kept, removed or added. */
export function diffLines(before: string, after: string): { op: ' ' | '-' | '+'; line: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const longest = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) longest[i][j] = a[i] === b[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1]);
  }
  const out: { op: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push({ op: ' ', line: a[i++] }), j++;
    else if (j < b.length && (i >= a.length || longest[i][j + 1] >= longest[i + 1][j])) out.push({ op: '+', line: b[j++] });
    else out.push({ op: '-', line: a[i++] });
  }
  return out;
}
