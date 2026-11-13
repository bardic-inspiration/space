// A board in the page. The main board follows the match in focus; a second
// one stands beside it for a fork's parent, or a second batch's heatmap.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Board, type Heat } from '../board/board.ts';
import type { SpaceMap, State } from '../core.ts';
import type { Presentation } from '../present/presentation.ts';
import { studio, useStudio } from './studio.ts';

export interface Scene {
  presentation: Presentation;
  state: State;
  map?: SpaceMap | null;
  animate?: boolean;
}

const boards = new Map<string, Board>();
(window as unknown as { boards: typeof boards }).boards = boards;

export function BoardView({ name, scene, heat, interactive, caption }: { name: string; scene: Scene | null; heat?: Heat | null; interactive?: boolean; caption?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const theme = useStudio((state) => state.theme);
  const tilt = useStudio((state) => state.tilt);
  const hidden = useStudio((state) => state.hiddenLayers);
  const overlay = useStudio((state) => state.overlay);
  const selection = useStudio((state) => state.selection);
  const marks = useStudio((state) => state.marks);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let made: Board;
    try {
      made = new Board(host.current!);
    } catch (error) {
      setFailed((error as Error).message);
      return undefined;
    }
    boards.set(name, made);
    setBoard(made);
    return () => {
      boards.delete(name);
      made.dispose();
    };
  }, [name]);

  useEffect(() => {
    if (!board) return;
    board.onPointer = interactive ? (event) => studio.tool?.(event) ?? false : null;
    board.onPick = interactive ? (pick, cell) => studio.selectEntity(pick?.entity, pick?.entity ? undefined : cell ?? undefined) : null;
    board.onHover = (label) => studio.state.hover !== label && studio.set({ hover: label });
  }, [board, interactive]);

  const presentation = scene?.presentation ?? null;
  useLayoutEffect(() => board?.setPresentation(presentation), [board, presentation]);
  useEffect(() => board?.refreshTheme(), [board, theme]);
  useEffect(() => board?.setTilt(tilt), [board, tilt]);
  useEffect(() => {
    if (!board || !presentation) return;
    for (const layer of presentation.registry.cellLayers.keys()) board.setLayerHidden(layer, hidden.includes(layer));
  }, [board, presentation, hidden]);
  // Before the browser paints, so the board and the panels move in the same frame.
  useLayoutEffect(() => {
    if (board && scene) board.show(scene.state, { animate: scene.animate, map: scene.map });
  }, [board, scene?.state, scene?.map, presentation, theme]);
  useEffect(() => board?.setOverlay(interactive ? overlay : null), [board, overlay, interactive, scene?.state]);
  useEffect(() => board?.setSelection(interactive ? selection : null), [board, selection, interactive, scene?.state]);
  useEffect(() => board?.setHeatmap(heat ?? null), [board, heat, scene?.state]);
  useEffect(() => board?.setMarks(interactive ? marks : []), [board, marks, interactive, scene?.state]);

  const tray = board && scene ? board.tray() : [];
  return (
    <div className="board" data-board={name}>
      <div className="board-host" ref={host} />
      {caption && <div className="board-caption">{caption}</div>}
      {failed && <div className="board-failed">The board needs WebGL, and this browser gave none: {failed}</div>}
      {tray.length > 0 && (
        <div className="tray" title="Components the map has no place for">
          <b>Tray</b>
          {tray.map((item) => <button key={item.key} onClick={() => item.entity && studio.selectEntity(item.entity)}>{item.label}</button>)}
        </div>
      )}
    </div>
  );
}

export const boardNamed = (name: string): Board | undefined => boards.get(name);
