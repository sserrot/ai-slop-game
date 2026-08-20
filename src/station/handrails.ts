/**
 * Handrails (DESIGN.md §2 rail graph, §9 rendering; asset bible ISS-STR-05).
 *
 * The meshes are built straight from `RailGraph`'s world-space nodes, so the rail
 * you can see IS the rail the player grips and the alien follows. There is no
 * second, decorative set of handrails to drift out of sync — if a rail is missing
 * from the graph it is missing from the render, which is exactly how you want an
 * authoring bug to present itself.
 *
 * REV B — THE RAIL IS ONLY A HERO WHERE IT IS THE ONLY WAY TO MOVE
 * ----------------------------------------------------------------
 * The bible scopes this asset to `gravity: 'zero'` and the closing rules say why:
 * "nothing out-contrasts a handrail — INSIDE a zero-G module. In gravity modules
 * that priority passes to cover and thresholds." But §2 is equally explicit that
 * the rails themselves stay authored everywhere: the alien rail-follows inside
 * every module at scope `any`, and §4's gravity-failure fairness guarantee ("2.5
 * seconds of warning is only fair if there is something to grab at the end of
 * it") is a promise about geometry, not about timing.
 *
 * Deleting the rails from gravity modules would break both. So nothing is
 * deleted — the rails are SPLIT BY MATERIAL:
 *
 *   zero modules    `materials.rail` — the ice-blue hero surface, faintly
 *                   self-lit, the most readable thing in the room.
 *   nominal modules `materials.aluminium` — bare metal pipework. Present,
 *                   grabbable, obviously not the way you are meant to travel.
 *
 * Which set an instance lands in is read LIVE from the graph (`railsActive`), so
 * when the plant winds down the rails in that module WAKE UP: the same geometry
 * goes from pipe to hero at the moment the floor stops being one. That is the
 * warning window made visible, and it costs one extra draw call for the whole
 * station.
 *
 * The brackets are a third set and never change: a standoff is structure, not
 * grammar. Rails never cast shadow — `InstancedSet` latches that, and the latch
 * is deliberate (a hundred rails re-rasterised into the 1024² flashlight map
 * every frame is a cost you measure, not one you see).
 */

import * as THREE from 'three';
import type { ModuleId } from '@shared/types';
import type { RailGraph, RailNode } from '@shared/graph/railGraph';
import { buildRailBracketGeometry, buildRailGeometry } from './geometry';
import { InstancedSet } from './instancing';
import type { InstanceEntry } from './instancing';
import type { StationMaterials } from './materials';

const UP = new THREE.Vector3(0, 1, 0);
/** Where along a segment the two brackets sit. A 0.8 m grab span (§14
 *  `GRAB_RANGE`) wants its supports outside the hands, not under them. */
const BRACKET_T = 0.14;
/** Below this, a segment is a stub at a junction and gets no brackets: two
 *  standoffs 10 cm apart read as a lump, not as a mount. */
const BRACKET_MIN_LENGTH = 0.55;
/** How far off the rail axis a module's rail centroid has to be before "away
 *  from the middle of the room" is a usable direction for a bracket. */
const STANDOFF_MIN = 0.06;

export class StationHandrails {
  readonly group = new THREE.Group();
  private readonly rails: RailGraph;
  private readonly zero: InstancedSet;
  private readonly nominal: InstancedSet;
  private readonly brackets: InstancedSet;
  private visible: ReadonlySet<ModuleId> | null = null;
  /** Every module with rails, in a fixed order — the bit positions below. */
  private readonly moduleIds: ModuleId[] = [];
  /** Bitmasks of (rails load-bearing) and (module visible) as last packed, so
   *  the per-frame refresh is a compare and not a repack. −1 = never packed. */
  private activeBits = -1;
  private visibleBits = -1;
  /** Reused across refreshes: this runs every frame, so it allocates nothing. */
  private readonly zeroSet = new Set<ModuleId>();
  private readonly nominalSet = new Set<ModuleId>();
  private readonly visibleSet = new Set<ModuleId>();

  constructor(rails: RailGraph, materials: StationMaterials) {
    this.group.name = 'station-handrails';
    this.rails = rails;

    const tubes: InstanceEntry[] = [];
    const brackets: InstanceEntry[] = [];
    // Group by module so the culler can drop a whole module's rails at once.
    const byModule = new Map<ModuleId, RailNode[]>();
    for (const node of rails.nodes()) {
      let list = byModule.get(node.module);
      if (!list) {
        list = [];
        byModule.set(node.module, list);
      }
      list.push(node);
    }

    for (const [module, nodes] of byModule) {
      const centroid = railCentroid(nodes);
      for (const node of nodes) {
        const a = new THREE.Vector3(node.a.x, node.a.y, node.a.z);
        const b = new THREE.Vector3(node.b.x, node.b.y, node.b.z);
        const dir = b.clone().sub(a);
        const length = dir.length();
        if (length < 1e-4) continue;
        dir.divideScalar(length);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const swing = new THREE.Quaternion().setFromUnitVectors(UP, dir);
        tubes.push({
          module,
          matrix: new THREE.Matrix4().compose(mid, swing, new THREE.Vector3(1, length, 1)),
        });
        if (length < BRACKET_MIN_LENGTH) continue;

        // The standoff points AWAY from the middle of the module's own rail
        // layout, perpendicular to the rail. That is the wall in every piece the
        // kit has — a tube's rails sit either side of the axis, the cupola's ring
        // is radial — and it needs no module transform, which this class does not
        // have. A node's six spokes run THROUGH their centroid, so the
        // perpendicular collapses and they are left unbracketed: correct, since a
        // spoke's ends die into the face frames rather than into a wall.
        const standoff = mid.clone().sub(centroid);
        standoff.addScaledVector(dir, -standoff.dot(dir));
        if (standoff.length() < STANDOFF_MIN) continue;
        standoff.normalize();
        // Bracket frame: rail along +Y, wall at −Z.
        const basis = new THREE.Matrix4().makeBasis(
          new THREE.Vector3().crossVectors(dir, standoff).normalize(),
          dir,
          standoff,
        );
        for (const t of [BRACKET_T, 1 - BRACKET_T]) {
          const at = a.clone().addScaledVector(dir, length * t);
          brackets.push({ module, matrix: basis.clone().setPosition(at) });
        }
      }
    }

    // Both rail sets carry every instance; visibility picks. Two InstancedMeshes
    // with the same 32-triangle tube is a few kilobytes of matrices, and the
    // alternative — rebuilding a set when a module loses its floor — is geometry
    // churn during the one second of the round when the frame budget matters
    // most.
    this.zero = new InstancedSet(buildRailGeometry(), materials.rail, tubes, 'handrails');
    this.nominal = new InstancedSet(
      buildRailGeometry(),
      materials.aluminium,
      tubes,
      'handrails-inert',
    );
    this.brackets = new InstancedSet(
      buildRailBracketGeometry(),
      materials.frame,
      brackets,
      'handrail-brackets',
    );
    this.group.add(this.zero.mesh, this.nominal.mesh, this.brackets.mesh);
    this.moduleIds.push(...byModule.keys());

    // THE PER-FRAME HOOK. Gravity can change at ANY time (§4's director drops
    // floors mid-round) and nothing calls into this class when it does:
    // `StationGravity` writes the module's new mode onto the layout and repaints
    // the deck edge, while `Station.applyVisibility` only runs on a cull change.
    // Rather than require a new call site in `station.ts` or `main.ts` — files
    // this family does not own — the repaint rides the one hook three.js
    // guarantees runs every frame for anything in the scene:
    // `Object3D.updateMatrixWorld` recurses into children regardless of
    // `visible`, so `Scene.updateMatrixWorld` reaches this group even when every
    // rail in the station is culled. `refresh()` is a bitmask compare when
    // nothing has moved, and calling it from anywhere else stays valid.
    const base = THREE.Object3D.prototype.updateMatrixWorld.bind(this.group);
    this.group.updateMatrixWorld = (force?: boolean): void => {
      this.refresh();
      base(force);
    };
    this.refresh();
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    this.visible = visible;
    this.refresh();
  }

  /**
   * Re-read which modules have lost their floor, and repaint accordingly.
   *
   * Allocation-free and O(modules) when nothing has changed, which is what lets
   * it run from `updateMatrixWorld` every frame. With more than 31 modules the
   * bitmask saturates and this stops early-outing — `InstancedSet.setVisible`
   * still does, so the result is correct either way, just less thrifty.
   */
  refresh(): void {
    let activeBits = 0;
    let visibleBits = 0;
    for (let i = 0; i < this.moduleIds.length; i++) {
      const id = this.moduleIds[i] as ModuleId;
      const bit = i < 31 ? 1 << i : 0;
      if (this.rails.railsActive(id)) activeBits |= bit;
      if (!this.visible || this.visible.has(id)) visibleBits |= bit;
    }
    if (activeBits === this.activeBits && visibleBits === this.visibleBits) return;
    this.activeBits = activeBits;
    this.visibleBits = visibleBits;

    this.zeroSet.clear();
    this.nominalSet.clear();
    this.visibleSet.clear();
    for (const id of this.moduleIds) {
      if (this.visible && !this.visible.has(id)) continue;
      this.visibleSet.add(id);
      (this.rails.railsActive(id) ? this.zeroSet : this.nominalSet).add(id);
    }
    this.zero.setVisible(this.zeroSet);
    this.nominal.setVisible(this.nominalSet);
    this.brackets.setVisible(this.visibleSet);
  }

  dispose(): void {
    for (const set of [this.zero, this.nominal, this.brackets]) {
      this.group.remove(set.mesh);
      set.dispose();
    }
  }
}

/** Middle of a module's rail layout — the anchor a bracket stands off from. */
function railCentroid(nodes: readonly RailNode[]): THREE.Vector3 {
  const c = new THREE.Vector3();
  let n = 0;
  for (const node of nodes) {
    c.x += node.a.x + node.b.x;
    c.y += node.a.y + node.b.y;
    c.z += node.a.z + node.b.z;
    n += 2;
  }
  return n === 0 ? c : c.divideScalar(n);
}
