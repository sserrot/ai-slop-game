/**
 * Fixed-timestep accumulator loop (DESIGN.md §7: "20 Hz server tick; clients
 * render interpolated at display rate").
 *
 * Simulation runs at a fixed `TICK_HZ` so physics, noise and the alien behave
 * identically regardless of frame rate. Rendering happens once per animation
 * frame and receives `alpha` — the fraction of the way from the previous sim
 * state to the current one — for interpolation (§7 "interpolate remote players
 * and the alien").
 *
 *     ticker.onFixed((dt, tick) => world.step(dt, tick));
 *     ticker.onRender((alpha) => renderer.draw(alpha));
 *     ticker.start();
 */

import { TICK_HZ } from '@shared/constants';
import type { Unsubscribe } from './eventBus';

/** Called once per simulation step. `dt` is always exactly `fixedDt`. */
export type FixedUpdate = (dt: number, tick: number) => void;
/** Called once per frame. `alpha` ∈ [0,1) is the interpolation factor. */
export type RenderUpdate = (alpha: number, frameDt: number) => void;

export interface TickerOptions {
  /** Simulation rate. Defaults to TICK_HZ (20). */
  hz?: number;
  /**
   * Longest frame the accumulator will honour, in seconds. Anything longer is
   * treated as this — a tab that was backgrounded for a minute must not try to
   * catch up with 1200 sim steps ("spiral of death"). Defaults to 0.25s.
   */
  maxFrameSeconds?: number;
  /** Hard cap on sim steps per frame. Defaults to 5. */
  maxStepsPerFrame?: number;
  /** Clock source in milliseconds. Defaults to `performance.now` if present. */
  now?: () => number;
}

const defaultNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

export class Ticker {
  /** Simulation rate in Hz. */
  readonly hz: number;
  /** Seconds per simulation step — the `dt` every fixed update receives. */
  readonly fixedDt: number;

  private readonly maxFrameSeconds: number;
  private readonly maxStepsPerFrame: number;
  private readonly now: () => number;

  private readonly fixedHandlers = new Set<FixedUpdate>();
  private readonly renderHandlers = new Set<RenderUpdate>();

  private accumulator = 0;
  private lastMs = 0;
  private _tick = 0;
  private _alpha = 0;
  private _elapsed = 0;
  private _running = false;
  private _frameHandle: number | null = null;
  /** Set when the driver is setTimeout rather than requestAnimationFrame. */
  private _timerHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TickerOptions = {}) {
    this.hz = opts.hz ?? TICK_HZ;
    if (!(this.hz > 0)) throw new Error(`Ticker: hz must be positive, got ${this.hz}`);
    this.fixedDt = 1 / this.hz;
    this.maxFrameSeconds = opts.maxFrameSeconds ?? 0.25;
    this.maxStepsPerFrame = opts.maxStepsPerFrame ?? 5;
    this.now = opts.now ?? defaultNow;
  }

  /** Simulation ticks completed since `start()`. Matches the server's tick
   *  counter in spirit; do not assume they are equal. */
  get tick(): number {
    return this._tick;
  }

  /** Interpolation factor for the current frame, [0, 1). */
  get alpha(): number {
    return this._alpha;
  }

  /** Seconds of simulated time since `start()`. */
  get elapsed(): number {
    return this._elapsed;
  }

  get running(): boolean {
    return this._running;
  }

  /** Register a fixed-timestep callback. Returns an unsubscribe function. */
  onFixed(fn: FixedUpdate): Unsubscribe {
    this.fixedHandlers.add(fn);
    return () => this.fixedHandlers.delete(fn);
  }

  /** Register a per-frame callback. Returns an unsubscribe function. */
  onRender(fn: RenderUpdate): Unsubscribe {
    this.renderHandlers.add(fn);
    return () => this.renderHandlers.delete(fn);
  }

  /** Begin driving the loop from requestAnimationFrame (or a timer, headless). */
  start(): void {
    if (this._running) return;
    this._running = true;
    this.lastMs = this.now();
    this.accumulator = 0;
    this.schedule();
  }

  /** Stop. State (tick count, elapsed) is preserved; `start()` resumes. */
  stop(): void {
    if (!this._running) return;
    this._running = false;
    const raf = getCancelFrame();
    if (this._frameHandle !== null && raf) raf(this._frameHandle);
    if (this._timerHandle !== null) clearTimeout(this._timerHandle);
    this._frameHandle = null;
    this._timerHandle = null;
  }

  /** Reset the clock and counters without touching subscriptions. */
  reset(): void {
    this.accumulator = 0;
    this._tick = 0;
    this._alpha = 0;
    this._elapsed = 0;
    this.lastMs = this.now();
  }

  /**
   * Advance the loop by hand to the given wall-clock ms. Use this when you own
   * the outer loop — a `setInterval` on the server, or a deterministic test —
   * instead of `start()`.
   */
  step(nowMs: number = this.now()): void {
    let frameSeconds = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    if (!Number.isFinite(frameSeconds) || frameSeconds < 0) frameSeconds = 0;
    if (frameSeconds > this.maxFrameSeconds) frameSeconds = this.maxFrameSeconds;

    this.accumulator += frameSeconds;

    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < this.maxStepsPerFrame) {
      this.accumulator -= this.fixedDt;
      this._tick++;
      this._elapsed += this.fixedDt;
      steps++;
      for (const fn of this.fixedHandlers) {
        try {
          fn(this.fixedDt, this._tick);
        } catch (err) {
          console.error('[ticker] fixed update threw:', err);
        }
      }
    }

    // Hit the step cap: drop the backlog rather than accumulating a debt we can
    // never repay. Better a small time skip than a permanently late simulation.
    if (steps >= this.maxStepsPerFrame && this.accumulator > this.fixedDt) {
      this.accumulator = 0;
    }

    this._alpha = this.accumulator / this.fixedDt;

    for (const fn of this.renderHandlers) {
      try {
        fn(this._alpha, frameSeconds);
      } catch (err) {
        console.error('[ticker] render update threw:', err);
      }
    }
  }

  private schedule(): void {
    if (!this._running) return;
    const raf = getRequestFrame();
    if (raf) {
      this._frameHandle = raf((ts: number) => {
        this._frameHandle = null;
        if (!this._running) return;
        this.step(ts);
        this.schedule();
      });
      return;
    }
    // Headless fallback: run the sim at its own rate with no render pacing.
    this._timerHandle = setTimeout(() => {
      this._timerHandle = null;
      if (!this._running) return;
      this.step(this.now());
      this.schedule();
    }, Math.max(1, Math.floor(1000 / this.hz)));
  }
}

type FrameCallback = (timestampMs: number) => void;

function getRequestFrame(): ((cb: FrameCallback) => number) | null {
  const g = globalThis as { requestAnimationFrame?: (cb: FrameCallback) => number };
  return typeof g.requestAnimationFrame === 'function'
    ? g.requestAnimationFrame.bind(globalThis)
    : null;
}

function getCancelFrame(): ((handle: number) => void) | null {
  const g = globalThis as { cancelAnimationFrame?: (handle: number) => void };
  return typeof g.cancelAnimationFrame === 'function'
    ? g.cancelAnimationFrame.bind(globalThis)
    : null;
}

/**
 * Linear interpolation helper for render callbacks — the whole reason `alpha`
 * exists. Interpolate remote players and the alien, never the local player (§7:
 * clients own their own movement outright).
 */
export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

/**
 * Frame-rate independent exponential decay expressed as a half-life, which is
 * how §4 specifies air drag: `vel *= halfLifeDecay(dt, DRAG_HALFLIFE)`.
 * Specify half-lives, never bare exponents.
 */
export function halfLifeDecay(dtSeconds: number, halfLifeSeconds: number): number {
  return Math.pow(0.5, dtSeconds / halfLifeSeconds);
}
