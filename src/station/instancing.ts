/**
 * Per-module instancing (DESIGN.md §9 — "`InstancedMesh` for handrails and
 * repeated props; one draw call per prop type").
 *
 * The catch: §9 asks for one draw call per prop type AND two-hop portal culling
 * in the same breath, and a single station-wide InstancedMesh cannot hide the
 * modules you are not allowed to see. The resolution is to keep exactly one
 * InstancedMesh per type and REPACK it when the visible set changes: every
 * module owns a contiguous block of instance matrices, and `setVisible` copies
 * the visible blocks to the front of the buffer and shortens `count`.
 *
 * That is a few hundred float copies on a module transition — cheaper than one
 * extra draw call per frame, and it happens only when you swim through a hatch.
 */

import * as THREE from 'three';
import type { ModuleId } from '@shared/types';

export interface InstanceEntry {
  module: ModuleId;
  matrix: THREE.Matrix4;
}

/**
 * Pin an `Object3D` boolean so a blanket `group.traverse(o => o.flag = true)`
 * somewhere else cannot silently undo a decision this file made deliberately.
 *
 * A hundred handrails re-rasterised into the 1024² flashlight shadow map every
 * frame is not a bug you SEE — it is a bug you measure, months later — so the
 * flag is defended rather than merely set. The property keeps a setter (writes
 * are swallowed, never thrown) because a blanket setter running under `strict`
 * must not take the frame down; `userData.noShadow` is set alongside so a
 * well-behaved traverser can skip these meshes instead of writing to them.
 *
 * Defined on the INSTANCE, so `Object3D.copy`/`clone` of anything else — and of
 * a clone of this mesh — is unaffected.
 */
function lockFlag(object: THREE.Object3D, key: 'castShadow' | 'frustumCulled', value: boolean): void {
  Object.defineProperty(object, key, {
    get: () => value,
    set: () => {
      /* deliberate no-op: this decision is owned here (§9) */
    },
    configurable: true,
    enumerable: true,
  });
}

export class InstancedSet {
  readonly mesh: THREE.InstancedMesh;
  readonly total: number;
  private readonly chunks = new Map<ModuleId, Float32Array>();
  private readonly order: ModuleId[] = [];
  private lastKey = ' ';

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    entries: readonly InstanceEntry[],
    name = 'instances',
  ) {
    const grouped = new Map<ModuleId, THREE.Matrix4[]>();
    for (const e of entries) {
      let list = grouped.get(e.module);
      if (!list) {
        list = [];
        grouped.set(e.module, list);
        this.order.push(e.module);
      }
      list.push(e.matrix);
    }

    this.total = entries.length;
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, this.total));
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.receiveShadow = true;
    // §9 budgets ONE shadow map (the flashlight). These meshes opt out of it,
    // and the decision is LATCHED — a blanket `castShadow = true` traverse
    // elsewhere is swallowed rather than obeyed.
    lockFlag(this.mesh, 'castShadow', false);
    this.mesh.userData.noShadow = true;
    // Frustum culling is ON, and the bounding volume is rebuilt on every repack
    // (see `refreshBounds`). It used to be off, on the reasonable grounds that
    // three's cached bounding sphere describes whatever was in the buffer last
    // time — but a stale sphere is a bug waiting to happen and "never cull" is
    // 7 guaranteed draw calls a frame. Recomputing costs one pass over at most
    // a few dozen matrices, on module transitions only.
    lockFlag(this.mesh, 'frustumCulled', true);

    const target = this.mesh.instanceMatrix.array as Float32Array;
    let cursor = 0;
    for (const module of this.order) {
      const list = grouped.get(module) as THREE.Matrix4[];
      const chunk = new Float32Array(list.length * 16);
      for (let i = 0; i < list.length; i++) (list[i] as THREE.Matrix4).toArray(chunk, i * 16);
      this.chunks.set(module, chunk);
      target.set(chunk, cursor * 16);
      cursor += list.length;
    }
    this.mesh.count = cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.refreshBounds();
  }

  /** Show only the instances belonging to `visible`. Cheap no-op when unchanged. */
  setVisible(visible: ReadonlySet<ModuleId>): void {
    if (this.total === 0) return;
    let key = '';
    for (const module of this.order) key += visible.has(module) ? '1' : '0';
    if (key === this.lastKey) return;
    this.lastKey = key;

    const target = this.mesh.instanceMatrix.array as Float32Array;
    let cursor = 0;
    for (const module of this.order) {
      if (!visible.has(module)) continue;
      const chunk = this.chunks.get(module) as Float32Array;
      target.set(chunk, cursor * 16);
      cursor += chunk.length / 16;
    }
    this.mesh.count = cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.refreshBounds();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.chunks.clear();
  }

  /**
   * Rebuild the bounding sphere and box over the instances currently PACKED at
   * the front of the buffer. `InstancedMesh.computeBoundingSphere` walks
   * `0 … count`, which is exactly the visible block after a repack, so the
   * volume the frustum test uses always describes what will actually be drawn.
   *
   * `count === 0` (every module in this set culled away) would leave three with
   * an empty sphere of radius -1, which `Frustum.intersectsSphere` treats as
   * "never visible" — correct, but only by accident. Say it explicitly instead.
   */
  private refreshBounds(): void {
    if (this.mesh.count === 0) {
      const sphere = this.mesh.boundingSphere ?? new THREE.Sphere();
      sphere.makeEmpty();
      this.mesh.boundingSphere = sphere;
      const box = this.mesh.boundingBox ?? new THREE.Box3();
      box.makeEmpty();
      this.mesh.boundingBox = box;
      return;
    }
    this.mesh.computeBoundingSphere();
    this.mesh.computeBoundingBox();
  }
}
