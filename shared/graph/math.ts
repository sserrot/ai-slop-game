/**
 * Tiny plain-object vector/quaternion maths.
 *
 * shared/ must stay renderer-free: the Node server imports this too and pulling
 * three.js into the server for a dot product is not worth it. Every function
 * here takes and returns plain `{x,y,z}` / `{x,y,z,w}` objects, which are
 * structurally compatible with `THREE.Vector3` / `THREE.Quaternion` — you can
 * pass a THREE.Vector3 straight in, and `v3(...)` the result back out with
 * `new THREE.Vector3().copy(result)`.
 */

import type { Quat, Vec3 } from '@shared/types';

export const V3_ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });
export const QUAT_IDENTITY: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function cloneV3(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSq(a));
}

export function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(distanceSq(a, b));
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-12) return v3(0, 0, 0);
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

export function lerpV3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** Rotate `v` by unit quaternion `q`. */
export function applyQuat(v: Vec3, q: Quat): Vec3 {
  // t = 2 * cross(q.xyz, v); v' = v + q.w * t + cross(q.xyz, t)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Conjugate of a unit quaternion — its inverse rotation. */
export function conjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/**
 * Hamilton product `a * b` — the rotation "apply b, then a".
 *
 * Composing a module's transform with a prop's own `localQuat` needs this, and
 * without it every caller reaches for `THREE.Quaternion`, which shared/ may not
 * do (the Node server imports this file). Same convention and same operand
 * order as `THREE.Quaternion.multiplyQuaternions(a, b)`.
 */
export function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Copy of a quaternion. */
export function cloneQuat(q: Quat): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/** Transform a module-space point into world space. */
export function localToWorld(local: Vec3, transform: { pos: Vec3; quat: Quat }): Vec3 {
  return add(applyQuat(local, transform.quat), transform.pos);
}

/**
 * `localToWorld` writing into `out` instead of allocating the two intermediates
 * `add(applyQuat(...))` needs. Same expression tree in the same order, so
 * results are bit-identical and a caller may switch freely. `out` is
 * caller-owned — nothing here is shared state, so two rooms in one Node process
 * cannot collide.
 */
export function localToWorldInto(
  local: Vec3,
  transform: { pos: Vec3; quat: Quat },
  out: Vec3,
): Vec3 {
  const q = transform.quat;
  const tx = 2 * (q.y * local.z - q.z * local.y);
  const ty = 2 * (q.z * local.x - q.x * local.z);
  const tz = 2 * (q.x * local.y - q.y * local.x);
  out.x = local.x + q.w * tx + (q.y * tz - q.z * ty) + transform.pos.x;
  out.y = local.y + q.w * ty + (q.z * tx - q.x * tz) + transform.pos.y;
  out.z = local.z + q.w * tz + (q.x * ty - q.y * tx) + transform.pos.z;
  return out;
}

/** Transform a module-space direction into world space (rotation only). */
export function localDirToWorld(local: Vec3, transform: { pos: Vec3; quat: Quat }): Vec3 {
  return applyQuat(local, transform.quat);
}

/** Transform a world-space point into module space. */
export function worldToLocal(world: Vec3, transform: { pos: Vec3; quat: Quat }): Vec3 {
  return worldToLocalInto(world, transform, v3());
}

/**
 * `worldToLocal` writing into `out` instead of allocating three intermediates.
 *
 * Arithmetically identical to `applyQuat(sub(world, pos), conjugate(quat))` —
 * same operands in the same order — so a caller that switches to it gets
 * bit-identical results. `Station.moduleAt` runs this once per module per frame,
 * which is where the allocations were coming from.
 */
export function worldToLocalInto(
  world: Vec3,
  transform: { pos: Vec3; quat: Quat },
  out: Vec3,
): Vec3 {
  const dx = world.x - transform.pos.x;
  const dy = world.y - transform.pos.y;
  const dz = world.z - transform.pos.z;
  // conjugate(q) — the inverse rotation of a unit quaternion.
  const qx = -transform.quat.x;
  const qy = -transform.quat.y;
  const qz = -transform.quat.z;
  const qw = transform.quat.w;
  const tx = 2 * (qy * dz - qz * dy);
  const ty = 2 * (qz * dx - qx * dz);
  const tz = 2 * (qx * dy - qy * dx);
  out.x = dx + qw * tx + (qy * tz - qz * ty);
  out.y = dy + qw * ty + (qz * tx - qx * tz);
  out.z = dz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** What `projectOnSegment` returns, and the reusable buffer `…Into` fills. */
export interface SegmentProjection {
  /** Parameter along the segment, 0 at `a`, 1 at `b`. */
  t: number;
  /** World position of the closest point. Mutated in place by `…Into`. */
  point: Vec3;
  /** Metres from the query point to `point`. */
  distance: number;
}

/** A zeroed `SegmentProjection` to hand to `projectOnSegmentInto`. */
export function segmentProjection(): SegmentProjection {
  return { t: 0, point: v3(), distance: 0 };
}

/**
 * Closest point to `p` on the segment a→b, as a parameter `t` in [0, 1] plus the
 * point itself.
 *
 * Allocates a result. The hot paths (`RailGraph.nearestAmong`, which runs over
 * every rail candidate on every frame for both the player's grab check and the
 * alien's rail following) call `projectOnSegmentInto` instead.
 */
export function projectOnSegment(p: Vec3, a: Vec3, b: Vec3): SegmentProjection {
  return projectOnSegmentInto(p, a, b, segmentProjection());
}

/**
 * `projectOnSegment` with no allocation: the answer is written into `out`
 * (including `out.point`, which is mutated in place) and `out` is returned.
 *
 * The arithmetic is the same expression tree as `projectOnSegment` above — which
 * is now literally this function plus a fresh buffer — so results are
 * bit-identical and a caller may switch freely. `out` is caller-owned, so
 * nothing here is shared state and two rooms on one Node process cannot collide.
 */
export function projectOnSegmentInto(
  p: Vec3,
  a: Vec3,
  b: Vec3,
  out: SegmentProjection,
): SegmentProjection {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq < 1e-12) {
    out.t = 0;
    out.point.x = a.x;
    out.point.y = a.y;
    out.point.z = a.z;
    out.distance = distance(p, a);
    return out;
  }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = a.x + abx * t;
  const py = a.y + aby * t;
  const pz = a.z + abz * t;
  const dx = p.x - px;
  const dy = p.y - py;
  const dz = p.z - pz;
  out.t = t;
  out.point.x = px;
  out.point.y = py;
  out.point.z = pz;
  out.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return out;
}

/**
 * Uniformly distributed point inside a sphere of `radius`, centred on `origin`.
 * The alien's INVESTIGATE target is `origin + randomInSphere(errorRadius)` (§5).
 * Inject `rng` to make a round reproducible.
 */
export function randomInSphere(radius: number, rng: () => number = Math.random): Vec3 {
  // Rejection sampling: cheap, unbiased, and terminates fast (52% acceptance).
  for (let i = 0; i < 32; i++) {
    const x = rng() * 2 - 1;
    const y = rng() * 2 - 1;
    const z = rng() * 2 - 1;
    const d2 = x * x + y * y + z * z;
    if (d2 <= 1 && d2 > 0) {
      return { x: x * radius, y: y * radius, z: z * radius };
    }
  }
  return v3(0, 0, 0);
}

/** `origin` offset by a random point inside `radius` — the §5 INVESTIGATE target. */
export function jitterPoint(origin: Vec3, radius: number, rng: () => number = Math.random): Vec3 {
  return add(origin, randomInSphere(radius, rng));
}
