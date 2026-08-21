/**
 * The two-mode player controller — DESIGN.md §4, plus §6's heart rate.
 *
 * "Hand-rolled kinematic controller, swept capsule against a BVH of static
 * geometry. Two locomotion regimes, chosen per module by
 * `StationModule.gravity`: `nominal`, where you walk, and `zero`, where you
 * float. Walking is the default and the overwhelming majority of the station."
 *
 * WALKING (`gravity: 'nominal'`) — states GROUNDED | AIRBORNE
 *   Three gaits held on a key, and the table IS the risk system (§0 pillar 2):
 *   crouch 0.75 m/s at loudness 4, walk 1.4 at 12, sprint 2.4 at 30. A footstep
 *   is a DISTANCE, never a timer (§3), so shuffling costs nothing and crossing a
 *   module costs the same however you did it. Crouch is a genuinely smaller
 *   body, not a lower camera. Jump is 0.45 m, which lands you at 2.97 m/s —
 *   above walking's silent tolerance and below crouching's, so jumping is loud
 *   unless you land in a crouch.
 *
 * ZERO-G (`gravity: 'zero'`) — states FLOATING | GRIPPING | CHARGING
 *   Unchanged from r2, in every number and every behaviour. What changed is only
 *   its SCOPE: you meet it two or three times a round instead of continuously,
 *   which is what makes it frightening again (§4).
 *
 *   FLOATING  pos += vel*dt, no gravity, drag as a HALF-LIFE (never a bare
 *             per-frame exponent — §4 calls that out as r1's bug).
 *   GRIPPING  anchored to a rail segment, WASD slides at RAIL_SLIDE along the
 *             rail axis and traverses connected segments via the rail graph.
 *             Look stays free.
 *   CHARGING  hold Grip + Charge; 0→1 over CHARGE_TIME; release for
 *             cameraForward * lerp(PUSH_MIN, PUSH_MAX).
 *
 * HIDDEN — in a locker, an equipment bay or a crew bunk, in either regime (§4).
 *   No locomotion input is read, the body is geometry the alien must route
 *   around, and everything you emit is muffled by the shell. There is no sight
 *   logic here or anywhere: the alien is blind, and hiding does not change that.
 *
 * CROSSING BETWEEN THE TWO — §4's four transitions, and the reason for the
 * pivot. Run into a zero-G module and you LAUNCH, carrying exactly the momentum
 * you had. Float into one with a floor and you SETTLE, then LAND, and the
 * landing is priced on the closing speed. Lose the floor where you stand and you
 * LIFT OFF at 0.6 m/s with about a second to get a hand on a rail.
 *
 * FOUR RULES ARE LOAD-BEARING AND EASY TO BREAK. Two are from the original
 * review pass and two are the pivot's:
 *
 *  1. BUFFERED GRAB. Holding Grip auto-latches the first rail entering
 *     GRAB_RANGE — checked at every collision substep, not once per frame.
 *     Tap-to-grab-on-arrival would give a 133 ms window at PUSH_MAX (§4), which
 *     is a trap, not a skill ceiling.
 *  2. CATCH ≠ CRASH. A clean arrested catch is `catchNoise(speed)` = 8 + 3v; an
 *     uncontrolled impact is `impactNoise(speed)` = 15 + 6v. Conflating them
 *     was r1's bug and it deleted every quiet way to move fast. Both come from
 *     `noiseLoudness()` in @shared/constants — neither formula is retyped here.
 *     `resolveImpact` captures the approach speed from `-preVelocity.dot(normal)`
 *     BEFORE restitution and tangent friction touch the velocity, and nothing in
 *     the walking path may reach into that function.
 *  3. A SHUT HATCH BLOCKS, ON BOTH PATHS, IN BOTH REGIMES. The swept body tests
 *     `HatchBarrier` at every substep (doors are not in the BVH); the rail slide
 *     goes through `RailGraph.slide()`, whose `jointOpen()` check runs FIRST and
 *     is only then narrowed by gravity scope. Re-measure by counting MODULES
 *     CROSSED, never distance travelled — a long slide racks up hundreds of
 *     metres circulating inside one module's own rail loop and reads as a pass.
 *  4. A LANDING IS SAMPLED BEFORE CONTACT RESOLUTION. Same discipline as (2),
 *     same failure mode: a landing sampled after the stop reads 0 m/s and
 *     reports one quiet footstep no matter how far you fell.
 *
 * The controller is client-authoritative (§7): no prediction, no reconciliation.
 * Call `update(dt)` once per RENDERED frame with the frame delta; the local
 * player is never interpolated.
 */

import * as THREE from 'three';
import {
  AIR_CONTROL,
  ATTENUATION_PER_M,
  BOB_AMPLITUDE_M,
  CHARGE_TIME,
  DRAG_HALFLIFE,
  FLOOR,
  GRAB_RANGE,
  GROUND_ACCEL_M_S2,
  GROUND_SNAP_M,
  GROUND_STOP_HALFLIFE_S,
  JUMP_SPEED_M_S,
  PLAYER_RADIUS,
  PUSH_MAX,
  PUSH_MIN,
  RAIL_SLIDE,
  STEP_HEIGHT_M,
  clamp,
  gaitProfile,
  hideEnterSeconds,
  hideNoise,
  noiseLoudness,
} from '@shared/constants';
import type {
  Gait,
  GravityMode,
  HideSpotKey,
  LocomotionTransition,
  LocomotionTransitionKind,
  ModuleId,
  NoiseEvent,
  NoiseKind,
  PlayerId,
  PlayerSnapshot,
  PlayerState,
  TransformMessage,
  Vec3,
} from '@shared/types';
import type { ModuleGraph } from '@shared/graph/moduleGraph';
import type { RailAdvance, RailGraph, RailQuery } from '@shared/graph/railGraph';
import { parseRailKey, railAdvanceBuffer, railQueryBuffer } from '@shared/graph/railGraph';
import type { RailKey } from '@shared/types';
import { v3 } from '@shared/graph/math';
import {
  applyGravity,
  applyTransitionVelocity,
  classifyGravityTransition,
  defaultStateFor,
  downSpeed,
  hasFloor,
  makeTransition,
  type TransitionReason,
} from '@shared/graph/gravity';
import { StrideMeter, emitsFootsteps, gaitFromInput } from '@shared/graph/gait';
import { HideSpotGraph, parseHideSpotKey, type HideVolume } from '@shared/graph/hideSpots';
import { bus } from '../core/eventBus';
import { halfLifeDecay } from '../core/ticker';
import { PlayerCamera } from './camera';
import {
  StationCollider,
  makeRayHit,
  type BodyOffsets,
  type ColliderInput,
  type ContactResult,
  type RayHit,
} from './collision';
import { PlayerComfort, VignetteMeter, type PlayerComfortOptions } from './comfort';
import { Extinguisher } from './extinguisher';
import { HatchBarrier, type HatchBlock } from './hatchBarrier';
import { PropBarrier, makePropContact, type PropContact } from './propBarrier';
import { HeartRate } from './heartRate';
import { HideController, hasteForGait } from './hiding';
import { PlayerInput } from './input';
import {
  AIM_RAYCAST_HZ,
  CONTACT_EPSILON,
  COYOTE_TIME_S,
  EXERTION_CATCH,
  EXERTION_IMPACT,
  EXERTION_PUSH,
  EXTINGUISHER_CHARGES,
  GRIP_DOOR_AXIS_MIN,
  GRIP_DOOR_CLEARANCE_M,
  GRIP_HOLD_DISTANCE,
  GROUND_NORMAL_MIN,
  HEART_EVENT_HZ,
  HIDE_PITCH_LIMIT_DEG,
  HIDE_REACH_M,
  HIDE_YAW_LIMIT_DEG,
  IMPACT_COOLDOWN_S,
  IMPACT_MIN_SPEED,
  INTERACT_BOUNDS_SLACK_M,
  INTERACT_RANGE,
  INTERACT_REACH_M,
  GROUND_LANDING_EPSILON_M,
  JUMP_GROUND_LOCKOUT_S,
  KNOCK_COOLDOWN_S,
  KNOCK_REACH_M,
  LANDING_MIN_SPEED_M_S,
  LIFTOFF_VIGNETTE_PULSE,
  MAX_FRAME_DT,
  MODULE_SWITCH_MARGIN_M,
  PUSH_LATCH_LOCKOUT_S,
  RAIL_HINT_RANGE_FACTOR,
  RAIL_PULL_INTERVAL_M,
  RESTITUTION,
  STAND_UP_CLEARANCE_M,
  STEP_BLOCKED_PROGRESS,
  STEP_DOWN_SLACK_M,
  STEP_FORWARD_MIN_M,
  STEP_RISE_MIN_M,
  STEP_UP_PROGRESS,
  TANGENT_FRICTION,
  WALL_IMPACT_MIN_SPEED,
  WEDGE_DEPTH_M,
} from './tuning';
import type {
  CrosshairState,
  HidePrompt,
  InteractTarget,
  InteractionHit,
  PlayerConfig,
  PlayerSpawn,
} from './types';
import {
  DOWN,
  HeadBob,
  UP,
  ViewLag,
  accelerateDeck,
  capsuleOffsets,
  deckComponent,
  deckDistance,
  eyeHeightFor,
  heightGain,
  makeGroundInfo,
  probeGround,
  type GroundInfo,
} from './walk';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _point = new THREE.Vector3();
const _prevPoint = new THREE.Vector3();
const _step = new THREE.Vector3();
const _preVel = new THREE.Vector3();
/** Scratch for `standUpOnSettle()`'s one downward ray. */
/**
 * Reach beyond the body radius for a brace surface (§4 surface push-off).
 *
 * Deliberately generous — 1.0 m, so 1.3 m from the body centre. A tighter 0.45 m
 * was measured as useless: contact with a bulkhead is elastic (RESTITUTION), so
 * a drifting body touches the wall and is already coasting back out of reach by
 * the time the player reacts. Measured in that state: the surface probe returned
 * false on every frame while the wall sat 0.73-0.9 m away.
 *
 * This is a rescue, not a movement tech. Being unable to move at all is a far
 * worse failure than occasionally pushing off something slightly out of arm's
 * reach, and §4 already prices every push-off the same flat 8 regardless.
 */
const BRACE_REACH_M = 1.0;
/** Axis probe directions for {@link Player.probeBraceSurface}. */
const BRACE_DIRS: readonly THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];
const _braceNormal = new THREE.Vector3();
const _braceHit = makeRayHit();

const _settleHit: RayHit = makeRayHit();
const _tangent = new THREE.Vector3();
const _centre = new THREE.Vector3();
/** Last position the sweep was allowed to occupy, for the hatch-door test. */
const _doorFrom = new THREE.Vector3();
const _doorNormal = new THREE.Vector3();
const _doorProbe = new THREE.Vector3();
const _axis = { x: 0, y: 0 };
const _look = { dx: 0, dy: 0 };
/** Reused for the world-bounds pass that builds the interaction broad-phase. */
const _bounds = new THREE.Box3();
const _sphere = new THREE.Sphere();

// Walking scratch. Same discipline as above: module-level, never re-entrant,
// never held across a frame boundary.
/** Body position at the top of a walking move, for the step-up retry and for
 *  measuring the ground actually covered. */
const _walkStart = new THREE.Vector3();
/** Where the flat (no step-up) attempt ended, so a failed retry can go back. */
const _flatEnd = new THREE.Vector3();
const _lift = new THREE.Vector3();
const _deck = new THREE.Vector3();
const _wedge = new THREE.Vector3();
/** The flat move's contact normal, kept across the step-up retry's own sweeps. */
const _contactNormal = new THREE.Vector3();
const _standProbe = new THREE.Vector3();
const _doorPoint = new THREE.Vector3();
const _doorA = new THREE.Vector3();
const _doorB = new THREE.Vector3();
const _hidePos = new THREE.Vector3();
const _hideQuat = new THREE.Quaternion();
const _hideDir = new THREE.Vector3();
const _transitionAt: Vec3 = { x: 0, y: 0, z: 0 };
/** Capsule offsets for a gait the body is not currently in — the stand-up test. */
const _probeOffsets: [THREE.Vector3, THREE.Vector3] = [
  new THREE.Vector3(),
  new THREE.Vector3(),
];

const HIDE_YAW_LIMIT_RAD = (HIDE_YAW_LIMIT_DEG * Math.PI) / 180;
const HIDE_PITCH_LIMIT_RAD = (HIDE_PITCH_LIMIT_DEG * Math.PI) / 180;

/**
 * One interactable, plus the cheap rejection test the ray needs.
 *
 * Lockers and panels are bolted to bulkheads and never move, so the sphere is
 * measured once per station and reused. A locker DOOR swings, which is what
 * `INTERACT_BOUNDS_SLACK_M` covers.
 */
interface AimCandidate {
  object: THREE.Object3D;
  centre: THREE.Vector3;
  /** Reach at which the object can still be hit: bounds radius + slack + the
   *  ray's own length, pre-squared so the test is a subtract-and-compare. */
  reachSq: number;
}

export class Player {
  readonly id: PlayerId;
  readonly comfort: PlayerComfort;
  readonly input: PlayerInput;
  readonly look: PlayerCamera;
  readonly collider = new StationCollider();
  readonly heart = new HeartRate();
  readonly extinguisher: Extinguisher;

  /** Body centre in world space — also the eye position (§4: the sphere is you). */
  readonly position = new THREE.Vector3();
  /** Metres per second. Meaningful in every state; zero while gripping still. */
  readonly velocity = new THREE.Vector3();

  private readonly config: PlayerConfig;
  private readonly vignetteMeter = new VignetteMeter();
  private readonly raycaster = new THREE.Raycaster();
  private readonly contact: ContactResult = {
    hit: false,
    normal: new THREE.Vector3(),
    depth: 0,
  };
  /** Private to the door response, so it cannot stomp `this.contact` mid-sweep. */
  private readonly doorContact: ContactResult = {
    hit: false,
    normal: new THREE.Vector3(),
    depth: 0,
  };

  private moduleGraph: ModuleGraph | null;
  private railGraph: RailGraph | null;
  /** Lockers, equipment bays and crew bunks (§4). Rebuilt with the layout. */
  private hideSpots: HideSpotGraph | null;
  /** Closed and sealed hatch doors, which the static BVH does not contain. */
  private barrier: HatchBarrier;
  /**
   * Interactable props, which the static BVH does not contain either.
   *
   * Measured from the same list the interaction ray walks (see `./propBarrier`
   * for the numbers this fixes). Rebuilt only when that list is replaced.
   */
  private props: PropBarrier;
  /** Deepest prop contact resolved during the current sweep. Folded into
   *  `contact` once the sweep is over, so the response path is unchanged. */
  private readonly propContact: PropContact = makePropContact();
  private readonly propStep: PropContact = makePropContact();
  /** BVH re-depenetration after a prop push — see `clearProps`. */
  private readonly propBvh: ContactResult = {
    hit: false,
    normal: new THREE.Vector3(),
    depth: 0,
  };
  private interactables: THREE.Object3D[];
  /** Broad-phase index over `interactables`, built lazily and rebuilt whenever
   *  the list is replaced (see `refreshAimCandidates`). */
  private aimIndex: AimCandidate[] = [];
  private aimIndexSource: THREE.Object3D[] | null = null;
  private aimIndexLength = -1;
  /** Scratch the broad-phase fills each frame. Never resized down, so the
   *  raycast argument costs nothing after the first few frames. */
  private readonly aimNear: THREE.Object3D[] = [];
  /** Raycaster output, reused. `Raycaster.intersectObjects` appends to a target
   *  array when it is given one. */
  private readonly aimHits: THREE.Intersection[] = [];
  /** The one `InteractionHit`, refilled per sample and built on the first real
   *  hit. Nothing keeps it across a frame — `onInteract` consumes it. */
  private interactionBuffer: InteractionHit | null = null;
  /** Seconds until the next interaction raycast (§4 aim, sampled at
   *  AIM_RAYCAST_HZ — the crosshair does not need 60 Hz). */
  private aimCooldown = 0;

  private _state: PlayerState = 'FLOATING';
  private _charge = 0;
  private _gripKey: RailKey | null = null;
  private gripT = 0;
  private readonly gripOffset = new THREE.Vector3();
  private slideAccum = 0;
  private latchLockout = 0;

  // -- walking (§4, the pivot) ----------------------------------------------
  /**
   * The regime the body is currently in, cached from `StationModule.gravity`.
   *
   * Cached rather than read live at every use because the frame that DISCOVERS
   * a change is the frame that has to emit the transition for it, and comparing
   * a cached value against the live one is the only way to notice.
   */
  private _gravity: GravityMode;
  /** The module `_gravity` was last sampled in, so a change can be classified
   *  as `crossed` (you moved) or `station` (the floor failed). */
  private gravityModule: ModuleId | null = null;
  private _gait: Gait = 'walk';
  /** Distance-based footsteps (§3). Never a timer. */
  private readonly stride = new StrideMeter('walk', true);
  private readonly ground: GroundInfo = makeGroundInfo();
  /** The two sphere centres of the walking capsule, relative to the eye. */
  private readonly capsule: [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  /** Seconds of jump grace left after walking off a ledge. */
  private coyote = 0;
  /** Seconds the ground snap stays suppressed after a jump. */
  private groundLock = 0;
  private readonly viewLag = new ViewLag();
  private readonly headBob = new HeadBob();
  /** View lag plus head bob, handed to the camera and to nothing else. */
  private readonly viewOffset = new THREE.Vector3();
  /**
   * Offset from the eye to the point the hatch-door test is run at.
   *
   * Zero in `zero` modules, where the body IS the eye. Under gravity the body
   * hangs below the eye, and testing a doorway disc against a point 0.8 m above
   * the tube axis is needlessly close to the aperture's edge; the body centre is
   * within a few centimetres of the axis and is the honest point to ask about.
   */
  private readonly doorOffset = new THREE.Vector3();

  // -- hiding (§4) -----------------------------------------------------------
  private readonly hide = new HideController();
  /** Crouch latch — Ctrl toggles it (see `updateToggles`). */
  private crouchLatched = false;
  private _hidePrompt: HidePrompt | null = null;
  /** Pooled world-space anchor for the hide prompt — the closest point on the
   *  candidate spot's box, written by `nearestSurface` each frame. */
  private readonly hideAnchor: Vec3 = { x: 0, y: 0, z: 0 };
  /** The one `HidePrompt` object, refilled per frame — see `refreshHidePrompt`.
   *  Built on the first frame a spot is actually in reach, so it never has to
   *  hold a placeholder `HideVolume`. */
  private hidePromptBuffer: HidePrompt | null = null;

  private _module: ModuleId = '';
  /** The last module we told the bus about. `spawnAt` writes `_module`
   *  directly, so comparing against `_module` alone silently swallows the
   *  `module:entered` for a spawn — and that event gates the §6 panels, the §8
   *  reverb and the listener's module in the noise runtime. */
  private announcedModule: ModuleId | null = null;
  private _alive = true;
  private _flashlight = false;
  private _trackerMuted = false;
  private _crosshair: CrosshairState = 'dot';
  private _interaction: InteractionHit | null = null;
  /** The §6 interact target, refilled in place — see `refreshInteractTarget`. */
  private _interactTarget: InteractTarget | null = null;
  private readonly targetBuffer: InteractTarget = {
    kind: 'other',
    label: '',
    object: null,
    point: new THREE.Vector3(),
    distance: 0,
    inReach: false,
    usable: false,
    hide: null,
  };
  /** Last shape reported through `onInteractTarget`, for the change edge. */
  private targetSignature = '';
  private _nearestRail: RailQuery | null = null;
  /**
   * Caller-owned result buffers for the rail graph (§2).
   *
   * `RailGraph` allocated a `RailQuery` plus five vectors per candidate per
   * call; these are the reusable answers it writes into instead. They are
   * separate objects on purpose: `railBuffer` is held for a whole frame as
   * `_nearestRail`, `grabBuffer` is filled mid-sweep by the buffered latch, and
   * sharing one would let the latch quietly rewrite the crosshair's rail.
   */
  private readonly railBuffer: RailQuery = railQueryBuffer();
  private readonly grabBuffer: RailQuery = railQueryBuffer();
  private readonly advanceBuffer: RailAdvance = railAdvanceBuffer();
  /** Scratch for the `moduleAt` probe — see `PlayerConfig.moduleAt`. */
  private readonly probePos = v3();
  /** Scratch for `RailGraph.pointAtInto` while gripping without sliding. */
  private readonly probeVec = v3();

  /** The one `TransformMessage`, refilled per tick — see `transformMessage`. */
  private readonly transformBuf: TransformMessage = {
    pos: v3(),
    quat: { x: 0, y: 0, z: 0, w: 1 },
    state: 'FLOATING',
    gripId: null,
    module: '',
    gait: 'walk',
    hideSpot: null,
    t: 0,
  };

  private time = 0;
  private lastImpactAt = -10;
  private lastLandingAt = -10;
  private lastKnockAt = -10;
  private heartEventAt = -10;
  private lastChargeSent = -1;
  private _tick = 0;

  private readonly emitToBus: boolean;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(config: PlayerConfig) {
    this.config = config;
    this.id = config.id ?? 'local';
    this.emitToBus = config.emitToBus ?? true;

    this.comfort =
      config.comfort instanceof PlayerComfort
        ? config.comfort
        : new PlayerComfort((config.comfort ?? {}) as Partial<PlayerComfortOptions>);

    this.input =
      config.input ??
      new PlayerInput({
        domElement: config.domElement,
        camera: config.camera,
        keymap: config.keymap,
        attach: config.autoInput ?? true,
        lockOnClick: config.lockOnClick,
      });

    this.look = new PlayerCamera(config.camera, this.comfort);
    this.extinguisher = new Extinguisher(config.extinguisherCharges ?? EXTINGUISHER_CHARGES);
    this.interactables = config.interactables ?? [];
    this.props = new PropBarrier(this.interactables);

    this.moduleGraph = config.moduleGraph ?? null;
    this.railGraph = config.railGraph ?? null;
    this.hideSpots =
      config.hideSpots ?? (this.moduleGraph ? new HideSpotGraph(this.moduleGraph) : null);
    this.barrier = new HatchBarrier(this.moduleGraph);
    this._gravity = config.defaultGravity ?? 'zero';
    if (config.collider) this.collider.set(config.collider);

    this.raycaster.near = 0;
    this.raycaster.far = INTERACT_RANGE;

    if (config.spawn) this.spawnAt(config.spawn);
    else {
      this.refreshModule(true);
      this.adoptGravity(this.currentGravity());
    }

    if (config.subscribeAlienProximity ?? true) {
      this.unsubscribers.push(
        bus.on('alien:proximity', ({ metres, hops }) => this.heart.setProximity(metres, hops)),
      );
    }
  }

  // =========================================================================
  // Read-only state — the UI, the net layer and the audio layer all read here
  // =========================================================================

  get state(): PlayerState {
    return this._state;
  }

  /** 0–1, only meaningful while CHARGING. The §6 charge arc on the crosshair. */
  get charge(): number {
    return this._charge;
  }

  /** `RailKey` of the held rail, or null. Matches `PlayerSnapshot.gripId`. */
  get gripId(): RailKey | null {
    return this._gripKey;
  }

  get module(): ModuleId {
    return this._module;
  }

  /** The regime under the player's feet right now (§4). */
  get gravityMode(): GravityMode {
    return this._gravity;
  }

  /** True in a module with a floor. The walking half of the controller. */
  get walking(): boolean {
    return hasFloor(this._gravity);
  }

  /** Feet on the deck. False while AIRBORNE, and in every zero-G state. */
  get grounded(): boolean {
    return this._state === 'GROUNDED';
  }

  /** The held gait (§4's risk dial). Carried in every state, so a `liftoff`
   *  knows what you were doing when the floor went. */
  get gait(): Gait {
    return this._gait;
  }

  /** Metres of ground covered toward the next footstep, 0–1. Audio foley. */
  get stridePhase(): number {
    return this.stride.phase;
  }

  /** The hide spot being occupied, or null. Non-null implies `state` is
   *  `HIDDEN`, or a climb in or out of it is in progress. */
  get hideSpot(): HideSpotKey | null {
    return this.hide.key;
  }

  /** 0–1 through the current climb into or out of a spot; 1 while inside. */
  get hideProgress(): number {
    return this.hide.progress;
  }

  /** A hide spot within reach, and what using it would cost right now (§4). */
  get hideCandidate(): HidePrompt | null {
    return this._hidePrompt;
  }

  /** The hide spot graph, once a station has been attached. */
  get hideGraph(): HideSpotGraph | null {
    return this.hideSpots;
  }

  /** Camera offset from the body: head bob plus view lag, metres. Comfort only
   *  — nothing gameplay-facing reads it (§4). */
  get viewShift(): THREE.Vector3 {
    return this.viewOffset;
  }

  get alive(): boolean {
    return this._alive;
  }

  get speed(): number {
    return this.velocity.length();
  }

  /** bpm (§6). */
  get heartRate(): number {
    return this.heart.bpm;
  }

  /** 0–1 vignette for the post pass (§4, §9). */
  get vignette(): number {
    return this.vignetteMeter.value;
  }

  get flashlightOn(): boolean {
    return this._flashlight;
  }

  get trackerMuted(): boolean {
    return this._trackerMuted;
  }

  /** §6 crosshair state. */
  get crosshair(): CrosshairState {
    return this._crosshair;
  }

  /** What the interaction ray is on right now, if anything. */
  get interaction(): InteractionHit | null {
    return this._interaction;
  }

  /**
   * The §6 interact prompt: what `[E]` would do right now, or null.
   *
   * Non-null exactly when `crosshair` is `'hand'` — both are written by the same
   * pass off the same raycast, so a HUD chip and the crosshair glyph cannot
   * disagree and nothing has to cast a second ray to draw one. Bind the key
   * label from `primaryCode(KEYMAP, 'interact')` in `./keymap`.
   *
   * Owned by the controller and refilled in place; read it, never keep it.
   */
  get interactTarget(): InteractTarget | null {
    return this._interactTarget;
  }

  /** Nearest rail within the grab hint range — the "rail" crosshair driver. */
  get nearestRail(): RailQuery | null {
    return this._nearestRail;
  }

  get pointerLocked(): boolean {
    return this.input.locked;
  }

  // =========================================================================
  // Wiring
  // =========================================================================

  /** The station arrived (or was rebuilt). Safe to call at any time. */
  setStation(
    moduleGraph: ModuleGraph | null,
    railGraph: RailGraph | null,
    hideSpots?: HideSpotGraph | null,
  ): void {
    this.moduleGraph = moduleGraph;
    this.railGraph = railGraph;
    // The doorway discs and the hide volumes are geometry, so they are rebuilt
    // with the layout — never on a hatch cycle or a gravity failure, both of
    // which the barrier and the hide graph read live off the module graph.
    this.barrier = new HatchBarrier(moduleGraph);
    this.hideSpots =
      hideSpots ?? this.config.hideSpots ?? (moduleGraph ? new HideSpotGraph(moduleGraph) : null);
    // A spot resolved against the old layout is not a place any more.
    if (this.hide.busy) this.abandonHide();
    if (this._gripKey && !railGraph?.node(this._gripKey)) this.letGo();
    this.refreshModule(true);
    this.adoptGravity(this.currentGravity());
  }

  /** Static collision geometry: a MeshBVH, a Mesh, an Object3D, or an array. */
  setCollider(input: ColliderInput): void {
    this.collider.set(input);
  }

  setInteractables(objects: THREE.Object3D[]): void {
    this.interactables = objects;
    // Force the aim broad-phase to re-measure, even if the caller handed back
    // the same array object with different contents.
    this.aimIndexSource = null;
    // The same list is the collision set for these props (see `./propBarrier`):
    // an interactable is by definition something the player walks up to and
    // presses their face against, and none of them are in the station BVH at
    // the extent they were actually built to.
    this.props.set(objects);
    this.setInteractTarget(null);
  }

  /**
   * Re-measure the interactable props after the station group has moved.
   *
   * Never needed for the shipped level — `Station` keeps its group at the origin
   * (that is a documented invariant of `src/station/station.ts`) — but a caller
   * that assembles the station after handing the list over needs a way to say
   * so, exactly like `StationCollider.refreshTransforms`.
   */
  refreshInteractables(): void {
    this.props.refresh();
  }

  /** Alien proximity for the heart-rate model (§6). Also arrives automatically
   *  from the bus's `alien:proximity` unless that was disabled. */
  setAlienProximity(metres: number, hops = -1): void {
    this.heart.setProximity(metres, hops);
  }

  lockPointer(): void {
    this.input.lock();
  }

  unlockPointer(): void {
    this.input.unlock();
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    if (!this.config.input) this.input.dispose();
  }

  // =========================================================================
  // Placement
  // =========================================================================

  /** Drop the player somewhere (§10 random spawns). Clears velocity and grip. */
  spawnAt(spawn: PlayerSpawn): void {
    if (spawn.pos) this.position.set(spawn.pos.x, spawn.pos.y, spawn.pos.z);
    this.velocity.set(0, 0, 0);
    this._gripKey = null;
    this._charge = 0;
    this.latchLockout = 0;
    this.heart.reset();
    this.hide.clear();
    this._hidePrompt = null;
    this.stride.reset(true);
    this.viewLag.reset();
    this.headBob.reset();
    this.viewOffset.set(0, 0, 0);
    this.coyote = 0;
    this.groundLock = 0;
    if (spawn.module) this._module = spawn.module;
    if (spawn.lookAt) {
      _fwd.set(spawn.lookAt.x, spawn.lookAt.y, spawn.lookAt.z).sub(this.position);
      this.look.lookAlong(_fwd);
    }
    this.refreshModule(true);
    // You wake up in whatever the module is: on a deck, or drifting. §10 spawns
    // are random, and one of §2's authored zero-G modules is a legal roll.
    this.adoptGravity(this.currentGravity());
    this._state = defaultStateFor(this._gravity);
    // A spawn point is authored, or picked by the server, and neither of them
    // knows where the lockers are. Nothing else in the frame will move a body
    // that arrives inside one, because the sweep only resolves what it touches
    // on the way — so resolve it here, once, at the moment of arrival.
    if (this.collider.ready) {
      this.collider.depenetrate(this.position, PLAYER_RADIUS, this.contact, this.bodyOffsets());
    }
    this.clearProps(this.position);
    this.look.apply(this.position, this.viewOffset);
  }

  /** Hard set of position, e.g. a server anti-cheat correction (§7). */
  teleport(pos: Vec3, module?: ModuleId): void {
    this.spawnAt({ pos, module });
  }

  /** External velocity change — a decoy blast, a bumped teammate, a net fixup. */
  applyImpulse(delta: Vec3): void {
    if (this._state !== 'FLOATING') this.letGo();
    this.velocity.x += delta.x;
    this.velocity.y += delta.y;
    this.velocity.z += delta.z;
  }

  /** Death (§10). The body keeps drifting; input stops. */
  setAlive(alive: boolean): void {
    if (this._alive === alive) return;
    this._alive = alive;
    if (!alive) {
      this.letGo();
      this._charge = 0;
      // A corpse must not hold a hide spot for the rest of the round — it would
      // deny a living player the one verb §4 added, and `HIDE_SPOTS_MIN` is six.
      if (this.hide.busy) this.abandonHide();
    } else {
      this.heart.reset();
    }
  }

  // =========================================================================
  // The loop
  // =========================================================================

  /**
   * One frame. `dt` is seconds — pass the real frame delta (§7: the local player
   * is client-authoritative and never interpolated, so this runs at display
   * rate, not at the 20 Hz sim tick).
   *
   * `tick` is the server tick stamped onto NoiseEvents; omit it and the
   * `tickProvider` from the config, or an internal counter, supplies one.
   */
  update(dt: number, tick?: number): void {
    const step = clamp(dt, 0, MAX_FRAME_DT);
    this.time += step;
    this._tick = tick ?? this.config.tickProvider?.() ?? this._tick + 1;
    if (this.latchLockout > 0) this.latchLockout = Math.max(0, this.latchLockout - step);

    // 1. Look first, so a push-off released this frame leaves along the
    //    direction the player is actually pointing.
    this.input.consumeLook(_look);
    this.look.update(
      step,
      _look.dx,
      _look.dy,
      this.comfort.rollLock ? 0 : this.input.rollAxis(),
      this.input.consumeSnapSteps(),
    );

    if (this._alive) {
      this.updateToggles();
      this.updateMovement(step);
    } else {
      this.updateDrift(step);
    }

    // 2. Where am I, and does this room have a floor?
    //
    //    In that order, and after the move: the module you are in is a function
    //    of where the move put you, and the regime is a function of the module.
    //    A crossing therefore takes effect on the frame after the body actually
    //    entered — 16 ms of walking inside a zero-G module, which is invisible,
    //    and momentum is conserved across the transition anyway (§4), so the
    //    launch that follows is identical either way.
    this.refreshModule(false);
    this.syncGravity();

    // 3. Heart rate and the breathing loop (§6) — even the dead breathe until
    //    the round ends, but a corpse does not, so gate on alive.
    if (this.heart.update(step) && this._alive) {
      this.emit('breathing', { intensity: this.heart.intensity });
    }
    if (this.emitToBus && this.time - this.heartEventAt >= 1 / HEART_EVENT_HZ) {
      this.heartEventAt = this.time;
      bus.emit('player:heartRate', { bpm: this.heart.bpm, intensity: this.heart.intensity });
    }

    // 4. Present. The camera is allowed to trail the body (`ViewLag`) and to
    //    bob (`HeadBob`); nothing else in the game reads either, which is what
    //    keeps a comfort dial from changing what the alien hears (§4).
    this.updateAimAndCrosshair(step);
    this.updateViewOffset(step);
    this.vignetteMeter.update(step, this.look.angularSpeed, this.comfort);
    this.look.apply(this.position, this.viewOffset);

    this.input.endFrame();
  }

  // =========================================================================
  // Movement
  // =========================================================================

  /**
   * Dispatch on the regime, not on the state.
   *
   * The state is downstream of the regime — `GROUNDED` cannot exist in a module
   * with no floor and `GRIPPING` cannot exist in one with a deck — and
   * `syncGravity()` has already reconciled the two by the time this runs. Going
   * the other way round is how a body ends up walking on air because it was
   * still `GROUNDED` when the plant failed.
   */
  private updateMovement(dt: number): void {
    if (this.hide.busy) {
      this.updateHiding(dt);
      return;
    }
    if (hasFloor(this._gravity)) {
      this.updateWalking(dt);
      return;
    }

    const gripHeld = this.input.isDown('grip');
    switch (this._state) {
      case 'GRIPPING':
      case 'CHARGING':
        this.updateAnchored(dt, gripHeld);
        break;
      case 'FLOATING':
      default:
        this.updateFloating(dt, gripHeld);
        break;
    }
  }

  // =========================================================================
  // Walking — DESIGN.md §4's default regime
  // =========================================================================

  /**
   * One walking frame.
   *
   * The order is the whole design and none of it is arbitrary:
   *
   *   1. gait, which may resize the body and therefore move the eye
   *   2. wish direction, on the deck plane, camera-relative
   *   3. jump, then acceleration, then gravity
   *   4. `preVelocity` captured HERE — before any contact resolution, because
   *      that is the number `landingNoise()` is a function of (§4)
   *   5. the swept capsule, door-aware at every substep
   *   6. the step-up retry, if a wall stopped a move that should have been legal
   *   7. the ground probe: land, snap, or stay airborne
   *   8. footsteps, from the ground actually covered
   */
  private updateWalking(dt: number): void {
    const gait = this.resolveGait();
    const profile = gaitProfile(gait);
    const eyeHeight = eyeHeightFor(gait);
    capsuleOffsets(gait, this.capsule);
    // The door test asks about the body's middle, not its eye — see the field.
    this.doorOffset.copy(UP).multiplyScalar(profile.bodyHeight * 0.5 - eyeHeight);

    // 2. Wish direction, projected onto the deck. Looking at your feet must not
    //    slow you down, so the camera forward is flattened rather than used raw.
    this.input.axis(_axis);
    _wish.set(0, 0, 0);
    if (_axis.x !== 0 || _axis.y !== 0) {
      this.look.right(_right);
      this.look.forward(_fwd);
      _wish.addScaledVector(_right, _axis.x).addScaledVector(_fwd, _axis.y);
      deckComponent(_wish, _wish);
      if (_wish.lengthSq() > 1e-9) _wish.normalize();
      else _wish.set(0, 0, 0);
    }

    // Nothing to stand on yet. §4's collider is "ready once there is anything
    // to collide with"; before that the station is still streaming in, and a
    // body that fell out of the world while it did would be a worse bug than a
    // body that walked on nothing for a second. It still respects shut hatches:
    // the barrier is analytic and needs no geometry at all.
    const noGeometry = !this.collider.ready;

    // 3. Jump, then acceleration, then gravity.
    const grounded = this._state === 'GROUNDED';
    if (this.groundLock > 0) this.groundLock = Math.max(0, this.groundLock - dt);
    let jumped = false;
    if (
      !noGeometry &&
      (grounded || this.coyote > 0) &&
      this.groundLock <= 0 &&
      this.input.pressed('jump')
    ) {
      jumped = this.launchJump();
    }

    if (noGeometry) this.setState('GROUNDED');
    if (noGeometry || (grounded && !jumped)) {
      // Glue: any residual fall is spent, so the ground SNAP is what carries the
      // body down a lip rather than a growing downward velocity.
      applyTransitionVelocity('landing', this.velocity);
      accelerateDeck(
        this.velocity,
        _wish,
        profile.speed,
        GROUND_ACCEL_M_S2,
        dt,
        GROUND_STOP_HALFLIFE_S,
      );
    } else {
      // §14 AIR_CONTROL: you may steer a jump, you may not accelerate out of a
      // fall — hence the reduced authority and the `null` (no braking) decay.
      accelerateDeck(this.velocity, _wish, profile.speed, GROUND_ACCEL_M_S2 * AIR_CONTROL, dt, null);
      applyGravity(this.velocity, dt);
    }

    // 4. THE CAPTURE. Everything below may arrest this velocity; the loudness
    //    of a landing is a function of what it was before that happened.
    _preVel.copy(this.velocity);
    _walkStart.copy(this.position);
    _step.copy(this.velocity).multiplyScalar(dt);
    deckComponent(_step, _deck);
    const wanted = _deck.length();

    // 5 + 6. Move, and retry over a coaming if a wall ate the move.
    const stoppedByDoor = this.sweepBody(_step);
    if (!stoppedByDoor && !noGeometry) {
      // Sampled before the step-up retry, whose own sweeps overwrite `contact`.
      const wedged = this._state === 'GROUNDED' && this.contact.depth > WEDGE_DEPTH_M;
      _contactNormal.copy(this.contact.normal);
      const hadContact = this.contact.hit;
      const achieved = deckDistance(this.position, _walkStart);
      if (
        this._state === 'GROUNDED' &&
        wanted > 1e-4 &&
        achieved < wanted * STEP_UP_PROGRESS
      ) {
        this.tryStepUp(_deck, achieved, eyeHeight);
      }
      if (hadContact) this.resolveContact(_preVel, _contactNormal);
      // You do not fit here. See `WEDGE_DEPTH_M`: give back the ground, keep the
      // height, and let the player work out that they have to crouch.
      if (wedged) {
        _wedge.subVectors(_walkStart, this.position);
        deckComponent(_wedge, _wedge);
        this.position.add(_wedge);
        deckComponent(this.velocity, _wedge);
        this.velocity.sub(_wedge);
      }
    }

    // 7. Where is the deck now?
    if (!noGeometry) this.settleOnGround(dt, gait);

    // 8. Footsteps, from ground ACTUALLY covered — a body that walked into a
    //    bulkhead went nowhere and pays nothing (§3).
    this.advanceStride(deckDistance(this.position, _walkStart), gait);

    // The camera keeps still through every vertical correction the frame made:
    // total rise, minus the rise the velocity actually asked for.
    this.viewLag.bodyMovedUp(heightGain(this.position, _walkStart) - _step.dot(UP));
  }

  /** §14 JUMP_HEIGHT_M 0.45 → `sqrt(2gh)` = 2.97 m/s on landing, which is above
   *  walking's silent tolerance and below crouching's. That is the whole jump. */
  private launchJump(): boolean {
    const along = this.velocity.dot(DOWN);
    this.velocity.addScaledVector(DOWN, -(along + JUMP_SPEED_M_S));
    this.coyote = 0;
    this.groundLock = JUMP_GROUND_LOCKOUT_S;
    this.setState('AIRBORNE');
    this.stride.reset(true);
    return true;
  }

  /**
   * The ground probe, the landing, and the snap.
   *
   * A landing is emitted from `_preVel`, captured before the sweep — §4 is
   * explicit that sampling after the stop reads 0 m/s and reports one quiet
   * footstep no matter how far you fell.
   */
  private settleOnGround(dt: number, gait: Gait): void {
    const eyeHeight = eyeHeightFor(gait);
    probeGround(this.collider, this.position, eyeHeight, this.ground);
    const wasGrounded = this._state === 'GROUNDED';
    // Two different questions, two different ranges. A body already on its feet
    // asks "is the deck still under me" and gets `GROUND_PROBE_M` of tolerance
    // so it stays glued over a lip. A FALLING body asks "have I arrived", and
    // must be answered at the deck itself — see `GROUND_LANDING_EPSILON_M`.
    const range = wasGrounded ? Number.POSITIVE_INFINITY : GROUND_LANDING_EPSILON_M;
    const canGround = this.ground.grounded && this.ground.gap <= range && this.groundLock <= 0;

    if (!canGround) {
      if (wasGrounded) {
        // Walked off something. Coyote time starts now, and the stride meter
        // stops: an airborne body covers ground silently (§4).
        this.coyote = COYOTE_TIME_S;
        this.stride.reset(true);
      } else if (this.coyote > 0) {
        this.coyote = Math.max(0, this.coyote - dt);
      }
      this.setState('AIRBORNE');
      return;
    }

    // Glue the feet to the deck over a lip or a ramp. GROUND_SNAP_M >=
    // GROUND_PROBE_M by §14, so anything the probe found is snappable.
    const gap = this.ground.gap;
    if (gap > 0 && gap <= GROUND_SNAP_M) this.position.addScaledVector(DOWN, gap);

    if (!wasGrounded) {
      const speed = Math.max(0, downSpeed(_preVel));
      if (speed >= LANDING_MIN_SPEED_M_S && this.time - this.lastLandingAt >= IMPACT_COOLDOWN_S) {
        this.lastLandingAt = this.time;
        this.emitTransition('landing', this._gravity, this._gravity, speed, gait);
        this.heart.addExertion(EXERTION_IMPACT * clamp(speed / PUSH_MAX, 0, 1));
      }
      this.stride.reset(true);
    }
    // Keep the ground speed, drop the fall (§4: land mid-stride and keep going).
    applyTransitionVelocity('landing', this.velocity);
    this.coyote = COYOTE_TIME_S;
    this.setState('GROUNDED');
  }

  /**
   * Retry a blocked ground move by lifting the body a step height first.
   *
   * §14 `STEP_HEIGHT_M` 0.4: you walk over racks, cable runs and hatch coamings
   * without a jump input. The retry is only attempted when the flat move was
   * actually stopped, so the cost is three extra sweeps in the frames where a
   * player is pressed against something and none at all otherwise.
   */
  private tryStepUp(deckDelta: THREE.Vector3, flatAchieved: number, eyeHeight: number): void {
    const wanted = deckDelta.length();
    if (wanted < 1e-6) return;
    _flatEnd.copy(this.position);
    this.position.copy(_walkStart);

    // Up…
    _lift.copy(UP).multiplyScalar(STEP_HEIGHT_M);
    if (this.sweepBody(_lift)) {
      this.position.copy(_flatEnd);
      return;
    }
    const lifted = heightGain(this.position, _walkStart);
    // …over. Far enough that the body ends up standing ON the ledge rather
    // than balanced against its edge (see `STEP_FORWARD_MIN_M`).
    _lift.copy(deckDelta).multiplyScalar(Math.max(wanted, STEP_FORWARD_MIN_M) / wanted);
    if (this.sweepBody(_lift)) {
      this.position.copy(_flatEnd);
      return;
    }

    // …and down, by RAY rather than by sweep. The sweep substeps at half a
    // radius, and a sphere descending onto a ledge in 15 cm bites is resolved
    // out sideways by the ledge's FACE — it never lands on the top at all. The
    // ray answers the same question exactly, and the ledge is the only thing it
    // can hit inside the step height.
    probeGround(this.collider, this.position, eyeHeight, this.ground);
    if (!this.ground.grounded || this.ground.gap > lifted + STEP_DOWN_SLACK_M) {
      this.position.copy(_flatEnd);
      return;
    }
    if (this.ground.gap > 0) this.position.addScaledVector(DOWN, this.ground.gap);

    // Refuse a step that would leave the body inside something — a bulkhead or
    // a prop; a step-up onto a locker is exactly the case the BVH cannot see.
    if (!this.bodyFits(this.position, this.capsule, STAND_UP_CLEARANCE_M)) {
      this.position.copy(_flatEnd);
      return;
    }
    // Only keep it if it actually bought ground. A body that got lifted, went
    // nowhere and came back down would otherwise hop against every wall.
    const gained = deckDistance(this.position, _walkStart);
    if (gained <= flatAchieved + 1e-4) {
      this.position.copy(_flatEnd);
      return;
    }

    // …and only if it EARNED the lurch. `STEP_FORWARD_MIN_M` (0.42 m) exists to
    // put a body on top of a ledge instead of balanced against its edge, which
    // means it is a whole frame's travel handed out in one go — five walking
    // frames' worth, twenty at the substep the sweep runs at. That is correct
    // when something was climbed and free distance when nothing was.
    //
    // MEASURED before this test existed (escape-soyuz, two 1.15 m deck banks a
    // shoulder off the walking line): a walk ran 1.72 m/s against SPEED_WALK
    // 1.4, and a sprint held against the rack wall chained 23 lurches in 1.5 s
    // for a sustained 5.22 m/s — over SPEED_HUNT 3.0. §4's whole gravity chase
    // is "sprint 2.4 < hunt 3.0, so escape needs geometry"; a controller that
    // pays 0.42 m per graze hands the player a way to out-run the hunt by
    // scraping a wall, which is the old game with extra steps.
    //
    // So a rise-less step is allowed only out of a genuine stop — the "vault a
    // coaming" case §14's STEP_HEIGHT_M is for — never as a bonus for sliding
    // along something.
    if (
      heightGain(this.position, _walkStart) <= STEP_RISE_MIN_M &&
      flatAchieved > wanted * STEP_BLOCKED_PROGRESS
    ) {
      this.position.copy(_flatEnd);
    }
  }

  /**
   * The walking sweep: the same substepped swept body as zero-G, with the
   * capsule offsets and the same per-substep hatch-door test.
   *
   * Shut hatches are NOT in the static BVH (see `./hatchBarrier`), so they have
   * to be tested here, against the last position the sweep was allowed to
   * occupy — otherwise a sprinting body steps straight over a 0.1 m door. This
   * is one half of the block §4 requires; `RailGraph.slide()` is the other.
   *
   * Returns true if a door stopped the move.
   */
  private sweepBody(delta: THREE.Vector3): boolean {
    _doorFrom.copy(this.position);
    let stopped = false;
    this.beginPropSweep();
    this.collider.sweep(
      this.position,
      delta,
      PLAYER_RADIUS,
      (center) => {
        // Interactable props are not in the BVH either — resolved per substep,
        // for the same reason the door is (see `./propBarrier`). BEFORE the
        // door test, never after: a prop push is up to a body radius long, so
        // the door has to see the position the substep actually ended at or a
        // locker beside a hatchway becomes a way through a sealed one.
        this.clearProps(center);
        _doorA.copy(_doorFrom).add(this.doorOffset);
        _doorB.copy(center).add(this.doorOffset);
        const door = this.barrier.blocking(_doorA, _doorB, PLAYER_RADIUS);
        if (door) {
          this.resolveDoorStop(door, _doorFrom, _preVel);
          stopped = true;
          return true;
        }
        _doorFrom.copy(center);
        return false;
      },
      this.contact,
      this.capsule,
    );
    this.foldPropContact();
    return stopped;
  }

  /** Feed the stride meter and turn what it fires into `footstep` events. */
  private advanceStride(metres: number, gait: Gait): void {
    this.stride.setGait(gait);
    if (!emitsFootsteps(this._state)) return;
    const steps = this.stride.advance(metres);
    for (let i = 0; i < steps; i++) this.emit('footstep', { gait });
  }

  /**
   * Resolve the held gait, and resize the body if it changed.
   *
   * Crouch beats sprint (§14): a panicking player mashing both gets the quiet
   * one. Standing back up is REFUSABLE — that is what makes crouch genuinely
   * useful for getting under things rather than a camera trick — and the feet
   * stay planted through the change, so only the eye moves.
   */
  private resolveGait(): Gait {
    const want = gaitFromInput(this.crouchLatched, this.input.isDown('sprint'));
    if (want === this._gait) return this._gait;

    const from = eyeHeightFor(this._gait);
    const to = eyeHeightFor(want);
    if (to > from && !this.canResize(want, to - from)) return this._gait;

    if (to !== from && hasFloor(this._gravity) && !this.hide.busy) {
      this.position.addScaledVector(UP, to - from);
      this.viewLag.bodyMovedUp(to - from);
    }
    this._gait = want;
    this.config.onGait?.(want);
    return want;
  }

  /** Is there room for the body this gait would need? */
  private canResize(gait: Gait, riseMetres: number): boolean {
    if (!this.collider.ready || !hasFloor(this._gravity)) return true;
    _standProbe.copy(this.position).addScaledVector(UP, riseMetres);
    capsuleOffsets(gait, _probeOffsets);
    // Props as well as station geometry: standing up inside a locker you had
    // crouched under is the same refusal, and only one of the two is in the BVH.
    return this.bodyFits(_standProbe, _probeOffsets, STAND_UP_CLEARANCE_M);
  }

  /** §4 FLOATING: `pos += vel * dt`, no gravity, drag as a half-life. */
  private updateFloating(dt: number, gripHeld: boolean): void {
    // Air drag: vel *= 0.5^(dt / DRAG_HALFLIFE). NEVER a bare exponent.
    this.velocity.multiplyScalar(halfLifeDecay(dt, DRAG_HALFLIFE));

    this.fireExtinguisherIfRequested();

    _preVel.copy(this.velocity);
    _step.copy(this.velocity).multiplyScalar(dt);

    const canLatch = gripHeld && this.railGraph !== null && this.latchLockout <= 0;
    let latched = false;
    let stoppedByDoor = false;

    // Hatch doors are not in the BVH (see `./hatchBarrier`), so the sweep tests
    // them itself, per substep, against the last position it was allowed to
    // occupy — otherwise a 6 m/s body steps straight over a 0.1 m door.
    _doorFrom.copy(this.position);
    this.beginPropSweep();

    this.collider.sweep(
      this.position,
      _step,
      PLAYER_RADIUS,
      (center) => {
        // Props before the door, same substep, same reason as the walking sweep.
        this.clearProps(center);
        const door = this.barrier.blocking(_doorFrom, center, PLAYER_RADIUS);
        if (door) {
          this.resolveDoorStop(door, _doorFrom, _preVel);
          stoppedByDoor = true;
          return true;
        }
        _doorFrom.copy(center);
        if (!canLatch) return false;
        const candidate = this.grabCandidate(center);
        if (!candidate) return false;
        this.latch(candidate, _preVel.length());
        latched = true;
        return true; // stop the sweep the instant the hand closes
      },
      this.contact,
    );

    this.foldPropContact();
    if (latched || stoppedByDoor) return;
    if (this.contact.hit) this.resolveImpact(_preVel, this.contact.normal);

    // A surface you are touching is something to push off. Without this the only
    // way out of a drift is a rail: a player who crossed into a zero-G module,
    // missed the grab and coasted into a wall had NO input that moved them —
    // reported as "i fell and then was stuck on the floor". The fire
    // extinguisher (§4) is the authored rescue and it is bound and working, but
    // three charges behind a key nobody has pressed yet is not an answer to
    // being stranded by ordinary movement.
    //
    // This is also just how bodies work in zero-G: astronauts push off walls far
    // more than they haul on rails. §4's push-off numbers are unchanged — same
    // charge time, same PUSH_MIN..PUSH_MAX, same flat loudness 8 — the only new
    // thing is that a bulkhead counts as something to push against.
    this.updateSurfacePush(dt);
  }

  /**
   * Charge a push-off against whatever the body is resting on (zero-G only).
   *
   * Entered from FLOATING while in contact, so it cannot interfere with the rail
   * path: `updateAnchored` owns CHARGING when a grip is held, and this only runs
   * when there is no grip at all. The launch direction is where you are looking,
   * hemisphere-clamped to the contact normal so you cannot push yourself further
   * into the wall you are pressed against.
   */
  private updateSurfacePush(dt: number): void {
    const touching = this.probeBraceSurface(_braceNormal);
    if (this._state === 'CHARGING' && this._gripKey === null) {
      this._charge = clamp(this._charge + dt / CHARGE_TIME, 0, 1);
      this.publishCharge();
      // Drifting off the surface mid-charge cancels it — you have nothing left
      // to push against. Releasing fires.
      if (!this.input.isDown('charge') || !touching) {
        if (touching) this.pushOffFrom(_braceNormal);
        else {
          this._charge = 0;
          this.setState('FLOATING');
          this.publishCharge();
        }
      }
      return;
    }
    if (this._state === 'FLOATING' && touching && this.input.isDown('charge')) {
      this.setState('CHARGING');
      this._charge = 0;
    }
  }

  /**
   * Is there a surface within arm's reach to brace against, and which way does
   * it face? Writes the outward normal into `out`.
   *
   * A PROBE, not `this.contact`. `contact` only reports a hit when the swept
   * body actually collides during motion, so a player already at rest against a
   * bulkhead has no contact at all — which is precisely the stranded case this
   * exists to rescue, and is why the first version of this fix did nothing.
   * Measured on the reported situation: state FLOATING, speed 0.47 m/s,
   * `contact.hit === false`.
   *
   * Six axis rays, only while the charge key is held, so the cost is nil.
   */
  private probeBraceSurface(out: THREE.Vector3): boolean {
    const collider = this.collider;
    if (!collider?.ready) return false;
    const reach = PLAYER_RADIUS + BRACE_REACH_M;
    let best = Infinity;
    let found = false;
    for (const dir of BRACE_DIRS) {
      const hit = collider.raycast(this.position, dir, reach, _braceHit);
      if (!hit.hit || hit.distance >= best) continue;
      best = hit.distance;
      // Face the normal back toward the body: a double-sided hit can report
      // either winding, and "away from the wall" is the only useful answer.
      out.copy(hit.normal);
      if (out.dot(dir) > 0) out.negate();
      found = true;
    }
    return found;
  }

  /** `pushOff` with the launch direction clamped out of a surface. */
  private pushOffFrom(normal: THREE.Vector3): void {
    this.look.forward(_fwd);
    // Looking into the wall would otherwise launch you into it. Reflect the
    // inward component out along the normal so "push" always means "away".
    const into = _fwd.dot(normal);
    if (into < 0) _fwd.addScaledVector(normal, -into * 2);
    if (_fwd.lengthSq() > 1e-9) _fwd.normalize();
    else _fwd.copy(normal);
    const charge = this._charge;
    const speed = PUSH_MIN + (PUSH_MAX - PUSH_MIN) * charge;
    this.velocity.copy(_fwd).multiplyScalar(speed);
    this._charge = 0;
    this.slideAccum = 0;
    this.latchLockout = PUSH_LATCH_LOCKOUT_S;
    this.setState('FLOATING');
    this.publishCharge();
    this.emit('push-off');
    this.heart.addExertion(EXERTION_PUSH * (0.4 + 0.6 * charge));
  }

  // =========================================================================
  // Crossing between the regimes — §4's four transitions
  // =========================================================================

  /** The regime the module the body is in declares, live off the layout. */
  private currentGravity(): GravityMode {
    const graph = this.moduleGraph;
    if (!graph || !this._module || !graph.has(this._module)) {
      return this.config.defaultGravity ?? 'zero';
    }
    // `StationModule.gravity` is mutated in place by `ModuleGraph.setGravity()`,
    // exactly the way `Port.hatch` is, so there is nothing to invalidate and no
    // subscription to keep alive — reading it is always current.
    return graph.gravityOf(this._module);
  }

  /** Take a regime without producing a transition. Spawns and layout swaps. */
  private adoptGravity(mode: GravityMode): void {
    this._gravity = mode;
    this.gravityModule = this._module;
    this.look.setFloorLock(hasFloor(mode) || this.hide.inside);
    if (hasFloor(mode)) capsuleOffsets(this._gait, this.capsule);
    else this.capsule[0].set(0, 0, 0);
    this.doorOffset.set(0, 0, 0);
  }

  /**
   * Did the floor change under us, and if so, which of §4's four transitions is
   * it?
   *
   * The distinction the whole set-piece rests on is `crossed` versus `station`:
   * walking into a module with no floor is a LAUNCH you chose and paid for, and
   * the floor failing where you stand is a LIFTOFF you did not. Both end in
   * FLOATING; only one of them is your fault, and only one of them punches the
   * vignette.
   */
  private syncGravity(): void {
    const mode = this.currentGravity();
    if (mode === this._gravity) {
      this.gravityModule = this._module;
      // The body may still have to be reconciled with its regime — a state can
      // be left over from a teleport, a net correction or a spawn.
      this.enforceRegimeState();
      return;
    }

    const from = this._gravity;
    const reason: TransitionReason = this._module !== this.gravityModule ? 'crossed' : 'station';
    const kind = classifyGravityTransition(from, mode, reason);
    this._gravity = mode;
    this.gravityModule = this._module;
    if (kind) this.applyRegimeChange(kind, from, mode);
    this.look.setFloorLock(hasFloor(mode) || this.hide.inside);
    this.config.onGravityMode?.(mode, this._module, reason);
  }

  /**
   * Everything one transition does to the body.
   *
   * Velocity first, and through `applyTransitionVelocity()` rather than by hand,
   * because §4 pins each rule to a constant: a launch is UNCHANGED (momentum is
   * conserved; there is no free boost and no free brake), a liftoff adds exactly
   * `LIFTOFF_IMPULSE_M_S` along UP, a settle is unchanged and starts falling
   * next frame.
   */
  private applyRegimeChange(
    kind: LocomotionTransitionKind,
    from: GravityMode,
    to: GravityMode,
  ): void {
    // A body halfway into a locker when the floor goes is not in the locker.
    // A body already INSIDE one stays there: the box is still geometry, and
    // being tipped out of your hiding place by a plant failure would make the
    // §5 director's cheapest lever also its most lethal.
    if (this.hide.busy && !this.hide.inside) this.abandonHide();

    // The speed the transition happened AT. A launch is priced on the ground
    // speed you carried through the hatch (§4: sprint in, fly far); the others
    // are informational.
    const speed =
      kind === 'launch' ? deckComponent(this.velocity, _deck).length() : this.velocity.length();

    applyTransitionVelocity(kind, this.velocity);

    if (!this.hide.inside) {
      switch (kind) {
        case 'launch':
        case 'liftoff':
          this.letGo();
          this.stride.reset(true);
          this.headBob.reset();
          this.coyote = 0;
          this.groundLock = 0;
          this.capsule[0].set(0, 0, 0);
          this.doorOffset.set(0, 0, 0);
          this.setState('FLOATING');
          if (kind === 'liftoff') this.vignetteMeter.pulse(LIFTOFF_VIGNETTE_PULSE);
          break;
        case 'settle':
          this.letGo();
          this.stride.reset(true);
          this.coyote = 0;
          this.groundLock = 0;
          capsuleOffsets(this._gait, this.capsule);
          this.standUpOnSettle();
          // You are upright and falling. The landing resolves separately, which
          // is exactly the gap §4 leaves you to get into a crouch.
          this.setState('AIRBORNE');
          break;
        default:
          break;
      }
    }

    this.emitTransition(kind, from, to, speed, this._gait);
  }

  /**
   * Put the feet on the deck when a `settle` grows a body out of a sphere.
   *
   * `position` is the EYE in both regimes and the walking capsule hangs BELOW
   * it, which is right for a body that settles in open air — the eyes stay where
   * they were and the legs unfold downward, which is what actually happens when
   * a floating person is caught by gravity. It is wrong for the far more common
   * case: floating in through a hatch a metre off the plating. MEASURED before
   * this existed — a body that drifted out of `airlock-eva` at eye height 0.00,
   * which is 0.75 m above a deck at `DECK_Y_M`, unfolded 1.55 m of legs straight
   * through the deck plate and stood up on the node's hull floor 0.75 m UNDER
   * the room, inside geometry, with no way back out.
   *
   * So: if there is an upward-facing surface within a body's length below the
   * eye, the body stands ON it and the whole lift goes to `ViewLag`, which was
   * built for exactly this discontinuity ("a settle that grows a standing body out
   * of a floating sphere"). The camera does not move this frame; the body does.
   *
   * Nothing is lifted when the surface is further away than the legs are long —
   * that is a genuine fall, and §4 wants it: you settle, you drop, and the
   * landing resolves separately at `landingNoise()` from the pre-contact speed.
   */
  private standUpOnSettle(): void {
    const collider = this.collider;
    if (!collider?.ready) return;
    const eyeHeight = eyeHeightFor(this._gait);
    const hit = collider.raycast(this.position, DOWN, eyeHeight, _settleHit);
    if (!hit.hit) return;
    // A hull wall you are pressed against is not a floor (same rule the ground
    // probe uses), or a body settling beside a bulkhead would ride up it.
    if (hit.normal.dot(UP) < GROUND_NORMAL_MIN) return;
    const lift = eyeHeight - hit.distance;
    if (lift <= 0) return;
    this.position.addScaledVector(UP, lift);
    this.viewLag.bodyMovedUp(lift);
  }

  /**
   * Build the §4 `LocomotionTransition`, emit its NoiseEvent if it has one, and
   * hand the record to the integrator.
   *
   * `loudness === 0` MEANS EMIT NOTHING — not an event carrying zero. A walking
   * launch, every settle and every liftoff are genuinely silent, and §4 calls a
   * phantom zero-loudness event in §3's coalescing window "a bug that will take
   * a day to find".
   */
  private emitTransition(
    kind: LocomotionTransitionKind,
    from: GravityMode,
    to: GravityMode,
    speed: number,
    gait: Gait,
  ): LocomotionTransition {
    _transitionAt.x = this.position.x;
    _transitionAt.y = this.position.y;
    _transitionAt.z = this.position.z;
    const transition = makeTransition({
      kind,
      player: this.id,
      module: this._module,
      from,
      to,
      at: _transitionAt,
      speed,
      gait,
      t: this._tick,
    });
    if (transition.loudness > 0) {
      // The kind carries the formula: a landing is `landingNoise(speed, gait)`
      // and a launch is the push-off it amounts to (§4 — sprinting into a failed
      // module is exactly as loud as pushing off, because it is the same act).
      if (kind === 'landing') this.emit('landing', { speed, gait });
      else this.emit('push-off');
    }
    this.config.onTransition?.(transition);
    return transition;
  }

  /**
   * Force the state to one its regime actually allows.
   *
   * Nothing in the normal flow needs this — but a teleport, a `setAlive`, a net
   * correction or a spawn can all leave a `GROUNDED` body in a module with no
   * floor, and one frame of walking on nothing is one frame too many.
   */
  private enforceRegimeState(): void {
    if (this.hide.busy) return;
    const floor = hasFloor(this._gravity);
    if (floor) {
      if (this._state === 'GROUNDED' || this._state === 'AIRBORNE') return;
      this.letGo();
      capsuleOffsets(this._gait, this.capsule);
      this.setState('AIRBORNE');
      return;
    }
    if (this._state === 'GROUNDED' || this._state === 'AIRBORNE') {
      this.capsule[0].set(0, 0, 0);
      this.doorOffset.set(0, 0, 0);
      this.setState('FLOATING');
    }
  }

  // =========================================================================
  // Hiding — §4
  // =========================================================================

  /**
   * One frame of climbing in, sitting inside, or climbing out.
   *
   * The POSITION is driven by the climb; the VIEW is not. Taking the camera off
   * a player for two and a half seconds while something is coming would be both
   * a control problem and a nausea problem (§13), and the pivot exists partly to
   * reduce the second. The view is only folded once you are actually inside,
   * where a cone about the spot's authored `lookDir` reads as the locker door
   * closing rather than as the game taking your head.
   */
  private updateHiding(dt: number): void {
    this.velocity.set(0, 0, 0);
    // The gait stays live in there, and it has to: haste is what prices getting
    // OUT (§4), and a player who climbed in carefully must still be able to bail
    // out at a sprint when they hear it working the door open. The body is not
    // resized — it is in a box — only the dial the exit is read off.
    const want = gaitFromInput(this.crouchLatched, this.input.isDown('sprint'));
    if (want !== this._gait) {
      this._gait = want;
      this.config.onGait?.(want);
    }
    const event = this.hide.update(dt);
    if (this.hide.pose(_hidePos, _hideQuat)) this.position.copy(_hidePos);

    if (event === 'entered') {
      this.look.setFloorLock(true);
      this.viewLag.reset();
      this.headBob.reset();
    } else if (event === 'exited') {
      this.look.setFloorLock(hasFloor(this._gravity));
      this.setState(defaultStateFor(this._gravity));
      this.coyote = 0;
      this.groundLock = 0;
      this.stride.reset(true);
      // Land on the deck rather than near it. The climb-out lerps to the entry
      // point plus an eye height, but an authored entry is not a validated body
      // pose — the two levels disagree about whether its Y means the deck or
      // 0.9 m above it — so settle onto whatever floor is actually under the
      // body. Without this the player leaves the locker AIRBORNE and stays that
      // way, which reads as crawling.
      if (hasFloor(this._gravity)) {
        // Resync the collider to the gait first: `updateHiding` moves `_gait`
        // directly (haste prices the exit) without resizing the body, so the
        // capsule can be a gait behind by the time we climb out.
        capsuleOffsets(this._gait, this.capsule);
        this.standUpOnSettle();
      }
      return;
    }

    if (this.hide.inside) {
      this.hide.lookDir(_hideDir);
      this.look.constrainToCone(_hideDir, HIDE_YAW_LIMIT_RAD, HIDE_PITCH_LIMIT_RAD);
    }
  }

  /**
   * The nearest usable hide spot in reach, and what it would cost right now.
   *
   * The prompt is REUSED. It is recomputed from scratch every frame — `null`
   * when nothing is in reach, a fresh set of five numbers when something is —
   * so a caller that held one across frames was already reading a value that
   * had gone stale; now it reads one that has been updated. Nothing in the
   * client keeps it: `main.ts` tests it and calls `toggleHide()` in the same
   * statement, and `enterHide()` reads `.volume` synchronously.
   */
  private refreshHidePrompt(): void {
    this._hidePrompt = null;
    const graph = this.hideSpots;
    if (!graph || !this._alive || this.hide.busy || !this._module) return;
    // Surface distance, not entry distance: the prompt fires when you are AT
    // the box, from any side, and `point` is where the glyph anchors.
    const anchor = this.hideAnchor;
    const volume = graph.nearestSurface(
      this._module,
      this.position,
      HIDE_REACH_M,
      this._gravity,
      anchor,
    );
    if (!volume) return;
    const haste = hasteForGait(this._gait);
    const distance = Math.hypot(
      this.position.x - anchor.x,
      this.position.y - anchor.y,
      this.position.z - anchor.z,
    );
    let prompt = this.hidePromptBuffer;
    if (!prompt) {
      prompt = {
        volume,
        distance,
        point: anchor,
        haste,
        seconds: hideEnterSeconds(haste),
        loudness: hideNoise(haste),
      };
      this.hidePromptBuffer = prompt;
    } else {
      prompt.volume = volume;
      prompt.distance = distance;
      prompt.point = anchor;
      prompt.haste = haste;
      prompt.seconds = hideEnterSeconds(haste);
      prompt.loudness = hideNoise(haste);
    }
    this._hidePrompt = prompt;
  }

  /**
   * The hide key: get in, cancel a climb, or get out. One button, because the
   * price is set by the gait you are already holding rather than by a second
   * modifier nobody would find under pressure.
   */
  toggleHide(): boolean {
    if (this.hide.inside) return this.exitHide();
    if (this.hide.busy) return this.hide.cancel();
    return this.enterHide();
  }

  /**
   * Climb into a spot. `volume` defaults to the one in reach.
   *
   * The noise goes out at the START of the climb, not at the end: a player heard
   * getting in has to live with it, and 2.5 quiet seconds followed by a bang
   * would hand the careful option a burst of loudness exactly when it had
   * finished being careful. §14 asserts the careful entry does not fit inside
   * the time a HUNT needs to cross a module, so hiding late cannot be bought.
   */
  enterHide(volume?: HideVolume): boolean {
    if (!this._alive || this.hide.busy) return false;
    const graph = this.hideSpots;
    const target = volume ?? this._hidePrompt?.volume ?? null;
    if (!target) return false;
    if (graph && !graph.usableIn(target, this._gravity)) return false;

    const haste = hasteForGait(this._gait);
    // Emitted BEFORE the controller takes the spot, so the shell is not yet
    // between you and the room — you are still standing in it, scrambling.
    this.emit('hide-enter', { intensity: haste, hidden: false });
    if (!this.hide.enter(target, haste, this.position, this.look.orientation)) return false;
    this.letGo();
    // HIDDEN from the first frame of the climb, not from the moment the door
    // shuts: `PlayerState.HIDDEN` is defined as "no locomotion input is read"
    // (§7), which is true the instant you commit — and it keeps
    // `PlayerSnapshot.hideSpot` non-null exactly when the state says it should
    // be, which the contract requires.
    this.setState('HIDDEN');
    this.velocity.set(0, 0, 0);
    this.stride.reset(true);
    this.headBob.reset();
    this._hidePrompt = null;
    this.config.onHide?.({
      module: target.module,
      spot: parseHideSpotKey(target.key).spot,
      action: 'enter',
      haste,
    });
    return true;
  }

  /** Climb out. Same price as getting in: bailing at a sprint is a loud dive. */
  exitHide(): boolean {
    const volume = this.hide.volume;
    if (!this.hide.inside || !volume) return false;
    const haste = hasteForGait(this._gait);
    // Not muffled: you are coming out of the shell, not sitting behind it.
    this.emit('hide-exit', { intensity: haste, hidden: false });
    // The eye must land an eye-height above the entry point, not ON it — see
    // HideController.exit. Without the lift the body ends up under the deck.
    if (!this.hide.exit(haste, eyeHeightFor(this._gait))) return false;
    this.config.onHide?.({
      module: volume.module,
      spot: parseHideSpotKey(volume.key).spot,
      action: 'exit',
      haste,
    });
    return true;
  }

  /**
   * Thrown out without ceremony — the alien breached the spot (§4), the player
   * died, or the layout was replaced underneath them.
   *
   * Silent on purpose. A breach is already the loudest thing in the room at
   * `LOUDNESS.HIDE_BREACH` 55, emitted by the thing doing it; charging the
   * occupant a second `hide-exit` for being evicted would double-count one
   * event into §3's coalescing window.
   */
  breachHide(): boolean {
    if (!this.hide.busy) return false;
    this.abandonHide();
    return true;
  }

  /** Drop the spot and stand the body at its entry point. */
  private abandonHide(): void {
    const volume = this.hide.volume;
    this.hide.clear();
    this._hidePrompt = null;
    if (volume) {
      this.position.set(volume.entry.x, volume.entry.y, volume.entry.z);
      // `position` is the EYE and `entry` is a place to STAND, so the body has
      // to be lifted onto it. Setting the eye to the entry point directly buries
      // a whole body under the deck — the bug that left a player crawling after
      // climbing out of a locker.
      this.position.addScaledVector(UP, eyeHeightFor(this._gait));
      // A spot's authored entry point is a point, not a validated body pose, and
      // a spot derived from a locker prop puts it right against the carcass.
      // Being thrown out of a hide spot must not be a way into the geometry.
      if (this.collider.ready) {
        this.collider.depenetrate(this.position, PLAYER_RADIUS, this.contact, this.bodyOffsets());
      }
      this.clearProps(this.position);
    }
    this.look.setFloorLock(hasFloor(this._gravity));
    if (this._state === 'HIDDEN') this.setState(defaultStateFor(this._gravity));
    this.stride.reset(true);
    this.coyote = 0;
    this.groundLock = 0;
  }

  /** §4 GRIPPING / CHARGING: anchored to a rail, sliding at RAIL_SLIDE. */
  private updateAnchored(dt: number, gripHeld: boolean): void {
    const rails = this.railGraph;
    const key = this._gripKey;
    if (!rails || !key) {
      this.letGo();
      return;
    }
    const node = rails.node(key);
    if (!node) {
      this.letGo();
      return;
    }
    // Local copy: `this._gripKey` stops being narrowed the moment we call
    // anything, and the slide below may move us onto a different segment.
    let activeKey: RailKey = key;

    // Let go: Grip released. A charge in flight is cancelled, not fired — you
    // cannot push off something you are no longer holding.
    if (!gripHeld) {
      this.letGo();
      return;
    }

    // Charge handling (§4: hold Space while gripping).
    if (this._state === 'GRIPPING' && this.input.isDown('charge')) {
      this.setState('CHARGING');
      this._charge = 0;
    }
    if (this._state === 'CHARGING') {
      this._charge = clamp(this._charge + dt / CHARGE_TIME, 0, 1);
      this.publishCharge();
      if (!this.input.isDown('charge')) {
        this.pushOff();
        return;
      }
    }

    // Slide. WASD is read camera-relative and projected onto the rail axis, so
    // "press the way you are looking" always moves you the way you expect even
    // when the rail runs across your view.
    this.input.axis(_axis);
    _wish.set(0, 0, 0);
    if (_axis.x !== 0 || _axis.y !== 0) {
      this.look.right(_right);
      this.look.forward(_fwd);
      _wish.addScaledVector(_right, _axis.x).addScaledVector(_fwd, _axis.y);
      if (_wish.lengthSq() > 1e-9) _wish.normalize();
    }
    _dir.set(node.dir.x, node.dir.y, node.dir.z);
    const along = clamp(_wish.dot(_dir), -1, 1);
    const slide = RAIL_SLIDE * along;

    _prevPoint.copy(this.position);
    if (Math.abs(slide) > 1e-4) {
      // `slide()`, NEVER `advance()`. It is `advance` scoped to `'zero'`, and
      // the scope is what stops a player sliding out of a zero-G module into a
      // room they should be walking through (§2). The hatch rule is untouched by
      // it: `jointOpen()` still runs FIRST inside `pickContinuation`, so a
      // closed hatch and a sealed hatch both still block, and gravity scope is
      // layered on top rather than in place of that.
      const advance = rails.slide(activeKey, this.gripT, slide * dt, this.advanceBuffer);
      activeKey = advance.key;
      this._gripKey = advance.key;
      this.gripT = advance.t;
      _point.set(advance.point.x, advance.point.y, advance.point.z);

      // Hand over hand: one `rail-pull` (loudness 4, §3) per metre.
      this.slideAccum += advance.travelled;
      while (this.slideAccum >= RAIL_PULL_INTERVAL_M) {
        this.slideAccum -= RAIL_PULL_INTERVAL_M;
        this.emit('rail-pull');
      }
    } else {
      rails.pointAtInto(activeKey, this.gripT, this.probeVec);
      _point.set(this.probeVec.x, this.probeVec.y, this.probeVec.z);
    }

    // Keep the body an arm's length off the rail, perpendicular to it. Doing
    // this every frame also re-frames the offset when a slide crosses into a
    // segment running a different way (a node module, or through a hatch).
    const current = rails.require(activeKey);
    _dir.set(current.dir.x, current.dir.y, current.dir.z);
    this.gripOffset.addScaledVector(_dir, -this.gripOffset.dot(_dir));
    if (this.gripOffset.lengthSq() > GRIP_HOLD_DISTANCE * GRIP_HOLD_DISTANCE) {
      this.gripOffset.setLength(GRIP_HOLD_DISTANCE);
    }

    this.position.copy(_point).add(this.gripOffset);
    if (this.collider.ready) this.collider.depenetrate(this.position, PLAYER_RADIUS, this.contact);
    // A rail can run past a locker face. The grip anchors the body to the rail
    // regardless, so the props get the same say here they get in the sweep.
    this.clearProps(this.position);
    this.clearGripOfDoor(rails, _prevPoint);

    // Velocity is measured, not assumed: crossing a segment can flip the rail's
    // own direction, and the release/catch bookkeeping must not flip with it.
    if (dt > 0) this.velocity.subVectors(this.position, _prevPoint).divideScalar(dt);
  }

  /**
   * Stop a grip a body-radius short of a shut hatch.
   *
   * THE BUG: `RailGraph.slide()` correctly refuses to continue through a closed
   * or sealed hatch — but it stops the HAND at the junction, and the junction is
   * the door plane. The body centre is the eye (§4, the sphere is you), so
   * passage was properly blocked while the camera stood inside the door leaf and
   * looked through it. Only the head was wrong, which is exactly the kind of
   * wrong that convinces a player the door is fake.
   *
   * THE FIX: solve for the point on the rail whose distance from the door plane
   * is a radius, and slide there. `u = railDir · doorNormal` is how much a metre
   * along the rail buys along the normal, so the correction is one division. It
   * goes through `slide()` rather than moving the body directly, so the grip
   * stays anchored to a real rail parameter and a segment crossing on the way
   * back is handled by the same code that handles every other one.
   *
   * WHY THIS CANNOT WELD ANYBODY TO A DOOR: the correction only fires while the
   * body is INSIDE the radius, and it always pushes to the side the body is
   * already on. Once clear it is a no-op, and sliding away from the door only
   * increases the distance, so it never resists a player leaving. Sliding INTO
   * the door is refused, which is the point of a door.
   */
  private clearGripOfDoor(rails: RailGraph, previousBody: THREE.Vector3): void {
    const key = this._gripKey;
    if (!key) return;
    const margin = PLAYER_RADIUS + GRIP_DOOR_CLEARANCE_M;
    const door = this.barrier.straddling(this.position, margin);
    if (!door) return;
    const node = rails.node(key);
    if (!node) return;

    _doorNormal.copy(door.normal);
    const signed = _doorProbe.copy(this.position).sub(door.centre).dot(_doorNormal);
    // Which side of the door are we on? Straddling it exactly, keep the side we
    // were on last frame — the one we were NOT heading toward.
    let side = signed >= 0 ? 1 : -1;
    if (Math.abs(signed) < 1e-4) {
      side = _doorProbe.copy(previousBody).sub(door.centre).dot(_doorNormal) >= 0 ? 1 : -1;
    }

    _dir.set(node.dir.x, node.dir.y, node.dir.z);
    const u = _dir.dot(_doorNormal);
    // A rail running ACROSS a doorway rather than through it cannot be backed
    // off along its own axis. Leave it: the passage is still blocked by
    // `slide()`, and a rail like that is a layout problem, not a movement one.
    if (Math.abs(u) < GRIP_DOOR_AXIS_MIN) return;

    const metres = (side * margin - signed) / u;
    if (Math.abs(metres) < 1e-5) return;
    const back = rails.slide(key, this.gripT, metres, this.advanceBuffer);
    this._gripKey = back.key;
    this.gripT = back.t;
    this.position.set(back.point.x, back.point.y, back.point.z).add(this.gripOffset);
    if (this.collider.ready) this.collider.depenetrate(this.position, PLAYER_RADIUS, this.contact);
    this.clearProps(this.position);
  }

  /** Dead bodies persist and drift (§10). No input, no noise. */
  private updateDrift(dt: number): void {
    this.velocity.multiplyScalar(halfLifeDecay(dt, DRAG_HALFLIFE));
    // A corpse in a module with a floor is on the floor. It still drifts — §10
    // wants bodies to be findable objects — it just does it along the deck.
    if (hasFloor(this._gravity)) applyGravity(this.velocity, dt);
    _preVel.copy(this.velocity);
    _step.copy(this.velocity).multiplyScalar(dt);

    // A corpse respects a shut hatch too — otherwise a sealed module is not
    // sealed, it just has a body floating through the door.
    _doorFrom.copy(this.position);
    let stoppedByDoor = false;
    this.beginPropSweep();
    this.collider.sweep(
      this.position,
      _step,
      PLAYER_RADIUS,
      (center) => {
        this.clearProps(center);
        const door = this.barrier.blocking(_doorFrom, center, PLAYER_RADIUS);
        if (door) {
          this.resolveDoorStop(door, _doorFrom, _preVel);
          stoppedByDoor = true;
          return true;
        }
        _doorFrom.copy(center);
        return false;
      },
      this.contact,
    );
    this.foldPropContact();

    if (stoppedByDoor) return;
    if (this.contact.hit) {
      const vn = this.velocity.dot(this.contact.normal);
      if (vn < 0) this.velocity.addScaledVector(this.contact.normal, -vn * (1 + RESTITUTION));
    }
  }

  // =========================================================================
  // Grip, catch, push-off
  // =========================================================================

  /** The §4 buffered latch: the first rail inside GRAB_RANGE, this module or
   *  through an open hatch. */
  private grabCandidate(center: THREE.Vector3): RailQuery | null {
    const rails = this.railGraph;
    if (!rails) return null;
    // `grabBuffer` is consumed by `latch()` on the same substep, before anything
    // else can query it — see the field's comment for why it is not `railBuffer`.
    if (this._module && this.moduleGraph?.has(this._module)) {
      return rails.grabCandidate(this._module, center, GRAB_RANGE, this.grabBuffer);
    }
    return rails.nearest(center, GRAB_RANGE, this.grabBuffer);
  }

  /**
   * Close the hand. `speed` is the body speed at the moment of contact — the
   * clean-catch loudness is `catchNoise(speed)` = 8 + 3v (§3), NOT the impact
   * formula. A full-speed clean catch is 26; a full-speed crash is 51.
   */
  private latch(candidate: RailQuery, speed: number): void {
    this._gripKey = candidate.key;
    this.gripT = candidate.t;
    this.slideAccum = 0;

    _point.set(candidate.point.x, candidate.point.y, candidate.point.z);
    this.gripOffset.copy(this.position).sub(_point);
    _dir.set(candidate.node.dir.x, candidate.node.dir.y, candidate.node.dir.z);
    this.gripOffset.addScaledVector(_dir, -this.gripOffset.dot(_dir));
    if (this.gripOffset.lengthSq() > GRIP_HOLD_DISTANCE * GRIP_HOLD_DISTANCE) {
      this.gripOffset.setLength(GRIP_HOLD_DISTANCE);
    }

    this.setState('GRIPPING');
    this._module = candidate.node.module;

    // REPORT BEFORE ARRESTING. `catchNoise()` is a function of the speed you
    // caught at, and zeroing the velocity first makes anything that samples
    // `player.velocity` from inside the noise sink read catchNoise(0) = 8 for
    // every catch — including the full-speed one §4 requires to be 26.
    // `NoiseInfo.speed` is the authoritative value; this ordering just stops the
    // live state lying while the sink runs.
    this.emit('catch', { speed });
    this.velocity.set(0, 0, 0);
    this.heart.addExertion(EXERTION_CATCH * clamp(speed / PUSH_MAX, 0, 1));
  }

  /** Release the rail without pushing. Keeps whatever slide velocity you had. */
  private letGo(): void {
    this._gripKey = null;
    this._charge = 0;
    this.slideAccum = 0;
    this.publishCharge();
    if (this._state !== 'FLOATING') this.setState('FLOATING');
  }

  /** §4 CHARGING release: `cameraForward * lerp(PUSH_MIN, PUSH_MAX, charge)`. */
  private pushOff(): void {
    const charge = this._charge;
    const speed = PUSH_MIN + (PUSH_MAX - PUSH_MIN) * charge;
    this.look.forward(_fwd);
    this.velocity.copy(_fwd).multiplyScalar(speed);

    this._gripKey = null;
    this._charge = 0;
    this.slideAccum = 0;
    // Grip is held, not tapped — without this the rail you just left catches you
    // again on the next substep.
    this.latchLockout = PUSH_LATCH_LOCKOUT_S;
    this.setState('FLOATING');
    this.publishCharge();

    // Push-off is a flat 8 in the §3 table, regardless of how hard you pushed.
    this.emit('push-off');
    this.heart.addExertion(EXERTION_PUSH * (0.4 + 0.6 * charge));
  }

  /**
   * Contact response, dispatched by regime.
   *
   * The zero-G branch is `resolveImpact` BELOW, untouched — the walking path
   * must never reach into it, because §4's hardest-won fix lives in its first
   * three lines and every edit to that function is a chance to re-break the
   * catch-versus-crash loudness on the wire.
   */
  private resolveContact(preVelocity: THREE.Vector3, normal: THREE.Vector3): void {
    if (hasFloor(this._gravity)) this.resolveWalkContact(preVelocity, normal);
    else this.resolveImpact(preVelocity, normal);
  }

  /**
   * Contact response for a body with its feet on a deck.
   *
   * Two things differ from zero-G, and both are deliberate:
   *
   *  1. NO RESTITUTION. A walking body does not bounce off a bulkhead. The
   *     inbound component is removed and the tangent is kept in full, so you
   *     slide along a wall at your gait speed instead of scrubbing off into it.
   *  2. A WALL IS ONLY AN IMPACT WHILE AIRBORNE, and then only above
   *     `WALL_IMPACT_MIN_SPEED`. Under gravity you are in contact with the world
   *     constantly and the deck is `2 x DECK_HALF_WIDTH_M` wide; charging
   *     `impactNoise(1.4)` = 23
   *     every time somebody brushes a bulkhead would make walking louder than
   *     running and drown §3's coalescing window in events nobody chose. Ground
   *     contacts are not impacts at all — they are landings, priced by
   *     `landingNoise()` from the pre-contact velocity in `settleOnGround`.
   *
   * The reporting order is the same as `resolveImpact`'s and for the same
   * reason: the loudness is a function of the speed you arrived at, and the
   * response below destroys that number in place.
   */
  private resolveWalkContact(preVelocity: THREE.Vector3, normal: THREE.Vector3): void {
    if (normal.lengthSq() < 1e-9) return;
    const ground = normal.dot(UP) >= GROUND_NORMAL_MIN;
    if (!ground && this._state === 'AIRBORNE') {
      const approach = -preVelocity.dot(normal);
      if (approach >= WALL_IMPACT_MIN_SPEED && this.time - this.lastImpactAt >= IMPACT_COOLDOWN_S) {
        this.lastImpactAt = this.time;
        this.emit('impact', { speed: approach });
        this.heart.addExertion(EXERTION_IMPACT * clamp(approach / PUSH_MAX, 0, 1));
      }
    }
    const vn = this.velocity.dot(normal);
    if (vn < 0) this.velocity.addScaledVector(normal, -vn);
  }

  /**
   * Contact response for an uncontrolled arrival: `impactNoise(speed)` = 15 + 6v
   * (§3), a different curve from the clean catch above, on purpose.
   */
  private resolveImpact(preVelocity: THREE.Vector3, normal: THREE.Vector3): void {
    if (normal.lengthSq() < 1e-9) return;
    const approach = -preVelocity.dot(normal);

    // REPORT BEFORE RESPONDING. `impactNoise()` is a function of the speed you
    // arrived at, and restitution plus tangent friction destroy that number in
    // place — a full-charge crash measured 1.21 m/s (loudness 22, under
    // HUNT_TRIGGER) instead of 6 m/s (loudness 51) for anything sampling
    // `player.velocity` from inside the sink. `NoiseInfo.speed` is the
    // authoritative value; this ordering just stops the live state lying too.
    if (approach >= IMPACT_MIN_SPEED && this.time - this.lastImpactAt >= IMPACT_COOLDOWN_S) {
      this.lastImpactAt = this.time;
      this.emit('impact', { speed: approach });
      this.heart.addExertion(EXERTION_IMPACT * clamp(approach / PUSH_MAX, 0, 1));
    }

    const vn = this.velocity.dot(normal);
    if (vn < 0) this.velocity.addScaledVector(normal, -vn * (1 + RESTITUTION));
    _tangent.copy(this.velocity).addScaledVector(normal, -this.velocity.dot(normal));
    this.velocity.addScaledVector(_tangent, -(1 - TANGENT_FRICTION));
  }

  /**
   * A shut hatch stopped the sweep. Stand the body back on the side it came
   * from, clear of the door plane, and treat the door as the wall it is.
   *
   * The push-out matters as much as the stop: a door that closes on a player
   * already straddling its plane would otherwise block every subsequent move in
   * both directions and trap them in the frame forever. The clearing push runs
   * along the door normal, which inside a hatchway is the axis of the tube —
   * always the free direction — and is then depenetrated against the hull.
   */
  private resolveDoorStop(
    door: HatchBlock,
    lastLegal: THREE.Vector3,
    preVelocity: THREE.Vector3,
  ): void {
    _doorNormal.copy(door.normal);
    // Measured at the body point the barrier itself was queried with, so the
    // two agree about which side of the leaf the player is on even for a door
    // whose normal is not perpendicular to `doorOffset`.
    _doorPoint.copy(lastLegal).add(this.doorOffset);
    let signed = _doorProbe.copy(_doorPoint).sub(door.centre).dot(_doorNormal);
    // Which side are we on? Straddling the plane exactly, keep the side we came
    // from — i.e. the one we were NOT heading toward.
    let side = signed >= 0 ? 1 : -1;
    if (Math.abs(signed) < 1e-4) side = preVelocity.dot(_doorNormal) > 0 ? -1 : 1;

    this.position.copy(lastLegal);
    // Props FIRST, and the door last. A prop push is up to a body radius along
    // the prop's own face, and a locker beside a hatchway could aim that push
    // straight through the leaf — which would be a body stepping through a
    // SEALED hatch, the one thing §5's barricading mechanic cannot survive. Do
    // it before the clearance is measured and the door has the final say.
    this.clearProps(this.position);
    _doorPoint.copy(this.position).add(this.doorOffset);
    signed = _doorProbe.copy(_doorPoint).sub(door.centre).dot(_doorNormal);
    // A hair past touching, so the next frame's test reads "clear" rather than
    // "exactly on the surface" and the body is free to drift away.
    const clearance = side * (PLAYER_RADIUS + CONTACT_EPSILON);
    if (side > 0 ? signed < clearance : signed > clearance) {
      this.position.addScaledVector(_doorNormal, clearance - signed);
    }
    if (this.collider.ready) {
      this.collider.depenetrate(this.position, PLAYER_RADIUS, this.doorContact, this.bodyOffsets());
    }

    // Normal points away from the door, toward the side we are on — the same
    // convention the BVH contact normal uses, so the response is identical.
    _doorNormal.multiplyScalar(side);
    this.resolveContact(preVelocity, _doorNormal);
  }

  /** The collider shape for the current regime: the walking capsule, or
   *  `undefined` for the single §4 sphere. */
  private bodyOffsets(): [THREE.Vector3, THREE.Vector3] | undefined {
    return hasFloor(this._gravity) && !this.hide.busy ? this.capsule : undefined;
  }

  /**
   * Push the body out of any interactable prop it is inside, and remember the
   * deepest one for the frame's contact response.
   *
   * Runs per SUBSTEP, alongside the hatch-door test and for the same reason: a
   * prop is a box the body must not tunnel, and a sweep that only checked at the
   * end would resolve a fast body out of the far side of the locker it went
   * through. The BVH is re-depenetrated straight afterwards, because a prop
   * standing against a bulkhead can push the body into the bulkhead and the
   * static geometry has the final say about where a body may be.
   *
   * NOT WHILE HIDDEN. `HideController` puts the occupant at the volume's centre
   * on purpose (§4 — that is what makes `sweepBlocked` mean anything), and a
   * hide spot derived from a locker prop shares its box. Fighting the pose would
   * eject the player from the spot they just spent 2.5 s and 8 loudness getting
   * into.
   */
  private clearProps(center: THREE.Vector3): boolean {
    if (this.props.size === 0 || this.hide.busy) return false;
    const offsets = this.bodyOffsets();
    const contact = this.props.resolve(center, PLAYER_RADIUS, offsets, this.propStep);
    if (!contact.hit) return false;
    if (this.collider.ready) {
      this.collider.depenetrate(center, PLAYER_RADIUS, this.propBvh, offsets);
    }
    if (contact.depth > this.propContact.depth) {
      this.propContact.hit = true;
      this.propContact.depth = contact.depth;
      this.propContact.object = contact.object;
      this.propContact.normal.copy(contact.normal);
    }
    return true;
  }

  /** Forget the previous sweep's prop contact. Called at the top of every
   *  sweep, the same way `ContactResult` is reset inside `StationCollider`. */
  private beginPropSweep(): void {
    this.propContact.hit = false;
    this.propContact.depth = 0;
    this.propContact.object = null;
    this.propContact.normal.set(0, 0, 0);
  }

  /**
   * Fold the sweep's prop contact into `this.contact`.
   *
   * The whole point of folding rather than reporting separately: everything
   * downstream — the wedge test, `resolveContact`, and above all the
   * `-preVelocity.dot(normal)` approach-speed capture that prices a catch at 26
   * and a crash at 51 — already reads `contact`, and a second response path is a
   * second chance to get that ordering wrong. The deeper of the two contacts
   * wins, so a body stopped by a locker reports the locker's normal and a body
   * stopped by the bulkhead behind it reports the bulkhead's.
   */
  private foldPropContact(): void {
    if (!this.propContact.hit) return;
    if (this.contact.hit && this.contact.depth >= this.propContact.depth) return;
    this.contact.hit = true;
    this.contact.depth = Math.max(this.contact.depth, this.propContact.depth);
    this.contact.normal.copy(this.propContact.normal);
  }

  /** Is there room for the body here, props included? */
  private bodyFits(center: THREE.Vector3, offsets: BodyOffsets, tolerance: number): boolean {
    if (this.collider.overlaps(center, PLAYER_RADIUS, offsets, tolerance)) return false;
    if (this.hide.busy) return true;
    return !this.props.overlaps(center, PLAYER_RADIUS, offsets, tolerance);
  }

  // =========================================================================
  // Discrete actions
  // =========================================================================

  private updateToggles(): void {
    if (this.input.pressed('flashlight')) this.toggleFlashlight();
    if (this.input.pressed('trackerMute')) this.toggleTrackerMute();
    if (this.input.pressed('knock')) this.knock();
    if (this.input.pressed('hide')) this.toggleHide();
    if (this.input.pressed('interact')) this.config.onInteract?.(this._interaction);
    // Crouch is a TOGGLE, not a hold. It was held, and the failure mode was
    // the browser: crouch-walking means Ctrl+W — the one accelerator no page
    // may intercept — and one panicked crouch-forward closed the tab. Gated on
    // a floor so Ctrl can keep doubling as grip in zero-G without silently
    // flipping the gait you will land in.
    if (this.input.pressed('crouch') && hasFloor(this._gravity)) {
      this.crouchLatched = !this.crouchLatched;
    }
  }

  /** §10 knock codes: tap a handrail, loudness 15, carries about two modules. */
  knock(): boolean {
    if (!this._alive) return false;
    if (this.time - this.lastKnockAt < KNOCK_COOLDOWN_S) return false;
    // A knock is a hand on a handrail (§10), and handrails are authored in EVERY
    // module — scenery to a walking player, but still there to tap. So the test
    // is the rail, not the regime: gripping one puts your hand on it already,
    // and otherwise one has to be within arm's reach. That is why `_nearestRail`
    // is queried at scope `'any'` and only the CROSSHAIR is scoped to `'zero'`.
    const holding = this._state === 'GRIPPING' || this._state === 'CHARGING';
    const inReach =
      holding || (this._nearestRail !== null && this._nearestRail.distance <= KNOCK_REACH_M);
    if (!inReach) return false;
    this.lastKnockAt = this.time;
    this.emit('knock');
    return true;
  }

  /** §4 fire extinguisher: one burst of delta-v, loudness 65. */
  fireExtinguisher(): boolean {
    // Zero-G only, and not as a rule but as a fact: it is a thruster for a body
    // with nothing to push against (§4 "stranded mid-module with no rail in
    // reach"). On a deck you have a floor, and the floor is better.
    if (!this._alive || this._state !== 'FLOATING') return false;
    if (!this.extinguisher.fire()) return false;

    // Aim: WASD steers the burst relative to where you are looking, so you can
    // burn retrograde to stop. No input means straight ahead.
    this.input.axis(_axis);
    _wish.set(0, 0, 0);
    if (_axis.x !== 0 || _axis.y !== 0) {
      this.look.right(_right);
      this.look.forward(_fwd);
      _wish.addScaledVector(_right, _axis.x).addScaledVector(_fwd, _axis.y).normalize();
    } else {
      this.look.forward(_wish);
    }

    this.velocity.addScaledVector(_wish, this.extinguisher.deltaV);
    // Never faster than a full push-off (§14 check 5b).
    if (this.velocity.lengthSq() > PUSH_MAX * PUSH_MAX) this.velocity.setLength(PUSH_MAX);

    this.emit('extinguisher');
    this.heart.addExertion(EXERTION_PUSH);
    return true;
  }

  private fireExtinguisherIfRequested(): void {
    if (this.input.pressed('extinguisher')) this.fireExtinguisher();
  }

  toggleFlashlight(): boolean {
    this._flashlight = !this._flashlight;
    this.config.onFlashlight?.(this._flashlight);
    return this._flashlight;
  }

  /** §6: muted, you are silent but blind. */
  toggleTrackerMute(): boolean {
    this._trackerMuted = !this._trackerMuted;
    this.config.onTrackerMute?.(this._trackerMuted);
    if (this.emitToBus) bus.emit('ui:trackerMute', { muted: this._trackerMuted });
    return this._trackerMuted;
  }

  /**
   * Emit any NoiseEvent from the player's position — voice (§7), a puzzle's
   * pry bar (§11), a decoy landing in your hand. Loudness always comes from
   * `noiseLoudness()`, never from a caller's number.
   */
  emitNoise(
    kind: NoiseKind,
    opts: { speed?: number; intensity?: number; gait?: Gait; hidden?: boolean } = {},
  ): NoiseEvent | null {
    return this.emit(kind, opts);
  }

  /** Set the gait directly — a gamepad trigger, a replay, a test. Refused if
   *  there is no headroom to stand up in (§4 crouch). */
  setGait(gait: Gait): boolean {
    if (gait === this._gait) return true;
    const rise = eyeHeightFor(gait) - eyeHeightFor(this._gait);
    if (rise > 0 && !this.canResize(gait, rise)) return false;
    if (rise !== 0 && hasFloor(this._gravity) && !this.hide.busy) {
      this.position.addScaledVector(UP, rise);
      this.viewLag.bodyMovedUp(rise);
    }
    this._gait = gait;
    this.config.onGait?.(gait);
    return true;
  }

  /** Jump, if there is a deck under you (§4, 0.45 m). Returns false in zero-G,
   *  in mid-air, and inside a hide spot. */
  jump(): boolean {
    if (!this._alive || !hasFloor(this._gravity) || this.hide.busy) return false;
    if (this._state !== 'GROUNDED' && this.coyote <= 0) return false;
    if (this.groundLock > 0) return false;
    return this.launchJump();
  }

  // =========================================================================
  // Aim, module tracking, snapshots
  // =========================================================================

  private updateAimAndCrosshair(dt: number): void {
    // Nearest rail, for the crosshair's "rail" state and for knock reach. Six
    // candidates in a module and allocation-free, so this stays per-frame.
    const rails = this.railGraph;
    if (rails) {
      const hintRange = GRAB_RANGE * RAIL_HINT_RANGE_FACTOR;
      this._nearestRail =
        this._module && this.moduleGraph?.has(this._module)
          ? rails.nearestInModule(this._module, this.position, hintRange, this.railBuffer)
          : rails.nearest(this.position, hintRange, this.railBuffer);
    } else {
      this._nearestRail = null;
    }

    this.updateInteractionRay(dt);
    this.refreshHidePrompt();

    // A hide spot in reach reports `hand`: it IS a hand verb, and §6's crosshair
    // list is short on purpose because the crosshair is the tutorial. The rail
    // glyph is scoped to `zero` modules even though the query above is not —
    // handrails are scenery where there is a floor (§2), and offering a grab
    // prompt for one would be a lie about what the key does.
    const railsLive = this.railGraph?.railsActive(this._module) ?? false;
    // ONE resolution of "is there a hand verb here", used by the glyph and by
    // the prompt. Splitting them is how a crosshair and a HUD chip end up
    // disagreeing about whether E does anything.
    this.refreshInteractTarget();
    if (this._state === 'CHARGING') this._crosshair = 'charge';
    else if (this._interactTarget) this._crosshair = 'hand';
    else if (
      railsLive &&
      this._nearestRail &&
      this._nearestRail.distance <= GRAB_RANGE * RAIL_HINT_RANGE_FACTOR
    )
      this._crosshair = 'rail';
    else this._crosshair = 'dot';
  }

  /**
   * The camera's offset from the body: view lag plus head bob.
   *
   * Comfort only. Nothing else reads it — the noise origin, the collider and the
   * §7 transform are all `this.position` — which is what stops a comfort dial
   * from changing what the alien hears (§4).
   */
  private updateViewOffset(dt: number): void {
    const lag = this.viewLag.update(dt);
    const gait = this._gait;
    const profile = gaitProfile(gait);
    const active = this._state === 'GROUNDED' && !this.hide.busy;
    const speedFraction =
      profile.speed > 0 ? deckComponent(this.velocity, _deck).length() / profile.speed : 0;
    this.look.right(_right);
    const bob = this.headBob.update(
      dt,
      this.stride.phase,
      active,
      BOB_AMPLITUDE_M * this.comfort.headBob,
      speedFraction,
      _right,
    );
    this.viewOffset.copy(bob).addScaledVector(UP, lag);
  }

  /**
   * The interaction ray (§6: you must physically be at the panel).
   *
   * Two filters sit in front of `intersectObjects`, which used to walk all 22 of
   * the station's lockers and panels — every module, visible or not — 60 times a
   * second for a 2.5 m ray:
   *
   *  1. A per-frame sphere reject. An object can only be hit if its bounding
   *     sphere reaches the ray, i.e. within `INTERACT_RANGE + radius` of the
   *     eye. That is exactly conservative — it can never drop a real hit, and
   *     40k random rays over the station (lockers shut and swung open alike)
   *     returned the identical nearest hit with the list cut from 22 to ~4.
   *  2. Sampling at AIM_RAYCAST_HZ. When nothing is in reach the state is
   *     cleared immediately, so leaving a panel is never late; only the choice
   *     between candidates already in front of you is resampled.
   */
  private updateInteractionRay(dt: number): void {
    const near = this.aimNear;
    near.length = 0;
    const candidates = this.refreshAimCandidates();
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (this.position.distanceToSquared(candidate.centre) > candidate.reachSq) continue;
      near.push(candidate.object);
    }

    if (near.length === 0) {
      this._interaction = null;
      this.aimCooldown = 0; // re-arm, so walking back up to a panel is instant
      return;
    }

    // A held hit whose contact point has fallen out of arm's reach is dropped
    // on the spot rather than waiting for the next sample — that is the one case
    // where a stale answer would be visibly wrong instead of merely late.
    const stale =
      this._interaction !== null &&
      this.position.distanceToSquared(this._interaction.point) > INTERACT_RANGE * INTERACT_RANGE;
    this.aimCooldown -= dt;
    if (this.aimCooldown > 0 && !stale) return;
    this.aimCooldown = 1 / AIM_RAYCAST_HZ;

    this.look.forward(_fwd);
    this.raycaster.set(this.position, _fwd);
    this.raycaster.far = INTERACT_RANGE;
    // `intersectObjects` fills a caller-supplied array when it is given one;
    // without it, a fresh array per sample. The intersection records inside are
    // three's own and are still minted per hit — that part is not ours.
    const hits = this.aimHits;
    hits.length = 0;
    this.raycaster.intersectObjects(near, true, hits);
    const first = hits[0];
    if (!first) {
      this._interaction = null;
      hits.length = 0;
      return;
    }
    // Refilled rather than replaced. `point` is COPIED into a vector this class
    // owns: three's own is recycled by the next cast, and `_interaction.point`
    // outlives the cast — the staleness test below reads it a frame later.
    let held = this.interactionBuffer;
    if (!held) {
      held = { object: first.object, point: new THREE.Vector3(), distance: 0 };
      this.interactionBuffer = held;
    }
    held.object = first.object;
    held.point.copy(first.point);
    held.distance = first.distance;
    this._interaction = held;
    hits.length = 0;
  }

  /**
   * The §6 interact prompt, from the aim result the crosshair already has.
   *
   * WHY IT LIVES HERE AND NOT IN THE HUD. §6's crosshair reports `hand` for a
   * panel, a locker AND a hide spot in reach — "it IS a hand verb, and the §6
   * list is deliberately short because the crosshair is the tutorial". A HUD
   * that wanted to say WHICH hand verb had exactly two options: re-run the
   * raycast (a second answer that drifts from the glyph, at 22 lockers and
   * panels a frame) or be told. This is being told.
   *
   * THE ORDER MATCHES `main.ts`'s KEY HANDLER on purpose: a panel, a locker or
   * a crewmate is never worth losing to a bunk you happen to be standing beside,
   * so the ray wins and the hide spot is the fallback. A prompt that named a
   * different verb from the one the key performs would be worse than no prompt.
   *
   * `describeInteractable` is asked every frame, deliberately. It was once per
   * target, which is cheaper and wrong: a locker's `usable` goes false the
   * moment somebody empties it, and the player is still standing in front of it
   * when that happens. One map lookup against one object is not worth a stale
   * prompt.
   */
  private refreshInteractTarget(): void {
    const hit = this._interaction;
    const spot = this._hidePrompt;
    if (!hit && !spot) {
      this.setInteractTarget(null);
      return;
    }

    const target = this.targetBuffer;
    if (hit) {
      const info = this.config.describeInteractable?.(hit.object) ?? null;
      target.kind = info?.kind ?? 'other';
      target.label = info?.label ?? '';
      target.object = hit.object;
      target.point.copy(hit.point);
      target.distance = hit.distance;
      target.hide = null;
      // §6 wants you AT the panel. `INTERACT_RANGE` is the ray and is generous
      // so the glyph lights up on approach; `INTERACT_REACH_M` is the commit.
      // The ray's own distance is the honest measure of it — it is the gap to
      // the surface of THE thing you are aiming at, which a nearest-prop query
      // is not: standing with your back to a locker would otherwise report you
      // as being at the panel across the deck.
      target.inReach = hit.distance <= INTERACT_REACH_M;
      target.usable = (info?.usable ?? true) && this._alive && !this.hide.busy;
    } else if (spot) {
      target.kind = 'hide';
      target.label = '';
      target.object = null;
      // The glyph goes ON the box (the prompt's surface anchor), never at the
      // authored standing point out in the open floor.
      target.point.set(spot.point.x, spot.point.y, spot.point.z);
      target.distance = spot.distance;
      target.hide = spot;
      // The spot was only reported at all because it is inside `HIDE_REACH_M`,
      // which IS the "at it" test for a hide spot (§4: arm's length plus a step).
      target.inReach = true;
      target.usable =
        this._alive &&
        !this.hide.busy &&
        (this.hideSpots?.usableIn(spot.volume, this._gravity) ?? true);
    }
    this.setInteractTarget(target);
  }

  /**
   * Publish the target, firing `onInteractTarget` only on a real change.
   *
   * The identity in the signature is the OBJECT for a prop and the hide
   * VOLUME's key for a spot — never `hide.key`, which is the spot you are
   * already INSIDE and is null for a candidate, so two different bunks in a row
   * would have looked identical and the HUD would never have been told.
   */
  private setInteractTarget(target: InteractTarget | null): void {
    this._interactTarget = target;
    const signature = target
      ? `${target.kind}|${target.label}|${target.inReach ? 1 : 0}|${target.usable ? 1 : 0}|` +
        `${target.object ? target.object.id : (target.hide?.volume.key ?? '')}`
      : '';
    if (signature === this.targetSignature) return;
    this.targetSignature = signature;
    this.config.onInteractTarget?.(target);
  }

  /** The broad-phase index, rebuilt only when `interactables` is replaced. */
  private refreshAimCandidates(): readonly AimCandidate[] {
    // Length as well as identity: `Station.dispose()` empties the array in
    // place rather than handing back a new one, and a cache of disposed
    // geometry is worse than no cache.
    if (
      this.aimIndexSource === this.interactables &&
      this.aimIndexLength === this.interactables.length
    ) {
      return this.aimIndex;
    }
    this.aimIndexSource = this.interactables;
    this.aimIndexLength = this.interactables.length;
    this.aimIndex = [];
    for (const object of this.interactables) {
      // Ancestors first: the bounds walk assumes parent world matrices are current.
      object.updateWorldMatrix(true, false);
      _bounds.setFromObject(object);
      if (_bounds.isEmpty()) continue;
      _bounds.getBoundingSphere(_sphere);
      const reach = _sphere.radius + INTERACT_BOUNDS_SLACK_M + INTERACT_RANGE;
      this.aimIndex.push({
        object,
        centre: _sphere.center.clone(),
        reachSq: reach * reach,
      });
    }
    return this.aimIndex;
  }

  private refreshModule(force: boolean): void {
    let next = this._module;
    this.probePos.x = this.position.x;
    this.probePos.y = this.position.y;
    this.probePos.z = this.position.z;
    const resolved = this.config.moduleAt?.(this.probePos, this._module || null);
    if (this._gripKey) {
      // Gripping is exact: the rail knows which module it belongs to.
      next = parseRailKey(this._gripKey).module;
    } else if (resolved) {
      // A real containment test beats the nearest-centre heuristic outright.
      next = resolved;
    } else if (this.moduleGraph) {
      const nearest = this.moduleGraph.nearestModule(this.position) ?? this._module;
      next = force ? nearest : this.acceptModuleChange(nearest);
    }
    if (!force && next === this._module) return;
    this._module = next;
    if (next !== this.announcedModule && this.emitToBus) {
      const previous = this.announcedModule;
      this.announcedModule = next;
      bus.emit('player:module', { id: this.id, from: previous, to: next });
      bus.emit('module:entered', { module: next });
    } else {
      this.announcedModule = next;
    }
  }

  /**
   * `ModuleGraph.nearestModule` compares module CENTRES, so a floating body can
   * be "nearest" to a module it is not actually connected to — two tubes that
   * run side by side, say. A player only ever leaves a module through one of its
   * hatches, so only accept a change to a graph neighbour, and require a clear
   * margin so a body hovering on the mid-plane does not flip module ids at 60 Hz
   * (every flip is a `player:module` event and a noise-origin change).
   */
  private acceptModuleChange(candidate: ModuleId): ModuleId {
    const graph = this.moduleGraph;
    const current = this._module;
    if (!graph || candidate === current) return current;
    if (!current || !graph.has(current)) return candidate;
    if (!graph.edgeBetween(current, candidate)) return current;

    const here = graph.centre(current);
    const there = graph.centre(candidate);
    if (!here || !there) return candidate;
    const dHere = this.position.distanceTo(_centre.set(here.x, here.y, here.z));
    const dThere = this.position.distanceTo(_centre.set(there.x, there.y, there.z));
    return dThere < dHere - MODULE_SWITCH_MARGIN_M ? candidate : current;
  }

  /** §7's networked player record. */
  snapshot(): PlayerSnapshot {
    const q = this.look.orientation;
    return {
      id: this.id,
      pos: v3(this.position.x, this.position.y, this.position.z),
      quat: { x: q.x, y: q.y, z: q.z, w: q.w },
      state: this._state,
      // `gripId` is only ever set in a `zero` module — there is nothing to hold
      // in a room with a floor, and the rail queries are scoped so it cannot be.
      gripId: this._gripKey,
      module: this._module,
      alive: this._alive,
      charge: this._charge,
      heartRate: this.heart.bpm,
      gait: this._gait,
      hideSpot: this.hide.key,
    };
  }

  /**
   * The §7 `transform` message: send it, the server sanity-checks it, done.
   *
   * REUSED between calls, like `RailGraph`'s query buffers. This goes out on
   * every fixed tick, forever, and `NetClient.sendTransform` serialises it
   * synchronously — nothing downstream keeps it. `snapshot()` above is the one
   * that hands back a fresh record you may hold.
   */
  transformMessage(tick?: number): TransformMessage {
    const q = this.look.orientation;
    const msg = this.transformBuf;
    msg.pos.x = this.position.x;
    msg.pos.y = this.position.y;
    msg.pos.z = this.position.z;
    msg.quat.x = q.x;
    msg.quat.y = q.y;
    msg.quat.z = q.z;
    msg.quat.w = q.w;
    msg.state = this._state;
    msg.gripId = this._gripKey;
    msg.module = this._module;
    // The server re-derives footstep loudness from the gait and sanity-checks
    // speed against `gaitSpeed(gait)` rather than PUSH_MAX (§7).
    msg.gait = this._gait;
    msg.hideSpot = this.hide.key;
    msg.t = tick ?? this._tick;
    return msg;
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private setState(next: PlayerState): void {
    if (this._state === next) return;
    this._state = next;
    if (this.emitToBus) {
      bus.emit('player:state', { id: this.id, state: next, gripId: this._gripKey });
    }
  }

  private publishCharge(): void {
    if (!this.emitToBus) return;
    const charge = this._charge;
    if (charge === this.lastChargeSent) return;
    // Always announce the ends of the arc; throttle the middle.
    const edge = charge === 0 || charge === 1;
    if (!edge && Math.abs(charge - this.lastChargeSent) < 0.01) return;
    this.lastChargeSent = charge;
    bus.emit('player:charge', { charge });
  }

  private emit(
    kind: NoiseKind,
    opts: {
      speed?: number;
      intensity?: number;
      gait?: Gait;
      /** Override the hide-spot muffle. `false` on the climb in and the climb
       *  out, which happen with the player half outside the shell. */
      hidden?: boolean;
      origin?: THREE.Vector3;
    } = {},
  ): NoiseEvent | null {
    if (!this._alive) return null;
    // The speed THIS event was made at, captured here and handed to the sink.
    // It is not `this.speed`: by the time a sink runs, the controller has
    // already arrested a catch to zero and bled a crash through restitution, and
    // an impact's loudness is the closing speed along the contact normal, not
    // the body's full speed. Re-deriving it downstream is how catch became 8 and
    // a full-charge crash became 22 (§3, §4).
    const speed = opts.speed ?? 0;
    const gait = opts.gait ?? this._gait;
    // The shell (§4). NEGATIVE dB, added exactly like a hatch offset, and
    // applied here as well as on the server because §8 requires the player to
    // hear their own noise at the level it actually went out at — you have to
    // feel the mistake as you make it, including feeling it be quieter.
    const hidden = opts.hidden ?? this.hide.inside;
    const muffleDb = hidden ? this.hide.muffleDb : 0;
    const loudness = noiseLoudness(kind, {
      speed: opts.speed,
      intensity: opts.intensity,
      gait,
      hidden,
      muffleDb,
    });
    const origin = opts.origin ?? this.position;
    const event: NoiseEvent = {
      kind,
      origin: v3(origin.x, origin.y, origin.z),
      module: this._module,
      loudness,
      t: this._tick,
      actor: this.id,
    };
    // How far it carries before dropping under the §3 audibility floor — the
    // §6 noise ring is scaled to exactly this.
    const carriedMetres = Math.max(0, (loudness - FLOOR) / ATTENUATION_PER_M);
    this.config.onNoise?.(event, { loudness, carriedMetres, speed, gait, hidden, muffleDb });
    if (this.emitToBus) {
      bus.emit('noise:emitted', { event });
      bus.emit('noise:self', { event, carriedMetres });
    }
    return event;
  }
}
