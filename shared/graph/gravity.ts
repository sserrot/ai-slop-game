/**
 * Gravity as a per-module CONDITION (the walking pivot).
 *
 * DESIGN.md pillar 2 said "Nobody walks." Playtest disagreed: zero-G everywhere
 * is the biggest source of motion sickness, it makes hiding impossible, and it
 * makes chases one-dimensional — a 5 m tube gives a fleeing player no corners,
 * so RAIL_SLIDE 1.2 against SPEED_HUNT 3.0 is a foregone conclusion. So every
 * module now has a local floor and players WALK by default; zero-G is a
 * per-module condition a level authors and the §5 director drops mid-round.
 *
 * ONE GLOBAL DOWN (`STATION_DOWN`, −Y). Per-module orientations were rejected:
 * they force a reorientation at every hatch and destroy the spatial mental
 * model pillar 3 exists to protect. Nothing here ever reads a module's
 * transform to decide which way is down, and nothing ever should.
 *
 * Everything in this file is pure maths over plain objects, identical on client
 * and server. The state itself lives on `StationModule.gravity`, mutated in
 * place by `ModuleGraph` exactly the way `Port.hatch` is.
 */

import {
  GRAVITY_WARNING_S,
  LIFTOFF_IMPULSE_M_S,
  STATION_DOWN,
  STATION_GRAVITY_M_S2,
  STATION_UP,
  TERMINAL_VELOCITY_M_S,
  clamp,
  transitionNoise,
} from '@shared/constants';
import type {
  Gait,
  GravityCause,
  GravityMode,
  GravityScope,
  GravityShiftEvent,
  LocomotionTransition,
  LocomotionTransitionKind,
  ModuleId,
  PlayerId,
  PlayerState,
  StationLayout,
  StationModule,
  Vec3,
} from '@shared/types';
import { dot, v3 } from '@shared/graph/math';

export { STATION_DOWN, STATION_UP } from '@shared/constants';

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * Component of `velocity` along `STATION_DOWN`, in m/s.
 *
 * POSITIVE MEANS FALLING. That sign convention is chosen once, here, because
 * five subsystems need "how fast am I coming down" and half of them would
 * otherwise pick the other sign: `landingNoise` takes a positive approach
 * speed, and so does §14's `impactNoise` behind it.
 */
export function downSpeed(velocity: Vec3): number {
  return dot(velocity, STATION_DOWN);
}

/** Signed height of `a` above `b` along `STATION_UP`, in metres. */
export function heightAbove(a: Vec3, b: Vec3): number {
  return (a.x - b.x) * STATION_UP.x + (a.y - b.y) * STATION_UP.y + (a.z - b.z) * STATION_UP.z;
}

/**
 * The part of `v` perpendicular to `STATION_DOWN` — motion across the deck.
 *
 * This is what the stride meter is fed. Counting total displacement instead
 * would charge a falling player footsteps, and counting the raw speed would
 * charge one for walking into a wall.
 */
export function groundVelocity(v: Vec3, out: Vec3 = v3()): Vec3 {
  const along = dot(v, STATION_DOWN);
  out.x = v.x - STATION_DOWN.x * along;
  out.y = v.y - STATION_DOWN.y * along;
  out.z = v.z - STATION_DOWN.z * along;
  return out;
}

/** Metres between `a` and `b` measured in the deck plane, ignoring height. */
export function groundDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  const along = dx * STATION_DOWN.x + dy * STATION_DOWN.y + dz * STATION_DOWN.z;
  const px = dx - STATION_DOWN.x * along;
  const py = dy - STATION_DOWN.y * along;
  const pz = dz - STATION_DOWN.z * along;
  return Math.sqrt(px * px + py * py + pz * pz);
}

/**
 * Integrate one step of free fall onto `velocity`, in place.
 *
 * Clamps the DOWN component to `TERMINAL_VELOCITY_M_S` and leaves the ground
 * component alone. The clamp is not cosmetic: `TERMINAL_VELOCITY_M_S` equals
 * `PUSH_MAX`, which is what keeps `impactNoise`'s codomain inside the §3
 * loudness table no matter how far anybody falls.
 */
export function applyGravity(velocity: Vec3, dt: number): Vec3 {
  const along = dot(velocity, STATION_DOWN);
  const next = Math.min(along + STATION_GRAVITY_M_S2 * dt, TERMINAL_VELOCITY_M_S);
  const delta = next - along;
  velocity.x += STATION_DOWN.x * delta;
  velocity.y += STATION_DOWN.y * delta;
  velocity.z += STATION_DOWN.z * delta;
  return velocity;
}

/** Down-speed after falling `metres` from an initial down-speed `v0`, clamped
 *  to terminal velocity. `sqrt(v0² + 2gh)`. */
export function fallSpeedAfterDrop(metres: number, v0 = 0): number {
  if (metres <= 0) return Math.min(Math.max(v0, 0), TERMINAL_VELOCITY_M_S);
  return Math.min(
    Math.sqrt(Math.max(0, v0) ** 2 + 2 * STATION_GRAVITY_M_S2 * metres),
    TERMINAL_VELOCITY_M_S,
  );
}

// ---------------------------------------------------------------------------
// Module gravity — reading, normalising, scoping
// ---------------------------------------------------------------------------

/** True if `mode` gives the player a floor to stand on. */
export function hasFloor(mode: GravityMode): boolean {
  return mode === 'nominal';
}

/** Does a `GravityScope` admit this mode? `'any'` admits both. */
export function scopeAdmits(scope: GravityScope, mode: GravityMode): boolean {
  return scope === 'any' || scope === mode;
}

/** The `PlayerState` a body defaults into on acquiring this regime, before any
 *  ground check. A floor means you fall onto it; no floor means you drift. */
export function defaultStateFor(mode: GravityMode): PlayerState {
  return hasFloor(mode) ? 'AIRBORNE' : 'FLOATING';
}

/** True if `state` can only exist in a module with the given gravity. `HIDDEN`
 *  is legal in both and returns true for either. */
export function stateAllowedIn(state: PlayerState, mode: GravityMode): boolean {
  switch (state) {
    case 'GROUNDED':
    case 'AIRBORNE':
      return mode === 'nominal';
    case 'FLOATING':
    case 'GRIPPING':
    case 'CHARGING':
      return mode === 'zero';
    case 'HIDDEN':
      return true;
    default: {
      const never: never = state;
      throw new Error(`stateAllowedIn: unhandled PlayerState ${String(never)}`);
    }
  }
}

/**
 * Fill in a module's gravity if the authored JSON predates the field, or
 * carries garbage. Mutates and returns the module.
 *
 * `'nominal'` is the default, and that is the whole pivot in one line: a level
 * that says nothing has floors everywhere. Zero-G has to be asked for.
 */
export function normalizeModuleGravity(module: StationModule): StationModule {
  if (module.gravity !== 'zero' && module.gravity !== 'nominal') {
    module.gravity = 'nominal';
  }
  return module;
}

/** `normalizeModuleGravity` across a whole layout. */
export function normalizeLayoutGravity(layout: StationLayout): StationLayout {
  for (const m of layout.modules) normalizeModuleGravity(m);
  return layout;
}

// ---------------------------------------------------------------------------
// Announcing a change
// ---------------------------------------------------------------------------

/**
 * Build the announcement for a module's gravity changing.
 *
 * `inMs` defaults to `GRAVITY_WARNING_S`, and that delay is the mechanic's
 * fairness guarantee: the plant is heard winding down (a `gravity-shift`
 * NoiseEvent at `LOUDNESS.GRAVITY_SHIFT`, from the module CENTRE) and the floor
 * only lets go afterwards. Pass 0 for a change that is already in effect —
 * a late-joining client reconciling a snapshot, say.
 */
export function gravityShiftEvent(
  module: ModuleId,
  from: GravityMode,
  to: GravityMode,
  cause: GravityCause,
  tick: number,
  inMs: number = GRAVITY_WARNING_S * 1000,
): GravityShiftEvent {
  return { module, from, to, cause, inMs: Math.max(0, inMs), t: tick };
}

// ---------------------------------------------------------------------------
// Transitions between the two regimes
// ---------------------------------------------------------------------------

/** Why a body's gravity regime changed: it moved, or the station did. */
export type TransitionReason = 'crossed' | 'station';

/**
 * Which `LocomotionTransition` a change of regime produces. Returns null when
 * nothing changed.
 *
 *                       reason: 'crossed'      reason: 'station'
 *   nominal → zero      'launch'               'liftoff'
 *   zero → nominal      'settle'               'settle'
 *
 * `'landing'` is NOT produced here — it is the separate later moment when an
 * AIRBORNE body reaches the deck, and the gap between `settle` and `landing` is
 * exactly where the player gets to crouch. Use `landingTransition()` for it.
 */
export function classifyGravityTransition(
  from: GravityMode,
  to: GravityMode,
  reason: TransitionReason,
): LocomotionTransitionKind | null {
  if (from === to) return null;
  if (to === 'zero') return reason === 'crossed' ? 'launch' : 'liftoff';
  return 'settle';
}

export interface TransitionInit {
  kind: LocomotionTransitionKind;
  player: PlayerId;
  module: ModuleId;
  from: GravityMode;
  to: GravityMode;
  at: Vec3;
  /** See `LocomotionTransition.speed`. Negative values are clamped to 0. */
  speed: number;
  gait: Gait;
  /** Server tick (§7). */
  t: number;
}

/**
 * THE transition constructor. Use it rather than building the object literal,
 * so `loudness` comes from `transitionNoise()` in exactly one place — the same
 * discipline §14 applies to every other derived number.
 *
 * `loudness === 0` means EMIT NOTHING. A walking launch, a settle and every
 * liftoff are genuinely silent; a zero-loudness NoiseEvent would sit under
 * FLOOR and propagate nowhere, so sending one is pure wire noise.
 */
export function makeTransition(init: TransitionInit): LocomotionTransition {
  const speed = Math.max(0, init.speed);
  return {
    kind: init.kind,
    player: init.player,
    module: init.module,
    from: init.from,
    to: init.to,
    at: { x: init.at.x, y: init.at.y, z: init.at.z },
    speed,
    gait: init.gait,
    loudness: transitionNoise(init.kind, speed, init.gait),
    t: init.t,
  };
}

/**
 * The moment an AIRBORNE body reaches the deck.
 *
 * `velocity` is the velocity IMMEDIATELY BEFORE the contact is resolved — the
 * same discipline as `resolveImpact`'s `-preVelocity.dot(normal)` in the §4
 * controller, and for the same reason: the loudness is a function of the speed
 * you ARRIVED at, and any response that zeroes the down component first
 * destroys that number in place. A landing sampled after the stop reads 0 m/s
 * and reports one quiet footstep no matter how far you fell.
 */
export function landingTransition(
  player: PlayerId,
  module: ModuleId,
  at: Vec3,
  velocity: Vec3,
  gait: Gait,
  t: number,
): LocomotionTransition {
  return makeTransition({
    kind: 'landing',
    player,
    module,
    from: 'nominal',
    to: 'nominal',
    at,
    speed: Math.max(0, downSpeed(velocity)),
    gait,
    t,
  });
}

/**
 * What the velocity becomes across a transition. Mutates and returns
 * `velocity`.
 *
 * - `launch` — UNCHANGED. Momentum carries you into the zero-G module; there is
 *   no free boost, which is why a sprint (2.4 m/s) buys a real crossing and a
 *   walk (1.4) buys a slow drift.
 * - `liftoff` — your walking velocity plus `LIFTOFF_IMPULSE_M_S` along UP. The
 *   residual push of legs that were holding you down, and the visible cue that
 *   the floor has gone. Small enough that the deck stays in reach for about a
 *   second, which is the window to grab a rail.
 * - `settle` — UNCHANGED. Gravity starts pulling next frame via `applyGravity`.
 * - `landing` — the DOWN component is removed and the ground component kept, so
 *   a body that lands mid-stride keeps walking.
 */
export function applyTransitionVelocity(
  kind: LocomotionTransitionKind,
  velocity: Vec3,
): Vec3 {
  switch (kind) {
    case 'liftoff':
      velocity.x += STATION_UP.x * LIFTOFF_IMPULSE_M_S;
      velocity.y += STATION_UP.y * LIFTOFF_IMPULSE_M_S;
      velocity.z += STATION_UP.z * LIFTOFF_IMPULSE_M_S;
      return velocity;
    case 'landing': {
      const along = dot(velocity, STATION_DOWN);
      if (along > 0) {
        velocity.x -= STATION_DOWN.x * along;
        velocity.y -= STATION_DOWN.y * along;
        velocity.z -= STATION_DOWN.z * along;
      }
      return velocity;
    }
    case 'launch':
    case 'settle':
      return velocity;
    default: {
      const never: never = kind;
      throw new Error(`applyTransitionVelocity: unhandled kind ${String(never)}`);
    }
  }
}

/** Clamp a speed into the range `landingNoise` / `impactNoise` are defined
 *  over. Exported because both the client emitter and the server's
 *  re-derivation must agree on the clamp, not just on the formula. */
export function clampImpactSpeed(v: number): number {
  return clamp(v, 0, TERMINAL_VELOCITY_M_S);
}
