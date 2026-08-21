/**
 * Player-local tuning — DESIGN.md §4 / §6 support values that §14 does NOT define.
 *
 * HARD RULE: nothing in this file may duplicate a §14 constant. RAIL_SLIDE,
 * PUSH_MIN, PUSH_MAX, CHARGE_TIME, GRAB_RANGE, DRAG_HALFLIFE, PLAYER_RADIUS,
 * catchNoise(), impactNoise(), breathingNoise(), the gait table, the walking
 * constants (GROUND_*, STEP_HEIGHT_M, JUMP_*, AIR_CONTROL, BOB_AMPLITUDE_M, the
 * collider heights, DECK_Y_M) and the whole LOUDNESS table are imported from
 * `@shared/constants` at every use site. These are the numbers the doc leaves to
 * feel: contact response, grip geometry, mouse sensitivity, the heart-rate
 * curve, camera smoothing. They are all tuning dials, all documented, and all
 * safe to change without re-checking the §14 sanity set.
 */

import { PLAYER_RADIUS } from '@shared/constants';

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/** Longest frame `Player.update` will integrate, in seconds. A 2-second stall
 *  must not teleport a 6 m/s body twelve metres through a bulkhead. */
export const MAX_FRAME_DT = 0.1;

// ---------------------------------------------------------------------------
// Collision response (§4 "swept sphere against a BVH of static geometry")
// ---------------------------------------------------------------------------

/** Sweep substep length as a fraction of PLAYER_RADIUS. Half a radius, so the
 *  body cannot tunnel a bulkhead at PUSH_MAX whatever §14 sizes it at. */
export const COLLISION_SUBSTEP_FACTOR = 0.5;
/** Depenetration passes per substep. Four resolves a corner cleanly. */
export const DEPENETRATION_ITERATIONS = 4;
/** Metres of push below which a contact is treated as noise, not a hit. */
export const CONTACT_EPSILON = 1e-4;
/** Bounce. Zero-G bodies do bounce off bulkheads, but not like a ball. */
export const RESTITUTION = 0.2;
/** Tangential velocity retained through a contact — scuffing along a wall. */
export const TANGENT_FRICTION = 0.9;
/** m/s of closing speed below which a contact is a nudge, not an "uncontrolled
 *  impact" (§3). Below this no impact NoiseEvent is emitted at all. */
export const IMPACT_MIN_SPEED = 0.6;
/** Seconds between impact events, so grinding along a wall is one sound. */
export const IMPACT_COOLDOWN_S = 0.25;

// ---------------------------------------------------------------------------
// Walking (§4 "every module has a local floor and players WALK by default")
// ---------------------------------------------------------------------------
//
// Everything with a §14 home — SPEED_*, FOOTSTEP_*, STRIDE_*, STEP_HEIGHT_M,
// GROUND_PROBE_M, GROUND_SNAP_M, GROUND_ACCEL_M_S2, GROUND_STOP_HALFLIFE_S,
// AIR_CONTROL, JUMP_*, BOB_AMPLITUDE_M, the collider heights and DECK_Y_M — is
// imported, never restated. What is left here is the machinery of the swept
// capsule: how it probes, how it recovers, and how the camera is kept still
// while the body is snapped around underneath it.

/**
 * Metres the ground ray starts above the feet.
 *
 * A probe that starts exactly at the feet starts ON the deck surface, and a ray
 * whose origin is coplanar with the triangle it must hit is a coin toss. 5 cm of
 * lift is subtracted straight back out of the reported gap, so it changes
 * nothing except whether the deck is found.
 */
export const GROUND_PROBE_LIFT_M = 0.05;

/**
 * Minimum `normal · STATION_UP` for a surface to count as a floor.
 *
 * cos 50°. Above it you stand; below it the surface is a wall, and a wall you
 * are pressed against must never read as ground — that is how a player ends up
 * standing on the side of a tube. The kit's deck is flat, so this only ever
 * matters for the curved hull a module without a deck still has.
 */
export const GROUND_NORMAL_MIN = 0.64;

/**
 * Seconds after walking off a ledge during which a jump still works.
 *
 * Coyote time. Not realism — it is the difference between "the controller is
 * tight" and "the controller ate my input", and at 60 fps 0.1 s is six frames
 * of grace that no player will ever notice as generosity.
 */
export const COYOTE_TIME_S = 0.1;

/** Seconds after a jump during which the ground snap is suppressed, so the
 *  body actually leaves the deck instead of being glued straight back to it. */
export const JUMP_GROUND_LOCKOUT_S = 0.15;

/**
 * m/s of closing speed along STATION_DOWN below which arriving on the deck is
 * not a landing at all.
 *
 * Walking over a 2 cm weld seam is not a landing, and firing a `landing`
 * NoiseEvent for it would put a footstep-loudness event into §3's coalescing
 * window every time the deck is not perfectly flat. Above this the landing is
 * real and `landingNoise()` prices it — which for a gentle arrival is exactly
 * one footstep anyway, so nothing is lost at the boundary.
 */
export const LANDING_MIN_SPEED_M_S = 0.5;

/**
 * Metres of gap that still count as "landed" for a body that is AIRBORNE.
 *
 * `GROUND_PROBE_M` (0.35) is the WALKING probe — it exists so a body already on
 * its feet stays glued over a lip (§14). Reusing it for a falling body lands
 * everybody 35 cm early, which quietly halves the arrival speed: a 0.45 m jump
 * that should land at 2.97 m/s and pay `landingNoise` 33 instead lands at 1.3
 * and pays one 12-loudness footstep. The whole jump design (§4 — loud unless you
 * crouch) evaporates. A falling body lands when it reaches the deck; the swept
 * capsule has already stopped it there, so the gap is ~0 by construction.
 */
export const GROUND_LANDING_EPSILON_M = 0.03;

/** Fraction of the requested ground move that counts as "I got there". Below
 *  it the mover is considered blocked and the step-up is attempted. */
export const STEP_UP_PROGRESS = 0.9;

/**
 * Metres the step-up carries the body forward while it is lifted, at minimum.
 *
 * It has to be more than a body radius — so it is DERIVED from one, not typed.
 * A capsule that clears a coaming by a centimetre is still centred outside it,
 * and the ground ray — cast straight down the body's own axis — would find the
 * deck it just left rather than the ledge it is standing over. Slightly more
 * than `PLAYER_RADIUS` puts the axis genuinely over the new surface, which is
 * also the point at which the body would actually be standing on it rather than
 * balanced on its edge.
 *
 * The 7 cm of margin is what it was when the radius was 0.35 (0.42 total). It
 * is expressed against the radius now because the radius moved to 0.30 and a
 * literal 0.42 would have quietly become 1.4 body radii of free travel per
 * step-up — see the measured 5.22 m/s graze exploit under `STEP_RISE_MIN_M`,
 * which is exactly what over-paying this buys.
 *
 * The visible cost is a short forward lurch onto the step. Every first-person
 * controller has one; the alternative is a body that mounts a coaming by
 * millimetres per frame and reads as stuck.
 */
export const STEP_FORWARD_MIN_M = PLAYER_RADIUS + 0.07;

/** Extra metres the step-up probe drops through, so a body lifted over a
 *  coaming lands back on the deck rather than hovering a hair above it. */
export const STEP_DOWN_SLACK_M = 0.05;

/**
 * Metres of rise, above which a completed step-up counts as having CLIMBED
 * something and may keep its full `STEP_FORWARD_MIN_M` lurch.
 *
 * The lurch is legitimate when it puts a body on top of a ledge (see
 * `STEP_FORWARD_MIN_M`). It is not legitimate as a reward for grazing something
 * — and grazing is what `STEP_UP_PROGRESS` 0.9 actually detects most of the
 * time, because a body sliding along a prop's corner keeps only ~80% of its
 * requested move and trips the "blocked" test without being blocked at all.
 *
 * MEASURED, in `escape-soyuz`, before this existed: two deck banks 1.15 m tall
 * — far too tall to climb — sat a shoulder's width off the walking line. Each
 * graze paid a full 0.42 m of free travel in a single frame, so a walk down the
 * module ran at 1.72 m/s against `SPEED_WALK` 1.4, and a sprint held against a
 * rack wall chained 23 of them in 1.5 s for a sustained **5.22 m/s** — above
 * `SPEED_HUNT` 3.0, which is the one bound §4 hangs the entire gravity chase on
 * ("you cannot outrun a hunt; escape requires geometry").
 *
 * 2 cm is above the deck-edge trim (`DECK_EDGE_H` 0.025 clears it) and far
 * below anything a player would call a step.
 */
export const STEP_RISE_MIN_M = 0.02;

/**
 * Fraction of the requested ground move below which the flat sweep counts as
 * genuinely STOPPED rather than merely slowed.
 *
 * A rise-less step-up is the "walk over a coaming" case — up, across, and back
 * down to the height you started at — and §2's kit deliberately authors no such
 * lip ("sill, just under the deck, so a doorway never has a lip to step over",
 * `src/station/geometry.ts`). It stays supported anyway, for a level that does
 * author one, but only from a standing stop: at 0.15 a body has to be pressed
 * almost square against the thing before it is allowed to vault it, which is
 * exactly the case a graze is not.
 */
export const STEP_BLOCKED_PROGRESS = 0.15;

/** Metres of penetration a standing-up test tolerates before it refuses. Below
 *  this is the ordinary resting contact of a body against the deck. */
export const STAND_UP_CLEARANCE_M = 0.02;

/**
 * Minimum half-extent, in metres, the prop barrier gives a measured box.
 *
 * A puzzle panel's screen is a flat plate — one of its three local extents is
 * genuinely zero — and a zero half-extent has no face to leave by, so a body
 * resolved onto it would sit exactly on the plane and flicker. One centimetre
 * is below anything a player can see and above every floating-point tie.
 */
export const PROP_MIN_HALF_M = 0.01;

/**
 * Spacing of the prop barrier's capsule samples, as a fraction of
 * `PLAYER_RADIUS`.
 *
 * The barrier resolves a body as spheres along its own segment (see
 * `./propBarrier`), and the gap between two samples is the depth a box edge
 * landing between them can reach before either notices:
 * `r - sqrt(r^2 - (spacing/2)^2)`. At one whole radius that is 2.7 cm; at half a
 * radius it is 0.6 cm, which is under the resting contact the BVH already
 * tolerates (`STAND_UP_CLEARANCE_M`). The cost is three extra point-in-box tests
 * against props that are already inside the broad-phase, which is almost never
 * more than one prop.
 */
export const PROP_SAMPLE_FACTOR = 0.5;

/**
 * Metres of depenetration, in ONE grounded step, above which the body is judged
 * to be wedged rather than merely touching.
 *
 * A body that does not fit somewhere must not squeeze through it. Depenetration
 * alone will not stop that: a ceiling pushing down and a deck pushing up are
 * both VERTICAL corrections, and neither of them costs the body any of its
 * horizontal travel, so a standing player would slide under a slab they are 40
 * cm too tall for and come out the far side. Crouch is supposed to be the answer
 * to that (§4 — it is a smaller BODY, not a lower camera), which it only is if
 * standing is genuinely refused.
 *
 * The discriminator is free: an ordinary contact resolves in one pass of a
 * couple of centimetres, and a wedge never resolves at all, so it accumulates
 * the full push on every one of `DEPENETRATION_ITERATIONS` passes. 12 cm is well
 * above the first and far below the second. Only consulted while GROUNDED, so a
 * hard landing — which legitimately depenetrates deeply — is never mistaken for
 * one.
 */
export const WEDGE_DEPTH_M = 0.12;

/**
 * m/s of closing speed below which an AIRBORNE body hitting a WALL is a scuff
 * rather than an impact.
 *
 * Deliberately above `IMPACT_MIN_SPEED`: under gravity you are in contact with
 * the world constantly, and the walkable deck is only `2 × DECK_HALF_WIDTH_M`
 * across. The zero-G threshold is unchanged and still governs everything in a
 * `zero` module.
 */
export const WALL_IMPACT_MIN_SPEED = 1.5;

// ---------------------------------------------------------------------------
// View smoothing — the camera is not the body (§4 comfort, §13 motion sickness)
// ---------------------------------------------------------------------------

/**
 * Metres of camera lag the body may accumulate before it is clamped.
 *
 * The body gets snapped vertically for four legitimate reasons — a step-up over
 * a coaming, a ground snap down a lip, a crouch, and a `settle` that grows a
 * 1.7 m body downward out of a floating sphere. Every one of them is a
 * discontinuity, and a first-person camera that teleports vertically is the
 * single most reliable way to make somebody ill (§13). So the body moves at
 * once and the CAMERA is left behind by exactly the correction, then catches up
 * on a half-life. Nothing gameplay-facing reads the lagged position: noise
 * origins, the collider and the network transform are all the body.
 */
export const VIEW_LAG_MAX_M = 0.8;
/** Half-life of the camera catching the body back up. Fast enough to be gone
 *  inside a stride, slow enough that a 0.4 m step does not snap. */
export const VIEW_LAG_HALFLIFE_S = 0.07;

/** Lateral sway as a fraction of BOB_AMPLITUDE_M — a walk is not a pogo. */
export const BOB_LATERAL_FACTOR = 0.6;
/** Fraction of a gait's own speed below which the bob is silent. Stops the
 *  camera bobbing while a player leans into a wall going nowhere. */
export const BOB_MIN_SPEED_FRACTION = 0.15;

/**
 * Extra vignette a `liftoff` pulses in, before `vignetteStrength` scales it.
 *
 * The floor going out from under you is a set-piece (§4) and it has to READ as
 * one — but the reading may not be bought with a camera the player does not
 * control, because that is nausea, and this pivot exists partly to reduce
 * nausea. So the tell is the one effect the comfort menu already owns: a punch
 * of the vignette, which decays on its own and which a player who has turned
 * the vignette off simply does not receive.
 */
export const LIFTOFF_VIGNETTE_PULSE = 0.7;
/** Half-life of that pulse, seconds. */
export const VIGNETTE_PULSE_HALFLIFE_S = 0.6;

// ---------------------------------------------------------------------------
// Hiding (§4 "the genre gap r1 and r2 left open")
// ---------------------------------------------------------------------------

/**
 * Metres from a hide spot's `entryPos` at which the prompt appears and the
 * verb becomes available. Arm's length plus a step — you must be AT the locker,
 * the same rule §6 states for a puzzle panel.
 */
export const HIDE_REACH_M = 1.6;

/**
 * Degrees of yaw either side of a spot's `lookDir` you may turn while inside.
 *
 * You are in a locker: you can look along the crack, not over your shoulder.
 * Pitch is clamped separately and harder, because a body folded into an
 * equipment bay cannot look at its own feet.
 */
export const HIDE_YAW_LIMIT_DEG = 55;
export const HIDE_PITCH_LIMIT_DEG = 35;

/**
 * Haste (0–1) for each gait when getting into or out of a hide spot.
 *
 * The gait dial is already the game's risk dial (§0 pillar 2), so hiding reuses
 * it rather than inventing a second modifier: crouch in and you take the full
 * `HIDE_ENTER_TIME_SLOW_S` at `HIDE_QUIET`, sprint in and you dive in
 * `HIDE_ENTER_TIME_FAST_S` at `HIDE_LOUD`. One control, learned once, priced
 * the same everywhere.
 */
export const HIDE_HASTE_CROUCH = 0;
export const HIDE_HASTE_WALK = 0.5;
export const HIDE_HASTE_SPRINT = 1;

// ---------------------------------------------------------------------------
// Grip geometry (§4 GRIPPING)
// ---------------------------------------------------------------------------

/** Metres the body floats off the rail it is holding — an arm's length. The
 *  latch offset is projected perpendicular to the rail and clamped to this. */
export const GRIP_HOLD_DISTANCE = 0.45;
/** Metres of slide per `rail-pull` NoiseEvent (loudness 4, §3). Hand over hand. */
export const RAIL_PULL_INTERVAL_M = 1.0;
/** Multiplier on GRAB_RANGE for the crosshair's "rail" state (§6). Showing the
 *  grab prompt slightly before the buffered latch can fire reads as generous. */
export const RAIL_HINT_RANGE_FACTOR = 1.8;
/**
 * Seconds after a push-off during which the buffered latch is suppressed.
 *
 * Grip is HELD, not tapped (§4), so without this the rail you just launched from
 * re-latches on the very next substep and the push-off does nothing. 0.3 s puts
 * you 0.6–1.8 m out — past GRAB_RANGE at every charge level.
 */
export const PUSH_LATCH_LOCKOUT_S = 0.3;
/** Seconds between knocks (§10 knock codes). Stops Q from becoming a drum roll. */
export const KNOCK_COOLDOWN_S = 0.3;

/**
 * Extra metres, on top of PLAYER_RADIUS, that a GRIPPING slide is stopped short
 * of a shut hatch's plane.
 *
 * The bug this fixes: `RailGraph.slide()` correctly refuses to continue through
 * a closed or sealed hatch, but it stops the hand exactly AT the junction — and
 * the junction is the door plane. The body centre is the eye (§4, the sphere is
 * you), so passage was blocked while the camera stood inside the door leaf and
 * looked through it. Backing the grip off by a radius puts the whole body on
 * the side it is actually on.
 *
 * The margin must stay small. `HatchBarrier.blocking()` deliberately lets a body
 * that is not CLOSING on the plane move freely, so the back-off cannot weld
 * anybody to a door; but an over-generous clearance would shove a gripping
 * player backwards along the rail every frame they held the door direction,
 * which reads as the rail rejecting them.
 */
export const GRIP_DOOR_CLEARANCE_M = 0.02;

/** Minimum `|railDir · doorNormal|` for the back-off above to be solvable by
 *  sliding along the rail. A rail running across a doorway rather than through
 *  it cannot be backed off that way, and is left alone. */
export const GRIP_DOOR_AXIS_MIN = 0.1;
/** Metres — a knock needs a handrail within reach, gripped or not (§10). */
export const KNOCK_REACH_M = 1.0;

/** Metres of hysteresis before a floating player is reassigned to the next
 *  module. Stops a body hovering in a hatchway from flipping module ids — and
 *  with them every NoiseEvent's origin module — at frame rate. */
export const MODULE_SWITCH_MARGIN_M = 0.25;

// ---------------------------------------------------------------------------
// Look and comfort (§4 "comfort options ship in M0")
// ---------------------------------------------------------------------------

/** Radians of rotation per pixel of raw mouse movement. */
export const MOUSE_SENSITIVITY = 0.0022;
/** rad/s of roll from the roll keys, in free (roll-lock off) mode. */
export const ROLL_SPEED = 1.6;
/** Pitch limit in roll-lock mode: 89°. Past vertical the fixed horizon flips. */
export const PITCH_LIMIT = (89 * Math.PI) / 180;
/** rad/s of angular velocity that drives the vignette to full strength (§4). */
export const VIGNETTE_MAX_ANGULAR_SPEED = 2.5;
/** Vignette tightens fast… */
export const VIGNETTE_ATTACK_HALFLIFE = 0.08;
/** …and opens slowly, so it does not strobe. */
export const VIGNETTE_RELEASE_HALFLIFE = 0.3;
/** Default vertical FOV in degrees; the comfort slider overrides it. */
export const DEFAULT_FOV_DEGREES = 75;

// ---------------------------------------------------------------------------
// Interaction (§1 "player/ — zero-g controller, camera, interaction raycaster")
// ---------------------------------------------------------------------------

/** Metres the interaction ray reaches. You must be at the panel (§6). */
export const INTERACT_RANGE = 2.5;

/**
 * Metres from the prop's own surface within which the §6 prompt reads "usable"
 * rather than merely "aimed at".
 *
 * `INTERACT_RANGE` is the RAY, and it is generous on purpose so the crosshair
 * lights up as you approach. This is the second half of §6's rule — "you must
 * physically be at the panel, one hand on a rail, back exposed" — and it is what
 * an on-screen `[E]` prompt should be gated on, because a prompt that appears
 * from across a 2.6 m deck teaches the player that they do not have to commit.
 *
 * Measured from the SURFACE, not from the prop's centre, so a big locker and a
 * flat panel both mean the same thing by "at". The swept body now stops a full
 * `PLAYER_RADIUS` clear of both (see `./propBarrier`), so the closest anybody
 * can ever be is 0.30 m — this has to be comfortably above that or the verb
 * would be unreachable.
 */
export const INTERACT_REACH_M = 0.9;

/**
 * Hz at which the interaction ray is re-cast.
 *
 * The ray only drives the "hand" crosshair glyph and `PlayerConfig.onInteract`.
 * The actual interaction in `main.ts` re-picks on the keypress itself, so
 * nothing gameplay-facing depends on this being frame-tight. At 60 fps a
 * per-frame cast was 8% of the CPU frame for a 16-pixel icon; 20 Hz matches the
 * §7 sim tick and is still three samples inside the shortest possible glance.
 *
 * The broad-phase below runs EVERY frame regardless, so walking out of range of
 * every interactable clears the crosshair immediately — the sampling only ever
 * delays the choice BETWEEN nearby candidates.
 */
export const AIM_RAYCAST_HZ = 20;

/**
 * Metres of slack added to each interactable's cached world bounding radius for
 * the interaction ray's broad-phase.
 *
 * The bounds are measured once, with every locker shut. A locker door swings
 * ~100° on opening and sweeps out about its own width, so the cached sphere
 * under-covers an open locker by up to the door width. One metre covers that
 * several times over and still rejects 19 of the station's 22 interactables from
 * any given position — the broad-phase is only there to stop the ray walking
 * lockers and panels in modules the player cannot even see.
 */
export const INTERACT_BOUNDS_SLACK_M = 1.0;

// ---------------------------------------------------------------------------
// Fire extinguisher (§4 "limited-charge thruster… a panic button with a price")
// ---------------------------------------------------------------------------

/** Bursts per round. Discrete, so the HUD can show them and the player can
 *  ration them. Loudness 65 each — LOUDNESS.EXTINGUISHER, from §14. */
export const EXTINGUISHER_CHARGES = 3;
/** m/s of delta-v per burst. Below PUSH_MAX so the extinguisher is a rescue,
 *  never a better push-off — total speed is clamped to PUSH_MAX after a burst. */
export const EXTINGUISHER_DELTA_V = 2.5;

// ---------------------------------------------------------------------------
// Heart rate and breathing (§6 — "core, not optional")
// ---------------------------------------------------------------------------

/** bpm at rest, with the alien nowhere near. */
export const HEART_REST_BPM = 62;
/** bpm with the thing in the room. */
export const HEART_MAX_BPM = 170;
/** Metres at which alien proximity stops contributing at all. */
export const HEART_PROXIMITY_RANGE_M = 30;
/** Metres added to the effective distance per hatch between you and it — being
 *  one module away is calmer than being the same distance down a straight tube. */
export const HEART_HOP_METRES = 8;
/** Half-life of the climb toward the target intensity. Fear arrives quickly… */
export const HEART_ATTACK_HALFLIFE = 1.5;
/** …and leaves slowly. */
export const HEART_DECAY_HALFLIFE = 6;
/** Half-life of the exertion term a push-off, catch or crash injects. */
export const EXERTION_HALFLIFE = 8;
/** Exertion added by a full-charge push-off / a full-speed crash. */
export const EXERTION_PUSH = 0.35;
export const EXERTION_CATCH = 0.3;
export const EXERTION_IMPACT = 0.5;
/** Breaths per minute at rest and at maximum panic. Each breath emits one
 *  `breathing` NoiseEvent at breathingNoise(intensity) — 6 to 14 (§3, §6). */
export const BREATH_RATE_CALM = 12;
export const BREATH_RATE_PANIC = 28;
/** How often `player:heartRate` goes out on the bus, in Hz. The tracker's second
 *  trace does not need it faster (§6). */
export const HEART_EVENT_HZ = 4;
