/**
 * The wrist tracker's two clocks (DESIGN.md §6, §3).
 *
 * The tracker has *two* cadences and they are not the same number:
 *
 *   AUDIBLE   how often you hear a chirp. §6: "a beep every 3s when far,
 *             accelerating as the alien closes, solid tone when adjacent."
 *             That is `trackerBeepInterval()`, straight off §14's
 *             TRACKER_BEEP_INTERVAL_FAR_S / _NEAR_S.
 *
 *   EMITTED   how often the device puts a real loudness-20 NoiseEvent into the
 *             world. That is `trackerEmitInterval()`.
 *
 * They used to be the same clock, and that was a firehose. At contact range the
 * audible cadence is TRACKER_BEEP_INTERVAL_NEAR_S = 0.15 s — about seven
 * events a second, *per player*. Every one of those is a websocket message, a
 * server graph walk, a broadcast to every client in range, and a push into the
 * alien's coalescer.
 *
 * The coalescer is what makes the extra six a waste rather than a cost: §3
 * evaluates a rolling WINDOW_MS window and "act[s] on the loudest event in it".
 * Two identical loudness-20 beeps inside one window are indistinguishable from
 * one, so beeps 2..7 cannot change a single decision the alien makes — they only
 * pin its repeat penalty (§3 "diminishing returns per module", +3 m per
 * consecutive window) onto the player's own module and drown out everything
 * quieter the crew is doing.
 *
 * So the emitted clock is floored at one event per coalescing window. Nothing
 * is retuned by hand: the floor IS `WINDOW_MS`, imported from §14. The tone the
 * player hears is untouched — a solid tone still sounds solid — and the §6 trade
 * survives intact, because the emitted cadence still accelerates from one every
 * 3 s out at TRACKER_FAR_RANGE_M to one a second at contact. Leaving the tracker
 * on still gets steadily more expensive exactly when you want it most; it just
 * stops paying seven times over for information the alien only reads once.
 */

import {
  TRACKER_BEEP_INTERVAL_FAR_S,
  TRACKER_BEEP_INTERVAL_NEAR_S,
  TRACKER_FAR_RANGE_M,
  TRACKER_SOLID_RANGE_M,
  WINDOW_MS,
  clamp,
} from '@shared/constants';

/**
 * Shortest gap between two emitted tracker NoiseEvents, in seconds.
 *
 * Derived, never typed: it is exactly §14's coalescing window. A second beep
 * inside the same window can only ever be discarded as "not the loudest", so
 * emitting it buys nothing and costs a message, a graph walk and a broadcast.
 */
export const TRACKER_EMIT_INTERVAL_MIN_S = WINDOW_MS / 1000;

/**
 * 0 at TRACKER_FAR_RANGE_M or beyond, 1 at TRACKER_SOLID_RANGE_M or nearer.
 * Drives beep pitch as well as cadence.
 */
export function trackerUrgency(metres: number): number {
  if (!Number.isFinite(metres)) return 0;
  const span = TRACKER_FAR_RANGE_M - TRACKER_SOLID_RANGE_M;
  return 1 - clamp((metres - TRACKER_SOLID_RANGE_M) / span, 0, 1);
}

/**
 * Seconds between audible chirps at `metres`.
 *
 * Linear between the two published ranges: legibility beats realism (pillar 3),
 * and a player must be able to convert "it is speeding up" into "it is halving
 * the distance" without a chart. Never returns 0 — inside TRACKER_SOLID_RANGE_M
 * the device holds a continuous tone instead (`isTrackerSolid`), and this is the
 * rate it *would* be chirping at.
 */
export function trackerBeepInterval(metres: number): number {
  const t = 1 - trackerUrgency(metres);
  return (
    TRACKER_BEEP_INTERVAL_NEAR_S + t * (TRACKER_BEEP_INTERVAL_FAR_S - TRACKER_BEEP_INTERVAL_NEAR_S)
  );
}

/** True when the alien is close enough for the device to hold a solid tone. */
export function isTrackerSolid(metres: number): boolean {
  return Number.isFinite(metres) && metres <= TRACKER_SOLID_RANGE_M;
}

/**
 * Seconds between emitted loudness-20 NoiseEvents at `metres` — the tracker's
 * real in-world cost (§6), as opposed to what it sounds like.
 *
 * Far out the two clocks agree exactly (3 s), so nothing changes where the
 * device is cheap. They only diverge once the audible cadence outruns the
 * coalescing window, which is the range where the extra events were pure waste.
 */
export function trackerEmitInterval(metres: number): number {
  return Math.max(TRACKER_EMIT_INTERVAL_MIN_S, trackerBeepInterval(metres));
}
