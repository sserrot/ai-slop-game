/**
 * src/render/quality.ts — quality presets and the frame-rate guard (DESIGN.md §9).
 *
 * "Target 60 fps on a mid-range laptop." The guard watches real frame times and
 * suggests a step down (or back up, never above the ceiling the player chose).
 * The renderer applies the suggestion; this file makes no three.js calls at all.
 *
 * THE GUARD USED TO BE A ONE-WAY RATCHET. `upgradeFps` was 75, and on a 60 Hz
 * vsync the smoothed frame rate converges to 60 and can never exceed it — so
 * `goodTime` never accumulated and quality, once dropped, stayed dropped until
 * the page was reloaded. Traced over 110 s: heavy load stepped `high` → `medium`
 * → `low`, then 75 s of light load at a steady 60.0 fps produced ZERO upward
 * steps. Every player who ever hit a rough patch was still paying for it an hour
 * later. See {@link FrameGuard} for what replaced it.
 */

import { BLOOM_SCALE_HIGH, BLOOM_SCALE_MEDIUM, SHADOW_MAP_SIZE } from '@shared/constants';
import type { QualityLevel, QualityProfile } from './types';
import { damp } from './util';

/** Cheapest first. Index order is the guard's step order. */
export const QUALITY_ORDER: readonly QualityLevel[] = ['low', 'medium', 'high'];

const HIGH: QualityProfile = Object.freeze({
  level: 'high',
  post: true,
  bloom: true,
  // §9 "keep it cheap": bloom is a blur, so its bright pass runs at half the
  // composer resolution and the blur itself at a quarter of THAT — a
  // sixty-fourth of the frame's pixels, indistinguishable on screen.
  bloomScale: BLOOM_SCALE_HIGH,
  grain: 0.04,
  aberration: 0.012,
  shadowMapSize: SHADOW_MAP_SIZE, // 1024 — §9's single shadow map
  maxPixelRatio: 2,
  minPixelRatio: 1,
  // 3.3 Mpx ≈ 2340×1420. The reported player's 1920×1200 (2.30 Mpx) is well
  // inside it, so their picture does not change; what this stops is a
  // devicePixelRatio of 1.5–2 quietly turning a large window into 5–8 Mpx.
  maxRenderPixels: 3_300_000,
  msaaSamples: 4,
});

const MEDIUM: QualityProfile = Object.freeze({
  level: 'medium',
  post: true,
  bloom: true,
  bloomScale: BLOOM_SCALE_MEDIUM,
  grain: 0.03,
  aberration: 0.008,
  shadowMapSize: 512, // a real quarter of the texels, and the old map is freed
  maxPixelRatio: 1.25,
  // Slightly under 1:1, and only ever reached on a window whose CSS size alone
  // is over the budget. Without it the ladder collapses exactly where it is
  // needed: on a 2560×1600 window `medium` and `high` would BOTH floor at 1.0
  // and render the same 4.1 Mpx, and "step down" would mean nothing but a
  // smaller shadow map.
  minPixelRatio: 0.85,
  maxRenderPixels: 2_600_000,
  msaaSamples: 2,
});

const LOW: QualityProfile = Object.freeze({
  level: 'low',
  // `post: false` means "spend nothing on look". It does NOT always mean the
  // composer is gone: §4 ships the motion-comfort vignette in M0 and losing it
  // because the machine is slow is the wrong trade, so `Renderer.wantsPost()`
  // may keep a MINIMAL chain alive. Minimal is genuinely minimal — bloom is
  // skipped by the composer AND gives its five render targets back, grain and
  // aberration are zero, MSAA is off, the pixel ratio is 1, and the grade pass
  // tone-maps and encodes in the same full-screen quad that draws the vignette.
  // Two `renderer.render()` calls a frame against `high`'s nine.
  post: false,
  bloom: false,
  bloomScale: BLOOM_SCALE_MEDIUM,
  grain: 0,
  aberration: 0,
  shadowMapSize: 512, // the flashlight shadow stays — it *is* the look
  maxPixelRatio: 1,
  // The ONLY profile allowed to render below CSS resolution, and it is a
  // deliberate, stated trade: on a 4K window at 1:1 this drops to ~0.7× and the
  // image is visibly softer. It exists because the alternative at that size is
  // single-digit frame rates, and because `low` is where the guard runs out of
  // cheaper things to remove.
  minPixelRatio: 0.7,
  maxRenderPixels: 2_100_000,
  msaaSamples: 0,
});

export const QUALITY_PROFILES: Readonly<Record<QualityLevel, QualityProfile>> = Object.freeze({
  high: HIGH,
  medium: MEDIUM,
  low: LOW,
});

export function qualityIndex(level: QualityLevel): number {
  const i = QUALITY_ORDER.indexOf(level);
  return i < 0 ? QUALITY_ORDER.length - 1 : i;
}

export function qualityFromIndex(index: number): QualityLevel {
  const i = Math.max(0, Math.min(QUALITY_ORDER.length - 1, Math.round(index)));
  return QUALITY_ORDER[i];
}

/**
 * Drawing-buffer pixels for a CSS size and a profile.
 *
 * Separate from `Renderer` so a caller can ask "what would this cost?" without
 * one, and so the rule lives next to the budget it enforces.
 */
export function pixelRatioFor(
  profile: QualityProfile,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const ceiling = Math.min(Math.max(0.1, devicePixelRatio), profile.maxPixelRatio);
  const cssPixels = Math.max(1, cssWidth * cssHeight);
  const budgetFit = Math.sqrt(profile.maxRenderPixels / cssPixels);
  return Math.max(profile.minPixelRatio, Math.min(ceiling, budgetFit));
}

export interface FrameGuardOptions {
  /** Sustained fps below this asks for a step down. Default 48. */
  downgradeFps?: number;
  /**
   * Sustained fps above this asks for a step back up. Default 57.
   *
   * MUST be reachable on the display the player actually has. The old default
   * of 75 was not: a 60 Hz vsync pins the smoothed rate at 60.
   */
  upgradeFps?: number;
  /** Seconds of sustained bad frames before stepping down. Default 2.5. */
  downgradeSeconds?: number;
  /** Seconds of sustained good frames before the FIRST step up. Default 12. */
  upgradeSeconds?: number;
  /** Seconds of silence after any change. Default 5. */
  cooldownSeconds?: number;
  /** Seconds ignored at startup, while shaders compile. Default 3. */
  warmupSeconds?: number;
  /**
   * An upgrade undone within this many seconds counts as a failed experiment
   * and multiplies the wait before the next one. Default 30.
   */
  regretSeconds?: number;
  /** Multiplier on `upgradeSeconds` per failed upgrade. Default 3. */
  backoffFactor?: number;
  /**
   * How many times the wait may grow. Default 4, so with the other defaults the
   * required good time runs 12 → 36 → 108 → 324 → 972 s. Reaching the last one
   * takes 480 s of good play — §14's `STAGE_TIMEOUT_MS`, one whole round — so a
   * machine that cannot hold the higher setting is probed about four times and
   * then left alone, while one that gets FASTER (the player closed whatever was
   * eating the GPU) still finds its way back up inside about sixteen minutes.
   */
  maxBackoffSteps?: number;
  /**
   * Longest frame that still counts, in seconds; longer ones are CLAMPED to it
   * rather than thrown away. Default 0.5.
   *
   * The old code discarded everything over 0.25 s, which meant the very worst
   * frames — anything under 4 fps, i.e. exactly the state the guard exists to
   * escape — were invisible to it. Clamping keeps a genuine catastrophe in the
   * average while still stopping one alt-tab from costing a quality level.
   */
  clampSeconds?: number;
}

/** -1 step down, 0 hold, +1 step up. */
export type QualitySuggestion = -1 | 0 | 1;

/** What the guard currently believes. For a debug overlay or a settings row. */
export interface FrameGuardState {
  fps: number;
  /** fps below which it wants to step down. */
  downgradeFps: number;
  /** fps above which it would consider stepping up, given the backoff. */
  upgradeFps: number;
  /** Seconds of good frames still needed before the next upward step. */
  upgradeSecondsRequired: number;
  /** Upgrades that were undone within `regretSeconds`. Each one doubles the wait. */
  failedUpgrades: number;
  cooldown: number;
}

/**
 * Rolling frame-time watchdog. Always sample it (the fps figure feeds
 * `RenderStats`); it only returns a non-zero suggestion when `enabled`.
 *
 * Three rules keep it from thrashing, which matters because every step it
 * suggests reallocates render targets and the shadow map — a step is itself a
 * hitch, and a guard that oscillates is worse than one that is switched off:
 *
 *  1. a wide band. Down below 48 fps, up above 57, nothing in between;
 *  2. a cooldown after every change;
 *  3. **exponential backoff.** An upgrade that has to be undone within
 *     `regretSeconds` triples the good time required before the next attempt:
 *     12 s, 36 s, 108 s, 324 s, then 972 s forever. Simulated against a machine
 *     pinned at 40 fps on `high` and 60 on `medium`, that is four probes in the
 *     first five minutes and then one every sixteen — it settles, but it
 *     settles *because it tried*, not because trying was impossible.
 *
 * Simulated across six sessions (recovery after a rough patch; a machine that
 * cannot hold `high`; one that cannot hold `medium` either; a healthy 60 Hz
 * session; a 50 Hz display; one 300 ms hitch every 10 s): the healthy, the
 * 50 Hz and the hitching sessions produce ZERO changes, and the rough-patch
 * session drops to `low` and is back at `high` 47 s later. Under the old rules
 * that last one never recovered at all.
 */
export class FrameGuard {
  /**
   * When false, `sample()` still tracks fps but always returns 0.
   *
   * On by default. It shipped disabled, which meant a machine that could not
   * hold 60 fps simply stayed at `high` and stuttered.
   */
  enabled = true;

  private readonly downgradeFps: number;
  private readonly upgradeFpsCeiling: number;
  private readonly downgradeSeconds: number;
  private readonly upgradeSeconds: number;
  private readonly cooldownSeconds: number;
  private readonly warmupSeconds: number;
  private readonly regretSeconds: number;
  private readonly backoffFactor: number;
  private readonly maxBackoffSteps: number;
  private readonly clampSeconds: number;

  private ema = 60;
  /** Best smoothed rate seen since boot — the only evidence of the refresh rate. */
  private bestEma = 60;
  private badTime = 0;
  private goodTime = 0;
  private cooldown = 0;
  private warmup = 0;
  private failedUpgrades = 0;
  private sinceUpgrade = Number.POSITIVE_INFINITY;

  constructor(opts: FrameGuardOptions = {}) {
    this.downgradeFps = opts.downgradeFps ?? 48;
    this.upgradeFpsCeiling = opts.upgradeFps ?? 57;
    this.downgradeSeconds = opts.downgradeSeconds ?? 2.5;
    this.upgradeSeconds = opts.upgradeSeconds ?? 12;
    this.cooldownSeconds = opts.cooldownSeconds ?? 5;
    this.warmupSeconds = opts.warmupSeconds ?? 3;
    this.regretSeconds = opts.regretSeconds ?? 30;
    this.backoffFactor = Math.max(1, opts.backoffFactor ?? 3);
    this.maxBackoffSteps = opts.maxBackoffSteps ?? 4;
    this.clampSeconds = opts.clampSeconds ?? 0.5;
  }

  /** Smoothed frames per second. */
  get fps(): number {
    return this.ema;
  }

  /** Smoothed frame time in milliseconds. */
  get frameMs(): number {
    return this.ema > 0 ? 1000 / this.ema : 0;
  }

  /**
   * The rate the guard currently wants before it will try stepping back up.
   *
   * Normally the fixed ceiling (57 fps). On a display whose refresh is BELOW
   * that — a 50 Hz panel, a browser pacing at 48 — the fixed number would be
   * another unreachable threshold, so it falls back to 97% of the best rate
   * this session has ever shown. It never drops to or below `downgradeFps`,
   * because a band with no gap in it is an oscillator.
   */
  get upgradeFps(): number {
    return Math.min(this.upgradeFpsCeiling, Math.max(this.downgradeFps * 1.01, this.bestEma * 0.97));
  }

  /** Good seconds required before the next upward step, after backoff. */
  get upgradeSecondsRequired(): number {
    const steps = Math.min(this.failedUpgrades, this.maxBackoffSteps);
    return this.upgradeSeconds * Math.pow(this.backoffFactor, steps);
  }

  get state(): FrameGuardState {
    return {
      fps: this.ema,
      downgradeFps: this.downgradeFps,
      upgradeFps: this.upgradeFps,
      upgradeSecondsRequired: this.upgradeSecondsRequired,
      failedUpgrades: this.failedUpgrades,
      cooldown: this.cooldown,
    };
  }

  /**
   * Feed one real frame duration in seconds.
   *
   * A hidden tab is skipped outright. This browser keeps calling
   * `requestAnimationFrame` while hidden (measured: 30.2 callbacks/s, still
   * drawing) and the resulting half-rate frames were reading as a struggling
   * machine — an agent tab left in the background had ratcheted itself to `low`
   * without a single slow frame of real rendering. An occluded window is the
   * same story with a human in front of it.
   */
  sample(frameSeconds: number): QualitySuggestion {
    if (!(frameSeconds > 0)) return 0;
    if (typeof document !== 'undefined' && document.hidden) {
      this.badTime = 0;
      this.goodTime = 0;
      return 0;
    }

    // Clamp rather than discard: a 250 ms frame is not noise, it is the worst
    // thing that happened all round, and the guard exists to react to it.
    const dt = Math.min(frameSeconds, this.clampSeconds);

    this.ema = damp(this.ema, 1 / dt, 0.5, dt);
    if (this.ema > this.bestEma) this.bestEma = Math.min(this.ema, 300);
    if (this.sinceUpgrade < this.regretSeconds) this.sinceUpgrade += dt;

    if (this.warmup < this.warmupSeconds) {
      this.warmup += dt;
      return 0;
    }
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      this.badTime = 0;
      this.goodTime = 0;
      return 0;
    }

    const upgradeAt = this.upgradeFps;
    if (this.ema < this.downgradeFps) {
      this.badTime += dt;
      this.goodTime = 0;
    } else if (this.ema > upgradeAt) {
      this.goodTime += dt;
      this.badTime = 0;
    } else {
      this.badTime = 0;
      this.goodTime = 0;
    }

    if (!this.enabled) return 0;

    if (this.badTime >= this.downgradeSeconds) {
      this.badTime = 0;
      this.cooldown = this.cooldownSeconds;
      // Did we get here by trying to step up and failing? Then wait longer next
      // time — this is the whole anti-thrash mechanism.
      if (this.sinceUpgrade < this.regretSeconds) {
        this.failedUpgrades = Math.min(this.failedUpgrades + 1, this.maxBackoffSteps);
      }
      this.sinceUpgrade = Number.POSITIVE_INFINITY;
      return -1;
    }
    if (this.goodTime >= this.upgradeSecondsRequired) {
      this.goodTime = 0;
      this.cooldown = this.cooldownSeconds;
      this.sinceUpgrade = 0;
      return 1;
    }
    return 0;
  }

  /**
   * Forget history — call after a manual quality change or a scene swap.
   *
   * Deliberately does NOT clear `failedUpgrades`: that is the memory of what
   * this machine has already proven it cannot do, and a resize is not evidence
   * to the contrary. {@link forgetBackoff} is for when the player has changed
   * something that invalidates it.
   */
  reset(): void {
    this.badTime = 0;
    this.goodTime = 0;
    this.cooldown = this.cooldownSeconds;
    this.warmup = 0;
    this.sinceUpgrade = Number.POSITIVE_INFINITY;
  }

  /** Give the machine a clean slate — a player picking a level by hand. */
  forgetBackoff(): void {
    this.failedUpgrades = 0;
    this.bestEma = Math.max(60, this.ema);
  }
}
