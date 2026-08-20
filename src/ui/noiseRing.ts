/**
 * ISS — noise ring (DESIGN.md §6).
 *
 * "A ring around the crosshair that expands on every sound you emit, scaled to
 * how far it actually carried. This is the tutorial; no text needed."
 *
 * So: no text, no numbers, no units. One ripple per sound. Radius encodes reach
 * in metres; colour encodes the loudness band you learn by ear (quiet green,
 * amber, alarming red). A rail pull is a dim flicker at the reticle. A decoy
 * fills the screen. Nobody has to be told what that means.
 *
 * The reach reference is derived, not invented: the loudest thing in the game
 * (a decoy, 70) dies at the audibility floor after `(70 - FLOOR) / 1.0` = 68 m,
 * so 68 m is a full-screen ring and every other sound is a fraction of it.
 *
 * A tutorial has to teach the real rules, which means the ring must ripple when
 * the ALIEN heard something, not when the client thought it did. Most sounds are
 * the same either way — you pull a rail, the client rings instantly (§8: "you
 * have to feel the mistake as you make it") and the server broadcasts the same
 * event. Two kinds are not:
 *
 *   breathing   the server runs its own heart-rate model and its own breath
 *               clock (§6). `src/player/heartRate.ts` runs a different curve at
 *               a different rate, and its breaths are never sent — so a ripple
 *               from it is a lie in both directions: it ripples on breaths the
 *               alien never heard, and stays flat on the ones it did.
 *   voice       the server derives loudness from the calibrated `voiceLevel`
 *               stream on its own gate and interval (§7), not from the local
 *               mic envelope.
 *
 * For those two the ring waits for the server's own broadcast of our own event.
 * With no server at all (the offline sandbox) the local emitter is the only
 * model there is, so it drives the ring exactly as before.
 */

import { ATTENUATION_PER_M, FLOOR, LOUDNESS } from '@shared/constants';
import type { NoiseEvent, NoiseKind, PlayerId } from '@shared/types';
import { bus as sharedBus, type EventBus, type GameEvents, type Unsubscribe } from '../core/eventBus';
import { HiDpiCanvas } from './dom';
import { loudnessRgba } from './theme';

/** Metres at which a ripple reaches the outer edge of the ring canvas. */
export const NOISE_RING_REFERENCE_M = (LOUDNESS.DECOY - FLOOR) / ATTENUATION_PER_M;

/**
 * Kinds whose cadence and loudness the SERVER owns outright, so the client's
 * local emission of them is an estimate the alien never hears.
 */
const SERVER_CLOCKED: ReadonlySet<NoiseKind> = new Set<NoiseKind>(['breathing', 'voice']);

/**
 * Free-space reach of a sound: the distance at which it decays to the §3
 * audibility floor. Used for server broadcasts, which carry source loudness but
 * no propagation report — the same derivation `NOISE_RING_REFERENCE_M` uses, so
 * the scale stays consistent.
 */
function freeFieldReach(loudness: number): number {
  return Math.max(0, (loudness - FLOOR) / ATTENUATION_PER_M);
}

/** Seconds a ripple takes to expand and fade. */
const RIPPLE_LIFE_S = 0.85;
/** CSS-pixel size of the ring canvas; also its full-reach diameter. */
const RING_PX = 340;
/** The reticle is ~28px across; ripples start just outside it. */
const RING_MIN_RADIUS = 10;
/** Never draw past the canvas edge. */
const RING_MAX_RADIUS = RING_PX / 2 - 4;
/** More than this many concurrent ripples is visual mush; drop the oldest. */
const MAX_RIPPLES = 12;

interface Ripple {
  /** 0→1 through its life. */
  age: number;
  /** Radius in CSS px this ripple grows to. */
  target: number;
  loudness: number;
}

export interface NoiseRingOptions {
  parent: HTMLElement;
  /** Bus to read `noise:self` from. `null` to drive it manually with `pulse()`. */
  bus?: EventBus<GameEvents> | null;
  /**
   * Local session id, so the ring can pick its own events out of the server's
   * broadcast stream. Learned from `net:connected` when not supplied.
   */
  localPlayerId?: PlayerId | null;
}

export class NoiseRing {
  readonly canvas: HTMLCanvasElement;

  private readonly surface: HiDpiCanvas;
  private readonly ripples: Ripple[] = [];
  private readonly disposers: Unsubscribe[] = [];
  private dirty = false;

  private localId: PlayerId | null;
  /** True once a server is answering: its noise stream becomes the authority. */
  private serverAuthoritative = false;
  /** Server-clocked events of ours seen this frame, awaiting the identity check. */
  private pendingServer: NoiseEvent[] = [];
  /** Events this frame that came out of the LOCAL emitter, by object identity. */
  private readonly locallyEmitted = new Set<NoiseEvent>();

  constructor(opts: NoiseRingOptions) {
    this.surface = new HiDpiCanvas(RING_PX, RING_PX, 'iss-noise-ring');
    this.canvas = this.surface.canvas;
    opts.parent.appendChild(this.canvas);
    this.localId = opts.localPlayerId ?? null;

    const bus = opts.bus === undefined ? sharedBus : opts.bus;
    if (!bus) return;

    this.disposers.push(
      // Sounds the local player made, rung the instant they happened (§8).
      bus.on('noise:self', ({ event, carriedMetres }) => {
        this.locallyEmitted.add(event);
        if (this.serverAuthoritative && SERVER_CLOCKED.has(event.kind)) return;
        this.pulse(carriedMetres, event.loudness);
      }),
      // Server-clocked kinds only, and only ours. `noise:emitted` carries both
      // the network stream and the local emitter's own events — the two are
      // indistinguishable by content, so the decision is deferred to the next
      // `update()` and settled on object identity against `noise:self`, which
      // the local path always fires immediately afterwards.
      bus.on('noise:emitted', ({ event }) => {
        if (!this.serverAuthoritative) return;
        if (!SERVER_CLOCKED.has(event.kind)) return;
        if (this.localId === null || event.actor !== this.localId) return;
        if (this.pendingServer.length >= MAX_RIPPLES) this.pendingServer.shift();
        this.pendingServer.push(event);
      }),
      bus.on('net:connected', ({ sessionId }) => {
        this.localId = sessionId;
        this.serverAuthoritative = true;
      }),
      bus.on('net:disconnected', () => {
        this.serverAuthoritative = false;
      }),
    );
  }

  /**
   * Turn this frame's server broadcasts into ripples, minus anything the local
   * emitter produced (same object, seen on `noise:self`). One ripple per sound
   * the alien actually got, which is the only version worth teaching.
   */
  private flushServerRipples(): void {
    if (this.pendingServer.length > 0) {
      for (const event of this.pendingServer) {
        if (this.locallyEmitted.has(event)) continue;
        this.pulse(freeFieldReach(event.loudness), event.loudness);
      }
      this.pendingServer = [];
    }
    if (this.locallyEmitted.size > 0) this.locallyEmitted.clear();
  }

  /** Tell the ring which session is ours, if it cannot learn it from the bus. */
  setLocalPlayer(id: PlayerId | null): void {
    this.localId = id;
  }

  /**
   * Ripple for a sound the local player just made.
   *
   * @param carriedMetres how far it actually carried before hitting the floor
   * @param loudness      source loudness, 0–100 — picks the colour band
   */
  pulse(carriedMetres: number, loudness: number): void {
    const reach = Math.max(0, carriedMetres);
    // sqrt so the quiet tier is still visible: a 2m rail pull would otherwise be
    // 3% of the ring and read as "free", which is precisely the lie pillar 1
    // exists to prevent.
    const t = Math.sqrt(Math.min(1, reach / NOISE_RING_REFERENCE_M));
    const target = RING_MIN_RADIUS + (RING_MAX_RADIUS - RING_MIN_RADIUS) * t;
    this.ripples.push({ age: 0, target, loudness });
    if (this.ripples.length > MAX_RIPPLES) this.ripples.shift();
    this.dirty = true;
  }

  /** Convenience for callers holding a NoiseEvent and a resolved reach. */
  pulseEvent(event: NoiseEvent, carriedMetres: number): void {
    this.pulse(carriedMetres, event.loudness);
  }

  /** Advance and redraw. Call once per rendered frame. */
  update(dt: number): void {
    this.flushServerRipples();

    if (this.ripples.length === 0) {
      if (this.dirty) {
        this.surface.clear();
        this.dirty = false;
      }
      return;
    }

    this.surface.sync();
    const step = dt / RIPPLE_LIFE_S;
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.age += step;
      if (r.age >= 1) this.ripples.splice(i, 1);
    }

    const { ctx, width, height } = this.surface;
    ctx.clearRect(0, 0, width, height);
    const cx = width / 2;
    const cy = height / 2;

    for (const r of this.ripples) {
      // Ease-out: the sound leaves you fast and the ring settles at its reach.
      const u = 1 - Math.pow(1 - r.age, 3);
      const radius = RING_MIN_RADIUS + (r.target - RING_MIN_RADIUS) * u;
      const fade = 1 - r.age;

      ctx.lineWidth = 1 + 2.2 * fade;
      ctx.strokeStyle = loudnessRgba(r.loudness, 0.72 * fade);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      // A second, tighter ring behind the leading edge gives the ripple weight
      // without costing legibility.
      if (radius > RING_MIN_RADIUS + 6) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = loudnessRgba(r.loudness, 0.24 * fade);
        ctx.beginPath();
        ctx.arc(cx, cy, radius - 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    this.dirty = true;
  }

  /** Drop every in-flight ripple (round reset, teleport, results screen). */
  clear(): void {
    this.ripples.length = 0;
    this.pendingServer = [];
    this.locallyEmitted.clear();
    this.surface.clear();
    this.dirty = false;
  }

  setVisible(visible: boolean): void {
    this.canvas.style.display = visible ? '' : 'none';
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    this.canvas.remove();
  }
}
