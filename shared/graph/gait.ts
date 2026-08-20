/**
 * The gait and stride model (the walking pivot).
 *
 * Three gaits, three loudnesses, and one rule about when a footstep happens:
 *
 *   NOISE IS EMITTED PER FOOTSTEP, AND A FOOTSTEP IS A DISTANCE, NOT A TIMER.
 *
 * That choice is the honest one and it is worth stating why. A timer charges
 * you for time spent moving, so a player shuffling against a bulkhead pays the
 * same as one crossing a module, and a player who stutters their input pays
 * twice for one journey. Distance charges you for ground covered: shuffling is
 * free, crossing a module costs the same whether you did it in one burst or
 * ten, and "was that loud?" — pillar 1's question — has an answer the player
 * can see, because it is the same distance they just watched themselves travel.
 *
 * The numbers live in `@shared/constants` (`GAIT_PROFILES`); this is the
 * machine that turns metres into footstep events, and it runs identically on
 * the client (which emits) and the server (which re-derives and re-broadcasts).
 */

import {
  STRIDE_START_FRACTION,
  footstepLoudness,
  gaitProfile,
  gaitSpeed,
  strideMetres,
} from '@shared/constants';
import type { Gait, GaitProfile, PlayerState } from '@shared/types';
import { GAITS } from '@shared/types';

export {
  GAIT_PROFILES,
  footstepLoudness,
  gaitProfile,
  gaitSpeed,
  strideMetres,
} from '@shared/constants';
export { GAITS } from '@shared/types';

/** Quietest → loudest, which is also slowest → fastest. */
export function gaitIndex(gait: Gait): number {
  const i = GAITS.indexOf(gait);
  return i < 0 ? GAITS.indexOf('walk') : i;
}

/** The louder/faster of two gaits. */
export function louderGait(a: Gait, b: Gait): Gait {
  return gaitIndex(a) >= gaitIndex(b) ? a : b;
}

/** One step quieter, or `crouch` if already there. */
export function quieterGait(gait: Gait): Gait {
  return GAITS[Math.max(0, gaitIndex(gait) - 1)] as Gait;
}

/**
 * The gait implied by held modifiers. Crouch wins over sprint, deliberately:
 * when a panicking player mashes both, the quiet one is the safe one to give
 * them, and a controller that resolved it the other way would kill people for
 * a keyboard collision.
 */
export function gaitFromInput(crouchHeld: boolean, sprintHeld: boolean): Gait {
  if (crouchHeld) return 'crouch';
  return sprintHeld ? 'sprint' : 'walk';
}

/** Gaits only mean anything with a floor under you (`GROUNDED`); an AIRBORNE
 *  body covers ground silently. Footsteps must never fire in any other state. */
export function emitsFootsteps(state: PlayerState): boolean {
  return state === 'GROUNDED';
}

/**
 * Distance-based footstep accumulator.
 *
 * Feed it the GROUND-PLANE metres travelled each frame (see `groundDistance` /
 * `groundVelocity` in `./gravity`, which strip the vertical component — a
 * falling body must not be charged footsteps) and it hands back how many
 * footsteps fired. Almost always 0 or 1; more only if a frame was very long or
 * a body was teleported, and the loop below handles that rather than silently
 * dropping steps.
 *
 * CALLER-OWNED, like `railQueryBuffer()`: one per player, so two rooms in one
 * Node process cannot share a cadence.
 */
export class StrideMeter {
  private _gait: Gait;
  private _pending: number;
  private _steps = 0;
  private _distance = 0;

  constructor(gait: Gait = 'walk', primed = true) {
    this._gait = gait;
    this._pending = primed ? STRIDE_START_FRACTION * strideMetres(gait) : 0;
  }

  get gait(): Gait {
    return this._gait;
  }

  get profile(): GaitProfile {
    return gaitProfile(this._gait);
  }

  /** Metres accumulated toward the next footstep. */
  get pending(): number {
    return this._pending;
  }

  /** 0–1 toward the next footstep. The audio foley uses it to place the
   *  footfall inside a bob cycle; nothing gameplay-facing reads it. */
  get phase(): number {
    const stride = strideMetres(this._gait);
    return stride > 0 ? Math.min(1, this._pending / stride) : 0;
  }

  /** Footsteps this meter has fired since the last `reset()`. */
  get steps(): number {
    return this._steps;
  }

  /** Ground metres travelled since the last `reset()`. */
  get distance(): number {
    return this._distance;
  }

  /**
   * Change gait, KEEPING the accumulated distance.
   *
   * Keeping it is the point: a player who breaks into a run mid-stride has
   * already covered that ground, and zeroing it would let them reset the meter
   * on every gait change and cross a station in silence. If the carried
   * distance already exceeds the new (shorter) stride, the next `advance()`
   * fires immediately — which is correct, because it does.
   */
  setGait(gait: Gait): void {
    this._gait = gait;
  }

  /**
   * Feed ground-plane metres. Returns the number of footsteps that fired.
   *
   * Each returned step is one `footstep` NoiseEvent at `footstepLoudness(gait)`
   * — never a continuous emission, and never one per frame.
   */
  advance(metres: number): number {
    if (!(metres > 0)) return 0;
    const stride = strideMetres(this._gait);
    if (!(stride > 0)) return 0;
    this._distance += metres;
    this._pending += metres;
    let fired = 0;
    // Bounded: a pathological dt or a teleport must not spin here.
    while (this._pending >= stride && fired < 64) {
      this._pending -= stride;
      fired++;
    }
    if (fired >= 64) this._pending = 0;
    this._steps += fired;
    return fired;
  }

  /**
   * Drop the accumulator without counting a step. Use it on anything that is
   * not walking: leaving the floor, entering a hide spot, a spawn, a teleport.
   */
  reset(primed = true): void {
    this._pending = primed ? STRIDE_START_FRACTION * strideMetres(this._gait) : 0;
  }

  /** Zero the meter AND its statistics. Round reset. */
  clear(): void {
    this._pending = 0;
    this._steps = 0;
    this._distance = 0;
  }
}

/**
 * Loudness per metre for a gait — `footstep / stride`.
 *
 * The number to reason with when comparing routes rather than instants: at
 * these values crouching costs 7.3 a metre, walking 16.0 and running 26.1, so
 * the quiet gait is genuinely cheaper for the same ground and not merely
 * cheaper per event. `assertConstantsCoherent()` asserts that ordering; without
 * it a "quiet" gait with a very short stride could cost more to get anywhere,
 * and crouching would be strictly worse than walking.
 */
export function loudnessPerMetre(gait: Gait): number {
  return gaitProfile(gait).loudnessPerMetre;
}

/** Total footstep loudness laid down by covering `metres` in `gait`. Not a
 *  single event — the integral of many. Route planning and HUD, not emission. */
export function loudnessOverDistance(gait: Gait, metres: number): number {
  return Math.max(0, metres) * loudnessPerMetre(gait);
}

/** Seconds to cover `metres` at this gait's speed. */
export function secondsToCover(gait: Gait, metres: number): number {
  const speed = gaitSpeed(gait);
  return speed > 0 ? Math.max(0, metres) / speed : Number.POSITIVE_INFINITY;
}

/** Footsteps laid down covering `metres`, ignoring the meter's current phase. */
export function stepsOverDistance(gait: Gait, metres: number): number {
  const stride = strideMetres(gait);
  return stride > 0 ? Math.floor(Math.max(0, metres) / stride) : 0;
}

/** The loudest single footstep any gait produces. The alien's attention
 *  thresholds are sized against it (see `assertConstantsCoherent()`). */
export const LOUDEST_FOOTSTEP: number = Math.max(
  ...GAITS.map((g) => footstepLoudness(g)),
);

/** The quietest. Equal to `LOUDNESS.RAIL_PULL` by design — the cheapest
 *  deliberate movement costs the same 4 in either gravity regime. */
export const QUIETEST_FOOTSTEP: number = Math.min(
  ...GAITS.map((g) => footstepLoudness(g)),
);
