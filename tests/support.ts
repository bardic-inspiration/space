// What the tests take from core beyond its entry.

import { hashSeed, nextRandom, type Registry, type SpaceMap } from 'rpg-core';
import { patchMap } from 'rpg-core/src/runtime/map.ts';

export { compareHosts, createGridHost, loadMap } from 'rpg-core';
export type { SpaceMap } from 'rpg-core';

/**
 * A map with random ground writes laid over it, three times: each layer of
 * some cells takes another value of its type. Seeded by name, so a failure
 * repeats.
 */
export function patchedForTest(registry: Registry, map: SpaceMap, name: string): SpaceMap[] {
  let position = hashSeed(name);
  const draw = (count: number) => {
    const step = nextRandom(position);
    position = step.position;
    return Math.floor(step.value * count);
  };
  const layers = [...registry.cellLayers.values()];
  if (layers.length === 0) return [];
  return [0, 1, 2].map(() => {
    const overlay: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < Math.max(4, Math.floor((map.width * map.height) / 6)); i++) {
      const layer = layers[draw(layers.length)];
      const values = layer.type.k === 'enum' ? registry.enums.get(layer.type.name)! : layer.type.k === 'bool' ? [true, false] : layer.type.k === 'string' ? ['a', 'b'] : [0, 1, 2, 3, 4];
      (overlay[`${draw(map.width)},${draw(map.height)}`] ??= {})[layer.name] = values[draw(values.length)];
    }
    return patchMap(registry, map, overlay);
  });
}
