/**
 * Static collision (DESIGN.md §1 `three-mesh-bvh`, §4 swept sphere).
 *
 * One BVH for the whole station: hull walls, bulkheads, endcaps and rack faces,
 * merged into a single world-space, position-only geometry. §4's kinematic
 * controller sweeps a 0.35m sphere against it, and the interaction raycaster
 * uses it for line-of-sight queries.
 *
 * Hatch DOORS are deliberately not in it. They move, and rebuilding a BVH every
 * time a door swings would be absurd for nine doors; instead `HatchBlockers`
 * answers "does this movement cross a shut hatch?" analytically, against the
 * live `Port.hatch` state. A closed hatch is a 0.7m disc — cheap to test, and
 * there are only nine of them.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  MeshBVH,
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';
import { PLAYER_RADIUS } from '@shared/constants';
import type { ModuleId, Port, PortId, StationLayout, Vec3 } from '@shared/types';
import { localDirToWorld, localToWorld } from '@shared/graph/math';
import { PORT_RADIUS } from './kit';
import { toVector3 } from './threeUtil';

let patched = false;

/** Install three-mesh-bvh's accelerated raycast. Idempotent, and harmless for
 *  geometry without a `boundsTree` — it falls straight through to the default. */
export function installBvhRaycast(): void {
  if (patched) return;
  patched = true;
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

export interface StationCollider {
  bvh: MeshBVH;
  geometry: THREE.BufferGeometry;
  /** Invisible, identity-transformed, and already carrying `boundsTree`.
   *  Raycast against this; it is added to the station group so `dispose` finds it. */
  mesh: THREE.Mesh;
}

/** Merge world-space, position-only geometry into the station's static BVH. */
export function buildStationCollider(parts: THREE.BufferGeometry[]): StationCollider {
  installBvhRaycast();
  if (parts.length === 0) throw new Error('buildStationCollider: no collision geometry');
  const geometry = parts.length === 1 ? (parts[0] as THREE.BufferGeometry) : mergeGeometries(parts, false);
  if (parts.length > 1) for (const p of parts) p.dispose();

  const bvh = new MeshBVH(geometry);
  geometry.boundsTree = bvh;

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ visible: false, wireframe: true }),
  );
  mesh.name = 'station-collider';
  mesh.visible = false;
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  // Invisible, but a shadow map does not care about `visible` on a caster the
  // way you would hope — and §9 budgets exactly one shadow map. Opt out here so
  // the decision travels with the mesh, and flag it for blanket traversers.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.noShadow = true;
  return { bvh, geometry, mesh };
}

// ---------------------------------------------------------------------------
// Hatch discs
// ---------------------------------------------------------------------------

export interface PortDisc {
  module: ModuleId;
  port: PortId;
  centre: THREE.Vector3;
  normal: THREE.Vector3;
  radius: number;
  /** Live references into the layout — hatch state mutates in place, so these
   *  never go stale and the test needs no lookups. */
  near: Port;
  far: Port | null;
}

/**
 * Analytic blocker for shut hatches. Rebuilt never — the discs are static; only
 * whether each one is solid changes, and that is read live from the layout.
 */
export class HatchBlockers {
  private readonly discs: PortDisc[] = [];

  constructor(layout: StationLayout) {
    const byId = new Map(layout.modules.map((m) => [m.id, m]));
    for (const module of layout.modules) {
      for (const port of module.ports) {
        // Unlinked ports are already solid geometry in the BVH.
        if (!port.link) continue;
        const far = byId.get(port.link.module)?.ports.find((p) => p.id === port.link?.port) ?? null;
        this.discs.push({
          module: module.id,
          port: port.id,
          centre: toVector3(localToWorld(port.localPos, module.transform)),
          normal: toVector3(localDirToWorld(port.localDir, module.transform)).normalize(),
          radius: PORT_RADIUS,
          near: port,
          far,
        });
      }
    }
  }

  /** Every hatch disc, whatever its state — useful for debug draws. */
  all(): readonly PortDisc[] {
    return this.discs;
  }

  /**
   * Does moving a sphere of `radius` from `from` to `to` push through a hatch
   * that is not open? Returns the offending port, or null.
   *
   * Cheap and conservative: it treats the doorway as a flat disc and rejects the
   * move if the crossing point is anywhere inside the frame.
   */
  blocking(from: THREE.Vector3, to: THREE.Vector3, radius = PLAYER_RADIUS): PortDisc | null {
    for (const disc of this.discs) {
      // Both sides describe the same door; the more restrictive one wins.
      const sealed = disc.near.hatch.sealed || (disc.far?.hatch.sealed ?? false);
      const open = !sealed && disc.near.hatch.open && (disc.far?.hatch.open ?? true);
      if (open) continue;

      const dFrom = tmpA.copy(from).sub(disc.centre).dot(disc.normal);
      const dTo = tmpA.copy(to).sub(disc.centre).dot(disc.normal);
      if (dFrom > radius && dTo > radius) continue;
      if (dFrom < -radius && dTo < -radius) continue;
      // Stayed on one side and did not close on the plane — a body resting
      // against a shut door has to be able to leave it, or the door welds it on.
      if (dFrom * dTo > 0 && Math.abs(dTo) >= Math.abs(dFrom)) continue;

      // Point on the segment nearest the plane, clamped to the segment.
      const denom = dFrom - dTo;
      const t = Math.abs(denom) < 1e-6 ? 0 : Math.min(1, Math.max(0, dFrom / denom));
      tmpB.copy(to).sub(from).multiplyScalar(t).add(from);
      const lateral = tmpB.sub(disc.centre);
      const along = lateral.dot(disc.normal);
      lateral.addScaledVector(disc.normal, -along);
      if (lateral.lengthSq() <= (disc.radius + radius) * (disc.radius + radius)) return disc;
    }
    return null;
  }

}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Convenience for callers holding plain `Vec3`s. */
export function blockedByHatch(
  blockers: HatchBlockers,
  from: Vec3,
  to: Vec3,
  radius = PLAYER_RADIUS,
): PortDisc | null {
  return blockers.blocking(toVector3(from), toVector3(to), radius);
}
