/**
 * ISS-CHR-02 — first-person gloved arms (DESIGN.md §9, asset bible "Characters").
 *
 * §9's own words: this "sells zero-G more than anything else". It is also the
 * one asset in the game the player looks at for the entire round, and until now
 * it did not exist — the camera was a disembodied point, which is why the
 * station reads as a walkthrough rather than a place a body is in.
 *
 * FOUR THINGS IT HAS TO DO, from the bible's row for ISS-CHR-02:
 *
 *   1. **Reach for a rail while gripping.** Not a canned animation: the arm
 *      aims at `Player.nearestRail.point`, converted into camera space, so the
 *      glove closes on the rail you are actually about to grab. That is the
 *      whole reason to have hands in a zero-G module — the movement grammar is
 *      grab-and-pull, and a hand that grabs nothing in particular teaches
 *      nothing.
 *   2. **Brace on impact.** §4's catch-vs-crash distinction is priced in noise
 *      (26 vs 51) and the player has to feel which one happened. Both arms snap
 *      up, the fingers spread, and the view model recoils — a physical read on
 *      an event that is otherwise a number in an audio bus.
 *   3. **Hold the carried item.** Through the carryables agent's own factory,
 *      `buildHeldItem`, whose contract is "the group's origin IS the grip
 *      point". So the item hangs off a wrist node and nothing here knows what a
 *      medkit looks like.
 *   4. **Stay out of the way otherwise.** Idle drops both arms to the bottom
 *      corners of the frame with a breathing sway, and the walk cycle bobs them
 *      against the head bob rather than with it.
 *
 * LIGHT. The flashlight is parented to the camera with a 23° cone, so at the
 * 0.3 m the gloves sit at, the beam is only ~0.06 m across and the hands are
 * **outside it**. That is deliberate and correct: your own hands are not in your
 * torch beam either. They read on ambient as pale shapes, and silhouette
 * against whatever the beam is pointed at, which is the strongest reading a
 * dark game can give them. Do not "fix" it by widening the cone.
 *
 * NEVER casts a shadow (the one 1024² map belongs to the doorway ahead of you,
 * and a view model in it is a black bar across the screen) and never enters the
 * BVH — `Player.setInteractables` takes an explicit list, so camera children
 * cannot be raycast by accident.
 *
 *     const hands = new FirstPersonHands(station.materials);
 *     camera.add(hands.object3D);
 *     ticker.onRender((_alpha, dt) => hands.update(dt, player, camera));
 */

import * as THREE from 'three';
import type { Gait, GravityMode, PlayerState, Vec3 } from '@shared/types';
import { BOB_AMPLITUDE_M, PLAYER_RADIUS, SPEED_SPRINT } from '@shared/constants';
import { assertPolyBudget, chamferedBox, mergeParts, triangleCount } from '../station/artKit';
import { PALETTE, StationMaterials, build } from '../station/materials';
import { buildHeldItem } from '../station/items';
import type { ItemKind } from '../station/items';

// ===========================================================================
// Dimensions
// ===========================================================================

/**
 * m — where the elbow pivot sits in camera space.
 *
 * Solved against the frame, not guessed. main.ts runs a 75° vertical FOV with a
 * 0.05 m near plane, so at the 0.30 m the gloves live at the visible half-height
 * is 0.23 m and the half-width 0.41 m. This puts the elbow just BEHIND the eye
 * (+Z) and 0.13 m below it, so the sleeves are clipped by the near plane instead
 * of ending in a floating stump, and the resting glove sits exactly on the
 * bottom edge — present, not in the way.
 *
 * `x` was 0.28 — 68% of the half-width at glove depth — which parked each hand
 * hard against its frame edge, where the near-plane perspective stretches it
 * into a fisheye smear the playtest read as "way too big". Two passes brought
 * it in: 0.19 (middle third), then 0.15 after the second playtest still read
 * the arms as far apart — they now rest together, framing the crosshair's
 * lower half the way a pair of arms held in front of the chest actually does.
 */
const ELBOW = { x: 0.15, y: -0.08, z: 0.06 };

/** m — sleeve seal ring. */
const CUFF_L = 0.04;
const PALM_L = 0.042;
const FINGER_L = 0.054;
/** m — where the knuckle line sits relative to the wrist end of the forearm. */
const WRIST_TO_KNUCKLE = CUFF_L + PALM_L - 0.012;

/**
 * m — clearance kept between the resting fingertips and the closest a wall can
 * ever be.
 *
 * Two centimetres, and it exists because the reach below is now DERIVED from
 * `PLAYER_RADIUS`: without a margin the gloves would sit exactly on the surface
 * the collider stops at, and every rounding difference between the sweep's
 * depenetration epsilon and the render transform would show as a fingertip
 * flickering through a bulkhead.
 */
const REST_REACH_MARGIN_M = 0.02;

/**
 * m — how far the fingertips reach ahead of the eye when the arm is aimed
 * straight forward.
 *
 * DERIVED from `PLAYER_RADIUS`, not authored. The swept collider guarantees the
 * eye is never closer than a body radius to a wall, so a resting arm can only
 * stay out of the wall if it is shorter than that radius — and the radius is a
 * §14 constant that moves. It moved: 0.35 → 0.30 in the scale-down pass, at
 * which point the authored 0.313 m reach was 1.3 cm PAST the collider's own
 * guarantee and both gloves were inside every wall the player faced. The guard
 * in `assertHandsCoherent` did not fire because it compared against a literal
 * 0.35 that had stopped being the radius.
 *
 * The `reach` pose deliberately exceeds this — it is aimed at a handrail, and a
 * hand closing on a rail is *supposed* to be in it.
 */
export const HANDS_REST_REACH_M = PLAYER_RADIUS - REST_REACH_MARGIN_M;

/**
 * m — visible forearm, solved so the fingertips land exactly on
 * `HANDS_REST_REACH_M`.
 *
 * Shorter than an anatomical one, and it always was: the elbow is behind the
 * camera, so the only length that matters is the one that has to stay inside
 * `PLAYER_RADIUS`. Making that relationship the DEFINITION rather than a
 * comment is the whole point — the arm now tracks the body instead of drifting
 * out of it the next time §14 resizes the player.
 */
const FOREARM_L = HANDS_REST_REACH_M + ELBOW.z - FINGER_L - WRIST_TO_KNUCKLE;

/** m — how far along the arm the knuckle line sits. */
const KNUCKLE_Z = -(FOREARM_L + WRIST_TO_KNUCKLE);

// ===========================================================================
// Geometry
// ===========================================================================

/**
 * A tapered tube running along −Z from the joint: everything on an arm points
 * away from you.
 *
 * `rotateX(+π/2)` and not −: it maps +Y onto +Z (the same convention
 * `artKit.orientAxis` uses), so the near radius ends up at z = 0 and the tube
 * grows toward −Z. Getting the sign wrong builds every arm backwards through
 * the camera, which is invisible in a triangle count.
 */
function zTube(rNear: number, rFar: number, len: number, seg = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rNear, rFar, len, seg, 1, false);
  g.translate(0, -len / 2, 0);
  g.rotateX(Math.PI / 2);
  return g;
}

function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  return g;
}

/**
 * Suit cuff, forearm and the back of the glove, built at the elbow.
 *
 * The four knuckle plates are the detail that earns its triangles: they are the
 * only hard edges on the asset, so they are what catches a rim of light when the
 * torch is pointed anywhere near a wall, and they give the hand an orientation
 * you can read even when the fingers are in shadow.
 */
function buildLimb(side: -1 | 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Sleeve, elbow to wrist. Cross-sections sized to a forearm in a suit sleeve,
  // not a padded gauntlet: at 0.3 m from the eye every extra centimetre of
  // radius reads as three, and the playtest verdict on the first sizing was
  // simply "way too big".
  parts.push(at(zTube(0.04, 0.032, FOREARM_L), 0, 0, 0));
  // Cuff: a hard ring where the glove meets the sleeve, FLARED outward toward
  // the hand so the join reads as a seal — which is what an EVA cuff is, and the
  // one hard silhouette break between shoulder and knuckle.
  parts.push(at(zTube(0.043, 0.048, CUFF_L), 0, 0, -FOREARM_L + 0.012));

  const palmZ = -FOREARM_L - CUFF_L - PALM_L / 2 + 0.012;
  parts.push(at(chamferedBox({ x: 0.062, y: 0.036, z: PALM_L + 0.012 }, 0.009), 0, 0, palmZ));
  for (let i = 0; i < 4; i++) {
    const x = (-0.0216 + i * 0.0144) * side;
    parts.push(at(new THREE.BoxGeometry(0.0122, 0.0075, 0.019), x, 0.02, palmZ - 0.009));
  }

  const g = mergeParts(parts);
  g.name = `hand-limb-${side < 0 ? 'l' : 'r'}`;
  return g;
}

/**
 * Four fingers and a thumb, built at the knuckle line and pointing −Z.
 *
 * Their own mesh, and their own material, because the grip is the animation
 * that matters: this node rotates as one unit from spread to fist, which reads
 * as a hand closing without a single finger bone. Two draw calls per hand buys
 * the entire vocabulary — open, relaxed, closed, braced.
 */
function buildDigits(side: -1 | 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const x = (-0.0216 + i * 0.0144) * side;
    // Middle fingers longer, like fingers.
    const len = FINGER_L * (i === 1 || i === 2 ? 1 : 0.86);
    const finger = zTube(0.0072, 0.006, len, 6);
    finger.rotateY(((i - 1.5) * 0.06) * side);
    parts.push(at(finger, x, 0.002, -len / 2));
  }
  const thumb = zTube(0.0092, 0.0072, FINGER_L * 0.8, 6);
  thumb.rotateY(-0.85 * side);
  thumb.rotateX(0.25);
  parts.push(at(thumb, 0.028 * side, -0.011, -0.015));

  const g = mergeParts(parts);
  g.name = `hand-digits-${side < 0 ? 'l' : 'r'}`;
  return g;
}

// ===========================================================================
// Poses
// ===========================================================================

/**
 * One arm pose. Angles are radians in camera space, so a positive `pitch` tips
 * the forearm up into frame and a positive `yaw` swings it left.
 */
interface ArmPose {
  /** rad — forearm elevation. Negative points down out of frame. */
  readonly pitch: number;
  /** rad — inward swing. Signed per side by the caller. */
  readonly yaw: number;
  /** rad — roll about the forearm. */
  readonly roll: number;
  /** rad — finger curl. Negative closes the hand. */
  readonly curl: number;
  /** m — how far the whole arm slides forward along −Z. */
  readonly push: number;
}

/** Arms down, out of the way. The default, and what the player sees most. */
const IDLE: ArmPose = { pitch: -0.27, yaw: 0.2, roll: 0.12, curl: -0.42, push: 0 };

/** Walking. Barely distinct from idle — a whisker looser, and the (small) bob
 *  does the rest. It was a visibly lower pose, and the transition every time
 *  the player stopped and started read as the arms jumping around the frame. */
const WALKING: ArmPose = { pitch: -0.29, yaw: 0.21, roll: 0.13, curl: -0.44, push: 0 };

/** Floating with nothing to hold: arms drift up and open, because there is no
 *  down to hang from. This is the pose that says "zero-G" without a caption. */
const FLOATING: ArmPose = { pitch: -0.1, yaw: 0.14, roll: -0.05, curl: -0.2, push: 0.02 };

/** Closed on a rail. The arm's aim is overridden by the rail direction; this
 *  supplies the fist and the pull-in. */
const GRIPPING: ArmPose = { pitch: 0.05, yaw: 0.1, roll: 0.05, curl: -1.35, push: 0.05 };

/** Charging a push-off (§4). Hauled in against the rail, knuckles white. */
// Yaws re-tuned at the fourth crew-scale pass: reach derives from
// PLAYER_RADIUS, so the smaller body brought the gloves nearer the camera and
// the old angles pushed both fingertips off frame (1.02x / 1.23x extent).
const CHARGING: ArmPose = { pitch: 0.1, yaw: 0.115, roll: 0.08, curl: -1.5, push: 0.015 };

/** Impact. Both arms up and fingers SPREAD — the involuntary one. */
const BRACING: ArmPose = { pitch: 0.62, yaw: 0.34, roll: -0.2, curl: 0.28, push: 0.09 };

/** Inside a hide spot. Pulled in tight against the chest, hands curled. There
 *  is nowhere for an arm to go inside a locker, and that should feel true. */
const HIDING: ArmPose = { pitch: 0.5, yaw: 0.62, roll: 0.3, curl: -1.2, push: 0.11 };

/** The hand with the item in it. Raised and turned in so the carryable's own
 *  amber lamp is on screen — which is how the player knows they are holding it. */
const HOLDING: ArmPose = { pitch: -0.02, yaw: 0.25, roll: 0.1, curl: -1.05, push: 0.045 };

/** Reaching, but not yet gripping: a rail is in range. Aim overrides pitch/yaw;
 *  the fingers open in anticipation. */
const REACHING: ArmPose = { pitch: 0.05, yaw: 0.12, roll: 0.02, curl: -0.16, push: 0.06 };

type PoseAccum = { -readonly [K in keyof ArmPose]: number };

const POSE_KEYS: ReadonlyArray<keyof ArmPose> = Object.freeze([
  'pitch',
  'yaw',
  'roll',
  'curl',
  'push',
]);

function approach(current: number, target: number, rate: number, dt: number): number {
  const k = 1 - Math.exp(-rate * dt);
  return current + (target - current) * k;
}

/** rate — how fast a pose lands. Fast enough that a grab feels like the same
 *  input frame, slow enough that it is a movement rather than a cut. */
const POSE_RATE = 13;
/** rate — a brace decays slower than it arrives; that asymmetry is the flinch. */
const BRACE_DECAY = 3.4;

// ===========================================================================
// FirstPersonHands
// ===========================================================================

/**
 * What the hands need to know. Structurally satisfied by `Player` itself, so
 * `hands.update(dt, player, camera)` needs no adapter and cannot drift out of
 * sync with the controller.
 */
export interface HandsInput {
  readonly gravityMode: GravityMode;
  readonly state: PlayerState;
  readonly gait: Gait;
  readonly speed: number;
  /** 0..1 push-off charge (§4). */
  readonly charge: number;
  /** 0..1 through one stride, from the walk controller. */
  readonly stridePhase: number;
  /** Nearest grabbable rail, for the reach. `Player.nearestRail` fits. */
  readonly nearestRail?: { readonly point: Vec3; readonly distance: number } | null;
  /** Non-null while actually holding a rail. */
  readonly gripId?: string | null;
}

export interface HandsOptions {
  /** The station's one `StationMaterials`. Optional only so this can be built
   *  before the station is; without it the two materials it needs come from the
   *  sanctioned `build(PALETTE.…)` factory. */
  readonly materials?: StationMaterials | null;
  /** Draw the arms at all. A comfort/accessibility switch, not a debug flag. */
  readonly visible?: boolean;
  /** Metres the whole rig recoils on a brace. */
  readonly recoil?: number;
}

interface Side {
  readonly sign: -1 | 1;
  readonly arm: THREE.Object3D;
  readonly knuckle: THREE.Object3D;
  readonly grip: THREE.Object3D;
  readonly pose: PoseAccum;
  /** 0..1 blend toward the rail aim. */
  aim: number;
  /** Cached aim quaternion, slerped toward. */
  readonly aimQuat: THREE.Quaternion;
  readonly baseQuat: THREE.Quaternion;
}

const _v = new THREE.Vector3();
const _rail = new THREE.Vector3();
const _fwd = new THREE.Vector3(0, 0, -1);
const _euler = new THREE.Euler();
const _q = new THREE.Quaternion();

export class FirstPersonHands {
  /** Add to the CAMERA, not the scene: `camera.add(hands.object3D)`. The
   *  camera is already a scene child in main.ts, which is what makes camera
   *  children render at all. */
  readonly object3D: THREE.Group;

  private readonly sides: readonly [Side, Side];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly owned: THREE.Material[] = [];
  private readonly materials: StationMaterials | null;
  private readonly recoil: number;

  private held: ItemKind | null = null;
  private heldNode: THREE.Object3D | null = null;
  /**
   * One built-and-parented held form per kind, all but one of them invisible.
   *
   * The reason this is a cache and not a build-on-demand: `buildHeldItem` mints
   * two meshes and, the first time a kind is ever asked for, the geometry behind
   * them — and `Renderer.prewarm()` has already been and gone by the time
   * somebody picks a medkit up. A program linked mid-round is the first-visit
   * hitch this project has spent two passes killing. `preloadHeld` fills this at
   * load; `setHeld` then only ever toggles `visible`.
   */
  private readonly heldCache = new Map<ItemKind, THREE.Object3D>();
  private braceAmount = 0;
  private breath = Math.random() * Math.PI * 2;
  private lastSpeed = 0;
  /** 0..1 push-off charge, smoothed. Drives the pull-in and the shake. */
  private charge = 0;
  private shake = 0;
  /** Which arm reached last — kept across frames so the reach hand does not
   *  flip every time a rail crosses the centreline. */
  private lastReachSide: -1 | 1 = -1;

  constructor(opts: HandsOptions = {}) {
    this.materials = opts.materials ?? null;
    this.recoil = opts.recoil ?? 0.045;

    let sleeve: THREE.Material;
    let glove: THREE.Material;
    if (this.materials) {
      sleeve = this.materials.suit;
      // A step darker than the sleeve, not black: a tan grip glove. Black
      // fingers would vanish entirely at 5 candela and leave a pale arm ending
      // in nothing, which is worse than no contrast at all.
      glove = this.materials.plastic;
    } else {
      sleeve = build(PALETTE.suit);
      sleeve.name = 'suit-hands';
      glove = build(PALETTE.plastic);
      glove.name = 'plastic-hands';
      this.owned.push(sleeve, glove);
    }

    this.object3D = new THREE.Group();
    this.object3D.name = 'first-person-hands';
    this.object3D.visible = opts.visible !== false;
    // Camera-space geometry sits partly behind the near plane and hard against
    // the frame edges, where three's sphere test guesses wrong.
    this.object3D.frustumCulled = false;

    const build3 = (sign: -1 | 1): Side => {
      const arm = new THREE.Object3D();
      arm.name = `arm-${sign < 0 ? 'l' : 'r'}`;
      arm.position.set(ELBOW.x * sign, ELBOW.y, ELBOW.z);
      this.object3D.add(arm);

      const limb = new THREE.Mesh(buildLimb(sign), sleeve);
      limb.name = `limb-${sign < 0 ? 'l' : 'r'}`;
      this.harden(limb);
      arm.add(limb);

      const knuckle = new THREE.Object3D();
      knuckle.name = `knuckle-${sign < 0 ? 'l' : 'r'}`;
      knuckle.position.set(0, 0, KNUCKLE_Z);
      arm.add(knuckle);

      const digits = new THREE.Mesh(buildDigits(sign), glove);
      digits.name = `digits-${sign < 0 ? 'l' : 'r'}`;
      this.harden(digits);
      knuckle.add(digits);

      // Where a carryable's grip point goes. Rotated back out of the hold pose
      // so an item parented here reads as pointing away from the holder rather
      // than across their chest — `buildHeldItem` promises holder axes
      // (+X right, +Y up, −Z forward) and this is the node that supplies them.
      const grip = new THREE.Object3D();
      grip.name = `grip-${sign < 0 ? 'l' : 'r'}`;
      grip.position.set(0, -0.012, -0.02);
      grip.rotation.set(0.2, -0.34 * sign, -0.12 * sign);
      knuckle.add(grip);

      return {
        sign,
        arm,
        knuckle,
        grip,
        pose: { ...IDLE },
        aim: 0,
        aimQuat: new THREE.Quaternion(),
        baseQuat: new THREE.Quaternion(),
      };
    };

    this.sides = [build3(-1), build3(1)];
    this.applyPose(0);
  }

  // -- reads ---------------------------------------------------------------

  /** Draw calls: four for the arms, plus two more while carrying something. */
  get drawCalls(): number {
    if (!this.object3D.visible) return 0;
    return this.meshes.length + (this.heldNode ? 2 : 0);
  }

  /** Triangles for both arms. The item's own count is the carryables agent's. */
  get triangles(): number {
    let n = 0;
    for (const m of this.meshes) n += triangleCount(m.geometry);
    return n;
  }

  get bracing(): number {
    return this.braceAmount;
  }

  get holding(): ItemKind | null {
    return this.held;
  }

  // -- commands ------------------------------------------------------------

  /**
   * Put a carryable in the right hand, or `null` to empty it.
   *
   * Built through `buildHeldItem`, so the item's own pose, grip point and amber
   * lamp all come from `src/station/items.ts` and this file never learns what
   * any of the six items look like.
   */
  setHeld(kind: ItemKind | null): void {
    if (kind === this.held) return;
    this.held = kind;
    if (this.heldNode) {
      // Hidden, never disposed and never even unparented. `itemModel` caches and
      // SHARES item geometry across every world instance and every held mesh of
      // that kind, so disposing it here would blank every medkit in the station
      // — and re-parenting is how a mid-round allocation sneaks back in.
      this.heldNode.visible = false;
      this.heldNode = null;
    }
    if (!kind) return;
    const node = this.heldCache.get(kind) ?? this.buildHeld(kind);
    if (!node) return;
    node.visible = true;
    this.heldNode = node;
  }

  /**
   * Build the held form of every kind NOW, before `Renderer.prewarm()`.
   *
   * Call it once, at load, with `ITEM_KINDS`. Returns how many were built, which
   * is 0 when no `StationMaterials` was supplied — worth logging, because the
   * failure mode is otherwise an empty hand on first pickup.
   */
  preloadHeld(kinds: Iterable<ItemKind>): number {
    let built = 0;
    for (const kind of kinds) {
      if (this.heldCache.has(kind)) continue;
      if (this.buildHeld(kind)) built++;
    }
    return built;
  }

  /** Draw one kind's held form and park it, invisible, on the right hand. */
  private buildHeld(kind: ItemKind): THREE.Object3D | null {
    const materials = this.materials;
    if (!materials) {
      // `buildHeldItem` needs the station's material set for the item body and
      // its accent; refusing quietly beats inventing a second copy of both.
      return null;
    }
    const node = buildHeldItem(kind, materials, { name: `held-${kind}` });
    node.visible = false;
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        // A view model in the one shadow map is a black bar across the screen,
        // and camera-space geometry defeats three's sphere test at the frame
        // edges — the same two decisions `harden()` makes for the arms.
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        mesh.userData.noShadow = true;
        mesh.userData.noCollide = true;
      }
    });
    (this.sides[1] as Side).grip.add(node);
    this.heldCache.set(kind, node);
    return node;
  }

  /**
   * Flinch. `strength` is 0..1 — feed it the impact's approach speed over
   * `PUSH_MAX`, or just call `brace(1)` on a crash.
   *
   * §4 prices a catch at 26 and a crash at 51 and the player must be able to
   * tell which happened without reading a number, so the flinch scales.
   */
  brace(strength: number): void {
    const s = strength < 0 ? 0 : strength > 1 ? 1 : strength;
    if (s > this.braceAmount) this.braceAmount = s;
  }

  setVisible(visible: boolean): void {
    this.object3D.visible = visible;
  }

  // -- per-frame -----------------------------------------------------------

  /**
   * One frame. Call at render rate with the real delta, after `player.update`
   * so the camera transform the rail aim is resolved against is this frame's.
   */
  update(dt: number, input: HandsInput, camera?: THREE.Camera): void {
    if (dt > 0) {
      this.breath = (this.breath + dt * 1.15) % (Math.PI * 2);
      // Auto-flinch. A sudden loss of speed is a catch or a crash, and reading
      // it here means the hands work whether or not anybody wires `brace()`.
      const drop = this.lastSpeed - input.speed;
      if (drop > 1.4) this.brace(Math.min(1, drop / SPEED_SPRINT));
      this.lastSpeed = input.speed;
      this.braceAmount = approach(this.braceAmount, 0, BRACE_DECAY, dt);
      if (this.braceAmount < 0.002) this.braceAmount = 0;
      // §4's push-off charges while you hold Space on a rail. The arm hauling
      // itself in against the rail, and the shake as it loads, is the only
      // diegetic readout of a number the player is otherwise guessing at.
      this.charge = approach(this.charge, input.charge, 14, dt);
      this.shake = (this.shake + dt * 34) % (Math.PI * 2);
    }

    const hidden = input.state === 'HIDDEN';
    const gripped = input.state === 'GRIPPING' || input.state === 'CHARGING';
    const charging = input.state === 'CHARGING';
    const floating = input.state === 'FLOATING';
    const walking = input.state === 'GROUNDED' && input.speed > 0.15;

    // Which hand reaches. The one on the rail's side, unless it is busy holding
    // something — in which case the other one does, which is exactly what a
    // person carrying a box does when they need a handhold.
    //
    // ONLY when a rail matters: floating, gripping, or in a zero-G module.
    // Walking on a deck, the overhead rails are always "nearest", and the arms
    // spent the whole walk snapping into reach poses and swapping sides every
    // time the rail crossed the centreline — the "hands swap location a lot"
    // playtest note. On a floor your hands are your hands, not grab hardware.
    const rail = input.nearestRail ?? null;
    const canAim =
      rail !== null &&
      camera !== undefined &&
      (floating || gripped || input.gravityMode === 'zero');
    let reachSide: -1 | 1 = this.lastReachSide;
    if (canAim && rail && camera) {
      _rail.set(rail.point.x, rail.point.y, rail.point.z);
      // The camera's world matrix is whatever `player.update` last wrote; the
      // renderer has not run yet this frame, so refresh it or the arm aims at
      // where the rail was one frame ago.
      camera.updateMatrixWorld();
      camera.worldToLocal(_rail);
      // Hysteresis: only change hands once the rail is clearly on the other
      // side. A rail drifting across the centreline used to flip the reach
      // arm every few frames.
      if (Math.abs(_rail.x) > 0.25) reachSide = _rail.x >= 0 ? 1 : -1;
      if (this.heldNode && reachSide === 1) reachSide = -1;
      this.lastReachSide = reachSide;
    }

    for (let i = 0; i < 2; i++) {
      const side = this.sides[i] as Side;
      const isReacher = canAim && side.sign === reachSide;
      const target = this.targetFor(side, input, {
        hidden,
        gripped,
        charging,
        floating,
        walking,
        isReacher,
      });

      if (dt > 0) {
        for (const key of POSE_KEYS) {
          side.pose[key] = approach(side.pose[key], target[key], POSE_RATE, dt);
        }
        // Aim weight: full while gripping, partial while merely in reach.
        const wantAim = isReacher ? (gripped ? 1 : 0.7) : 0;
        side.aim = approach(side.aim, wantAim, 11, dt);
      }

      if (isReacher && side.aim > 0.001) this.computeAim(side, _rail);
    }

    this.applyPose(dt, input);
  }

  dispose(): void {
    this.object3D.removeFromParent();
    for (const node of this.heldCache.values()) node.removeFromParent();
    this.heldCache.clear();
    this.heldNode = null;
    // Only the arms' own buffers: the held items point at `itemModel`'s shared
    // geometry, which outlives any one pair of hands.
    for (const m of this.meshes) m.geometry.dispose();
    for (const m of this.owned) m.dispose();
  }

  // -- internals -----------------------------------------------------------

  private harden(mesh: THREE.Mesh): void {
    // A view model in the one shadow map is a black bar across the screen, and
    // it is never in the BVH because `setInteractables` takes an explicit list.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.userData.noShadow = true;
    mesh.userData.noCollide = true;
    this.meshes.push(mesh);
  }

  private targetFor(
    side: Side,
    input: HandsInput,
    f: {
      hidden: boolean;
      gripped: boolean;
      charging: boolean;
      floating: boolean;
      walking: boolean;
      isReacher: boolean;
    },
  ): ArmPose {
    const holdingThis = this.heldNode !== null && side.sign === 1;
    if (f.hidden) return HIDING;
    if (this.braceAmount > 0.35) return BRACING;
    if (f.isReacher) {
      if (f.charging) return CHARGING;
      if (f.gripped) return GRIPPING;
      return REACHING;
    }
    if (holdingThis) return HOLDING;
    if (f.gripped) return GRIPPING;
    if (f.floating || input.gravityMode === 'zero') return FLOATING;
    if (f.walking) return WALKING;
    return IDLE;
  }

  /**
   * Point the arm at the rail.
   *
   * `_v` is already the rail point in camera space. Aim from the elbow, and
   * clamp nothing: if the rail is further than the arm is long the hand simply
   * points at it, which is what reaching looks like.
   */
  private computeAim(side: Side, cameraSpacePoint: THREE.Vector3): void {
    const dir = _v
      .copy(cameraSpacePoint)
      .sub(side.arm.position)
      .normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) {
      side.aimQuat.identity();
      return;
    }
    side.aimQuat.setFromUnitVectors(_fwd, dir);
  }

  private applyPose(dt: number, input?: HandsInput): void {
    // Breathing, the walk bob, and the recoil, all on the rig root so both arms
    // share them — they come from the body, not from an arm.
    const breathe = Math.sin(this.breath) * 0.004;
    let bobY = 0;
    let bobX = 0;
    if (input) {
      const phase = input.stridePhase * Math.PI * 2;
      const amp = Math.min(1, input.speed / SPEED_SPRINT);
      // Against the head bob, not with it: the head rises and the hands fall,
      // which is what makes a walk feel weighted instead of floaty. TINY. At
      // 0.55×/0.35× of BOB_AMPLITUDE_M the arms pumped through a quarter of
      // the frame every stride — "they go up and down really far" — and since
      // the camera already bobs, the view model only needs a residual of its
      // own for the weight to read.
      bobY = -BOB_AMPLITUDE_M * amp * 0.16 * Math.sin(phase * 2);
      bobX = BOB_AMPLITUDE_M * amp * 0.09 * Math.sin(phase);
    }
    const recoil = this.braceAmount * this.recoil;
    // Charge tremble: small, fast, and it grows with the charge so a full-power
    // push-off looks like one before it is one.
    const tremor = this.charge * this.charge * 0.006;
    this.object3D.position.set(
      bobX + Math.sin(this.shake * 1.7) * tremor,
      breathe + bobY + Math.sin(this.shake) * tremor,
      recoil,
    );

    for (const side of this.sides) {
      const p = side.pose;
      _euler.set(p.pitch, p.yaw * side.sign, p.roll * side.sign, 'XYZ');
      side.baseQuat.setFromEuler(_euler);
      if (side.aim > 0.001) {
        _q.copy(side.baseQuat).slerp(side.aimQuat, side.aim);
        side.arm.quaternion.copy(_q);
      } else {
        side.arm.quaternion.copy(side.baseQuat);
      }
      // Charge pulls the whole arm in toward the rail it is loading against.
      side.arm.position.set(
        ELBOW.x * side.sign,
        ELBOW.y,
        ELBOW.z - p.push + this.charge * 0.028 * side.aim,
      );
      side.knuckle.rotation.set(p.curl, 0, 0);
    }
    if (dt <= 0) this.object3D.updateMatrixWorld(true);
  }
}

// ===========================================================================
// Self-check
// ===========================================================================

export class HandsCoherenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandsCoherenceError';
  }
}

/** The named poses, for the framing check below. */
const NAMED_POSES: ReadonlyArray<readonly [string, ArmPose]> = Object.freeze([
  ['IDLE', IDLE],
  ['WALKING', WALKING],
  ['FLOATING', FLOATING],
  ['GRIPPING', GRIPPING],
  ['CHARGING', CHARGING],
  ['BRACING', BRACING],
  ['HIDING', HIDING],
  ['HOLDING', HOLDING],
  ['REACHING', REACHING],
]);

/** Poses whose whole job is to be LOOKED at. If one of these leaves the frame
 *  the feature silently does not exist, which is exactly the failure a triangle
 *  count cannot see. */
const MUST_BE_ON_SCREEN: ReadonlySet<string> = new Set([
  'GRIPPING',
  'CHARGING',
  'BRACING',
  'HIDING',
  'HOLDING',
  'REACHING',
  'FLOATING',
]);

export interface HandsFrameProbe {
  readonly pose: string;
  readonly tip: { x: number; y: number; z: number };
  /** Frame half-extents at the fingertip's own depth. */
  readonly halfW: number;
  readonly halfH: number;
  readonly onScreen: boolean;
  /** Fraction of the frame half-extent the tip sits at. Under 1 is inside. */
  readonly extent: number;
}

/**
 * Where the right fingertip actually lands in the frame, per pose.
 *
 * This is the substitute for looking at the screen, and it earns its keep: a
 * view model is trivially easy to build correctly and place entirely below the
 * bottom edge, and nothing else in this file — not the triangle count, not the
 * poly budget, not the reach guard — would notice. Defaults match main.ts's
 * camera (75° vertical, 0.05 near).
 */
export function handsFrameReport(fovDeg = 75, aspect = 16 / 9): HandsFrameProbe[] {
  const half = Math.tan((fovDeg * Math.PI) / 360);
  const out: HandsFrameProbe[] = [];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const tip = new THREE.Vector3();
  for (const [name, p] of NAMED_POSES) {
    // Right hand, sign +1 — the one that holds things.
    e.set(p.pitch, p.yaw, p.roll, 'XYZ');
    q.setFromEuler(e);
    // Knuckle line, then the curl, then the finger.
    tip.set(0, 0, -FINGER_L).applyAxisAngle(new THREE.Vector3(1, 0, 0), p.curl);
    tip.z += KNUCKLE_Z;
    tip.applyQuaternion(q);
    tip.x += ELBOW.x;
    tip.y += ELBOW.y;
    tip.z += ELBOW.z - p.push;
    const depth = -tip.z;
    const halfH = depth > 0 ? depth * half : 0;
    const halfW = halfH * aspect;
    const extent =
      halfH > 0 ? Math.max(Math.abs(tip.y) / halfH, Math.abs(tip.x) / halfW) : Infinity;
    out.push({
      pose: name,
      tip: { x: tip.x, y: tip.y, z: tip.z },
      halfW,
      halfH,
      onScreen: depth > 0.05 && extent <= 1,
      extent,
    });
  }
  return out;
}

export function handsGeometryReport(): { limb: number; digits: number; total: number } {
  const l = buildLimb(-1);
  const d = buildDigits(-1);
  const limb = triangleCount(l);
  const digits = triangleCount(d);
  l.dispose();
  d.dispose();
  return { limb, digits, total: (limb + digits) * 2 };
}

/**
 * Prove the arms are arms and that they fit inside the body they belong to.
 *
 * The one thing that can go silently wrong: growing the rest pose past
 * `PLAYER_RADIUS`, at which point the gloves start intersecting every wall the
 * collider is happily sliding along, and the fix looks like a rendering bug.
 */
export function assertHandsCoherent(): void {
  const failures: string[] = [];
  const report = handsGeometryReport();
  // The bible's own band for ISS-CHR-02, not artKit's generic one.
  if (report.total < 400) {
    failures.push(`${report.total} triangles for both arms, under the bible's 400 floor`);
  }
  if (report.total > 700) {
    failures.push(`${report.total} triangles for both arms, over the bible's 700 ceiling`);
  }
  // Against the LIVE constant, never a literal. The literal 0.35 that used to be
  // here is precisely why the reach survived the scale-down pass unnoticed.
  if (HANDS_REST_REACH_M >= PLAYER_RADIUS) {
    failures.push(
      `rest reach ${HANDS_REST_REACH_M.toFixed(3)} m reaches PLAYER_RADIUS ` +
        `${PLAYER_RADIUS} — a resting glove would clip every wall the collider slides along`,
    );
  }
  if (FOREARM_L <= 0.1) {
    failures.push(
      `forearm solved to ${FOREARM_L.toFixed(3)} m — PLAYER_RADIUS ${PLAYER_RADIUS} no longer ` +
        `leaves room for an arm between the elbow and the fingertips`,
    );
  }

  for (const probe of handsFrameReport()) {
    if (-probe.tip.z <= 0.05) {
      failures.push(
        `${probe.pose}: fingertip at z ${probe.tip.z.toFixed(3)} is behind the 0.05 m near ` +
          `plane — the whole hand is clipped away`,
      );
      continue;
    }
    if (MUST_BE_ON_SCREEN.has(probe.pose) && !probe.onScreen) {
      failures.push(
        `${probe.pose}: fingertip at ${probe.extent.toFixed(2)}× the frame half-extent, i.e. ` +
          `off screen — this pose exists to be seen`,
      );
    }
    // Idle and walking are ALLOWED to sit on the bottom edge ("stay out of the
    // way"), but not to leave the frame entirely: if they do, the player never
    // learns they have arms at all.
    if (!MUST_BE_ON_SCREEN.has(probe.pose) && probe.extent > 1.35) {
      failures.push(
        `${probe.pose}: fingertip at ${probe.extent.toFixed(2)}× the frame half-extent — ` +
          `resting arms should graze the bottom edge, not vanish below it`,
      );
    }
  }
  if (failures.length > 0) {
    throw new HandsCoherenceError(
      `first-person hands (ISS-CHR-02) contradict their brief:\n  - ${failures.join('\n  - ')}`,
    );
  }
}

function isDevEnvironment(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env && typeof env.DEV === 'boolean') return env.DEV;
  } catch {
    /* plain Node — fall through */
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc && proc.env) return proc.env.NODE_ENV !== 'production';
  return true;
}

/** True when the check ran and passed at import (dev only). */
export const HANDS_CHECKED: boolean = (() => {
  if (!isDevEnvironment()) return false;
  assertHandsCoherent();
  const probe = buildLimb(-1);
  assertPolyBudget(probe, { label: 'gloved forearm', min: 100, max: 220 }, 'gloved forearm');
  probe.dispose();
  return true;
})();
