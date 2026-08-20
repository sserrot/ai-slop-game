/**
 * Heart rate and the breathing loop — DESIGN.md §6.
 *
 * "Heart rate — core, not optional. r1 filed this as a nice-to-have; it is
 * load-bearing. Your heart rate climbs with alien proximity and drives a
 * breathing loop that emits 6–14 loudness. That is roughly thirty lines, and it
 * is the direct counter to the freeze meta: holding still next to the alien
 * stops being free."
 *
 * Two inputs feed one 0–1 intensity: alien proximity (distance, widened by each
 * hatch between you and it) and exertion (a push-off, a catch, a crash). The
 * intensity drives bpm for the tracker's second trace AND the loudness of every
 * breath, via `breathingNoise()` from §14 — the 6–14 range is not re-typed here.
 */

import { breathingNoise, clamp } from '@shared/constants';
import { halfLifeDecay } from '../core/ticker';
import {
  BREATH_RATE_CALM,
  BREATH_RATE_PANIC,
  EXERTION_HALFLIFE,
  HEART_ATTACK_HALFLIFE,
  HEART_DECAY_HALFLIFE,
  HEART_HOP_METRES,
  HEART_MAX_BPM,
  HEART_PROXIMITY_RANGE_M,
  HEART_REST_BPM,
} from './tuning';

export class HeartRate {
  /** Smoothed 0–1 fear/effort scalar. */
  private _intensity = 0;
  /** Decaying exertion term — pushes, catches and crashes inject into this. */
  private _exertion = 0;
  /** Latest alien proximity, in metres and hatches. */
  private _metres = Number.POSITIVE_INFINITY;
  private _hops = -1;
  /** Seconds until the next breath. */
  private breathTimer = 0;

  /** Beats per minute — `PlayerSnapshot.heartRate`, and the tracker's second
   *  trace (§6). */
  get bpm(): number {
    return HEART_REST_BPM + this._intensity * (HEART_MAX_BPM - HEART_REST_BPM);
  }

  /** 0–1. Drives breathing loudness and, for the UI, how bad this looks. */
  get intensity(): number {
    return this._intensity;
  }

  /** Loudness of the next breath: 6–14 by §3, via §14's `breathingNoise`. */
  get breathLoudness(): number {
    return breathingNoise(this._intensity);
  }

  /** Metres to the alien as last reported. Infinity when unknown. */
  get proximityMetres(): number {
    return this._metres;
  }

  /**
   * Alien proximity, from the tracker (§7 syncs the alien transform to every
   * client, so this is a local computation). `hops` is hatches crossed; pass -1
   * or omit when unknown.
   */
  setProximity(metres: number, hops = -1): void {
    this._metres = Number.isFinite(metres) ? Math.max(0, metres) : Number.POSITIVE_INFINITY;
    this._hops = hops;
  }

  /** Nothing known about the alien — decay to rest. */
  clearProximity(): void {
    this._metres = Number.POSITIVE_INFINITY;
    this._hops = -1;
  }

  /** A push-off, a catch or a crash. `amount` is 0–1. */
  addExertion(amount: number): void {
    this._exertion = clamp(this._exertion + amount, 0, 1);
  }

  /** Instant reset — respawn, or a fresh round. */
  reset(): void {
    this._intensity = 0;
    this._exertion = 0;
    this.breathTimer = 0;
    this.clearProximity();
  }

  /**
   * Advance the model. Returns true on the frames a breath should be emitted —
   * the caller turns that into a `breathing` NoiseEvent at `breathLoudness`.
   */
  update(dt: number): boolean {
    if (dt <= 0) return false;

    // Proximity term. Each hatch between you and it is worth HEART_HOP_METRES
    // of extra calm: one module away is not the same as ten metres of open tube.
    let proximity = 0;
    if (Number.isFinite(this._metres)) {
      const effective = this._metres + Math.max(0, this._hops) * HEART_HOP_METRES;
      proximity = clamp(1 - effective / HEART_PROXIMITY_RANGE_M, 0, 1);
    }

    this._exertion *= halfLifeDecay(dt, EXERTION_HALFLIFE);
    const target = clamp(Math.max(proximity, this._exertion), 0, 1);

    // Fear arrives faster than it leaves.
    const halfLife = target > this._intensity ? HEART_ATTACK_HALFLIFE : HEART_DECAY_HALFLIFE;
    const k = halfLifeDecay(dt, halfLife);
    this._intensity = target + (this._intensity - target) * k;
    if (this._intensity < 1e-4) this._intensity = 0;

    // Breathing loop: 12 breaths/min calm, 28 panicked.
    const breathsPerMinute =
      BREATH_RATE_CALM + this._intensity * (BREATH_RATE_PANIC - BREATH_RATE_CALM);
    const interval = 60 / Math.max(1, breathsPerMinute);
    this.breathTimer -= dt;
    if (this.breathTimer <= 0) {
      this.breathTimer += interval;
      if (this.breathTimer <= 0) this.breathTimer = interval; // huge dt guard
      return true;
    }
    return false;
  }
}
