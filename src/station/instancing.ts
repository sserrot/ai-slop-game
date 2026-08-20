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
 *
 * Two things were added when the props were rebuilt (`props.ts`), both in
 * service of the same constraint — one mesh per kind, so variety and state have
 * to come from somewhere other than geometry:
 *
 *   • `variantIndex`, which assigns each authored instance to one of a kind's
 *     silhouette variants, so 33 racks down a wall stop tiling.
 *   • `setInstanceHidden`, which suppresses a single instance during the
 *     repack, so a per-instance STATE can be shown inside one draw call. The
 *     matrices live in one flat buffer with a span table per module rather than
 *     in per-module chunks, because a chunk can only be copied whole.
 */

import * as THREE from 'three';
import type { ModuleId } from '@shared/types';

export interface InstanceEntry {
  module: ModuleId;
  matrix: THREE.Matrix4;
}

/**
 * Pick one of `variants` buckets for an authored id, deterministically.
 *
 * One `InstancedMesh` per kind means variety cannot come from per-instance
 * geometry, so a kind that would visibly tile ships two or three silhouettes as
 * separate sets (`props.ts`: three racks, two cable runs) and every instance is
 * assigned to one here. Two properties matter and neither is negotiable:
 *
 *   • DETERMINISM. The same level must produce the same wall every run, or a
 *     screenshot, a bug report and a repro are three different rooms.
 *   • AVALANCHE ON THE LAST BYTE. The ids that need separating are exactly the
 *     ones that differ in their last character — `tubeRacks` emits
 *     `…-rack-00`, `…-rack-01`, `…-rack-10`, `…-rack-11` down one wall, and
 *     `tubeCables` emits three pieces that butt end to end into a single 4.9 m
 *     run. FNV-1a mixes the final byte through the whole 32-bit state, so
 *     consecutive ids land in unrelated buckets; a length- or charCode-sum hash
 *     would have put them all in the same one and quietly bought nothing.
 *
 * `>>> 0` keeps the state unsigned, which is the whole reason FNV-1a survives
 * being written in a language whose bitwise operators are signed 32-bit.
 */
export function variantIndex(id: string, variants: number): number {
  if (variants <= 1) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % variants;
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

interface ModuleSpan {
  /** First slot of this module's block in `source`, in instances. */
  readonly start: number;
  readonly count: number;
}

export class InstancedSet {
  readonly mesh: THREE.InstancedMesh;
  readonly total: number;
  /**
   * Every instance matrix, grouped by module, in the layout the repack reads.
   *
   * Was a `Map<ModuleId, Float32Array>` of per-module chunks. It is one flat
   * buffer now for a reason `setInstanceHidden` needs: a chunk can only be
   * copied whole, so suppressing a SINGLE instance meant rebuilding a chunk,
   * and a flat buffer plus a span table copies either a whole module (the fast
   * path, unchanged) or one instance at a time (only when something is
   * suppressed) out of the same memory.
   */
  private readonly source: Float32Array;
  private readonly order: ModuleId[] = [];
  private readonly spans = new Map<ModuleId, ModuleSpan>();
  /** Original entry index → slot in `source`. Entries arrive in author order
   *  and are stored in module order, so callers need the permutation. */
  private readonly slotOf: Int32Array;
  private readonly hidden: Uint8Array;
  private hiddenCount = 0;
  private lastKey = ' ';
  /** Bumped by `setInstanceHidden`, so the `lastKey` fast-out cannot swallow a
   *  suppression that happens while the visible set is unchanged. */
  private revision = 0;
  private lastRevision = -1;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    entries: readonly InstanceEntry[],
    name = 'instances',
  ) {
    const grouped = new Map<ModuleId, number[]>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as InstanceEntry;
      let list = grouped.get(e.module);
      if (!list) {
        list = [];
        grouped.set(e.module, list);
        this.order.push(e.module);
      }
      list.push(i);
    }

    this.total = entries.length;
    this.source = new Float32Array(this.total * 16);
    this.slotOf = new Int32Array(this.total);
    this.hidden = new Uint8Array(this.total);
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

    let slot = 0;
    for (const module of this.order) {
      const list = grouped.get(module) as number[];
      this.spans.set(module, { start: slot, count: list.length });
      for (const entry of list) {
        (entries[entry] as InstanceEntry).matrix.toArray(this.source, slot * 16);
        this.slotOf[entry] = slot;
        slot++;
      }
    }

    // Start with everything packed and drawn; `Station.update(null)` and the
    // first `applyCull` both arrive before the first frame, but an empty buffer
    // in between reads as a crash.
    const target = this.mesh.instanceMatrix.array as Float32Array;
    target.set(this.source);
    this.mesh.count = this.total;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.refreshBounds();
  }

  /** Show only the instances belonging to `visible`. Cheap no-op when unchanged. */
  setVisible(visible: ReadonlySet<ModuleId>): void {
    if (this.total === 0) return;
    let key = '';
    for (const module of this.order) key += visible.has(module) ? '1' : '0';
    if (key === this.lastKey && this.revision === this.lastRevision) return;
    this.lastKey = key;
    this.lastRevision = this.revision;
    this.repack(visible);
  }

  /**
   * Suppress or restore ONE instance, addressed by its index in the `entries`
   * array the constructor was given.
   *
   * This is how a per-instance STATE gets shown without a second draw call. The
   * case it exists for: the interactable accent on a hide spot (`props.ts`)
   * should go dark while somebody is inside it, because "is that box free?" is a
   * question a teammate has to be able to answer across a module and the alien
   * is blind, so nothing else in the frame answers it. Suppressing the lamp is
   * the whole state change — dot lit means you can get in, dot dark means
   * somebody already did.
   *
   * Cost: the repack loses its bulk `set()` for the module the suppressed
   * instance lives in and copies that module's matrices one at a time instead.
   * A few hundred float copies on a state change, not per frame.
   */
  setInstanceHidden(entry: number, hidden: boolean): void {
    if (entry < 0 || entry >= this.total) return;
    // `hidden` is indexed by SLOT, not by entry: the repack walks `source` in
    // module order and has no way back to the author's array, so the
    // permutation is applied here, once, rather than inside the hot loop.
    const slot = this.slotOf[entry] as number;
    const flag = hidden ? 1 : 0;
    if (this.hidden[slot] === flag) return;
    this.hidden[slot] = flag;
    this.hiddenCount += hidden ? 1 : -1;
    this.revision++;
    // The visible set has not changed, so re-run the repack against the key
    // already recorded rather than making callers re-supply it.
    this.repackFromKey();
  }

  /** True while `entry` is suppressed. */
  isInstanceHidden(entry: number): boolean {
    if (entry < 0 || entry >= this.total) return false;
    return this.hidden[this.slotOf[entry] as number] === 1;
  }

  /** Instances currently packed at the front of the buffer, i.e. drawn. */
  get drawnCount(): number {
    return this.mesh.count;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.spans.clear();
  }

  /** Copy the visible, unsuppressed blocks to the front and shorten `count`. */
  private repack(visible: ReadonlySet<ModuleId>): void {
    const target = this.mesh.instanceMatrix.array as Float32Array;
    let cursor = 0;
    for (const module of this.order) {
      if (!visible.has(module)) continue;
      const span = this.spans.get(module) as ModuleSpan;
      if (this.hiddenCount === 0) {
        target.set(this.source.subarray(span.start * 16, (span.start + span.count) * 16), cursor * 16);
        cursor += span.count;
        continue;
      }
      for (let i = 0; i < span.count; i++) {
        const s = span.start + i;
        if (this.hidden[s] === 1) continue;
        target.set(this.source.subarray(s * 16, (s + 1) * 16), cursor * 16);
        cursor++;
      }
    }
    this.mesh.count = cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.refreshBounds();
  }

  /** Re-run the repack for the visible set `lastKey` describes. `lastKey`'s
   *  initial `' '` is shorter than `order`, which reads as "nothing recorded
   *  yet" and correctly repacks everything. */
  private repackFromKey(): void {
    if (this.total === 0) return;
    const visible = new Set<ModuleId>();
    for (let i = 0; i < this.order.length; i++) {
      if (this.lastKey.length !== this.order.length || this.lastKey[i] === '1') {
        visible.add(this.order[i] as ModuleId);
      }
    }
    this.lastRevision = this.revision;
    this.repack(visible);
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
