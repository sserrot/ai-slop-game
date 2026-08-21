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
 * 972 triangles across ten body parts drawn in EIGHT draw calls — left and
 * right limbs are two instances of one geometry — and every part moves.
 *
 * **AND EVERY PART MOVES LATE.** The gait below was solved and correct and it
 * still read as a puppet, because it was one `Math.sin()` of one phase scalar
 * and nothing alive moves like that. The "Secondary motion" section adds the
 * three things sine cannot do — LAG (sprung tail and head, underdamped, so a
 * turn throws the tail wide and it settles after the hips have stopped), HOLD
 * AND SNAP (the head dwells dead still, then whips to a new bearing in ~110 ms,
 * and the body freezes with it) and BREATH (a rib cycle at its own rate,
 * skewed, beating against the gait). None of it costs a triangle.
 *
 * **AND THE FEET DO NOT SLIDE.** All four limbs are solved by `./ik.ts` to
 * CONTACTS authored in rig space, not posed by hand — and the stance travel is
 * derived from the same measured speed that drives the cadence, so a planted
 * foot covers exactly the metres the body covers. At any speed, without a
 * tuning constant. `assertAlienCoherent()` measures the residual and requires
 * it to be zero; it is currently about two nanometres over a whole stance.
 *
 * **AND IT IS MADE OF SKIN.** `./flesh.ts` gives `PALETTE.organic` a program of
 * its own: subsurface wrap, a grazing rim, procedural detail, a slow crawl. It
 * changes how the surface answers light and adds none, so `assertInert` still
 * passes and the creature is still invisible with the torch off.
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
 *   • RAIL-PULL, in `gravity: 'zero'` modules. **The body turns over.** A zero-G
 *     module's rails are its floor-and-ceiling pair (`tubeRails` in
 *     `station/kit.ts`) and the server threads the creature onto one, so it
 *     hauls along hanging UNDER the bar: the carriage rolls a half turn about
 *     the travel axis and the contact plane rolls with it, hand over hand, legs
 *     trailing. §5's one genuinely nice property — "it pulls along the same
 *     handrails in a room you are walking through as in one you are floating
 *     in" — survives because it is now literally the same solve; only the
 *     reach, the lead and the stance fraction differ.
 *
 *     r3 shipped this WITHOUT the roll, and it was the most visible bug in the
 *     asset: a limb hangs along −Y from its joint, so handholds placed above an
 *     upright body made the solver fold both arms back over the shoulders and
 *     the creature read as having its arms on upside down. See {@link
 *     VACUUM_ROLL}, and `AlienContactReport.ventralReach`, which is the number
 *     that now makes it impossible.
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
import { DECK_HEADROOM_M, RAIL_Y_M } from '@shared/constants';
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
import { KIT } from '../station/kit';
import { solveTwoBone, twoBoneOut, twoBoneTip } from './ik';
import { FleshMaterial, assertFleshCoherent } from './flesh';
import type { AlienSkin } from './skin';
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
 * Abdomen, hip girdle and two more blades. The tail is NOT in here any more.
 *
 * It used to be, on the grounds that the pelvis already rotates for the spine
 * undulation and a 0.72 m tail baked onto it sweeps a much bigger arc for free.
 * That was true and it was still wrong: a baked tail arrives at the same
 * instant the hips do, and nothing heavy that hangs off a moving body does
 * that. Everything dangling LAGS. So the tail is its own part on its own joint
 * now ({@link buildTail}), dragged by a spring in `AlienView.applyPose`, and it
 * costs the seventh draw call. That is the trade, made deliberately.
 */
function buildAbdomen(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(zTube(CHEST_R_BACK, 0.115, ABDOMEN_LEN, 8, false, 1), 0, 0, 0));
  parts.push(at(chamferedBox({ x: 0.32, y: 0.09, z: 0.15 }, 0.02), 0, 0, 0.08));
  parts.push(at(blade(0.016, 0.1, 0.05), 0, 0.12, 0.1));
  parts.push(at(blade(0.014, 0.07, 0.045), 0, 0.1, 0.26));

  const g = mergeParts(parts);
  g.name = 'alien-abdomen';
  return g;
}

/**
 * m — pelvis-local Z of the tail joint. Exactly where the baked tail used to
 * begin, so the silhouette and the bible's 2.40 m are untouched by the split:
 * the only thing that went up is the number of parts that can move.
 */
const TAIL_JOINT_Z = ABDOMEN_LEN - 0.02;

/** Tail-local position of the very tip. The deck-clearance check needs it, and
 *  deriving it from `TAIL_SEGS` means a retuned tail cannot silently sink. */
const TAIL_TIP_LOCAL = Object.freeze({
  y: TAIL_SEGS.reduce((sum, s) => sum + s.drop, 0),
  z: TAIL_SEGS.reduce((sum, s) => sum + s.len, 0) + 0.06,
});

/**
 * The tail, built at its own joint so a spring can drag it.
 *
 * The same three tapered segments and the same capped tip the abdomen used to
 * carry: ZERO triangles added, one draw call spent. What the draw call buys is
 * follow-through — on a turn the tail swings wide and settles late, which is
 * the loudest "this is an animal, not a prop" signal a pale silhouette can
 * carry at 10 m through fog, and it survives having no light on it at all.
 */
function buildTail(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let z = 0;
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
  g.name = 'alien-tail';
  return g;
}

/**
 * Neck and head, at a given jaw gape and crown flare.
 *
 * The head is where "no eyes" has to be positive rather than absent: a smooth
 * ellipsoid stretched to 1.55× along the travel axis, with a hinged lower jaw
 * and two spines swept back off the crown. Long, tapering, featureless. Beside
 * a crewmate's helmet — a perfect sphere with a dark faceplate cut into it —
 * the two heads share no outline at all, and that is the pair the bible says
 * must never be confused.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TAKES PARAMETERS, AND WHY THE JAW IS A MORPH AND NOT A JOINT
 *
 * A jaw on its own joint is the obvious build and it costs a NINTH draw call
 * for one rigid box. A morph target costs none: three carries per-instance
 * influences in a `DataTexture` and the vertex shader does the blend, so the
 * head stays one instanced draw whether the mouth is shut or wide open.
 *
 * And a morph does two things a hinge cannot. The throat DISTENDS as the mouth
 * opens — the neck tubes swell, which no rotation of a jaw box could produce —
 * and the crown spines splay on a separate axis, so a SEARCH can flare without
 * gaping and an ATTACK can do both. Those are non-rigid deformations, which is
 * exactly the case morph targets are for and the only reason to reach for them.
 *
 * The two shapes are authored by BUILDING THE HEAD TWICE and subtracting. Every
 * primitive here keeps its segment counts across the whole parameter range, so
 * the two meshes are vertex-for-vertex correspondent by construction and the
 * delta is just arithmetic — no vertex-index bookkeeping, no way for a later
 * edit to desynchronise the base from its targets, and the morph is authored in
 * the same language as the model.
 *
 * @param gape  0..1 — mouth shut to fully open, plus the throat swell.
 * @param flare 0..1 — crown spines laid back to splayed wide.
 */
function buildHeadNeck(gape = 0, flare = 0): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Throat. Swells with the gape: this is the part a hinge could never do.
  const throat = 1 + gape * 0.26;
  parts.push(at(zTube(0.082 * throat, 0.07 * throat, NECK_LEN / 2, 6, true, -1), 0, 0, 0));
  parts.push(
    at(zTube(0.07 * throat, 0.058 * throat, NECK_LEN / 2, 6, true, -1), 0, -0.012, -NECK_LEN / 2),
  );

  const skullZ = -NECK_LEN - SKULL_HALF + 0.045;
  const skull = new THREE.SphereGeometry(0.105, 8, 5);
  skull.scale(0.7 * (1 + flare * 0.07), 0.78 * (1 - gape * 0.05), SKULL_HALF / 0.105);
  parts.push(at(skull, 0, -0.018, skullZ));

  // Jaw. Hangs, slightly open — the only feature on the head, and it is a mouth
  // rather than an eye, which is the correct thing for a blind hunter to lead
  // with. The hinge is at its REAR face, so opening swings the chin down and
  // forward the way a jaw does, rather than sliding the whole box downward.
  const hingeZ = skullZ + 0.06;
  const jaw = chamferedBox({ x: 0.062, y: 0.03, z: 0.2 }, 0.01);
  jaw.rotateX(0.22);
  jaw.translate(0, -0.072, skullZ - 0.04 - hingeZ);
  jaw.rotateX(-gape * 0.62);
  parts.push(at(jaw, 0, 0, hingeZ));

  const tongue = new THREE.ConeGeometry(0.022, 0.11, 4);
  tongue.rotateX(-Math.PI / 2 + 0.3);
  tongue.translate(0, -0.05, skullZ - 0.13 - hingeZ);
  tongue.rotateX(-gape * 0.52);
  parts.push(at(tongue, 0, 0, hingeZ - gape * 0.03));

  for (const side of [-1, 1]) {
    const spine = blade(0.012, 0.14, 0.03);
    spine.rotateX(1.15 - flare * 0.46);
    spine.rotateZ(side * (0.4 + flare * 0.5));
    parts.push(at(spine, side * (0.035 + flare * 0.022), 0.02, skullZ + 0.1));
  }

  const g = mergeParts(parts);
  g.name = 'alien-head';
  return g;
}

/** Index into the head's morph targets. Named, because `[0]` and `[1]` at the
 *  call site is how a mouth ends up opening when the creature is listening. */
export const MORPH_GAPE = 0;
export const MORPH_FLARE = 1;

/**
 * The head, with its two morph targets attached as RELATIVE deltas.
 *
 * Relative rather than absolute so the two blend independently and additively:
 * an ATTACK is gape 1 AND flare 1 at the same time, and absolute targets would
 * have made that a choice between them.
 */
function buildHeadWithMorphs(): THREE.BufferGeometry {
  const base = buildHeadNeck(0, 0);
  const basePos = base.getAttribute('position');
  const delta = (variant: THREE.BufferGeometry): THREE.BufferAttribute => {
    const v = variant.getAttribute('position');
    if (v.count !== basePos.count) {
      throw new AlienCoherenceError(
        `head morph topology drifted: base has ${basePos.count} vertices, the variant has ` +
          `${v.count}. Every primitive in buildHeadNeck must keep its segment counts across ` +
          `the whole parameter range`,
      );
    }
    const out = new Float32Array(v.count * 3);
    for (let i = 0; i < out.length; i++) out[i] = v.array[i] - basePos.array[i];
    variant.dispose();
    return new THREE.BufferAttribute(out, 3);
  };
  base.morphAttributes.position = [delta(buildHeadNeck(1, 0)), delta(buildHeadNeck(0, 1))];
  base.morphTargetsRelative = true;
  return base;
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
 *
 * THE DIGITS NOW FAN FORWARD rather than hanging straight down, and that is a
 * mechanical change, not a stylistic one. `ik.ts` places a point on the bone's
 * OWN AXIS, so whatever touches the deck has to be on that axis — and the
 * fingertips of a downward-hanging hand sat 0.86 m from the elbow, which put
 * the chain's inner reach limit (|l1 − l2| = 0.45 m) right where a crouching
 * pose wants to be. Contact moved up to the knuckle pad at {@link ARM_L2} and
 * the fingers reach ahead of it, which is both solvable and a better hand: this
 * animal walks on its knuckles with its fingers spread on the plating.
 */
function buildForearm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(yLimb(0.055, 0.03, FOREARM_L, 8), 0, 0, 0));
  parts.push(at(chamferedBox({ x: 0.085, y: 0.05, z: 0.115 }, 0.015), 0, -FOREARM_L - 0.02, 0));

  const wrist = -FOREARM_L - 0.055;
  for (const spread of [-1, 0, 1]) {
    const digit = new THREE.ConeGeometry(0.017, HAND_L, 4);
    // Forward and a little down: the apex ends up ahead of the knuckle pad.
    digit.rotateX(-1.98);
    digit.rotateY(spread * 0.34);
    parts.push(at(digit, spread * 0.05, wrist - 0.01, -HAND_L * 0.42));
  }

  const g = mergeParts(parts);
  g.name = 'alien-forearm';
  return g;
}

/**
 * Hind limb, upper half: hip cap and thigh, built at the hip.
 *
 * This used to be one rigid dog-leg with the knee baked in at
 * {@link KNEE_BAKED}, and the argument for that was sound — a hind leg's knee
 * angle barely changes across a stride, so why spend a draw call on it. The
 * answer is that a baked knee has ONE degree of freedom at the hip, and one
 * degree of freedom cannot put a foot at a point in a plane. The old leg
 * therefore could not stand still: whatever the hip did, the foot swept an arc
 * through the deck. Splitting it is what makes the hind feet solvable, and
 * `KNEE_BAKED` survives only as the vacuum trail angle in {@link RAIL_LEGS}.
 */
function buildThigh(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(yLimb(0.082, 0.075, 0.09, 8), 0, 0.04, 0));
  parts.push(at(yLimb(0.072, 0.058, THIGH_L, 8), 0, 0, 0));
  const g = mergeParts(parts);
  g.name = 'alien-thigh';
  return g;
}

/** Hind limb, lower half: shin, ankle and three forward digits, built at the
 *  knee and hanging along −Y so the toe pad sits on the bone axis at
 *  {@link LEG_L2}. Same primitives the rigid dog-leg carried, so the split
 *  costs a draw call and not one triangle. */
function buildShin(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(yLimb(0.056, 0.038, SHIN_L, 8), 0, 0, 0));
  parts.push(at(new THREE.BoxGeometry(0.07, 0.05, 0.09), 0, -SHIN_L - 0.02, 0.015));
  for (const spread of [-1, 0, 1]) {
    const digit = new THREE.ConeGeometry(0.014, 0.13, 4);
    digit.rotateX(-Math.PI / 2 - 0.25);
    digit.rotateY(spread * 0.4);
    parts.push(at(digit, spread * 0.028, -SHIN_L - 0.035, -0.055));
  }
  const g = mergeParts(parts);
  g.name = 'alien-shin';
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
  /** Scan events per second. With `snap` at 0 this is the frequency of a
   *  continuous sine sweep; with `snap` at 1 it is how often the head jumps. */
  readonly sweepHz: number;
  /**
   * 0..1 — how STEPPED the scan is, and the newest thing on this table.
   *
   * At 0 the head sweeps like a windscreen wiper, which is what it did for the
   * whole of r3 and which nothing alive has ever done. At 1 it holds a bearing
   * dead still, then whips to a new one in about a tenth of a second and holds
   * again. A creature that HOLDS is a creature that is listening, and §5 says
   * this one hunts by sound — so the hold is not decoration, it is the animal
   * doing the only thing its perception model lets it do.
   *
   * It also gates the idle gait (see `HOLD_DEPTH`), so a parked SEARCH goes
   * genuinely, completely still between snaps. That stillness is the scariest
   * frame in the game and it costs nothing.
   */
  readonly snap: number;
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
  /**
   * 0..1 — jaw. Drives {@link MORPH_GAPE}, so it swells the throat as well as
   * dropping the chin.
   *
   * Never zero, even asleep: a mouth clamped shut is a mask, and this animal
   * leads with the only feature it has.
   */
  readonly gape: number;
  /** 0..1 — crown spines. Drives {@link MORPH_FLARE}. Rises with attention
   *  rather than with aggression, so a SEARCH flares wide without opening its
   *  mouth — the closest thing a creature with no eyes has to a stare. */
  readonly flare: number;
}

const POSTURES: Readonly<Record<AlienState, AlienPosture>> = Object.freeze({
  // Coiled and barely moving. Whatever is in the room with you is asleep.
  DORMANT: {
    cadence: 0,
    idleHz: 0.14,
    headLift: -0.42,
    headSweep: 0.03,
    sweepHz: 0.2,
    // Asleep, and twitching. Almost no sweep to give away.
    snap: 0.85,
    crouch: 1,
    arch: 0.16,
    stride: 0,
    tail: 0.15,
    reach: -0.3,
    gape: 0.06,
    flare: 0,
  },
  // Level head, unhurried, long stride. §5's 1.5 m/s: above your walk, below
  // your sprint, and it should LOOK like it is not trying.
  PATROL: {
    cadence: 1,
    idleHz: 0.35,
    headLift: 0.06,
    headSweep: 0.1,
    sweepHz: 0.5,
    // Mostly smooth. It is not looking for you yet.
    snap: 0.45,
    crouch: 0.16,
    arch: 0.03,
    stride: 0.85,
    tail: 0.7,
    reach: 0,
    gape: 0.12,
    flare: 0.12,
  },
  INVESTIGATE: {
    cadence: 0.9,
    idleHz: 0.5,
    headLift: 0.22,
    headSweep: 0.36,
    sweepHz: 0.8,
    // It heard something and is checking places one at a time.
    snap: 0.8,
    crouch: 0.28,
    arch: 0.06,
    stride: 0.7,
    tail: 0.85,
    reach: 0.05,
    gape: 0.26,
    flare: 0.45,
  },
  // Head high and sweeping wide, body low, feet slow. §5 says most kills
  // happen in SEARCH, so this is the posture worth learning to recognise.
  SEARCH: {
    cadence: 0.8,
    idleHz: 0.55,
    headLift: 0.3,
    headSweep: 0.58,
    sweepHz: 1.05,
    // THE tell, and total. Hold, snap, hold.
    snap: 1,
    crouch: 0.45,
    arch: 0.1,
    stride: 0.6,
    tail: 1,
    reach: 0.1,
    gape: 0.34,
    flare: 0.78,
  },
  // Flattened, nose down, reaching. §5: "It makes loud noise while hunting" —
  // it should look like it too, because a silent charge reads as a bug.
  HUNT: {
    cadence: 1.15,
    idleHz: 0.9,
    headLift: -0.26,
    headSweep: 0.05,
    sweepHz: 1.6,
    // Locked forward. Nothing to scan for; it already knows.
    snap: 0,
    crouch: 0.04,
    arch: -0.13,
    stride: 1.3,
    tail: 1.35,
    reach: 0.32,
    gape: 0.72,
    flare: 0.95,
  },
  ATTACK: {
    cadence: 1.25,
    idleHz: 1.4,
    headLift: -0.4,
    headSweep: 0.02,
    sweepHz: 2.2,
    // Locked forward.
    snap: 0,
    crouch: 0,
    arch: -0.2,
    stride: 1.45,
    tail: 1.5,
    reach: 0.4,
    gape: 1,
    flare: 1,
  },
  // Leaving, and looking back while it does. The one posture that should read
  // as relief.
  RETREAT: {
    cadence: 1.05,
    idleHz: 0.6,
    headLift: 0.1,
    headSweep: 0.3,
    sweepHz: 0.9,
    // Leaving, and looking back over its shoulder as it goes.
    snap: 0.55,
    crouch: 0.2,
    arch: 0.02,
    stride: 1,
    tail: 1.1,
    reach: -0.1,
    gape: 0.2,
    flare: 0.3,
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
// Secondary motion — the part that reads as alive
// ===========================================================================

/**
 * WHY THIS SECTION EXISTS.
 *
 * The gait below is solved, it is correct, and it still read as a puppet —
 * because every joint on the creature was one `Math.sin()` of one phase scalar.
 * Sine is the most predictable signal there is: nothing holds, nothing snaps,
 * nothing arrives late, and everything is perfectly symmetric about a midpoint
 * you can see coming. Dread is a PREDICTABILITY VIOLATION. You are not
 * frightened by the thing in the corridor; you are frightened by the thing that
 * stops doing what the last two seconds said it would.
 *
 * Three mechanisms, none of which costs a triangle or a material:
 *
 *   1. LAG. Heavy dangling things trail the body that swings them and overshoot
 *      when it stops. The tail and the head each get an UNDERDAMPED spring, so
 *      a turn throws the tail wide and it settles late. Forty lines, and it is
 *      the single biggest alive-versus-articulated delta available here.
 *   2. HOLD AND SNAP. The head scan dwells, dead still, then whips to a new
 *      bearing in ~110 ms. While it dwells the idle gait is gated off, so a
 *      parked SEARCH is genuinely motionless between snaps.
 *   3. BREATH. A rib cycle at its OWN rate, skewed (fast in, slow out), so the
 *      body is never quite at rest even when the gait clock has stopped.
 *
 * All three are deterministic — see {@link scanBearing} for why that is
 * load-bearing rather than merely tidy.
 */

/** One 1-D spring: position and velocity, integrated in place. */
export interface Spring {
  x: number;
  v: number;
}

function spring(x = 0): Spring {
  return { x, v: 0 };
}

/**
 * Advance a spring toward `target` and return its new position.
 *
 * Semi-implicit Euler, SUBSTEPPED. A backgrounded tab hands the next frame a
 * 250 ms `dt`, and at these stiffnesses an unsubstepped step that size is
 * unstable — the first frame after you alt-tab back would fire the tail through
 * the ceiling. Six substeps cap the effective step at ~16 ms.
 *
 * `damping` is deliberately below `2 * Math.sqrt(stiffness)`, i.e. UNDERDAMPED.
 * The overshoot is the entire point: it is the follow-through. A critically
 * damped spring gives a smooth lag, and smooth lag is what the sine wave the
 * whole section replaces already had.
 */
function springTo(
  s: Spring,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
): number {
  const steps = Math.min(6, Math.max(1, Math.ceil(dt / 0.016)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.v += (stiffness * (target - s.x) - damping * s.v) * h;
    s.x += s.v * h;
  }
  return s.x;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Head yaw. Damping ratio about 0.43 — it arrives fast and rings once, which
 *  is what a head on a 0.34 m neck does when something yanks it. */
const HEAD_YAW_K = 118;
const HEAD_YAW_C = 9.4;
/** Head pitch. Slower and looser, so a posture change lands LATE: the body
 *  commits to a HUNT and the head catches up a beat afterwards. */
const HEAD_PITCH_K = 42;
const HEAD_PITCH_C = 7.2;
/** Tail. Much looser than the head — 0.72 m of tapering mass, and it shows. */
const TAIL_YAW_K = 52;
const TAIL_YAW_C = 4.9;
const TAIL_PITCH_K = 38;
const TAIL_PITCH_C = 5.6;

/** How much of the hips' lead the tail gives away. Above 1 it overshoots on its
 *  own account as well as through the spring, and that is the whip. */
const TAIL_LAG_GAIN = 1.15;
/** rad per rad/s — how far a turn throws the tail out, and the cap on it. The
 *  server may snap the alien's heading between two snapshots; an unclamped tail
 *  would helicopter on the frame it does. */
const TAIL_TURN_GAIN = 0.26;
const TAIL_TURN_MAX = 0.5;
/**
 * rad — how far the tail hangs on a deck. Zero in vacuum, and the transition is
 * SPRUNG, so a §5 director floor drop makes the tail drift upward over about a
 * second. Nobody will be able to say why the room started feeling wrong.
 *
 * Bounded by the plating: `assertAlienCoherent()` proves the tip clears it in
 * every state, at every gait phase, at full droop.
 */
const TAIL_DROOP = 0.2;

/** rad and m — breath, on the chest only. Deliberately small: a visible heave
 *  on a 2.4 m animal is a bellows, not a lung. */
const BREATH_ARCH = 0.02;
const BREATH_HEAVE = 0.006;
/** Hz — resting breath, plus arousal. `idleHz` is already the arousal dial, so
 *  the rate is derived from it rather than becoming an eighth column on the
 *  posture table. It must never be a multiple of the gait rate: the two cycles
 *  have to beat against each other or the breath just reads as more gait. */
const BREATH_BASE_HZ = 0.2;
const BREATH_AROUSAL = 0.5;
/** Fraction of the cycle spent inhaling. Under a half, so the wave is skewed —
 *  a fast draw and a long release, which is what breathing sounds like and
 *  therefore what it has to look like. */
const BREATH_INHALE = 0.35;

/** Fraction of a scan cycle spent moving. 0.12 at SEARCH's 1.05 Hz is ~114 ms:
 *  fast enough to read as a snap rather than as a turn. */
const SCAN_SNAP_FRAC = 0.12;
/** Fraction spent settling after the snap before the body may go dead still. */
const SCAN_SETTLE_FRAC = 0.13;
/** How much of the idle gait a full hold suppresses. NOT 1 — the breath keeps
 *  running, and a body at exactly zero for a second reads as a dropped frame
 *  rather than as stillness. */
const HOLD_DEPTH = 0.9;

/** Stance fraction standing still, and at a full-speed HUNT. A stalking
 *  quadruped keeps three feet down; a charging one keeps one. */
const DUTY_STAND = 0.68;
const DUTY_RUN = 0.42;
/** m/s at which `DUTY_RUN` is reached. §5's HUNT speed, so the fastest thing
 *  the server can ask for is exactly the fastest gait this can draw. */
const DUTY_FULL_SPEED = 3.0;

/**
 * Where the head snaps to on scan cycle `i`, as a signed fraction of
 * `headSweep`.
 *
 * DETERMINISTIC, and that is load-bearing rather than tidy. `phase` starts at
 * zero on every client for the reason documented on that field: two people
 * looking at the same creature and calling out what it is doing over proximity
 * voice have to be looking at the SAME creature. `Math.random()` here would
 * have given each of them a monster that checked different corners. An integer
 * hash of the cycle index gives every client the same sequence for free, and
 * carries exactly the drift the gait phase already carries and not one bit
 * more.
 *
 * Biased away from centre — magnitude 0.4..1.0, either sign — so a snap is
 * always a snap. A run of near-zero targets would read as the head jamming.
 */
function scanBearing(i: number): number {
  let h = Math.imul(i | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  const v = ((h >>> 0) / 0xffffffff) * 2 - 1;
  return (v < 0 ? -1 : 1) * (0.4 + 0.6 * Math.abs(v));
}

/**
 * Everything `pose()` needs that is NOT a function of the gait phase.
 *
 * Solved once a frame in `AlienView.applyPose` and passed in, which is what
 * keeps `pose()` a pure function of its arguments — and that is what lets
 * `alienContactReport()` probe an arbitrary phase without building a view, a
 * renderer or a clock.
 */
export interface Secondary {
  /** rad — head yaw AFTER the spring. The scan is the spring's TARGET; this is
   *  where the head actually got to, overshoot included. */
  readonly headYaw: number;
  /** rad — how far the head's pitch still lags its own posture. */
  readonly headPitch: number;
  /** rad — tail yaw in pelvis-local space: the lag, plus the turn. */
  readonly tailYaw: number;
  /** rad — tail pitch: the droop, sprung against the gravity blend. */
  readonly tailPitch: number;
  /** -1..1 — the breath. -1 is fully exhaled. */
  readonly breath: number;
  /**
   * m — how far the body covers in one gait cycle: `speed / hz`.
   *
   * The single most important number in the locomotion, because it is what
   * makes the contacts world-fixed. It is DERIVED, never authored: the same
   * measured speed drives it and the cadence, so a foot cannot disagree with
   * the metres actually covered no matter what §5's director does to the
   * speeds. Zero means the creature is standing, and standing means planted.
   */
  readonly travel: number;
  /** 0..1 — fraction of the cycle a foot spends on the deck. Walks are around
   *  0.65, gallops around 0.4, and the difference is legible from down a
   *  corridor because it changes how much of the time the body is airborne. */
  readonly duty: number;
  /** 0..1 — the jaw morph, after breath and chatter. Not a joint; see
   *  {@link MORPH_GAPE}. */
  readonly gape: number;
  /** 0..1 — the crown-spine morph. */
  readonly flare: number;
}

/** Mutable working copy, so the per-frame solve allocates nothing. */
type SecondaryAccum = { -readonly [K in keyof Secondary]: number };

/** A creature with no secondary motion at all: what a freshly built rig poses
 *  into, and the baseline the contact check probes around. */
export const SECONDARY_REST: Secondary = Object.freeze({
  headYaw: 0,
  headPitch: 0,
  tailYaw: 0,
  tailPitch: 0,
  breath: 0,
  travel: 0,
  duty: DUTY_STAND,
  gape: 0,
  flare: 0,
});

// ===========================================================================
// The rig
// ===========================================================================

interface AlienRig {
  readonly root: THREE.Object3D;
  readonly carriage: THREE.Object3D;
  readonly chest: THREE.Object3D;
  readonly neck: THREE.Object3D;
  readonly pelvis: THREE.Object3D;
  /** The tail's own joint, hung off the pelvis. Everything it does is lag. */
  readonly tail: THREE.Object3D;
  readonly shoulder: readonly [THREE.Object3D, THREE.Object3D];
  readonly elbow: readonly [THREE.Object3D, THREE.Object3D];
  readonly hip: readonly [THREE.Object3D, THREE.Object3D];
  /** The knee (hock), which the r3 rig did not have — the shin was baked into
   *  the thigh at {@link KNEE_BAKED}. IK needs the joint. */
  readonly knee: readonly [THREE.Object3D, THREE.Object3D];
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
  const tail = node(pelvis, 'tail', 0, 0, TAIL_JOINT_Z);
  const hipL = node(pelvis, 'hip-l', -HIP.x, HIP.y, HIP.z);
  const hipR = node(pelvis, 'hip-r', HIP.x, HIP.y, HIP.z);
  const kneeL = node(hipL, 'knee-l', 0, -THIGH_L, 0);
  const kneeR = node(hipR, 'knee-r', 0, -THIGH_L, 0);
  return {
    root,
    carriage,
    chest,
    neck,
    pelvis,
    tail,
    shoulder: [shoulderL, shoulderR],
    elbow: [elbowL, elbowR],
    hip: [hipL, hipR],
    knee: [kneeL, kneeR],
  };
}

// ===========================================================================
// Locomotion — where the contacts go, and the IK that puts them there
// ===========================================================================

/**
 * r3 posed this creature by choosing joint angles until the average pose grazed
 * the deck, and `alienContactReport()` exists because that is a thing you have
 * to keep checking. Every limb constant below has been deleted. The chain now
 * runs the other way: the CONTACT is authored, and `src/alien/ik.ts` works out
 * what the joints must be.
 *
 * The payoff is not tidiness, it is that **contacts cannot slide**. Read the
 * two lines in `contactAt()` that do it:
 *
 *   • the body covers `sec.travel` metres per gait cycle — that number comes
 *     from `speed / hz`, i.e. from the same measured speed that sets the
 *     cadence, so it is right by construction at any speed the server invents;
 *   • a foot is on the deck for `sec.duty` of the cycle, during which the body
 *     covers `travel * duty` — so the foot travels exactly `travel * duty`
 *     backward through body space and its world position does not move.
 *
 * There is no tuning constant in that. `assertAlienCoherent()` measures the
 * residual and requires it to be zero to within float error.
 */

/** Spine motion that is not a limb: the heave, the deck's undulation, and the
 *  travelling wave that carries the creature along a rail. */
const SPINE = Object.freeze({
  /** Vertical bob, metres, at twice the stride rate: four feet, two beats. */
  bob: 0.022,
  /** rad — lateral undulation at the hips ON A DECK. Small, because the spine's
   *  job while walking is to lengthen the stride a little without upsetting
   *  four planted feet. In vacuum the swim below replaces it entirely. */
  yawWalk: 0.1,
  rollWalk: 0.055,
  rollRail: 0.1,

  /**
   * rad — amplitude scale of the swim wave, at the tail end of its envelope.
   *
   * Not a joint angle. Every spine joint's angle is DERIVED from this by the
   * envelope and the phase in {@link spineWaveAt}, so turning it up bends the
   * whole animal more without changing the shape it makes.
   *
   * BOUNDED BY THE TUBE, not by taste. A straight kit piece has a 1.0 m bore
   * with its zero-G handrails 0.70 m off the axis, which leaves about 0.71 m of
   * lateral room beside the rail the creature is threaded on. The first value
   * tried here was 1.15 and it swept the tail tip ±0.75 m at HUNT — through the
   * hull. `assertAlienCoherent()` measures the excursion against
   * {@link SPINE_LATERAL_LIMIT} now, so this is a solved number and the check
   * fails if anyone re-solves it upward.
   */
  swimAmp: 0.75,
  /**
   * How many wavelengths sit on the body at once. THE number that decides
   * whether this reads as slithering or as a fish stick being waggled.
   *
   * Under about 1.1 the joints all bend the same way at the same time and the
   * body is a single C — which is what the first attempt at this produced, and
   * it looked exactly as rigid as the geometry it was made of. The eye reads
   * "alive" from the INFLECTION: a body bending one way at the shoulders and
   * the other way at the hips is doing something no rigid object can do. 1.45
   * puts two inflections on it at every phase of every state, which
   * `assertAlienCoherent()` checks.
   *
   * The ceiling is the skeleton. Four spine joints can hold only so many crests
   * before consecutive segments disagree by enough that the rigid geometry
   * between them reads as a kink rather than a curve.
   */
  swimWaves: 1.45,
  /**
   * Envelope exponent — how fast the amplitude grows from nose to tail.
   *
   * Above 1, so the head is the quiet end. This is the correction that made the
   * wave work: with a flat envelope the NOSE had the largest excursion of
   * anything on the body — 760 mm, more than the tail tip — because the head
   * hangs 0.9 m off a pivoting pelvis. An animal that waves its own head about
   * cannot aim, and this one hunts by pointing its face at sounds. At 1.7 the
   * nose moves 281 mm and the tail tip 1119 mm, which is the right way round.
   */
  swimEnvelope: 1.7,
  /**
   * The DORSOVENTRAL half of the wave, as a share of the lateral amplitude and
   * a quarter-cycle behind it.
   *
   * A purely lateral wave is a flat S, and a flat S seen from a corridor rather
   * than from directly above is a body twitching side to side. The vertical
   * component makes the travelling shape a helix, which reads as swimming from
   * every angle — including the one the player actually has.
   */
  swimPitchShare: 0.4,
});

/**
 * The hind legs in vacuum, which are the one limb pair that is NOT solved.
 *
 * A trailing leg has nothing to stand on and nothing to grab, so there is no
 * contact to author and IK has no question to answer. These are the r3 angles
 * verbatim, including the baked knee, so a zero-G alien looks exactly like the
 * one that shipped — and the blend to them is a slerp, because §5's director
 * can cut a module's floor while it is mid-stride.
 */
const RAIL_LEGS = Object.freeze({
  hipPitch: -0.5,
  hipPitchAmp: 0.22,
  hipSplay: 0.22,
  knee: -KNEE_BAKED,
});

/**
 * Where the contacts live, in RIG space — the frame whose origin the server
 * puts `ALIEN_DECK_DROP_M` above the plating.
 *
 * Rig space and not chest space, deliberately. The chest yaws and bobs and
 * arches with the gait; a plant expressed relative to it would inherit all of
 * that and jitter by the few millimetres that make an eye call something fake.
 * These are constants derived from the skeleton, and `ik.ts` transforms them
 * into whatever space each joint's parent happens to be in this frame.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VACUUM CASE, AND WHY IT NEEDED THE BODY TO TURN OVER
 *
 * r3's vacuum pose put the handholds ABOVE an unrotated body and left it at
 * that. It looked exactly as wrong as it was: a limb here hangs along −Y from
 * its joint, so reaching for something overhead makes the solver fold the whole
 * arm up and back over the shoulder. The creature read as having its arms on
 * upside down, because in every sense that matters it did.
 *
 * The fix is not to bend the arms differently, it is to TURN THE CREATURE OVER,
 * and the station geometry says the same thing. `tubeRails()` in
 * `src/station/kit.ts` runs a pair of rails the length of every module at
 * `v3(±tubeRailX(radius), RAIL_Y_M, z)` — high on the bore, about 70% of the
 * way to the crown, and close enough to the centreline to read as an overhead
 * pair rather than as wall furniture. `server/sim/alien.ts` snaps the creature
 * ONTO one of them. So the thing is threaded on an overhead bar, and a body
 * hauling itself along an overhead bar hangs UNDER it. See {@link VACUUM_ROLL}.
 *
 * (Those rails are no longer gravity-dependent: `RAIL_ABOVE_DECK_M` clears a
 * standing crewmate by 0.22 m so that §4's promise — 2.5 s of warning before a
 * floor fails is only fair if there is something grabbable overhead — holds in
 * every module. The creature inherits that: same bar, both regimes.)
 *
 * Everything below therefore describes one contact plane and how far the limbs
 * reach into it. The plane rotates with the body; the reach shortens from the
 * deck's 0.45 m to a hand's width. Deck, vacuum, and every blend in between is
 * the same arithmetic — which is the mechanical version of §5's promise that
 * "it pulls along the same handrails in a room you are walking through as in
 * one you are floating in". The same arms, and now provably the same solve.
 */
const CONTACT = Object.freeze({
  /** Rig Z of the shoulder and hip joints at rest. Derived, not measured. */
  frontJointZ: CHEST_Z + SHOULDER.z,
  hindJointZ: PELVIS_Z + HIP.z,
  /** How far ahead of the shoulder a forehand plants, and behind the hip a
   *  hind foot does. A quadruped's forelimbs land ahead of the shoulder; its
   *  hind feet land under and behind the hip. */
  frontLead: -0.1,
  hindLead: 0.05,
  /** Lateral stance, added to the joint's own x. Grows with crouch, because
   *  crouching a quadruped means SPLAYING it — the r3 comment was right about
   *  that even though the mechanism it described has gone. */
  frontSplay: 0.085,
  frontSplayCrouch: 0.09,
  hindSplay: 0.07,
  hindSplayCrouch: 0.07,
  /** m — how high a foot lifts at the top of its swing, at full stride. */
  lift: 0.1,

  // -- vacuum -------------------------------------------------------------
  /**
   * m — how far a hand reaches into the contact plane when hauling on a rail,
   * against `ALIEN_DECK_DROP_M`'s 0.45 on a deck.
   *
   * Shorter than the deck's, because the server has already put the body's
   * CENTRE on the rail line — the hands have to get to a bar, not down to a
   * floor. Not much shorter, and the reason is geometry rather than taste.
   *
   * SOLVED, not chosen. A 0.41 m upper arm against a 0.69 m forearm-and-hand
   * leaves a 0.286 m hole around the shoulder that no elbow angle can reach
   * into, and a contact orbiting close to the spine spends its whole stroke
   * near that hole. Sweeping reach against lead against duty for the widest
   * margin puts the usable optimum here: 0.26 with {@link CONTACT.railLead} and
   * {@link DUTY_RAIL} leaves 16% of the reach band in hand at the tightest
   * point of the tightest state, against 3% for the value shipped before.
   *
   * The result also happens to be right: 0.26 hangs the body about a hand's
   * width clear of its own belly, which is what holding onto something looks
   * like. It is a larger decorative offset from the server's position than the
   * name suggests, and the deck already carries a 0.45 m one of exactly the
   * same kind.
   */
  railReach: 0.26,
  /** Narrower than a deck stance: hands go on the bar, not either side of it. */
  railSplay: 0.045,
  /**
   * A rail pull reaches much further ahead than a footfall does — the gait is
   * grab-far and haul-through, and this is the far. Also solved: it is what
   * centres the stroke in the arm's usable window rather than letting the back
   * of it fall into the inner hole.
   */
  railLead: -0.52,
});

/**
 * Stance fraction in vacuum, against `DUTY_STAND`/`DUTY_RUN` on a deck.
 *
 * Low, and it is the physics rather than a fudge: hauling along a rail is grab,
 * pull, RELEASE, glide, regrip. §4 gives the player exactly that and §5 prices
 * the alien's rail pull against it. A hand is on the bar for a bit over a third
 * of the cycle and free for the rest.
 *
 * It also buys back most of the reach problem above. Contact travel is
 * `travel * duty` — that is the no-slide identity and it holds in both regimes
 * — so a shorter duty is a shorter stroke, and a shorter stroke fits inside the
 * arm's usable window with room to spare.
 */
const DUTY_RAIL = 0.38;

/**
 * rad — how far the creature rolls about its own travel axis in vacuum.
 *
 * A half turn, so the ventral side it folds its limbs onto faces the overhead
 * rail. Blended through `AlienView.ground`, which is smoothed at 2.4 — so a §5
 * director floor drop does not flip the animal in a frame, it turns it over
 * across about a second, starting inside the 2.5 s announcement window while
 * somebody is watching. That is the most legible thing this creature does and
 * it costs one term.
 *
 * A half turn and not a quarter, even though the rails sit `tubeRailX` off the
 * centreline rather than on it: at `RAIL_Y_M` that offset is a small fraction
 * of the bore radius, so the bar is overhead far more than it is beside, and
 * rolling only 90° would hang the creature off the WALL — which is both wrong
 * and much less frightening than something inverted on the ceiling. The view
 * cannot know which of the two rails the server picked, so it commits to the
 * pose that is right for either.
 *
 * The number is not free to change: {@link CONTACT}'s whole formulation assumes
 * the contact plane and the body rotate TOGETHER, and `assertAlienCoherent()`
 * now checks both gravity regimes, so a partial roll is a supported pose rather
 * than a broken one — it just means clinging to a side wall instead.
 */
const VACUUM_ROLL = Math.PI;

/** m — bone lengths, as the IK sees them. `l2` is to the CONTACT PAD, never to
 *  the fingertip: the solver places a point on the bone's own axis, and the
 *  digits fan forward past it. */
const ARM_L1 = UPPER_ARM_L;
const ARM_L2 = FOREARM_L + 0.07;
const LEG_L1 = THIGH_L;
const LEG_L2 = SHIN_L + 0.05;

/** Which way each middle joint bulges (see `solveTwoBone`). An elbow bends
 *  backward, a hock bends forward, and getting these two the wrong way round
 *  is the single funniest bug available in this file. */
const ARM_POLE = new THREE.Vector3(0, 0, 1);
const LEG_POLE = new THREE.Vector3(0, 0, -1);
const FORWARD = new THREE.Vector3(0, 0, -1);

/** Phase offset per limb, in CYCLES, as the diagonal couplet §5 wants: front
 *  left with hind right. Order is [frontL, frontR, hindL, hindR]. */
const LIMB_OFFSET: readonly number[] = Object.freeze([0, 0.5, 0.5, 0]);

// Scratch for the limb solve. Reused; see the note in ik.ts.
const _target = new THREE.Vector3();
const _jointLocal = new THREE.Vector3();
const _chestInv = new THREE.Matrix4();
const _pelvisInv = new THREE.Matrix4();
const _authored = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _armOut = twoBoneOut();
const _legOut = twoBoneOut();

function fract(v: number): number {
  return v - Math.floor(v);
}

/**
 * The rig-space contact for one limb this frame. THE one place it is computed.
 *
 * `alienContactReport()` calls this too rather than re-deriving it, which is
 * the whole reason it is a function: a check that reimplements the thing it is
 * checking agrees with itself and with nothing else.
 *
 * @param side  −1 left, +1 right, in the creature's OWN frame. After a vacuum
 *              roll that is the opposite side in rig space, which the rotation
 *              below handles — a left hand stays on the left arm.
 */
function limbContact(
  out: THREE.Vector3,
  p: PostureAccum,
  sec: Secondary,
  ground: number,
  phase: number,
  side: -1 | 1,
  front: boolean,
): void {
  const air = 1 - ground;

  // The contact plane, and how far into it the limb reaches. On a deck that is
  // the plating; in vacuum it is the bar, and the body has rolled to face it.
  const reach = ALIEN_DECK_DROP_M * ground + CONTACT.railReach * air;
  const splay = front
    ? (CONTACT.frontSplay + p.crouch * CONTACT.frontSplayCrouch * ground) * ground +
      CONTACT.railSplay * air
    : (CONTACT.hindSplay + p.crouch * CONTACT.hindSplayCrouch * ground) * ground +
      CONTACT.railSplay * air;
  const jointX = front ? SHOULDER.x : HIP.x;
  const jointZ = front ? CONTACT.frontJointZ : CONTACT.hindJointZ;
  const lead = front
    ? (CONTACT.frontLead - p.reach * 0.22) * ground + CONTACT.railLead * air
    : CONTACT.hindLead * ground;

  // Rotate the offset into the rolled frame. At `air` = 0 this is the identity
  // and the limb reaches straight down; at 1 it reaches straight up, onto the
  // rail, with left and right swapped in rig space exactly as the rolled body
  // swapped them. Anything between is the animal turning over.
  const roll = VACUUM_ROLL * air;
  const c = Math.cos(roll);
  const sn = Math.sin(roll);
  const ox = side * (jointX + splay);
  const oy = -reach;
  const baseX = ox * c - oy * sn;
  const baseY = ox * sn + oy * c;

  // The swing arc lifts AWAY from the contact plane, so it rotates with it.
  const lift = CONTACT.lift * p.stride;
  const liftX = -lift * sn;
  const liftY = lift * c;

  const cycles = phase / (Math.PI * 2) + (LIMB_OFFSET[front ? (side < 0 ? 0 : 1) : (side < 0 ? 2 : 3)] as number);
  const u = fract(cycles);
  const duty = dutyAt(sec, ground);
  const travel = Math.max(0, sec.travel);
  // The distance the body covers while this contact is down. Equal to the
  // distance the contact must travel backward through body space; that equality
  // IS the no-slide guarantee and is why neither number is tunable alone.
  const stance = travel * duty;
  const z = jointZ + lead;

  if (u < duty) {
    const t = duty <= 0 ? 0 : u / duty;
    out.set(baseX, baseY, z + stance * (t - 0.5));
    return;
  }
  const t = duty >= 1 ? 0 : (u - duty) / (1 - duty);
  // A half-sine arc. Not a cubic: the contact should leave and land at a
  // shallow angle and be furthest out in the middle, and every extra term in
  // the curve is one more thing to disagree with the deck about.
  const arc = Math.sin(Math.PI * t);
  out.set(baseX + liftX * arc, baseY + liftY * arc, z + stance * (0.5 - t));
}

/**
 * The stance fraction actually in force: `sec.duty` is the DECK figure the
 * speed solve produced, and vacuum overrides it toward {@link DUTY_RAIL}.
 *
 * Applied here rather than in `advanceSecondary` so that `alienContactReport`,
 * which is handed a `Secondary` and a `GravityMode` separately, cannot end up
 * measuring a different gait from the one being drawn.
 */
function dutyAt(sec: Secondary, ground: number): number {
  const d = sec.duty * ground + DUTY_RAIL * (1 - ground);
  return d < 0.15 ? 0.15 : d > 0.9 ? 0.9 : d;
}

/** True when this limb is in contact rather than in its swing, at this phase. */
function limbPlanted(sec: Secondary, phase: number, ground: number, side: -1 | 1, front: boolean): boolean {
  const duty = dutyAt(sec, ground);
  const off = LIMB_OFFSET[front ? (side < 0 ? 0 : 1) : (side < 0 ? 2 : 3)] as number;
  return fract(phase / (Math.PI * 2) + off) < duty;
}


// ---------------------------------------------------------------------------
// The spine wave
// ---------------------------------------------------------------------------

/** Rig Z of the nose, and the nose-to-tail-tip length. Derived from the
 *  skeleton so a retuned body cannot leave the wave describing a different
 *  animal than the one being drawn. */
const NOSE_Z = CHEST_Z - 0.28 - (NECK_LEN + SKULL_HALF * 2 - 0.045);
const SPINE_TIP_Z = PELVIS_Z + TAIL_JOINT_Z + TAIL_TIP_LOCAL.z;
const SPINE_LENGTH = SPINE_TIP_Z - NOSE_Z;

/** Fractional arc length from the nose, 0..1, for a rig Z. */
function spineU(z: number): number {
  return (z - NOSE_Z) / SPINE_LENGTH;
}

/** Where each spine joint sits along the body. Constants, computed once. */
const U_NECK = spineU(CHEST_Z - 0.28);
const U_CHEST = spineU(CHEST_Z);
const U_PELVIS = spineU(PELVIS_Z);
const U_TAIL = spineU(PELVIS_Z + TAIL_JOINT_Z);

/**
 * Every angle the spine needs this frame.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS COMPUTES ABSOLUTE HEADINGS AND THEN SUBTRACTS THEM
 *
 * The obvious implementation gives each joint a phase-shifted sine and writes
 * it straight into `.rotation.y`. It does not slither, and the reason is worth
 * writing down because the fix is not obvious from the symptom.
 *
 * A joint angle in a scene graph is RELATIVE to its parent. So a set of
 * local angles that are all roughly in phase does not make a wave — it makes
 * every joint bend the same way at the same time, which is a single C-bend
 * hinged in four places. Measured on the real rig: one sign change along the
 * whole body, at any amplitude. That is a banana, and a banana cannot slither
 * however hard you wave it.
 *
 * A travelling wave is a statement about where each segment POINTS in the
 * world, not about the angle between neighbours. So the wave is evaluated as an
 * absolute heading per segment — amplitude from the envelope, phase from the
 * arc length — and the local angles are recovered by differencing along the
 * hierarchy. The joint between two segments moving in opposite directions then
 * gets a big angle and the joint between two moving together gets none, which
 * is what puts INFLECTIONS on the body instead of one long arc.
 *
 * The other thing it buys for free: the head stops swinging. With the envelope
 * heavier at the tail, `neckYaw` comes out as roughly minus the chest's
 * heading — the front of the animal automatically counter-rotates to hold its
 * nose steady while the wave passes underneath it. Nobody had to author that.
 *
 * On a DECK none of this applies: the deck terms are the r3 walk, where the
 * chest counter-yaws against the hips because a quadruped keeps four feet under
 * itself. Blended, never switched — §5's director cuts floors mid-stroke.
 */
interface SpineWave {
  pelvisYaw: number;
  chestYaw: number;
  neckYaw: number;
  tailYaw: number;
  pelvisPitch: number;
  chestPitch: number;
  neckPitch: number;
  tailPitch: number;
}

const _spineWave: SpineWave = {
  pelvisYaw: 0,
  chestYaw: 0,
  neckYaw: 0,
  tailYaw: 0,
  pelvisPitch: 0,
  chestPitch: 0,
  neckPitch: 0,
  tailPitch: 0,
};

function spineWaveAt(p: PostureAccum, phase: number, ground: number): SpineWave {
  const air = 1 - ground;
  const w = _spineWave;

  // -- the deck walk --------------------------------------------------------
  const walkAmp = SPINE.yawWalk * p.tail * ground;
  const walkPelvis = walkAmp * Math.sin(phase - 0.8);
  const walkChest = -walkAmp * 0.45 * Math.sin(phase);

  if (air < 0.001) {
    w.pelvisYaw = walkPelvis;
    w.chestYaw = walkChest;
    w.neckYaw = 0;
    w.tailYaw = 0;
    w.pelvisPitch = 0;
    w.chestPitch = 0;
    w.neckPitch = 0;
    w.tailPitch = 0;
    return w;
  }

  // -- the swim -------------------------------------------------------------
  const amp = SPINE.swimAmp * p.tail * air;
  const k = SPINE.swimWaves * Math.PI * 2;
  const pitchAmp = amp * SPINE.swimPitchShare;
  /** Absolute heading of the segment at fractional arc length `u`. */
  const yawOf = (u: number): number =>
    amp * Math.pow(u, SPINE.swimEnvelope) * Math.sin(phase - k * u);
  const pitchOf = (u: number): number =>
    pitchAmp * Math.pow(u, SPINE.swimEnvelope) * Math.cos(phase - k * u);

  const yN = yawOf(U_NECK);
  const yC = yawOf(U_CHEST);
  const yP = yawOf(U_PELVIS);
  const yT = yawOf(U_TAIL);
  const pN = pitchOf(U_NECK);
  const pC = pitchOf(U_CHEST);
  const pP = pitchOf(U_PELVIS);
  const pT = pitchOf(U_TAIL);

  // Differenced along the hierarchy: carriage → pelvis → chest → neck, and
  // pelvis → tail. Get this ordering wrong and the wave runs backwards.
  w.pelvisYaw = walkPelvis + yP;
  w.chestYaw = walkChest + (yC - yP);
  w.neckYaw = yN - yC;
  w.tailYaw = yT - yP;
  w.pelvisPitch = pP;
  w.chestPitch = pC - pP;
  w.neckPitch = pN - pC;
  w.tailPitch = pT - pP;
  return w;
}

/** Where the pelvis's yaw actually is this frame — the tail spring's target.
 *  Reads the same solve `poseSpine` uses; see the note above about drift. */
function spineYawAt(p: PostureAccum, phase: number, ground: number): number {
  return spineWaveAt(p, phase, ground).pelvisYaw;
}

/**
 * Pose the spine: carriage, pelvis, chest, neck, tail. No limbs.
 *
 * Split from the limbs because the limb solve needs `chest.matrixWorld` and
 * `pelvis.matrixWorld` to be CURRENT — it transforms rig-space contacts into
 * each joint's parent space — and those matrices are what this function
 * decides. Two `updateMatrixWorld` calls a frame on a thirteen-node rig is the
 * whole cost of getting that ordering right.
 */
function poseSpine(
  rig: AlienRig,
  p: PostureAccum,
  phase: number,
  sec: Secondary,
  ground: number,
): void {
  const air = 1 - ground;

  // -- carriage: how high the whole animal rides, and which way up ---------
  //
  // THE ROLL IS THE VACUUM POSE. See VACUUM_ROLL: a `zero` module's rails are
  // its floor-and-ceiling pair and the server threads the creature onto one, so
  // it hauls along hanging UNDER the bar. Without this term the handholds sit
  // above an upright body and the solver folds both arms back over the
  // shoulders — the creature reads as having its arms on upside down, which is
  // what it had. `limbContact` rotates the contact plane by the same angle, so
  // the body and the thing it is reaching for turn over together.
  const crouchDrop = p.crouch * 0.11 * ground;
  rig.carriage.position.set(0, -crouchDrop, 0);
  rig.carriage.rotation.set(
    0,
    0,
    VACUUM_ROLL * air +
      (SPINE.rollWalk * ground + SPINE.rollRail * air) * p.tail * Math.sin(phase * 0.5),
  );

  // -- spine: the deck's undulation, and in vacuum the SWIM -----------------
  //
  // All of it comes out of `spineWaveAt`, which is where the reasoning lives.
  // The short version: on a deck the chest counter-yaws against the hips like
  // any walking quadruped, and in vacuum the body carries a travelling wave
  // computed as absolute segment headings and differenced into joint angles —
  // because a set of in-phase LOCAL angles is a banana, not a wave.
  const w = spineWaveAt(p, phase, ground);

  rig.pelvis.rotation.set(
    w.pelvisPitch,
    w.pelvisYaw,
    SPINE.yawWalk * p.tail * ground * 0.5 * Math.sin(phase - 1.5),
  );

  // The chest hinges at the waist: the arch, the wave, and the heave. The heave
  // is two beats per stride, one per diagonal pair — and exactly zero in
  // zero-G, or the body reads as bouncing off a floor that is not there.
  //
  // The breath rides ON TOP of all of it and at its own rate (see BREATH_*).
  // A body whose ribs move only when its legs do is a puppet, and the beat
  // between the two cycles is most of what makes a standing creature unnerving.
  rig.chest.rotation.set(
    p.arch + sec.breath * BREATH_ARCH + w.chestPitch,
    w.chestYaw,
    0,
  );
  rig.chest.position.set(
    0,
    0.005 + SPINE.bob * p.stride * ground * Math.sin(phase * 2) + sec.breath * BREATH_HEAVE,
    CHEST_Z - PELVIS_Z,
  );

  // -- head ---------------------------------------------------------------
  // Both terms are SPRUNG, not raw. The yaw is the scan after the spring has
  // whipped past it and rung back; the pitch is how far behind its own posture
  // the head still is, so committing to a HUNT throws the skull a beat late.
  // The wave reaches the neck, ADDED to the scan rather than replacing it, so a
  // SEARCH still holds and snaps its bearings while the body swims under it.
  // `neckYaw` is usually close to minus the chest's heading — that is the
  // envelope doing its job, holding the nose still while the body passes.
  rig.neck.rotation.set(
    -p.headLift + sec.headPitch + w.neckPitch,
    sec.headYaw + w.neckYaw,
    sec.headYaw * 0.35,
  );

  // -- tail ---------------------------------------------------------------
  // LOCAL, so it composes with the pelvis yaw it is parented to: the spring
  // solved for how far behind the hips the tail is, and this is exactly that
  // deficit. Zero here means a tail that arrives with the hips, which is what
  // the baked tail did and what this whole part exists to stop doing.
  // The spring's lag and the wave's heading, added. The spring is what makes a
  // TURN throw the tail wide and settle it late; the wave is what makes the
  // tail the loudest part of a rail pull. They are different mechanisms and the
  // creature wants both.
  const tailYaw = sec.tailYaw + w.tailYaw;
  rig.tail.rotation.set(sec.tailPitch + w.tailPitch, tailYaw, tailYaw * 0.3);
}

/**
 * Solve all four limbs. Requires `poseSpine` and an `updateMatrixWorld` first.
 *
 * The two pairs differ in exactly three ways — where they plant, which way the
 * middle joint bends, and what happens to them in vacuum — so they share the
 * loop rather than each getting a hand-written copy that can drift.
 */
function poseLimbs(
  rig: AlienRig,
  p: PostureAccum,
  phase: number,
  sec: Secondary,
  ground: number,
): void {
  const air = 1 - ground;

  // Both chains hang off a parent that moved this frame, so the rig-space
  // contacts have to come back into that parent's space before the solve.
  _chestInv.copy(rig.chest.matrixWorld).invert();
  _pelvisInv.copy(rig.pelvis.matrixWorld).invert();

  for (let i = 0; i < 2; i++) {
    const side: -1 | 1 = i === 0 ? -1 : 1;

    // ---- forelimb ---------------------------------------------------------
    // One call, both regimes. On a deck it plants on the plating; in vacuum it
    // grips the rail the rolled body is hanging from; in between it does the
    // honest intermediate thing, because the plane it reaches into is rotating
    // at the same rate the body is.
    limbContact(_target, p, sec, ground, phase, side, true);
    const shoulder = rig.shoulder[i] as THREE.Object3D;
    const elbow = rig.elbow[i] as THREE.Object3D;
    _jointLocal.copy(_target).applyMatrix4(_chestInv);
    solveTwoBone(shoulder.position, _jointLocal, ARM_POLE, ARM_L1, ARM_L2, FORWARD, _armOut);
    shoulder.quaternion.copy(_armOut.root);
    elbow.quaternion.copy(_armOut.joint);

    // ---- hind limb --------------------------------------------------------
    limbContact(_target, p, sec, ground, phase, side, false);
    const hip = rig.hip[i] as THREE.Object3D;
    const knee = rig.knee[i] as THREE.Object3D;
    _jointLocal.copy(_target).applyMatrix4(_pelvisInv);
    solveTwoBone(hip.position, _jointLocal, LEG_POLE, LEG_L1, LEG_L2, FORWARD, _legOut);
    hip.quaternion.copy(_legOut.root);
    knee.quaternion.copy(_legOut.joint);

    if (air > 0.001) {
      // The hind limbs are the one pair that is NOT solved in vacuum: a
      // trailing leg has nothing to stand on and nothing to grab, so there is
      // no contact to author and the IK has no question to answer. Slerp to the
      // authored trail — RAIL_LEGS, the r3 angles verbatim.
      //
      // The arms are not treated this way and must not be. They DO have
      // something to grab, and §5's one genuinely nice property is that they
      // grab it with the same solve that walks.
      const swing = Math.sin(phase * 0.5 + (i === 0 ? 0 : Math.PI));
      _euler.set(
        RAIL_LEGS.hipPitch + p.stride * RAIL_LEGS.hipPitchAmp * swing,
        0,
        side * RAIL_LEGS.hipSplay,
      );
      hip.quaternion.slerp(_authored.setFromEuler(_euler), air);
      _euler.set(RAIL_LEGS.knee, 0, 0);
      knee.quaternion.slerp(_authored.setFromEuler(_euler), air);
    }
  }
}

/**
 * Pose the rig for one frame.
 *
 * `ground` is the gravity blend: 1 on a deck, 0 in a zero-G module, and the
 * intermediate values are a real transition rather than a debug slider — §5's
 * director can drop a module's floor under the alien mid-stride, and the
 * announcement window (§4, `GravityShiftEvent.inMs`) means the player is
 * watching when it happens.
 */
function pose(
  rig: AlienRig,
  p: PostureAccum,
  phase: number,
  sec: Secondary,
  ground: number,
): void {
  poseSpine(rig, p, phase, sec, ground);
  rig.root.updateMatrixWorld(true);
  poseLimbs(rig, p, phase, sec, ground);
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
  /**
   * Cast into the §9 flashlight shadow map. Defaults FALSE — and `main.ts`
   * turns it ON, deliberately, which is a reversal worth explaining.
   *
   * The old argument was that a 1024² map spent on the monster is a map not
   * spent on the doorway you are about to walk through. True, and beside the
   * point. `RemoteCrewViews` already spends the same map on other players
   * because "another player's shadow sliding across a bulkhead is the cheapest
   * *you are not alone* signal in the game" — and every word of that is more
   * true of the thing that is hunting you. A shadow arriving through a hatchway
   * BEFORE the body does is the only way this creature can be seen without
   * being looked at, and it is the cheapest scare in the project.
   *
   * The cost is real and it is bounded: seven more meshes in a shadow pass
   * measured at 34 draw calls, and only while the alien is inside the two-hop
   * cull set AND inside the torch's 13 m throw. Left default-false so a
   * headless or offscreen `AlienView` still costs nothing.
   */
  castShadow?: boolean;
  /**
   * Secondary motion — the sprung tail and head, the hold-and-snap scan, the
   * breath. ON by default and nothing in the game turns it off.
   *
   * It exists as a switch for exactly one caller: `alien.html`, the model
   * viewer, which offers an A/B against the r3 sine-only creature. That
   * comparison IS the argument for the whole section, and an argument you
   * cannot run is a claim. Construction-time rather than a setter, so the game
   * pays no per-frame branch for a debug affordance.
   */
  secondary?: boolean;
  /**
   * Use the flesh shader (`./flesh.ts`) rather than the plain palette material.
   * ON by default.
   *
   * Off gives you `PALETTE.organic` exactly as `StationMaterials` builds it —
   * the r3 surface — which is what the viewer's A/B wants and what a machine
   * that cannot afford one more `WebGLProgram` link would want. It is the same
   * COLOUR either way; what you lose is subsurface, rim, skin detail and crawl.
   */
  flesh?: boolean;
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
  private readonly tailPart: PartInstances;
  private readonly upperArmPart: PartInstances;
  private readonly forearmPart: PartInstances;
  private readonly thighPart: PartInstances;
  private readonly shinPart: PartInstances;
  private readonly parts: PartInstances[];
  private readonly ownedMaterial: THREE.Material | null;
  /** Non-null when the creature is wearing its own skin, which it is unless
   *  somebody asked for the flat palette material. Owns its material. */
  private readonly flesh: FleshMaterial | null;
  /** A sculpted body, once somebody has sculpted one. See `./skin.ts`. */
  private skin: AlienSkin | null = null;

  private readonly prev: Pose;
  private readonly curr: Pose;
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchFwd = new THREE.Vector3();

  private _state: AlienState = 'DORMANT';
  private _module: ModuleId = '';
  private _gravity: GravityMode = 'nominal';
  private _speed = 0;
  private _hasPose = false;
  private readonly emitBusEvents: boolean;
  private readonly cullByModule: boolean;
  private readonly useSecondary: boolean;
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
  /**
   * Scan cycles since construction, as a FLOAT and deliberately unwrapped.
   *
   * Its integer part indexes {@link scanBearing}, so wrapping it at 2π the way
   * `phase` wraps would restart the head's sequence of bearings every few
   * seconds and the creature would visibly check the same three corners for the
   * rest of the round.
   */
  private scanCycles = 0;
  /** 0..1 — how deep into a hold the head is. Gates the idle gait. */
  private hold = 0;
  /** Breath clock, 0..1, at its own rate. Never a multiple of the gait. */
  private breathPhase = 0;
  /** rad/s — the body's own yaw rate off the interpolated transform. This is
   *  what throws the tail wide on a corner, and it is measured rather than
   *  guessed because the server owns the heading. */
  private turnRate = 0;
  private prevYaw = 0;
  private hasYaw = false;

  /** Solved once a frame by `advanceSecondary`, read by `pose`. */
  private readonly secondary: SecondaryAccum = { ...SECONDARY_REST };
  /** Reused every frame; `setMorph` copies out of it immediately. */
  private readonly morphInfluences: number[] = [0, 0];
  private readonly headYawSpring = spring();
  private readonly headPitchSpring = spring();
  private readonly tailYawSpring = spring();
  private readonly tailPitchSpring = spring();
  /** Gravity blend, 0 = rail-pull, 1 = walk. Smoothed so a director floor drop
   *  is a transition rather than a snap. */
  private ground = 1;

  constructor(opts: AlienViewOptions = {}) {
    const materials = opts.materials ?? null;
    // ONE material for the whole creature. Pale, matte, no emissive, ever: the
    // asset bible's row for ISS-CHR-01 reads "Accent: none — pale only", and
    // `assertInert` below turns that from a comment into a check.
    //
    // r3 rode `StationMaterials.organic` here, on the rule that one material
    // has one owner and minting a second copy of the same program is waste.
    // That rule has not changed; what changed is that the creature no longer
    // wants the same program. `FleshMaterial` builds from the same palette row
    // — same colour, same roughness, same zero emissive, so every contrast
    // promise `assertPaletteCoherent()` made still holds — and then changes how
    // the surface answers light. See `./flesh.ts` for why that is worth a
    // program of its own, and why none of it glows.
    let material: THREE.Material;
    if (opts.flesh !== false) {
      this.flesh = new FleshMaterial();
      material = this.flesh.material;
      this.ownedMaterial = null;
    } else if (materials) {
      this.flesh = null;
      material = materials.organic;
      this.ownedMaterial = null;
    } else {
      this.flesh = null;
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
    this.headPart = part(buildHeadWithMorphs(), 1, 'alien-head');
    this.tailPart = part(buildTail(), 1, 'alien-tail');
    // Left and right are two instances of ONE geometry. The limbs are built
    // symmetric about their own YZ plane precisely so this works without a
    // mirrored copy — mirroring flips triangle winding and fixing that costs
    // more than the geometry saves.
    this.upperArmPart = part(buildUpperArm(), 2, 'alien-upper-arm');
    this.forearmPart = part(buildForearm(), 2, 'alien-forearm');
    this.thighPart = part(buildThigh(), 2, 'alien-thigh');
    this.shinPart = part(buildShin(), 2, 'alien-shin');
    this.parts = [
      this.chestPart,
      this.abdomenPart,
      this.headPart,
      this.tailPart,
      this.upperArmPart,
      this.forearmPart,
      this.thighPart,
      this.shinPart,
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
    this.useSecondary = opts.secondary ?? true;
    this.gravityOf = opts.gravityOf ?? null;

    // Seed the droop spring at its resting value. Without this the very first
    // frame shows a tail sticking straight out that then sags over a second,
    // which is a spawn animation nobody asked for.
    this.tailPitchSpring.x = TAIL_DROOP;
    this.secondary.tailPitch = TAIL_DROOP;

    // Pose once so the first frame after the first snapshot is already correct.
    this.applyPose(0);

    // The promise, checked: nothing on this creature glows. One false positive
    // devalues every amber dot in the station, and a self-lit monster would be
    // the loudest false positive available.
    assertInert(this.object3D, 'the alien (ISS-CHR-01)');
  }

  // -- the art pass seam ----------------------------------------------------

  /**
   * Replace the procedural body with a sculpted, skinned one (BACKLOG B-08).
   *
   * The eight instanced parts stay constructed but stop being drawn — they are
   * not disposed, so {@link releaseSkin} can put them back without a rebuild,
   * which is what the model viewer's A/B needs and what a quality tier that
   * drops the skin on a weak machine would need.
   *
   * `pass null` to go back to cylinders. Nothing else in the class branches on
   * which body is present: `update()` feeds both the same state, the same
   * gravity and the same measured speed, because the whole point of the
   * contract in `./skin.ts` is that a sculpt is a different BODY and not a
   * different creature.
   */
  adoptSkin(skin: AlienSkin | null): void {
    if (this.skin === skin) return;
    if (this.skin) {
      this.skin.object3D.removeFromParent();
      this.skin = null;
    }
    this.skin = skin;
    if (skin) {
      this.object3D.add(skin.object3D);
      skin.setState(this._state);
      skin.setGravity(this._gravity);
    }
    for (const p of this.parts) p.mesh.visible = skin === null && p.count > 0;
  }

  /** The sculpted body, if one was adopted. */
  get sculpted(): AlienSkin | null {
    return this.skin;
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

  /**
   * Draw calls the creature costs. SEVEN since the tail got its own joint, and
   * it does not vary beyond parts culling themselves at zero instances.
   */
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
      this.tailPart.triangles +
      this.upperArmPart.triangles * 2 +
      this.forearmPart.triangles * 2 +
      this.thighPart.triangles * 2 +
      this.shinPart.triangles * 2
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
    this.skin?.setState(state);
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
    this.skin?.setGravity(mode);
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

    // Yaw rate off the interpolated heading, which is what throws the tail wide
    // on a corner. Measured rather than derived from the server's snapshots
    // directly: `alpha` means the body is between two of them, and a tail that
    // reacted to snapshot arrival would flick once per network tick.
    const fwd = this.scratchFwd.set(0, 0, -1).applyQuaternion(this.object3D.quaternion);
    const yaw = Math.atan2(fwd.x, -fwd.z);
    if (this.hasYaw) {
      let d = yaw - this.prevYaw;
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      this.turnRate = approach(this.turnRate, d / frameDt, 12, frameDt);
    } else {
      this.hasYaw = true;
    }
    this.prevYaw = yaw;

    this.flesh?.update(frameDt);
    if (this.skin) {
      // A sculpt still needs the measured speed, and for exactly the reason the
      // procedural body does: it is what stops the feet sliding. See the stride
      // discussion in `./skin.ts`.
      this.skin.setSpeed(this._speed);
      this.skin.update(frameDt);
      return;
    }
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
    this.skin?.dispose();
    this.skin = null;
    this.object3D.removeFromParent();
    for (const p of this.parts) p.dispose();
    // Only ever the fallback: the station's own `organic` belongs to
    // `StationMaterials` and disposing it would blank the monster for good.
    this.ownedMaterial?.dispose();
    this.flesh?.dispose();
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
      this.advanceSecondary(dt);
    }

    pose(this.rig, this.posture, this.phase, this.secondary, this.ground);

    for (const p of this.parts) p.begin();
    this.chestPart.push(this.rig.chest);
    this.abdomenPart.push(this.rig.pelvis);
    this.headPart.push(this.rig.neck);
    this.morphInfluences[MORPH_GAPE] = this.secondary.gape;
    this.morphInfluences[MORPH_FLARE] = this.secondary.flare;
    this.headPart.setMorph(0, this.morphInfluences);
    this.tailPart.push(this.rig.tail);
    for (let i = 0; i < 2; i++) {
      this.upperArmPart.push(this.rig.shoulder[i] as THREE.Object3D);
      this.forearmPart.push(this.rig.elbow[i] as THREE.Object3D);
      this.thighPart.push(this.rig.hip[i] as THREE.Object3D);
      this.shinPart.push(this.rig.knee[i] as THREE.Object3D);
    }
    for (const p of this.parts) p.end();
  }

  /**
   * One frame of scan, hold, gait clock, spring and breath.
   *
   * ORDER IS LOAD-BEARING and this is the whole of why: the scan decides the
   * hold, the hold gates the gait clock, the gait clock moves the hips, and the
   * tail spring is chasing the hips. Solve them in any other order and the tail
   * is chasing where the hips were last frame — which looks almost right, and
   * is the kind of almost-right that costs an evening to find.
   */
  private advanceSecondary(dt: number): void {
    const p = this.posture;

    if (!this.useSecondary) {
      // r3, exactly: one sine sweep, one ungated gait clock, and nothing on the
      // body arrives late. Kept faithful rather than merely damped — including
      // the tail sitting at zero pitch, which is where the baked tail sat — so
      // the viewer's A/B is a real before and not a flattering one.
      this.scanCycles += Math.max(0, p.sweepHz) * dt;
      const travel = this._speed / ALIEN_STRIDE_M;
      const hz = Math.max(p.idleHz, travel * p.cadence);
      this.phase = (this.phase + hz * Math.PI * 2 * dt) % (Math.PI * 2);
      this.hold = 0;
      this.secondary.headYaw = p.headSweep * Math.sin(this.scanCycles * Math.PI * 2);
      this.secondary.headPitch = 0;
      this.secondary.tailYaw = 0;
      this.secondary.tailPitch = 0;
      this.secondary.breath = 0;
      // The IK still runs — it is the skeleton now, not an effect — so it still
      // needs somewhere to put the feet. What the A/B removes is the LAG, the
      // hold and the breath, not the creature's ability to stand up.
      this.secondary.travel = hz > 1e-4 ? this._speed / hz : 0;
      this.secondary.duty = DUTY_STAND + (DUTY_RUN - DUTY_STAND) * clamp01(this._speed / DUTY_FULL_SPEED);
      // The morphs hold at their posture value: r3 had no jaw at all, and a
      // head frozen shut would make the A/B a comparison of two different
      // models rather than of two ways of moving one.
      this.secondary.gape = clamp01(p.gape);
      this.secondary.flare = clamp01(p.flare);
      return;
    }

    // -- 1. the scan: a sine, a staircase, and the blend between them -------
    this.scanCycles += Math.max(0, p.sweepHz) * dt;
    const cycle = Math.floor(this.scanCycles);
    const u = this.scanCycles - cycle;
    const snap = clamp01(p.snap);

    const t = Math.min(1, u / SCAN_SNAP_FRAC);
    // Ease OUT cubic: all of the speed at the front. An ease-in-out here reads
    // as the head TURNING to look at something. This reads as it being yanked,
    // and those are different animals.
    const whip = 1 - (1 - t) ** 3;
    const from = scanBearing(cycle - 1);
    const to = scanBearing(cycle);
    const stepped = from + (to - from) * whip;
    const swept = Math.sin(this.scanCycles * Math.PI * 2);
    const scan = p.headSweep * (swept * (1 - snap) + stepped * snap);

    // -- 2. the hold: how still the rest of it goes while it listens --------
    this.hold = snap * clamp01((u - SCAN_SNAP_FRAC) / SCAN_SETTLE_FRAC);

    // -- 3. the gait clock, gated by the hold -------------------------------
    // Only the IDLE term is gated, never the travel term. A creature actually
    // covering ground must not stutter its legs: §5's entire read-the-gait
    // contract rests on cadence meaning metres per second and nothing else, and
    // a player who mistakes a stutter for a slowdown walks into a HUNT.
    const idleHz = p.idleHz * (1 - this.hold * HOLD_DEPTH);
    const travelHz = (this._speed / ALIEN_STRIDE_M) * p.cadence;
    const hz = Math.max(idleHz, travelHz);
    this.phase = (this.phase + hz * Math.PI * 2 * dt) % (Math.PI * 2);

    // -- 3b. metres per cycle, which is what stops the feet sliding ---------
    // `speed / hz` and nothing else. Both terms are measured off the same
    // interpolated transform, so this is the distance the body ACTUALLY covers
    // between two identical poses — which is, by definition, how far a planted
    // foot has to travel backward through body space over that cycle. Hold the
    // creature still and `hz` falls to the idle rate while `speed` is zero, so
    // travel is zero and the feet do not shuffle.
    this.secondary.travel = hz > 1e-4 ? this._speed / hz : 0;
    // Stance shortens with speed: a stalk keeps three feet down, a charge one.
    const gallop = clamp01(this._speed / DUTY_FULL_SPEED);
    this.secondary.duty = DUTY_STAND + (DUTY_RUN - DUTY_STAND) * gallop;

    // -- 4. springs ---------------------------------------------------------
    this.secondary.headYaw = springTo(this.headYawSpring, scan, HEAD_YAW_K, HEAD_YAW_C, dt);
    // The pitch spring holds where the head IS; the difference from where the
    // posture says it should be is the lag `pose()` adds back on.
    const pitch = springTo(this.headPitchSpring, p.headLift, HEAD_PITCH_K, HEAD_PITCH_C, dt);
    this.secondary.headPitch = p.headLift - pitch;

    // The tail chases the hips' CURRENT yaw and is always behind it; that
    // deficit is the trail. The body's own turn is added on top and clamped.
    const hips = spineYawAt(p, this.phase, this.ground);
    const lag = springTo(this.tailYawSpring, hips, TAIL_YAW_K, TAIL_YAW_C, dt);
    const turn = clamp(-this.turnRate * TAIL_TURN_GAIN, -TAIL_TURN_MAX, TAIL_TURN_MAX);
    this.secondary.tailYaw = (lag - hips) * TAIL_LAG_GAIN + turn;

    // Droop follows the gravity blend, so a director floor drop lets it rise.
    this.secondary.tailPitch = springTo(
      this.tailPitchSpring,
      TAIL_DROOP * this.ground,
      TAIL_PITCH_K,
      TAIL_PITCH_C,
      dt,
    );

    // -- 5. breath, at its own rate and skewed ------------------------------
    const breathHz = BREATH_BASE_HZ + p.idleHz * BREATH_AROUSAL;
    this.breathPhase = (this.breathPhase + breathHz * dt) % 1;
    const b = this.breathPhase;
    this.secondary.breath =
      b < BREATH_INHALE
        ? -Math.cos((b / BREATH_INHALE) * Math.PI)
        : Math.cos(((b - BREATH_INHALE) / (1 - BREATH_INHALE)) * Math.PI);

    // -- 6. the mouth -------------------------------------------------------
    // The gape BREATHES: a creature that runs with its mouth open is panting,
    // and a jaw held at a constant angle is a prop. Scaled by the posture's own
    // gape so a DORMANT mouth barely moves and an ATTACK's works hard.
    // Chattering rides at three times the gait rate — fast, shallow, and only
    // present when the mouth is already open.
    const chatter = Math.sin(this.phase * 3) * 0.05 * p.gape;
    this.secondary.gape = clamp01(p.gape + this.secondary.breath * 0.07 * p.gape + chatter);
    this.secondary.flare = clamp01(p.flare);
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
  tail: number;
  upperArm: number;
  forearm: number;
  thigh: number;
  shin: number;
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
  // The tail is spine, so it counts toward "long, thin" and toward the 2.40 m.
  const tail = measure(buildTail(), new THREE.Vector3(0, 0, PELVIS_Z + TAIL_JOINT_Z), true);
  // Limbs at their real joints, so the span is the span.
  const shoulderAt = new THREE.Vector3(SHOULDER.x, SHOULDER.y, CHEST_Z + SHOULDER.z);
  const upperArm = measure(buildUpperArm(), shoulderAt, false);
  const forearm = measure(
    buildForearm(),
    shoulderAt.clone().setY(SHOULDER.y - UPPER_ARM_L),
    false,
  );
  const hipAt = new THREE.Vector3(HIP.x, HIP.y, PELVIS_Z + HIP.z);
  const thigh = measure(buildThigh(), hipAt, false);
  const shin = measure(buildShin(), hipAt.clone().setY(HIP.y - THIGH_L), false);
  return {
    chest,
    abdomen,
    head,
    tail,
    upperArm,
    forearm,
    thigh,
    shin,
    total:
      chest + abdomen + head + tail + upperArm * 2 + forearm * 2 + thigh * 2 + shin * 2,
    length: body.max.z - body.min.z,
    bodyHalfWidth: Math.max(Math.abs(body.min.x), body.max.x),
    spanHalfWidth: Math.max(Math.abs(span.min.x), span.max.x),
    bodyHeight: body.max.y - body.min.y,
  };
}

export interface AlienContactReport {
  /** Rig-space position of the left forehand's contact pad. */
  hand: THREE.Vector3;
  /** Rig-space position of the left hind foot's toe pad. */
  foot: THREE.Vector3;
  /** Where the solver was ASKED to put them. Equal to the above to float error
   *  whenever the chain could reach; the gap between the two is the only
   *  honest measure of an IK rig and it is why both are reported. */
  handTarget: THREE.Vector3;
  footTarget: THREE.Vector3;
  /**
   * True when the target lies outside the chain's reachable annulus, so the
   * solver had to pull it in.
   *
   * Measured against the BONE LIMITS, not by comparing the solved contact to
   * the target. Those are different questions and conflating them was a bug:
   * in vacuum the hind limbs are deliberately slerped away from their solve to
   * the authored trail, so a position comparison reports "unreachable" for a
   * limb that reached perfectly well and was then overridden on purpose.
   */
  handClamped: boolean;
  footClamped: boolean;
  /**
   * How much of the chain's usable reach band the forelimb target sits inside:
   * 0 at the inner limit, 1 at full stretch.
   *
   * Reported because "did it reach" is a cliff and this is the approach to it.
   * The vacuum pose sat at 0.03 of the band before `railReach` was retuned —
   * technically reachable, one crouch away from not being.
   */
  handReachBand: number;
  /**
   * m — how far the forehand contact sits out along the BODY's own down axis,
   * measured from the shoulder.
   *
   * The number that would have caught the vacuum bug. "Is the hand below the
   * shoulder" is meaningless for a creature that spends half the station upside
   * down; "is the hand out on the side the limbs fold onto" is the same
   * question asked in a frame that rolls with the animal, and it is negative
   * exactly when an arm has folded back over its own shoulder.
   */
  ventralReach: number;
  /** True when this phase has that limb on the deck rather than in its swing. */
  handPlanted: boolean;
  footPlanted: boolean;
  crown: number;
  nose: number;
  tailTip: number;
  deck: number;
}

const _reportTip = new THREE.Vector3();

/**
 * Where the hands and feet actually end up. The tuning instrument for
 * {@link CONTACT}, and the thing that proves the IK is doing its job.
 *
 * Measured by FORWARD kinematics from the posed rig — a point at `−ARM_L2` down
 * the forearm's own axis, run through `matrixWorld` — and not by asking the
 * solver where it meant to put things. An IK routine that reports its own
 * target back has proved nothing at all.
 */
export function alienContactReport(
  state: AlienState = 'PATROL',
  gravity: GravityMode = 'nominal',
  phase = 0,
  sec: Secondary = SECONDARY_REST,
): AlienContactReport {
  const rig = buildRig();
  const p = copyPosture(POSTURES[state]);
  const ground = gravity === 'zero' ? 0 : 1;
  pose(rig, p, phase, sec, ground);

  const v = new THREE.Vector3();
  const hand = new THREE.Vector3(0, -ARM_L2, 0).applyMatrix4(
    (rig.elbow[0] as THREE.Object3D).matrixWorld,
  );
  const foot = new THREE.Vector3(0, -LEG_L2, 0).applyMatrix4(
    (rig.knee[0] as THREE.Object3D).matrixWorld,
  );

  // The SAME function `poseLimbs` uses, not a copy of it. That is not economy:
  // this check exists to catch the targets being wrong, and a check that
  // reimplements the thing it is checking agrees with itself and with nothing
  // else. The vacuum pose shipped broken for a whole revision underneath a
  // duplicate of this block that was every bit as wrong as the original.
  const handTarget = new THREE.Vector3();
  const footTarget = new THREE.Vector3();
  limbContact(handTarget, p, sec, ground, phase, -1, true);
  limbContact(footTarget, p, sec, ground, phase, -1, false);

  const shoulderRig = new THREE.Vector3().setFromMatrixPosition(
    (rig.shoulder[0] as THREE.Object3D).matrixWorld,
  );
  const hipRig = new THREE.Vector3().setFromMatrixPosition(
    (rig.hip[0] as THREE.Object3D).matrixWorld,
  );

  const crown = v.set(0, 0.135, 0).applyMatrix4(rig.chest.matrixWorld).y;
  const nose = v
    .set(0, -0.018, -NECK_LEN - SKULL_HALF * 2 + 0.045)
    .applyMatrix4(rig.neck.matrixWorld).z;
  const tailTip = v
    .set(0, TAIL_TIP_LOCAL.y, TAIL_TIP_LOCAL.z)
    .applyMatrix4(rig.tail.matrixWorld).y;

  return {
    hand,
    foot,
    handTarget,
    footTarget,
    handClamped: reachBand(shoulderRig, handTarget, ARM_L1, ARM_L2) === null,
    footClamped: reachBand(hipRig, footTarget, LEG_L1, LEG_L2) === null,
    handReachBand: reachBand(shoulderRig, handTarget, ARM_L1, ARM_L2) ?? -1,
    ventralReach: ventralReachOf(rig, hand),
    handPlanted: limbPlanted(sec, phase, ground, -1, true),
    footPlanted: limbPlanted(sec, phase, ground, -1, false),
    crown,
    nose,
    tailTip,
    deck: -ALIEN_DECK_DROP_M,
  };
}

/**
 * The secondary-motion and locomotion states the contact check has to survive.
 *
 * Not decoration. Breath tilts the chest, the chest carries the shoulders, and
 * the shoulders carry the hands the check prices against the deck — so a breath
 * amplitude chosen for how it looks can quietly put a palm through the plating.
 * `travel` matters even more: it is the whole stride, and a limb that solves at
 * a standstill can still be out of reach at the extremes of a HUNT.
 */
const SECONDARY_PROBES: readonly Secondary[] = Object.freeze([
  SECONDARY_REST,
  { ...SECONDARY_REST, breath: 1, tailPitch: TAIL_DROOP },
  { ...SECONDARY_REST, breath: -1, tailPitch: TAIL_DROOP },
  {
    headYaw: 0.7,
    headPitch: 0.3,
    tailYaw: TAIL_TURN_MAX,
    tailPitch: TAIL_DROOP,
    breath: 1,
    travel: 0,
    duty: DUTY_STAND,
    gape: 1,
    flare: 1,
  },
  // Walking, and running. §5's PATROL covers ALIEN_STRIDE_M per cycle by
  // construction; a HUNT covers it in a shorter, flatter, one-foot-down cycle.
  { ...SECONDARY_REST, travel: ALIEN_STRIDE_M, duty: DUTY_STAND, tailPitch: TAIL_DROOP },
  { ...SECONDARY_REST, travel: ALIEN_STRIDE_M, duty: DUTY_RUN, tailPitch: TAIL_DROOP, breath: 1 },
]);

/**
 * m — how far the spine may swing sideways from the body's own axis before it
 * is inside the hull.
 *
 * Read off the kit rather than typed in, so a level built from wider or
 * narrower tube moves it on its own — which is exactly what happened when
 * `TUBE_RADIUS_M` went 1.0 → 1.5. What did NOT survive that change was the
 * first version of this derivation, and the way it failed is worth keeping:
 *
 *   `sqrt(bore² − railOffset²)` was right when a `zero` module's rails were a
 *   floor-and-ceiling pair, because `railOffset` was then a HEIGHT and that
 *   expression is the bore's half width at that height. Rails now run at
 *   `(±tubeRailX, RAIL_Y_M, z)`, so `railOffset` is an X coordinate and the
 *   old expression measures nothing at all. It kept returning a plausible
 *   number — 0.938 m against a true 0.722 m — so the check went on passing,
 *   for the wrong reason, which is the worst state an assertion can be in.
 *
 * Derived properly: the body hangs {@link CONTACT.railReach} below the bar, so
 * its spine sits at `RAIL_Y_M − railReach`. The bore's half width THERE is
 * `sqrt(bore² − y²)`, and the creature is already `railOffset` off the
 * centreline toward one wall, so the room it actually has is the difference.
 * Two thirds of that is left for its own girth and for not visibly grazing the
 * hull, because a tail clearing the wall by a centimetre reads as clipping.
 */
const SPINE_LATERAL_LIMIT = (() => {
  const straight = KIT.straight;
  const spineY = RAIL_Y_M - CONTACT.railReach;
  const halfWidth = Math.sqrt(Math.max(0, straight.radius * straight.radius - spineY * spineY));
  return Math.max(0.1, halfWidth - straight.railOffset) * 0.67;
})();

/**
 * The widest the spine gets, and how many times it changes direction along its
 * own length, sampled over a whole gait cycle.
 *
 * The second number is the one this whole section exists for. A body whose
 * heading changes sign along its length is doing something no rigid object can
 * do, and that — not amplitude — is what the eye reads as ALIVE. The first
 * implementation of the swim had plenty of amplitude and exactly one
 * inflection: a banana, waved hard.
 */
export function alienSpineReport(
  state: AlienState = 'PATROL',
  gravity: GravityMode = 'zero',
  sec: Secondary = SECONDARY_REST,
): { lateral: number; vertical: number; inflections: number } {
  const rig = buildRig();
  const p = copyPosture(POSTURES[state]);
  const ground = gravity === 'zero' ? 0 : 1;
  const inv = new THREE.Matrix4();
  const v = new THREE.Vector3();
  // Stations along the spine, nose to tail tip, in each segment's own space.
  const stations: Array<[THREE.Object3D, THREE.Vector3]> = [
    [rig.neck, new THREE.Vector3(0, -0.018, -0.54)],
    [rig.neck, new THREE.Vector3(0, 0, -0.1)],
    [rig.chest, new THREE.Vector3(0, 0, -0.25)],
    [rig.chest, new THREE.Vector3(0, 0, 0.25)],
    [rig.pelvis, new THREE.Vector3(0, 0, 0.2)],
    [rig.pelvis, new THREE.Vector3(0, 0, 0.42)],
    [rig.tail, new THREE.Vector3(0, -0.05, 0.4)],
    [rig.tail, new THREE.Vector3(0, -0.075, TAIL_TIP_LOCAL.z)],
  ];
  let lateral = 0;
  let vertical = 0;
  let inflections = 0;
  const STEPS = 96;
  for (let k = 0; k < STEPS; k++) {
    pose(rig, p, (k / STEPS) * Math.PI * 2, sec, ground);
    // Measured in the CARRIAGE's frame, so the vacuum roll and the body's own
    // heading are factored out and this is pure bending.
    inv.copy(rig.carriage.matrixWorld).invert();
    let prev = 0;
    let signs = 0;
    for (let i = 0; i < stations.length; i++) {
      const [node, off] = stations[i] as [THREE.Object3D, THREE.Vector3];
      v.copy(off).applyMatrix4(node.matrixWorld).applyMatrix4(inv);
      lateral = Math.max(lateral, Math.abs(v.x));
      vertical = Math.max(vertical, Math.abs(v.y));
      if (i > 0 && Math.sign(v.x) !== Math.sign(prev)) signs++;
      prev = v.x;
    }
    inflections = Math.max(inflections, signs);
  }
  return { lateral, vertical, inflections };
}

/** m — how close a planted contact has to be to the deck. Five millimetres,
 *  where the hand-posed rig this replaced was allowed 130. That is not a
 *  tightened tolerance, it is a different KIND of number: the old one measured
 *  how well somebody had guessed, this one measures float error. */
const PLANT_TOLERANCE_M = 0.005;

/**
 * Prove the creature is the creature the bible and the server both describe.
 *
 * Four things can silently go wrong and none of them is visible in a still
 * image: it can drift off the bible's 2.40 m; it can grow wider than the 0.45 m
 * body the server prices contact against; its contacts can end up above or
 * below the deck the server has already decided it is standing on; and — the
 * one that only IK can get wrong, and the one worth the most — its feet can
 * SLIDE, covering a different distance from the body they are carrying.
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

  // BOTH regimes, and the half-way blend. r3 checked `nominal` only, which is
  // why nobody noticed that the vacuum pose had the creature reaching for a
  // handhold behind its own shoulders: there was no floor for the check to
  // measure against, so it did not look. Reachability and self-consistency are
  // measurable in vacuum even when deck height is not, and those are exactly
  // the two things that were broken.
  const REGIMES: readonly GravityMode[] = ['nominal', 'zero'];
  for (const state of Object.keys(POSTURES) as AlienState[]) {
    for (const gravity of REGIMES) {
      for (const phase of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      for (const sec of SECONDARY_PROBES) {
        const c = alienContactReport(state, gravity, phase, sec);
        const at =
          `${state} (${gravity}) @ phase ${phase.toFixed(2)}, travel ${sec.travel.toFixed(2)}`;
        const onDeck = gravity === 'nominal';

        // 1 — the solver reached. A clamped chain is a real pose, but a chain
        //     clamped inside the creature's OWN gait means the targets are
        //     outside the skeleton and no amount of animation will fix it.
        if (c.handClamped) {
          failures.push(
            `${at}: the forelimb could not reach its own plant — target ` +
              `${fmt(c.handTarget)}, solved ${fmt(c.hand)}. Shorten CONTACT.frontLead or ` +
              `the stance`,
          );
        }
        // The hind limbs are only solved on a deck; in vacuum they are slerped to
        // the authored trail, so their target is not a claim about anything.
        if (onDeck && c.footClamped) {
          failures.push(
            `${at}: the hind limb could not reach its own plant — target ` +
              `${fmt(c.footTarget)}, solved ${fmt(c.foot)}`,
          );
        }

        // 1b — and it reached with ROOM. A target sitting on the inner limit of
        //      the annulus is one posture tweak from being unreachable, and the
        //      failure mode is silent: the solver clamps, the hand floats, and
        //      nothing throws. The vacuum pose sat at 0.03 of the band.
        if (!c.handClamped && c.handReachBand < 0.06) {
          failures.push(
            `${at}: the forelimb target is at ${c.handReachBand.toFixed(3)} of its reach band ` +
              `— technically solvable, effectively on the inner limit. Move CONTACT.railReach ` +
              `or the lead out`,
          );
        }

        // 2 — a planted contact is ON the deck, not near it. Deck only: in
        //     vacuum the contact plane is the rail and its height is whatever
        //     the roll put it at, which check 1 has already proved reachable
        //     and check 2b proves is on the correct SIDE of the body.
        if (onDeck && c.handPlanted && Math.abs(c.hand.y - c.deck) > PLANT_TOLERANCE_M) {
          failures.push(
            `${at}: planted hand at y ${c.hand.y.toFixed(4)}, deck at ${c.deck}`,
          );
        }
        if (onDeck && c.footPlanted && Math.abs(c.foot.y - c.deck) > PLANT_TOLERANCE_M) {
          failures.push(
            `${at}: planted foot at y ${c.foot.y.toFixed(4)}, deck at ${c.deck}`,
          );
        }

        // 2b — THE ONE THE ARMS-ON-UPSIDE-DOWN BUG WOULD HAVE FAILED.
        //
        // A limb must reach out of the body's VENTRAL side — the side it folds
        // its limbs onto — never back over its own shoulders. Measured as the
        // contact sitting on the far side of the shoulder joint along the
        // body's own down axis, which is the definition that survives the
        // creature being upside down.
        if (c.handPlanted && c.ventralReach < 0.05) {
          failures.push(
            `${at}: the forehand contact is only ${c.ventralReach.toFixed(3)} m out along the ` +
              `body's ventral axis — the arm is folding back over the shoulder instead of ` +
              `reaching. Check VACUUM_ROLL against the contact plane in limbContact`,
          );
        }

        if (onDeck && c.crown > DECK_HEADROOM_M - ALIEN_DECK_DROP_M) {
          failures.push(
            `${state}: dorsal blades at ${c.crown.toFixed(3)} above the body centre clear ` +
              `DECK_HEADROOM_M (${DECK_HEADROOM_M}) — it would walk through the ceiling`,
          );
        }
        // The tail is the one part that gained a degree of freedom with nothing
        // above it to stop it: TAIL_DROOP is a free number and the plating is
        // not. 60 mm of clearance, because a tail tip skimming the deck at
        // 3 m/s reads as clipping even when it technically is not.
        if (onDeck && c.tailTip < c.deck + 0.06) {
          failures.push(
            `${at}: tail tip at ${c.tailTip.toFixed(3)} is inside the deck at ${c.deck} — ` +
              `reduce TAIL_DROOP`,
          );
        }
      }
      }
    }
  }

  // 2c — THE SPINE FITS THE TUBE, AND IT SLITHERS.
  //
  // Two failures with one measurement, because they pull against each other:
  // turn the swim up until the body really undulates and the tail goes through
  // the hull; turn it down until it fits and the animal goes rigid. Both are
  // checkable, so neither is a matter of opinion.
  for (const state of Object.keys(POSTURES) as AlienState[]) {
    const spine = alienSpineReport(state, 'zero', {
      ...SECONDARY_REST,
      travel: ALIEN_STRIDE_M,
      duty: DUTY_RAIL,
    });
    if (spine.lateral > SPINE_LATERAL_LIMIT) {
      failures.push(
        `${state} (zero): the spine swings ${spine.lateral.toFixed(3)} m off its own axis, ` +
          `past the ${SPINE_LATERAL_LIMIT.toFixed(3)} m a straight module's bore leaves beside ` +
          `the rail — the tail is going through the hull. Reduce SPINE.swimAmp`,
      );
    }
    // DORMANT is asleep and coiled; it is allowed to be a shape rather than a
    // wave. Everything that is actually going somewhere has to undulate.
    if (state !== 'DORMANT' && spine.inflections < 2) {
      failures.push(
        `${state} (zero): the spine holds only ${spine.inflections} inflection(s) at its ` +
          `waviest — the body is a single bend hinged in four places, which is what "rigid" ` +
          `looks like. Raise SPINE.swimWaves, not SPINE.swimAmp`,
      );
    }
  }

  // 3 — THE ONE THAT MATTERS. Over a whole stance, a planted contact must
  //     travel backward through body space by exactly the distance the body
  //     travels forward. Any residual is skating, and skating is the single
  //     most reliable way to make an animal look like a toy.
  for (const travel of [0, 0.6, ALIEN_STRIDE_M]) {
    for (const duty of [DUTY_RUN, DUTY_STAND]) {
      const sec: Secondary = { ...SECONDARY_REST, travel, duty, tailPitch: TAIL_DROOP };
      const stance = travel * duty;
      // Sample the hind limb across its own stance. Its phase offset is half a
      // cycle, so shift by that to start at touchdown.
      const start = alienContactReport('PATROL', 'nominal', (0.5 + 1e-6) * Math.PI * 2, sec);
      const end = alienContactReport('PATROL', 'nominal', (0.5 + duty - 1e-6) * Math.PI * 2, sec);
      const moved = end.foot.z - start.foot.z;
      if (Math.abs(moved - stance) > 1e-3) {
        failures.push(
          `foot slide: at travel ${travel.toFixed(2)} m/cycle and duty ${duty.toFixed(2)} the ` +
            `planted foot moved ${moved.toFixed(4)} m through body space but the body moved ` +
            `${stance.toFixed(4)} m — the difference (${(moved - stance).toFixed(4)} m) is skate`,
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

/**
 * Where a target sits inside a two-bone chain's reachable annulus: 0 at the
 * inner limit, 1 at full stretch, `null` when it is outside either end.
 *
 * The inner limit is the one that bites here and it is easy to forget it
 * exists: with a 0.41 m upper arm against a 0.69 m forearm-and-hand there is a
 * 0.28 m hole around the shoulder that no elbow angle can put a hand into.
 */
function reachBand(
  joint: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
): number | null {
  const d = joint.distanceTo(target);
  const min = Math.abs(l1 - l2) * 1.02;
  const max = (l1 + l2) * 0.995;
  if (d < min || d > max) return null;
  return (d - min) / (max - min);
}

/**
 * How far `contact` lies out along the carriage's own down axis, from the left
 * shoulder. See {@link AlienContactReport.ventralReach}.
 */
function ventralReachOf(rig: AlienRig, contact: THREE.Vector3): number {
  const down = new THREE.Vector3(0, -1, 0).applyQuaternion(rig.carriage.quaternion);
  const shoulder = new THREE.Vector3().setFromMatrixPosition(
    (rig.shoulder[0] as THREE.Object3D).matrixWorld,
  );
  return contact.clone().sub(shoulder).dot(down);
}

function fmt(v: THREE.Vector3): string {
  return `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
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
  assertFleshCoherent();
  const probe = buildChest();
  assertPolyBudget(probe, { label: 'alien thorax', min: 90, max: 200 }, 'alien thorax');
  probe.dispose();
  return true;
})();
