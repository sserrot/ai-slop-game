/**
 * Walking — the default locomotion regime (DESIGN.md §4, the r2 pivot).
 *
 * "Every module has a local floor and players WALK by default. Zero-G is a
 * per-module condition." This file is the machinery that regime needs and that
 * the zero-G controller never had: a body with a height, a probe that finds the
 * deck under it, an acceleration model, and a camera that is allowed to lag the
 * body so none of the above makes anybody ill.
 *
 * Three rules are load-bearing and are implemented literally here:
 *
 *  1. ONE GLOBAL DOWN. Every direction in this file comes from `STATION_DOWN` /
 *     `STATION_UP` in `@shared/graph/gravity`. Nothing reads a module transform
 *     to work out which way is up, and nothing ever should — per-module gravity
 *     DIRECTIONS were considered and rejected outright (§4), because they turn
 *     every hatch into a reorientation puzzle and destroy the spatial mental
 *     model pillar 3 exists to protect.
 *
 *  2. THE GROUND PROBE IS SHORTER THAN THE STEP HEIGHT. `GROUND_PROBE_M` 0.35 <
 *     `STEP_HEIGHT_M` 0.4, and §14 says why: the probe answers "am I standing on
 *     something", the step height answers "may I walk up onto that". A probe
 *     longer than a step is how a controller ends up hovering over a two-step
 *     drop.
 *
 *  3. THE BODY MOVES, THE CAMERA FOLLOWS. Step-ups, ground snaps, crouches and
 *     `settle`s all displace the body vertically in a single frame. `ViewLag`
 *     leaves the camera behind by exactly that correction and lets it catch up
 *     on a half-life. It is comfort only: noise origins, the collider and the §7
 *     transform all read the body, never the lagged eye, which is what stops a
 *     comfort dial from changing what the alien hears.
 */

import * as THREE from 'three';
import { GROUND_PROBE_M, PLAYER_RADIUS, clamp, gaitProfile } from '@shared/constants';
import { STATION_DOWN, STATION_UP } from '@shared/graph/gravity';
import type { Gait } from '@shared/types';
import { halfLifeDecay } from '../core/ticker';
import type { StationCollider } from './collision';
import { makeRayHit, type RayHit } from './collision';
import {
  BOB_LATERAL_FACTOR,
  BOB_MIN_SPEED_FRACTION,
  GROUND_NORMAL_MIN,
  GROUND_PROBE_LIFT_M,
  VIEW_LAG_HALFLIFE_S,
  VIEW_LAG_MAX_M,
} from './tuning';

/** The single global up, as a three vector, for the maths below. */
export const UP = new THREE.Vector3(STATION_UP.x, STATION_UP.y, STATION_UP.z);
/** The single global down. */
export const DOWN = new THREE.Vector3(STATION_DOWN.x, STATION_DOWN.y, STATION_DOWN.z);

const _scratch = new THREE.Vector3();
const _ground = new THREE.Vector3();
const _target = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _probeHit: RayHit = makeRayHit();

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/**
 * The eye height a gait stands at, metres above the feet.
 *
 * §14 keeps a full `GaitProfile` per gait, and both the eye and the collider
 * height live on it — so crouching is genuinely a smaller body and not merely a
 * lower camera. That distinction is the whole point: §4 wants crouch to be
 * useful for getting UNDER things and INTO hide spots, which a camera trick
 * cannot deliver.
 */
export function eyeHeightFor(gait: Gait): number {
  return gaitProfile(gait).eyeHeight;
}

/** The collider height a gait occupies, metres. */
export function bodyHeightFor(gait: Gait): number {
  return gaitProfile(gait).bodyHeight;
}

/**
 * The two sphere centres that make up the walking capsule, as offsets from the
 * EYE — which is the point the whole controller calls `position`, in both
 * regimes, so a `settle` never has to move the player's viewpoint sideways to
 * change body shape.
 *
 * §14 defines the body as "two spheres of PLAYER_RADIUS at floor + r and
 * floor + height − r", and that is transcribed here and nowhere else.
 */
export function capsuleOffsets(
  gait: Gait,
  out: [THREE.Vector3, THREE.Vector3],
): [THREE.Vector3, THREE.Vector3] {
  const eye = eyeHeightFor(gait);
  const height = bodyHeightFor(gait);
  out[0].copy(UP).multiplyScalar(PLAYER_RADIUS - eye);
  out[1].copy(UP).multiplyScalar(height - PLAYER_RADIUS - eye);
  return out;
}

// ---------------------------------------------------------------------------
// The ground probe
// ---------------------------------------------------------------------------

export interface GroundInfo {
  /** A walkable surface is within `GROUND_PROBE_M` of the feet. */
  grounded: boolean;
  /** True if the ray found anything at all, walkable or not. */
  hit: boolean;
  /** Metres from the feet down to that surface. 0 while standing on it. */
  gap: number;
  /** World unit normal of the surface, pointing up out of it. */
  normal: THREE.Vector3;
  /** World contact point. */
  point: THREE.Vector3;
}

export function makeGroundInfo(): GroundInfo {
  return {
    grounded: false,
    hit: false,
    gap: Number.POSITIVE_INFINITY,
    normal: new THREE.Vector3(),
    point: new THREE.Vector3(),
  };
}

/**
 * Is there a deck under these feet?
 *
 * A single ray straight down `STATION_DOWN` from just above the feet. It is not
 * the thing that holds the body up — the capsule depenetration does that, and
 * would do it even if this ray missed — so a ray that slips down a gap between
 * two deck panels costs you the ground SNAP for a frame, not the floor.
 *
 * The `GROUND_NORMAL_MIN` test is what stops a body pressed against the curved
 * hull of a module with no deck from reporting that it is standing on the wall.
 */
export function probeGround(
  collider: StationCollider,
  position: THREE.Vector3,
  eyeHeight: number,
  out: GroundInfo = makeGroundInfo(),
): GroundInfo {
  out.grounded = false;
  out.hit = false;
  out.gap = Number.POSITIVE_INFINITY;
  if (!collider.ready) return out;

  _rayOrigin.copy(position).addScaledVector(UP, GROUND_PROBE_LIFT_M - eyeHeight);
  const far = GROUND_PROBE_LIFT_M + GROUND_PROBE_M;
  const hit = collider.raycast(_rayOrigin, DOWN, far, _probeHit);
  if (!hit.hit) return out;

  out.hit = true;
  out.gap = hit.distance - GROUND_PROBE_LIFT_M;
  out.normal.copy(hit.normal);
  out.point.copy(hit.point);
  out.grounded = out.gap <= GROUND_PROBE_M && hit.normal.dot(UP) >= GROUND_NORMAL_MIN;
  return out;
}

// ---------------------------------------------------------------------------
// Acceleration
// ---------------------------------------------------------------------------

/**
 * Steer the DECK-PLANE component of `velocity` toward `wish * targetSpeed`,
 * in place. The component along `STATION_DOWN` is left completely alone: that
 * one belongs to gravity, to the jump, and to the landing, and mixing them is
 * how a controller ends up cancelling its own fall by walking.
 *
 * `stopHalfLife` is the no-input decay and is `null` while airborne — §14's
 * `AIR_CONTROL` says you may steer a jump, you may not brake in mid-air.
 *
 * While airborne the result is additionally capped at whichever is larger, the
 * speed you came in with or the gait's own speed. Without that cap, repeatedly
 * steering into the acceleration would let a player build speed in the air out
 * of nothing, which is the oldest exploit in first-person movement and would
 * quietly break §4's sprint-2.4-versus-hunt-3.0 bargain.
 */
export function accelerateDeck(
  velocity: THREE.Vector3,
  wish: THREE.Vector3,
  targetSpeed: number,
  accel: number,
  dt: number,
  stopHalfLife: number | null,
): void {
  const along = velocity.dot(DOWN);
  _ground.copy(velocity).addScaledVector(DOWN, -along);
  const entrySpeed = _ground.length();

  if (wish.lengthSq() < 1e-8 || targetSpeed <= 0) {
    if (stopHalfLife !== null) _ground.multiplyScalar(halfLifeDecay(dt, stopHalfLife));
  } else {
    _target.copy(wish).multiplyScalar(targetSpeed);
    _scratch.subVectors(_target, _ground);
    const need = _scratch.length();
    const budget = accel * dt;
    if (need > budget && need > 1e-9) _scratch.multiplyScalar(budget / need);
    _ground.add(_scratch);
    if (stopHalfLife === null) {
      const cap = Math.max(entrySpeed, targetSpeed);
      const now = _ground.length();
      if (now > cap + 1e-6) _ground.multiplyScalar(cap / now);
    }
  }

  velocity.copy(_ground).addScaledVector(DOWN, along);
}

/** The deck-plane part of `v`, written into `out`. */
export function deckComponent(v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(v).addScaledVector(DOWN, -v.dot(DOWN));
}

/** Metres between two world points measured in the deck plane — the number the
 *  `StrideMeter` is fed. Total displacement would charge a falling body for
 *  footsteps it never took (§4). */
export function deckDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  _scratch.subVectors(a, b);
  _scratch.addScaledVector(DOWN, -_scratch.dot(DOWN));
  return _scratch.length();
}

/** Signed height of `a` above `b` along `STATION_UP`. */
export function heightGain(a: THREE.Vector3, b: THREE.Vector3): number {
  return _scratch.subVectors(a, b).dot(UP);
}

// ---------------------------------------------------------------------------
// View lag
// ---------------------------------------------------------------------------

/**
 * How far the camera is currently behind the body, along `STATION_UP`.
 *
 * Every vertical correction the controller makes — a step over a 0.4 m coaming,
 * a snap down a lip, a crouch, the moment a floating sphere becomes a
 * `PLAYER_STAND_HEIGHT_M` body standing on a deck — is fed in here as a signed
 * metre count and comes
 * back out over the next few frames. §13 lists motion sickness as a risk that
 * costs you players; a camera that teleports vertically is the most reliable way
 * to cause it, and there is no version of this controller that does not make
 * those corrections.
 */
export class ViewLag {
  private _value = 0;

  get value(): number {
    return this._value;
  }

  /**
   * The body just moved `metres` UP. Push the camera the other way by the same
   * amount so it holds still, then let `update` bring it back.
   */
  bodyMovedUp(metres: number): void {
    if (!Number.isFinite(metres) || metres === 0) return;
    this._value = clamp(this._value - metres, -VIEW_LAG_MAX_M, VIEW_LAG_MAX_M);
  }

  update(dt: number): number {
    if (this._value === 0) return 0;
    this._value *= halfLifeDecay(dt, VIEW_LAG_HALFLIFE_S);
    if (Math.abs(this._value) < 1e-4) this._value = 0;
    return this._value;
  }

  reset(): void {
    this._value = 0;
  }
}

// ---------------------------------------------------------------------------
// Head bob
// ---------------------------------------------------------------------------

/**
 * The §4 comfort head bob, driven by the STRIDE rather than by a clock.
 *
 * Everything else about walking is measured in ground covered (§3: "a stride is
 * a distance, never a timer"), so the bob is too — which means the camera dips
 * exactly when a footstep fires, at every gait, for free. It is scaled by
 * `ComfortOptions.headBob` and it changes NOTHING about the noise: §4 says a
 * comfort setting may not alter what the alien hears, and this is the setting
 * that would be most tempting to let leak.
 */
export class HeadBob {
  private amount = 0;
  private readonly offset = new THREE.Vector3();

  /**
   * @param phase01  the stride meter's phase toward the next footstep
   * @param active   grounded, moving, and the player asked for a bob
   * @param amplitude metres at full strength (BOB_AMPLITUDE_M × comfort dial)
   * @param speedFraction current deck speed over the gait's own speed
   */
  update(
    dt: number,
    phase01: number,
    active: boolean,
    amplitude: number,
    speedFraction: number,
    right: THREE.Vector3,
  ): THREE.Vector3 {
    const want = active && speedFraction > BOB_MIN_SPEED_FRACTION ? clamp(speedFraction, 0, 1) : 0;
    // Ramp rather than switch: a bob that snaps on when you start walking reads
    // as a glitch, and one that snaps off mid-cycle reads as a hitch.
    const k = halfLifeDecay(dt, 0.12);
    this.amount = want + (this.amount - want) * k;
    if (this.amount < 1e-3) {
      this.amount = 0;
      return this.offset.set(0, 0, 0);
    }
    const theta = phase01 * Math.PI * 2;
    const scale = amplitude * this.amount;
    // Lowest at the footfall (phase 0), highest at mid-stride.
    this.offset.copy(UP).multiplyScalar(-Math.cos(theta) * scale);
    this.offset.addScaledVector(right, Math.sin(theta) * scale * BOB_LATERAL_FACTOR);
    return this.offset;
  }

  reset(): void {
    this.amount = 0;
    this.offset.set(0, 0, 0);
  }

  get value(): THREE.Vector3 {
    return this.offset;
  }
}
