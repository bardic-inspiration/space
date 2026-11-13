// Cards: a `list<int>` or `list<string>`, drawn as a row of faces in list
// order. A face is a rank and a suit read from each card, or words.

import * as THREE from 'three';
import type { Value } from '../core.ts';
import { reader } from '../present/reader.ts';
import type { CheckContext, Frame, InlineNode, InstrumentDoc, ItemBase, Reader } from '../present/types.ts';
import { checkCommon, hiddenBinding, isDim, pointOf, subjects, type Common } from './component.ts';
import type { BoardKit, Drawn, Form, Subject } from './form.ts';
import { RED_SUITS, SUIT_SIGNS, paintSuit, rankText, suitName } from './icons.ts';

export interface Face {
  rank?: string;
  suit?: string;
  text?: string;
}

export interface BoundCards extends Common {
  cards: Reader;
  rank?: Reader;
  suit?: Reader;
  text?: Reader;
  back: boolean;
  /** The ruleset hides the list from some seats. It is drawn as the referee sees it, and marked (S14). */
  hidden: boolean;
}

export interface CardsItem extends ItemBase {
  faces: Face[];
  back: boolean;
  hidden: boolean;
}

function check(name: string, doc: InstrumentDoc, ctx: CheckContext): BoundCards | undefined {
  const common = checkCommon(name, doc, ctx);
  if (!common) return undefined;
  if (doc.cards === undefined) {
    ctx.issue('.cards', 'cards need `cards`: the list they show');
    return undefined;
  }
  const cards = reader(ctx, doc.cards, '.cards', { of: common.of, expect: ['list<int>', 'list<string>'] });
  if (!cards) return undefined;
  const card = cards.type === 'list<int>' ? 'int' : 'string';
  const face = (part: 'rank' | 'suit' | 'text') => (doc.face?.[part] === undefined
    ? undefined
    : reader(ctx, doc.face[part]!, `.face.${part}`, { of: common.of, vars: { card }, expect: part === 'text' ? 'string' : ['int', 'string'] })?.read);
  if (doc.face?.text !== undefined && (doc.face.rank !== undefined || doc.face.suit !== undefined)) ctx.issue('.face', 'a face is a `rank` and a `suit`, or `text`');
  return { ...common, cards: cards.read, rank: face('rank'), suit: face('suit'), text: face('text'), back: doc.back === true, hidden: hiddenBinding(ctx, common.of, doc.cards) };
}

function faceOf(bound: BoundCards, frame: Frame, id: string | undefined, card: Value): Face {
  if (bound.text) return { text: String(bound.text(frame.state, id, { card })) };
  if (!bound.rank && !bound.suit) return { text: String(card) };
  return {
    rank: bound.rank ? rankText(bound.rank(frame.state, id, { card })) : undefined,
    suit: bound.suit ? suitName(bound.suit(frame.state, id, { card })) : undefined,
  };
}

const layout = (bound: BoundCards, frame: Frame): CardsItem[] => subjects(bound, frame).map((id) => {
  const cards = (bound.cards(frame.state, id) ?? []) as Value[];
  return {
    key: `${bound.name}:${id ?? ''}`, instrument: bound.name, entity: id, point: pointOf(bound, frame, id),
    label: `${bound.name}${id === undefined ? '' : ` of ${id}`}`, dim: isDim(bound, frame, id),
    faces: cards.map((card) => faceOf(bound, frame, id, card)), back: bound.back, hidden: bound.hidden,
  };
});

const WIDTH = 0.62;
const HEIGHT = 0.86;
const GAP = 0.08;
const showFace = (face: Face) => face.text ?? `${face.rank ?? ''}${SUIT_SIGNS[face.suit ?? ''] ?? face.suit ?? ''}`;

function paintFace(context: CanvasRenderingContext2D, w: number, h: number, face: Face | null, hidden: boolean, dim: boolean): void {
  const r = w * 0.1;
  context.clearRect(0, 0, w, h);
  context.beginPath();
  context.roundRect(2, 2, w - 4, h - 4, r);
  context.fillStyle = face ? (dim ? '#c9c9c4' : '#fbfaf6') : '#31507f';
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = face ? '#8b8b86' : '#1f355a';
  context.stroke();
  if (!face) {
    context.strokeStyle = '#6f8fc4';
    context.lineWidth = 2;
    for (let i = -h; i < w; i += 14) {
      context.beginPath();
      context.moveTo(i, h - 8);
      context.lineTo(i + h, 8);
      context.stroke();
    }
    return;
  }
  const red = RED_SUITS.has(face.suit ?? '');
  context.fillStyle = dim ? '#77776f' : red ? '#b5483a' : '#20242b';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  if (face.text !== undefined) {
    context.font = `600 ${Math.min(h * 0.26, (w * 1.5) / Math.max(1, face.text.length))}px system-ui, sans-serif`;
    context.fillText(face.text, w / 2, h / 2);
  } else {
    context.font = `700 ${h * 0.36}px system-ui, sans-serif`;
    context.fillText(face.rank ?? '', w / 2, h * 0.3);
    if (face.suit && face.suit in SUIT_SIGNS) paintSuit(context, face.suit, w / 2, h * 0.68, h * 0.3);
    else if (face.suit) {
      context.font = `500 ${h * 0.16}px system-ui, sans-serif`;
      context.fillText(face.suit, w / 2, h * 0.7);
    }
  }
  // Hidden from some seats: a mark in the corner.
  if (hidden) {
    context.fillStyle = '#7a5bb0';
    context.beginPath();
    context.moveTo(w - 4, 4 + r);
    context.lineTo(w - 4, h * 0.26);
    context.lineTo(w - h * 0.26, 4);
    context.lineTo(w - 4 - r, 4);
    context.closePath();
    context.fill();
  }
}

function mount(bound: BoundCards, kit: BoardKit): Drawn<CardsItem> {
  const card = new THREE.PlaneGeometry(WIDTH, HEIGHT);
  const held = new Map<string, { group: THREE.Group; look: string; count: number }>();
  let last: CardsItem[] = [];

  return {
    update(items, { animate }) {
      const seen = new Set<string>();
      for (const item of items) {
        if (!item.point) continue;
        seen.add(item.key);
        let entry = held.get(item.key);
        if (!entry) {
          entry = { group: new THREE.Group(), look: '', count: 0 };
          held.set(item.key, entry);
          kit.group.add(entry.group);
        }
        entry.group.position.set(item.point.x, 0.03, item.point.y);
        const look = JSON.stringify([item.faces, item.dim, item.back]);
        if (entry.look === look) continue;
        for (const child of [...entry.group.children]) {
          entry.group.remove(child);
          ((child as THREE.Mesh).material as THREE.Material).dispose();
        }
        const span = item.faces.length * WIDTH + (item.faces.length - 1) * GAP;
        item.faces.forEach((face, index) => {
          const shown = item.back ? null : face;
          const key = `card|${shown ? showFace(shown) : 'back'}|${item.hidden}|${item.dim}`;
          const mesh = new THREE.Mesh(card, new THREE.MeshBasicMaterial({
            map: kit.texture(key, 124, 172, (context, w, h) => paintFace(context, w, h, shown, item.hidden, item.dim)), transparent: true,
          }));
          mesh.rotation.x = -Math.PI / 2;
          const to = { x: -span / 2 + WIDTH / 2 + index * (WIDTH + GAP), y: 0.002 * index, z: 0 };
          // A card that was not there before is dealt in.
          const dealt = animate && entry!.look !== '' && index >= entry!.count;
          mesh.position.set(to.x, dealt ? 0.9 : to.y, dealt ? -0.6 : to.z);
          entry!.group.add(mesh);
          kit.glide(mesh, to, dealt);
        });
        entry.look = look;
        entry.count = item.faces.length;
      }
      for (const [key, entry] of held) {
        if (seen.has(key)) continue;
        kit.group.remove(entry.group);
        held.delete(key);
      }
      last = items;
    },
    pick(point) {
      const hit = last.find((item) => {
        if (!item.point || item.faces.length === 0) return false;
        const span = item.faces.length * WIDTH + (item.faces.length - 1) * GAP;
        return Math.abs(point.x - item.point.x) <= span / 2 && Math.abs(point.y - item.point.y) <= HEIGHT / 2;
      });
      return hit ? { instrument: bound.name, entity: hit.entity, label: `${hit.label}: ${hit.faces.map(showFace).join(' ')}` } : null;
    },
    dispose() {
      for (const entry of held.values()) kit.group.remove(entry.group);
      held.clear();
      card.dispose();
    },
  };
}

/** Cards inline: the faces a value written to the binding holds. */
function inline(bound: BoundCards, frame: Frame, subject: Subject): InlineNode | null {
  if (!('value' in subject) || !Array.isArray(subject.value)) return null;
  const faces = subject.value.map((card) => faceOf(bound, frame, subject.entity, card));
  if (faces.length === 0) return { class: 'i-cards i-none', children: ['no cards'] };
  return {
    class: `i-cards${bound.hidden ? ' i-hidden' : ''}`, title: bound.hidden ? 'hidden from some seats' : undefined,
    children: faces.map((face) => ({ class: `i-card${RED_SUITS.has(face.suit ?? '') ? ' i-red' : ''}`, children: [showFace(face)] })),
  };
}

export const cardsForm: Form<BoundCards, CardsItem> = { id: 'cards', role: 'component', check, layout, mount, inline };
