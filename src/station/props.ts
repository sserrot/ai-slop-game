/**
 * Instanced station decor (DESIGN.md §9).
 *
 * Racks, cable bundles, stowage bags, laptops on arms, cargo slots and the node
 * hub balls all come from `PropRef`s in the level file, so what you see is
 * exactly what the layout says is there — no separate decoration pass that can
 * drift from the data the alien and the noise system reason about.
 *
 * Lockers and puzzle panels are NOT here: they animate and carry per-instance
 * state, so `lockers.ts` and `panels.ts` give them their own meshes.
 */

import * as THREE from 'three';
import type { ModuleId, StationLayout } from '@shared/types';
import { propArchetype } from './kit';
import type { PropKind } from './kit';
import { buildPropGeometry } from './geometry';
import { InstancedSet } from './instancing';
import type { InstanceEntry } from './instancing';
import type { StationMaterials } from './materials';
import { propWorldMatrix } from './threeUtil';

/**
 * `slot` is NOT here: the five cargo slots are colour-coded to the five bags
 * (§11 puzzle 3), and one InstancedMesh has one material. `cargo.ts` owns both
 * halves of that pairing so the tints cannot drift apart.
 */
const INSTANCED_KINDS: PropKind[] = [
  'rack',
  'cable',
  'stowage',
  'laptop',
  'hub',
  'bulkhead',
  'bench',
  'bank',
  'cargo-rack',
];

export class StationProps {
  readonly group = new THREE.Group();
  private readonly sets: InstancedSet[] = [];

  constructor(layout: StationLayout, materials: StationMaterials) {
    this.group.name = 'station-props';
    const byKind = new Map<PropKind, InstanceEntry[]>();
    for (const kind of INSTANCED_KINDS) byKind.set(kind, []);

    const unknown = new Set<string>();
    for (const module of layout.modules) {
      for (const prop of module.props) {
        const arch = propArchetype(prop.kind);
        if (!arch) {
          unknown.add(prop.kind);
          continue;
        }
        if (!arch.instanced) continue; // lockers and panels get their own meshes
        const list = byKind.get(prop.kind as PropKind);
        if (!list) continue;
        list.push({ module: module.id, matrix: propWorldMatrix(module, prop) });
      }
    }
    if (unknown.size > 0) {
      console.warn(`station: no prop archetype for ${[...unknown].join(', ')} — not rendered`);
    }

    for (const kind of INSTANCED_KINDS) {
      const entries = byKind.get(kind) as InstanceEntry[];
      if (entries.length === 0) continue;
      const set = new InstancedSet(
        buildPropGeometry(kind),
        materialFor(materials, kind),
        entries,
        `props-${kind}`,
      );
      this.sets.push(set);
      this.group.add(set.mesh);
    }
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    for (const set of this.sets) set.setVisible(visible);
  }

  dispose(): void {
    for (const set of this.sets) {
      this.group.remove(set.mesh);
      set.dispose();
    }
    this.sets.length = 0;
  }
}

function materialFor(materials: StationMaterials, kind: PropKind): THREE.Material {
  switch (kind) {
    case 'rack':
      return materials.rack;
    case 'cable':
      return materials.cable;
    case 'stowage':
      return materials.stowage;
    case 'laptop':
      return materials.laptop;
    case 'slot':
      return materials.slot;
    case 'hub':
      return materials.hub;
    case 'bulkhead':
    case 'bench':
    case 'bank':
      return materials.furniture;
    case 'cargo-rack':
      return materials.cargoRack;
    default:
      return materials.trim;
  }
}
