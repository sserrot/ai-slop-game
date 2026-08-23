/**
 * src/alien/cadence.ts — the cadence law, shared by the game and the viewer.
 *
 * One rule, stated once: a gait clip plays at `speed * duration / stride`, so a
 * planted foot moves rearward through the body at exactly the body's ground
 * speed and stays fixed in world space. `alien-viewer.html` exists to judge the
 * asset before it ships; it must apply the SAME law — including the clamps —
 * or an artist tunes against physics the game will not run (the viewer showed
 * unclamped cadence for exactly one revision, which is why this module exists).
 */

import { clamp } from '@shared/constants';

export const GLB_URL = '/models/alien.glb';
export const META_URL = '/models/alien.meta.json';

/** One gait's record in the sidecar `art/alien.py` writes at build time. */
export interface ClipMeta {
  frames: number;
  /** Metres the body advances per cycle, MEASURED from the baked action. */
  stride: number;
}

export interface AlienMeta {
  fps: number;
  clips: Record<string, ClipMeta>;
}

/** Below the floor a clip reads as a freeze-frame; above the ceiling as a
 *  thrash. Outside either, honest foot-slip is the lesser evil. */
export const TIMESCALE_MIN = 0.35;
export const TIMESCALE_MAX = 3.2;

/** Speed below which the gait idles at the floor instead of freezing
 *  mid-stride — a statue with one foot in the air reads as a bug. */
export const STANDSTILL_SPEED = 0.05;

/**
 * Seconds-per-metre factor for one clip: `timeScale = speed * factor`.
 * Null when the sidecar is missing or carries no stride for this clip —
 * callers fall back to `clipDuration / ALIEN_STRIDE_M` (the procedural body's
 * own stride constant) rather than abandoning the lock.
 */
export function cadenceFactor(meta: AlienMeta | null, clip: string): number | null {
  const m = meta?.clips?.[clip];
  if (!m || m.stride <= 0) return null;
  return m.frames / (meta?.fps ?? 24) / m.stride;
}

/** The law itself: clamped timeScale for a clip factor at a body speed. */
export function clipTimeScale(factor: number, speed: number): number {
  if (speed < STANDSTILL_SPEED) return TIMESCALE_MIN;
  return clamp(speed * factor, TIMESCALE_MIN, TIMESCALE_MAX);
}
