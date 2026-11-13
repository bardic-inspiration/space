// The debug overlay's drawing (spec 8.1): the host calls behind a candidate,
// a gate or a param's domain, laid on the board. `cellsWithin` is a filled
// range, `neighbors` marked cells, `lineOfSight` a ray that is green when
// clear and red when broken, `distance` a labelled line, `cellAt` and
// `inBounds` a marked cell.

import * as THREE from 'three';
import type { HostCall, Point, SpaceMap } from '../core.ts';
import type { BoardKit } from '../forms/form.ts';

const HEIGHT = 0.09;

export function drawOverlay(group: THREE.Group, calls: HostCall[], map: SpaceMap, kit: BoardKit): void {
  const theme = kit.theme();
  const flat = (cell: Point, color: string, opacity: number, inset = 0) => {
    const square = new THREE.Mesh(new THREE.PlaneGeometry(1 - inset * 2, 1 - inset * 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    square.rotation.x = -Math.PI / 2;
    square.position.set(cell.x + 0.5, HEIGHT, cell.y + 0.5);
    group.add(square);
  };
  const frame = (cell: Point, color: string) => {
    const loop = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color }));
    const [a, b] = [0.06, 0.94];
    loop.geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      cell.x + a, HEIGHT, cell.y + a, cell.x + b, HEIGHT, cell.y + a, cell.x + b, HEIGHT, cell.y + b, cell.x + a, HEIGHT, cell.y + b,
    ], 3));
    group.add(loop);
  };
  const cross = (cell: Point, color: string) => {
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color }));
    const [a, b] = [0.28, 0.72];
    lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      cell.x + a, HEIGHT, cell.y + a, cell.x + b, HEIGHT, cell.y + b, cell.x + b, HEIGHT, cell.y + a, cell.x + a, HEIGHT, cell.y + b,
    ], 3));
    group.add(lines);
  };
  const line = (a: Point, b: Point, color: string, text?: string) => {
    // A flat bar, so the ray has a width a line would not get.
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(0.05, length), 0.09), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
    bar.rotation.set(-Math.PI / 2, 0, 0);
    bar.rotateZ(-Math.atan2(b.y - a.y, b.x - a.x));
    bar.position.set((a.x + b.x) / 2 + 0.5, HEIGHT + 0.02, (a.y + b.y) / 2 + 0.5);
    bar.renderOrder = 8;
    group.add(bar);
    for (const end of [a, b]) {
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.13, 16), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(end.x + 0.5, HEIGHT + 0.03, end.y + 0.5);
      dot.renderOrder = 9;
      group.add(dot);
    }
    if (text !== undefined) {
      const label = kit.label(text, { size: 0.34, color, plate: theme.background });
      label.position.set((a.x + b.x) / 2 + 0.5, 0.6, (a.y + b.y) / 2 + 0.5);
      group.add(label);
    }
  };
  const onMap = (cell: Point) => cell.x >= 0 && cell.y >= 0 && cell.x < map.width && cell.y < map.height;
  const blocked = new Set(map.blocksMove.map((cell) => `${cell.x},${cell.y}`));

  for (const call of calls) {
    const [a, b] = call.args as [Point, Point | number];
    switch (call.fn) {
      case 'cellsWithin':
        for (const cell of call.result as Point[]) flat(cell, theme.accent, 0.22);
        frame(a, theme.accent);
        break;
      case 'neighbors': {
        const found = call.result as Point[];
        for (const cell of found) flat(cell, theme.good, 0.4, 0.18);
        frame(a, theme.accent);
        // An adjacent cell that is open and yet left out: a diagonal a closed corner removes.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const cell = { x: a.x + dx, y: a.y + dy };
            const adjacent = (dx !== 0 || dy !== 0) && (map.adjacency === 8 || dx === 0 || dy === 0);
            if (adjacent && onMap(cell) && !blocked.has(`${cell.x},${cell.y}`) && !found.some((other) => other.x === cell.x && other.y === cell.y)) cross(cell, theme.bad);
          }
        }
        break;
      }
      case 'lineOfSight':
        line(a, b as Point, call.result ? theme.good : theme.bad);
        break;
      case 'distance':
        line(a, b as Point, theme.muted, String(call.result));
        break;
      case 'inBounds':
        frame(a, call.result ? theme.good : theme.bad);
        if (!call.result) cross(a, theme.bad);
        break;
      case 'cellAt':
        frame(a, theme.accent);
        break;
    }
  }
}

/** A host call in words, for the overlay's list. */
export function describeCall(call: HostCall): string {
  const show = (value: Point | number) => (typeof value === 'number' ? String(value) : `(${value.x}, ${value.y})`);
  const result = Array.isArray(call.result) ? `${call.result.length} cells` : typeof call.result === 'object' ? JSON.stringify(call.result) : String(call.result);
  return `${call.fn}(${call.args.map(show).join(', ')}) → ${result}`;
}
