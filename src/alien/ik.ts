/**
 * src/alien/ik.ts — analytic two-bone IK. Pure maths, no three scene graph.
 *
 * DESIGN.md §5 sized "rail-following with IK" at 15+ evenings and called it
 * "the hidden giant" (BACKLOG B-07). Most of that estimate is the rail
 * FOLLOWING — path planning along the §2 rail graph, which is server work and
 * is not this. The IK itself is a triangle. This file is the triangle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IK AT ALL, WHEN THE BAKED ANGLES ALREADY LOOKED FINE
 *
 * They did not look fine, they looked *solved*, which is a different thing.
 * `alienContactReport()` was written because the hand-tuned `WALK` angles put
 * feet within ±0.10 m of the deck and no closer, and the whole gait was a set
 * of joint angles chosen so that the average pose grazed the floor. A limb
 * posed that way SKATES: the contact point slides backward and forward under
 * the body while the creature walks, at a rate that has nothing to do with how
 * fast it is actually going, and the eye reads skating instantly even when it
 * cannot say what is wrong.
 *
 * With IK the causality runs the right way round. You say where the foot IS —
 * on the deck, at a world-fixed point, for the whole of its stance — and the
 * joints are whatever they have to be. `AlienView` derives the stance travel
 * from the same speed that drives the cadence, so **contacts cannot slide at
 * any speed**. That is not tuning, it is arithmetic, and `assertAlienCoherent`
 * checks it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUATERNIONS, NOT EULER ANGLES
 *
 * The obvious implementation solves a pitch for the root and a pitch for the
 * joint and writes them into `.rotation.x`. It does not work, and the reason is
 * worth writing down because it will look like it should:
 *
 * A limb here is splayed outward (a Z rotation) as well as swung fore-and-aft
 * (an X rotation). Under three's default `XYZ` Euler order those compose so
 * that the CHILD joint's X axis is no longer perpendicular to the plane the
 * limb is reaching in — so the elbow bends slightly out of plane and the hand
 * misses its target by a few centimetres, more the wider the splay. Solving
 * directly for quaternions has no orientation-order to get wrong: bone one
 * points at a computed direction, bone two points at the target, done.
 */

import * as THREE from 'three';

/** The direction a bone hangs when its joint is at identity. Every limb part in
 *  `alienView.ts` is built along −Y from its joint, which is what makes one
 *  geometry serve both sides. */
export const BONE_REST = Object.freeze(new THREE.Vector3(0, -1, 0));

export interface TwoBoneOut {
  /** Local rotation for the root joint (shoulder / hip). */
  readonly root: THREE.Quaternion;
  /** Local rotation for the middle joint (elbow / knee), relative to `root`. */
  readonly joint: THREE.Quaternion;
  /** True when the target was outside the chain's reach and was pulled in.
   *  Not an error — a limb at full stretch is a real pose — but a chain that is
   *  clamped every frame is a chain whose targets are wrong. */
  clamped: boolean;
  /** Distance actually solved for, after clamping. */
  reach: number;
}

export function twoBoneOut(): TwoBoneOut {
  return {
    root: new THREE.Quaternion(),
    joint: new THREE.Quaternion(),
    clamped: false,
    reach: 0,
  };
}

// Scratch. Module-level and reused: this runs four times a frame on every
// client and JavaScript is single-threaded, so the alternative is sixteen
// Vector3 allocations per frame for no benefit whatsoever.
const _toTarget = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _bone1 = new THREE.Vector3();
const _bone2 = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _clampedTarget = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _want = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qWorld2 = new THREE.Quaternion();
const _fallback = new THREE.Vector3(0, 0, 1);
const _fallback2 = new THREE.Vector3(1, 0, 0);
const _localZ = new THREE.Vector3(0, 0, 1);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Roll `q` about `axis` so that the frame's local +Z faces `want` as closely as
 * the axis allows.
 *
 * `Quaternion.setFromUnitVectors` gives the SHORTEST rotation between two
 * directions, which is the right answer for where a bone points and no answer
 * at all for how it is rolled about itself. That does not matter for a tapered
 * tube; it matters a great deal for the part with a foot on the end, because an
 * unconstrained roll walks the creature on the sides of its toes.
 */
function alignRoll(q: THREE.Quaternion, axis: THREE.Vector3, want: THREE.Vector3): void {
  _cur.copy(_localZ).applyQuaternion(q);
  _cur.addScaledVector(axis, -_cur.dot(axis));
  _want.copy(want);
  _want.addScaledVector(axis, -_want.dot(axis));
  if (_cur.lengthSq() < 1e-8 || _want.lengthSq() < 1e-8) return;
  _cur.normalize();
  _want.normalize();
  _cross.crossVectors(_cur, _want);
  const angle = Math.atan2(_cross.dot(axis), _cur.dot(_want));
  q.premultiply(_q.setFromAxisAngle(axis, angle));
}

/**
 * Solve a two-bone chain, in the root joint's PARENT space.
 *
 * @param jointPos  where the root joint sits (its `.position`).
 * @param target    where the end of bone two must end up.
 * @param pole      which way the middle joint should bulge. An elbow that bends
 *                  backward takes +Z; a hock that bends forward takes −Z. Only
 *                  its direction is used, and only its component perpendicular
 *                  to the reach matters — so "roughly backward" is a complete
 *                  specification and no pole target object is needed.
 * @param l1        root joint to middle joint.
 * @param l2        middle joint to the CONTACT POINT, which is the fingertip or
 *                  the toe pad and not the wrist: the thing that touches the
 *                  deck is the thing the solve has to place.
 * @param alignZ    direction the chain's local +Z should face, for roll. Pass
 *                  the creature's forward.
 */
export function solveTwoBone(
  jointPos: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  l1: number,
  l2: number,
  alignZ: THREE.Vector3,
  out: TwoBoneOut,
): TwoBoneOut {
  _toTarget.subVectors(target, jointPos);
  let d = _toTarget.length();

  // Reach limits. The inner one is not fussiness: inside |l1 − l2| the triangle
  // has no solution at all, and this chain's bones are very unequal (a 0.41 m
  // upper arm against a 0.86 m forearm-and-hand), so the inner limit is a real
  // 0.45 m hole that a crouching pose can absolutely reach into.
  const min = Math.abs(l1 - l2) * 1.02;
  const max = (l1 + l2) * 0.995;
  out.clamped = d < min || d > max;
  d = clamp(d, min, max);
  if (_toTarget.lengthSq() < 1e-10) _toTarget.copy(BONE_REST).multiplyScalar(d);
  _dir.copy(_toTarget).normalize();
  _clampedTarget.copy(jointPos).addScaledVector(_dir, d);
  out.reach = d;

  // Angle between bone one and the line to the target — the law of cosines, and
  // the entire reason this is analytic rather than iterative.
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a = Math.acos(cosA);

  // Bend axis. Rotating `_dir` about (dir × pole) by +a carries it toward the
  // pole, which is where the middle joint belongs.
  _axis.crossVectors(_dir, pole);
  if (_axis.lengthSq() < 1e-8) _axis.crossVectors(_dir, _fallback);
  if (_axis.lengthSq() < 1e-8) _axis.crossVectors(_dir, _fallback2);
  _axis.normalize();

  _bone1.copy(_dir).applyQuaternion(_q.setFromAxisAngle(_axis, a));
  _mid.copy(jointPos).addScaledVector(_bone1, l1);
  _bone2.subVectors(_clampedTarget, _mid);
  if (_bone2.lengthSq() < 1e-10) _bone2.copy(_bone1);
  _bone2.normalize();

  out.root.setFromUnitVectors(BONE_REST, _bone1);
  alignRoll(out.root, _bone1, alignZ);

  _qWorld2.setFromUnitVectors(BONE_REST, _bone2);
  alignRoll(_qWorld2, _bone2, alignZ);

  // The middle joint is stored LOCAL to the root, because that is how a scene
  // graph parents it.
  out.joint.copy(out.root).invert().multiply(_qWorld2);
  return out;
}

/**
 * Where the chain's contact point actually ended up, given the solved
 * rotations. The inverse of the solve, used by the coherence check — an IK
 * routine that grades its own homework by returning the target it was handed
 * proves nothing.
 */
export function twoBoneTip(
  jointPos: THREE.Vector3,
  out: TwoBoneOut,
  l1: number,
  l2: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  _bone1.copy(BONE_REST).applyQuaternion(out.root);
  _qWorld2.copy(out.root).multiply(out.joint);
  _bone2.copy(BONE_REST).applyQuaternion(_qWorld2);
  return target.copy(jointPos).addScaledVector(_bone1, l1).addScaledVector(_bone2, l2);
}
