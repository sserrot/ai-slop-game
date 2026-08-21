/**
 * Interactable props as a collision surface (DESIGN.md §4 swept body, §6 "you
 * must physically be at the panel").
 *
 * WHAT THIS FIXES, MEASURED. The station's static BVH is built from the module
 * shells, the deck and a whitelist of solid prop kinds (`SOLID_PROP_KINDS` in
 * `src/station/geometry.ts`). Panels are not on that list at all, and a
 * locker's collision proxy is its ARCHETYPE box rather than the carcass that
 * actually got built. So the swept body was never stopped at the thing the
 * player was walking up to. On the shipped level, with `PLAYER_RADIUS` 0.30:
 *
 *   airlock-eva-panel-keyswitch-b   body reaches 0.04 m from the face → 0.26 m
 *   airlock-eva-panel-keyswitch-a   0.08 m → 0.22 m of body inside the panel
 *   lab-atlas-panel-fuse-1          0.10 m → 0.20 m
 *   cupola-nadir-panel-fuse-3       0.105 m → 0.195 m
 *   every locker                    0.22–0.26 m → 0.04–0.08 m
 *
 * The body point IS the eye (§4), so 0.26 m of overlap is the camera and both
 * gloves inside the panel. That is the whole of the playtest report — "i clicked
 * E to interact and the character model glitched into whatever asset i was
 * interacting with". Pressing E did not move anybody: E is simply the moment you
 * are pressed hardest against the thing, and the interaction ray reaches 2.5 m,
 * so you can be well inside a panel and still be interacting with it.
 *
 * WHY ANALYTIC AND NOT MORE BVH. Exactly the argument `./hatchBarrier` makes for
 * doors, and the same argument `src/station/collision.ts` makes in its own
 * header: an interactable is a handful of boxes whose extents we already know,
 * a locker DOOR swings (and must stay non-solid, or opening one shoves the
 * player), and adding twenty-odd `MeshBVH` entries to `StationCollider` would
 * put all of them through the innermost loop of the frame. Twenty-two oriented
 * boxes behind a bounding-sphere reject cost nothing and cannot go stale.
 *
 * WHAT IT IS DELIBERATELY NOT. Not a hit list — it never decides what E does.
 * It is measured ONCE from the objects the interaction raycaster was already
 * handed, in whatever pose they were built in (locker doors shut), and after
 * that it is pure geometry, exactly like the hide shells and the hatch discs.
 */

import * as THREE from 'three';
import {
  CONTACT_EPSILON,
  DEPENETRATION_ITERATIONS,
  PROP_MIN_HALF_M,
  PROP_SAMPLE_FACTOR,
} from './tuning';

/** One prop the body was pushed out of. Owned by the barrier — read it, never
 *  keep it. */
export interface PropContact {
  hit: boolean;
  /** World unit normal, pointing away from the prop — the same convention
   *  `StationCollider`'s contact normal uses, so the response is identical. */
  normal: THREE.Vector3;
  /** Metres of penetration resolved. */
  depth: number;
  /** The interactable that did it, for a debug draw. Null when `hit` is false. */
  object: THREE.Object3D | null;
}

export function makePropContact(): PropContact {
  return { hit: false, normal: new THREE.Vector3(), depth: 0, object: null };
}

/** One measured prop: an oriented box, plus the cheap rejection test. */
interface PropBox {
  object: THREE.Object3D;
  /** Box centre, world space. */
  centre: THREE.Vector3;
  /** Half-extents along the box's own axes, world scale applied. */
  half: THREE.Vector3;
  /** Rotation from box space to world. */
  quat: THREE.Quaternion;
  /** Inverse of the above, so a probe goes into box space with one multiply. */
  inverse: THREE.Quaternion;
  /** World-space bounding radius, for the broad-phase. */
  bound: number;
}

const _localBox = new THREE.Box3();
const _childBox = new THREE.Box3();
const _toLocal = new THREE.Matrix4();
const _childLocal = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _probe = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _out = new THREE.Vector3();
const _push = new THREE.Vector3();
const _segment = new THREE.Vector3();

/** The default body: one sphere on the body point (the §4 zero-G collider). */
const SINGLE_SPHERE: readonly THREE.Vector3[] = Object.freeze([new THREE.Vector3(0, 0, 0)]);

export class PropBarrier {
  private boxes: PropBox[] = [];

  constructor(objects?: readonly THREE.Object3D[] | null) {
    if (objects) this.set(objects);
  }

  /** Number of props under test. Zero makes every query a no-op. */
  get size(): number {
    return this.boxes.length;
  }

  /** Re-measure from a new list. Cheap enough to call on every level load. */
  set(objects: readonly THREE.Object3D[] | null | undefined): void {
    this.boxes = [];
    if (!objects) return;
    for (const object of objects) {
      const box = measure(object);
      if (box) this.boxes.push(box);
    }
  }

  clear(): void {
    this.boxes = [];
  }

  /**
   * Re-read the world transforms of every measured prop.
   *
   * Props do not move — but the station group they hang off can be assembled
   * after the barrier was built, and a box measured against an identity matrix
   * that later becomes a placement is a box in the wrong room.
   */
  refresh(): void {
    for (const box of this.boxes) {
      const fresh = measure(box.object);
      if (!fresh) continue;
      box.centre.copy(fresh.centre);
      box.half.copy(fresh.half);
      box.quat.copy(fresh.quat);
      box.inverse.copy(fresh.inverse);
      box.bound = fresh.bound;
    }
  }

  /**
   * Push a body of `radius` out of every prop it is inside. `center` is
   * mutated; the deepest contact is returned.
   *
   * `offsets` are sphere centres relative to `center`, exactly as
   * `StationCollider` takes them. TWO offsets are treated as the CAPSULE they
   * describe rather than as two loose spheres: the segment between them is
   * sampled at no more than a radius apart, so a waist-height console cannot
   * slip through the gap between a walking body's two spheres. The BVH path
   * gets away without that because station geometry is dense and floor-to-
   * ceiling; a prop is a single box roughly the height of the gap.
   */
  resolve(
    center: THREE.Vector3,
    radius: number,
    offsets?: readonly THREE.Vector3[] | null,
    out: PropContact = makePropContact(),
  ): PropContact {
    out.hit = false;
    out.depth = 0;
    out.object = null;
    out.normal.set(0, 0, 0);
    if (this.boxes.length === 0) return out;

    const spheres = offsets && offsets.length > 0 ? offsets : SINGLE_SPHERE;
    const samples = sampleCount(spheres, radius);
    const reach = box3Reach(radius, spheres);

    // Iterated, exactly like `StationCollider.depenetrate`: pushing one sample
    // out moves the whole body, which can push a different sample into a
    // different prop. One pass leaves a body pressed into a corner between two
    // of them a few millimetres inside; the loop settles it, and exits on the
    // first clean pass so the ordinary case still costs one.
    for (let iteration = 0; iteration < DEPENETRATION_ITERATIONS; iteration++) {
      let moved = 0;
      for (const box of this.boxes) {
        // Broad-phase: the farthest a sample can reach, against the prop's own
        // bounding sphere. Conservative — it can never drop a real contact.
        if (_probe.copy(center).sub(box.centre).lengthSq() > (box.bound + reach) ** 2) continue;

        for (let s = 0; s < samples; s++) {
          samplePoint(_probe, center, spheres, s, samples);
          const depth = pushOut(box, _probe, radius, _push);
          if (depth <= 0) continue;
          center.add(_push);
          moved += depth;
          if (depth > out.depth) {
            out.hit = true;
            out.depth = depth;
            out.object = box.object;
            out.normal.copy(_push).normalize();
          }
        }
      }
      if (moved <= CONTACT_EPSILON) break;
    }
    return out;
  }

  /**
   * Would a body of this shape be inside a prop at `center`? Non-mutating.
   *
   * Asked for the same reason `StationCollider.overlaps` is: standing up and
   * stepping onto a ledge both have to be refusable, and a controller that only
   * refuses against the BVH would let a crouched player stand up inside a
   * locker.
   */
  overlaps(
    center: THREE.Vector3,
    radius: number,
    offsets?: readonly THREE.Vector3[] | null,
    tolerance = 0,
  ): boolean {
    if (this.boxes.length === 0) return false;
    const spheres = offsets && offsets.length > 0 ? offsets : SINGLE_SPHERE;
    const samples = sampleCount(spheres, radius);
    const reach = box3Reach(radius, spheres);
    for (const box of this.boxes) {
      if (_probe.copy(center).sub(box.centre).lengthSq() > (box.bound + reach) ** 2) continue;
      for (let s = 0; s < samples; s++) {
        samplePoint(_probe, center, spheres, s, samples);
        if (pushOut(box, _probe, radius, _push) > tolerance) return true;
      }
    }
    return false;
  }

}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Broad-phase radius around the body POINT. */
function box3Reach(radius: number, spheres: readonly THREE.Vector3[]): number {
  return radius + bodyReachOf(spheres);
}

/** Sphere centres a body of two offsets needs to cover its own segment. */
function sampleCount(spheres: readonly THREE.Vector3[], radius: number): number {
  if (spheres.length < 2) return spheres.length;
  const step = Math.max(radius * PROP_SAMPLE_FACTOR, 1e-3);
  return Math.max(2, Math.ceil(bodySpan(spheres) / step) + 1);
}

/**
 * Farthest any sample can be from the body POINT.
 *
 * Not half the capsule's length — the body point is the EYE (§4: "position IS
 * the eye in both regimes"), which sits at the top of a walking capsule, so the
 * foot sphere is `EYE_HEIGHT − PLAYER_RADIUS` away and the head sphere only a
 * few centimetres. Sizing the broad-phase off the half-length silently rejected
 * every prop the feet were in and the eye was not — a wall panel at chest height
 * on the far side of a 0.33 m box, which is exactly the residue that survived
 * the first cut of this file.
 */
function bodyReachOf(spheres: readonly THREE.Vector3[]): number {
  let far = 0;
  for (let i = 0; i < spheres.length; i++) {
    const d = (spheres[i] as THREE.Vector3).length();
    if (d > far) far = d;
  }
  return far;
}

/** Length of the segment the samples have to cover. */
function bodySpan(spheres: readonly THREE.Vector3[]): number {
  if (spheres.length < 2) return 0;
  const a = spheres[0] as THREE.Vector3;
  const b = spheres[spheres.length - 1] as THREE.Vector3;
  return _segment.copy(b).sub(a).length();
}

/** The `i`th of `n` points evenly spaced along the body's own segment. */
function samplePoint(
  out: THREE.Vector3,
  center: THREE.Vector3,
  spheres: readonly THREE.Vector3[],
  i: number,
  n: number,
): THREE.Vector3 {
  const a = spheres[0] as THREE.Vector3;
  if (n <= 1) return out.copy(center).add(a);
  const b = spheres[spheres.length - 1] as THREE.Vector3;
  const t = i / (n - 1);
  out.copy(a).lerp(b, t).add(center);
  return out;
}

/**
 * Shortest push that takes a sphere at `point` out of `box`. Returns the depth,
 * with the world-space correction written into `push`.
 */
function pushOut(
  box: PropBox,
  point: THREE.Vector3,
  radius: number,
  push: THREE.Vector3,
): number {
  _probe.copy(point).sub(box.centre).applyQuaternion(box.inverse);
  _closest.set(
    clamp(_probe.x, -box.half.x, box.half.x),
    clamp(_probe.y, -box.half.y, box.half.y),
    clamp(_probe.z, -box.half.z, box.half.z),
  );
  _out.copy(_probe).sub(_closest);
  const distSq = _out.lengthSq();
  if (distSq > radius * radius) return 0;

  let depth: number;
  if (distSq > 1e-12) {
    const dist = Math.sqrt(distSq);
    _out.divideScalar(dist);
    depth = radius - dist;
  } else {
    // Dead inside the box: leave by the nearest face, which is the only exit
    // that cannot drag a body through the prop it is standing in.
    const ox = box.half.x - Math.abs(_probe.x);
    const oy = box.half.y - Math.abs(_probe.y);
    const oz = box.half.z - Math.abs(_probe.z);
    if (ox <= oy && ox <= oz) {
      _out.set(_probe.x < 0 ? -1 : 1, 0, 0);
      depth = ox + radius;
    } else if (oy <= oz) {
      _out.set(0, _probe.y < 0 ? -1 : 1, 0);
      depth = oy + radius;
    } else {
      _out.set(0, 0, _probe.z < 0 ? -1 : 1);
      depth = oz + radius;
    }
  }
  depth += CONTACT_EPSILON;
  push.copy(_out).applyQuaternion(box.quat).multiplyScalar(depth);
  return depth;
}

/**
 * Measure one interactable as an oriented box, in whatever pose it is in now.
 *
 * The local bounds are taken in the object's OWN frame rather than as a world
 * AABB, because a panel is a thin plate on a curved hull and its world AABB
 * would be a fat cube standing off the wall — which would stop the player a
 * body's width further out than the panel actually is and read as an invisible
 * kerb in the middle of the deck.
 */
function measure(object: THREE.Object3D): PropBox | null {
  object.updateWorldMatrix(true, true);
  _toLocal.copy(object.matrixWorld).invert();
  _localBox.makeEmpty();

  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    // A door that has swung open still measures from the carcass it belongs to;
    // that is deliberate, and the same call the station makes about hatch
    // leaves. What is measured is the box you cannot walk into, not the panel
    // of steel currently sticking out of it.
    if (mesh.userData.noCollide === true) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bounds = mesh.geometry.boundingBox;
    if (!bounds) return;
    _childBox.copy(bounds);
    _childLocal.multiplyMatrices(_toLocal, mesh.matrixWorld);
    _childBox.applyMatrix4(_childLocal);
    _localBox.union(_childBox);
  });

  if (_localBox.isEmpty()) return null;

  object.matrixWorld.decompose(_pos, _quat, _scale);
  _localBox.getCenter(_probe);
  _localBox.getSize(_out);

  const half = new THREE.Vector3(
    Math.max((_out.x * Math.abs(_scale.x)) / 2, PROP_MIN_HALF_M),
    Math.max((_out.y * Math.abs(_scale.y)) / 2, PROP_MIN_HALF_M),
    Math.max((_out.z * Math.abs(_scale.z)) / 2, PROP_MIN_HALF_M),
  );
  const centre = _probe.clone().applyMatrix4(object.matrixWorld);
  const quat = _quat.clone();
  return {
    object,
    centre,
    half,
    quat,
    inverse: quat.clone().invert(),
    bound: half.length(),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
