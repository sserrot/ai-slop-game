/**
 * ISS-CHR-01 — the alien's body (DESIGN.md §5 / §9, asset bible "Characters").
 *
 * §9 promised "long, thin, pale, moving by pulling along the same rails you do"
 * and shipped a `CapsuleGeometry` instead, on the correct grounds that horror
 * lives in audio and lighting. That capsule is now the single largest art debt
 * in the project, because after the r3 gravity pivot the monster has to say
 * something the capsule cannot say at all.
 *
 * **WHAT THIS ASSET IS FOR.** §5 gives the alien three speeds — patrol 1.5,
 * search 1.2, hunt 3.0 — and the whole chase design is the player reading which
 * one is coming down the corridor at them. Audio carries most of that, but a
 * SEARCH sweep and a HUNT charge look completely different and the player's life
 * depends on the difference. So the budget goes where the bible says it goes:
 *
 *   > spend the budget on ANIMATION not mesh … its gait is how you read its
 *   > state from down a corridor.
 *
 * 972 triangles across nine body parts drawn in SIX draw calls — left and
 * right limbs are two instances of one geometry — and every part moves.
 *
 * **NO EYES.** Not a stylistic choice — a mechanical one. It hunts by sound
 * (§5: "Perception is sound + contact only. No vision cone, ever"), and glowing
 * eyes would teach the player, wordlessly and every single frame, that the thing
 * can see them. Pillar 3 is legibility; two glowing dots would be a lie told
 * ten times a second. Its cue is **pale value against a dark hull** and nothing
 * else, which is why `materials.organic` carries no emissive and this file never
 * touches a material after construction. `assertInert` holds that promise.
 *
 * **TWO LOCOMOTIONS**, because r3 gave it two floors:
 *
 *   • WALK, in `gravity: 'nominal'` modules. `server/sim/alien.ts` rides the
 *     deck at `DECK_Y_M + ALIEN_RADIUS`, so the transform this view receives
 *     sits exactly 0.45 m above the plating — which is why the body is built as
 *     a low quadrupedal stalk with its spine horizontal at that height and its
 *     four limbs folded down onto the deck, rather than an upright figure that
 *     would need an offset nobody would remember to apply.
 *   • RAIL-PULL, in `gravity: 'zero'` modules. Same rig, straightened along the
 *     travel axis, hauling hand over hand with the legs trailing. §5's one
 *     genuinely nice property — "it pulls along the same handrails in a room
 *     you are walking through as in one you are floating in" — survives
 *     because the arms are the same arms.
 *
 * A pure view. It never simulates anything; the AI is server-authoritative
 * (§7). It interpolates the transform the server sends and poses itself.
 *
 *     const view = new AlienView({ materials: station.materials });
 *     scene.add(view.object3D);
 *     ticker.onRender((alpha, dt) => view.update(alpha, dt));
 */

import * as THREE from 'three';
import type {
  AlienSnapshot,
  AlienState,
  GravityMode,
  ModuleId,
  Quat,
  Vec3,
} from '@shared/types';
import { DECK_HEADROOM_M } from '@shared/constants';
import {
  POLY_BUDGETS,
  assertInert,
  assertPolyBudget,
  chamferedBox,
  mergeParts,
  orientAxis,
  triangleCount,
} from '../station/artKit';
import { PALETTE, StationMaterials, build } from '../station/materials';
import { PartInstances } from '../player/bodyView';
import { bus } from '../core/eventBus';
import type { Unsubscribe } from '../core/eventBus';

/**
 * m — body radius. Mirrors `ALIEN_RADIUS` in `server/sim/alien.ts`, which is the
 * contact range's half AND the height its centre rides above a deck. Neither is
 * a §14 constant; if you tune one, tune both — the server decides who dies,
 * this only decides what you see.
 */
export const ALIEN_VIEW_RADIUS = 0.45;

/**
 * m — nose to tail tip. The bible's own figure for ISS-CHR-01.
 *
 * Was 1.6 when the body was a capsule, and the change is the point: 2.40 m of
 * thin thing is more than twice the length of a 1.70 m crewmate's HEIGHT while
 * being a third of its width, so the two silhouettes cannot be confused even
 * before either of them moves.
 */
export const ALIEN_VIEW_LENGTH = 2.4;

/**
 * m — where the body centre sits above a walking deck. Not a free parameter:
 * `server/sim/alien.ts` sets `DECK_RIDE_HEIGHT_M = DECK_Y_M + ALIEN_RADIUS` and
 * this view is handed the result, so the deck is always exactly this far below
 * the rig origin and the limb poses below are solved against that.
 */
export const ALIEN_DECK_DROP_M = ALIEN_VIEW_RADIUS;

/** m — stride length, for turning the server's speed into a cadence. Long
 *  limbs, long stride: at patrol 1.5 m/s that is 1.25 steps a second, at hunt
 *  3.0 m/s it is 2.5, and the two are unmistakable from down a corridor. */
export const ALIEN_STRIDE_M = 1.2;

/** Above this many metres between two snapshots we assume a teleport and snap
 *  rather than sliding the body across the station. */
const TELEPORT_SNAP_M = 12;

// ===========================================================================
// Skeleton dimensions
// ===========================================================================

const CHEST_Z = -0.25;
const CHEST_LEN = 0.58;
const CHEST_R_FRONT = 0.145;
const CHEST_R_BACK = 0.175;

const NECK_LEN = 0.34;
const SKULL_HALF = 0.165;

const PELVIS_Z = CHEST_Z + CHEST_LEN / 2;
const ABDOMEN_LEN = 0.46;
const TAIL_SEGS: ReadonlyArray<{ len: number; rNear: number; rFar: number; drop: number }> =
  Object.freeze([
    { len: 0.26, rNear: 0.1, rFar: 0.072, drop: 0 },
    { len: 0.24, rNear: 0.072, rFar: 0.046, drop: -0.02 },
    { len: 0.22, rNear: 0.046, rFar: 0.016, drop: -0.055 },
  ]);

const SHOULDER = { x: 0.195, y: 0.035, z: -0.2 };
const UPPER_ARM_L = 0.41;
const FOREARM_L = 0.62;
const HAND_L = 0.2;
const HIP = { x: 0.155, y: -0.01, z: 0.1 };
const THIGH_L = 0.34;
const SHIN_L = 0.36;
/**
 * Baked knee, radians, bending REARWARD.
 *
 * Solved against `WALK.hipSplay`, not chosen: `alienContactReport()` says a hip
 * at rig-local y ≈ −0.02 with a 0.55 rad splay puts this leg's foot on the deck
 * at −0.45 ± 0.10 across every state and every phase. Retune one and re-run it.
 *
 * A rigid dog-leg saves the two draw calls an articulated knee would cost, and
 * a hind leg's knee angle barely changes across a stride anyway — the hip
 * carries the motion, which is exactly what the front limbs' elbows do not do.
 */
const KNEE_BAKED = 1.3;

// ===========================================================================
// Geometry
// ===========================================================================

/**
 * A tapered tube laid along Z from the joint outward.
 *
 * Everything on this creature runs fore-and-aft, and three's cylinders run
 * along Y, so this is the one conversion the whole file needs. `dir` is −1 for
 * "toward the nose" and +1 for "toward the tail"; `rNear` is always the radius
 * at the joint, so the taper reads the same way in every call.
 */
function zTube(
  rNear: number,
  rFar: number,
  len: number,
  seg = 8,
  open = false,
  dir: -1 | 1 = -1,
): THREE.BufferGeometry {
  const g =
    dir < 0
      ? new THREE.CylinderGeometry(rNear, rFar, len, seg, 1, open)
      : new THREE.CylinderGeometry(rFar, rNear, len, seg, 1, open);
  g.translate(0, (dir < 0 ? -1 : 1) * (len / 2), 0);
  return orientAxis(g, 'z');
}

/** A tapered tube centred on the origin, `rBack` at +Z and `rFront` at −Z. */
function zTubeCentred(
  rBack: number,
  rFront: number,
  len: number,
  seg = 8,
  open = false,
): THREE.BufferGeometry {
  return orientAxis(new THREE.CylinderGeometry(rBack, rFront, len, seg, 1, open), 'z');
}

/** A tapered tube along −Y from the joint: every limb segment. */
function yLimb(rNear: number, rFar: number, len: number, seg = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rNear, rFar, len, seg, 1, false);
  g.translate(0, -len / 2, 0);
  return g;
}

/**
 * A blade: a four-sided cone squashed on one axis.
 *
 * Eight triangles, and it is the cheapest silhouette in the game. A row of them
 * along the spine gives the alien a serrated top edge, which is the one profile
 * cue that survives being seen from directly in front — the angle at which a
 * long thin thing is hardest to read.
 */
function blade(width: number, height: number, length: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.5, height, 4);
  g.scale(width * 2, 1, length * 2);
  g.translate(0, height / 2, 0);
  return g;
}

function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  return g;
}

/**
 * Thorax: the tapered spine section, a shoulder girdle, five dorsal blades and
 * four flank ribs. Built centred on the chest joint.
 */
function buildChest(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(zTubeCentred(CHEST_R_BACK, CHEST_R_FRONT, CHEST_LEN, 8));
  parts.push(at(chamferedBox({ x: 0.42, y: 0.1, z: 0.17 }, 0.02), 0, 0.03, -0.19));

  const blades: ReadonlyArray<[number, number]> = [
    [-0.22, 0.09],
    [-0.1, 0.13],
    [0.02, 0.12],
    [0.14, 0.1],
    [0.24, 0.07],
  ];
  for (const [z, h] of blades) {
    parts.push(at(blade(0.018, h, 0.055), 0, 0.135, z));
  }

  // Ribs. Angled backward as well as outward so the flanks read as swept, not
  // as spikes: this thing moves nose-first and the geometry should say so.
  for (const side of [-1, 1]) {
    for (const z of [-0.06, 0.12]) {
      const rib = blade(0.016, 0.1, 0.05);
      rib.rotateZ((side * Math.PI) / 2 - side * 0.35);
      rib.rotateY(side * 0.4);
      parts.push(at(rib, side * 0.13, -0.01, z));
    }
  }

  const g = mergeParts(parts);
  g.name = 'alien-chest';
  return g;
}

/**
 * Abdomen, hip girdle, two more blades and the whole tail, as one mesh.
 *
 * The tail is BAKED into the pelvis rather than jointed, and that is a
 * deliberate trade: the pelvis already rotates for the spine undulation, and a
 * 0.72 m tail hanging off a rotating joint sweeps a much bigger arc than the
 * joint itself does. Free amplification, one draw call, no tail bones.
 */
function buildAbdomen(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(zTube(CHEST_R_BACK, 0.115, ABDOMEN_LEN, 8, false, 1), 0, 0, 0));
  parts.push(at(chamferedBox({ x: 0.32, y: 0.09, z: 0.15 }, 0.02), 0, 0, 0.08));
  parts.push(at(blade(0.016, 0.1, 0.05), 0, 0.12, 0.1));
  parts.push(at(blade(0.014, 0.07, 0.045), 0, 0.1, 0.26));

  let z = ABDOMEN_LEN - 0.02;
  let y = 0;
  for (const seg of TAIL_SEGS) {
    y += seg.drop;
    parts.push(at(zTube(seg.rNear, seg.rFar, seg.len, 6, true, 1), 0, y, z));
    z += seg.len;
  }
  // Cap the last open tube so the tail ends in a point rather than a hole.
  const tip = new THREE.ConeGeometry(0.016, 0.06, 4);
  tip.rotateX(-Math.PI / 2);
  parts.push(at(tip, 0, y, z + 0.03));

  const g = mergeParts(parts);
  g.name = 'alien-abdomen';
  return g;
}

/**
 * Neck and head.
 *
 * The head is where "no eyes" has to be positive rather than absent: a smooth
 * ellipsoid stretched to 1.55× along the travel axis, with a hinged lower jaw
 * and two spines swept back off the crown. Long, tapering, featureless. Beside
 * a crewmate's helmet — a perfect sphere with a dark faceplate cut into it —
 * the two heads share no outline at all, and that is the pair the bible says
 * must never be confused.
 */
function buildHeadNeck(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(zTube(0.082, 0.07, NECK_LEN / 2, 6, true, -1), 0, 0, 0));
  parts.push(at(zTube(0.07, 0.058, NECK_LEN / 2, 6, true, -1), 0, -0.012, -NECK_LEN / 2));

  const skullZ = -NECK_LEN - SKULL_HALF + 0.045;
  const skull = new THREE.SphereGeometry(0.105, 8, 5);
  skull.scale(0.7, 0.78, SKULL_HALF / 0.105);
  parts.push(at(skull, 0, -0.018, skullZ));

  // Jaw. Hangs, slightly open — the only feature on the head, and it is a mouth
  // rather than an eye, which is the correct thing for a blind hunter to lead
  // with.
  const jaw = chamferedBox({ x: 0.062, y: 0.03, z: 0.2 }, 0.01);
  jaw.rotateX(0.22);
  parts.push(at(jaw, 0, -0.072, skullZ - 0.04));
  const tongue = new THREE.ConeGeometry(0.022, 0.11, 4);
  tongue.rotateX(-Math.PI / 2 + 0.3);
  parts.push(at(tongue, 0, -0.05, skullZ - 0.13));

  for (const side of [-1, 1]) {
    const spine = blade(0.012, 0.14, 0.03);
    spine.rotateX(1.15);
    spine.rotateZ(side * 0.4);
    parts.push(at(spine, side * 0.035, 0.02, skullZ + 0.1));
  }

  const g = mergeParts(parts);
  g.name = 'alien-head';
  return g;
}

/** Upper arm, built at the shoulder and hanging along −Y. */
function buildUpperArm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(yLimb(0.085, 0.078, 0.1, 8), 0, 0.045, 0));
  parts.push(at(yLimb(0.075, 0.055, UPPER_ARM_L, 8), 0, -0.01, 0));
  const g = mergeParts(parts);
  g.name = 'alien-upper-arm';
  return g;
}

/**
 * Forearm, palm and three long digits, built at the elbow.
 *
 * The digits are the reason this is a separate part from the upper arm. A rail
 * pull is a HAND closing on a rail and hauling, and the elbow is what makes
 * that a reach rather than a swing; with the elbow baked, the arm would sweep
 * like a windscreen wiper and the whole "it moves the way you do" idea would
 * die with it.
 */
function buildForearm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(yLimb(0.055, 0.03, FOREARM_L, 8), 0, 0, 0));
  parts.push(at(chamferedBox({ x: 0.085, y: 0.05, z: 0.115 }, 0.015), 0, -FOREARM_L - 0.02, 0));

  const wrist = -FOREARM_L - 0.04;
  for (const spread of [-0.34, 0, 0.34]) {
    const digit = new THREE.ConeGeometry(0.017, HAND_L, 4);
    digit.rotateX(Math.PI);
    digit.rotateZ(spread * 0.55);
    digit.rotateX(spread * 0.5);
    parts.push(at(digit, spread * 0.055, wrist - HAND_L / 2, 0));
  }

  const g = mergeParts(parts);
  g.name = 'alien-forearm';
  return g;
}

/** Hind leg: thigh, rearward-bent shin, ankle and three digits, as one rigid
 *  dog-leg built at the hip. */
function buildLeg(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(yLimb(0.082, 0.075, 0.09, 8), 0, 0.04, 0));
  parts.push(at(yLimb(0.072, 0.058, THIGH_L, 8), 0, 0, 0));

  const shin = yLimb(0.056, 0.038, SHIN_L, 8);
  shin.rotateX(-KNEE_BAKED);
  parts.push(at(shin, 0, -THIGH_L, 0));

  const footY = -THIGH_L - Math.cos(KNEE_BAKED) * SHIN_L;
  const footZ = Math.sin(KNEE_BAKED) * SHIN_L;
  parts.push(at(new THREE.BoxGeometry(0.07, 0.05, 0.09), 0, footY - 0.02, footZ));
  for (const spread of [-1, 0, 1]) {
    const digit = new THREE.ConeGeometry(0.014, 0.13, 4);
    digit.rotateX(-Math.PI / 2 - 0.25);
    digit.rotateY(spread * 0.4);
    parts.push(at(digit, spread * 0.028, footY - 0.03, footZ - 0.07));
  }

  const g = mergeParts(parts);
  g.name = 'alien-leg';
  return g;
}

// ===========================================================================
// Posture — the state machine the player actually reads
// ===========================================================================

/**
 * One §5 state, as a body.
 *
 * Every field is a thing you can see from 10 m down a dark corridor with a
 * 23° torch cone, which was the filter for including it at all. Nothing here
 * is a colour, a glow or a material change: `assertInert` forbids those, and
 * a monster that announces its state by changing hue is a HUD element.
 */
interface AlienPosture {
  /** Multiplier on the speed-derived cadence. */
  readonly cadence: number;
  /** Cycle rate when it is standing still, so a stationary alien is never a
   *  statue. A SEARCH sweep with the body parked is the scariest thing it does. */
  readonly idleHz: number;
  /** rad — head raise. Positive lifts the muzzle; negative drops it, which is
   *  what a thing about to reach you does. */
  readonly headLift: number;
  /** rad — amplitude of the yaw sweep. THE tell for SEARCH. */
  readonly headSweep: number;
  readonly sweepHz: number;
  /** 0..1 — how far it hunkers. Lowers the body and folds the limbs. */
  readonly crouch: number;
  /** rad — spine pitch. Negative flattens and tips the nose down (HUNT). */
  readonly arch: number;
  /** Limb swing amplitude. */
  readonly stride: number;
  /** Tail and spine sway amplitude. */
  readonly tail: number;
  /** Forward bias on the arms — HUNT reaches ahead of itself. */
  readonly reach: number;
}

const POSTURES: Readonly<Record<AlienState, AlienPosture>> = Object.freeze({
  // Coiled and barely moving. Whatever is in the room with you is asleep.
  DORMANT: {
    cadence: 0,
    idleHz: 0.14,
    headLift: -0.42,
    headSweep: 0.03,
    sweepHz: 0.2,
    crouch: 1,
    arch: 0.16,
    stride: 0,
    tail: 0.15,
    reach: -0.3,
  },
  // Level head, unhurried, long stride. §5's 1.5 m/s: above your walk, below
  // your sprint, and it should LOOK like it is not trying.
  PATROL: {
    cadence: 1,
    idleHz: 0.35,
    headLift: 0.06,
    headSweep: 0.1,
    sweepHz: 0.5,
    crouch: 0.16,
    arch: 0.03,
    stride: 0.85,
    tail: 0.7,
    reach: 0,
  },
  INVESTIGATE: {
    cadence: 0.9,
    idleHz: 0.5,
    headLift: 0.22,
    headSweep: 0.36,
    sweepHz: 0.8,
    crouch: 0.28,
    arch: 0.06,
    stride: 0.7,
    tail: 0.85,
    reach: 0.05,
  },
  // Head high and sweeping wide, body low, feet slow. §5 says most kills
  // happen in SEARCH, so this is the posture worth learning to recognise.
  SEARCH: {
    cadence: 0.8,
    idleHz: 0.55,
    headLift: 0.3,
    headSweep: 0.58,
    sweepHz: 1.05,
    crouch: 0.45,
    arch: 0.1,
    stride: 0.6,
    tail: 1,
    reach: 0.1,
  },
  // Flattened, nose down, reaching. §5: "It makes loud noise while hunting" —
  // it should look like it too, because a silent charge reads as a bug.
  HUNT: {
    cadence: 1.15,
    idleHz: 0.9,
    headLift: -0.26,
    headSweep: 0.05,
    sweepHz: 1.6,
    crouch: 0.04,
    arch: -0.13,
    stride: 1.3,
    tail: 1.35,
    reach: 0.32,
  },
  ATTACK: {
    cadence: 1.25,
    idleHz: 1.4,
    headLift: -0.4,
    headSweep: 0.02,
    sweepHz: 2.2,
    crouch: 0,
    arch: -0.2,
    stride: 1.45,
    tail: 1.5,
    reach: 0.4,
  },
  // Leaving, and looking back while it does. The one posture that should read
  // as relief.
  RETREAT: {
    cadence: 1.05,
    idleHz: 0.6,
    headLift: 0.1,
    headSweep: 0.3,
    sweepHz: 0.9,
    crouch: 0.2,
    arch: 0.02,
    stride: 1,
    tail: 1.1,
    reach: -0.1,
  },
});

/** Mutable working copy of a posture, smoothed toward the target. */
type PostureAccum = { -readonly [K in keyof AlienPosture]: number };

function copyPosture(from: AlienPosture): PostureAccum {
  return { ...from };
}

const POSTURE_KEYS = Object.keys(POSTURES.PATROL) as Array<keyof AlienPosture>;

/**
 * rate — how fast a posture change lands. 3.2 gives roughly a third of a
 * second, which is long enough to read as the thing changing its mind and short
 * enough that the player is not acting on stale information.
 */
const POSTURE_RATE = 3.2;

function approach(current: number, target: number, rate: number, dt: number): number {
  const k = 1 - Math.exp(-rate * dt);
  return current + (target - current) * k;
}

// ===========================================================================
// The rig
// ===========================================================================

interface AlienRig {
  readonly root: THREE.Object3D;
  readonly carriage: THREE.Object3D;
  readonly chest: THREE.Object3D;
  readonly neck: THREE.Object3D;
  readonly pelvis: THREE.Object3D;
  readonly shoulder: readonly [THREE.Object3D, THREE.Object3D];
  readonly elbow: readonly [THREE.Object3D, THREE.Object3D];
  readonly hip: readonly [THREE.Object3D, THREE.Object3D];
}

function node(parent: THREE.Object3D, name: string, x = 0, y = 0, z = 0): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

/**
 * The skeleton, offline.
 *
 * Not in the scene and never rendered: `pose()` writes rotations into it,
 * `updateMatrixWorld(true)` resolves them, and the six `PartInstances` harvest
 * the results. That indirection is what buys left/right limbs as two instances
 * of one geometry — **six draw calls for a nine-part creature**, where a
 * parented mesh per part would have been nine.
 */
function buildRig(): AlienRig {
  const root = new THREE.Object3D();
  root.name = 'alien-rig';
  const carriage = node(root, 'carriage');
  // The PELVIS is the spine root, not the chest. That ordering is the fix for a
  // bug the contact check caught twice: with the chest on top, arching the spine
  // nose-down for a HUNT rotated the hips as well and drove the hind feet 100 mm
  // through the plating. Hips first, chest hinged off them at the waist, and an
  // arch is then exactly what an arch is — the front half moving.
  const pelvis = node(carriage, 'pelvis', 0, -0.005, PELVIS_Z);
  const chest = node(pelvis, 'chest', 0, 0.005, CHEST_Z - PELVIS_Z);
  const neck = node(chest, 'neck', 0, SHOULDER.y, -0.28);
  const shoulderL = node(chest, 'shoulder-l', -SHOULDER.x, SHOULDER.y, SHOULDER.z);
  const shoulderR = node(chest, 'shoulder-r', SHOULDER.x, SHOULDER.y, SHOULDER.z);
  const elbowL = node(shoulderL, 'elbow-l', 0, -UPPER_ARM_L, 0);
  const elbowR = node(shoulderR, 'elbow-r', 0, -UPPER_ARM_L, 0);
  const hipL = node(pelvis, 'hip-l', -HIP.x, HIP.y, HIP.z);
  const hipR = node(pelvis, 'hip-r', HIP.x, HIP.y, HIP.z);
  return {
    root,
    carriage,
    chest,
    neck,
    pelvis,
    shoulder: [shoulderL, shoulderR],
    elbow: [elbowL, elbowR],
    hip: [hipL, hipR],
  };
}

// ===========================================================================
// The two gaits
// ===========================================================================

/**
 * Joint angles for the walk, per limb, as (base, amplitude) pairs.
 *
 * Solved rather than eyeballed: the deck is `ALIEN_DECK_DROP_M` below the rig
 * origin in every gravity module (the server guarantees it), so the base angles
 * are the ones that put a hand and a foot on −0.45 with the limbs folded. Change
 * one and re-run `alienContactReport()`.
 */
const WALK = Object.freeze({
  shoulderPitch: -0.12,
  shoulderPitchAmp: 0.34,
  shoulderSplay: 0.78,
  elbowPitch: 1.42,
  elbowPitchAmp: 0.38,
  hipPitch: 0.06,
  hipPitchAmp: 0.22,
  hipSplay: 0.55,
  /** Vertical bob, metres, at twice the stride rate: four feet, two beats. */
  bob: 0.022,
  /** Lateral spine undulation, radians. */
  yaw: 0.1,
  roll: 0.055,
});

/** Joint angles for the rail pull. Arms forward and folded, legs trailing,
 *  spine swimming. No bob: there is no floor to push off. */
const RAIL = Object.freeze({
  shoulderPitch: 1.5,
  shoulderPitchAmp: 0.85,
  shoulderSplay: 0.26,
  elbowPitch: -0.62,
  elbowPitchAmp: 0.55,
  hipPitch: -0.5,
  hipPitchAmp: 0.22,
  hipSplay: 0.22,
  yaw: 0.2,
  roll: 0.14,
});

/**
 * Pose the rig for one frame.
 *
 * `ground` is the gravity blend: 1 on a deck, 0 in a zero-G module, and the
 * intermediate values are a real transition rather than a debug slider — §5's
 * director can drop a module's floor under the alien mid-stride, and the
 * announcement window (§4, `GravityShiftEvent.inMs`) means the player is
 * watching when it happens.
 */
function pose(rig: AlienRig, p: PostureAccum, phase: number, sweep: number, ground: number): void {
  const air = 1 - ground;
  const mix = (a: number, b: number): number => a * ground + b * air;

  // -- carriage: how high the whole animal rides ---------------------------
  const crouchDrop = p.crouch * 0.11 * ground;
  rig.carriage.position.set(0, -crouchDrop, 0);
  rig.carriage.rotation.set(0, 0, mix(WALK.roll, RAIL.roll) * p.tail * Math.sin(phase * 0.5));

  // -- spine: the undulation, and the tail it swings ------------------------
  // The pelvis owns the yaw wave and the tail is baked into it, so a 0.20 rad
  // hip twist becomes a 0.24 m tail sweep for free.
  const spineYaw = mix(WALK.yaw, RAIL.yaw) * p.tail;
  rig.pelvis.rotation.set(
    0,
    spineYaw * Math.sin(phase - 0.8),
    spineYaw * 0.5 * Math.sin(phase - 1.5),
  );
  // The chest hinges at the waist: the arch, the counter-yaw, and the heave.
  // Two beats per stride, one per diagonal pair — and exactly zero in zero-G,
  // or the body reads as bouncing off a floor that is not there.
  rig.chest.rotation.set(p.arch, -spineYaw * 0.45 * Math.sin(phase), 0);
  rig.chest.position.set(
    0,
    0.005 + WALK.bob * p.stride * ground * Math.sin(phase * 2),
    CHEST_Z - PELVIS_Z,
  );

  // -- head ---------------------------------------------------------------
  rig.neck.rotation.set(-p.headLift, sweep, sweep * 0.35);

  // -- limbs --------------------------------------------------------------
  // Diagonal couplet on a deck: front-left with hind-right. Hand over hand on a
  // rail: the two arms simply alternate, and the legs trail at half rate.
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const armOff = i === 0 ? 0 : Math.PI;
    const swingArm = Math.sin(phase + armOff);
    // Two leg waves, BLENDED rather than switched. On a deck the hind legs run
    // in a diagonal couplet with the opposite arm; on a rail they undulate at
    // half rate in phase with the same-side arm. Picking one by a `ground > 0.5`
    // test would step the phase mid-transition, and a director floor drop is
    // announced 2.5 s in advance precisely so somebody is watching it happen.
    const swingLegWalk = Math.sin(phase + (i === 0 ? Math.PI : 0));
    const swingLegRail = Math.sin(phase * 0.5 + armOff);
    const swingLeg = swingLegWalk * ground + swingLegRail * air;

    const shoulder = rig.shoulder[i] as THREE.Object3D;
    const elbow = rig.elbow[i] as THREE.Object3D;
    const hip = rig.hip[i] as THREE.Object3D;

    const sPitch =
      mix(WALK.shoulderPitch, RAIL.shoulderPitch) +
      p.reach * 0.4 -
      p.crouch * 0.22 +
      p.stride * mix(WALK.shoulderPitchAmp, RAIL.shoulderPitchAmp) * swingArm;
    const sSplay = mix(WALK.shoulderSplay, RAIL.shoulderSplay) + p.crouch * 0.34 * ground;
    shoulder.rotation.set(sPitch, 0, side * sSplay);

    // The elbow counter-swings so the hand plants and pushes instead of
    // paddling: on a deck the palm holds still while the body passes over it,
    // which is what a walk IS.
    const ePitch =
      mix(WALK.elbowPitch, RAIL.elbowPitch) -
      p.reach * 0.3 +
      p.crouch * 0.3 -
      p.arch * ground -
      p.stride * mix(WALK.elbowPitchAmp, RAIL.elbowPitchAmp) * swingArm;
    elbow.rotation.set(ePitch, 0, 0);

    const hPitch =
      mix(WALK.hipPitch, RAIL.hipPitch) +
      p.stride * mix(WALK.hipPitchAmp, RAIL.hipPitchAmp) * swingLeg;
    // Crouching a quadruped means splaying it, not shortening it: the carriage
    // drops and the legs fold OUTWARD to keep the feet on the deck. Fold the
    // wrong one and a SEARCH sweep walks with its knees through the plating.
    const hSplay = mix(WALK.hipSplay, RAIL.hipSplay) + p.crouch * 0.3 * ground;
    hip.rotation.set(hPitch, 0, side * hSplay);
  }

  rig.root.updateMatrixWorld(true);
}

// ===========================================================================
// AlienView
// ===========================================================================

export interface AlienViewOptions {
  /**
   * The station's one `StationMaterials`. Pass `station.materials`.
   *
   * Optional only so `buildAlien()` in main.ts keeps compiling: without it the
   * view builds the single `organic` material it needs through the sanctioned
   * `build(PALETTE.organic)` factory, which is the same shader program either
   * way. Pass the real one anyway — one owner per material is the rule.
   */
  materials?: StationMaterials | null;
  /** Re-emit `alien:state` / `alien:moved` on the bus as snapshots arrive.
   *  Leave false when the net layer already emits them. */
  emitBusEvents?: boolean;
  /** Hide the body when its module is outside the two-hop cull set (§2). */
  cullByModule?: boolean;
  /** Per-module gravity (§4). Decides walk vs rail-pull. Wire it to
   *  `station.moduleGravity` — without it everything walks, which is right for
   *  seven of the nine modules `levels/station.json` ships. */
  gravityOf?: ((module: ModuleId) => GravityMode) | null;
  /** Cast into the §9 flashlight shadow map. Default FALSE, and think hard
   *  before changing it: a 1024² map spent on the monster is a map not spent on
   *  the doorway you are about to walk through. */
  castShadow?: boolean;
}

interface Pose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

export class AlienView {
  /** Add this to the scene. Carries the interpolated server transform; the six
   *  instanced parts hang off it in rig-local space. */
  readonly object3D: THREE.Group;

  private readonly rig = buildRig();
  private readonly chestPart: PartInstances;
  private readonly abdomenPart: PartInstances;
  private readonly headPart: PartInstances;
  private readonly upperArmPart: PartInstances;
  private readonly forearmPart: PartInstances;
  private readonly legPart: PartInstances;
  private readonly parts: PartInstances[];
  private readonly ownedMaterial: THREE.Material | null;

  private readonly prev: Pose;
  private readonly curr: Pose;
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();

  private _state: AlienState = 'DORMANT';
  private _module: ModuleId = '';
  private _gravity: GravityMode = 'nominal';
  private _speed = 0;
  private _hasPose = false;
  private readonly emitBusEvents: boolean;
  private readonly cullByModule: boolean;
  private readonly gravityOf: ((module: ModuleId) => GravityMode) | null;
  private visibleModules: Set<ModuleId> | null = null;
  private busUnsubs: Unsubscribe[] = [];

  private readonly posture: PostureAccum = copyPosture(POSTURES.DORMANT);
  /**
   * Starts at zero, deliberately, and NOT at a random offset.
   *
   * There is exactly one alien, so a random phase buys no visual variety — it
   * only desynchronises clients. Gait is how a player reads patrol from search
   * from hunt (§5), and they call that out to each other over proximity voice,
   * so two people looking at the same creature must see the same stride. A
   * random seed put them up to a full cycle apart.
   */
  private phase = 0;
  private sweepPhase = 0;
  /** Gravity blend, 0 = rail-pull, 1 = walk. Smoothed so a director floor drop
   *  is a transition rather than a snap. */
  private ground = 1;

  constructor(opts: AlienViewOptions = {}) {
    const materials = opts.materials ?? null;
    // ONE material for the whole creature. Pale, matte, no emissive, ever: the
    // asset bible's row for ISS-CHR-01 reads "Accent: none — pale only", and
    // `assertInert` below turns that from a comment into a check.
    let material: THREE.Material;
    if (materials) {
      material = materials.organic;
      this.ownedMaterial = null;
    } else {
      material = build(PALETTE.organic);
      material.name = 'organic-alien';
      this.ownedMaterial = material;
    }
    const shadow = opts.castShadow ?? false;

    this.object3D = new THREE.Group();
    this.object3D.name = 'alien';
    this.object3D.visible = false; // nothing to show until the first snapshot

    const part = (g: THREE.BufferGeometry, n: number, name: string): PartInstances =>
      new PartInstances(g, material, n, name, { castShadow: shadow });

    this.chestPart = part(buildChest(), 1, 'alien-chest');
    this.abdomenPart = part(buildAbdomen(), 1, 'alien-abdomen');
    this.headPart = part(buildHeadNeck(), 1, 'alien-head');
    // Left and right are two instances of ONE geometry. The limbs are built
    // symmetric about their own YZ plane precisely so this works without a
    // mirrored copy — mirroring flips triangle winding and fixing that costs
    // more than the geometry saves.
    this.upperArmPart = part(buildUpperArm(), 2, 'alien-upper-arm');
    this.forearmPart = part(buildForearm(), 2, 'alien-forearm');
    this.legPart = part(buildLeg(), 2, 'alien-leg');
    this.parts = [
      this.chestPart,
      this.abdomenPart,
      this.headPart,
      this.upperArmPart,
      this.forearmPart,
      this.legPart,
    ];
    // Instance matrices are rig-local, so the group's own transform is what puts
    // the creature in the station — and `PartInstances.end()` refreshes each
    // part's bounding sphere every frame, which is what lets three's frustum
    // test (`_sphere.copy(object.boundingSphere).applyMatrix4(matrixWorld)`)
    // stay correct on a body whose instances move. So culling stays ON: the
    // alien standing behind you in a visible module should cost nothing.
    for (const p of this.parts) this.object3D.add(p.mesh);

    this.prev = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.curr = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.emitBusEvents = opts.emitBusEvents ?? false;
    this.cullByModule = opts.cullByModule ?? false;
    this.gravityOf = opts.gravityOf ?? null;

    // Pose once so the first frame after the first snapshot is already correct.
    this.applyPose(0);

    // The promise, checked: nothing on this creature glows. One false positive
    // devalues every amber dot in the station, and a self-lit monster would be
    // the loudest false positive available.
    assertInert(this.object3D, 'the alien (ISS-CHR-01)');
  }

  // -- reads ----------------------------------------------------------------

  get state(): AlienState {
    return this._state;
  }

  get module(): ModuleId {
    return this._module;
  }

  /** Which locomotion it is using. */
  get gravity(): GravityMode {
    return this._gravity;
  }

  /** m/s, measured off the interpolated transform — what drives the cadence. */
  get speed(): number {
    return this._speed;
  }

  /** True while the server says it is hunting — what the audio hook keys off. */
  get hunting(): boolean {
    return this._state === 'HUNT' || this._state === 'ATTACK';
  }

  /** Interpolated world position, valid after `update()`. */
  get position(): THREE.Vector3 {
    return this.object3D.position;
  }

  /** Draw calls the creature costs. Six, and it does not vary. */
  get drawCalls(): number {
    let n = 0;
    for (const p of this.parts) if (p.mesh.visible) n++;
    return n;
  }

  /** Triangles on screen when it is visible. */
  get triangles(): number {
    return (
      this.chestPart.triangles +
      this.abdomenPart.triangles +
      this.headPart.triangles +
      this.upperArmPart.triangles * 2 +
      this.forearmPart.triangles * 2 +
      this.legPart.triangles * 2
    );
  }

  /** Plain `{x,y,z}` copy, for anything in `shared/` (which never sees three). */
  positionVec3(): Vec3 {
    const p = this.object3D.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  distanceTo(pos: Vec3): number {
    return this.object3D.position.distanceTo(this.scratchPos.set(pos.x, pos.y, pos.z));
  }

  // -- network → view -------------------------------------------------------

  /** Feed one server snapshot (§7 `alien: { pos, quat, state }` + module). */
  applySnapshot(snapshot: AlienSnapshot): void {
    this.setTransform(snapshot.pos, snapshot.quat);
    this.setState(snapshot.state);
    this.setModule(snapshot.module);
  }

  /** Push a new authoritative transform; the previous one becomes the lerp
   *  start. Call once per received state update, not per frame. */
  setTransform(pos: Vec3, quat?: Quat): void {
    if (!this._hasPose) {
      this.curr.pos.set(pos.x, pos.y, pos.z);
      if (quat) this.curr.quat.set(quat.x, quat.y, quat.z, quat.w);
      this.prev.pos.copy(this.curr.pos);
      this.prev.quat.copy(this.curr.quat);
      this._hasPose = true;
      this.object3D.position.copy(this.curr.pos);
      this.object3D.quaternion.copy(this.curr.quat);
      this.object3D.visible = this.shouldBeVisible();
      return;
    }
    this.prev.pos.copy(this.curr.pos);
    this.prev.quat.copy(this.curr.quat);
    this.curr.pos.set(pos.x, pos.y, pos.z);
    if (quat) this.curr.quat.set(quat.x, quat.y, quat.z, quat.w);
    if (this.prev.pos.distanceTo(this.curr.pos) > TELEPORT_SNAP_M) {
      this.prev.pos.copy(this.curr.pos);
      this.prev.quat.copy(this.curr.quat);
    }
  }

  setState(state: AlienState): void {
    if (state === this._state) return;
    const from = this._state;
    this._state = state;
    // Deliberately NOT a material change. The old capsule tinted its emissive
    // per state, which was the only cue a featureless pill could carry; a body
    // with a gait says it better and says it honestly, because a glow would
    // also be visible with the torch off through fog at any range.
    if (this.emitBusEvents) bus.emit('alien:state', { from, to: state });
  }

  setModule(module: ModuleId): void {
    if (module === this._module) return;
    this._module = module;
    if (this.gravityOf) this.setGravity(this.gravityOf(module));
    if (this.emitBusEvents) {
      bus.emit('alien:moved', { pos: this.positionVec3(), module });
    }
    this.object3D.visible = this.shouldBeVisible();
  }

  /**
   * Which locomotion to use. Called for you when `gravityOf` is supplied.
   *
   * Blended, not switched: §5's director can cut a module's floor while the
   * alien is standing in it, and the 2.5 s announcement means somebody is
   * watching. A monster that snaps from a walk to a swim in one frame turns the
   * game's most carefully-fair event into a visual glitch.
   */
  setGravity(mode: GravityMode): void {
    this._gravity = mode;
  }

  /**
   * Restrict rendering to the §2 two-hop cull set. Pass null to always draw.
   * Only does anything when constructed with `cullByModule`.
   */
  setVisibleModules(modules: readonly ModuleId[] | null): void {
    this.visibleModules = modules ? new Set(modules) : null;
    this.object3D.visible = this.shouldBeVisible();
  }

  // -- per-frame ------------------------------------------------------------

  /**
   * Interpolate toward the latest snapshot, then animate.
   *
   * `alpha` comes from the ticker (§7 — interpolate remote players and the
   * alien). `frameDt` is real seconds and drives the gait; passing 0 freezes
   * the animation without freezing the interpolation, which is what a paused
   * menu wants.
   */
  update(alpha: number, frameDt = 0): void {
    if (!this._hasPose) return;
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    this.scratchPos.copy(this.object3D.position);
    this.object3D.position.lerpVectors(this.prev.pos, this.curr.pos, a);
    this.scratchQuat.copy(this.prev.quat).slerp(this.curr.quat, a);
    this.object3D.quaternion.copy(this.scratchQuat);

    if (frameDt <= 0) return;

    // Cadence from measured speed, not from the state table. The server owns
    // §5's speeds and may retune them; reading the transform means the legs can
    // never disagree with the metres actually covered.
    const moved = this.scratchPos.distanceTo(this.object3D.position) / frameDt;
    this._speed = approach(this._speed, Math.min(moved, 12), 6, frameDt);
    this.applyPose(frameDt);
  }

  // -- bus wiring -----------------------------------------------------------

  /**
   * Optional convenience: drive the view straight off the event bus when the
   * net layer publishes `alien:moved` / `alien:state` instead of handing you
   * snapshots. Returns an unsubscribe function.
   */
  attachToBus(): Unsubscribe {
    this.detachFromBus();
    this.busUnsubs.push(
      bus.on('alien:moved', ({ pos, module }) => {
        this.setTransform(pos);
        this.setModule(module);
      }),
    );
    this.busUnsubs.push(
      bus.on('alien:state', ({ to }) => {
        this.setState(to);
      }),
    );
    this.busUnsubs.push(
      bus.on('cull:changed', ({ visible }) => {
        if (this.cullByModule) this.setVisibleModules(visible);
      }),
    );
    return () => this.detachFromBus();
  }

  detachFromBus(): void {
    for (const off of this.busUnsubs) off();
    this.busUnsubs = [];
  }

  dispose(): void {
    this.detachFromBus();
    this.object3D.removeFromParent();
    for (const p of this.parts) p.dispose();
    // Only ever the fallback: the station's own `organic` belongs to
    // `StationMaterials` and disposing it would blank the monster for good.
    this.ownedMaterial?.dispose();
  }

  // -- internals ------------------------------------------------------------

  private shouldBeVisible(): boolean {
    if (!this._hasPose) return false;
    // Culling is geometry, not behaviour: a DORMANT alien three modules away is
    // still behind two bulkheads, and drawing it anyway is a wall-hack for the
    // first fifteen seconds of every round (§2's two-hop set is the whole rule).
    if (!this.cullByModule || !this.visibleModules) return true;
    return this.visibleModules.has(this._module);
  }

  /**
   * Advance the gait and write the six instance sets.
   *
   * Runs even while off-screen, and deliberately: the alien walks through a
   * hatch mid-stride, and a body that resumes a frozen pose the moment it comes
   * into view is worse than one that was never animated.
   */
  private applyPose(dt: number): void {
    const target = POSTURES[this._state] ?? POSTURES.PATROL;
    if (dt > 0) {
      for (const key of POSTURE_KEYS) {
        this.posture[key] = approach(this.posture[key], target[key], POSTURE_RATE, dt);
      }
      this.ground = approach(this.ground, this._gravity === 'zero' ? 0 : 1, 2.4, dt);

      // Standing still still moves: `idleHz` keeps a parked SEARCH sweeping and
      // a DORMANT body breathing.
      const travel = this._speed / ALIEN_STRIDE_M;
      const hz = Math.max(this.posture.idleHz, travel * this.posture.cadence);
      this.phase = (this.phase + hz * Math.PI * 2 * dt) % (Math.PI * 2);
      this.sweepPhase = (this.sweepPhase + this.posture.sweepHz * Math.PI * 2 * dt) %
        (Math.PI * 2);
    }

    const sweep = this.posture.headSweep * Math.sin(this.sweepPhase);
    pose(this.rig, this.posture, this.phase, sweep, this.ground);

    for (const p of this.parts) p.begin();
    this.chestPart.push(this.rig.chest);
    this.abdomenPart.push(this.rig.pelvis);
    this.headPart.push(this.rig.neck);
    for (let i = 0; i < 2; i++) {
      this.upperArmPart.push(this.rig.shoulder[i] as THREE.Object3D);
      this.forearmPart.push(this.rig.elbow[i] as THREE.Object3D);
      this.legPart.push(this.rig.hip[i] as THREE.Object3D);
    }
    for (const p of this.parts) p.end();
  }
}

// ===========================================================================
// Self-check
// ===========================================================================

export class AlienCoherenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlienCoherenceError';
  }
}

export interface AlienGeometryReport {
  chest: number;
  abdomen: number;
  head: number;
  upperArm: number;
  forearm: number;
  leg: number;
  total: number;
  /** Nose to tail tip, metres. */
  length: number;
  /** Half-width of the SPINE alone — the number "long, thin" is a claim about. */
  bodyHalfWidth: number;
  /** Half-width including the limbs at their joints, unposed. */
  spanHalfWidth: number;
  bodyHeight: number;
}

/**
 * Triangle counts and the neutral-pose extents.
 *
 * Two half-widths, deliberately. The spine's own width is what §9's "long,
 * thin" is about and what separates this creature from a crewmate; the span
 * including limbs is what has to stay inside the 0.45 m body the server prices
 * contact against. Measuring one and calling it the other is how a thin animal
 * quietly becomes a wide one.
 */
export function alienGeometryReport(): AlienGeometryReport {
  const body = new THREE.Box3();
  const span = new THREE.Box3();
  const measure = (
    g: THREE.BufferGeometry,
    offset: THREE.Vector3,
    isSpine: boolean,
  ): number => {
    g.computeBoundingBox();
    const box = (g.boundingBox as THREE.Box3).clone().translate(offset);
    span.union(box);
    if (isSpine) body.union(box);
    const n = triangleCount(g);
    g.dispose();
    return n;
  };
  const chestAt = new THREE.Vector3(0, 0, CHEST_Z);
  const pelvisAt = new THREE.Vector3(0, 0, PELVIS_Z);
  const chest = measure(buildChest(), chestAt, true);
  const abdomen = measure(buildAbdomen(), pelvisAt, true);
  const head = measure(buildHeadNeck(), new THREE.Vector3(0, SHOULDER.y, CHEST_Z - 0.28), true);
  // Limbs at their real joints, so the span is the span.
  const shoulderAt = new THREE.Vector3(SHOULDER.x, SHOULDER.y, CHEST_Z + SHOULDER.z);
  const upperArm = measure(buildUpperArm(), shoulderAt, false);
  const forearm = measure(
    buildForearm(),
    shoulderAt.clone().setY(SHOULDER.y - UPPER_ARM_L),
    false,
  );
  const leg = measure(
    buildLeg(),
    new THREE.Vector3(HIP.x, HIP.y, PELVIS_Z + HIP.z),
    false,
  );
  return {
    chest,
    abdomen,
    head,
    upperArm,
    forearm,
    leg,
    total: chest + abdomen + head + upperArm * 2 + forearm * 2 + leg * 2,
    length: body.max.z - body.min.z,
    bodyHalfWidth: Math.max(Math.abs(body.min.x), body.max.x),
    spanHalfWidth: Math.max(Math.abs(span.min.x), span.max.x),
    bodyHeight: body.max.y - body.min.y,
  };
}

/** Where the hands and feet actually end up, per gait. The tuning instrument
 *  for `WALK` and `RAIL`: on a deck every contact point wants to be within a
 *  couple of centimetres of `−ALIEN_DECK_DROP_M`. */
export function alienContactReport(
  state: AlienState = 'PATROL',
  gravity: GravityMode = 'nominal',
  phase = 0,
): { hand: number; foot: number; crown: number; nose: number; deck: number } {
  const rig = buildRig();
  const p = copyPosture(POSTURES[state]);
  const ground = gravity === 'zero' ? 0 : 1;
  pose(rig, p, phase, 0, ground);
  const v = new THREE.Vector3();
  const hand = new THREE.Vector3(0, -(FOREARM_L + HAND_L + 0.04), 0)
    .applyMatrix4((rig.elbow[0] as THREE.Object3D).matrixWorld)
    .y;
  const footLocal = new THREE.Vector3(
    0,
    -THIGH_L - Math.cos(KNEE_BAKED) * SHIN_L - 0.05,
    Math.sin(KNEE_BAKED) * SHIN_L,
  );
  const foot = footLocal.applyMatrix4((rig.hip[0] as THREE.Object3D).matrixWorld).y;
  const crown = v.set(0, 0.135, 0).applyMatrix4(rig.chest.matrixWorld).y;
  const nose = v
    .set(0, -0.018, -NECK_LEN - SKULL_HALF * 2 + 0.045)
    .applyMatrix4(rig.neck.matrixWorld).z;
  return { hand, foot, crown, nose, deck: -ALIEN_DECK_DROP_M };
}

/**
 * Prove the creature is the creature the bible and the server both describe.
 *
 * Three things can silently go wrong here and all three are invisible in a
 * still image: it can drift off the bible's 2.40 m, it can grow wider than the
 * 0.45 m body the server prices contact against, and — the one that actually
 * happened twice while tuning — its hands and feet can end up above or below
 * the deck the server has already decided it is standing on.
 */
export function assertAlienCoherent(): void {
  const failures: string[] = [];
  const report = alienGeometryReport();

  if (Math.abs(report.length - ALIEN_VIEW_LENGTH) > 0.12) {
    failures.push(
      `nose-to-tail is ${report.length.toFixed(3)} m, not the bible's ${ALIEN_VIEW_LENGTH}`,
    );
  }
  if (report.spanHalfWidth > ALIEN_VIEW_RADIUS) {
    failures.push(
      `unposed span ${report.spanHalfWidth.toFixed(3)} m exceeds ALIEN_VIEW_RADIUS ` +
        `${ALIEN_VIEW_RADIUS}, which is the body the server prices contact against`,
    );
  }
  // "Long, thin" is a ratio, not an adjective — and it is the ratio that keeps
  // this creature from converging on a crewmate, who is 1.70 tall by 0.58 wide
  // (2.9:1, and UPRIGHT). Measured on the spine, not the limb span.
  const slenderness = report.length / Math.max(0.01, report.bodyHalfWidth * 2);
  if (slenderness < 5) {
    failures.push(
      `slenderness ${slenderness.toFixed(2)}:1 — §9 says "long, thin", and under 5:1 it ` +
        `reads as a lump`,
    );
  }
  const band = POLY_BUDGETS.alien;
  if (report.total < band.min || report.total > band.max) {
    failures.push(
      `${report.total} triangles is outside the ${band.min}–${band.max} band; the bible spends ` +
        `this budget on ANIMATION, so being under it means parts that cannot move`,
    );
  }

  for (const state of Object.keys(POSTURES) as AlienState[]) {
    for (const phase of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const c = alienContactReport(state, 'nominal', phase);
      if (Math.abs(c.foot - c.deck) > 0.13) {
        failures.push(
          `${state} at phase ${phase.toFixed(2)}: hind foot at ${c.foot.toFixed(3)} but the ` +
            `deck is at ${c.deck} — it is skating or sunk`,
        );
      }
      if (Math.abs(c.hand - c.deck) > 0.15) {
        failures.push(
          `${state} at phase ${phase.toFixed(2)}: hand at ${c.hand.toFixed(3)} but the deck ` +
            `is at ${c.deck}`,
        );
      }
      if (c.crown > DECK_HEADROOM_M - ALIEN_DECK_DROP_M) {
        failures.push(
          `${state}: dorsal blades at ${c.crown.toFixed(3)} above the body centre clear ` +
            `DECK_HEADROOM_M (${DECK_HEADROOM_M}) — it would walk through the ceiling`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new AlienCoherenceError(
      `the alien (ISS-CHR-01) contradicts its own brief:\n  - ${failures.join('\n  - ')}`,
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
export const ALIEN_CHECKED: boolean = (() => {
  if (!isDevEnvironment()) return false;
  assertAlienCoherent();
  const probe = buildChest();
  assertPolyBudget(probe, { label: 'alien thorax', min: 90, max: 200 }, 'alien thorax');
  probe.dispose();
  return true;
})();
