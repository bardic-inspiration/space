// Chips: an `int`, drawn as a stack whose height follows the count, with the
// number beside it. Zero draws an empty outline.

import * as THREE from 'three';
import { reader } from '../present/reader.ts';
import type { CheckContext, Frame, InlineNode, InstrumentDoc, ItemBase, Reader } from '../present/types.ts';
import { checkCommon, colorOf, hiddenBinding, isDim, pointOf, subjects, type Common } from './component.ts';
import type { BoardKit, Drawn, Form, Subject } from './form.ts';

export interface BoundChips extends Common {
  count: Reader;
  /** The chips one disc stands for. */
  unit: number;
  hidden: boolean;
}

export interface ChipsItem extends ItemBase {
  count: number;
  /** Discs in the stack. */
  discs: number;
  color: string;
  hidden: boolean;
}

/** A stack is never drawn taller than this many discs. */
const MOST = 40;

function check(name: string, doc: InstrumentDoc, ctx: CheckContext): BoundChips | undefined {
  const common = checkCommon(name, doc, ctx);
  if (!common) return undefined;
  if (doc.count === undefined) {
    ctx.issue('.count', 'chips need `count`: the int they show');
    return undefined;
  }
  const count = reader(ctx, doc.count, '.count', { of: common.of, expect: 'int' });
  return count && { ...common, count: count.read, unit: doc.unit ?? 1, hidden: hiddenBinding(ctx, common.of, doc.count) };
}

const layout = (bound: BoundChips, frame: Frame): ChipsItem[] => subjects(bound, frame).map((id) => {
  const count = Number(bound.count(frame.state, id) ?? 0);
  return {
    key: `${bound.name}:${id ?? ''}`, instrument: bound.name, entity: id, point: pointOf(bound, frame, id),
    label: `${bound.name}${id === undefined ? '' : ` of ${id}`}: ${count}`, dim: isDim(bound, frame, id),
    count, discs: Math.min(MOST, Math.max(0, Math.ceil(count / bound.unit))), color: colorOf(bound, frame, id, '#c28a2c'), hidden: bound.hidden,
  };
});

const RADIUS = 0.3;
const THICK = 0.045;

function mount(bound: BoundChips, kit: BoardKit): Drawn<ChipsItem> {
  const disc = new THREE.CylinderGeometry(RADIUS, RADIUS, THICK * 0.82, 24);
  const held = new Map<string, { group: THREE.Group; stack: THREE.InstancedMesh; outline: THREE.LineLoop; label?: THREE.Sprite; look: string; discs: number }>();
  let last: ChipsItem[] = [];
  const matrix = new THREE.Matrix4();

  return {
    update(items, { animate }) {
      const theme = kit.theme();
      const seen = new Set<string>();
      for (const item of items) {
        if (!item.point) continue;
        seen.add(item.key);
        let entry = held.get(item.key);
        if (!entry) {
          const group = new THREE.Group();
          const stack = new THREE.InstancedMesh(disc, new THREE.MeshLambertMaterial({ color: '#ffffff' }), MOST);
          const ring: number[] = [];
          for (let i = 0; i < 32; i++) ring.push(Math.cos((i / 32) * Math.PI * 2) * RADIUS, 0.01, Math.sin((i / 32) * Math.PI * 2) * RADIUS);
          const outline = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: theme.muted }));
          outline.geometry.setAttribute('position', new THREE.Float32BufferAttribute(ring, 3));
          group.add(stack, outline);
          group.position.set(item.point.x, 0.02, item.point.y);
          kit.group.add(group);
          entry = { group, stack, outline, look: '', discs: item.discs };
          held.set(item.key, entry);
        }
        kit.glide(entry.group, { x: item.point.x, y: 0.02, z: item.point.y }, false);
        const look = `${item.count}|${item.color}|${item.dim}|${theme.ink}|${theme.background}`;
        if (entry.look !== look) {
          const color = new THREE.Color(item.dim ? theme.dim : item.color);
          const edge = color.clone().multiplyScalar(0.72);
          for (let i = 0; i < item.discs; i++) {
            entry.stack.setMatrixAt(i, matrix.makeTranslation(0, THICK * (i + 0.5), 0));
            entry.stack.setColorAt(i, i % 5 === 4 ? edge : color);
          }
          entry.stack.count = item.discs;
          entry.stack.instanceMatrix.needsUpdate = true;
          if (entry.stack.instanceColor) entry.stack.instanceColor.needsUpdate = true;
          entry.outline.visible = item.discs === 0;
          if (entry.label) entry.group.remove(entry.label);
          entry.label = kit.label(`${item.hidden ? '◌ ' : ''}${item.count}`, { size: 0.26, color: item.dim ? theme.muted : theme.ink, plate: theme.background });
          entry.label.position.set(RADIUS + 0.34, 0.25, 0);
          entry.group.add(entry.label);
          // A stack that grows or shrinks while playing settles from where it was.
          if (animate && entry.look) {
            entry.stack.scale.y = item.discs === 0 ? 1 : Math.max(0.05, entry.discs / item.discs);
            entry.stack.userData.settle = true;
          } else entry.stack.scale.y = 1;
          entry.look = look;
          entry.discs = item.discs;
        }
      }
      for (const [key, entry] of held) {
        if (seen.has(key)) continue;
        kit.group.remove(entry.group);
        entry.outline.geometry.dispose();
        held.delete(key);
      }
      last = items;
    },
    pick(point) {
      const hit = last.find((item) => item.point && Math.hypot(item.point.x - point.x, item.point.y - point.y) <= RADIUS + 0.05);
      return hit ? { instrument: bound.name, entity: hit.entity, label: hit.label } : null;
    },
    dispose() {
      for (const entry of held.values()) kit.group.remove(entry.group);
      held.clear();
      disc.dispose();
    },
  };
}

/** Chips inline: a small stack and the number. */
function inline(bound: BoundChips, frame: Frame, subject: Subject): InlineNode | null {
  if (!('value' in subject) || typeof subject.value !== 'number') return null;
  const color = colorOf(bound, frame, subject.entity, '#c28a2c');
  return { class: 'i-stack', children: [{ class: 'i-disc', style: { background: color } }, String(subject.value)] };
}

export const chipsForm: Form<BoundChips, ChipsItem> = { id: 'chips', role: 'component', check, layout, mount, inline };
