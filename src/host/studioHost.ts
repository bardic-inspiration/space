// The studio's geometry host: the six functions of core's docs/host.md, for
// the view, the session worker and every batch worker alike.
//
// It is a pure function of the one map it is given. Core calls the factory
// again with a patched map each time a match writes the ground, so building
// one indexes the map into typed arrays and does nothing else.
//
// In v1 it agrees with core's reference host answer for answer (S9): the same
// row order, the same closed corners, the same line walk for sight.

import type { CellValues, Point, SpaceHost, SpaceMap } from '../core.ts';

export function createStudioHost(map: SpaceMap): SpaceHost {
  const { width, height, unit } = map;
  const diagonal = map.adjacency === 8;
  const closed = map.corners === 'closed';
  const size = width * height;
  const blocksMove = new Uint8Array(size);
  const blocksSight = new Uint8Array(size);
  // 0 for a cell at its defaults, else one more than its index in `map.cells`.
  const given = new Int32Array(size);
  for (const cell of map.blocksMove) blocksMove[cell.y * width + cell.x] = 1;
  for (const cell of map.blocksSight) blocksSight[cell.y * width + cell.x] = 1;
  map.cells.forEach((cell, index) => { given[cell.y * width + cell.x] = index + 1; });

  const onMap = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  const walled = (x: number, y: number) => onMap(x, y) && blocksMove[y * width + x] === 1;
  const open = (x: number, y: number) => onMap(x, y) && blocksMove[y * width + x] === 0;
  const steps = (a: Point, b: Point) => {
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    return diagonal ? Math.max(dx, dy) : dx + dy;
  };
  const within = (cell: Point, reach: number): Point[] => {
    const cells: Point[] = [];
    for (let y = cell.y - reach; y <= cell.y + reach; y++) {
      for (let x = cell.x - reach; x <= cell.x + reach; x++) {
        if (!open(x, y)) continue;
        const dx = Math.abs(cell.x - x);
        const dy = Math.abs(cell.y - y);
        if ((diagonal ? Math.max(dx, dy) : dx + dy) <= reach) cells.push({ x, y });
      }
    }
    return cells;
  };

  return {
    inBounds: (cell) => open(cell.x, cell.y),
    distance: (a, b) => steps(a, b) * unit,
    neighbors: (cell) => within(cell, 1).filter((other) =>
      (other.x !== cell.x || other.y !== cell.y)
      // Closed corners: a diagonal step is cut off by a blocking cell on either side of it.
      && !(closed && other.x !== cell.x && other.y !== cell.y && (walled(other.x, cell.y) || walled(cell.x, other.y)))),
    cellsWithin: (cell, range) => within(cell, Math.floor(range / unit)),
    // The reference's walk along the line: a sight-blocking cell strictly between the two breaks it.
    lineOfSight: (a, b) => {
      const count = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      for (let i = 1; i < count; i++) {
        const x = Math.round(a.x + ((b.x - a.x) * i) / count);
        const y = Math.round(a.y + ((b.y - a.y) * i) / count);
        if (onMap(x, y) && blocksSight[y * width + x] === 1) return false;
      }
      return true;
    },
    cellAt: (cell): CellValues => {
      const index = onMap(cell.x, cell.y) ? given[cell.y * width + cell.x] : 0;
      return index === 0 ? map.defaults : map.cells[index - 1].values;
    },
  };
}
