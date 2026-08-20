/**
 * ISS — shared type definitions.
 *
 * Single source of truth for every structure that crosses the client/server line
 * (DESIGN.md §1 "shared/types/ — schemas used by both sides").
 *
 * This module is TYPE-ONLY at runtime except for a handful of small, frozen
 * lookup tables at the bottom. It imports nothing, so it can never create a
 * circular dependency.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Plain-object 3-vector. Deliberately NOT `THREE.Vector3` — shared/ must stay
 *  renderer-free so the Node server can import it. Convert at the boundary. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Plain-object quaternion, xyzw order (same order three.js uses). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type ModuleId = string;
export type PlayerId = string;
/** Port id, unique within its module. */
export type PortId = string;
/** Rail segment id, unique within its module. */
export type RailSegmentId = string;
/** `${ModuleId}:${RailSegmentId}` — a rail segment id that is unique station-wide. */
export type RailKey = string;
/** Hide-spot id, unique within its module. */
export type HideSpotId = string;
/** `${ModuleId}:${HideSpotId}` — a hide spot id that is unique station-wide. */
export type HideSpotKey = string;
/** An escape system unlocked by a puzzle (DESIGN.md §11 `Puzzle.gates`). */
export type EscapeSystemId = string;

// ---------------------------------------------------------------------------
// §2 — The station graph
// ---------------------------------------------------------------------------

export type ModuleKind = 'straight' | 'node' | 'cupola' | 'airlock' | 'lab';

export type LightingLevel = 'nominal' | 'emergency' | 'dark';

// ---------------------------------------------------------------------------
// Gravity — a PER-MODULE CONDITION, not the global default
// ---------------------------------------------------------------------------
//
// THE PIVOT. DESIGN.md pillar 2 ("Nobody walks") made zero-G the tax on every
// second of play. It is the biggest source of motion sickness, it makes hiding
// impossible, and it collapses the §5 chase loop: a 5 m tube gives a fleeing
// player no corners, and RAIL_SLIDE (1.2) against SPEED_HUNT (3.0) means the
// alien always wins. Measured in playtest: "the monster finds you basically
// instantly and is faster than you."
//
// The replacement: every module has a local floor and players WALK by default.
// Zero-G becomes a per-module CONDITION — a spike of tension in a few authored
// places, plus whatever the §5 escalation director drops mid-round.
//
// ONE GLOBAL DOWN VECTOR for the whole station (`STATION_DOWN` in
// `@shared/constants`). Per-module orientations were considered and rejected:
// they create a reorientation problem at every single hatch and destroy the
// spatial mental model pillar 3 exists to protect.

/**
 * Locomotion regime of one module.
 *
 * - `nominal` — there is a floor along `STATION_DOWN`. The player WALKS
 *   (`GROUNDED` / `AIRBORNE`, §4). Handrails are scenery.
 * - `zero` — no floor. The player FLOATS, GRIPS and pushes off exactly as
 *   DESIGN.md §4 describes. Handrails are the movement grammar.
 */
export type GravityMode = 'nominal' | 'zero';

/**
 * A `GravityMode` filter for a query, plus `'any'` for "do not filter".
 *
 * Rail queries are scoped by this (§2 rails only matter in `zero` modules), but
 * noise propagation and alien pathfinding are NOT — they must keep working
 * across both kinds of module, so they never take a scope.
 */
export type GravityScope = GravityMode | 'any';

/** Why a module's gravity changed. Drives the audio cue and the HUD line. */
export type GravityCause =
  /** The value baked into the level file — the round's starting condition. */
  | 'authored'
  /** The §5 escalation director dropped it as the station comes back to life. */
  | 'director'
  /** A §11 puzzle turned a plant off or on. */
  | 'puzzle'
  /** Collateral: a breaker reset, a hull event, the alien tearing something out. */
  | 'damage'
  /** Back to the authored value. */
  | 'restored';

/**
 * One module's gravity changing, announced BEFORE it takes effect.
 *
 * `inMs` is the fairness guarantee and the reason this is an event rather than
 * a silent state flip: the plant winds down audibly (a `gravity-shift`
 * NoiseEvent at `LOUDNESS.GRAVITY_SHIFT`, emitted at the module centre) and the
 * floor only lets go `GRAVITY_WARNING_S` later. Pillar 3 — the player must be
 * able to build a correct mental model — needs the warning to exist.
 */
export interface GravityShiftEvent {
  module: ModuleId;
  from: GravityMode;
  to: GravityMode;
  cause: GravityCause;
  /** ms from `t` until `to` takes effect. 0 means it already has. */
  inMs: number;
  /** Server tick the shift was announced on (§7, 20 Hz). */
  t: number;
}

/** Networked per-module gravity record (§7 `StationState`). */
export interface ModuleGravitySnapshot {
  module: ModuleId;
  /** The mode IN EFFECT right now. */
  gravity: GravityMode;
  /** An announced change that has not landed yet, or null. */
  pending: GravityMode | null;
  /** ms until `pending` takes effect. 0 when `pending` is null. */
  pendingMs: number;
}

/** Reference to an authored prop instance placed in a module. */
export interface PropRef {
  id: string;
  /** Kit piece / prop archetype name, e.g. 'locker', 'handrail', 'panel'. */
  kind: string;
  /** Position in module space. */
  localPos: Vec3;
  /** Rotation in module space. Omit for identity. */
  localQuat?: Quat;
  /** Uniform scale. Omit for 1. */
  scale?: number;
  /** True if the prop can be raycast-interacted with (§4 interaction raycaster). */
  interactable?: boolean;
}

/** State of the hatch sitting in a port. */
export interface HatchState {
  open: boolean;
  /** Powered lock; blocks the alien, needs a charge to set (§5). Implies closed. */
  sealed: boolean;
  /**
   * Cached dB offset for this hatch: open -3, closed -25, sealed -40 (§14).
   * DENORMALISED CACHE — `hatchAttenuationDb()` in `@shared/graph` recomputes it
   * from `open`/`sealed` and is authoritative. Keep this field in sync with
   * `syncHatchAttenuation()` so authored JSON round-trips cleanly.
   */
  attenuationDb: number;
}

export interface Port {
  id: PortId;
  /** ALSO the audio panner position for cross-module sound (§8). Module space. */
  localPos: Vec3;
  /** Outward normal of the port, module space, unit length. */
  localDir: Vec3;
  link: { module: ModuleId; port: PortId } | null;
  hatch: HatchState;
}

/** A stretch of handrail. Authored once per kit piece; instances with geometry (§2). */
export interface RailSegment {
  id: RailSegmentId;
  /** Endpoints in module space. */
  a: Vec3;
  b: Vec3;
  /** Other segment ids in the SAME module reachable without letting go. */
  connects: RailSegmentId[];
  /** Segment continues through this hatch — port id in the same module. */
  portLink?: PortId;
}

/**
 * Somewhere a body fits and the alien's sweep does not reach: a locker, an
 * equipment bay, a crew bunk.
 *
 * THE ALIEN IS BLIND. There is no sight-based logic anywhere in this type, and
 * none may be added. Hiding buys exactly two things:
 *
 *   1. The alien will not physically sweep through your position. Its contact
 *      test skips an occupant, and its in-module navigation routes around the
 *      volume.
 *   2. `muffleDb` on everything you emit while inside — a shell is a shell.
 *
 * It does NOT buy silence. Panicked breathing (§6, 6–14) still leaves the box
 * and still clears `ATTN_SEARCH` at point-blank; see `HIDE_SAFE_RADIUS_M` for
 * how close the thing has to get. Getting in costs a noise too (`hide-enter`),
 * on §11's loud-fast / quiet-slow rule: dive in and everything in two modules
 * heard you do it.
 */
export interface HideSpot {
  id: HideSpotId;
  kind: HideSpotKind;
  /** Centre of the occupied volume, module space — where the body ends up. */
  localPos: Vec3;
  /** Orientation of the volume in module space. Omit for identity. */
  localQuat?: Quat;
  /**
   * Half-extents of the occupied volume along its OWN axes, metres.
   * This is the box the alien must not sweep through, so it should hug the
   * body: a locker is roughly `{ x: 0.3, y: 0.9, z: 0.3 }`.
   */
  halfExtents: Vec3;
  /** Where you stand (or float) to get in, module space. The interaction prompt
   *  and the alien's route-around both key off this. */
  entryPos: Vec3;
  /** Direction the camera faces while inside, module space. Omit to face
   *  `entryPos` from `localPos`. */
  lookDir?: Vec3;
  /** Bodies that fit. Defaults to `HIDE_SPOT_CAPACITY_DEFAULT` (1). */
  capacity?: number;
  /**
   * Which gravity modes this spot can be entered in. Defaults to `'any'`.
   * An equipment bay you have to stand up into is `'nominal'`; a bunk with
   * restraints is `'any'`; a stowage net you have to float into is `'zero'`.
   */
  usableIn?: GravityScope;
  /** dB the shell takes off the occupant's own noise. NEGATIVE, added like a
   *  hatch offset. Defaults to `HIDE_MUFFLE_DB` (−8). */
  muffleDb?: number;
}

export type HideSpotKind = 'locker' | 'equipment-bay' | 'crew-bunk';

export interface StationModule {
  id: ModuleId;
  kind: ModuleKind;
  transform: { pos: Vec3; quat: Quat };
  ports: Port[];
  /** See §2 — not optional. Both GRIPPING (§4) and alien nav (§5) need it.
   *  Only load-bearing while `gravity` is `'zero'`; scenery otherwise. */
  rails: RailSegment[];
  props: PropRef[];
  lighting: LightingLevel;
  /**
   * Locomotion regime. REQUIRED and authorable in the level JSON — this is the
   * per-module condition the whole pivot turns on. `'nominal'` unless the level
   * says otherwise; a loader normalising raw JSON should default it there
   * (`normalizeModuleGravity()` in `@shared/graph`).
   *
   * MUTABLE AT RUNTIME. `ModuleGraph.setGravity()` writes it in place, exactly
   * the way `Port.hatch` is mutated in place, so every consumer that reads the
   * layout live sees the change with nothing to invalidate.
   */
  gravity: GravityMode;
  /** Lockers, equipment bays, crew bunks. Optional: most modules have none, and
   *  a level authored before hide spots existed still loads. */
  hideSpots?: HideSpot[];
  /** m³, drives reverb selection (§8). */
  volume: number;
}

/** The authored JSON level file (§2 "authoring is then a JSON file"). */
export interface StationLayout {
  id: string;
  name?: string;
  modules: StationModule[];
  /** Module holding the escape vehicle. Never a player spawn (§10). */
  escapeModule: ModuleId;
  /** Module holding the undock finale. Never a player spawn (§10). */
  finaleModule: ModuleId;
}

// ---------------------------------------------------------------------------
// §3 — Noise
// ---------------------------------------------------------------------------

/**
 * Every distinct sound source in the game. Maps 1:1 onto the §3 loudness table
 * plus the puzzle-specific sounds in §11 and the alien's own noise in §5.
 * Audio (§8) keys its sample/bus selection off this.
 */
export type NoiseKind =
  // Movement, zero-G (§3, §4)
  | 'rail-pull'
  | 'push-off'
  | 'catch'
  | 'impact'
  | 'body-collision'
  | 'extinguisher'
  // Movement, under gravity — loudness is gait-scaled, never speed-scaled.
  // One event PER FOOTSTEP (see `StrideMeter`), never a continuous hiss.
  | 'footstep'
  /** Feet meeting the deck. Quiet if you land soft or land crouched; an
   *  uncontrolled arrival falls through to `impactNoise()`. */
  | 'landing'
  // Body (§6)
  | 'breathing'
  | 'voice'
  | 'headset'
  // Hiding
  | 'hide-enter'
  | 'hide-exit'
  /** The alien working a hide spot open. Loud on purpose: everyone else on the
   *  station gets to hear where it is and what it found. */
  | 'hide-breach'
  // Tools & world
  | 'knock'
  | 'tracker-beep'
  | 'cargo-bounce'
  | 'hatch-cycle'
  | 'pry-bar'
  | 'decoy'
  /** A module's gravity plant spinning down or up. Emitted at the module
   *  CENTRE, not at any player — the station made this noise, you did not. */
  | 'gravity-shift'
  // Puzzles (§11)
  | 'breaker'
  | 'breaker-reset'
  | 'hand-pump'
  | 'valve-slow'
  | 'valve-fast'
  | 'keyswitch'
  | 'undock-lever'
  // Alien (§5 — "it makes loud noise while hunting")
  | 'alien';

export interface NoiseEvent {
  kind: NoiseKind;
  /** World-space origin. */
  origin: Vec3;
  module: ModuleId;
  /** 0–100 at source. */
  loudness: number;
  /** Server tick (§7, 20 Hz). */
  t: number;
  actor?: PlayerId;
}

/** Identifies one port anywhere in the station. */
export interface PortRef {
  module: ModuleId;
  port: PortId;
}

/**
 * How a NoiseEvent arrived at one module: the loudest path found to that module.
 * `level` is measured AT `entryPoint` — the loudest point in the module.
 */
export interface ModuleArrival {
  module: ModuleId;
  /** Level at `entryPoint`, i.e. the module's best case. */
  level: number;
  /** Hatches crossed from the origin module. 0 for the origin module itself. */
  hops: number;
  /** Metres travelled from the origin to `entryPoint`. */
  distance: number;
  /** Sum of hatch dB offsets on the path (negative or zero). */
  hatchDb: number;
  /** Most-attenuating single hatch on the path (0 if none crossed). */
  worstHatchDb: number;
  /** The port IN THIS MODULE the sound arrives through. null for the origin module. */
  throughPort: PortRef | null;
  /** World position of `throughPort`, or the event origin for the origin module. */
  entryPoint: Vec3;
  /** Previous module on the loudest path, or null for the origin module. */
  via: ModuleId | null;
}

/**
 * What one listener actually hears. `throughPort` is REQUIRED — §8 pans
 * cross-module sound at the connecting port, not along the source's true bearing.
 */
export interface ListenerResolution {
  /** Arrival level at the listener. May be below FLOOR (then `audible` is false). */
  level: number;
  audible: boolean;
  /** Port in the LISTENER's module the sound arrives through; null if same module. */
  throughPort: PortRef | null;
  /** World position to pan the sound at: the port, or the true origin if same module. */
  panPosition: Vec3;
  /** Total metres travelled, origin → listener. */
  distance: number;
  hops: number;
  /** Sum of hatch dB offsets on the path (≤ 0). */
  hatchDb: number;
  /** Most-attenuating single hatch on the path (≤ 0). Drives the §8 lowpass. */
  worstHatchDb: number;
  /** True if any hatch on the path is closed or sealed → lowpass at 400 Hz (§8). */
  occluded: boolean;
}

// ---------------------------------------------------------------------------
// §4 — Player
// ---------------------------------------------------------------------------

/**
 * Player controller FSM. One machine, two regimes, selected by the gravity of
 * the module the body is in:
 *
 *   gravity: 'nominal'   GROUNDED ⇄ AIRBORNE          (+ HIDDEN)
 *   gravity: 'zero'      FLOATING ⇄ GRIPPING ⇄ CHARGING (+ HIDDEN)
 *
 * The zero-G three are DESIGN.md §4 unchanged — this is a pivot, not a
 * rewrite, and the swept-sphere controller keeps both of its hard-won fixes:
 * `resolveImpact` still captures approach speed from `-preVelocity.dot(normal)`
 * BEFORE restitution, and shut hatches still stop a body on both the sweep path
 * and the rail path.
 *
 * Crossing between regimes is a `LocomotionTransition`, never a teleport.
 */
export type PlayerState =
  /** Zero-G: `pos += vel * dt`, drag as a half-life (§4). */
  | 'FLOATING'
  /** Zero-G: anchored to a rail segment, sliding at RAIL_SLIDE (§4). */
  | 'GRIPPING'
  /** Zero-G: holding Space on a rail, charging a push-off (§4). */
  | 'CHARGING'
  /** Gravity: feet on the deck. Walking, crouching or sprinting. */
  | 'GROUNDED'
  /** Gravity: not touching the deck — jumped, fell, or just arrived. */
  | 'AIRBORNE'
  /** Inside a `HideSpot`, in either regime. No locomotion input is read. */
  | 'HIDDEN';

/**
 * How fast you are moving under gravity, and therefore how loud each footstep
 * is. Three discrete gaits rather than an analogue stick, because pillar 1
 * demands the player can always answer "was that loud?" — and a number they
 * chose is answerable where an axis is not.
 */
export type Gait = 'crouch' | 'walk' | 'sprint';

/**
 * Everything one gait decides. The table lives in `@shared/constants`
 * (`GAIT_PROFILES`); this is its shape.
 *
 * `cadenceHz` and `loudnessPerMetre` are DERIVED (speed / stride and footstep /
 * stride) and stored so nobody recomputes them slightly differently. The
 * constants module asserts they match.
 */
export interface GaitProfile {
  gait: Gait;
  /** m/s over the ground. */
  speed: number;
  /**
   * Metres of travel per footstep. DISTANCE-based, never a timer: noise then
   * scales with how far you actually went, so shuffling in place is free and
   * crossing a module costs the same whether you did it in one burst or ten.
   */
  strideM: number;
  /** Loudness of ONE footstep (§3 table). */
  footstep: number;
  /**
   * m/s of closing speed along `STATION_DOWN` that a landing in this gait
   * absorbs silently. Above it the landing falls through to `impactNoise()`.
   * Crouch absorbs the most — "land in a crouch" is the skill expression that
   * makes the quietest gait worth its speed penalty.
   */
  landingSoftMaxMps: number;
  /** Camera height above the deck while in this gait, metres. */
  eyeHeight: number;
  /** Collider height while in this gait, metres. */
  bodyHeight: number;
  /** DERIVED: `speed / strideM`, footsteps per second at full gait speed. */
  cadenceHz: number;
  /** DERIVED: `footstep / strideM`, loudness per metre of ground covered. */
  loudnessPerMetre: number;
}

/** Networked per-player record (§7 `players:`). */
export interface PlayerSnapshot {
  id: PlayerId;
  pos: Vec3;
  quat: Quat;
  state: PlayerState;
  /** RailKey of the segment being gripped. Only ever set in a `zero` module. */
  gripId: RailKey | null;
  /** Module the player is currently inside — required for noise resolution (§3). */
  module: ModuleId;
  alive: boolean;
  /** 0–1 push-off charge, only meaningful while CHARGING (§4). */
  charge: number;
  /** Drives the breathing loop's 6–14 loudness (§6). Beats per minute. */
  heartRate: number;
  /** Gait selected by the player. Meaningful while GROUNDED or AIRBORNE; it is
   *  still carried in the other states so a `liftoff` knows what you were doing. */
  gait: Gait;
  /** Hide spot being occupied, or null. Non-null implies `state === 'HIDDEN'`. */
  hideSpot: HideSpotKey | null;
}

/**
 * Crossing between the two locomotion regimes. Four kinds, orthogonal on two
 * axes — which way you crossed, and whether you moved or the station did.
 *
 *                       you moved                  the station changed
 *   into zero-G         'launch'                   'liftoff'
 *   into gravity        'settle' → 'landing'       'settle' → 'landing'
 *
 * `settle` is the moment a floating body acquires a floor (it becomes AIRBORNE
 * and starts falling); `landing` is the moment it reaches that floor. They are
 * separate because the noise is on the second one and the time between them is
 * where the player gets to crouch.
 */
export type LocomotionTransitionKind = 'launch' | 'settle' | 'landing' | 'liftoff';

export interface LocomotionTransition {
  kind: LocomotionTransitionKind;
  player: PlayerId;
  module: ModuleId;
  /** Gravity before / after. Equal for `landing` (both `'nominal'`). */
  from: GravityMode;
  to: GravityMode;
  /** World position at the moment of transition. */
  at: Vec3;
  /**
   * Speed the transition happened at, m/s.
   * - `landing`: closing speed along `STATION_DOWN` — the number
   *   `landingNoise()` is a function of.
   * - `launch`: ground speed carried into zero-G, which becomes the FLOATING
   *   velocity. Momentum is conserved; there is no free boost.
   * - `settle` / `liftoff`: current speed, informational.
   */
  speed: number;
  /** Gait held at the moment of transition. */
  gait: Gait;
  /** Loudness emitted, from `transitionNoise()`. 0 means emit NO event at all —
   *  a walking launch and every liftoff are genuinely silent. */
  loudness: number;
  /** Server tick (§7). */
  t: number;
}

/** Client comfort options — ship in M0, not later (§4). */
export interface ComfortOptions {
  /** Fixed horizon; no roll from the controller. */
  rollLock: boolean;
  /** 0 = smooth turning, otherwise degrees per snap. */
  snapTurnDegrees: number;
  fovDegrees: number;
  /** Vignette that tightens with angular velocity. 0 = off, 1 = full. */
  vignetteStrength: number;
  /**
   * Brightness trim on the flashlight, as a multiplier on §14's
   * `FLASHLIGHT_INTENSITY`. 1 = the authored torch; the renderer clamps it to
   * `FLASHLIGHT_SCALE_MIN…MAX`.
   *
   * It sits with the comfort dials rather than in a graphics menu on purpose:
   * §9 makes the station dark and the torch the only thing you steer by, so how
   * bright that beam is decides whether a player can read the room at all. §13
   * calls anything that stops someone playing a risk, and an unreadable frame
   * is exactly that.
   */
  flashlightIntensity: number;
  /**
   * 0 = no head bob at all, 1 = the authored bob. Walking is new (see
   * `GravityMode`) and a bobbing camera is the single most reliable way to make
   * a first-person game nauseating — §13 counts anything that stops someone
   * playing as a risk, and this pivot exists partly to REDUCE motion sickness,
   * so shipping walking without the off switch would trade one cause for
   * another. Amplitude scales `BOB_AMPLITUDE_M`; the footstep NOISE is
   * unaffected, because comfort settings may never change what the alien hears.
   */
  headBob: number;
}

// ---------------------------------------------------------------------------
// §5 — Alien
// ---------------------------------------------------------------------------

/**
 * DORMANT → PATROL → INVESTIGATE → SEARCH → HUNT → ATTACK
 *                        ↑____________|        |
 *                        └── RETREAT ←─────────┘
 */
export type AlienState =
  | 'DORMANT'
  | 'PATROL'
  | 'INVESTIGATE'
  | 'SEARCH'
  | 'HUNT'
  | 'ATTACK'
  | 'RETREAT';

/** Networked alien record (§7 `alien:`). Synced to everyone — anti-cheat is
 *  deliberately skipped, read it through `getAlienForClient(playerId)` (§7). */
export interface AlienSnapshot {
  pos: Vec3;
  quat: Quat;
  state: AlienState;
  module: ModuleId;
}

/** Escalation director stage (§5). */
export type DirectorStage = 0 | 1 | 2 | 3 | 4;

/** One row of the §5 escalation table. */
export interface DirectorStageConfig {
  stage: DirectorStage;
  /** Systems brought online required to reach this stage. */
  systemsRequired: number;
  patrolSpeed: number;
  /** Arrival level PATROL bothers to react to. */
  patrolThreshold: number;
  /** Weight target selection 2:1 toward the biggest player cluster (§5). */
  crowdBias: boolean;
  /** Seconds a SEARCH sweep lasts. */
  searchDuration: number;
  /** Arrival level within HUNT_TRIGGER_RANGE_M that triggers HUNT. */
  huntTrigger: number;
  /**
   * How many modules the director may be holding in `gravity: 'zero'` at this
   * stage ON TOP of the ones the level authored.
   *
   * This is the pivot's escalation lever and it is deliberately small. Zero-G is
   * a spike of tension, not a tax: at stages 0–1 the station is exactly as
   * authored, and even at stage 4 the walkable majority survives (see the
   * `ZERO_G_FRACTION_MAX` sanity check). Dropping a module is announced
   * `GRAVITY_WARNING_S` ahead at `LOUDNESS.GRAVITY_SHIFT`, so it is pressure,
   * never a gotcha.
   */
  gravityFailures: number;
}

/** Networked director record (§7 `director:`). */
export interface DirectorSnapshot {
  stage: DirectorStage;
  systemsOnline: number;
  /** ms until the next free stage (§14 STAGE_TIMEOUT_MS). */
  msToNextFreeStage: number;
}

// ---------------------------------------------------------------------------
// §11 — Puzzles
// ---------------------------------------------------------------------------

export type PuzzleId =
  | 'breaker-sequence'
  | 'coolant-valve'
  | 'cargo-stow'
  | 'fuse-hunt'
  | 'airlock-keyswitch'
  | 'undock-sequence';

export interface Puzzle {
  id: PuzzleId;
  module: ModuleId;
  /** Server-authoritative. Cast to the puzzle's own state type in its handler. */
  state: unknown;
  solved: boolean;
  /** Which escape systems this unlocks. */
  gates: EscapeSystemId[];
}

/** Networked hatch record (§7 `hatches:`). */
export interface HatchSnapshot {
  /** Globally unique: `${ModuleId}:${PortId}`. */
  portId: string;
  open: boolean;
  sealed: boolean;
}

/** Networked puzzle record (§7 `puzzles:`). */
export interface PuzzleSnapshot {
  id: PuzzleId;
  state: unknown;
  solved: boolean;
}

// ---------------------------------------------------------------------------
// §10 — Round outcome
// ---------------------------------------------------------------------------

export type DeathCause = 'alien' | 'impact' | 'vacuum' | 'disconnect';

export interface RoundResult {
  escaped: PlayerId[];
  dead: PlayerId[];
  /** Escaping with three of six is a win (§10). */
  win: boolean;
  durationMs: number;
  finalStage: DirectorStage;
}

// ---------------------------------------------------------------------------
// §7 — Network payloads
// ---------------------------------------------------------------------------

/** Full room state mirror (§7 "Colyseus state (continuous)"). The Colyseus
 *  `Schema` classes live server-side; this is the plain-object view clients
 *  interpolate against. */
export interface StationState {
  players: PlayerSnapshot[];
  alien: AlienSnapshot;
  hatches: HatchSnapshot[];
  puzzles: PuzzleSnapshot[];
  director: DirectorSnapshot;
  /**
   * Per-module gravity, including announced-but-not-yet-landed changes.
   * Continuous state rather than an ephemeral message because a client that
   * joins late, or that missed a `gravity` message, must still know which rooms
   * have a floor — getting that wrong is a player walking into a wall.
   */
  gravity: ModuleGravitySnapshot[];
  /** Server tick this state belongs to. */
  tick: number;
}

/** §7 ephemeral `noise` — broadcast by the server after propagation. */
export interface NoiseMessage {
  pos: Vec3;
  module: ModuleId;
  level: number;
  kind: NoiseKind;
  /** Server tick the event happened on. */
  t: number;
  actor?: PlayerId;
}

/** §7 ephemeral `interact`. */
export interface InteractMessage {
  targetId: string;
  action: string;
  /** Optional payload for the target's own handler (breaker index, valve delta…). */
  value?: number | string | boolean;
}

/** §7 ephemeral `death`. */
export interface DeathMessage {
  playerId: PlayerId;
  cause: DeathCause;
}

/** Client → server, every tick. Clients own their own movement outright (§7);
 *  the server only sanity-checks speed and teleports. */
export interface TransformMessage {
  pos: Vec3;
  quat: Quat;
  state: PlayerState;
  gripId: RailKey | null;
  module: ModuleId;
  /** Gait held this tick. The server needs it to re-derive footstep loudness
   *  and to sanity-check speed against `gaitSpeed(gait)` rather than PUSH_MAX. */
  gait: Gait;
  /** Hide spot occupied, or null. */
  hideSpot: HideSpotKey | null;
  /** Client tick, for the server's speed sanity check. */
  t: number;
}

/** Client → server at 10 Hz (§7). Server converts it into a NoiseEvent. */
export interface VoiceLevelMessage {
  /** Calibrated 0–1 mic level, post-AGC (§7 "calibrate the mic"). */
  level: number;
}

/** Client → server: "I made this sound." The server re-derives loudness from the
 *  §14 tables, so a lying client cannot make itself quiet. */
export interface NoiseIntentMessage {
  kind: NoiseKind;
  pos: Vec3;
  module: ModuleId;
  /** Speed in m/s for `catch` / `impact` / `landing`, which are speed-scaled (§14). */
  speed?: number;
  /** 0–1 for `breathing`, `voice`, `hide-enter` and `hide-exit`. */
  intensity?: number;
  /** Required for `footstep` and `landing` — loudness is a function of gait. */
  gait?: Gait;
  /** True if the emitter was inside a `HideSpot`; the server applies `muffleDb`.
   *  The client cannot be trusted with the subtraction, only with the fact. */
  hidden?: boolean;
}

/** Client → server: cycle or seal a hatch (§5). */
export interface HatchMessage {
  module: ModuleId;
  port: PortId;
  action: 'open' | 'close' | 'seal';
}

/**
 * Client → server: get into or out of a hide spot.
 *
 * `haste` is the §11 loud-fast / quiet-slow dial applied to a movement verb:
 * 0 is `HIDE_ENTER_TIME_SLOW_S` of careful climbing at `HIDE_QUIET`, 1 is
 * `HIDE_ENTER_TIME_FAST_S` of diving at `HIDE_LOUD`. The client owns its own
 * movement (§7), so it says which it did; the server re-derives the loudness.
 */
export interface HideMessage {
  module: ModuleId;
  spot: HideSpotId;
  action: 'enter' | 'exit';
  /** 0–1. */
  haste: number;
}

/** Server → client: the director advanced (§5). */
export interface StageMessage {
  stage: DirectorStage;
  systemsOnline: number;
}

/** Server → client: a puzzle changed (§11). */
export interface PuzzleMessage {
  id: PuzzleId;
  state: unknown;
  solved: boolean;
}

/** Server → client: round is over (§10). */
export interface RoundEndMessage {
  result: RoundResult;
}

/** Typed message table, client → server. Use the keys as Colyseus message names. */
export interface ClientToServerMessages {
  transform: TransformMessage;
  noise: NoiseIntentMessage;
  interact: InteractMessage;
  voiceLevel: VoiceLevelMessage;
  hatch: HatchMessage;
  hide: HideMessage;
}

/** Typed message table, server → client. */
export interface ServerToClientMessages {
  noise: NoiseMessage;
  death: DeathMessage;
  stage: StageMessage;
  puzzle: PuzzleMessage;
  roundEnd: RoundEndMessage;
  /** A module's gravity is changing, announced `inMs` ahead of the fact. */
  gravity: GravityShiftEvent;
}

export type ClientMessageName = keyof ClientToServerMessages;
export type ServerMessageName = keyof ServerToClientMessages;

// ---------------------------------------------------------------------------
// Small runtime helpers (frozen literal arrays, safe to import anywhere)
// ---------------------------------------------------------------------------

export const MODULE_KINDS: readonly ModuleKind[] = Object.freeze([
  'straight',
  'node',
  'cupola',
  'airlock',
  'lab',
] as const);

export const ALIEN_STATES: readonly AlienState[] = Object.freeze([
  'DORMANT',
  'PATROL',
  'INVESTIGATE',
  'SEARCH',
  'HUNT',
  'ATTACK',
  'RETREAT',
] as const);

export const PLAYER_STATES: readonly PlayerState[] = Object.freeze([
  'FLOATING',
  'GRIPPING',
  'CHARGING',
  'GROUNDED',
  'AIRBORNE',
  'HIDDEN',
] as const);

/** The states that only exist in a `gravity: 'zero'` module. */
export const ZERO_G_PLAYER_STATES: readonly PlayerState[] = Object.freeze([
  'FLOATING',
  'GRIPPING',
  'CHARGING',
] as const);

/** The states that only exist in a `gravity: 'nominal'` module. */
export const GRAVITY_PLAYER_STATES: readonly PlayerState[] = Object.freeze([
  'GROUNDED',
  'AIRBORNE',
] as const);

export const GRAVITY_MODES: readonly GravityMode[] = Object.freeze([
  'nominal',
  'zero',
] as const);

/** Ordered quietest → loudest, which is also slowest → fastest. Both orderings
 *  are asserted in `assertConstantsCoherent()`; nothing may break the tie. */
export const GAITS: readonly Gait[] = Object.freeze(['crouch', 'walk', 'sprint'] as const);

export const HIDE_SPOT_KINDS: readonly HideSpotKind[] = Object.freeze([
  'locker',
  'equipment-bay',
  'crew-bunk',
] as const);

export const LOCOMOTION_TRANSITION_KINDS: readonly LocomotionTransitionKind[] = Object.freeze([
  'launch',
  'settle',
  'landing',
  'liftoff',
] as const);

export const PUZZLE_IDS: readonly PuzzleId[] = Object.freeze([
  'breaker-sequence',
  'coolant-valve',
  'cargo-stow',
  'fuse-hunt',
  'airlock-keyswitch',
  'undock-sequence',
] as const);
