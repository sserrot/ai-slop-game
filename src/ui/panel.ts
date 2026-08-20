/**
 * ISS — in-world puzzle panels (DESIGN.md §6).
 *
 * "Puzzle panels rendered in-world — but as `CanvasTexture`, not
 * render-to-texture of a second 3D scene. These are gauges, needles and
 * breakers: draw them with the 2D canvas API and update at 10 Hz only while a
 * player is in the module."
 *
 * That is exactly what this file is. A `Panel` owns one offscreen 2D canvas, one
 * `CanvasTexture` and one plane mesh; a `PanelSystem` owns the set of them and
 * decides which are allowed to redraw this frame. A panel that nobody is
 * standing in front of costs zero — no canvas work, no texture upload.
 *
 * The puzzle layer supplies `draw(ctx, state)` and nothing else. Everything
 * below `draw` — the housing, the bezel, the scanlines, the 10 Hz throttle, the
 * texture upload — happens here, so all six puzzles look like they were bolted
 * to the same station by the same contractor.
 *
 * Panel-space coordinates are canvas pixels with the origin top-left. Raycast
 * the mesh, take `intersection.uv`, and `uvToCanvas()` / `regionAt()` turn it
 * into "the player just poked breaker 4".
 */

import * as THREE from 'three';
import { PANEL_UPDATE_HZ } from '@shared/constants';
import type { ModuleId, Quat, Vec3 } from '@shared/types';
import { bus as sharedBus, type EventBus, type GameEvents, type Unsubscribe } from '../core/eventBus';
import { UI_COLORS, clamp01, uiFont } from './theme';

// ===========================================================================
// Draw callback contract
// ===========================================================================

/** Per-frame context handed to a panel's `draw`. */
export interface PanelFrame {
  /** Canvas width in panel pixels. */
  width: number;
  /** Canvas height in panel pixels. */
  height: number;
  /** Seconds since the panel system started — for blinking lamps and needles. */
  time: number;
  /** Seconds since this panel last redrew. */
  dt: number;
  /** Redraw counter; 0 on the very first draw. */
  frame: number;
}

/**
 * What a puzzle implements. Draw the whole panel every call — the canvas is
 * cleared and the housing redrawn before you are invoked.
 */
export type PanelDraw<S> = (ctx: CanvasRenderingContext2D, state: S, frame: PanelFrame) => void;

export interface PanelRegion {
  id: string;
  /** Panel-pixel rect. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelOptions<S> {
  /** Stable id. Defaults to `panel-<n>`; use the PuzzleId when there is one. */
  id?: string;
  /** Module this panel physically lives in — drives the 10 Hz activity gate. */
  module: ModuleId;
  /** Plane size in metres. */
  width: number;
  height: number;
  /** Canvas resolution. Default 640 px/m — legible at arm's length, and at
   *  10 Hz on six panels it is nothing. Clamped to 64…2048 px per axis. */
  pixelsPerMetre?: number;
  /** Initial state object handed to `draw` unchanged. */
  state: S;
  draw: PanelDraw<S>;
  /** Draw the standard housing (background, bezel, title, scanlines). Default true. */
  chrome?: boolean;
  /** Label printed into the bezel when `chrome` is on. */
  title?: string;
  /** World placement. The integrator may instead parent `panel.mesh` itself. */
  position?: Vec3;
  quaternion?: Quat;
  /** Redraw rate while active. Defaults to PANEL_UPDATE_HZ (10). */
  hz?: number;
}

let panelSerial = 0;

// ===========================================================================
// Panel
// ===========================================================================

export class Panel<S = unknown> {
  readonly id: string;
  readonly module: ModuleId;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshBasicMaterial;
  readonly geometry: THREE.PlaneGeometry;
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Canvas pixel size — panel-space coordinates run 0..width, 0..height. */
  readonly width: number;
  readonly height: number;
  /** Seconds between redraws while active. */
  readonly period: number;

  private readonly drawFn: PanelDraw<S>;
  /** The one `PanelFrame` handed to `drawFn`, refilled per redraw. Read it
   *  inside the draw callback; nothing may keep it. */
  private readonly drawFrame: PanelFrame = { width: 0, height: 0, time: 0, dt: 0, frame: 0 };
  private readonly chrome: boolean;
  private readonly title: string;
  private readonly regions: PanelRegion[] = [];

  private _state: S;
  private _active = false;
  private dirty = true;
  private sinceDraw = 0;
  private lastDrawTime = 0;
  private frameCount = 0;
  private disposed = false;

  constructor(opts: PanelOptions<S>) {
    this.id = opts.id ?? `panel-${++panelSerial}`;
    this.module = opts.module;
    this.drawFn = opts.draw;
    this.chrome = opts.chrome ?? true;
    this.title = opts.title ?? '';
    this._state = opts.state;

    const ppm = opts.pixelsPerMetre ?? 640;
    this.width = Math.max(64, Math.min(2048, Math.round(opts.width * ppm)));
    this.height = Math.max(64, Math.min(2048, Math.round(opts.height * ppm)));
    this.period = 1 / (opts.hz ?? PANEL_UPDATE_HZ);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error(`[ui] panel ${this.id}: 2D context unavailable`);
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    this.material = new THREE.MeshBasicMaterial({ map: this.texture });
    // Panels are their own light source in a dark module (§9 "emissive strips"),
    // and bloom should see them at full strength.
    this.material.toneMapped = false;

    this.geometry = new THREE.PlaneGeometry(opts.width, opts.height);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = `panel:${this.id}`;
    this.mesh.userData.panelId = this.id;
    this.mesh.userData.module = this.module;
    this.mesh.frustumCulled = true;
    if (opts.position) this.mesh.position.set(opts.position.x, opts.position.y, opts.position.z);
    if (opts.quaternion) {
      const q = opts.quaternion;
      this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }

    // First paint immediately, so a panel is never a blank white plane even if
    // the player is standing in the doorway when the round starts.
    this.redraw(0, true);
  }

  // ------------------------------------------------------------------ state --

  get state(): S {
    return this._state;
  }

  /** Replace the state wholesale (server snapshots arrive this way). */
  setState(next: S): void {
    this._state = next;
    this.dirty = true;
  }

  /** Merge a partial update into an object state. */
  patch(part: Partial<S>): void {
    if (this._state !== null && typeof this._state === 'object') {
      Object.assign(this._state as object, part);
    }
    this.dirty = true;
  }

  /** Force a redraw on the next update even if the state object is unchanged. */
  invalidate(): void {
    this.dirty = true;
  }

  // ----------------------------------------------------------------- regions --

  /**
   * Register a clickable rect in panel pixels. The interaction raycaster can
   * then ask `regionAt(uv)` which control the player is pointing at.
   */
  addRegion(id: string, x: number, y: number, w: number, h: number): PanelRegion {
    const region: PanelRegion = { id, x, y, w, h };
    this.regions.push(region);
    return region;
  }

  clearRegions(): void {
    this.regions.length = 0;
  }

  /** UV from a raycast hit → panel pixels (origin top-left). */
  uvToCanvas(uv: { x: number; y: number }): { x: number; y: number } {
    return { x: uv.x * this.width, y: (1 - uv.y) * this.height };
  }

  /** Region under a raycast UV, or null. */
  regionAt(uv: { x: number; y: number }): PanelRegion | null {
    const p = this.uvToCanvas(uv);
    for (const r of this.regions) {
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r;
    }
    return null;
  }

  // ------------------------------------------------------------------ active --

  get active(): boolean {
    return this._active;
  }

  /**
   * A panel only draws while a player is in its module (§6). Becoming active
   * redraws immediately so you never walk in on a stale gauge.
   */
  setActive(active: boolean): void {
    if (active === this._active) return;
    this._active = active;
    if (active) this.dirty = true;
  }

  // ------------------------------------------------------------------ frame --

  /**
   * Called by PanelSystem once per rendered frame. Returns true if it redrew.
   * `now` is seconds.
   */
  update(now: number, dt: number): boolean {
    if (this.disposed || !this._active) return false;
    this.sinceDraw += dt;
    if (this.sinceDraw < this.period) return false;
    this.redraw(now, false);
    return true;
  }

  /** Draw right now, regardless of the throttle. */
  redraw(now: number, force: boolean): void {
    if (this.disposed) return;
    if (!force && !this._active) return;
    const dt = this.frameCount === 0 ? 0 : Math.max(0, now - this.lastDrawTime);
    this.lastDrawTime = now;
    this.sinceDraw = 0;
    this.dirty = false;

    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.chrome) {
      panelBackground(ctx, this.width, this.height);
      panelBezel(ctx, this.width, this.height, this.title);
    }
    ctx.restore();

    ctx.save();
    try {
      // Refilled, not rebuilt: the draw callback reads it and returns, and this
      // runs for every active panel at its own period for the whole round.
      const frameInfo = this.drawFrame;
      frameInfo.width = this.width;
      frameInfo.height = this.height;
      frameInfo.time = now;
      frameInfo.dt = dt;
      frameInfo.frame = this.frameCount;
      this.drawFn(ctx, this._state, frameInfo);
    } catch (err) {
      console.error(`[ui] panel '${this.id}' draw threw:`, err);
    }
    ctx.restore();

    if (this.chrome) {
      ctx.save();
      panelScanlines(ctx, this.width, this.height);
      ctx.restore();
    }

    this.frameCount++;
    this.texture.needsUpdate = true;
  }

  /** Place the plane in world space (plain Vec3/Quat, not THREE types). */
  setTransform(position: Vec3, quaternion?: Quat): void {
    this.mesh.position.set(position.x, position.y, position.z);
    if (quaternion) this.mesh.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

// ===========================================================================
// PanelSystem
// ===========================================================================

export interface PanelSystemOptions {
  /** Bus for `module:entered`. Pass `null` to drive activity manually. */
  bus?: EventBus<GameEvents> | null;
  /** Module the local player starts in, if known. */
  module?: ModuleId | null;
}

export class PanelSystem {
  /** Add this once to the scene; every panel mesh parents into it. */
  readonly group: THREE.Group;

  private readonly panels = new Map<string, Panel<never>>();
  private readonly unsubscribe: Unsubscribe | null;
  private playerModule: ModuleId | null;
  private lastNowMs = -1;
  private elapsed = 0;

  constructor(opts: PanelSystemOptions = {}) {
    this.group = new THREE.Group();
    this.group.name = 'puzzle-panels';
    this.playerModule = opts.module ?? null;

    const bus = opts.bus === undefined ? sharedBus : opts.bus;
    this.unsubscribe = bus
      ? bus.on('module:entered', ({ module }) => this.setPlayerModule(module))
      : null;
  }

  /** Build a panel, parent its mesh into `group`, and track it. */
  create<S>(opts: PanelOptions<S>): Panel<S> {
    const panel = new Panel<S>(opts);
    this.add(panel);
    return panel;
  }

  add<S>(panel: Panel<S>): void {
    if (this.panels.has(panel.id)) {
      throw new Error(`[ui] duplicate panel id '${panel.id}'`);
    }
    this.panels.set(panel.id, panel as unknown as Panel<never>);
    this.group.add(panel.mesh);
    panel.setActive(panel.module === this.playerModule);
  }

  get<S = unknown>(id: string): Panel<S> | undefined {
    return this.panels.get(id) as unknown as Panel<S> | undefined;
  }

  all(): Panel<never>[] {
    return [...this.panels.values()];
  }

  byModule(module: ModuleId): Panel<never>[] {
    return this.all().filter((p) => p.module === module);
  }

  remove(id: string): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    this.panels.delete(id);
    panel.dispose();
  }

  /** The local player moved. Only panels in this module are allowed to draw. */
  setPlayerModule(module: ModuleId | null): void {
    if (module === this.playerModule) return;
    this.playerModule = module;
    for (const panel of this.panels.values()) panel.setActive(panel.module === module);
  }

  get currentModule(): ModuleId | null {
    return this.playerModule;
  }

  /** Panel meshes the raycaster should test — only the ones actually live. */
  activeMeshes(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const panel of this.panels.values()) if (panel.active) out.push(panel.mesh);
    return out;
  }

  /** Resolve a raycast hit back to the panel that owns it. */
  panelForObject(object: THREE.Object3D): Panel<never> | undefined {
    const id = object.userData?.panelId;
    return typeof id === 'string' ? this.panels.get(id) : undefined;
  }

  /** Call once per rendered frame with `performance.now()`. */
  update(nowMs: number): void {
    const dt = this.lastNowMs < 0 ? 0 : Math.min(0.25, (nowMs - this.lastNowMs) / 1000);
    this.lastNowMs = nowMs;
    this.elapsed += dt;
    for (const panel of this.panels.values()) panel.update(this.elapsed, dt);
  }

  dispose(): void {
    this.unsubscribe?.();
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
    this.group.removeFromParent();
  }
}

// ===========================================================================
// Drawing toolkit — the house style, so six puzzles look like one station
// ===========================================================================

/**
 * Gradients cached per context and height.
 *
 * A `CanvasGradient` is an object, `createLinearGradient` mints one, and the
 * housing is repainted on every panel redraw — eleven panels at their own
 * period, forever. The gradient is a pure function of `h` and its three stops
 * are constants, so the cached one is the identical object the call would have
 * produced. Keyed per context (a gradient belongs to the context that made it)
 * through a WeakMap, so a disposed panel's entry goes with it.
 */
const BACKGROUND_GRADIENTS = new WeakMap<CanvasRenderingContext2D, Map<number, CanvasGradient>>();

/** Brushed dark housing with a subtle vertical gradient. */
export function panelBackground(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  let byHeight = BACKGROUND_GRADIENTS.get(ctx);
  if (!byHeight) {
    byHeight = new Map();
    BACKGROUND_GRADIENTS.set(ctx, byHeight);
  }
  let grad = byHeight.get(h);
  if (!grad) {
    grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0a1310');
    grad.addColorStop(0.5, '#060d0a');
    grad.addColorStop(1, '#030605');
    byHeight.set(h, grad);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

/** Screwed-down bezel, corner ticks and an optional stencilled title. */
export function panelBezel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  title = '',
): void {
  ctx.strokeStyle = UI_COLORS.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(4, 4, w - 8, h - 8);

  ctx.strokeStyle = UI_COLORS.lineFaint;
  ctx.lineWidth = 1;
  ctx.strokeRect(11, 11, w - 22, h - 22);

  const tick = Math.min(22, w * 0.06);
  ctx.strokeStyle = UI_COLORS.greenDim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  // Unrolled from a nested array literal — five arrays per redraw, per panel,
  // for four corners that never change. Same four corners, same order.
  for (let i = 0; i < 4; i++) {
    const cx = i === 1 || i === 3 ? w - 4 : 4;
    const cy = i >= 2 ? h - 4 : 4;
    const sx = i === 1 || i === 3 ? -1 : 1;
    const sy = i >= 2 ? -1 : 1;
    ctx.moveTo(cx + sx * tick, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy * tick);
  }
  ctx.stroke();

  if (title) {
    const size = Math.max(11, Math.round(h * 0.045));
    ctx.font = uiFont(size, 'bold');
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(title.toUpperCase(), 18, 17);
    ctx.strokeStyle = UI_COLORS.lineFaint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(18, 20 + size * 1.35);
    ctx.lineTo(w - 18, 20 + size * 1.35);
    ctx.stroke();
  }
}

/** CRT wash. Cheap, and it sells "this thing was installed in 1998". */
export function panelScanlines(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#000000';
  for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2);
  ctx.globalAlpha = 1;
}

export interface PanelTextOptions {
  size?: number;
  color?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  bold?: boolean;
  glow?: boolean;
}

/** Stencilled label in the house font. */
export function panelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: PanelTextOptions = {},
): void {
  ctx.save();
  ctx.font = uiFont(opts.size ?? 16, opts.bold ? 'bold' : 'normal');
  ctx.fillStyle = opts.color ?? UI_COLORS.text;
  ctx.textAlign = opts.align ?? 'left';
  ctx.textBaseline = opts.baseline ?? 'alphabetic';
  if (opts.glow) {
    ctx.shadowColor = opts.color ?? UI_COLORS.green;
    ctx.shadowBlur = (opts.size ?? 16) * 0.6;
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

export interface GaugeOptions {
  x: number;
  y: number;
  radius: number;
  /** Current reading. */
  value: number;
  min?: number;
  max?: number;
  /** Highlighted target band, e.g. the coolant valve's green band (§11 #2). */
  band?: [number, number];
  label?: string;
  /** Printed under the needle. Pass '' to suppress. */
  readout?: string;
  ticks?: number;
  color?: string;
}

/**
 * A 240° analogue gauge with a needle. This is puzzle 2's pressure gauge, and
 * it is the reason the panel system exists: one player reads the needle while
 * the other, in another module, turns a wheel they cannot see the effect of.
 */
export function panelGauge(ctx: CanvasRenderingContext2D, opts: GaugeOptions): void {
  const { x, y, radius } = opts;
  const min = opts.min ?? 0;
  const max = opts.max ?? 1;
  const start = Math.PI * 0.75;
  const sweep = Math.PI * 1.5;
  const norm = clamp01((opts.value - min) / (max - min || 1));
  const color = opts.color ?? UI_COLORS.green;

  ctx.save();
  // Dial face.
  ctx.fillStyle = '#020504';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Target band.
  if (opts.band) {
    const b0 = clamp01((opts.band[0] - min) / (max - min || 1));
    const b1 = clamp01((opts.band[1] - min) / (max - min || 1));
    ctx.strokeStyle = 'rgba(77, 255, 155, 0.30)';
    ctx.lineWidth = radius * 0.18;
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.78, start + sweep * b0, start + sweep * b1);
    ctx.stroke();
  }

  // Arc + ticks.
  ctx.strokeStyle = UI_COLORS.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.88, start, start + sweep);
  ctx.stroke();

  const ticks = opts.ticks ?? 10;
  ctx.strokeStyle = UI_COLORS.textDim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= ticks; i++) {
    const a = start + sweep * (i / ticks);
    const major = i % 5 === 0;
    const r0 = radius * (major ? 0.7 : 0.78);
    ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
    ctx.lineTo(x + Math.cos(a) * radius * 0.88, y + Math.sin(a) * radius * 0.88);
  }
  ctx.stroke();

  // Needle.
  const angle = start + sweep * norm;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, radius * 0.055);
  ctx.lineCap = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = radius * 0.35;
  ctx.beginPath();
  ctx.moveTo(x - Math.cos(angle) * radius * 0.12, y - Math.sin(angle) * radius * 0.12);
  ctx.lineTo(x + Math.cos(angle) * radius * 0.74, y + Math.sin(angle) * radius * 0.74);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.07, 0, Math.PI * 2);
  ctx.fill();

  if (opts.label) {
    panelText(ctx, opts.label, x, y + radius * 0.44, {
      size: radius * 0.16,
      color: UI_COLORS.textDim,
      align: 'center',
      baseline: 'middle',
    });
  }
  if (opts.readout) {
    panelText(ctx, opts.readout, x, y + radius * 0.72, {
      size: radius * 0.22,
      color,
      align: 'center',
      baseline: 'middle',
      bold: true,
    });
  }
  ctx.restore();
}

export interface BarOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0–1. */
  value: number;
  color?: string;
  label?: string;
  /** Draw as discrete cells rather than a continuous fill. */
  segments?: number;
}

/** Horizontal meter — hand-pump progress, pry timer, charge level. */
export function panelBar(ctx: CanvasRenderingContext2D, opts: BarOptions): void {
  const { x, y, w, h } = opts;
  const v = clamp01(opts.value);
  const color = opts.color ?? UI_COLORS.green;
  ctx.save();
  ctx.strokeStyle = UI_COLORS.line;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, w, h);
  if (opts.segments && opts.segments > 1) {
    const n = opts.segments;
    const gap = 3;
    const cell = (w - 6 - gap * (n - 1)) / n;
    const lit = Math.round(v * n);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i < lit ? color : 'rgba(77, 255, 155, 0.08)';
      ctx.fillRect(x + 3 + i * (cell + gap), y + 3, cell, h - 6);
    }
  } else {
    ctx.fillStyle = 'rgba(77, 255, 155, 0.08)';
    ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    ctx.fillStyle = color;
    ctx.fillRect(x + 2, y + 2, (w - 4) * v, h - 4);
  }
  if (opts.label) {
    panelText(ctx, opts.label, x, y - 6, { size: h * 0.6, color: UI_COLORS.textDim });
  }
  ctx.restore();
}

/** Indicator lamp. `on` lit and glowing, off is a dark lens with a rim. */
export function panelLamp(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  on: boolean,
  color: string = UI_COLORS.green,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = on ? color : 'rgba(255,255,255,0.05)';
  if (on) {
    ctx.shadowColor = color;
    ctx.shadowBlur = radius * 1.6;
  }
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = on ? color : UI_COLORS.line;
  ctx.stroke();
  ctx.restore();
}

export interface SwitchOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  on: boolean;
  label?: string;
  /** Highlight ring — "the raycaster is pointing at this one". */
  focused?: boolean;
  color?: string;
}

/** Breaker toggle — puzzle 1's six switches, and any other physical lever. */
export function panelSwitch(ctx: CanvasRenderingContext2D, opts: SwitchOptions): void {
  const { x, y, w, h } = opts;
  const color = opts.color ?? (opts.on ? UI_COLORS.green : UI_COLORS.amberDim);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = opts.focused ? UI_COLORS.amber : UI_COLORS.line;
  ctx.lineWidth = opts.focused ? 2.5 : 1.5;
  ctx.strokeRect(x, y, w, h);

  // The lever itself sits at the top when thrown.
  const inset = w * 0.22;
  const leverH = h * 0.42;
  const leverY = opts.on ? y + h * 0.08 : y + h - leverH - h * 0.08;
  ctx.fillStyle = color;
  if (opts.on) {
    ctx.shadowColor = color;
    ctx.shadowBlur = w * 0.5;
  }
  ctx.fillRect(x + inset, leverY, w - inset * 2, leverH);
  ctx.shadowBlur = 0;

  if (opts.label) {
    panelText(ctx, opts.label, x + w / 2, y + h + h * 0.24, {
      size: Math.max(10, w * 0.34),
      color: UI_COLORS.textDim,
      align: 'center',
      baseline: 'middle',
    });
  }
  ctx.restore();
}

/** Big status word across the panel — SOLVED / LOCKED / FAULT. */
export function panelBanner(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  text: string,
  color: string = UI_COLORS.green,
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(2, 6, 4, 0.72)';
  ctx.fillRect(0, h * 0.4, w, h * 0.2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.4);
  ctx.lineTo(w, h * 0.4);
  ctx.moveTo(0, h * 0.6);
  ctx.lineTo(w, h * 0.6);
  ctx.stroke();
  panelText(ctx, text, w / 2, h * 0.5, {
    size: Math.min(w * 0.13, h * 0.11),
    color,
    align: 'center',
    baseline: 'middle',
    bold: true,
    glow: true,
  });
  ctx.restore();
}
