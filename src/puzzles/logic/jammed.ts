/**
 * Jammed access — the canonical loud-fast / quiet-slow pair (DESIGN.md §11).
 *
 * "A jammed hatch can be pried (60, 3 seconds) or hand-pumped (6, 25 seconds,
 * locked in place throughout)." That sentence *is* the hard design rule, so it
 * lives in one place and gets reused: jammed lockers holding the breaker card
 * and the spare fuses run through this exact mechanic.
 *
 * Both paths are HOLDS. Letting go resets progress to zero — "locked in place
 * throughout" is the price of the quiet path, and a pry bar you can put down
 * halfway would make the loud path free.
 */

import type { ModuleId, PlayerId, Vec3 } from '@shared/types';
import { HAND_PUMP_TIME_S, PRY_TIME_S } from '@shared/constants';
import {
  CONTINUOUS_NOISE_INTERVAL_S,
  HOLD_GRACE_MS,
  type PuzzleEffects,
} from './types';

export type JamMode = 'idle' | 'pry' | 'pump';

export interface JamState {
  /** False once it is open — every other field stops mattering. */
  jammed: boolean;
  mode: JamMode;
  holder: PlayerId | null;
  /** Seconds accumulated on the current hold. */
  progress: number;
  /** Seconds the current mode needs. */
  required: number;
  /** Heartbeat deadline; the hold lapses when `nowMs` passes it. */
  holdUntilMs: number;
  /** Seconds since this hold last made a sound. */
  noiseAccum: number;
}

export function createJam(jammed: boolean): JamState {
  return {
    jammed,
    mode: 'idle',
    holder: null,
    progress: 0,
    required: 0,
    holdUntilMs: 0,
    noiseAccum: 0,
  };
}

/** Fraction of the current hold completed, 0–1. */
export function jamProgress01(jam: JamState): number {
  if (!jam.jammed) return 1;
  if (jam.required <= 0) return 0;
  return Math.min(1, jam.progress / jam.required);
}

/**
 * Register a hold heartbeat. Clients send one of these per fixed tick while the
 * button is down; switching mode (pry ↔ pump) restarts the progress.
 *
 * Returns true if the state changed.
 */
export function jamHold(
  jam: JamState,
  mode: 'pry' | 'pump',
  playerId: PlayerId,
  nowMs: number,
): boolean {
  if (!jam.jammed) return false;
  const lapsed = nowMs > jam.holdUntilMs;
  if (jam.holder !== null && jam.holder !== playerId && !lapsed) {
    // Someone else already has both hands on it. One pair of hands per jam.
    return false;
  }
  let changed = false;
  if (jam.holder !== playerId || jam.mode !== mode || lapsed) {
    jam.holder = playerId;
    jam.mode = mode;
    jam.progress = 0;
    jam.required = mode === 'pry' ? PRY_TIME_S : HAND_PUMP_TIME_S;
    // Fire the first sound on the very next tick rather than a second later.
    jam.noiseAccum = CONTINUOUS_NOISE_INTERVAL_S;
    changed = true;
  }
  jam.holdUntilMs = nowMs + HOLD_GRACE_MS;
  return changed;
}

/** Let go. Progress is lost — that is the whole point of the mechanic. */
export function jamRelease(jam: JamState, playerId: PlayerId): boolean {
  if (!jam.jammed || jam.holder !== playerId) return false;
  jam.holder = null;
  jam.mode = 'idle';
  jam.progress = 0;
  jam.required = 0;
  jam.holdUntilMs = 0;
  jam.noiseAccum = 0;
  return true;
}

/**
 * Advance a jam by `dt` seconds, emitting the pry bar (60) or hand pump (6) at
 * `CONTINUOUS_NOISE_INTERVAL_S`. Returns true the tick it comes open.
 */
export function jamTick(
  jam: JamState,
  dt: number,
  nowMs: number,
  module: ModuleId,
  pos: Vec3,
  out: PuzzleEffects,
): boolean {
  if (!jam.jammed) return false;
  if (jam.holder === null || jam.mode === 'idle') return false;

  if (nowMs > jam.holdUntilMs) {
    // Heartbeat lapsed — they let go, or their connection did.
    jam.holder = null;
    jam.mode = 'idle';
    jam.progress = 0;
    jam.required = 0;
    jam.noiseAccum = 0;
    out.touch();
    return false;
  }

  jam.progress += dt;
  jam.noiseAccum += dt;
  if (jam.noiseAccum >= CONTINUOUS_NOISE_INTERVAL_S) {
    jam.noiseAccum -= CONTINUOUS_NOISE_INTERVAL_S;
    out.noise(jam.mode === 'pry' ? 'pry-bar' : 'hand-pump', module, pos, jam.holder ?? undefined);
  }

  if (jam.progress >= jam.required) {
    jam.jammed = false;
    jam.mode = 'idle';
    jam.holder = null;
    jam.progress = 0;
    jam.required = 0;
    jam.holdUntilMs = 0;
    jam.noiseAccum = 0;
    out.touch();
    return true;
  }
  out.touch();
  return false;
}
