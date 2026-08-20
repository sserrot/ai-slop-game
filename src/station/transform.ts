/**
 * Quaternion helpers for kit-piece snapping (DESIGN.md §2 — "build a kit of five
 * pieces and snap them via ports").
 *
 * `@shared/graph/math` deliberately stops at `applyQuat` / `conjugate`, because
 * shared/ only ever *consumes* transforms. Authoring needs to *derive* them, so
 * the construction side lives here. Still pure plain-object maths — no three.js —
 * so `buildLevel.ts` can run it under tsx and the result can be JSON.
 */

import type { Quat, Vec3 } from '@shared/types';
import { cross, dot, normalize, v3 } from '@shared/graph/math';

export const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function quatClone(q: Quat): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/** Hamilton product — `a` applied AFTER `b`, matching THREE.Quaternion.multiply. */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-12) return { ...IDENTITY_QUAT };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

export function quatFromAxisAngle(axis: Vec3, radians: number): Quat {
  const a = normalize(axis);
  const h = radians / 2;
  const s = Math.sin(h);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(h) };
}

/**
 * Shortest rotation taking unit vector `from` onto unit vector `to`.
 * Mirrors THREE.Quaternion.setFromUnitVectors, including the antiparallel case.
 */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const f = normalize(from);
  const t = normalize(to);
  let r = dot(f, t) + 1;
  if (r < 1e-8) {
    // Opposed: any perpendicular axis will do; pick the most stable one.
    r = 0;
    if (Math.abs(f.x) > Math.abs(f.z)) {
      return quatNormalize({ x: -f.y, y: f.x, z: 0, w: 0 });
    }
    return quatNormalize({ x: 0, y: -f.z, z: f.y, w: 0 });
  }
  const c = cross(f, t);
  return quatNormalize({ x: c.x, y: c.y, z: c.z, w: r });
}

/**
 * Quaternion from an orthonormal basis given as the images of the local X/Y/Z
 * axes (i.e. the columns of the rotation matrix). Shepperd's method.
 */
export function quatFromBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Quat {
  const m00 = xAxis.x;
  const m10 = xAxis.y;
  const m20 = xAxis.z;
  const m01 = yAxis.x;
  const m11 = yAxis.y;
  const m21 = yAxis.z;
  const m02 = zAxis.x;
  const m12 = zAxis.y;
  const m22 = zAxis.z;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return quatNormalize({
      x: (m21 - m12) * s,
      y: (m02 - m20) * s,
      z: (m10 - m01) * s,
      w: 0.25 / s,
    });
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return quatNormalize({
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
      w: (m21 - m12) / s,
    });
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return quatNormalize({
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
      w: (m02 - m20) / s,
    });
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return quatNormalize({
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
    w: (m10 - m01) / s,
  });
}

/**
 * Orientation for a wall-mounted prop.
 *
 * Convention used by every prop archetype in `kit.ts`: local **+Y points into
 * the module interior** (out of the wall it is bolted to) and local **+Z runs
 * along the prop's long axis**. Give it those two world-space directions and
 * this returns the quaternion; `along` is re-orthogonalised against `inward`.
 */
export function orientProp(inward: Vec3, along: Vec3): Quat {
  const y = normalize(inward);
  let z = { x: along.x - y.x * dot(along, y), y: along.y - y.y * dot(along, y), z: along.z - y.z * dot(along, y) };
  if (Math.hypot(z.x, z.y, z.z) < 1e-6) {
    // `along` was parallel to `inward` — fall back to any perpendicular.
    z = Math.abs(y.z) < 0.9 ? v3(0, 0, 1) : v3(1, 0, 0);
    z = { x: z.x - y.x * dot(z, y), y: z.y - y.y * dot(z, y), z: z.z - y.z * dot(z, y) };
  }
  z = normalize(z);
  const x = cross(y, z);
  return quatFromBasis(x, y, z);
}

/** Round a vector for stable, diff-friendly JSON. */
export function roundVec(v: Vec3, decimals = 4): Vec3 {
  const f = 10 ** decimals;
  return {
    x: Math.round(v.x * f) / f,
    y: Math.round(v.y * f) / f,
    z: Math.round(v.z * f) / f,
  };
}

export function roundQuat(q: Quat, decimals = 6): Quat {
  const f = 10 ** decimals;
  return {
    x: Math.round(q.x * f) / f,
    y: Math.round(q.y * f) / f,
    z: Math.round(q.z * f) / f,
    w: Math.round(q.w * f) / f,
  };
}
