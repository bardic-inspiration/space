// A token: an entity with a place to stand, drawn as a round chip with an
// icon and a ring in its color. Several in one cell fan out inside it.

import * as THREE from 'three';
import { fill, parseTemplate, type Part } from '../present/template.ts';
import type { CheckContext, Frame, InlineNode, InstrumentDoc, ItemBase } from '../present/types.ts';
import { checkCommon, colorOf, fieldScope, isDim, pointOf, subjects, type Common } from './component.ts';
import type { BoardKit, Drawn, Form, Subject } from './form.ts';
import { paintIcon } from './icons.ts';

export interface BoundToken extends Common {
  label: Part[];
  icon?: string;
}

export interface TokenItem extends ItemBase {
  color: string;
  icon?: string;
  /** Smaller when it shares its cell. */
  scale: number;
}

function check(name: string, doc: InstrumentDoc, ctx: CheckContext): BoundToken | undefined {
  const common = checkCommon(name, doc, ctx);
  if (!common) return undefined;
  if (!common.of) {
    ctx.issue('.of', 'a token stands for an entity: it needs `of`');
    return undefined;
  }
  if (doc.at === undefined) ctx.issue('.at', 'a token needs `at`: where it stands');
  const label = parseTemplate(doc.label ?? '{id}');
  const kind = ctx.registry.kinds.get(common.of)!;
  for (const part of label) {
    if ('path' in part && part.path[0] !== 'id' && !kind.fields.has(part.path[0])) ctx.issue('.label', `${kind.name} has no field "${part.path[0]}"`);
  }
  return { ...common, label, icon: doc.icon };
}

function describe(bound: BoundToken, frame: Frame, id: string, neutral: string): Omit<TokenItem, 'point' | 'scale'> {
  return {
    key: `${bound.name}:${id}`, instrument: bound.name, entity: id,
    label: fill(bound.label, fieldScope(bound, frame, id), frame.registry, frame.state),
    dim: isDim(bound, frame, id), color: colorOf(bound, frame, id, neutral), icon: bound.icon,
  };
}

function layout(bound: BoundToken, frame: Frame): TokenItem[] {
  const items = subjects(bound, frame).map((id) => ({ ...describe(bound, frame, id!, '#7d8590'), point: pointOf(bound, frame, id), scale: 1 }));
  // Several in one cell fan out inside it.
  const sharing = new Map<string, TokenItem[]>();
  for (const item of items) {
    if (!item.point) continue;
    const key = `${item.point.x},${item.point.y}`;
    sharing.set(key, [...(sharing.get(key) ?? []), item]);
  }
  for (const group of sharing.values()) {
    if (group.length < 2) continue;
    group.forEach((item, index) => {
      const angle = (index / group.length) * Math.PI * 2 - Math.PI / 2;
      item.point = { x: item.point!.x + Math.cos(angle) * 0.23, y: item.point!.y + Math.sin(angle) * 0.23 };
      item.scale = group.length > 4 ? 0.42 : 0.55;
    });
  }
  return items;
}

const RADIUS = 0.4;

function mount(bound: BoundToken, kit: BoardKit): Drawn<TokenItem> {
  const ring = new THREE.CylinderGeometry(RADIUS, RADIUS, 0.1, 32);
  const face = new THREE.CylinderGeometry(RADIUS * 0.78, RADIUS * 0.78, 0.12, 32);
  const top = new THREE.CircleGeometry(RADIUS * 0.7, 24);
  const held = new Map<string, { group: THREE.Group; look: string }>();
  let last: TokenItem[] = [];

  const build = (item: TokenItem): THREE.Group => {
    const theme = kit.theme();
    const group = new THREE.Group();
    const rim = new THREE.Mesh(ring, new THREE.MeshLambertMaterial({ color: item.dim ? theme.dim : item.color }));
    rim.position.y = 0.05;
    const disc = new THREE.Mesh(face, new THREE.MeshLambertMaterial({ color: item.dim ? theme.dim : theme.face }));
    disc.position.y = 0.06;
    group.add(rim, disc);
    const glyph = item.icon ?? item.label.slice(0, 2);
    if (glyph) {
      const ink = item.dim ? theme.muted : theme.ink;
      const icon = new THREE.Mesh(top, new THREE.MeshBasicMaterial({
        map: kit.texture(`icon|${glyph}|${ink}`, 96, 96, (context, size) => paintIcon(context, glyph, size, ink)), transparent: true,
      }));
      icon.rotation.x = -Math.PI / 2;
      icon.position.y = 0.125;
      group.add(icon);
    }
    const label = kit.label(item.label, { size: 0.3, color: item.dim ? theme.muted : theme.ink, plate: theme.background });
    label.position.set(0, 0.2, RADIUS + 0.24);
    group.add(label);
    // A dimmed token lies flat and gray.
    group.scale.set(item.scale, item.dim ? item.scale * 0.3 : item.scale, item.scale);
    return group;
  };

  return {
    update(items, { animate }) {
      const theme = kit.theme();
      const seen = new Set<string>();
      for (const item of items) {
        if (!item.point) continue;
        seen.add(item.key);
        const look = `${item.color}|${item.label}|${item.dim}|${item.scale}|${item.icon}|${theme.face}|${theme.ink}`;
        let entry = held.get(item.key);
        const fresh = !entry;
        if (!entry || entry.look !== look) {
          const group = build(item);
          if (entry) {
            group.position.copy(entry.group.position);
            kit.group.remove(entry.group);
          }
          entry = { group, look };
          held.set(item.key, entry);
          kit.group.add(group);
        }
        kit.glide(entry.group, { x: item.point.x, y: 0.02, z: item.point.y }, animate && !fresh);
      }
      for (const [key, entry] of held) {
        if (seen.has(key)) continue;
        kit.group.remove(entry.group);
        held.delete(key);
      }
      last = items;
    },
    pick(point) {
      // The nearest token under the point wins, so a fan can be told apart.
      let best: { item: TokenItem; distance: number } | undefined;
      for (const item of last) {
        if (!item.point) continue;
        const distance = Math.hypot(item.point.x - point.x, item.point.y - point.y);
        if (distance <= RADIUS * item.scale + 0.04 && (!best || distance < best.distance)) best = { item, distance };
      }
      return best ? { instrument: bound.name, entity: best.item.entity, label: best.item.label } : null;
    },
    dispose() {
      for (const entry of held.values()) kit.group.remove(entry.group);
      held.clear();
      ring.dispose();
      face.dispose();
      top.dispose();
    },
  };
}

/** A token inline: a chip in its color, with its label. */
function inline(bound: BoundToken, frame: Frame, subject: Subject): InlineNode | null {
  const id = subject.entity;
  if (id === undefined || 'value' in subject) return null;
  if (!frame.state.entities[id]) return { class: 'i-chip i-gone', children: [id] };
  const item = describe(bound, frame, id, '#7d8590');
  return { class: `i-chip${item.dim ? ' i-dim' : ''}`, title: id, children: [{ class: 'i-dot', style: { background: item.dim ? 'var(--dim)' : item.color } }, item.label] };
}

export const tokenForm: Form<BoundToken, TokenItem> = { id: 'token', role: 'component', check, layout, mount, inline };
