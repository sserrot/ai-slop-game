/**
 * Turning §3 loudness points into Web Audio gain (DESIGN.md §8).
 *
 * The §3 scale runs from FLOOR (2, "just physically audible") to 70 (a decoy at
 * source, the loudest thing in the game). We map that whole span onto the
 * roughly 40 dB of usable dynamic range a game mix actually has, anchored so
 * that 70 plays at unity:
 *
 *   level 70 (decoy at source)          0 dB   gain 1.0
 *   level 51 (full-speed crash)      -11.4 dB  gain 0.27
 *   level 45 (hatch cycle)           -15.0 dB  gain 0.18
 *   level 26 (full-speed clean catch)-26.4 dB  gain 0.048
 *   level 15 (knock, or a hatch cycle
 *             through a closed hatch
 *             one module away)       -33.0 dB  gain 0.022
 *   level  4 (rail pull)             -39.6 dB  gain 0.010
 *   level  2 (FLOOR)                    silent, faded, not stepped
 *
 * A NOTE ON §8's "-25 dB": §14 stores hatch attenuation as dB offsets and §8
 * describes a closed hatch as "lowpass at 400 Hz, -25 dB". Those 25 points are
 * charged in full by the propagation — the level really does drop by 25 — but
 * they are then rendered through the 0.6 dB/point scale above rather than as 25
 * literal decibels of gain. Taking it literally was tried first and it breaks a
 * requirement the doc states elsewhere and even asserts in
 * `assertConstantsCoherent()`: "a hatch cycle must still be audible through a
 * closed hatch one module away — it is how you hear the alien coming (§5)". At
 * 1 dB/point that arrival lands at -55 dB, which is not audible on any speaker
 * anyone will play this on. `DB_PER_LOUDNESS` is one constant; set it to 1 for
 * the literal reading.
 *
 * Everything synthesized in `synth.ts` is normalised to roughly the same peak
 * so that this — and not an accident of oscillator amplitude — is what decides
 * how loud a sound is.
 */

import { FILTER_RAMP_S, FLOOR, OCCLUSION_LOWPASS_HZ, OPEN_LOWPASS_HZ, clamp } from '@shared/constants';

/** Loudness that plays at unity gain: the loudest row of the §3 table. */
export const LEVEL_REFERENCE = 70;
/** dB per loudness point. 0.6 spreads FLOOR..70 across ~40 dB. Set it to 1 for
 *  §8's literal reading — and see the note above on why that is not the default. */
export const DB_PER_LOUDNESS = 0.6;
/** Nothing is quieter than this, so a sound at the floor still exists. */
export const MIN_AUDIBLE_DB = -45;
/** Loudness points over FLOOR across which a sound fades in from silence.
 *  Stops sustained sources clicking as they cross the audibility floor. */
export const FLOOR_FADE_POINTS = 3;

/** Self noise (§8: "audible to them at full volume") — floor and ceiling of the
 *  body-bus mapping. Even a rail pull is clearly audible; a decoy is louder. */
export const SELF_GAIN_MIN = 0.35;
export const SELF_GAIN_MAX = 1.0;

/**
 * `setTargetAtTime` time constant. §8: ramp over ~100 ms, never step, or every
 * hatch cycle clicks. setTargetAtTime is exponential and reaches ~95% in 3τ, so
 * τ = FILTER_RAMP_S / 3 settles in the ~100 ms the doc asks for.
 */
export const RAMP_TAU = FILTER_RAMP_S / 3;

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-6));
}

export interface LevelMapping {
  reference?: number;
  dbPerLoudness?: number;
  minDb?: number;
  floor?: number;
}

/** Arrival level → dB, clamped into the usable window. */
export function levelToDb(level: number, map: LevelMapping = {}): number {
  const reference = map.reference ?? LEVEL_REFERENCE;
  const perPoint = map.dbPerLoudness ?? DB_PER_LOUDNESS;
  const minDb = map.minDb ?? MIN_AUDIBLE_DB;
  return clamp((level - reference) * perPoint, minDb, 0);
}

/**
 * Arrival level → linear gain. Silent at or below the floor, with a short fade
 * over the next few points so a moving source does not pop in and out.
 */
export function levelToGain(level: number, map: LevelMapping = {}): number {
  const floor = map.floor ?? FLOOR;
  if (level <= floor) return 0;
  const fade = clamp((level - floor) / FLOOR_FADE_POINTS, 0, 1);
  return dbToGain(levelToDb(level, map)) * fade;
}

/**
 * Gain for a source we already have at full amplitude — a peer's voice stream
 * (§7) — where what we want is the *loss* the graph applied, not an absolute
 * position on the loudness scale. Unity at the source, then exactly the metres
 * and hatch dB §3 charged it.
 */
export function relativeGain(arrivalLevel: number, sourceLoudness: number, minDb = -45): number {
  if (sourceLoudness <= 0 || arrivalLevel <= FLOOR) return 0;
  const db = clamp((arrivalLevel - sourceLoudness) * DB_PER_LOUDNESS, minDb, 0);
  // Same fade over the last few points as `levelToGain`, so a peer walking out
  // of earshot goes quiet instead of cutting off mid-word.
  const fade = clamp((arrivalLevel - FLOOR) / FLOOR_FADE_POINTS, 0, 1);
  return dbToGain(db) * fade;
}

/**
 * §8: "every noise the player emits must be audible to them at full volume."
 * Full volume, but not flat — a louder mistake still feels louder.
 */
export function selfGain(loudness: number): number {
  const t = clamp(loudness / LEVEL_REFERENCE, 0, 1);
  return SELF_GAIN_MIN + (SELF_GAIN_MAX - SELF_GAIN_MIN) * t;
}

/** §8: a closed hatch is a 400 Hz lowpass on top of its dB cost. */
export function occlusionCutoffHz(occluded: boolean): number {
  return occluded ? OCCLUSION_LOWPASS_HZ : OPEN_LOWPASS_HZ;
}

/**
 * Ramp an AudioParam. NEVER assign `.value` on a live graph — §8 is explicit
 * that stepping makes every hatch cycle click.
 */
export function ramp(param: AudioParam, target: number, now: number, tau: number = RAMP_TAU): void {
  const safe = Number.isFinite(target) ? target : 0;
  param.setTargetAtTime(safe, now, Math.max(tau, 0.001));
}

/** Set a param immediately — only ever at voice construction, before it sounds. */
export function setNow(param: AudioParam, value: number, now: number): void {
  const safe = Number.isFinite(value) ? value : 0;
  param.cancelScheduledValues(now);
  param.setValueAtTime(safe, now);
}
