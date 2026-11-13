// The store (S1): one module, no state library. It holds the open project,
// the variant in hand and its last good compile, the match being watched (a
// log, a cursor and a selection), and what Analyze and Build are working on.
// Panels read it with `useStudio` and change it through its methods.

import { useSyncExternalStore } from 'react';
import { parse } from 'yaml';
import {
  listBatches, metricsHash, metricsPath, missingSeeds, seedsOf, staleness, writeBatch, type Batch, type Stale,
} from '../analyze/batches.ts';
import { compileMetrics, type BatchRecord, type CompiledMetrics, type MetricsDoc } from '../analyze/metrics.ts';
import type { BoardPointer, Mark } from '../board/board.ts';
import { CORE_COMMIT, CompileError, apply, emptyState, type GameEvent, type HostCall, type MatchRecord, type SpaceMap, type State } from '../core.ts';
import { BatchPool, Cancelled, InputErrors, SessionClient, type BatchHandle, type Run } from '../engine/client.ts';
import { compileInput, variantHash, type Compiled } from '../engine/input.ts';
import type { DecisionInfo, ForkSteps } from '../engine/session.ts';
import { StateCache, decisionsOf } from '../log/cursor.ts';
import { buildTree, type LogTree } from '../log/tree.ts';
import { bindPresentation, type Presentation } from '../present/presentation.ts';
import { sentenceOf, titleOf } from '../present/sentences.ts';
import type { InlineNode, PresentationDoc } from '../present/types.ts';
import { exampleFiles } from '../project/examples.ts';
import { FolderFiles, type ProjectFiles } from '../project/files.ts';
import { chainOf, listForks, regenerate, saveFork, toSteps, type ForkDoc } from '../project/forks.ts';
import { Project, type FileIssue, type Resolved, type VariantDoc } from '../project/project.ts';

export type Mode = 'build' | 'run' | 'analyze';

/** A match being watched: a finished log, and what is derived from it once. */
export interface Watched {
  hash: string;
  seed: string;
  log: GameEvent[];
  record: MatchRecord;
  cache: StateCache;
  tree: LogTree;
  /** The `seq` of every decision. */
  decisions: number[];
  /** The bindings in force, when a fork changed them. */
  binds: Record<string, string>;
  /** The fork this log is, when it is one. */
  fork?: { id?: string; at: number; steps: ForkSteps; parent?: string | null };
  /** Each row's sentence, made when first shown. */
  sentences: Map<number, InlineNode[]>;
  compiled: Compiled;
  presentation: Presentation;
}

export interface BatchProgress {
  variant: string;
  done: number;
  total: number;
  startedAt: number;
}

export interface StudioState {
  project: Project | null;
  opening: boolean;
  error: string | null;
  notice: string | null;
  theme: 'light' | 'dark';
  mode: Mode;
  ruleset: string;
  variant: string;
  /** The presentation file in use: an id under `studio/presentation/<ruleset>/`, or `none` for the defaults. */
  look: string;
  seed: string;
  resolved: Resolved | null;
  hash: string | null;
  /** The last good compile: it stays on the board while a variant has errors. */
  compiled: Compiled | null;
  presentation: Presentation | null;
  issues: FileIssue[];
  metrics: CompiledMetrics | null;
  metricsHash: string;
  // Run
  match: Watched | null;
  /** A fork open beside its parent. */
  branch: Watched | null;
  /** Which of the two the log and the inspector follow. */
  focus: 'match' | 'branch';
  cursor: number;
  playing: boolean;
  speed: number;
  /** True when the last cursor move was one event of playback: the board animates it. */
  animate: boolean;
  running: boolean;
  selection: { entity?: string; cell?: { x: number; y: number } } | null;
  decision: { seq: number; info: DecisionInfo | null; error?: string } | null;
  overlay: HostCall[] | null;
  /** A fork being put together at the decision the cursor stands at. */
  draft: ForkSteps;
  refereeTool: { layer: string; value: unknown } | null;
  tilt: boolean;
  /** A map being edited, drawn in place of the compiled one: work in progress shows even when it fails a check. */
  preview: SpaceMap | null;
  marks: Mark[];
  hiddenLayers: string[];
  hover: string | null;
  // Analyze
  batches: Batch[];
  progress: BatchProgress | null;
  selectedBatches: string[];
  heat: { metric: string } | null;
  // Build
  revision: number;
}

type Listener = () => void;

const initial: StudioState = {
  project: null, opening: true, error: null, notice: null, theme: 'light', mode: 'run', ruleset: '', variant: '', look: 'default', seed: '1',
  resolved: null, hash: null, compiled: null, presentation: null, issues: [], metrics: null, metricsHash: '',
  match: null, branch: null, focus: 'match', cursor: 0, playing: false, speed: 8, animate: false, running: false, selection: null, decision: null, overlay: null,
  draft: {}, refereeTool: null, tilt: false, preview: null, marks: [], hiddenLayers: [], hover: null,
  batches: [], progress: null, selectedBatches: [], heat: null, revision: 0,
};

export class Studio {
  state: StudioState = initial;
  private readonly listeners = new Set<Listener>();
  private session: SessionClient | null = null;
  private pool: BatchPool | null = null;
  private batch: BatchHandle | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private compileTimer: ReturnType<typeof setTimeout> | null = null;
  private asked = 0;
  private compiles = 0;
  /** A tool that takes the board's pointer: the map editor's brush, entity placement. */
  tool: ((event: BoardPointer) => boolean) | null = null;
  private readonly compiledByHash = new Map<string, { compiled: Compiled; presentation: Presentation; start: State }>();
  /** Undo and redo, per document. */
  private readonly history = new Map<string, { undo: (string | undefined)[]; redo: (string | undefined)[] }>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<StudioState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private get sessionClient(): SessionClient {
    return (this.session ??= new SessionClient());
  }

  get batchPool(): BatchPool {
    return (this.pool ??= new BatchPool());
  }

  /** The match the log and the inspector follow. */
  get watched(): Watched | null {
    return this.state.focus === 'branch' && this.state.branch ? this.state.branch : this.state.match;
  }

  // ── Opening a project ───────────────────────────────────────────────────

  async open(files: ProjectFiles): Promise<void> {
    this.pause();
    this.set({ opening: true, error: null });
    try {
      const project = await Project.open(files);
      const ruleset = project.rulesets().includes(this.state.ruleset) ? this.state.ruleset : project.rulesets()[0];
      this.history.clear();
      this.set({
        ...initial, theme: this.state.theme, mode: this.state.mode, project, opening: false, ruleset, variant: project.variants(ruleset)[0]?.id ?? '',
        notice: project.staleCore ? `This project was last used with core ${project.staleCore.slice(0, 7)}; this studio runs ${CORE_COMMIT.slice(0, 7)}. Its batches are stale.` : null,
      });
      await this.recompile(true);
    } catch (error) {
      this.set({ opening: false, error: (error as Error).message });
    }
  }

  openExamples(): Promise<void> {
    return this.open(exampleFiles());
  }

  /** Asks for a folder with the File System Access API (S4). */
  async openFolder(): Promise<void> {
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) return this.set({ error: 'This browser cannot open a folder. The studio needs desktop Chromium for that; the examples open in memory and cannot be saved.' });
    try {
      await this.open(new FolderFiles(await picker({ mode: 'readwrite' })));
    } catch (error) {
      if ((error as Error).name !== 'AbortError') this.set({ error: (error as Error).message });
    }
  }

  get canOpenFolder(): boolean {
    return 'showDirectoryPicker' in window;
  }

  // ── The variant in hand ─────────────────────────────────────────────────

  select(ruleset: string, variant?: string): Promise<void> {
    const project = this.state.project!;
    const id = variant ?? project.variants(ruleset)[0]?.id ?? '';
    this.pause();
    this.set({
      ruleset, variant: id, match: null, branch: null, focus: 'match', cursor: 0, selection: null, decision: null, overlay: null, draft: {}, refereeTool: null,
      ...(ruleset === this.state.ruleset ? {} : { compiled: null, presentation: null, look: 'default', hiddenLayers: [], selectedBatches: [], heat: null }),
    });
    return this.recompile(true);
  }

  setLook(look: string): void {
    this.set({ look });
    this.rebind();
  }

  /** The presentation files of the ruleset in hand. */
  looks(): string[] {
    const { project, ruleset } = this.state;
    return project ? project.under(`studio/presentation/${ruleset}`).map((path) => path.slice(path.lastIndexOf('/') + 1, -'.yaml'.length)) : [];
  }

  presentationPath(look = this.state.look): string {
    return `studio/presentation/${this.state.ruleset}/${look}.yaml`;
  }

  /** Compiles the variant in hand on the page, and plays its seed when it is sound and differs from what is on the board. */
  async recompile(play = false): Promise<void> {
    const { project, ruleset, variant } = this.state;
    if (!project) return;
    const turn = ++this.compiles;
    const resolved = project.resolve(ruleset, variant) ?? null;
    if (!resolved) return this.set({ resolved: null, issues: [{ file: '', path: '', message: `there is no variant "${variant}"` }], revision: project.revision });
    const issues: FileIssue[] = [...resolved.issues];
    let compiled: Compiled | null = null;
    let hash: string | null = null;
    if (issues.length === 0) {
      hash = await variantHash(resolved.input);
      if (turn !== this.compiles) return;
      try {
        compiled = compileInput(resolved.input);
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        issues.push(...project.locate(resolved, error.issues));
      }
    }
    const metricsDoc = this.metricsDoc();
    const digest = await metricsHash(metricsDoc.doc ?? null);
    if (turn !== this.compiles) return;
    issues.push(...metricsDoc.issues);
    const good = compiled ?? this.state.compiled;
    const metrics = good ? compileMetrics(good, metricsDoc.doc ?? null) : null;
    if (metrics) issues.push(...metrics.issues.map((issue) => project.place(metricsPath(ruleset), issue.path.split('.'), issue)));
    this.set({
      resolved, hash: compiled ? hash : null, compiled: good, issues, metrics, metricsHash: digest, revision: project.revision,
      batches: listBatches(project, ruleset),
    });
    this.rebind();
    const changed = compiled && (this.state.match?.hash !== hash || this.state.match.seed !== this.state.seed);
    if (compiled && (play || changed)) await this.play();
  }

  /** Compiles again a little after the last edit: 300 ms after typing stops. */
  recompileSoon(): void {
    if (this.compileTimer) clearTimeout(this.compileTimer);
    this.compileTimer = setTimeout(() => void this.recompile(), 300);
  }

  private metricsDoc(): { doc?: MetricsDoc; issues: FileIssue[] } {
    const { project, ruleset } = this.state;
    return project!.studioDoc<MetricsDoc>('metrics', metricsPath(ruleset));
  }

  /** Binds the presentation file in use to the last good compile. Its refusals join the issues; nothing of it reaches a run. */
  private rebind(): void {
    const { project, compiled, look } = this.state;
    if (!project || !compiled) return;
    const path = this.presentationPath();
    const file = look === 'none' ? { issues: [] as FileIssue[] } : project.studioDoc<PresentationDoc>('presentation', path);
    const presentation = bindPresentation(file.doc, compiled, file.doc ? look : 'default');
    const issues = [
      ...this.state.issues.filter((issue) => !issue.file.startsWith('studio/presentation/')), ...file.issues,
      ...presentation.issues.map((issue) => project.place(path, issue.path.split('.'), issue)),
    ];
    // A match of the variant as it now resolves is shown under the new binding; any other stays as it was played.
    const reopen = (watched: Watched | null) => (watched && watched.hash === this.state.hash ? this.watch(watched.log, watched.record, watched, compiled, presentation) : watched);
    this.set({ presentation, issues, match: reopen(this.state.match), branch: reopen(this.state.branch) });
  }

  get run(): Run | null {
    const { resolved, hash } = this.state;
    return resolved && hash ? { hash, input: resolved.input } : null;
  }

  // ── Run ─────────────────────────────────────────────────────────────────

  private watch(log: GameEvent[], record: MatchRecord, from: Pick<Watched, 'hash' | 'seed' | 'binds' | 'fork'>, compiled = this.state.compiled!, presentation = this.state.presentation!): Watched {
    const cache = new StateCache(log);
    const stateAt = (count: number) => cache.at(count);
    const openers = presentation.sections.map((section) => ({
      on: section.on, title: (entry: GameEvent) => titleOf(section.title, entry, { registry: compiled.registry, presentation, stateAt }),
    }));
    return {
      hash: from.hash, seed: from.seed, binds: from.binds, fork: from.fork, log, record, cache, compiled, presentation,
      tree: buildTree(log, 1 + compiled.scenario.setup.length, openers), decisions: decisionsOf(log), sentences: new Map(),
    };
  }

  /** A row's sentence, made once. */
  sentence(watched: Watched, entry: GameEvent): InlineNode[] {
    let nodes = watched.sentences.get(entry.seq);
    if (!nodes) {
      try {
        nodes = sentenceOf(entry, { registry: watched.compiled.registry, presentation: watched.presentation, tree: watched.tree, stateAt: (count) => watched.cache.at(count) });
      } catch (error) {
        nodes = [`${entry.t} (${(error as Error).message})`];
      }
      watched.sentences.set(entry.seq, nodes);
    }
    return nodes;
  }

  /** Plays the seed to its end in the session worker (S5), then stands at the start of play. */
  async play(seed = this.state.seed, expect?: { logHash: string; variant?: string }): Promise<void> {
    const run = this.run;
    if (!run || !this.state.compiled) return;
    this.pause();
    this.set({ seed: String(seed), running: true, error: null });
    try {
      const { log, record } = await this.sessionClient.play(run, seed);
      const match = this.watch(log, record, { hash: run.hash, seed: String(seed), binds: {} });
      // A match opened from a batch record regenerates its log; when it differs, say what changed since.
      let notice = this.state.notice;
      if (expect && expect.logHash !== record.logHash) {
        notice = `Seed ${seed} no longer plays as its record says (${expect.logHash} then, ${record.logHash} now): ${expect.variant && expect.variant !== run.hash ? 'the variant has changed since' : 'the core commit has changed since'}.`;
      } else if (expect) notice = `Seed ${seed} regenerated to its record's logHash, ${record.logHash}.`;
      this.set({ match, branch: null, focus: 'match', running: false, cursor: Math.min(log.length, 1 + match.compiled.scenario.setup.length), selection: null, decision: null, overlay: null, draft: {}, notice });
      this.atCursor();
    } catch (error) {
      if (error instanceof Cancelled) return;
      // A throw from the rules is shown in Run, not swallowed.
      if (error instanceof InputErrors) this.set({ running: false, issues: this.state.project!.locate(this.state.resolved!, error.issues) });
      else this.set({ running: false, error: (error as Error).message });
    }
  }

  setCursor(cursor: number, animate = false): void {
    const watched = this.watched;
    if (!watched) return;
    const next = Math.max(0, Math.min(watched.log.length, Math.round(cursor)));
    if (next === this.state.cursor && !animate) return;
    this.set({ cursor: next, animate, overlay: null });
    this.atCursor();
  }

  /** The state at a cursor of a watched match. */
  stateOf(watched: Watched, cursor: number): State {
    return watched.cache.at(cursor);
  }

  /** Where the other board's cursor stands: the same decision index, counted from the fork point. */
  partnerCursor(): number {
    const { match, branch, focus, cursor } = this.state;
    if (!match || !branch) return cursor;
    const [from, to] = focus === 'branch' ? [branch, match] : [match, branch];
    const at = branch.fork!.at;
    if (cursor <= at) return cursor;
    const index = from.decisions.filter((seq) => seq < cursor).length;
    return index >= to.decisions.length ? to.log.length : cursor >= from.log.length ? to.log.length : to.decisions[index];
  }

  step(by: number): void {
    this.pause();
    this.setCursor(this.state.cursor + by);
  }

  /** Steps to just before the next or the previous decision: the board shows what the seat saw. */
  stepDecision(direction: 1 | -1): void {
    const watched = this.watched;
    if (!watched) return;
    this.pause();
    const { cursor } = this.state;
    const next = direction > 0 ? watched.decisions.find((seq) => seq > cursor) : [...watched.decisions].reverse().find((seq) => seq < cursor);
    this.setCursor(next ?? (direction > 0 ? watched.log.length : 0));
  }

  toggle(): void {
    if (this.state.playing) return this.pause();
    const watched = this.watched;
    if (!watched) return;
    if (this.state.cursor >= watched.log.length) this.set({ cursor: 1 + watched.compiled.scenario.setup.length });
    this.set({ playing: true });
    this.tick();
  }

  pause(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.state.playing) this.set({ playing: false });
  }

  private tick(): void {
    const watched = this.watched;
    if (!this.state.playing || !watched) return;
    if (this.state.cursor >= watched.log.length) return this.pause();
    const interval = 1000 / this.state.speed;
    // Playback pauses a moment at each decision.
    const atDecision = watched.decisions.includes(this.state.cursor);
    this.timer = setTimeout(() => {
      this.setCursor(this.state.cursor + 1, true);
      this.tick();
    }, atDecision ? Math.max(interval * 3, 220) : interval);
  }

  /** When the cursor stands at a decision, asks the session worker what the seat saw. */
  private atCursor(): void {
    const watched = this.watched;
    const { cursor } = this.state;
    const entry = watched?.log[cursor];
    if (!watched || !entry || entry.t !== 'intent' || entry.of === undefined) {
      if (this.state.decision) this.set({ decision: null, draft: {}, refereeTool: null });
      return;
    }
    if (this.state.decision?.seq === cursor && this.state.decision.info) return;
    this.set({ decision: { seq: cursor, info: null }, draft: {}, refereeTool: null });
    if (this.state.playing) return;
    const ask = ++this.asked;
    const run = this.run;
    if (!run || run.hash !== watched.hash) return;
    setTimeout(() => {
      if (ask !== this.asked) return;
      this.sessionClient.decision(run, watched.log, watched.record.logHash, cursor, watched.binds).then((info) => {
        if (ask === this.asked && this.state.cursor === cursor) this.set({ decision: { seq: cursor, info } });
      }).catch((error) => {
        if (ask === this.asked && !(error instanceof Cancelled)) this.set({ decision: { seq: cursor, info: null, error: (error as Error).message } });
      });
    }, 60);
  }

  selectEntity(entity: string | undefined, cell?: { x: number; y: number }): void {
    this.set({ selection: entity || cell ? { entity, cell } : null });
  }

  // ── Forks (spec 9.1) ────────────────────────────────────────────────────

  setDraft(draft: ForkSteps): void {
    this.set({ draft });
  }

  /** A referee's ground change at the decision the cursor stands at, added to the fork being put together. */
  paintGround(cell: { x: number; y: number }): void {
    const tool = this.state.refereeTool;
    const seat = this.refereeSeat();
    if (!tool || !seat) return;
    const changes = [...(this.state.draft.author?.changes ?? []).filter((change) => !('ground' in change && change.ground.layer === tool.layer
      && JSON.stringify(change.ground.at) === JSON.stringify([cell.x, cell.y]))), { ground: { at: [cell.x, cell.y] as [number, number], layer: tool.layer, value: tool.value } }];
    this.set({ draft: { ...this.state.draft, author: { seat, changes } } });
  }

  /** The scenario's referee seat; a referee change needs one. */
  refereeSeat(): string | undefined {
    const seats = this.state.compiled?.scenario.doc.seats ?? {};
    return Object.keys(seats).find((seat) => seats[seat].referee);
  }

  /** Plays the fork being put together and opens the branch beside its parent. */
  async runFork(steps: ForkSteps = this.state.draft, at = this.state.cursor): Promise<Watched | null> {
    const parent = this.watched;
    const run = this.run;
    if (!parent || !run) return null;
    this.pause();
    this.set({ running: true, error: null });
    try {
      const { log, record } = await this.sessionClient.branch(run, parent.log, parent.record.logHash, at, steps, parent.binds);
      const branch = this.watch(log, record, {
        hash: run.hash, seed: parent.seed, binds: { ...parent.binds, ...steps.bind }, fork: { at, steps, parent: parent.fork?.id ?? null },
      });
      this.set({ match: parent, branch, focus: 'branch', running: false, cursor: at, draft: {}, refereeTool: null, decision: null });
      this.atCursor();
      return branch;
    } catch (error) {
      if (!(error instanceof Cancelled)) this.set({ running: false, error: (error as Error).message });
      return null;
    }
  }

  forks(): ForkDoc[] {
    const { project, ruleset, variant } = this.state;
    return project ? listForks(project, ruleset, variant) : [];
  }

  /** Saves the open branch as a fork: what was done at its decision, and the hash of the log that gives. */
  saveBranch(id: string, title?: string): void {
    const { project, branch, ruleset, variant } = this.state;
    if (!project || !branch?.fork) return;
    saveFork(project, ruleset, {
      format: 1, fork: { id, ...(title ? { title } : {}) }, variant: { id: variant, hash: branch.hash }, seed: branch.seed,
      parent: branch.fork.parent ?? null, at: branch.fork.at, steps: toSteps(branch.fork.steps), logHash: branch.record.logHash,
    });
    branch.fork.id = id;
    this.set({ revision: project.revision, notice: `Saved the fork "${id}".` });
  }

  /** Regenerates a saved fork: the match, then each fork of its chain, and checks the result against its `logHash`. */
  async openFork(id: string): Promise<void> {
    const run = this.run;
    const { compiled } = this.state;
    if (!run || !compiled) return;
    this.pause();
    this.set({ running: true, error: null });
    try {
      const chain = chainOf(this.forks(), id);
      const fork = chain.at(-1)!;
      const binds: Record<string, string>[] = [{}];
      const { runs } = await regenerate(
        chain,
        (seed) => this.sessionClient.play(run, seed),
        (parent, seq, steps, held) => {
          binds.push({ ...held, ...steps.bind });
          return this.sessionClient.branch(run, parent.log, parent.record.logHash, seq, steps, held);
        },
      );
      const watched = runs.map((played, index) => this.watch(played.log, played.record, {
        hash: run.hash, seed: String(fork.seed), binds: binds[index],
        fork: index === 0 ? undefined : { id: chain[index - 1].fork.id, at: chain[index - 1].at, steps: {}, parent: chain[index - 1].parent ?? null },
      }));
      const branch = watched.at(-1)!;
      const matches = fork.logHash === undefined || fork.logHash === branch.record.logHash;
      this.set({
        match: watched.at(-2)!, branch, focus: 'branch', running: false, seed: String(fork.seed), cursor: fork.at, decision: null, draft: {},
        notice: matches ? `The fork "${id}" regenerated to its logHash, ${branch.record.logHash}.`
          : `The fork "${id}" no longer regenerates to its log (${fork.logHash} then, ${branch.record.logHash} now): ${fork.variant.hash === run.hash ? 'the core commit has' : 'the variant has'} changed since.`,
      });
      this.atCursor();
    } catch (error) {
      if (!(error instanceof Cancelled)) this.set({ running: false, error: (error as Error).message });
    }
  }

  closeBranch(): void {
    this.set({ branch: null, focus: 'match' });
    this.atCursor();
  }

  /** The state a scenario starts in: its setup, before anything is played. */
  startState(compiled: Compiled): State {
    return compiled.scenario.setup.reduce<State>((state, event) => apply(state, event), emptyState());
  }

  /** Another variant of the ruleset, compiled on the page to draw its map: a batch's heatmap lies over its own variant's map. */
  async sceneOf(variant: string): Promise<{ compiled: Compiled; presentation: Presentation; start: State } | null> {
    const { project, ruleset, look } = this.state;
    const resolved = project?.resolve(ruleset, variant);
    if (!project || !resolved || resolved.issues.length > 0) return null;
    const key = `${await variantHash(resolved.input)}|${look}|${project.revision}`;
    if (!this.compiledByHash.has(key)) {
      try {
        const compiled = compileInput(resolved.input);
        const file = look === 'none' ? undefined : project.studioDoc<PresentationDoc>('presentation', this.presentationPath()).doc;
        if (this.compiledByHash.size > 6) this.compiledByHash.clear();
        this.compiledByHash.set(key, { compiled, presentation: bindPresentation(file, compiled, look), start: this.startState(compiled) });
      } catch {
        return null;
      }
    }
    return this.compiledByHash.get(key)!;
  }

  // ── Analyze ─────────────────────────────────────────────────────────────

  /** The seed range a variant's batches run over: its own default, else 1 to 40. */
  seedRange(): { from: number; to: number } {
    return this.state.resolved?.variant.doc.seeds ?? { from: 1, to: 40 };
  }

  staleOf(batch: Batch): Stale[] {
    const { project, ruleset, variant, hash, metricsHash: metrics } = this.state;
    // A batch of another variant is checked against what that variant resolves to now.
    if (batch.doc.variant.id === variant) return staleness(batch, { hash: hash ?? undefined, metrics });
    void project;
    void ruleset;
    return staleness(batch, { hash: this.hashes.get(batch.doc.variant.id), metrics });
  }

  /** The hash each variant of the ruleset resolves to now, worked out when Analyze opens. */
  readonly hashes = new Map<string, string>();

  async refreshHashes(): Promise<void> {
    const { project, ruleset } = this.state;
    if (!project) return;
    this.hashes.clear();
    for (const variant of project.variants(ruleset)) {
      const resolved = project.resolve(ruleset, variant.id);
      if (resolved && resolved.issues.length === 0) this.hashes.set(variant.id, await variantHash(resolved.input));
    }
    this.set({ batches: listBatches(project, ruleset) });
  }

  /** Runs the variant in hand over a seed range across the pool. Seeds already recorded are not played again. */
  async runBatch(range = this.seedRange(), options: { fresh?: boolean } = {}): Promise<Batch | null> {
    const { project, ruleset, variant, metricsHash: digest } = this.state;
    const run = this.run;
    if (!project || !run || this.batch) return null;
    const doc = { format: 1, variant: { id: variant, hash: run.hash }, ruleset, core: CORE_COMMIT, seeds: range, metrics: digest };
    const existing = this.state.batches.find((batch) => batch.doc.variant.id === variant && batch.doc.variant.hash === run.hash);
    const usable = existing && !options.fresh && existing.doc.metrics === digest && existing.doc.core === CORE_COMMIT;
    const have: BatchRecord[] = usable ? existing.records.filter((record) => seedsOf(range).includes(record.seed)) : [];
    const todo = missingSeeds(range, have);
    const metrics = this.metricsDoc().doc ?? null;
    this.set({ progress: { variant, done: have.length, total: have.length + todo.length, startedAt: performance.now() }, error: null });
    this.batch = this.batchPool.run(run, todo, metrics, (_record, done) => {
      this.set({ progress: { ...this.state.progress!, done: have.length + done } });
    });
    try {
      const { records } = await this.batch.done;
      const written = writeBatch(project, doc, [...have, ...records], new Date().toISOString());
      this.hashes.set(variant, run.hash);
      this.set({ progress: null, batches: listBatches(project, ruleset), revision: project.revision, selectedBatches: [...new Set([...this.state.selectedBatches, written.path])] });
      return written;
    } catch (error) {
      this.set({ progress: null, error: (error as Error).message });
      return null;
    } finally {
      this.batch = null;
    }
  }

  cancelBatch(): void {
    this.batch?.cancel();
  }

  toggleBatch(path: string): void {
    const selected = this.state.selectedBatches;
    this.set({ selectedBatches: selected.includes(path) ? selected.filter((held) => held !== path) : [...selected, path] });
  }

  /** Opens a record's match in Run: its variant and seed, regenerated and checked against its `logHash`. */
  async openRecord(batch: Batch, record: BatchRecord): Promise<void> {
    this.set({ mode: 'run' });
    if (batch.doc.variant.id !== this.state.variant) await this.select(this.state.ruleset, batch.doc.variant.id);
    await this.play(record.seed, 'logHash' in record ? { logHash: record.logHash, variant: record.variant } : undefined);
  }

  // ── Build ───────────────────────────────────────────────────────────────

  /**
   * The variant edits are written to. Editing on a base variant first asks
   * for a new variant's name, and moves to it.
   */
  editable(): string | null {
    const { project, ruleset, variant, resolved } = this.state;
    if (!project || !resolved) return null;
    if (!resolved.variant.base) return variant;
    const name = window.prompt(`"${resolved.variant.title}" is a base variant, and the studio never writes base files.\nName a new variant to hold your changes:`, `${resolved.variant.scenario}-edit`);
    if (!name) return null;
    try {
      project.createVariant(ruleset, name, resolved.variant);
      this.set({ variant: name, revision: project.revision });
      return name;
    } catch (error) {
      this.set({ error: (error as Error).message });
      return null;
    }
  }

  private remember(path: string): void {
    const held = this.history.get(path) ?? { undo: [], redo: [] };
    held.undo.push(this.state.project!.text(path));
    held.redo = [];
    this.history.set(path, held);
  }

  /** Writes a studio file in place: a presentation file, the metrics, a variant's own file. */
  writeFile(path: string, text: string, options: { soon?: boolean } = {}): void {
    const project = this.state.project!;
    if (project.text(path) === text) return;
    this.remember(path);
    project.write(path, text);
    this.set({ revision: project.revision });
    if (options.soon) this.recompileSoon();
    else void this.recompile();
  }

  /** Writes a document of the variant in hand, as a path under the ruleset's folder: saving a base document writes a shadow. */
  writeDocument(rel: string, text: string, options: { soon?: boolean } = {}): string | null {
    const variant = this.editable();
    if (!variant) return null;
    const path = `${this.state.project!.variantDir(this.state.ruleset, variant)}/files/${rel}`;
    this.writeFile(path, text, options);
    return path;
  }

  updateVariant(change: (doc: VariantDoc) => VariantDoc): void {
    const variant = this.editable();
    const project = this.state.project!;
    if (!variant) return;
    const path = `${project.variantDir(this.state.ruleset, variant)}/variant.yaml`;
    this.remember(path);
    project.writeVariant(this.state.ruleset, variant, change(structuredClone(project.variant(this.state.ruleset, variant)!.doc)));
    this.set({ revision: project.revision });
    void this.recompile();
  }

  canUndo(path: string): boolean {
    return (this.history.get(path)?.undo.length ?? 0) > 0;
  }

  canRedo(path: string): boolean {
    return (this.history.get(path)?.redo.length ?? 0) > 0;
  }

  /** Undo and redo, per document. */
  undo(path: string, redo = false): void {
    const project = this.state.project!;
    const held = this.history.get(path);
    const [from, to] = redo ? [held?.redo, held?.undo] : [held?.undo, held?.redo];
    if (!from || from.length === 0) return;
    const text = from.pop();
    to!.push(project.text(path));
    if (text === undefined) project.remove(path);
    else project.write(path, text);
    this.set({ revision: project.revision });
    void this.recompile();
  }

  /** The text of a document as the variant in hand sees it, and the file it is read from. */
  document(rel: string): { path: string; text: string | undefined; shadowed: boolean } {
    const { project, ruleset, variant } = this.state;
    const path = project!.effective(ruleset, variant, rel);
    return { path, text: project!.text(path), shadowed: path.startsWith('studio/') };
  }

  parsed<T>(path: string): T | undefined {
    try {
      return parse(this.state.project!.text(path) ?? '') as T;
    } catch {
      return undefined;
    }
  }

  setTheme(theme: 'light' | 'dark'): void {
    document.documentElement.dataset.theme = theme;
    this.set({ theme });
  }

  toggleLayer(layer: string): void {
    const hidden = this.state.hiddenLayers;
    this.set({ hiddenLayers: hidden.includes(layer) ? hidden.filter((held) => held !== layer) : [...hidden, layer] });
  }
}

export const studio = new Studio();

/** Reads a part of the store, and renders again when that part changes. */
export function useStudio<T>(select: (state: StudioState) => T): T {
  return useSyncExternalStore(studio.subscribe, () => select(studio.state));
}
