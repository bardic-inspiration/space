// The workspace: three modes around one persistent board.

import { useEffect, useMemo, useState } from 'react';
import type { State } from '../core.ts';
import { AnalyzePanel, useHeat } from './AnalyzePanel.tsx';
import { BoardView, boardNamed, type Scene } from './BoardView.tsx';
import { BuildPanel } from './BuildPanel.tsx';
import { Inspector, LogPanel, Transport } from './RunPanel.tsx';
import { studio, useStudio, type Mode } from './studio.ts';

const MODES: Mode[] = ['build', 'run', 'analyze'];

function TopBar() {
  const project = useStudio((state) => state.project);
  const ruleset = useStudio((state) => state.ruleset);
  const variant = useStudio((state) => state.variant);
  const look = useStudio((state) => state.look);
  const seed = useStudio((state) => state.seed);
  const mode = useStudio((state) => state.mode);
  const theme = useStudio((state) => state.theme);
  const running = useStudio((state) => state.running);
  const hash = useStudio((state) => state.hash);
  useStudio((state) => state.revision);
  const [typed, setTyped] = useState(seed);
  useEffect(() => setTyped(seed), [seed]);
  if (!project) return <header className="top"><b className="brand">Spatial Test Studio</b></header>;
  const variants = project.variants(ruleset);
  return (
    <header className="top">
      <b className="brand">Spatial Test Studio</b>
      <span className="project" title={project.files.saves ? 'A folder on disk' : 'Held in memory: changes are lost with the page'}>
        {project.name}{project.files.saves ? '' : ' · not saved'}
      </span>
      <button onClick={() => void studio.openFolder()} title="Open a project folder (desktop Chromium)">Open folder…</button>
      <button onClick={() => void studio.openExamples()}>Examples</button>
      <span className="gap" />
      <label>Ruleset
        <select aria-label="Ruleset" value={ruleset} onChange={(event) => void studio.select(event.target.value)}>
          {project.rulesets().map((id) => <option key={id} value={id}>{project.rulesetTitle(id)}</option>)}
        </select>
      </label>
      <label>Variant
        <select aria-label="Variant" value={variant} onChange={(event) => void studio.select(ruleset, event.target.value)}>
          <optgroup label="Scenarios as written">
            {variants.filter((held) => held.base).map((held) => <option key={held.id} value={held.id}>{held.title}</option>)}
          </optgroup>
          {variants.some((held) => !held.base) && (
            <optgroup label="Variants">
              {variants.filter((held) => !held.base).map((held) => <option key={held.id} value={held.id}>{held.title} ({held.scenario})</option>)}
            </optgroup>
          )}
        </select>
      </label>
      <label>Look
        <select aria-label="Look" value={look} onChange={(event) => studio.setLook(event.target.value)}>
          {[...new Set(['default', ...studio.looks()])].map((id) => <option key={id} value={id}>{studio.looks().includes(id) ? id : 'default (none written)'}</option>)}
          <option value="none">no presentation file</option>
        </select>
      </label>
      <form className="seed" onSubmit={(event) => { event.preventDefault(); void studio.play(typed); }}>
        <label>Seed <input aria-label="Seed" value={typed} onChange={(event) => setTyped(event.target.value)} size={5} /></label>
        <button type="submit" disabled={!hash || running}>{running ? 'Playing…' : 'Play seed'}</button>
      </form>
      <span className="gap" />
      <nav className="modes">
        {MODES.map((id) => <button key={id} className={mode === id ? 'on' : ''} onClick={() => studio.set({ mode: id })}>{id[0].toUpperCase() + id.slice(1)}</button>)}
      </nav>
      <button onClick={() => { const next = theme === 'light' ? 'dark' : 'light'; localStorage.setItem('studio.theme', next); studio.setTheme(next); }} title="Light or dark">
        {theme === 'light' ? 'Dark' : 'Light'}
      </button>
    </header>
  );
}

/** The layer panel: one row per declared layer, with its legend, and a mark when play may change it. */
function LayerPanel() {
  const presentation = useStudio((state) => state.presentation);
  const hidden = useStudio((state) => state.hiddenLayers);
  const tilt = useStudio((state) => state.tilt);
  const hover = useStudio((state) => state.hover);
  const layers = (presentation?.container?.bound as unknown as { layers?: { name: string; mutable: boolean; type: string; values: Map<string, { color: string }>; ramp: string[] }[] } | undefined)?.layers ?? [];
  return (
    <div className="board-tools">
      <div className="row">
        <button onClick={() => boardNamed('main')?.fit()} title="Fit the map (F)">Fit</button>
        <button className={tilt ? 'on' : ''} onClick={() => studio.set({ tilt: !tilt })} title="Tilt to a perspective view">Tilt</button>
        <span className="hover">{hover ?? ''}</span>
      </div>
      {layers.map((layer) => (
        <label key={layer.name} className="layer" title={layer.mutable ? 'Play may change this layer' : 'Fixed: the map’s value stands for the whole match'}>
          <input type="checkbox" checked={!hidden.includes(layer.name)} onChange={() => studio.toggleLayer(layer.name)} />
          <span>{layer.name}{layer.mutable ? ' ✎' : ''}</span>
          <span className="legend">
            {layer.type === 'number'
              ? <i className="swatch wide" style={{ background: `linear-gradient(90deg, ${layer.ramp.join(', ')})` }} />
              : [...layer.values].map(([value, look]) => <i key={value} className="swatch" style={{ background: look.color }} title={value} />)}
          </span>
        </label>
      ))}
    </div>
  );
}

function Issues() {
  const issues = useStudio((state) => state.issues);
  const error = useStudio((state) => state.error);
  const notice = useStudio((state) => state.notice);
  if (issues.length === 0 && !error && !notice) return null;
  return (
    <div className="issues">
      {notice && <div className="notice">{notice} <button onClick={() => studio.set({ notice: null })}>Dismiss</button></div>}
      {error && <div className="issue bad">{error} <button onClick={() => studio.set({ error: null })}>Dismiss</button></div>}
      {issues.length > 0 && <div className="issue-head">{issues.length} {issues.length === 1 ? 'error' : 'errors'}: this variant cannot be run until they are fixed. The last good compile stays on the board.</div>}
      {issues.slice(0, 40).map((issue, index) => (
        <button key={index} className="issue bad" onClick={() => window.dispatchEvent(new CustomEvent('studio:goto', { detail: issue }))} title="Open in the editor">
          <code>{issue.file}{issue.line ? `:${issue.line}` : ''}</code> {issue.path && <i>{issue.path}</i>} {issue.message}
        </button>
      ))}
    </div>
  );
}

/** What each board shows in each mode. */
function Boards() {
  const mode = useStudio((state) => state.mode);
  const match = useStudio((state) => state.match);
  const branch = useStudio((state) => state.branch);
  const focus = useStudio((state) => state.focus);
  const cursor = useStudio((state) => state.cursor);
  const animate = useStudio((state) => state.animate);
  const compiled = useStudio((state) => state.compiled);
  const presentation = useStudio((state) => state.presentation);
  const preview = useStudio((state) => state.preview);
  const heat = useHeat();

  const start: State | null = useMemo(() => (compiled ? studio.startState(compiled) : null), [compiled]);
  let main: Scene | null = null;
  let partner: Scene | null = null;
  let captions: [string?, string?] = [];
  if (mode === 'run' && match) {
    const watched = focus === 'branch' && branch ? branch : match;
    main = { presentation: watched.presentation, state: watched.cache.at(cursor), animate };
    if (branch) {
      const other = watched === branch ? match : branch;
      partner = { presentation: other.presentation, state: other.cache.at(studio.partnerCursor()) };
      captions = watched === branch ? ['Fork', 'Parent'] : ['Parent', 'Fork'];
    }
  } else if (mode === 'analyze' && heat.scenes[0]) {
    main = heat.scenes[0];
    partner = heat.scenes[1] ?? null;
    captions = heat.captions;
  } else if (presentation && start) main = { presentation, state: start, map: mode === 'build' ? preview : null };

  return (
    <div className={`boards${partner ? ' split' : ''}`}>
      <BoardView name="main" scene={main} interactive caption={captions[0]} heat={mode === 'analyze' ? heat.heats[0] : null} />
      {partner && <BoardView name="partner" scene={partner} caption={captions[1]} heat={mode === 'analyze' ? heat.heats[1] : null} />}
      <LayerPanel />
    </div>
  );
}

function useKeys() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, .cm-editor')) return;
      if (event.key === 'f') return boardNamed('main')?.fit();
      if (studio.state.mode !== 'run') return;
      if (event.key === ' ') studio.toggle();
      else if (event.key === 'ArrowRight') event.shiftKey ? studio.stepDecision(1) : studio.step(1);
      else if (event.key === 'ArrowLeft') event.shiftKey ? studio.stepDecision(-1) : studio.step(-1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const project = useStudio((state) => state.project);
  const opening = useStudio((state) => state.opening);
  const error = useStudio((state) => state.error);
  const mode = useStudio((state) => state.mode);
  useKeys();
  if (!project) {
    return (
      <div className="app">
        <TopBar />
        <div className="splash">
          {opening ? 'Opening…' : error}
          {!opening && <p><button onClick={() => void studio.openExamples()}>Open the examples</button> <button onClick={() => void studio.openFolder()}>Open a folder…</button></p>}
        </div>
      </div>
    );
  }
  return (
    <div className={`app mode-${mode}`}>
      <TopBar />
      <main className="work">
        <aside className="left">
          {mode === 'run' && <LogPanel />}
          {mode === 'analyze' && <AnalyzePanel />}
          {mode === 'build' && <BuildPanel />}
        </aside>
        <section className="middle">
          <Boards />
          {mode === 'run' && <Transport />}
          <Issues />
        </section>
        {mode !== 'analyze' && <aside className="right"><Inspector /></aside>}
      </main>
    </div>
  );
}
