/**
 * Handrails (DESIGN.md §2 rail graph, §9 rendering).
 *
 * The meshes are built straight from `RailGraph`'s world-space nodes, so the
 * rail you can see IS the rail the player grips and the alien follows. There is
 * no second, decorative set of handrails to drift out of sync — if a rail is
 * missing from the graph it is missing from the render, which is exactly how
 * you want an authoring bug to present itself.
 *
 * One InstancedMesh, a unit cylinder stretched onto each segment, in the §9
 * high-contrast material.
 */

import * as THREE from 'three';
import type { ModuleId } from '@shared/types';
import type { RailGraph } from '@shared/graph/railGraph';
import { buildRailGeometry } from './geometry';
import { InstancedSet } from './instancing';
import type { InstanceEntry } from './instancing';
import type { StationMaterials } from './materials';

const UP = new THREE.Vector3(0, 1, 0);

export class StationHandrails {
  readonly group = new THREE.Group();
  private readonly set: InstancedSet;

  constructor(rails: RailGraph, materials: StationMaterials) {
    this.group.name = 'station-handrails';
    const entries: InstanceEntry[] = [];
    // Group by module so the culler can drop a whole module's rails at once.
    const byModule = new Map<ModuleId, InstanceEntry[]>();

    for (const node of rails.nodes()) {
      const a = new THREE.Vector3(node.a.x, node.a.y, node.a.z);
      const b = new THREE.Vector3(node.b.x, node.b.y, node.b.z);
      const dir = b.clone().sub(a);
      const length = dir.length();
      if (length < 1e-4) continue;
      dir.divideScalar(length);
      const matrix = new THREE.Matrix4().compose(
        a.clone().add(b).multiplyScalar(0.5),
        new THREE.Quaternion().setFromUnitVectors(UP, dir),
        new THREE.Vector3(1, length, 1),
      );
      let list = byModule.get(node.module);
      if (!list) {
        list = [];
        byModule.set(node.module, list);
      }
      list.push({ module: node.module, matrix });
    }
    for (const list of byModule.values()) entries.push(...list);

    this.set = new InstancedSet(buildRailGeometry(), materials.rail, entries, 'handrails');
    this.group.add(this.set.mesh);
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    this.set.setVisible(visible);
  }

  dispose(): void {
    this.group.remove(this.set.mesh);
    this.set.dispose();
  }
}
