/**
 * Shut hatches as a collision surface (DESIGN.md §4 swept sphere, §5 doors).
 *
 * Hatch DOORS are deliberately absent from the static station BVH: they swing,
 * and rebuilding a BVH every time one moves would be absurd for nine doors. That
 * left the §4 swept sphere with nothing to hit, so a closed hatch — and worse, a
 * SEALED one — did not exist for the player at all. Both §5 pillars depend on it
 * existing: "closing a hatch behind you buys ~3 seconds while it opens the
 * hatch" is nothing if you can swim through the door, and SEAL_CHARGES is a
 * barricading mechanic that has to actually barricade.
 *
 * A doorway is a flat disc, so this is the analytic stand-in: for each linked
 * port, does the swept sphere cross the door plane inside the frame? Nine or so
 * discs, a handful of dot products each, zero allocation — cheap enough to run
 * at every collision substep, which is where it has to run so a body at PUSH_MAX
 * cannot step straight over a 0.1 m door.
 *
 * The discs are geometry and never move. Only `Port.hatch` changes, and that is
 * read LIVE off the module graph's own `Port` objects — the same objects the
 * station and the net layer mutate — so there is nothing to invalidate and no
 * rebuild on a hatch cycle.
 */

import * as THREE from 'three';
import { PLAYER_RADIUS } from '@shared/constants';
import type { ModuleId, Port, PortId } from '@shared/types';
import type { ModuleGraph } from '@shared/graph/moduleGraph';
import { localDirToWorld, localToWorld } from '@shared/graph/math';

/**
 * Radius of a hatch opening, metres. This mirrors the kit's `PORT_RADIUS`
 * (src/station/kit.ts) — the player subsystem does not import from another
 * subsystem's directory (see the header of `./types.ts`), and the number is
 * geometry rather than a §14 tuning constant, so it lives here rather than in
 * `./tuning.ts` where someone might "feel" it.
 *
 * Precision is not load-bearing: the test below is deliberately generous
 * (`disc.radius + body radius`), and everything outside the opening is the
 * bulkhead, which is solid geometry in the BVH already. The disc only ever gets
 * consulted for a door that is shut, and a shut door has no legal crossing.
 */
const HATCH_APERTURE_M = 0.7;

/** A doorway the sweep ran into. */
export interface HatchBlock {
  module: ModuleId;
  port: PortId;
  /** Centre of the doorway, world space. */
  centre: THREE.Vector3;
  /** Unit normal of the door plane, world space (the port's outward direction). */
  normal: THREE.Vector3;
}

interface HatchDisc extends HatchBlock {
  radius: number;
  /** Live references into the layout — hatch state mutates in place. */
  near: Port;
  far: Port | null;
}

const _probe = new THREE.Vector3();
const _lateral = new THREE.Vector3();

export class HatchBarrier {
  private readonly discs: HatchDisc[] = [];

  constructor(graph: ModuleGraph | null | undefined) {
    if (!graph) return;
    const seen = new Set<string>();
    for (const module of graph.all()) {
      for (const port of module.ports) {
        // An unlinked port is capped with real geometry — the BVH has it.
        if (!port.link) continue;
        // One disc per doorway, not one per side: both ports describe the same
        // door and the test already consults both hatch states.
        const here = `${module.id}:${port.id}`;
        const there = `${port.link.module}:${port.link.port}`;
        const pair = here < there ? `${here}|${there}` : `${there}|${here}`;
        if (seen.has(pair)) continue;
        seen.add(pair);

        const centre = localToWorld(port.localPos, module.transform);
        const normal = localDirToWorld(port.localDir, module.transform);
        this.discs.push({
          module: module.id,
          port: port.id,
          centre: new THREE.Vector3(centre.x, centre.y, centre.z),
          normal: new THREE.Vector3(normal.x, normal.y, normal.z).normalize(),
          radius: HATCH_APERTURE_M,
          near: port,
          far: graph.port(port.link.module, port.link.port) ?? null,
        });
      }
    }
  }

  /** Number of doorways under test. Zero means every query is a no-op. */
  get size(): number {
    return this.discs.length;
  }

  /**
   * Does moving a sphere of `radius` from `from` to `to` push through a hatch
   * that is not open?
   *
   * Returns the offending doorway or null. The returned object is owned by the
   * barrier and its vectors are live — read it, never keep it.
   */
  blocking(
    from: THREE.Vector3,
    to: THREE.Vector3,
    radius: number = PLAYER_RADIUS,
  ): HatchBlock | null {
    for (const disc of this.discs) {
      // Both sides describe the same door; the more restrictive one wins, and a
      // seal beats an `open` flag outright (§14: sealed is a powered lock).
      const sealed = disc.near.hatch.sealed || (disc.far?.hatch.sealed ?? false);
      const open = !sealed && disc.near.hatch.open && (disc.far?.hatch.open ?? true);
      if (open) continue;

      const dFrom = _probe.copy(from).sub(disc.centre).dot(disc.normal);
      const dTo = _probe.copy(to).sub(disc.centre).dot(disc.normal);
      // Wholly on one side, clear of the door: nothing to do.
      if (dFrom > radius && dTo > radius) continue;
      if (dFrom < -radius && dTo < -radius) continue;
      // Staying on one side and not closing on the plane: let it go. Without
      // this, a body resolved to rest against a shut door reads as "touching"
      // forever and can never leave — it would be welded to the door it bumped,
      // which is a far worse bug than the one this class exists to fix.
      if (dFrom * dTo > 0 && Math.abs(dTo) >= Math.abs(dFrom)) continue;

      // Point on the segment nearest the plane, clamped to the segment.
      const denom = dFrom - dTo;
      const t = Math.abs(denom) < 1e-6 ? 0 : clamp01(dFrom / denom);
      _lateral.copy(to).sub(from).multiplyScalar(t).add(from).sub(disc.centre);
      _lateral.addScaledVector(disc.normal, -_lateral.dot(disc.normal));
      const reach = disc.radius + radius;
      if (_lateral.lengthSq() <= reach * reach) return disc;
    }
    return null;
  }

  /**
   * Is a body of `radius` at `point` overlapping the plane of a shut hatch?
   *
   * `blocking()` above answers "did this MOVE cross a door", which is the right
   * question for a swept body and the wrong one for a GRIPPING player: the rail
   * slide stops the hand exactly at the junction, and the junction is the door
   * plane, so nothing crossed — the body simply ended up straddling it, with
   * passage correctly blocked and the camera inside the leaf.
   *
   * This is the static half of the same test, and it is deliberately NOT
   * symmetric with `blocking()`'s "not closing on the plane" escape: a body
   * standing in a doorway is in the doorway whichever way it is drifting. The
   * caller (`Player.clearGripOfDoor`) is what keeps that from welding anybody to
   * a door, by only ever pushing them toward the side they are already on.
   *
   * The returned object is owned by the barrier and its vectors are live — read
   * it, never keep it.
   */
  straddling(point: THREE.Vector3, radius: number = PLAYER_RADIUS): HatchBlock | null {
    for (const disc of this.discs) {
      const sealed = disc.near.hatch.sealed || (disc.far?.hatch.sealed ?? false);
      const open = !sealed && disc.near.hatch.open && (disc.far?.hatch.open ?? true);
      if (open) continue;

      const signed = _probe.copy(point).sub(disc.centre).dot(disc.normal);
      if (Math.abs(signed) >= radius) continue;

      _lateral.copy(point).sub(disc.centre).addScaledVector(disc.normal, -signed);
      const reach = disc.radius + radius;
      if (_lateral.lengthSq() <= reach * reach) return disc;
    }
    return null;
  }
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
