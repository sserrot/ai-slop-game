/**
 * The plain-object ↔ three.js boundary.
 *
 * `shared/` deliberately never imports three (the Node server uses the same
 * maths), so every `Vec3`/`Quat` that crosses into the renderer converts here.
 * They are structurally identical, which keeps this trivial.
 */

import * as THREE from 'three';
import type { PropRef, Quat, StationModule, Vec3 } from '@shared/types';

const ONE = new THREE.Vector3(1, 1, 1);

export function toVector3(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

export function toQuaternion(q: Quat): THREE.Quaternion {
  return new THREE.Quaternion(q.x, q.y, q.z, q.w);
}

export function fromVector3(v: THREE.Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** Module space → world space. */
export function moduleMatrix(module: StationModule): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    toVector3(module.transform.pos),
    toQuaternion(module.transform.quat),
    ONE,
  );
}

/** Prop space → module space. */
export function propMatrix(prop: PropRef): THREE.Matrix4 {
  const s = prop.scale ?? 1;
  return new THREE.Matrix4().compose(
    toVector3(prop.localPos),
    prop.localQuat ? toQuaternion(prop.localQuat) : new THREE.Quaternion(),
    new THREE.Vector3(s, s, s),
  );
}

/** Prop space → world space. */
export function propWorldMatrix(module: StationModule, prop: PropRef): THREE.Matrix4 {
  return moduleMatrix(module).multiply(propMatrix(prop));
}

/** Apply a module's transform to a module-space point, in three types. */
export function moduleToWorld(module: StationModule, local: Vec3): THREE.Vector3 {
  return toVector3(local).applyQuaternion(toQuaternion(module.transform.quat)).add(
    toVector3(module.transform.pos),
  );
}
