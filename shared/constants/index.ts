/**
 * ISS — tuning constants. DESIGN.md §14 is the single source of truth.
 *
 * IMPORT THESE. NEVER RE-TYPE THEM. Change one, re-check the set — §14's own
 * warning, earned the hard way: r1's floor, attenuation and error formula were
 * individually plausible and jointly broken.
 *
 * `assertConstantsCoherent()` at the bottom encodes the six §14 sanity checks and
 * throws if any fails. It runs automatically once at module load in dev.
 */

import type {
  DirectorStage,
  DirectorStageConfig,
  Gait,
  GaitProfile,
  LocomotionTransitionKind,
  NoiseKind,
  Vec3,
} from '@shared/types';
// A value import, and safe: `@shared/types` imports nothing at all, so it can
// never close a cycle. Re-typing the gait list here would breach §14's own rule.
import { GAITS } from '@shared/types';

// ===========================================================================
// The station frame — ONE global "down" for the whole station
// ===========================================================================

/**
 * THE global down vector. There is exactly one, and every module shares it.
 *
 * Per-module gravity DIRECTIONS were considered and rejected outright. A
 * station where each tube has its own floor forces a reorientation at every
 * single hatch, and the player's spatial mental model — the thing pillar 3
 * exists to protect — cannot survive that. What varies per module is whether
 * there is a floor at all (`StationModule.gravity`), never which way it faces.
 *
 * −Y, matching the kit: handrails are authored below each module's axis
 * (`railOffset` in `src/station/kit.ts`), the level's modules are laid out on a
 * horizontal plane, and −Y is what three.js, every artist and every player
 * already assume "down" means. Unit length.
 */
export const STATION_DOWN: Readonly<Vec3> = Object.freeze({ x: 0, y: -1, z: 0 });

/** `-STATION_DOWN`. Provided so nobody negates the vector by hand and gets it
 *  subtly wrong in one of five subsystems. Unit length. */
export const STATION_UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });

/**
 * Metres — the length of a straight kit piece (§2 "straight 5m").
 *
 * It was a bare `5` inside three different sanity checks and a private constant
 * in two layout builders. It is a real shared dimension: every "carries roughly
 * N modules" claim in §3 and every chase-geometry number below is measured in
 * it.
 */
export const MODULE_LENGTH_M = 5;

// ===========================================================================
// §14 — Propagation
// ===========================================================================

/** dB (loudness points) lost per metre travelled. Linear, not inverse-square:
 *  realism here makes the mechanic illegible (§3). */
export const ATTENUATION_PER_M = 1.0;

/** Physical audibility floor. Below this a sound does not exist for anyone. */
export const FLOOR = 2;

/**
 * Hatch dB offsets. NEGATIVE by §14 convention — they are offsets you ADD to a
 * level, matching `Port.hatch.attenuationDb`. The §3 formula subtracts their
 * magnitudes; `graph/noise.ts` adds these signed values, which is the same thing.
 */
export const HATCH_OPEN = -3;
export const HATCH_CLOSED = -25;
export const HATCH_SEALED = -40;

// ===========================================================================
// §14 — Attention (see the director for PATROL at stage > 0)
// ===========================================================================

/** Arrival level PATROL bothers to react to, at director stage 0. */
export const ATTN_PATROL = 12;
/** Arrival level INVESTIGATE and SEARCH react to. */
export const ATTN_SEARCH = 4;
/**
 * HUNT reacts to "anything" (§3 table). Not a §14 constant — 0 is the encoding
 * of "no threshold", since nothing below FLOOR ever arrives at all.
 */
export const ATTN_HUNT = 0;

// ===========================================================================
// §14 — Localization
// ===========================================================================

/** Clamp helper, exported because the graph and AI both need it. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * §14: `errorRadius(level) = clamp((70 - level) / 5, 2, 12)` — metres.
 *
 * The alien investigates `origin + randomInSphere(errorRadius)` (§5). The 2m
 * minimum is the fairness guarantee: it can never teleport-pin anybody.
 */
export function errorRadius(level: number): number {
  return clamp((70 - level) / 5, 2, 12);
}

export const ERROR_RADIUS_MIN_M = 2;
export const ERROR_RADIUS_MAX_M = 12;

// ===========================================================================
// §14 — Coalescing (§3)
// ===========================================================================

/** Rolling window; act on the loudest event in it. */
export const WINDOW_MS = 1000;
/** Discard by margin, not absolutely: drop only events more than this far below
 *  the window's loudest. Anything within it is a secondary investigation target. */
export const DISCARD_MARGIN = 15;
/** Each consecutive window whose loudest event comes from the same module widens
 *  that module's effective error radius by this much. */
export const REPEAT_PENALTY_M = 3;
/** …to a maximum of +12 (§14 "per repeat, max +12"). */
export const REPEAT_PENALTY_MAX_M = 12;

// ===========================================================================
// §14 — Player (§4)
// ===========================================================================

/** m/s — WASD slide along a gripped rail. Deliberately below SPEED_PATROL. */
export const RAIL_SLIDE = 1.2;
/** m/s — release velocity at charge 0. */
export const PUSH_MIN = 2;
/** m/s — release velocity at charge 1. Down from r1's 9 (§4). */
export const PUSH_MAX = 6;
/** s — charge 0→1 while holding Space in GRIPPING. */
export const CHARGE_TIME = 1.2;
/** m — buffered auto-latch range. Hold Grip; the first rail entering range catches. */
export const GRAB_RANGE = 0.8;
/** s — air drag half-life: `vel *= 0.5 ** (dt / DRAG_HALFLIFE)`. Specify
 *  half-lives, never bare exponents (§4). */
export const DRAG_HALFLIFE = 4.0;

/** Swept-sphere radius of the player capsule against the static BVH (§4).
 *  0.3 → 0.27 in the proportional scale-down pass — see the block comment on
 *  `PLAYER_STAND_HEIGHT_M`; the whole body shrinks together or not at all. */
export const PLAYER_RADIUS = 0.23;

/** §14 — clean, arrested rail catch. Quiet enough that skill buys silence. */
export function catchNoise(v: number): number {
  return 8 + 3 * v;
}

/** §14 — uncontrolled impact. 51 at the 6 m/s cap; a pry bar is 60. */
export function impactNoise(v: number): number {
  return 15 + 6 * v;
}

// ===========================================================================
// WALKING — the pivot. Gravity is a per-module condition, not the default.
// ===========================================================================
//
// DESIGN.md pillar 2 said "Nobody walks." It was wrong, and the playtest that
// proved it is worth restating: zero-G everywhere is the biggest source of
// motion sickness, it makes hiding impossible, and it makes every chase
// one-dimensional. A 5 m tube offers a fleeing player no corners, no sightline
// breaks and no escape geometry, so at RAIL_SLIDE 1.2 against SPEED_HUNT 3.0
// the alien always wins. "The monster finds you basically instantly and is
// faster than you."
//
// So: every module has a local floor along STATION_DOWN and players walk by
// default; zero-G is a per-module CONDITION (`StationModule.gravity`) that a
// level can author and the §5 director can drop mid-round.
//
// Nothing else in the design moves. §3's propagation, §5's FSM, §7's client
// authority and §14's whole loudness table are untouched — the new numbers
// below are slotted INTO that table's existing ladders, and the sanity checks
// at the bottom assert they landed in the right rungs.

/**
 * m/s² along `STATION_DOWN` in a `nominal` module.
 *
 * Earth-normal, not a "space station" number. Every player's intuition for how
 * long a fall takes is calibrated on 9.81, and pillar 3 says legibility beats
 * realism every time they disagree. A weaker field would also stretch the drop
 * after a `settle`, which is dead time in the one moment the design wants to be
 * sharp.
 */
export const STATION_GRAVITY_M_S2 = 9.81;

/**
 * m/s — hard cap on fall speed, and with it the top of `impactNoise`'s domain.
 *
 * Deliberately equal to `PUSH_MAX`. The §3 table tops its movement tier out at
 * "uncontrolled impact 51 at 6 m/s", and `noiseLoudness()` clamps speed to
 * `PUSH_MAX` for exactly that reason. Letting a fall exceed it would put a
 * routine trip above a thrown decoy on a scale that has no room left, so the
 * whole game — pushed, thrown or dropped — moves at 6 m/s or less. Reached from
 * rest in 0.61 s over 1.83 m, which is inside one module's height.
 */
export const TERMINAL_VELOCITY_M_S = 6;

/**
 * m/s — the server's anti-teleport bound (§7 "the server sanity-checks speed
 * and teleports").
 *
 * The worst legal case is a body at `TERMINAL_VELOCITY_M_S` straight down with
 * full lateral air control: `hypot(6, 2.4)` = 6.46 m/s. 7.0 covers it with
 * headroom for one tick of network jitter, and is still nowhere near a
 * meaningful cheat.
 */
export const MAX_LEGAL_SPEED_M_S = 7.0;

/**
 * m — how high you jump from a standing start under `STATION_GRAVITY_M_S2`.
 *
 * Small, and the smallness is the design. Landing speed from a flat jump is
 * `sqrt(2 g h)` = 2.97 m/s, which sits ABOVE the walk gait's silent-landing
 * tolerance (1.8) and BELOW the crouch gait's (3.4): jumping is loud unless you
 * land in a crouch. That is the entire jump mechanic, and it costs one number.
 */
export const JUMP_HEIGHT_M = 0.45;

/** m/s — derived launch speed for `JUMP_HEIGHT_M`. `sqrt(2 g h)` = 2.97. */
export const JUMP_SPEED_M_S = Math.sqrt(2 * STATION_GRAVITY_M_S2 * JUMP_HEIGHT_M);

/** m — ledge height you walk over without jumping. Racks, cable runs, the lip
 *  of a hatch coaming. Below `PLAYER_CROUCH_HEIGHT_M` so a step never clips a
 *  crouching body's head into geometry. */
export const STEP_HEIGHT_M = 0.4;

/**
 * m — how far below the feet the ground probe looks for a deck.
 *
 * Shorter than `STEP_HEIGHT_M`: the probe answers "am I standing on something",
 * the step height answers "may I walk up onto that". Making the probe the
 * longer of the two is how a controller ends up hovering over a two-step drop.
 */
export const GROUND_PROBE_M = 0.35;

/** m — the largest downward snap that keeps a walking body glued to the deck
 *  over a lip or a ramp. Above it you become AIRBORNE and fall properly. */
export const GROUND_SNAP_M = 0.4;

/** m/s² — ground acceleration toward the gait's speed. High: this is a horror
 *  game, not a driving sim, and mushy starts read as input lag. */
export const GROUND_ACCEL_M_S2 = 24;

/** s — half-life of the ground velocity when no input is held. 60 ms is a
 *  crisp stop without the dead feel of a hard zero. */
export const GROUND_STOP_HALFLIFE_S = 0.06;

/** Fraction of `GROUND_ACCEL_M_S2` available while AIRBORNE. You may steer a
 *  jump; you may not accelerate out of a fall. */
export const AIR_CONTROL = 0.25;

/**
 * Suit thrusters (§4 amendment) — weak, continuous, camera-relative
 * acceleration while FLOATING, m/s².
 *
 * Rails and push-offs stayed the FAST way across a module, but they were also
 * the ONLY way, and that made zero-G freight (§11 cargo stow) nearly
 * unplayable: a body drifting with a bag had no input that moved it. The suit
 * now has a cold-gas RCS: WASD thrusts relative to where you are looking, so
 * W climbs where you look, S burns retrograde to stop, and a stranded body is
 * never truly stranded. Deliberately WEAK — a fifth of a push-off's top speed,
 * reached over a full second — so the §4 movement grammar (grab, pull, commit)
 * still wins every race; the thruster is how you steer freight and recover,
 * not how you flee. Silent, like drifting: §3 has no row for it, and the zero
 * loudness rule means no event is emitted.
 */
export const FLOAT_THRUST_M_S2 = 1.6;
/** m/s — thrust stops ADDING speed here (it may still redirect or brake a
 *  faster body). Under every gait speed and far under `PUSH_MAX`. */
export const FLOAT_THRUST_MAX_M_S = 1.2;

/** m — camera bob amplitude at `headBob = 1`, scaled by gait cadence. Comfort
 *  may zero it (`ComfortOptions.headBob`); noise never changes with it. */
export const BOB_AMPLITUDE_M = 0.045;

// -- collider ---------------------------------------------------------------
//
// The player is a capsule of `PLAYER_RADIUS` and one of the heights below: two
// spheres, at `floor + PLAYER_RADIUS` and `floor + height − PLAYER_RADIUS`. In
// `zero` modules it collapses back to the single §4 swept sphere, which is why
// `PLAYER_RADIUS` is shared between the two regimes and why the two hard-won
// fixes in the sweep — the pre-restitution approach speed in `resolveImpact`,
// and shut hatches stopping the body — carry over unchanged.
//
// The straight kit piece has a `TUBE_RADIUS_M` interior radius
// (`src/station/kit.ts` builds against it), and `DECK_HEADROOM_M` is derived
// from that and the deck inset rather than chosen. `PLAYER_STAND_HEIGHT_M` is
// sized against the headroom, not against a person — but the tube is no longer
// the constraint it was: at a 1.0 m bore the margin over a standing collider was
// 5 cm and every fitting in the kit had to be budgeted around it, and at 1.5 m
// it is 0.65 m. What still makes the station feel cramped is the FURNITURE, not
// the bore, which is where §2's chase geometry moved the problem on purpose.

// Scaled down three times, all off playtest reads. First ~6%: the body was
// sized to a 1.75 m headroom and read as oversized once the tube widened.
// Then 1.6 → 1.52, which fixed nothing, because the complaint was never the
// height — it was PROPORTION: "the model feels too big relative to everything
// else." So the third pass scales the whole body uniformly — radius (see
// PLAYER_RADIUS), stand, crouch and both eyes together — which reads as the
// station getting roomier rather than the ceiling getting closer. Settled at
// 10% off the 1.52/0.30 body after trying 8%. Fourth pass: a further uniform
// -15% (1.37 → 1.16), same rationale as the third — proportion against the
// station, not headroom — requested once the GLB alien landed and the crew
// read large beside it. The eye keeps its scaled ~0.12 m offset below the
// crown, and `RAIL_ABOVE_DECK_M` tracks the height by definition — re-run
// `buildLevel.ts` so the authored rails follow.
export const PLAYER_STAND_HEIGHT_M = 1.16;
export const PLAYER_CROUCH_HEIGHT_M = 0.73;
export const EYE_HEIGHT_STAND_M = 1.05;
export const EYE_HEIGHT_CROUCH_M = 0.61;

/**
 * m — where the deck sits, as an offset from a module's centreline, in the
 * global down axis. The straight kit piece has a 1.0 m interior radius, so a
 * deck 0.75 m below centre leaves 1.75 m of headroom and a 1.32 m wide walking
 * surface (`2 × √(1² − 0.75²)`) — cramped, which is correct for a station.
 *
 * This constant exists to settle a handshake that two independently-written
 * subsystems would otherwise each guess at: the player controller sizes its
 * body and ground probe against the deck, and the station kit builds the deck
 * geometry. If they disagree the player either clips the ceiling or hovers.
 * One number, imported by both. `assertConstantsCoherent()` checks the fit.
 */
export const DECK_Y_M = -0.75;

/**
 * m — interior radius of a straight tube. `src/station/kit.ts` builds against
 * this rather than its own literal.
 *
 * Widened from 1.0 after a playtest: "the corridors are way too narrow". At 1.0
 * the deck was 1.32 m wide and a 0.70 m player left about 30 cm of clearance on
 * each side, which reads as a crawlspace rather than a corridor — and it made
 * the chase geometry §2 asks for impossible, because there was no room to put
 * anything beside the walking line.
 */
export const TUBE_RADIUS_M = 1.5;

/**
 * m — half-width of the walkable deck, DERIVED from the tube radius and the
 * deck inset rather than typed. These three numbers are one piece of geometry;
 * hand-typing the result is how they drift apart.
 */
export const DECK_HALF_WIDTH_M = Math.sqrt(TUBE_RADIUS_M * TUBE_RADIUS_M - DECK_Y_M * DECK_Y_M);

/** m — headroom from the deck to the top of a straight tube. Derived, as above. */
export const DECK_HEADROOM_M = TUBE_RADIUS_M - DECK_Y_M;

/**
 * m — height of every handrail above the deck, station-wide.
 *
 * Rails were moved overhead after a playtest: floor-level bars read as clutter
 * to walk past, and after the gravity pivot they are scenery in a `nominal`
 * module anyway. They stay fully load-bearing in `zero` modules, where there is
 * no up and an overhead rail is just a rail.
 *
 * Clears a standing crewmember by 0.22 m. It lives here, not in the kit, because
 * three separate things must agree on it: `src/station/kit.ts` builds the
 * authored station's rails, `server/station/layout.ts` builds the procedural
 * fallback's, and the controller has to be able to REACH one — §4 promises 2.5 s
 * of warning before gravity fails, which is only fair if there is something
 * grabbable overhead. Two of those used to hold their own copy.
 */
export const RAIL_ABOVE_DECK_M = PLAYER_STAND_HEIGHT_M + 0.22;

/** m — the module-space Y that `RAIL_ABOVE_DECK_M` puts a rail at. */
export const RAIL_Y_M = DECK_Y_M + RAIL_ABOVE_DECK_M;

// ===========================================================================
// GAIT — three speeds, three loudnesses, one stride model
// ===========================================================================
//
// Noise is emitted PER FOOTSTEP, never continuously, and the stride is measured
// in METRES OF TRAVEL rather than seconds. Distance is the honest unit: it
// makes noise scale with how far you actually went, so a player who shuffles
// against a wall pays nothing and a player who crosses a module pays the same
// whether they did it in one burst or ten. A timer would charge the first
// player and undercharge the second.
//
// SPEEDS. The brief is exact: sprint must exceed SPEED_PATROL (1.5) so fleeing
// works at all, and stay below SPEED_HUNT (3.0) so escaping requires geometry
// rather than raw speed. The full ladder the three gaits slot into — asserted
// end to end in `assertConstantsCoherent()` — is:
//
//   crouch 0.75  <  RAIL_SLIDE 1.2 = SPEED_SEARCH 1.2  <  walk 1.4
//                <  SPEED_PATROL 1.5  <  sprint 2.4  <  SPEED_HUNT 3.0
//                <  PUSH_MAX 6.0
//
// Read it left to right and the whole game is in it. Crouching is slower than
// pulling yourself along a handrail, so the quiet option costs real time in
// both regimes. Walking beats a SEARCH sweep but loses to a PATROL, so you are
// slowly run down if you never commit. Sprinting beats a patrol by 0.9 m/s and
// loses to a hunt by 0.6 — at which rate the alien needs 8.3 s to close one
// module length while you cover four more, which is the four corners the old
// design could not give you. And a push-off is still the fastest thing in the
// game, so zero-G stays the high-risk shortcut it was always meant to be
// instead of becoming a punishment.

/** m/s — crouched. Half a walk, and slower than a handrail pull. */
export const SPEED_CROUCH = 0.75;
/** m/s — the default. Just under SPEED_PATROL: never quite outrun, never
 *  caught by a sweep. */
export const SPEED_WALK = 1.4;
/**
 * m/s — sprint. `SPEED_PATROL < SPEED_SPRINT < SPEED_HUNT`, by design and by
 * assertion. 2.4 leaves 0.9 m/s over a patrol and 0.6 m/s under a hunt.
 */
export const SPEED_SPRINT = 2.4;

/** Loudness of one crouched footstep. Equal to `LOUDNESS.RAIL_PULL` on purpose:
 *  the quietest deliberate movement in the game costs 4 in either regime. */
export const FOOTSTEP_CROUCH = 4;
/** Loudness of one walking footstep. Exactly `ATTN_PATROL`, so a patrolling
 *  alien hears you walk only at point-blank range — and hears it from a module
 *  away by stage 4, when the threshold has sharpened to 4. */
export const FOOTSTEP_WALK = 12;
/** Loudness of one sprinting footstep. Above every PATROL threshold at every
 *  stage and every crew size: running is ALWAYS heard. */
export const FOOTSTEP_RUN = 30;

/** m of travel per footstep, per gait. Short shuffling steps crouched, long
 *  ones at a run — so cadence rises with speed but not proportionally. */
export const STRIDE_CROUCH_M = 0.55;
export const STRIDE_WALK_M = 0.75;
export const STRIDE_RUN_M = 1.15;

/**
 * m/s of closing speed along `STATION_DOWN` that each gait absorbs silently.
 *
 * The crouch value is the load-bearing one: it is above `JUMP_SPEED_M_S`
 * (2.97), so a jump landed in a crouch is a single 4-loudness footstep, and a
 * jump landed on the run is `impactNoise(2.97)` = 33. Same physics, 29 points
 * of difference, bought with one keypress and a fraction of a second of
 * foresight. That is the §11 loud-fast/quiet-slow rule applied to locomotion.
 */
export const LANDING_SOFT_CROUCH_MPS = 3.4;
export const LANDING_SOFT_WALK_MPS = 1.8;
export const LANDING_SOFT_SPRINT_MPS = 1.2;

/**
 * Fraction of a stride the meter starts primed at when you begin moving from a
 * standstill. Without it the first footstep is a full stride away and starting
 * to move is silent, which teaches the wrong model. Half a stride puts the
 * first step where a real first step is.
 */
export const STRIDE_START_FRACTION = 0.5;

/**
 * THE gait table. Everything the controller, the audio foley and the server's
 * loudness re-derivation need, in one place, with the derived fields precomputed
 * so five subsystems cannot round them three different ways.
 */
export const GAIT_PROFILES: Readonly<Record<Gait, GaitProfile>> = Object.freeze({
  crouch: Object.freeze({
    gait: 'crouch',
    speed: SPEED_CROUCH,
    strideM: STRIDE_CROUCH_M,
    footstep: FOOTSTEP_CROUCH,
    landingSoftMaxMps: LANDING_SOFT_CROUCH_MPS,
    eyeHeight: EYE_HEIGHT_CROUCH_M,
    bodyHeight: PLAYER_CROUCH_HEIGHT_M,
    cadenceHz: SPEED_CROUCH / STRIDE_CROUCH_M,
    loudnessPerMetre: FOOTSTEP_CROUCH / STRIDE_CROUCH_M,
  }) as GaitProfile,
  walk: Object.freeze({
    gait: 'walk',
    speed: SPEED_WALK,
    strideM: STRIDE_WALK_M,
    footstep: FOOTSTEP_WALK,
    landingSoftMaxMps: LANDING_SOFT_WALK_MPS,
    eyeHeight: EYE_HEIGHT_STAND_M,
    bodyHeight: PLAYER_STAND_HEIGHT_M,
    cadenceHz: SPEED_WALK / STRIDE_WALK_M,
    loudnessPerMetre: FOOTSTEP_WALK / STRIDE_WALK_M,
  }) as GaitProfile,
  sprint: Object.freeze({
    gait: 'sprint',
    speed: SPEED_SPRINT,
    strideM: STRIDE_RUN_M,
    footstep: FOOTSTEP_RUN,
    landingSoftMaxMps: LANDING_SOFT_SPRINT_MPS,
    eyeHeight: EYE_HEIGHT_STAND_M,
    bodyHeight: PLAYER_STAND_HEIGHT_M,
    cadenceHz: SPEED_SPRINT / STRIDE_RUN_M,
    loudnessPerMetre: FOOTSTEP_RUN / STRIDE_RUN_M,
  }) as GaitProfile,
} as const);

/** The gait table row. Unknown gaits fall back to `walk` rather than throwing —
 *  a bad value on the wire must not take a room down. */
export function gaitProfile(gait: Gait): GaitProfile {
  return GAIT_PROFILES[gait] ?? GAIT_PROFILES.walk;
}

/** m/s over the ground for a gait. */
export function gaitSpeed(gait: Gait): number {
  return gaitProfile(gait).speed;
}

/** Loudness of ONE footstep in this gait (§3). */
export function footstepLoudness(gait: Gait): number {
  return gaitProfile(gait).footstep;
}

/** Metres of travel between footsteps in this gait. */
export function strideMetres(gait: Gait): number {
  return gaitProfile(gait).strideM;
}

/**
 * Loudness of arriving on the deck at `approachSpeed` m/s in `gait`.
 *
 * Below the gait's `landingSoftMaxMps` it is one ordinary footstep — you
 * absorbed it. Above, it is an uncontrolled impact and falls through to §14's
 * `impactNoise`, floored at the gait's own footstep so a hard landing is never
 * reported quieter than the step it replaced (a sprinting landing at 1.3 m/s
 * would otherwise come in at 23, under the 30 the same stride costs).
 *
 * Monotone non-decreasing in BOTH arguments — faster is never quieter, and a
 * louder gait is never quieter at the same speed. Asserted.
 */
export function landingNoise(approachSpeed: number, gait: Gait): number {
  const profile = gaitProfile(gait);
  const v = clamp(approachSpeed, 0, PUSH_MAX);
  if (v <= profile.landingSoftMaxMps) return profile.footstep;
  return Math.max(impactNoise(v), profile.footstep);
}

// ===========================================================================
// GRAVITY TRANSITIONS — crossing between the two regimes
// ===========================================================================

/**
 * s — how long before a module's gravity actually changes that the plant is
 * heard winding down or up.
 *
 * The fairness guarantee for the whole mechanic, and pillar 3's price of entry:
 * the floor never simply vanishes. 2.5 s is 6.0 m at a sprint — more than enough
 * to reach the middle of a 5 m module and get a hand on a handrail, or to leave
 * through the hatch you came in by.
 */
export const GRAVITY_WARNING_S = 2.5;

/**
 * ms a director-dropped module stays in `zero` before the plant recovers on its
 * own. A §11 puzzle can restore it sooner. Set to `Infinity` for a level that
 * wants a permanent failure.
 */
export const GRAVITY_FAIL_DURATION_MS = 90_000;

/**
 * m/s of upward drift a standing body picks up when gravity fails underneath
 * it. Not a launch — the residual push of legs that were holding you down.
 * Small enough that you stay in reach of the deck for about a second, which is
 * the window to grab a rail.
 */
export const LIFTOFF_IMPULSE_M_S = 0.6;

/**
 * m/s below which crossing into a `zero` module is a silent drift rather than a
 * push-off. Equal to `PUSH_MIN`, which is not a coincidence: §14 already
 * defines 2 m/s as the slowest thing that counts as a push, so a walk (1.4)
 * drifts in for free and a sprint (2.4) pays `LOUDNESS.PUSH_OFF`. The rule
 * needed no new number, only the observation that it was already there.
 */
export const LAUNCH_MIN_SPEED_M_S = PUSH_MIN;

/**
 * Loudness a `LocomotionTransition` emits. 0 means emit NO NoiseEvent at all —
 * a `settle`, a `liftoff` and a walking `launch` are genuinely silent, and a
 * zero-loudness event would sit below FLOOR and propagate nowhere anyway.
 */
export function transitionNoise(
  kind: LocomotionTransitionKind,
  speed: number,
  gait: Gait,
): number {
  switch (kind) {
    case 'landing':
      return landingNoise(speed, gait);
    case 'launch':
      // Momentum is conserved, so the sound is the push it amounts to.
      return speed >= LAUNCH_MIN_SPEED_M_S ? LOUDNESS.PUSH_OFF : 0;
    case 'settle':
    case 'liftoff':
      // The station made the noise, not you: the plant's `gravity-shift` is
      // already on the wire at LOUDNESS.GRAVITY_SHIFT from the module centre.
      return 0;
    default: {
      const never: never = kind;
      throw new Error(`transitionNoise: unhandled kind ${String(never)}`);
    }
  }
}

// ===========================================================================
// HIDING — the alien is blind, so hiding is geometry plus silence
// ===========================================================================
//
// DESIGN.md has no hiding mechanic, which is a real genre gap and one the
// walking pivot finally makes buildable: a floor means lockers, bays and bunks
// are things you can get INTO.
//
// The rule is one sentence, which is the pillar-3 test: the alien will not
// sweep through a hide spot, so it cannot find you by walking into you — but it
// hears everything you do in there, minus the shell. NO SIGHT LOGIC. Not here,
// not in the alien, not ever.

/**
 * dB the shell takes off the occupant's own noise. NEGATIVE and additive,
 * exactly like a hatch offset, so `level + muffleDb` is the whole implementation.
 *
 * WHY −8. It is sized off the one sound a hidden player cannot stop making:
 * panicked breathing at `BREATHING_MAX` (14). 14 − 8 = 6 at the spot, which
 * decays under `ATTN_SEARCH` (4) after `HIDE_SAFE_RADIUS_M` metres. So the thing
 * has to be practically leaning on the locker before your breathing gives you
 * away — tense, survivable, and completely legible once it has happened to you
 * once. A deeper muffle would make hiding a win button; a shallower one would
 * make it theatre.
 */
export const HIDE_MUFFLE_DB = -8;

/** m — how close the alien must get before a maximally panicked occupant is
 *  audible to a SEARCH sweep. Derived from HIDE_MUFFLE_DB and asserted. */
export const HIDE_SAFE_RADIUS_M = 3;

/** Loudness of climbing carefully into or out of a hide spot. Under every
 *  PATROL threshold at every crew size: the quiet-slow path is genuinely quiet. */
export const HIDE_QUIET = 8;
/** Loudness of diving in. Above every PATROL threshold: a last-second dive is
 *  always heard, which is what makes hiding early the skilled play. */
export const HIDE_LOUD = 30;

/** s — the careful entry. Long enough that you cannot buy it once it is hunting. */
export const HIDE_ENTER_TIME_SLOW_S = 2.5;
/** s — the dive. */
export const HIDE_ENTER_TIME_FAST_S = 0.5;

/** Bodies per spot when the author does not say. */
export const HIDE_SPOT_CAPACITY_DEFAULT = 1;

/**
 * m — how close the alien must be, WITH a fix on the spot, to start working it
 * open. Contact range: it has to be at the door.
 */
export const HIDE_BREACH_RANGE_M = 1.2;

/**
 * s the alien spends breaching before the kill lands, at `LOUDNESS.HIDE_BREACH`
 * throughout. The window exists so a player who is heard can still bail out —
 * loudly, into a room with the thing in it, which is a decision rather than a
 * cutscene.
 */
export const HIDE_BREACH_TIME_S = 2.0;

/** Minimum hide spots an authored station needs to be playable — roughly one
 *  per module across §2's 8–10, minus the escape and finale modules. */
export const HIDE_SPOTS_MIN = 6;

/** Loudness of entering or leaving a hide spot at `haste` 0–1 (§11's
 *  loud-fast / quiet-slow rule, applied to a movement verb). */
export function hideNoise(haste01: number): number {
  return HIDE_QUIET + clamp(haste01, 0, 1) * (HIDE_LOUD - HIDE_QUIET);
}

/** Seconds entering or leaving takes at `haste` 0–1. */
export function hideEnterSeconds(haste01: number): number {
  return HIDE_ENTER_TIME_SLOW_S +
    clamp(haste01, 0, 1) * (HIDE_ENTER_TIME_FAST_S - HIDE_ENTER_TIME_SLOW_S);
}

/**
 * Apply a hide spot's shell to a loudness. Clamped at 0, never negative —
 * `propagate()` treats anything under FLOOR as inaudible and a negative source
 * level would poison gain maths downstream.
 */
export function muffledLoudness(loudness: number, muffleDb: number = HIDE_MUFFLE_DB): number {
  return Math.max(0, loudness + Math.min(0, muffleDb));
}

// ===========================================================================
// ZERO-G AS A CONDITION — how much of the station may lack a floor
// ===========================================================================

/**
 * The most modules a LEVEL may author as `gravity: 'zero'`.
 *
 * Two of §2's 8–10. Zero-G is a spike, not a tax: authoring half the station
 * without a floor rebuilds exactly the round the pivot exists to delete.
 */
export const ZERO_G_AUTHORED_MAX = 2;

/**
 * Hard ceiling on the fraction of the station that may be in `zero` at once,
 * authored plus director-dropped. At §2's minimum of 8 modules that is 4 —
 * which is precisely `ZERO_G_AUTHORED_MAX` plus the stage-4 director budget, so
 * the two numbers are pinned to each other and the check below will fail the
 * moment somebody raises one without the other.
 */
export const ZERO_G_FRACTION_MAX = 0.5;

// ===========================================================================
// §14 — Alien (§5)
// ===========================================================================

/** m/s — stage 0. Above RAIL_SLIDE by design: you cannot out-slide it on rails. */
export const SPEED_PATROL = 1.5;
export const SPEED_SEARCH = 1.2;
/** m/s — beats every option except a full push-off, and that only briefly. */
export const SPEED_HUNT = 3.0;
/** Arrival level that triggers HUNT within HUNT_TRIGGER_RANGE_M. 35 at stage 4. */
export const HUNT_TRIGGER = 50;
/** Arrival level that triggers HUNT at director stage 4 (§5 table). */
export const HUNT_TRIGGER_STAGE4 = 35;
/** m — HUNT triggers on "an arrival above 50 within 10m" (§5). */
export const HUNT_TRIGGER_RANGE_M = 10;
/** s — SEARCH sweep of the module and its neighbours. 25 at stage 3+. */
export const SEARCH_DURATION = 15;
/** s — SEARCH duration at director stage 3 and above (§5 table). */
export const SEARCH_DURATION_LATE = 25;
/** s — the alien opens a closed hatch in this long, at loudness 45. It cannot
 *  open sealed ones. */
export const HATCH_OPEN_TIME = 3.0;

/** Anti-camping: `ANTICAMP_MS = rand(60_000, 150_000)` (§14). Fuzzed and
 *  undisclosed on purpose — a flat timer is a provable escape valve (§5). */
export const ANTICAMP_MIN_MS = 60_000;
export const ANTICAMP_MAX_MS = 150_000;
/** m — "within 15m of a living player without a kill" (§5). */
export const ANTICAMP_RADIUS_M = 15;

/** Roll a fresh anti-camp timeout. Inject `rng` to make rounds reproducible. */
export function anticampMs(rng: () => number = Math.random): number {
  return ANTICAMP_MIN_MS + rng() * (ANTICAMP_MAX_MS - ANTICAMP_MIN_MS);
}

/** 2:1 target-selection weight toward the module holding the largest cluster of
 *  players, once crowd bias is on (§5, stage 2+). */
export const CROWD_BIAS_WEIGHT = 2;

// ===========================================================================
// §14 — Round
// ===========================================================================

/** Throwable, loudness 70, pulls the alien and triggers RETREAT. No respawn (§5). */
export const DECOYS_PER_ROUND = 2;
/** Power charges for sealing hatches. Scarce so barricading isn't the whole game. */
export const SEAL_CHARGES = 2;
/** ms — one free director stage every 8 minutes so a stalling team escalates. */
export const STAGE_TIMEOUT_MS = 480_000;

// ===========================================================================
// CREW SCALING — the §14 table is balanced for a crew, not for one player
// ===========================================================================
//
// Every number above is calibrated against DESIGN.md's stated target: "up to
// six players" sharing one noise budget. §3's attention thresholds, §5's crowd
// bias and §3's localization-error curve all assume MANY sources competing for
// one pair of ears. Take the crowd away and each of them inverts:
//
//   * Attention. The thresholds are a filter for a stream of six people's
//     noise. Solo the player IS the stream, so every arrival that clears the
//     threshold is unambiguous and points at the only body on the station.
//   * Crowd bias (§5). "Weight target selection 2:1 toward the module holding
//     the largest cluster of players" is a PACING tool — it stops the far side
//     of a ten-module station having a boring round. With one player the
//     largest cluster is that player, and a pacing tool becomes a homing beacon.
//   * Localization error (§3). errorRadius is slop against the WRONG player.
//     Solo there is no wrong player: 12m of slop around the only occupant of a
//     5m-diameter tube still lands in the right room.
//   * Escalation (§5). STAGE_TIMEOUT_MS was sized for "roughly 20–25 minutes"
//     of six people working in parallel. One pair of hands does not bring
//     systems online at six hands' rate, so the free-stage clock — which exists
//     to punish STALLING — punishes being alone instead.
//
// So the values below are not a difficulty slider. They restore, at low player
// counts, the *conditions* the §14 numbers were tuned under. Everything
// converges exactly onto §14 at CREW_FULL, so the six-player game that DESIGN.md
// actually describes is untouched: `crewPressure(6) === crewPressure(5) === 1`
// makes every scaled value identical to its §14 constant.
//
// Counted players are LIVING and un-escaped. That is deliberate: a six-player
// round that attrits to two survivors has lost the same noise budget a solo
// round never had, and §10 plans for exactly that ("at six players someone dies
// early. Every round.").

/**
 * Living-player count at which every crew-scaled value equals its §14 number.
 *
 * Five, not six: §10's win condition is "escaping with three of six is a win",
 * so a round is expected to spend most of its length below six. Converging at
 * five means a full crew that loses one member is still playing the game
 * DESIGN.md describes, rather than being handed a discount for a single death.
 */
export const CREW_FULL = 5;

/**
 * 0 at one living player, 1 at `CREW_FULL` or more. The single dial every
 * crew-scaled value below is interpolated on, so they can never disagree.
 */
export function crewPressure(livingPlayers: number): number {
  return clamp((livingPlayers - 1) / (CREW_FULL - 1), 0, 1);
}

/** Linear interpolation, exported because the sims lerp on `crewPressure`. */
export function lerp(soloValue: number, crewValue: number, pressure01: number): number {
  return soloValue + (crewValue - soloValue) * clamp(pressure01, 0, 1);
}

// -- round-start grace ------------------------------------------------------

/**
 * s — the alien stays DORMANT this long after the round starts, at one living
 * player. It does not move and hears nothing below its HUNT trigger, so §10's
 * reunion phase is survivable for someone who is quiet.
 *
 * WHY 75. §10 claims the fairness floor for the opening is `ALIEN_SPAWN_MIN_HOPS`
 * — the alien spawning three hops away. Measured, that floor is worth about ten
 * seconds: three hops is roughly 15 m of station and `SPEED_PATROL` is 1.5 m/s.
 * It is not a grace period, and treating it as one is what made the opening
 * unsurvivable. 75 s is instead sized off the two things a solo player must
 * actually do before the hunt starts:
 *   - traverse the station once: the shipped level has 84.9 m of handrail, and
 *     84.9 / RAIL_SLIDE = 71 s;
 *   - be holding a decoy: DECOYS_PER_ROUND in nine lockers means a mean of 3.3
 *     lockers opened across 3.3 modules before the first one turns up.
 * Below that the §5 counters do not exist yet and the round is decided by the
 * spawn roll.
 */
export const ROUND_GRACE_SOLO_S = 75;

/**
 * s — the same grace at `CREW_FULL` and above. Short on purpose: §10's reunion
 * is "a quiet, dread-heavy reunion phase", never a safe one, and six players
 * scattered over nine modules already dilute each other. 25 s is one module hop
 * of orientation — enough to find a handrail and work out which way is which.
 */
export const ROUND_GRACE_CREW_S = 25;

/** s — round-start DORMANT grace for this many living players (§10). */
export function roundGraceSeconds(livingPlayers: number): number {
  return lerp(ROUND_GRACE_SOLO_S, ROUND_GRACE_CREW_S, crewPressure(livingPlayers));
}

// -- attention --------------------------------------------------------------

/**
 * Added to the PATROL attention threshold at one living player, fading to 0 at
 * `CREW_FULL`.
 *
 * WHY 8. It has to clear the whole §3 "quiet tier" and stop just short of the
 * loud one, so that careful traversal is free solo and every deliberate,
 * loud-fast action still costs you. `ATTN_PATROL` + 8 = 20 puts the solo stage-0
 * line exactly on the tracker beep:
 *   silent  — rail pull 4, hand pump 6, push-off 8, valve-slow 8, breathing
 *             6–14, knock 15, a catch under 4 m/s
 *   heard   — tracker beep 20, body collision 25, cargo bounce 30, breaker 35,
 *             valve-fast 40, hatch cycle 45, keyswitch 45, breaker reset 50,
 *             pry bar 60, undock 60, extinguisher 65, decoy 70, a shout, any
 *             uncontrolled impact above 0.9 m/s, a catch at 4 m/s or more.
 * Every §11 puzzle's loud-fast path is in the second list, so progress is still
 * bought with attention — which is the point of §5's escalation.
 */
export const ATTN_PATROL_SOLO_BONUS = 8;

/**
 * Added to the INVESTIGATE / SEARCH threshold at one living player, fading to 0
 * at `CREW_FULL`.
 *
 * WHY 4. `ATTN_SEARCH` = 4 is the sharpest number in the document and §3 is
 * proud of it: "a rail pull is completely safe at distance, and *fatal* when the
 * thing is sweeping your module". With a crew that is a moment; solo it is a
 * latch, because the only sound on the station is the person it is sweeping for,
 * so every SEARCH re-fixes on the player and the alien never lets go. `ATTN_SEARCH`
 * + 4 = 8 keeps the mechanic and removes the latch: shifting your grip (4) is
 * survivable, but a push-off (8), any rail catch at all (`catchNoise(0)` = 8),
 * a knock (15) or panicked breathing at a high heart rate (up to 14) still give
 * you away inside the sweep.
 */
export const ATTN_SEARCH_SOLO_BONUS = 4;

/** Arrival level PATROL reacts to at this stage and living-player count (§3). */
export function patrolThreshold(stage: number, livingPlayers: number): number {
  const base = directorConfig(stage).patrolThreshold;
  return Math.round(base + ATTN_PATROL_SOLO_BONUS * (1 - crewPressure(livingPlayers)));
}

/** Arrival level INVESTIGATE / SEARCH react to at this living-player count (§3). */
export function searchThreshold(livingPlayers: number): number {
  return Math.round(ATTN_SEARCH + ATTN_SEARCH_SOLO_BONUS * (1 - crewPressure(livingPlayers)));
}

// -- escalation -------------------------------------------------------------

/**
 * The §5 stage table is a *crowd* escalation: rising patrol speed, a longer
 * SEARCH sweep and the stage-4 HUNT discount all exist to keep six people from
 * settling into silent-slow play. Solo none of them have that job, and all three
 * compound with "you are the only thing it can hear". At one living player the
 * stage row therefore collapses onto its stage-0 values —
 * `SPEED_PATROL` (still above `RAIL_SLIDE`, so §14 check 5 holds and you still
 * cannot out-slide it), `SEARCH_DURATION`, and `HUNT_TRIGGER` with no discount —
 * and lerps back to the full §5 row at `CREW_FULL`.
 *
 * The PATROL threshold still sharpens with the stage even solo (20 → 12), so
 * progress still buys pressure. That is the half of §5's escalation that works
 * with one player.
 */
export function crewScaledStage(stage: number, livingPlayers: number): DirectorStageConfig {
  const base = directorConfig(stage);
  const p = crewPressure(livingPlayers);
  return {
    stage: base.stage,
    systemsRequired: base.systemsRequired,
    patrolSpeed: lerp(SPEED_PATROL, base.patrolSpeed, p),
    patrolThreshold: patrolThreshold(stage, livingPlayers),
    crowdBias: base.crowdBias && livingPlayers >= CROWD_BIAS_MIN_PLAYERS,
    searchDuration: lerp(SEARCH_DURATION, base.searchDuration, p),
    huntTrigger: Math.round(lerp(HUNT_TRIGGER, base.huntTrigger, p)),
    // Gravity failures do NOT collapse to zero solo — losing the floor is the
    // pivot's headline tension and a lone player should still meet it. What
    // they do not get is COMPOUNDING: one dropped module at a time, never the
    // stage-4 pair, because a solo player has nobody to cycle a hatch for them
    // and two simultaneous failures is how a round ends to geometry rather than
    // to the alien. Never above the §5 row, so more players is never safer.
    gravityFailures: Math.min(
      base.gravityFailures,
      Math.round(lerp(Math.min(1, base.gravityFailures), base.gravityFailures, p)),
    ),
  };
}

/**
 * Living players below which §5's crowd bias is switched off entirely.
 *
 * Three, because a "largest cluster" needs at least two candidate clusters to be
 * the larger of. At one or two players the bias has nothing to weigh and
 * degenerates into pointing the alien at the only occupied module.
 */
export const CROWD_BIAS_MIN_PLAYERS = 3;

/**
 * m — while PATROLLING with a small crew, and only while it has heard nothing,
 * the alien drifts away rather than walking into the sole occupant of the
 * station. 0 at `CREW_FULL`.
 *
 * This is the pacing half of crowd bias, run in reverse, and it is the single
 * biggest solo fix: measured on the shipped nine-module level (mean hop distance
 * 2.07), a purely random patrol walks into a solo player's handrail within about
 * 30 seconds, and contact is an instant kill. Six players make that a shared
 * risk with a revive (§10); one player makes it the whole round.
 *
 * WHY 6. It is a personal-space bubble, not an exclusion zone: one §2 module is
 * 5 m long, so at 6 m the alien still comes into the room with you and gets a
 * handrail's length away before it turns — about four seconds of warning at
 * `SPEED_PATROL` — rather than orbiting two modules out. Measured over 10-minute
 * solo rounds on the shipped level, a careful player spends 21% of the round
 * with it inside 8 m and survives; at 10 m the alien becomes a rumour (5% inside
 * 8 m) and at 4 m it is back to killing 93% of solo players who touch a puzzle.
 * It also sits inside both of §5's own radii — `ANTICAMP_RADIUS_M` (15), so the
 * standoff and the anti-camp valve never disagree about how close it may loiter,
 * and `HUNT_TRIGGER_RANGE_M` (10), so standing off never takes it out of range
 * of the reflex that grabs a player who makes a racket.
 *
 * It applies ONLY in PATROL with no fix and no retained secondary: the moment
 * the alien has actually heard something, it comes for you at any range.
 */
export const PATROL_STANDOFF_SOLO_M = 6;

/** m — PATROL standoff at this living-player count. 0 once there is a crowd. */
export function patrolStandoffM(livingPlayers: number): number {
  return lerp(PATROL_STANDOFF_SOLO_M, 0, crewPressure(livingPlayers));
}

/**
 * ms — the free-escalation timer at one living player.
 *
 * WHY 720_000 (12 min). §5 gives a free stage every 8 minutes "so a stalling
 * team escalates anyway", sized against "roughly 20–25 minutes" of six people
 * working in parallel. A solo player is not stalling; they are doing six
 * people's work in series, so the same clock reads their pace as a stall and
 * hands them stage 3 before their second system. 1.5x is the smallest multiple
 * that keeps four free stages outside a plausible solo round while preserving
 * the arc: a solo run still escalates, just on the schedule of one pair of hands.
 */
export const STAGE_TIMEOUT_SOLO_MS = 720_000;

/** ms between free director stages at this living-player count (§5). */
export function stageTimeoutMs(livingPlayers: number): number {
  return lerp(STAGE_TIMEOUT_SOLO_MS, STAGE_TIMEOUT_MS, crewPressure(livingPlayers));
}

// ===========================================================================
// §3 — Loudness table (cross-referenced against §14; tune these first)
// ===========================================================================

/** Fixed-loudness sounds. Speed-scaled ones use `catchNoise` / `impactNoise`. */
export const LOUDNESS = Object.freeze({
  /** Rail pull — carries ~2 m. Safe at distance, fatal in a SEARCH sweep. */
  RAIL_PULL: 4,
  /** Spectator headset speaker — carries ~3 m (§10). */
  HEADSET: 5,
  /** Hand pump / manual override — carries ~4 m. */
  HAND_PUMP: 6,
  /** Gentle push-off — carries ~6 m. */
  PUSH_OFF: 8,
  /** Handrail knock — ~2 modules. The knock-code primitive (§10). */
  KNOCK: 15,
  /** Tracker beep, unmuted — ~1 module (§6). Muting is a genuine trade. */
  TRACKER_BEEP: 20,
  /** Body collision while carrying — ~1 module. */
  BODY_COLLISION: 25,
  /** Cargo bag bounce — ~1 module (§11 puzzle 3). */
  CARGO_BOUNCE: 30,
  /** Breaker toggle / CLACK — ~2 modules (§11 puzzle 1). */
  BREAKER: 35,
  /** Wrong breaker order resets the panel with a buzz (§11 puzzle 1). */
  BREAKER_RESET: 50,
  /** Coolant valve turned slowly (§11 puzzle 2). */
  VALVE_SLOW: 8,
  /** Coolant valve spun fast (§11 puzzle 2). */
  VALVE_FAST: 40,
  /** Hatch cycle, either party — ~3 modules. The alien pays this too (§5). */
  HATCH_CYCLE: 45,
  /** Airlock keyswitch activation, unavoidable (§11 puzzle 5). */
  KEYSWITCH: 45,
  /** Pry bar / power tool — ~4 modules. */
  PRY_BAR: 60,
  /** Undock release levers — the finale, at loudness 60 (§11 puzzle 6). */
  UNDOCK_LEVER: 60,
  /** Fire extinguisher thrust — ~4 modules. A panic button with a price (§4). */
  EXTINGUISHER: 65,
  /** Decoy impact — ~5 modules. Two per round. */
  DECOY: 70,
  /** The alien while HUNTING. A silent charge is unfair and reads as a bug (§5). */
  ALIEN_HUNT: 55,
  /**
   * A gravity plant winding down or up — ~2 modules. Emitted at the MODULE
   * CENTRE, not at any player.
   *
   * 35 is deliberately the breaker-toggle rung. It is loud enough that the
   * alien reacts to it at every stage and every crew size, which is the point:
   * the §5 director dropping a module is a real event that moves the thing on
   * the map, not a set-dressing rumble. Nobody is punished for it — no player
   * caused it, and the origin is the plant rather than the person standing next
   * to it.
   */
  GRAVITY_SHIFT: 35,
  /**
   * The alien working a hide spot open — ~4 modules. As loud as `ALIEN_HUNT`
   * because it is the same non-negotiable rule (§5): it must never do anything
   * decisive in silence. Everyone else on the station hears where it is and
   * that it has found somebody.
   */
  HIDE_BREACH: 55,
} as const);

/** Panicked breathing scales with heart rate (§6). */
export const BREATHING_MIN = 6;
export const BREATHING_MAX = 14;
/** Proximity voice — up to ~5 modules at a shout (§7). */
export const VOICE_MIN = 10;
export const VOICE_MAX = 55;

/** Map a normalised 0–1 intensity onto the breathing loudness range (§6). */
export function breathingNoise(intensity01: number): number {
  return BREATHING_MIN + clamp(intensity01, 0, 1) * (BREATHING_MAX - BREATHING_MIN);
}

/** Map a calibrated 0–1 mic level onto the proximity-voice range (§7). */
export function voiceNoise(level01: number): number {
  return VOICE_MIN + clamp(level01, 0, 1) * (VOICE_MAX - VOICE_MIN);
}

/**
 * Authoritative loudness for a NoiseKind. The server re-derives loudness from
 * this rather than trusting the client's number (§7 client authority is for
 * movement, not for how loud you were).
 *
 * `speed` is required for 'catch', 'impact' and 'landing'; `intensity` (0–1) for
 * 'breathing', 'voice', 'hide-enter' and 'hide-exit'; `gait` for 'footstep' and
 * 'landing'.
 *
 * `hidden` applies the hide spot's shell (`HIDE_MUFFLE_DB`, or the spot's own
 * `muffleDb` passed as `muffleDb`). The client reports the FACT of being hidden
 * and the server does the subtraction — same division of trust as the loudness
 * itself.
 */
export function noiseLoudness(
  kind: NoiseKind,
  opts: {
    speed?: number;
    intensity?: number;
    gait?: Gait;
    hidden?: boolean;
    muffleDb?: number;
  } = {},
): number {
  const raw = rawNoiseLoudness(kind, opts);
  return opts.hidden ? muffledLoudness(raw, opts.muffleDb ?? HIDE_MUFFLE_DB) : raw;
}

function rawNoiseLoudness(
  kind: NoiseKind,
  opts: { speed?: number; intensity?: number; gait?: Gait },
): number {
  const speed = clamp(opts.speed ?? 0, 0, PUSH_MAX);
  const intensity = clamp(opts.intensity ?? 0, 0, 1);
  const gait: Gait = opts.gait ?? 'walk';
  switch (kind) {
    case 'rail-pull':
      return LOUDNESS.RAIL_PULL;
    case 'headset':
      return LOUDNESS.HEADSET;
    case 'hand-pump':
      return LOUDNESS.HAND_PUMP;
    case 'push-off':
      return LOUDNESS.PUSH_OFF;
    case 'breathing':
      return breathingNoise(intensity);
    case 'voice':
      return voiceNoise(intensity);
    case 'catch':
      return catchNoise(speed);
    case 'impact':
      return impactNoise(speed);
    case 'footstep':
      return footstepLoudness(gait);
    case 'landing':
      return landingNoise(speed, gait);
    case 'hide-enter':
    case 'hide-exit':
      return hideNoise(intensity);
    case 'hide-breach':
      return LOUDNESS.HIDE_BREACH;
    case 'gravity-shift':
      return LOUDNESS.GRAVITY_SHIFT;
    case 'knock':
      return LOUDNESS.KNOCK;
    case 'tracker-beep':
      return LOUDNESS.TRACKER_BEEP;
    case 'body-collision':
      return LOUDNESS.BODY_COLLISION;
    case 'cargo-bounce':
      return LOUDNESS.CARGO_BOUNCE;
    case 'breaker':
      return LOUDNESS.BREAKER;
    case 'breaker-reset':
      return LOUDNESS.BREAKER_RESET;
    case 'valve-slow':
      return LOUDNESS.VALVE_SLOW;
    case 'valve-fast':
      return LOUDNESS.VALVE_FAST;
    case 'hatch-cycle':
      return LOUDNESS.HATCH_CYCLE;
    case 'keyswitch':
      return LOUDNESS.KEYSWITCH;
    case 'pry-bar':
      return LOUDNESS.PRY_BAR;
    case 'undock-lever':
      return LOUDNESS.UNDOCK_LEVER;
    case 'extinguisher':
      return LOUDNESS.EXTINGUISHER;
    case 'decoy':
      return LOUDNESS.DECOY;
    case 'alien':
      return LOUDNESS.ALIEN_HUNT;
    default: {
      // Exhaustiveness guard: adding a NoiseKind without a loudness fails here.
      const never: never = kind;
      throw new Error(`noiseLoudness: unhandled NoiseKind ${String(never)}`);
    }
  }
}

// ===========================================================================
// §5 — Escalation director table
// ===========================================================================

/** The §5 escalation table, indexed by stage. Stage advances per system brought
 *  online, plus one free stage every STAGE_TIMEOUT_MS. */
export const DIRECTOR_STAGES: readonly DirectorStageConfig[] = Object.freeze([
  {
    stage: 0,
    systemsRequired: 0,
    patrolSpeed: SPEED_PATROL,
    patrolThreshold: ATTN_PATROL,
    crowdBias: false,
    searchDuration: SEARCH_DURATION,
    huntTrigger: HUNT_TRIGGER,
    // The round starts exactly as the level was authored. Whatever zero-G the
    // player meets in the first minutes, a designer put there.
    gravityFailures: 0,
  },
  {
    stage: 1,
    systemsRequired: 1,
    patrolSpeed: 1.6,
    patrolThreshold: 10,
    crowdBias: false,
    searchDuration: SEARCH_DURATION,
    huntTrigger: HUNT_TRIGGER,
    gravityFailures: 0,
  },
  {
    stage: 2,
    systemsRequired: 2,
    patrolSpeed: 1.8,
    patrolThreshold: 8,
    crowdBias: true,
    searchDuration: SEARCH_DURATION,
    huntTrigger: HUNT_TRIGGER,
    // First failure arrives with crowd bias, at the point §11 has the team
    // split across parallel puzzles — so it lands on somebody working alone.
    gravityFailures: 1,
  },
  {
    stage: 3,
    systemsRequired: 3,
    patrolSpeed: 2.0,
    patrolThreshold: 6,
    crowdBias: true,
    searchDuration: SEARCH_DURATION_LATE,
    huntTrigger: HUNT_TRIGGER,
    gravityFailures: 1,
  },
  {
    stage: 4,
    systemsRequired: 4,
    patrolSpeed: 2.2,
    patrolThreshold: ATTN_SEARCH,
    crowdBias: true,
    searchDuration: SEARCH_DURATION_LATE,
    huntTrigger: HUNT_TRIGGER_STAGE4,
    // Undock live. The station is coming apart and the crew is split across
    // three modules counting down over voice — this is the moment for it.
    gravityFailures: 2,
  },
] as const);

export const MAX_DIRECTOR_STAGE: DirectorStage = 4;

/** Config row for a stage, clamped into range. */
export function directorConfig(stage: number): DirectorStageConfig {
  const i = Math.round(clamp(stage, 0, MAX_DIRECTOR_STAGE));
  // Index is clamped above, so this is always defined.
  return DIRECTOR_STAGES[i] as DirectorStageConfig;
}

/**
 * Arrival level the alien bothers to react to, given its state, the stage and
 * how many players are still alive. "It hears better when it's already looking
 * for you" (§3), and it hears better still when there are six of you to hear.
 *
 * `livingPlayers` defaults to `CREW_FULL`, so an unaware caller gets the §14
 * table exactly as written.
 */
export function attentionThreshold(
  state: 'DORMANT' | 'PATROL' | 'INVESTIGATE' | 'SEARCH' | 'HUNT' | 'ATTACK' | 'RETREAT',
  stage: number = 0,
  livingPlayers: number = CREW_FULL,
): number {
  switch (state) {
    case 'PATROL':
      return patrolThreshold(stage, livingPlayers);
    case 'INVESTIGATE':
    case 'SEARCH':
      return searchThreshold(livingPlayers);
    case 'HUNT':
    case 'ATTACK':
      return ATTN_HUNT;
    case 'DORMANT':
    case 'RETREAT':
    default:
      return patrolThreshold(stage, livingPlayers);
  }
}

// ===========================================================================
// §2 / §7 / §8 / §9 / §10 — supporting constants stated elsewhere in the doc
// ===========================================================================

/** Render the player's module plus everything two hops away through open hatches
 *  (§2). One hop pops the second module into view down a straight run. */
export const CULL_HOPS = 2;

/** Target scope: 8–10 modules at six players (§2). */
export const STATION_MODULES_MIN = 8;
export const STATION_MODULES_MAX = 10;

/** Server tick rate (§7). Clients render interpolated at display rate. */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
/** Clients sample their own mic RMS and send `voiceLevel` at 10 Hz (§7). */
export const VOICE_LEVEL_HZ = 10;
/** In-world CanvasTexture puzzle panels update at 10 Hz, only while a player is
 *  in the module (§6). */
export const PANEL_UPDATE_HZ = 10;

export const MAX_PLAYERS = 6;
/** Escaping with three of six is a win (§10). */
export const WIN_MIN_SURVIVORS = 3;
/** Escape condition: four systems online, then the undock sequence (§11). */
export const SYSTEMS_TO_ESCAPE = 4;

/** Spawn constraints (§10). No two players in the same module; minimum one hop
 *  apart; never in the escape or finale module; alien at least three hops from
 *  the majority of players. */
export const SPAWN_MIN_HOPS_BETWEEN_PLAYERS = 1;
export const ALIEN_SPAWN_MIN_HOPS = 3;

/** Audio (§8): a closed hatch is a lowpass at 400 Hz on top of its dB offset. */
export const OCCLUSION_LOWPASS_HZ = 400;
/** Audio (§8): the open-hatch cutoff — effectively unfiltered. */
export const OPEN_LOWPASS_HZ = 20_000;
/** Audio (§8): ramp filter and gain changes with `setTargetAtTime` over ~100ms.
 *  Never step them, or every hatch cycle clicks audibly. Seconds. */
export const FILTER_RAMP_S = 0.1;

/** Tracker (§6): a beep every 3s when far, accelerating as the alien closes,
 *  solid tone when adjacent. Seconds. */
export const TRACKER_BEEP_INTERVAL_FAR_S = 3.0;
export const TRACKER_BEEP_INTERVAL_NEAR_S = 0.15;
/** m — beyond this the tracker is at its slowest pulse. */
export const TRACKER_FAR_RANGE_M = 40;
/** m — inside this the tracker is a solid tone. */
export const TRACKER_SOLID_RANGE_M = 4;

/**
 * Tracker cadence shape (§6) — playtest 2 legibility fix.
 *
 * The interval endpoints above are §6's, and they stay. What changed is how the
 * curve gets from one to the other. Interpolating the INTERVAL linearly (the r1
 * behaviour) spends almost all of the acceleration in the last few metres: from
 * TRACKER_FAR_RANGE_M to half of it the pulse only went 0.33 → 0.63 Hz, which a
 * player hears as "a beep" and not as "it is closing". Interpolating the
 * LOGARITHM of the interval instead — a geometric curve — makes every equal step
 * of distance multiply the rate by the same factor (2.11x per quarter of the
 * range), so the acceleration is uniform, monotonic and decodable anywhere in
 * the range. 0 = linear in interval, 1 = fully geometric.
 *
 * This shapes only what the player HEARS AND SEES. The emitted loudness-20
 * NoiseEvent (§3) still runs off the linear curve floored at the coalescing
 * window, so the tracker's in-world cost is exactly what it was.
 */
export const TRACKER_CADENCE_LOG_BLEND = 1;

/**
 * Tracker voice (§6, §8) — audition-deck v3: the sonar pebble.
 *
 * The r1 chirp was a 2100–2600 Hz square wave — a smoke alarm parked in the
 * 2–4 kHz band the ear is most sensitive to. v2 rebuilt it as an A4→A5
 * instrument, which fixed "piercing" but still read as an electronic chirp at
 * the near end across a 20-minute round. v3 drops the register a further
 * fourth and reshapes the transient as a water-drop pitch-fall (see
 * `trackerBeep` in synth.ts): sonar, not alarm. The travel FAR→NEAR is still
 * more than an octave, so far and near remain two different NOTES, and the
 * roots sit above the §8 station hum's energy so the tick still cuts through.
 */
export const TRACKER_TONE_FAR_HZ = 290;
export const TRACKER_TONE_NEAR_HZ = 640;
/** Lowpass over the whole chirp, geometric with urgency, closing further as the
 *  chirp decays. Far is dull and woody, near opens up: the timbre half of the
 *  second cue. Hz. */
export const TRACKER_TONE_LOWPASS_FAR_HZ = 620;
export const TRACKER_TONE_LOWPASS_NEAR_HZ = 2100;
/**
 * Chirp envelope, far → near, in seconds. r1's 2 ms attack on a square wave was
 * the click the playtester heard as "piercing"; ~20 ms is still percussive with
 * no edge on it. The decay shortens as the cadence speeds up so chirps never
 * smear into a buzz — see the §14 sanity check, which asserts the whole near-end
 * envelope fits inside TRACKER_BEEP_INTERVAL_NEAR_S.
 */
export const TRACKER_BEEP_ATTACK_FAR_S = 0.022;
export const TRACKER_BEEP_ATTACK_NEAR_S = 0.005;
export const TRACKER_BEEP_DECAY_FAR_S = 0.13;
export const TRACKER_BEEP_DECAY_NEAR_S = 0.06;
/** Chirp peak amplitude, far → near. §6's idle state has to be ignorable: far is
 *  a quiet low tick, contact is not. Ratio is deliberately large (~3x). */
export const TRACKER_BEEP_PEAK_FAR = 0.06;
export const TRACKER_BEEP_PEAK_NEAR = 0.19;
/** The solid tone's held level. Lower than the near chirp's transient peak
 *  because a continuous tone is perceived much louder than a 65 ms one. */
export const TRACKER_SOLID_PEAK = 0.115;
/**
 * Contact state (audition-deck v2): a dark 220 Hz throb — a racing heartbeat,
 * not a held siren note. The root sits BELOW the beep range on purpose: the
 * state change is a register drop, and the whole upper spectrum stays free for
 * the alien itself, which at contact range is the thing that matters.
 */
export const TRACKER_SOLID_ROOT_HZ = 220;
/** Solid-tone tremolo — amplitude, not pitch. Fast and deep: a flutter well
 *  above the beep cadence, so it reads as a distinct state. Hz, and 0–1. */
export const TRACKER_SOLID_TREMOLO_HZ = 6.8;
export const TRACKER_SOLID_TREMOLO_DEPTH = 0.8;
/**
 * Tracker urgency bands (§6). The device never shows a distance, but it does
 * have to show WHICH of its three states it is in, so the eye and the ear teach
 * each other the mapping inside one round. Urgency: 0 at TRACKER_FAR_RANGE_M,
 * 1 at TRACKER_SOLID_RANGE_M.
 */
export const TRACKER_URGENCY_CLOSING = 0.4;
export const TRACKER_URGENCY_NEAR = 0.75;

/** Rendering budget (§9). */
export const MAX_REALTIME_LIGHTS = 4;
export const SHADOW_MAP_SIZE = 1024;

// ---------------------------------------------------------------------------
// Flashlight (§9) — the one shadow-casting light, and §9's "only thing keeping
// the dark out". These are TORCH numbers, not floodlight numbers.
//
// The first tuning pass ran at intensity 26 / decay 2 / range 24 m, which is a
// physically honest lamp and completely unplayable: inverse-square over the
// 0.5–5 m range a 1 m-radius tube actually offers is a 100× swing, so anything
// nearer than ~1.2 m clipped to white. Measured nose-to-wall (0.55 m off a tube
// wall, 1920×1200): 31.6% of the frame above 0.85 luma and 17.1% at pure white.
// Dropping the decay exponent compresses that swing — it is the one control
// that makes a near wall and a far bulkhead legible in the same frame — and the
// intensity then only has to satisfy the mid range.
// ---------------------------------------------------------------------------

/**
 * Candela at `FLASHLIGHT_DECAY`. Chosen so a surface 2 m down the beam lands
 * around 0.35 sRGB after ACES and the §9 exposure — bright enough to read a
 * handrail, dark enough that the fog still owns the far end.
 */
export const FLASHLIGHT_INTENSITY = 5.0;

/**
 * Distance falloff exponent. 2 is physically correct and reads as a flash gun;
 * 1.25 keeps a near-field-to-mid-field ratio of ~2.4× instead of ~16×, so
 * floating up to a bulkhead no longer blows the frame out. Same measurement as
 * above at these numbers: 0.43% hot, 0.10% blown.
 */
export const FLASHLIGHT_DECAY = 1.25;

/**
 * Cutoff range in metres. Past this three's spot attenuation is zero, and the
 * shadow camera's far plane follows `light.distance` whether you set it or not
 * (`SpotLightShadow.updateMatrices`), so this is also the shadow throw. 13 m
 * sits just inside `DEFAULT_FOG_VISIBILITY_M` (15 m) — the beam dies in the fog
 * rather than at a visible edge, and §2's third hop stays invisible.
 */
export const FLASHLIGHT_RANGE_M = 13;

/** Cone half-angle in degrees. A hand torch, not a work lamp. */
export const FLASHLIGHT_ANGLE_DEG = 23;

/**
 * 0–1 soft cone edge. High: a hard-edged disc of light reads as a screen
 * effect, a soft one reads as a torch in a glove (which is what §9 wants).
 */
export const FLASHLIGHT_PENUMBRA = 0.85;

/** Slightly warm incandescent white — cool white reads as clinical, not scared. */
export const FLASHLIGHT_COLOR = 0xffe3bd;

/** Player-facing brightness trim, as a multiplier on `FLASHLIGHT_INTENSITY`. */
export const FLASHLIGHT_SCALE_MIN = 0.4;
export const FLASHLIGHT_SCALE_MAX = 1.8;

/**
 * Where that trim starts: 1 = the authored torch above, which is the number the
 * whole §9 exposure/bloom chain was measured at. The slider exists so a player
 * on a dim laptop panel can read the room at all (§13), not so the default has
 * to be argued about — anyone who moves it is correcting their display, and
 * `ComfortOptions.flashlightIntensity` persists that correction.
 */
export const FLASHLIGHT_SCALE_DEFAULT = 1;

/**
 * The ONE ambient fill (§9 "everything else is emissive strips and cheap
 * ambient"), owned by `LightingRig` and by nothing else.
 *
 * There used to be two AmbientLights: the rig's and a second one the Station
 * added to its own group (0x2a3238 @ 0.35). The rig's is the only one §5's HUNT
 * dim (`ambient × (1 − 0.35 × hunt)`) and the red-alert tint can reach, so 46%
 * of the actual fill never darkened when the alien came and never turned red on
 * alert. `Station` is now built with `ambient: false` and this is the knob.
 *
 * 0.30 — the rig's own authored value, deliberately NOT raised to compensate
 * for the light that went away. Measured (1280×720, emergency lighting, torch
 * on, 30 frames after the rig's damping settled, paired A/B): whole-frame mean
 * luminance 0.1142 with both lights vs 0.1135 with the rig's alone, and 0.0077
 * vs 0.0075 in a blacked-out module with the torch off. That is under 2%, below
 * the ±0.002 the emergency lights' own flicker moves the same frame — the
 * second light was buying almost no light and costing §5 its dimmer.
 */
export const AMBIENT_INTENSITY = 0.3;

/**
 * Bloom render-target scale at the `high` quality profile (§9 "keep it cheap").
 * Bloom is a blur: running its mip chain at half the composer resolution costs
 * a quarter of the fill and is not distinguishable from full resolution.
 */
export const BLOOM_SCALE_HIGH = 0.5;
/** …and a third again at `medium`, where the pixel-ratio ceiling is lower too. */
export const BLOOM_SCALE_MEDIUM = 0.35;

/** §11 puzzle timings — the loud-fast / quiet-slow rule, in seconds. */
export const PRY_TIME_S = 3;
export const HAND_PUMP_TIME_S = 25;
export const BREAKER_OVERRIDE_TIME_S = 20;
export const BREAKER_COUNT = 6;
/** Airlock keyswitches must be turned within one second of each other (§11). */
export const KEYSWITCH_WINDOW_S = 1.0;
/** Three release levers held for five seconds simultaneously (§11). */
export const UNDOCK_HOLD_S = 5;
export const UNDOCK_LEVER_COUNT = 3;
export const FUSE_COUNT = 3;
export const CARGO_BAG_COUNT = 5;

// ===========================================================================
// §14 — Sanity checks
// ===========================================================================

export class ConstantsCoherenceError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(
      `DESIGN.md §14 sanity checks failed (${failures.length}):\n  - ${failures.join('\n  - ')}`,
    );
    this.name = 'ConstantsCoherenceError';
    this.failures = failures;
  }
}

/**
 * Re-run these whenever you touch the tables above. Each one caught a real bug
 * in r1. Throws `ConstantsCoherenceError` listing every failure.
 */
export function assertConstantsCoherent(): void {
  const fail: string[] = [];
  const check = (ok: boolean, msg: string): void => {
    if (!ok) fail.push(msg);
  };

  // 1 — Every entry in the §3 loudness table exceeds FLOOR at zero distance.
  const tableMinima: Array<[string, number]> = [
    ...Object.entries(LOUDNESS),
    ['BREATHING (min)', BREATHING_MIN],
    ['VOICE (min)', VOICE_MIN],
    ['CATCH at 0 m/s', catchNoise(0)],
    ['IMPACT at 0 m/s', impactNoise(0)],
  ];
  for (const [label, value] of tableMinima) {
    check(
      value > FLOOR,
      `check 1: loudness table entry ${label} = ${value} is not above FLOOR (${FLOOR}) at zero distance`,
    );
  }

  // 2 — Knock (15) reaches two modules: 15 − 1.0×10 − 3 = 2 ≥ FLOOR.
  const knockAtTwoModules =
    LOUDNESS.KNOCK - ATTENUATION_PER_M * (2 * MODULE_LENGTH_M) + HATCH_OPEN; // HATCH_OPEN is -3
  check(
    knockAtTwoModules >= FLOOR,
    `check 2: knock two modules out arrives at ${knockAtTwoModules}, below FLOOR (${FLOOR})`,
  );

  // 3 — errorRadius returns its maximum for some *reachable* arrival level,
  //     i.e. for a level at or above FLOOR.
  check(
    errorRadius(FLOOR) === ERROR_RADIUS_MAX_M,
    `check 3: errorRadius(FLOOR=${FLOOR}) = ${errorRadius(FLOOR)}, never reaches its maximum of ${ERROR_RADIUS_MAX_M}`,
  );
  check(
    errorRadius(LOUDNESS.DECOY) === ERROR_RADIUS_MIN_M,
    `check 3b: errorRadius at the loudest event (${LOUDNESS.DECOY}) = ${errorRadius(LOUDNESS.DECOY)}, expected the ${ERROR_RADIUS_MIN_M}m fairness floor`,
  );

  // 4 — A full-speed clean catch is quieter than a pry bar: 8 + 3×6 = 26 < 60.
  check(
    catchNoise(PUSH_MAX) < LOUDNESS.PRY_BAR,
    `check 4: full-speed catch (${catchNoise(PUSH_MAX)}) is not quieter than a pry bar (${LOUDNESS.PRY_BAR})`,
  );
  check(
    catchNoise(PUSH_MAX) < impactNoise(PUSH_MAX),
    `check 4b: a clean catch (${catchNoise(PUSH_MAX)}) must be quieter than a crash (${impactNoise(PUSH_MAX)}) — skill has to buy silence`,
  );

  // 5 — SPEED_PATROL > RAIL_SLIDE, and SPEED_HUNT > PUSH_MAX is false by design.
  check(
    SPEED_PATROL > RAIL_SLIDE,
    `check 5: SPEED_PATROL (${SPEED_PATROL}) must exceed RAIL_SLIDE (${RAIL_SLIDE}) — you cannot out-slide it on rails`,
  );
  check(
    !(SPEED_HUNT > PUSH_MAX),
    `check 5b: SPEED_HUNT (${SPEED_HUNT}) must NOT exceed PUSH_MAX (${PUSH_MAX}) — a push-off is the only thing that outruns a hunt`,
  );

  // 6 — Grab window at max speed exceeds human reaction: 0.8 / 6 = 133ms.
  const grabWindowMs = (GRAB_RANGE / PUSH_MAX) * 1000;
  check(
    grabWindowMs >= 130,
    `check 6: grab window is ${grabWindowMs.toFixed(0)}ms (GRAB_RANGE ${GRAB_RANGE} / PUSH_MAX ${PUSH_MAX}), beneath human reaction time`,
  );

  // Coherence of the director table against the base constants it derives from.
  check(
    DIRECTOR_STAGES.length === MAX_DIRECTOR_STAGE + 1,
    `director: expected ${MAX_DIRECTOR_STAGE + 1} stages, found ${DIRECTOR_STAGES.length}`,
  );
  for (let i = 0; i < DIRECTOR_STAGES.length; i++) {
    const s = DIRECTOR_STAGES[i] as DirectorStageConfig;
    check(s.stage === i, `director: stage ${i} row is labelled ${s.stage}`);
    check(
      s.patrolThreshold >= FLOOR,
      `director: stage ${i} PATROL threshold ${s.patrolThreshold} is below FLOOR (${FLOOR}) — unreachable`,
    );
    if (i > 0) {
      const prev = DIRECTOR_STAGES[i - 1] as DirectorStageConfig;
      check(
        s.patrolSpeed > prev.patrolSpeed,
        `director: stage ${i} patrol speed ${s.patrolSpeed} does not escalate past stage ${i - 1} (${prev.patrolSpeed})`,
      );
      check(
        s.patrolThreshold < prev.patrolThreshold,
        `director: stage ${i} PATROL threshold ${s.patrolThreshold} does not sharpen past stage ${i - 1} (${prev.patrolThreshold})`,
      );
    }
  }
  check(
    DIRECTOR_STAGES[0]!.patrolSpeed === SPEED_PATROL,
    'director: stage 0 patrol speed must equal SPEED_PATROL',
  );
  check(
    DIRECTOR_STAGES[0]!.patrolThreshold === ATTN_PATROL,
    'director: stage 0 PATROL threshold must equal ATTN_PATROL',
  );

  // Hatch dB offsets are stored negative and strictly ordered.
  check(
    HATCH_OPEN > HATCH_CLOSED && HATCH_CLOSED > HATCH_SEALED,
    `hatches: expected HATCH_OPEN (${HATCH_OPEN}) > HATCH_CLOSED (${HATCH_CLOSED}) > HATCH_SEALED (${HATCH_SEALED})`,
  );
  check(
    HATCH_OPEN <= 0,
    `hatches: dB offsets must be negative or zero, HATCH_OPEN is ${HATCH_OPEN}`,
  );

  // A closed hatch at −25 already makes anything under 45 near-inaudible next
  // door — the reason sealing is scarce (§5). Guard the relationship.
  check(
    LOUDNESS.HATCH_CYCLE + HATCH_CLOSED - ATTENUATION_PER_M * MODULE_LENGTH_M >= FLOOR,
    'hatches: a hatch cycle must still be audible through a closed hatch one module away — it is how you hear the alien coming (§5)',
  );

  // Coalescing. NOTE: §3's "a hatch cycle under a decoy is still remembered"
  // is a claim about ARRIVAL levels at the alien, not source loudness — a decoy
  // is thrown far away, which is the whole point of throwing it. At source, a
  // decoy (70) does out-shout a hatch cycle (45) by more than DISCARD_MARGIN,
  // and that is correct: standing next to your own decoy masks nothing.
  check(
    REPEAT_PENALTY_MAX_M % REPEAT_PENALTY_M === 0,
    `coalescing: REPEAT_PENALTY_MAX_M (${REPEAT_PENALTY_MAX_M}) should be a whole number of ${REPEAT_PENALTY_M}m steps`,
  );

  // Tracker (§6). The chirp envelope has to fit inside the gap between chirps at
  // the fastest audible cadence, or contact range degrades into one continuous
  // buzz and the pulse rate — the only information the device carries — is gone.
  const nearEnvelope = TRACKER_BEEP_ATTACK_NEAR_S + TRACKER_BEEP_DECAY_NEAR_S;
  check(
    nearEnvelope < TRACKER_BEEP_INTERVAL_NEAR_S,
    `tracker: the near-range chirp envelope (${nearEnvelope.toFixed(3)}s) does not fit inside TRACKER_BEEP_INTERVAL_NEAR_S (${TRACKER_BEEP_INTERVAL_NEAR_S}s) — chirps would smear into a tone`,
  );
  // The far state must be the quiet one and the near state the loud one, or the
  // §6 trade ("unobtrusive when safe, unmissable when not") is inverted.
  check(
    TRACKER_BEEP_PEAK_FAR < TRACKER_BEEP_PEAK_NEAR &&
      TRACKER_TONE_FAR_HZ < TRACKER_TONE_NEAR_HZ &&
      TRACKER_URGENCY_CLOSING < TRACKER_URGENCY_NEAR,
    'tracker: far→near must rise in level, in pitch and through its urgency bands',
  );

  // -- crew scaling ---------------------------------------------------------
  // The §14 checks above, re-run on the scaled table, plus the one guarantee
  // that makes crew scaling safe to ship: it must be a no-op for the six-player
  // game DESIGN.md actually describes.

  // C1 — at CREW_FULL and above, every scaled value IS its §14 value. This is
  //      what lets the tables above be read without carrying the scaling in your
  //      head, and what stops a solo fix regressing a full crew.
  for (const crew of [CREW_FULL, MAX_PLAYERS]) {
    check(
      crewPressure(crew) === 1,
      `crew scaling: crewPressure(${crew}) = ${crewPressure(crew)}, expected 1 — §14 must be reached at ${CREW_FULL} living players`,
    );
    check(
      roundGraceSeconds(crew) === ROUND_GRACE_CREW_S,
      `crew scaling: roundGraceSeconds(${crew}) = ${roundGraceSeconds(crew)}, expected ROUND_GRACE_CREW_S`,
    );
    check(
      stageTimeoutMs(crew) === STAGE_TIMEOUT_MS,
      `crew scaling: stageTimeoutMs(${crew}) = ${stageTimeoutMs(crew)}, expected STAGE_TIMEOUT_MS`,
    );
    check(
      patrolStandoffM(crew) === 0,
      `crew scaling: patrolStandoffM(${crew}) = ${patrolStandoffM(crew)} — a full crew must never be avoided`,
    );
    check(
      searchThreshold(crew) === ATTN_SEARCH,
      `crew scaling: searchThreshold(${crew}) = ${searchThreshold(crew)}, expected ATTN_SEARCH`,
    );
    for (let s = 0; s <= MAX_DIRECTOR_STAGE; s++) {
      const base = directorConfig(s);
      const scaled = crewScaledStage(s, crew);
      check(
        scaled.patrolSpeed === base.patrolSpeed &&
          scaled.patrolThreshold === base.patrolThreshold &&
          scaled.searchDuration === base.searchDuration &&
          scaled.huntTrigger === base.huntTrigger &&
          scaled.crowdBias === base.crowdBias &&
          scaled.gravityFailures === base.gravityFailures,
        `crew scaling: stage ${s} at ${crew} players does not match the §5 table`,
      );
    }
  }

  // C2 — monotone in both axes: the alien never gets gentler as the round
  //      escalates, and never gets harsher as the crew shrinks.
  for (let crew = 1; crew <= MAX_PLAYERS; crew++) {
    for (let s = 0; s <= MAX_DIRECTOR_STAGE; s++) {
      const row = crewScaledStage(s, crew);
      check(
        row.patrolThreshold >= FLOOR,
        `crew scaling: stage ${s} at ${crew} players has PATROL threshold ${row.patrolThreshold}, below FLOOR (${FLOOR}) — unreachable`,
      );
      // §14 check 5, re-run: you must never be able to out-slide it on rails.
      check(
        row.patrolSpeed > RAIL_SLIDE,
        `crew scaling: stage ${s} at ${crew} players patrols at ${row.patrolSpeed}, not above RAIL_SLIDE (${RAIL_SLIDE})`,
      );
      if (s > 0) {
        const prev = crewScaledStage(s - 1, crew);
        check(
          row.patrolThreshold < prev.patrolThreshold,
          `crew scaling: at ${crew} players, stage ${s} threshold ${row.patrolThreshold} does not sharpen past stage ${s - 1} (${prev.patrolThreshold}) — progress must always buy pressure`,
        );
        check(
          row.patrolSpeed >= prev.patrolSpeed,
          `crew scaling: at ${crew} players, stage ${s} patrol speed ${row.patrolSpeed} is slower than stage ${s - 1}`,
        );
        check(
          row.gravityFailures >= prev.gravityFailures,
          `crew scaling: at ${crew} players, stage ${s} allows ${row.gravityFailures} gravity failures, fewer than stage ${s - 1} (${prev.gravityFailures}) — the station never repairs itself as it escalates`,
        );
      }
      if (crew > 1) {
        const fewer = crewScaledStage(s, crew - 1);
        check(
          fewer.gravityFailures <= row.gravityFailures,
          `crew scaling: stage ${s} drops MORE modules at ${crew - 1} players (${fewer.gravityFailures}) than at ${crew} (${row.gravityFailures}) — fewer hands must never mean more zero-G`,
        );
        check(
          row.patrolThreshold <= fewer.patrolThreshold,
          `crew scaling: stage ${s} is SHARPER at ${crew - 1} players (${fewer.patrolThreshold}) than at ${crew} (${row.patrolThreshold}) — fewer ears must never mean more danger`,
        );
        check(
          row.huntTrigger <= fewer.huntTrigger,
          `crew scaling: stage ${s} HUNT trigger is lower at ${crew - 1} players (${fewer.huntTrigger}) than at ${crew} (${row.huntTrigger})`,
        );
      }
    }
    check(
      searchThreshold(crew) >= ATTN_SEARCH,
      `crew scaling: searchThreshold(${crew}) = ${searchThreshold(crew)} is below ATTN_SEARCH (${ATTN_SEARCH})`,
    );
    check(
      roundGraceSeconds(crew) >= ROUND_GRACE_CREW_S,
      `crew scaling: roundGraceSeconds(${crew}) = ${roundGraceSeconds(crew)} is shorter than the full-crew grace`,
    );
  }

  // C3 — solo, the §3 quiet tier must be genuinely quiet on PATROL and the loud
  //      tier must genuinely still cost you. This is the entire solo brief in
  //      two loops: careful play survives, careless play does not.
  const soloPatrol = patrolThreshold(0, 1);
  const quietTier: Array<[string, number]> = [
    ['rail pull', LOUDNESS.RAIL_PULL],
    ['hand pump', LOUDNESS.HAND_PUMP],
    ['gentle push-off', LOUDNESS.PUSH_OFF],
    ['handrail knock', LOUDNESS.KNOCK],
    ['panicked breathing', BREATHING_MAX],
  ];
  for (const [label, value] of quietTier) {
    check(
      value < soloPatrol,
      `crew scaling: solo PATROL threshold ${soloPatrol} does not clear the quiet tier — ${label} (${value}) is still heard at point-blank range`,
    );
  }
  const loudTier: Array<[string, number]> = [
    ['breaker toggle', LOUDNESS.BREAKER],
    ['hatch cycle', LOUDNESS.HATCH_CYCLE],
    ['keyswitch', LOUDNESS.KEYSWITCH],
    ['pry bar', LOUDNESS.PRY_BAR],
    ['cargo bounce', LOUDNESS.CARGO_BOUNCE],
    ['full-speed crash', impactNoise(PUSH_MAX)],
  ];
  for (const [label, value] of loudTier) {
    check(
      value >= soloPatrol,
      `crew scaling: solo PATROL threshold ${soloPatrol} is above ${label} (${value}) — every §11 loud-fast path must still be heard, or progress costs nothing`,
    );
  }

  // C4 — solo, a rail pull survives a SEARCH sweep but a catch never does, so
  //      §3's "it hears better when it's already looking for you" keeps biting.
  const soloSearch = searchThreshold(1);
  check(
    LOUDNESS.RAIL_PULL < soloSearch,
    `crew scaling: solo SEARCH threshold ${soloSearch} still catches a rail pull (${LOUDNESS.RAIL_PULL}) — the sweep latches on and never lets go`,
  );
  check(
    catchNoise(0) >= soloSearch && LOUDNESS.PUSH_OFF >= soloSearch,
    `crew scaling: solo SEARCH threshold ${soloSearch} lets a push-off (${LOUDNESS.PUSH_OFF}) or a rail catch (${catchNoise(0)}) through a sweep unheard`,
  );
  check(
    soloSearch < soloPatrol,
    `crew scaling: solo SEARCH threshold ${soloSearch} is not sharper than solo PATROL (${soloPatrol})`,
  );

  // C5 — the PATROL standoff has to sit inside §5's own anti-camping radius, or
  //      the two rules disagree about how close it may loiter; and inside the
  //      HUNT reflex range, or it drifts out of grabbing distance of a racket.
  check(
    PATROL_STANDOFF_SOLO_M < ANTICAMP_RADIUS_M,
    `crew scaling: PATROL_STANDOFF_SOLO_M (${PATROL_STANDOFF_SOLO_M}) must sit inside ANTICAMP_RADIUS_M (${ANTICAMP_RADIUS_M})`,
  );
  check(
    PATROL_STANDOFF_SOLO_M <= HUNT_TRIGGER_RANGE_M,
    `crew scaling: PATROL_STANDOFF_SOLO_M (${PATROL_STANDOFF_SOLO_M}) exceeds HUNT_TRIGGER_RANGE_M (${HUNT_TRIGGER_RANGE_M}) — it would stand off beyond the range at which a loud arrival can grab it`,
  );

  // C6 — the round-start grace must outlast the three-hop spawn floor it is
  //      replacing as the opening's fairness guarantee (§10), or it is theatre.
  const threeHopSeconds = (ALIEN_SPAWN_MIN_HOPS * MODULE_LENGTH_M) / SPEED_PATROL;
  check(
    ROUND_GRACE_CREW_S > threeHopSeconds,
    `crew scaling: the full-crew grace (${ROUND_GRACE_CREW_S}s) is no better than the ${ALIEN_SPAWN_MIN_HOPS}-hop spawn floor it replaces (~${threeHopSeconds.toFixed(0)}s)`,
  );
  check(
    ROUND_GRACE_SOLO_S > ROUND_GRACE_CREW_S,
    `crew scaling: the solo grace (${ROUND_GRACE_SOLO_S}s) must exceed the crew grace (${ROUND_GRACE_CREW_S}s)`,
  );
  check(
    STAGE_TIMEOUT_SOLO_MS > STAGE_TIMEOUT_MS,
    `crew scaling: STAGE_TIMEOUT_SOLO_MS (${STAGE_TIMEOUT_SOLO_MS}) must be longer than STAGE_TIMEOUT_MS (${STAGE_TIMEOUT_MS})`,
  );

  // =========================================================================
  // WALKING PIVOT — gaits, gravity and hiding
  //
  // Same discipline as everything above: these are not opinions, they are the
  // relationships that make the new numbers a system rather than a list. Each
  // one is a sentence from the design that would otherwise only be true by
  // accident.
  // =========================================================================

  const crouch = GAIT_PROFILES.crouch;
  const walk = GAIT_PROFILES.walk;
  const sprint = GAIT_PROFILES.sprint;

  // W1 — THE speed ladder, end to end. Read it and the whole locomotion design
  //      is in one line. Every neighbouring pair below is load-bearing.
  const ladder: Array<[string, number, 'lt' | 'lte']> = [
    ['SPEED_CROUCH', crouch.speed, 'lt'],
    // A handrail pull beats a crouch: the quiet option costs time in BOTH
    // regimes, so zero-G never becomes the free way to be careful. RAIL_SLIDE
    // and SPEED_SEARCH are equal by §14's own design, hence 'lte' on the second.
    ['SPEED_SEARCH', SPEED_SEARCH, 'lt'],
    ['RAIL_SLIDE', RAIL_SLIDE, 'lte'],
    // Walking outpaces a SEARCH sweep but loses to a PATROL — you are slowly
    // run down if you never commit to anything.
    ['SPEED_WALK', walk.speed, 'lt'],
    ['SPEED_PATROL', SPEED_PATROL, 'lt'],
    // THE BRIEF, both halves: fleeing works, escaping needs geometry.
    ['SPEED_SPRINT', sprint.speed, 'lt'],
    ['SPEED_HUNT', SPEED_HUNT, 'lt'],
    // A push-off is still the fastest thing in the game, so zero-G stays the
    // high-risk shortcut §4 designed rather than becoming a punishment.
    ['PUSH_MAX', PUSH_MAX, 'lt'],
  ];
  for (let i = 1; i < ladder.length; i++) {
    const [loName, lo] = ladder[i - 1] as [string, number, 'lt' | 'lte'];
    const [hiName, hi, rel] = ladder[i] as [string, number, 'lt' | 'lte'];
    check(
      rel === 'lt' ? lo < hi : lo <= hi,
      `gait: the speed ladder is broken at ${loName} (${lo}) ${rel === 'lt' ? '<' : '<='} ${hiName} (${hi})`,
    );
  }

  // W2 — the brief's two hard bounds, stated on their own so a failure names
  //      them rather than a ladder index.
  check(
    sprint.speed > SPEED_PATROL,
    `gait: SPEED_SPRINT (${sprint.speed}) must exceed SPEED_PATROL (${SPEED_PATROL}) — fleeing has to be possible at all`,
  );
  check(
    sprint.speed < SPEED_HUNT,
    `gait: SPEED_SPRINT (${sprint.speed}) must stay below SPEED_HUNT (${SPEED_HUNT}) — escaping must require geometry, not raw speed`,
  );

  // W3 — chase geometry. The reason the pivot happened: at these speeds, how
  //      much station do you cover before a hunt closes one module length?
  //      Under 3 module-lengths there are no corners to use and we have rebuilt
  //      the 1-D chase this whole change exists to delete.
  const closeSeconds = MODULE_LENGTH_M / (SPEED_HUNT - sprint.speed);
  const modulesCovered = (closeSeconds * sprint.speed) / MODULE_LENGTH_M;
  check(
    modulesCovered >= 3,
    `gait: a sprinting player covers only ${modulesCovered.toFixed(1)} modules before a HUNT closes ${MODULE_LENGTH_M}m — chases collapse back to one dimension below 3`,
  );

  // W4 — every footstep is physically audible, and louder gait = louder step.
  for (const g of [crouch, walk, sprint]) {
    check(
      g.footstep > FLOOR,
      `gait: ${g.gait} footstep (${g.footstep}) is not above FLOOR (${FLOOR}) — a free gait deletes pillar 1`,
    );
  }
  check(
    crouch.footstep < walk.footstep && walk.footstep < sprint.footstep,
    `gait: footsteps must rise crouch (${crouch.footstep}) < walk (${walk.footstep}) < run (${sprint.footstep})`,
  );

  // W5 — the stride model. Cadence must not fall as you speed up (a faster gait
  //      that steps LESS often is nonsense), and loudness per metre must rise,
  //      so a slower gait is never a worse deal for the same ground covered.
  //      That second one is what makes crouching a real choice.
  check(
    crouch.cadenceHz < walk.cadenceHz && walk.cadenceHz < sprint.cadenceHz,
    `gait: cadence must rise with speed — crouch ${crouch.cadenceHz.toFixed(2)}Hz, walk ${walk.cadenceHz.toFixed(2)}Hz, run ${sprint.cadenceHz.toFixed(2)}Hz`,
  );
  check(
    crouch.loudnessPerMetre < walk.loudnessPerMetre &&
      walk.loudnessPerMetre < sprint.loudnessPerMetre,
    `gait: loudness per metre must rise with speed — crouch ${crouch.loudnessPerMetre.toFixed(1)}, walk ${walk.loudnessPerMetre.toFixed(1)}, run ${sprint.loudnessPerMetre.toFixed(1)}; otherwise crouching is strictly worse`,
  );
  for (const g of [crouch, walk, sprint]) {
    check(
      Math.abs(g.cadenceHz - g.speed / g.strideM) < 1e-9 &&
        Math.abs(g.loudnessPerMetre - g.footstep / g.strideM) < 1e-9,
      `gait: ${g.gait}'s derived fields do not match speed/stride and footstep/stride`,
    );
    // Footsteps are discrete events on a 20 Hz wire (§7). Two in one tick would
    // coalesce into one and the noise ring would under-report the gait.
    check(
      1000 / g.cadenceHz > TICK_MS,
      `gait: ${g.gait} steps every ${(1000 / g.cadenceHz).toFixed(0)}ms, inside one ${TICK_MS}ms server tick — footsteps would merge`,
    );
    check(
      g.strideM > 0 && g.eyeHeight < g.bodyHeight,
      `gait: ${g.gait} has a nonsense stride (${g.strideM}) or an eye above its own head (${g.eyeHeight}/${g.bodyHeight})`,
    );
  }

  // W6 — where each gait sits against the alien's attention (§3). This is the
  //      whole risk ladder, and it must hold at BOTH ends of the crew range.
  const soloPatrolNow = patrolThreshold(0, 1);
  const soloSearchNow = searchThreshold(1);
  check(
    sprint.footstep >= soloPatrolNow,
    `gait: a sprint footstep (${sprint.footstep}) is under the solo PATROL threshold (${soloPatrolNow}) — running must ALWAYS be heard`,
  );
  check(
    walk.footstep < soloPatrolNow,
    `gait: a walk footstep (${walk.footstep}) clears the solo PATROL threshold (${soloPatrolNow}) — walking is the default gait and must be survivable alone`,
  );
  check(
    walk.footstep <= ATTN_PATROL,
    `gait: a walk footstep (${walk.footstep}) is above ATTN_PATROL (${ATTN_PATROL}) — a full crew could never move at all`,
  );
  check(
    walk.footstep > directorConfig(MAX_DIRECTOR_STAGE).patrolThreshold,
    `gait: a walk footstep (${walk.footstep}) is still inaudible at the sharpest PATROL threshold (${directorConfig(MAX_DIRECTOR_STAGE).patrolThreshold}) — escalation must eventually reach ordinary movement`,
  );
  // The §3 "rail pull in a sweep" mechanic, mirrored under gravity: crouching
  // is fatal at point-blank in a SEARCH with a crew, and survivable alone.
  check(
    crouch.footstep <= ATTN_SEARCH,
    `gait: a crouched footstep (${crouch.footstep}) is above ATTN_SEARCH (${ATTN_SEARCH}) — the quietest gait must be safe outside point-blank range`,
  );
  check(
    crouch.footstep < soloSearchNow,
    `gait: a crouched footstep (${crouch.footstep}) is caught by a solo SEARCH sweep (${soloSearchNow}) — the sweep would latch on and never let go`,
  );
  // The cheapest deliberate movement must cost the SAME in both regimes, or one
  // of them becomes the free way to be careful and the other stops being used.
  // A crouched footstep and a rail pull are that movement.
  check(
    crouch.footstep === LOUDNESS.RAIL_PULL,
    `gait: a crouched footstep (${crouch.footstep}) and a rail pull (${LOUDNESS.RAIL_PULL}) have drifted apart — whichever is cheaper becomes the only careful movement anybody uses. Move both or neither`,
  );
  for (let crew = 1; crew <= MAX_PLAYERS; crew++) {
    for (let s = 0; s <= MAX_DIRECTOR_STAGE; s++) {
      check(
        sprint.footstep >= crewScaledStage(s, crew).patrolThreshold,
        `gait: at ${crew} players, stage ${s}, a sprint footstep (${sprint.footstep}) is under the PATROL threshold (${crewScaledStage(s, crew).patrolThreshold}) — sprinting must never be free`,
      );
    }
  }

  // W7 — landings. Monotone in speed and in gait, and continuous with the
  //      footstep it replaces, or "controlled landing is quiet" is a slogan.
  for (const g of GAITS) {
    const p = GAIT_PROFILES[g];
    check(
      landingNoise(0, g) === p.footstep,
      `landing: a zero-speed landing in ${g} reports ${landingNoise(0, g)}, not its own footstep (${p.footstep})`,
    );
    check(
      landingNoise(p.landingSoftMaxMps, g) === p.footstep,
      `landing: ${g}'s soft-landing tolerance (${p.landingSoftMaxMps} m/s) does not actually land quiet`,
    );
    // A genuine fall always costs more than the stride it interrupts. Note this
    // is asserted at terminal velocity, not just past the tolerance: while
    // SPRINTING you are already paying 30 a stride, so a landing a hair over
    // 1.2 m/s legitimately adds nothing. The cliff is only a cliff for the
    // gaits that were quiet, which is exactly where it should be.
    check(
      landingNoise(TERMINAL_VELOCITY_M_S, g) > p.footstep,
      `landing: a full-speed fall in ${g} costs ${landingNoise(TERMINAL_VELOCITY_M_S, g)}, no more than an ordinary footstep (${p.footstep})`,
    );
  }
  // THE landing mechanic, stated as one number: what does crouching before you
  // touch down actually buy? A jump landed on the run against the same jump
  // landed in a crouch must be worth at least a walking footstep of silence, or
  // "controlled landing is quiet" is not a decision anybody would make.
  const jumpSilenceBought =
    landingNoise(JUMP_SPEED_M_S, 'sprint') - landingNoise(JUMP_SPEED_M_S, 'crouch');
  check(
    jumpSilenceBought >= FOOTSTEP_WALK,
    `landing: crouching to absorb a jump saves only ${jumpSilenceBought.toFixed(1)} loudness — under one walking footstep (${FOOTSTEP_WALK}), so nobody would bother`,
  );
  for (let v = 0; v <= PUSH_MAX + 1e-9; v += 0.1) {
    const c = landingNoise(v, 'crouch');
    const w = landingNoise(v, 'walk');
    const r = landingNoise(v, 'sprint');
    check(
      c <= w && w <= r,
      `landing: at ${v.toFixed(1)} m/s a louder gait is quieter — crouch ${c}, walk ${w}, run ${r}`,
    );
    if (v > 0) {
      for (const g of GAITS) {
        check(
          landingNoise(v, g) >= landingNoise(v - 0.1, g),
          `landing: ${g} gets QUIETER between ${(v - 0.1).toFixed(1)} and ${v.toFixed(1)} m/s`,
        );
      }
    }
  }
  // The jump, in one relationship: loud on the run, silent in a crouch.
  check(
    JUMP_SPEED_M_S <= crouch.landingSoftMaxMps,
    `jump: landing from JUMP_HEIGHT_M arrives at ${JUMP_SPEED_M_S.toFixed(2)} m/s, past what a crouch absorbs (${crouch.landingSoftMaxMps}) — there would be no quiet way to jump`,
  );
  check(
    JUMP_SPEED_M_S > walk.landingSoftMaxMps,
    `jump: landing from JUMP_HEIGHT_M (${JUMP_SPEED_M_S.toFixed(2)} m/s) is absorbed by an ordinary walk — jumping would be free`,
  );

  // W8 — the speed domain. impactNoise' whole codomain has to stay inside the
  //      §3 table, and the server's anti-teleport bound has to cover the
  //      fastest legal body. These two protect the wire values below.
  check(
    TERMINAL_VELOCITY_M_S <= PUSH_MAX,
    `gravity: TERMINAL_VELOCITY_M_S (${TERMINAL_VELOCITY_M_S}) exceeds PUSH_MAX (${PUSH_MAX}) — a fall would out-shout the top of the §3 movement tier`,
  );
  const fastestLegal = Math.hypot(TERMINAL_VELOCITY_M_S, sprint.speed);
  check(
    MAX_LEGAL_SPEED_M_S >= fastestLegal && MAX_LEGAL_SPEED_M_S >= PUSH_MAX,
    `gravity: MAX_LEGAL_SPEED_M_S (${MAX_LEGAL_SPEED_M_S}) is under the fastest legal body (${fastestLegal.toFixed(2)} m/s falling with air control, or PUSH_MAX ${PUSH_MAX}) — the §7 speed check would eject honest players`,
  );

  // W9 — THE TWO WIRE VALUES. Both are regression tests for real, fixed bugs:
  //      `resolveImpact` captures approach speed from -preVelocity.dot(normal)
  //      BEFORE restitution and tangent friction touch it, and that is what
  //      makes these two numbers arrive at the server correctly. Pinning them
  //      here means anyone who drifts a constant breaks the build instead of
  //      quietly re-breaking §5's chase loop.
  check(
    impactNoise(PUSH_MAX) === 51,
    `wire: a full-speed crash must reach the server at 51, not ${impactNoise(PUSH_MAX)}`,
  );
  check(
    catchNoise(PUSH_MAX) === 26,
    `wire: a full-speed clean catch must reach the server at 26, not ${catchNoise(PUSH_MAX)}`,
  );
  check(
    impactNoise(PUSH_MAX) >= HUNT_TRIGGER,
    `wire: a full-speed crash (${impactNoise(PUSH_MAX)}) no longer trips HUNT_TRIGGER (${HUNT_TRIGGER}) — §5's chase loop would never fire`,
  );

  // W10 — collider geometry. Nothing exotic; these just stop a subsystem being
  //       built against a body that cannot exist.
  check(
    PLAYER_CROUCH_HEIGHT_M < PLAYER_STAND_HEIGHT_M &&
      EYE_HEIGHT_CROUCH_M < PLAYER_CROUCH_HEIGHT_M &&
      EYE_HEIGHT_STAND_M < PLAYER_STAND_HEIGHT_M,
    'collider: crouched must be shorter than standing, and eyes must sit inside the head',
  );
  check(
    PLAYER_CROUCH_HEIGHT_M >= 2 * PLAYER_RADIUS,
    `collider: PLAYER_CROUCH_HEIGHT_M (${PLAYER_CROUCH_HEIGHT_M}) is shorter than a capsule of PLAYER_RADIUS (${PLAYER_RADIUS}) can be`,
  );
  check(
    PLAYER_STAND_HEIGHT_M < DECK_HEADROOM_M,
    `deck: a standing player (${PLAYER_STAND_HEIGHT_M}m) does not fit under ${DECK_HEADROOM_M}m of headroom — the station kit and the controller disagree about the floor`,
  );
  check(
    DECK_HALF_WIDTH_M > PLAYER_RADIUS,
    `deck: the walkable surface (${2 * DECK_HALF_WIDTH_M}m wide) is narrower than the player (${2 * PLAYER_RADIUS}m) — nobody can stand on it`,
  );
  check(
    GROUND_PROBE_M < STEP_HEIGHT_M && STEP_HEIGHT_M < PLAYER_CROUCH_HEIGHT_M,
    `collider: expected GROUND_PROBE_M (${GROUND_PROBE_M}) < STEP_HEIGHT_M (${STEP_HEIGHT_M}) < PLAYER_CROUCH_HEIGHT_M (${PLAYER_CROUCH_HEIGHT_M}) — a probe longer than a step is how a body hovers over a drop`,
  );
  check(
    STEP_HEIGHT_M <= JUMP_HEIGHT_M,
    `collider: STEP_HEIGHT_M (${STEP_HEIGHT_M}) exceeds JUMP_HEIGHT_M (${JUMP_HEIGHT_M}) — you could walk onto things you cannot jump onto`,
  );
  check(
    GROUND_SNAP_M >= GROUND_PROBE_M,
    `collider: GROUND_SNAP_M (${GROUND_SNAP_M}) is shorter than GROUND_PROBE_M (${GROUND_PROBE_M}) — the controller would find ground it then refuses to snap to`,
  );
  check(
    STATION_DOWN.x === 0 && STATION_DOWN.z === 0 && STATION_DOWN.y === -1,
    'frame: STATION_DOWN must be a unit −Y vector — one global down, or the mental model pillar 3 protects is gone',
  );
  check(
    STATION_UP.x === -STATION_DOWN.x &&
      STATION_UP.y === -STATION_DOWN.y &&
      STATION_UP.z === -STATION_DOWN.z,
    'frame: STATION_UP must be exactly the negation of STATION_DOWN',
  );

  // W11 — transitions between the regimes.
  check(
    transitionNoise('launch', sprint.speed, 'sprint') === LOUDNESS.PUSH_OFF,
    `transition: sprinting into a zero-G module must cost a push-off (${LOUDNESS.PUSH_OFF}), not ${transitionNoise('launch', sprint.speed, 'sprint')}`,
  );
  check(
    transitionNoise('launch', walk.speed, 'walk') === 0,
    `transition: walking into a zero-G module must be a silent drift — it currently costs ${transitionNoise('launch', walk.speed, 'walk')}`,
  );
  check(
    transitionNoise('liftoff', walk.speed, 'walk') === 0 &&
      transitionNoise('settle', 0, 'walk') === 0,
    'transition: the station losing or regaining its floor is the plant\'s noise, never the player\'s',
  );
  check(
    GRAVITY_WARNING_S * sprint.speed >= MODULE_LENGTH_M / 2,
    `transition: GRAVITY_WARNING_S (${GRAVITY_WARNING_S}s) only carries a sprinter ${(GRAVITY_WARNING_S * sprint.speed).toFixed(1)}m — not far enough to reach the middle of a ${MODULE_LENGTH_M}m module and grab a rail`,
  );
  check(
    LOUDNESS.GRAVITY_SHIFT >= soloPatrolNow,
    `transition: a gravity plant failing (${LOUDNESS.GRAVITY_SHIFT}) must be loud enough to be an event even solo (threshold ${soloPatrolNow})`,
  );
  check(
    LIFTOFF_IMPULSE_M_S > 0 && LIFTOFF_IMPULSE_M_S < RAIL_SLIDE,
    `transition: LIFTOFF_IMPULSE_M_S (${LIFTOFF_IMPULSE_M_S}) must lift a standing body off the deck without launching it faster than it could pull itself along a rail (${RAIL_SLIDE})`,
  );
  check(
    LAUNCH_MIN_SPEED_M_S === PUSH_MIN,
    `transition: LAUNCH_MIN_SPEED_M_S (${LAUNCH_MIN_SPEED_M_S}) has drifted off PUSH_MIN (${PUSH_MIN}) — the two describe the same threshold`,
  );

  // W12 — hiding. Blind alien: geometry plus silence, and nothing else.
  check(
    HIDE_MUFFLE_DB < 0,
    `hiding: HIDE_MUFFLE_DB (${HIDE_MUFFLE_DB}) must be a negative dB offset, like every other attenuation in §14`,
  );
  const hiddenPanicAtRadius =
    BREATHING_MAX + HIDE_MUFFLE_DB - ATTENUATION_PER_M * HIDE_SAFE_RADIUS_M;
  check(
    hiddenPanicAtRadius < ATTN_SEARCH,
    `hiding: a maximally panicked occupant is still audible to a sweep at ${HIDE_SAFE_RADIUS_M}m (${hiddenPanicAtRadius} vs ATTN_SEARCH ${ATTN_SEARCH}) — hiding would be pure theatre`,
  );
  check(
    BREATHING_MAX + HIDE_MUFFLE_DB > FLOOR,
    `hiding: HIDE_MUFFLE_DB (${HIDE_MUFFLE_DB}) silences panicked breathing outright (${BREATHING_MAX + HIDE_MUFFLE_DB} vs FLOOR ${FLOOR}) — hiding would be a win button`,
  );
  check(
    HIDE_QUIET > FLOOR && HIDE_QUIET < HIDE_LOUD,
    `hiding: expected FLOOR (${FLOOR}) < HIDE_QUIET (${HIDE_QUIET}) < HIDE_LOUD (${HIDE_LOUD})`,
  );
  check(
    HIDE_QUIET < ATTN_PATROL,
    `hiding: climbing in carefully (${HIDE_QUIET}) is heard by a stage-0 patrol (${ATTN_PATROL}) — the quiet-slow path must actually be quiet`,
  );
  check(
    HIDE_LOUD >= soloPatrolNow,
    `hiding: diving in (${HIDE_LOUD}) is missed even by a solo patrol (${soloPatrolNow}) — the loud-fast path must cost something`,
  );
  check(
    HIDE_ENTER_TIME_SLOW_S > HIDE_ENTER_TIME_FAST_S && HIDE_ENTER_TIME_FAST_S > 0,
    `hiding: the careful entry (${HIDE_ENTER_TIME_SLOW_S}s) must take longer than the dive (${HIDE_ENTER_TIME_FAST_S}s)`,
  );
  check(
    hideNoise(0) === HIDE_QUIET && hideNoise(1) === HIDE_LOUD,
    'hiding: hideNoise must span HIDE_QUIET..HIDE_LOUD exactly',
  );
  check(
    hideEnterSeconds(0) === HIDE_ENTER_TIME_SLOW_S &&
      hideEnterSeconds(1) === HIDE_ENTER_TIME_FAST_S,
    'hiding: hideEnterSeconds must span the slow..fast entry times exactly',
  );
  // The careful entry must not be buyable while it is already coming for you.
  check(
    HIDE_ENTER_TIME_SLOW_S * SPEED_HUNT > MODULE_LENGTH_M,
    `hiding: a careful entry (${HIDE_ENTER_TIME_SLOW_S}s) fits inside the time a HUNT needs to cross one module (${(MODULE_LENGTH_M / SPEED_HUNT).toFixed(1)}s) — hiding late would be free`,
  );
  check(
    LOUDNESS.HIDE_BREACH >= LOUDNESS.ALIEN_HUNT,
    `hiding: a breach (${LOUDNESS.HIDE_BREACH}) must be at least as loud as a hunt (${LOUDNESS.ALIEN_HUNT}) — §5 forbids it doing anything decisive in silence`,
  );
  check(
    HIDE_BREACH_TIME_S > 0 && HIDE_BREACH_RANGE_M > 0 && HIDE_BREACH_RANGE_M < MODULE_LENGTH_M,
    `hiding: the breach must happen at contact range inside one module, not at ${HIDE_BREACH_RANGE_M}m`,
  );
  check(
    muffledLoudness(LOUDNESS.RAIL_PULL) >= 0 && muffledLoudness(100, -200) === 0,
    'hiding: muffledLoudness must clamp at 0 — a negative source level poisons downstream gain maths',
  );

  // W13 — how much of the station may lose its floor. Walking is the DEFAULT;
  //       zero-G is a spike. If this ever passes trivially, the pivot has been
  //       undone by accretion.
  const maxDirectorFailures = Math.max(...DIRECTOR_STAGES.map((s) => s.gravityFailures));
  const zeroGCeiling = Math.floor(STATION_MODULES_MIN * ZERO_G_FRACTION_MAX);
  check(
    ZERO_G_AUTHORED_MAX + maxDirectorFailures <= zeroGCeiling,
    `zero-G budget: ${ZERO_G_AUTHORED_MAX} authored + ${maxDirectorFailures} director-dropped modules exceeds ${ZERO_G_FRACTION_MAX * 100}% of the smallest legal station (${zeroGCeiling} of ${STATION_MODULES_MIN}) — walking must stay the default`,
  );
  check(
    DIRECTOR_STAGES[0]!.gravityFailures === 0,
    'zero-G budget: the round must start exactly as the level was authored (stage 0 gravityFailures must be 0)',
  );
  check(
    ZERO_G_AUTHORED_MAX < STATION_MODULES_MIN / 2,
    `zero-G budget: ZERO_G_AUTHORED_MAX (${ZERO_G_AUTHORED_MAX}) lets a level author half the station without a floor`,
  );

  if (fail.length > 0) throw new ConstantsCoherenceError(fail);
}

// ---------------------------------------------------------------------------
// Run the checks once at module load in dev, on both client and server.
// ---------------------------------------------------------------------------

function isDevEnvironment(): boolean {
  try {
    // Vite injects import.meta.env in the browser build.
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env && typeof env.DEV === 'boolean') return env.DEV;
  } catch {
    /* import.meta.env is absent under plain Node — fall through. */
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc && proc.env) return proc.env.NODE_ENV !== 'production';
  return true;
}

/** True when the coherence check ran and passed at import time. */
export const CONSTANTS_CHECKED: boolean = (() => {
  if (!isDevEnvironment()) return false;
  assertConstantsCoherent();
  return true;
})();
