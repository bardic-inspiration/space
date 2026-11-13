// The board (spec 8): one three.js scene shared by the three modes. It draws
// the map and lays the ruleset's other instruments out on it; each is drawn
// by its form. Bottom to top: the map, a heatmap, the components, then the
// debug overlay and the selection.
//
// Board `(x, y)` is three's `(x, height, y)`: cell `(x, y)` is the square
// from `(x, y)` to `(x + 1, y + 1)` on the ground plane, with `y` running
// down the screen, so the board reads as a map document's picture does.

import * as THREE from 'three';
import type { HostCall, SpaceMap, State } from '../core.ts';
import type { BoardKit, Drawn, Theme } from '../forms/form.ts';
import { ramp } from '../forms/form.ts';
import type { Instrument, Presentation } from '../present/presentation.ts';
import type { BoardPoint, ItemBase, Pick } from '../present/types.ts';
import { drawOverlay } from './overlay.ts';

export interface BoardPointer {
  type: 'down' | 'move' | 'up';
  point: BoardPoint;
  /** The cell under the pointer, when the map has a grid and the pointer is on it. */
  cell: { x: number; y: number } | null;
  pick: Pick | null;
  shift: boolean;
  alt: boolean;
}

export interface Selection {
  entity?: string;
  cell?: { x: number; y: number };
}

export interface Mark {
  x: number;
  y: number;
  message: string;
}

export interface Heat {
  /** `"x,y"` to a count. */
  cells: Record<string, number>;
  /** The count the top of the color scale stands for; the largest count when absent. */
  max?: number;
}

const HEAT = ['#2f9aa8', '#d9a441', '#b5483a'];
const GLIDE_MS = 180;

const readTheme = (element: HTMLElement): Theme => {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--board', '#ffffff'), plane: read('--plane', '#ffffff'), grid: read('--grid', '#c9ccd1'), ink: read('--ink', '#20242b'),
    muted: read('--muted', '#7d8590'), face: read('--face', '#f4f2ec'), accent: read('--accent', '#3a6fb5'), good: read('--good', '#3f9b6b'),
    bad: read('--bad', '#b5483a'), dim: read('--dim', '#a9adb3'),
  };
};

export class Board {
  readonly element: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly ortho = new THREE.OrthographicCamera();
  private readonly persp = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
  private readonly layers = { instruments: new THREE.Group(), heat: new THREE.Group(), overlay: new THREE.Group(), selection: new THREE.Group(), marks: new THREE.Group(), flashes: new THREE.Group() };
  private theme: Theme;
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly glides = new Map<THREE.Object3D, { from: THREE.Vector3; to: THREE.Vector3; start: number }>();
  private presentation: Presentation | null = null;
  private mounted: { instrument: Instrument; drawn: Drawn<ItemBase>; group: THREE.Group }[] = [];
  private laid: { instrument: Instrument; items: ItemBase[] }[] = [];
  private map: SpaceMap | undefined;
  private state: State | null = null;
  private given: SpaceMap | undefined;
  private readonly hiddenLayers = new Set<string>();
  private selection: Selection | null = null;
  private center = { x: 4, y: 4 };
  /** World units across the height of the view. */
  private span = 10;
  private tilted = false;
  private frame = 0;
  private dirty = true;
  private disposed = false;
  private fitted = '';
  /** Set once the view has been panned or zoomed by hand: a resize then leaves it alone. */
  private manual = false;
  private readonly observer: ResizeObserver;
  private drag: { x: number; y: number; pan: boolean; moved: boolean } | null = null;
  /** Frames drawn, for measuring. */
  frames = 0;

  /** A tool takes the pointer when this returns true; otherwise a drag pans and a click picks. */
  onPointer: ((event: BoardPointer) => boolean) | null = null;
  onPick: ((pick: Pick | null, cell: { x: number; y: number } | null) => void) | null = null;
  onHover: ((label: string | null) => void) | null = null;

  constructor(element: HTMLElement) {
    this.element = element;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = 'board-canvas';
    element.appendChild(this.renderer.domElement);
    this.theme = readTheme(element);
    this.scene.add(new THREE.AmbientLight('#ffffff', 2.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(-6, 14, 8);
    this.scene.add(sun);
    this.scene.add(this.layers.instruments, this.layers.heat, this.layers.flashes, this.layers.overlay, this.layers.selection, this.layers.marks);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(element);
    this.listen();
    this.resize();
  }

  // ── What is shown ───────────────────────────────────────────────────────

  /** Puts a presentation's instruments on the board, each drawn by its form. */
  setPresentation(presentation: Presentation | null): void {
    for (const { drawn, group } of this.mounted) {
      drawn.dispose();
      this.layers.instruments.remove(group);
    }
    this.mounted = [];
    this.laid = [];
    this.presentation = presentation;
    this.state = null;
    if (!presentation) return this.invalidate();
    for (const instrument of presentation.container ? [presentation.container, ...presentation.components] : presentation.components) {
      const group = new THREE.Group();
      this.layers.instruments.add(group);
      this.mounted.push({ instrument, group, drawn: instrument.form.mount(instrument.bound, this.kit(group)) as Drawn<ItemBase> });
    }
    this.invalidate();
  }

  /** Draws one state. `animate` while a match plays; scrubbing and stepping draw the state with no animation. */
  show(state: State, options: { animate?: boolean; map?: SpaceMap | null } = {}): void {
    if (!this.presentation) return;
    this.state = state;
    this.given = options.map ?? undefined;
    this.laid = this.presentation.layout(state, this.given);
    this.map = this.given ?? this.presentation.scenario.mapAt(state);
    for (const { instrument, items } of this.laid) {
      this.mounted.find((mounted) => mounted.instrument === instrument)?.drawn.update(items, { animate: options.animate === true });
    }
    const shape = this.map ? `${this.map.width}x${this.map.height}` : 'none';
    if (shape !== this.fitted) {
      this.fitted = shape;
      this.fit();
    }
    this.drawSelection();
    this.invalidate();
  }

  /** The components the map has no place for: listed in a tray beside the board. */
  tray(): ItemBase[] {
    return this.laid.flatMap(({ instrument, items }) => (instrument.form.role === 'component' ? items.filter((item) => !item.point) : []));
  }

  setLayerHidden(layer: string, hidden: boolean): void {
    if (hidden) this.hiddenLayers.add(layer);
    else this.hiddenLayers.delete(layer);
    this.redraw();
  }

  /** Draws the host calls of a candidate, a gate or a domain (spec 8.1). */
  setOverlay(calls: HostCall[] | null): void {
    this.clear(this.layers.overlay);
    if (calls && this.map) drawOverlay(this.layers.overlay, calls, this.map, this.kit(this.layers.overlay));
    this.invalidate();
  }

  setHeatmap(heat: Heat | null): void {
    this.clear(this.layers.heat);
    const entries = Object.entries(heat?.cells ?? {});
    if (entries.length > 0) {
      const top = heat!.max ?? Math.max(...entries.map(([, count]) => count));
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.72, depthWrite: false }), entries.length);
      const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
      const matrix = new THREE.Matrix4();
      entries.forEach(([key, count], index) => {
        const [x, y] = key.split(',').map(Number);
        mesh.setMatrixAt(index, matrix.compose(new THREE.Vector3(x + 0.5, 0.03, y + 0.5), flat, new THREE.Vector3(1, 1, 1)));
        mesh.setColorAt(index, new THREE.Color(ramp(HEAT, top === 0 ? 0 : count / top)));
      });
      this.layers.heat.add(mesh);
    }
    this.invalidate();
  }

  setSelection(selection: Selection | null): void {
    this.selection = selection;
    this.drawSelection();
    this.invalidate();
  }

  /** Marks cells with a message: a cell that fails a `space.checks` rule, in the map editor. */
  setMarks(marks: Mark[]): void {
    this.clear(this.layers.marks);
    for (const mark of marks) {
      this.layers.marks.add(this.outline(mark.x, mark.y, mark.x + 1, mark.y + 1, this.theme.bad, 0.08));
      const label = this.kit(this.layers.marks).label('!', { size: 0.5, color: this.theme.bad });
      label.position.set(mark.x + 0.5, 0.3, mark.y + 0.5);
      this.layers.marks.add(label);
    }
    this.invalidate();
  }

  /** Reads the theme's CSS variables again and redraws with them. */
  refreshTheme(): void {
    this.theme = readTheme(this.element);
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    const presentation = this.presentation;
    const state = this.state;
    this.setPresentation(presentation);
    if (state) this.show(state, { map: this.given });
  }

  private redraw(): void {
    if (this.state) this.show(this.state, { map: this.given });
  }

  // ── The camera ──────────────────────────────────────────────────────────

  /** Fits the whole map in view. */
  fit(): void {
    const map = this.map;
    const width = map?.width ?? 8;
    const height = map?.height ?? 8;
    const aspect = this.aspect();
    this.manual = false;
    this.center = { x: width / 2, y: height / 2 };
    this.span = Math.max(height + 1.5, (width + 1.5) / aspect);
    this.invalidate();
  }

  setTilt(tilted: boolean): void {
    this.tilted = tilted;
    this.invalidate();
  }

  get tilt(): boolean {
    return this.tilted;
  }

  private aspect(): number {
    return Math.max(0.1, this.element.clientWidth / Math.max(1, this.element.clientHeight));
  }

  private camera(): THREE.Camera {
    const aspect = this.aspect();
    const { x, y } = this.center;
    if (this.tilted) {
      const distance = this.span / (2 * Math.tan((this.persp.fov * Math.PI) / 360));
      this.persp.aspect = aspect;
      this.persp.position.set(x, distance * 0.78, y + distance * 0.62);
      this.persp.up.set(0, 1, 0);
      this.persp.lookAt(x, 0, y);
      this.persp.updateProjectionMatrix();
      return this.persp;
    }
    this.ortho.left = (-this.span * aspect) / 2;
    this.ortho.right = (this.span * aspect) / 2;
    this.ortho.top = this.span / 2;
    this.ortho.bottom = -this.span / 2;
    this.ortho.near = 0.1;
    this.ortho.far = 500;
    this.ortho.position.set(x, 100, y);
    this.ortho.up.set(0, 0, -1);
    this.ortho.lookAt(x, 0, y);
    this.ortho.updateProjectionMatrix();
    return this.ortho;
  }

  /** The point of the ground under a pointer position. */
  private ground(clientX: number, clientY: number): BoardPoint | null {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, this.camera());
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return hit ? { x: hit.x, y: hit.z } : null;
  }

  /** Where a board point is on the page, for a test or a tooltip. */
  toClient(point: BoardPoint): { x: number; y: number } {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const projected = new THREE.Vector3(point.x, 0, point.y).project(this.camera());
    return { x: bounds.left + ((projected.x + 1) / 2) * bounds.width, y: bounds.top + ((1 - projected.y) / 2) * bounds.height };
  }

  // ── Picking ─────────────────────────────────────────────────────────────

  private cellAt(point: BoardPoint): { x: number; y: number } | null {
    const map = this.map;
    if (!map || map.grid !== 'square') return null;
    const cell = { x: Math.floor(point.x), y: Math.floor(point.y) };
    return cell.x >= 0 && cell.y >= 0 && cell.x < map.width && cell.y < map.height ? cell : null;
  }

  /** What lies at a point: the topmost component there, else something of the map. */
  pickAt(point: BoardPoint): Pick | null {
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const pick = this.mounted[i].drawn.pick(point);
      if (pick) return pick;
    }
    return null;
  }

  /** Where an entity's instrument lies, for the selection ring. */
  private pointOf(entity: string): BoardPoint | null {
    for (const { items } of this.laid) {
      const item = items.find((candidate) => candidate.entity === entity && candidate.point);
      if (item) return item.point;
    }
    return null;
  }

  private drawSelection(): void {
    this.clear(this.layers.selection);
    const selection = this.selection;
    if (!selection) return;
    if (selection.cell) this.layers.selection.add(this.outline(selection.cell.x, selection.cell.y, selection.cell.x + 1, selection.cell.y + 1, this.theme.accent, 0.07));
    const point = selection.entity === undefined ? null : this.pointOf(selection.entity);
    if (point) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.54, 40), new THREE.MeshBasicMaterial({ color: this.theme.accent, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(point.x, 0.07, point.y);
      this.layers.selection.add(ring);
    }
  }

  private outline(x0: number, y0: number, x1: number, y1: number, color: string, height: number): THREE.Object3D {
    const group = new THREE.Group();
    const t = 0.07;
    const material = new THREE.MeshBasicMaterial({ color });
    for (const [x, y, w, h] of [[x0, y0, x1 - x0, t], [x0, y1 - t, x1 - x0, t], [x0, y0, t, y1 - y0], [x1 - t, y0, t, y1 - y0]]) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
      bar.rotation.x = -Math.PI / 2;
      bar.position.set(x + w / 2, height, y + h / 2);
      group.add(bar);
    }
    return group;
  }

  private listen(): void {
    const canvas = this.renderer.domElement;
    const describe = (event: PointerEvent, type: BoardPointer['type']): BoardPointer | null => {
      const point = this.ground(event.clientX, event.clientY);
      return point && { type, point, cell: this.cellAt(point), pick: this.pickAt(point), shift: event.shiftKey, alt: event.altKey };
    };
    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      const described = describe(event, 'down');
      const taken = event.button === 0 && described !== null && this.onPointer?.(described) === true;
      this.drag = { x: event.clientX, y: event.clientY, pan: !taken, moved: false };
    });
    canvas.addEventListener('pointermove', (event) => {
      const described = describe(event, 'move');
      if (!this.drag) {
        const cell = described?.cell;
        this.onHover?.(described?.pick?.label ?? (cell ? `(${cell.x}, ${cell.y})` : null));
        return;
      }
      if (Math.hypot(event.clientX - this.drag.x, event.clientY - this.drag.y) > 3) this.drag.moved = true;
      if (!this.drag.pan) {
        if (described) this.onPointer?.(described);
        return;
      }
      if (!this.drag.moved) return;
      this.manual = true;
      const perPixel = this.span / Math.max(1, this.element.clientHeight);
      this.center = { x: this.center.x - event.movementX * perPixel, y: this.center.y - event.movementY * perPixel };
      this.invalidate();
    });
    canvas.addEventListener('pointerup', (event) => {
      const drag = this.drag;
      this.drag = null;
      const described = describe(event, 'up');
      if (!drag) return;
      if (!drag.pan) {
        if (described) this.onPointer?.(described);
      } else if (!drag.moved && event.button === 0) this.onPick?.(described?.pick ?? null, described?.cell ?? null);
    });
    canvas.addEventListener('pointerleave', () => this.onHover?.(null));
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const before = this.ground(event.clientX, event.clientY);
      this.manual = true;
      this.span = Math.min(400, Math.max(2, this.span * Math.exp(event.deltaY * 0.0012)));
      // Zoom about the pointer: the ground under it stays under it.
      const after = this.ground(event.clientX, event.clientY);
      if (before && after) this.center = { x: this.center.x + before.x - after.x, y: this.center.y + before.y - after.y };
      this.invalidate();
    }, { passive: false });
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  private kit(group: THREE.Group): BoardKit {
    return {
      group,
      theme: () => this.theme,
      layerHidden: (layer) => this.hiddenLayers.has(layer),
      texture: (key, width, height, paint) => this.texture(key, width, height, paint),
      label: (text, options = {}) => {
        const size = options.size ?? 0.3;
        const color = options.color ?? this.theme.ink;
        const pixels = 44;
        const measure = document.createElement('canvas').getContext('2d')!;
        measure.font = `600 ${pixels}px system-ui, sans-serif`;
        const width = Math.ceil(measure.measureText(text).width) + 20;
        const texture = this.texture(`label|${text}|${color}|${options.plate ?? ''}`, width, pixels + 16, (context, w, h) => {
          context.clearRect(0, 0, w, h);
          if (options.plate) {
            context.globalAlpha = 0.78;
            context.fillStyle = options.plate;
            context.beginPath();
            context.roundRect(0, 0, w, h, 12);
            context.fill();
            context.globalAlpha = 1;
          }
          context.font = `600 ${pixels}px system-ui, sans-serif`;
          context.fillStyle = color;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(text, w / 2, h / 2 + 2);
        });
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
        sprite.scale.set((size * width) / (pixels + 16), size, 1);
        sprite.renderOrder = 10;
        return sprite;
      },
      glide: (object, to, animate) => {
        const target = new THREE.Vector3(to.x, to.y, to.z);
        if (!animate || object.position.distanceTo(target) < 0.001) {
          this.glides.delete(object);
          object.position.copy(target);
        } else this.glides.set(object, { from: object.position.clone(), to: target, start: performance.now() });
        this.invalidate();
      },
      flash: (cell) => {
        const square = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: this.theme.accent, transparent: true, opacity: 0.8, depthWrite: false }));
        square.rotation.x = -Math.PI / 2;
        square.position.set(cell.x + 0.5, 0.7, cell.y + 0.5);
        square.userData.born = performance.now();
        this.layers.flashes.add(square);
        this.invalidate();
      },
    };
  }

  private texture(key: string, width: number, height: number, paint: (context: CanvasRenderingContext2D, width: number, height: number) => void): THREE.Texture {
    let texture = this.textures.get(key);
    if (!texture) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      paint(canvas.getContext('2d')!, width, height);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(key, texture);
    }
    return texture;
  }

  private clear(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((one) => one.dispose());
        else material?.dispose();
      });
    }
  }

  private resize(): void {
    const width = Math.max(1, this.element.clientWidth);
    const height = Math.max(1, this.element.clientHeight);
    this.renderer.setSize(width, height, false);
    if (!this.manual) this.fit();
    this.invalidate();
  }

  /** Asks for a frame. Nothing is drawn while nothing changes. */
  invalidate(): void {
    this.dirty = true;
    if (this.frame === 0 && !this.disposed) this.frame = requestAnimationFrame((now) => this.tick(now));
  }

  private tick(now: number): void {
    this.frame = 0;
    if (this.disposed) return;
    let moving = false;
    for (const [object, glide] of this.glides) {
      const t = Math.min(1, (now - glide.start) / GLIDE_MS);
      object.position.lerpVectors(glide.from, glide.to, t * (2 - t));
      if (t >= 1) this.glides.delete(object);
      else moving = true;
    }
    for (const flash of [...this.layers.flashes.children] as THREE.Mesh[]) {
      const age = (now - (flash.userData.born as number)) / 600;
      if (age >= 1) {
        this.layers.flashes.remove(flash);
        flash.geometry.dispose();
        (flash.material as THREE.Material).dispose();
      } else {
        (flash.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - age);
        moving = true;
      }
    }
    // A stack that grew or shrank settles to its new height.
    this.layers.instruments.traverse((object) => {
      if (!object.userData.settle) return;
      object.scale.y += (1 - object.scale.y) * 0.3;
      if (Math.abs(1 - object.scale.y) < 0.01) {
        object.scale.y = 1;
        object.userData.settle = false;
      } else moving = true;
    });
    if (this.dirty || moving) {
      this.dirty = false;
      this.renderer.setClearColor(this.theme.background);
      this.renderer.render(this.scene, this.camera());
      this.frames += 1;
    }
    if (moving) this.frame = requestAnimationFrame((next) => this.tick(next));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.setPresentation(null);
    for (const group of Object.values(this.layers)) this.clear(group);
    for (const texture of this.textures.values()) texture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
