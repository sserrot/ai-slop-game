/**
 * Cargo stow — §11 puzzle 3, the one puzzle that could exist nowhere but this
 * game, and the one the pivot rescued from being the designated cut.
 *
 * "Five numbered bags float loose; each goes in its matching rack slot. They're
 * rigid bodies — push one too hard and it bounces off a bulkhead at loudness 30,
 * then keeps bouncing, and now you have five problems."
 *
 * That is a ZERO-G verb. Under gravity the bags sit on the deck and the puzzle
 * is picking things up; the reason `stowage-bay`'s module is authored `zero`
 * (§2's "a module where zero-G *is* the puzzle") is that floating bags are the
 * flagship use of the mechanic and the mechanic now has to earn its two-module
 * budget somewhere.
 *
 * This file owns BOTH halves of the pairing — the five slots and the five bags —
 * for one reason: they are colour-matched, and in near-darkness colour is the
 * only readable label a numbered bag has. One InstancedMesh has one material, so
 * `props.ts` could not have kept them in step; here the tint comes from a single
 * index and the pairing cannot drift.
 *
 * The bags are separate meshes because they are about to become Rapier bodies
 * (§1: client-authoritative, nearest player simulates). `bag(id)` hands the
 * physics owner the exact object to drive; nothing else needs to change.
 */

import * as THREE from 'three';
import type { ModuleId, PropRef, StationLayout } from '@shared/types';
import { buildPropGeometry } from './geometry';
import type { StationMaterials } from './materials';
import { moduleMatrix, propMatrix } from './threeUtil';

export interface CargoBag {
  id: string;
  module: ModuleId;
  /** 1–5, the number stencilled on it. Also indexes the tint. */
  number: number;
  mesh: THREE.Mesh;
  /** Where the level authored it. Reset targets and respawns come from here. */
  home: THREE.Vector3;
}

export interface CargoSlot {
  id: string;
  module: ModuleId;
  number: number;
  mesh: THREE.Mesh;
  /** World centre of the slot's mouth — where a bag has to end up. */
  target: THREE.Vector3;
}

/** Trailing `-<n>` on an authored id, or 0. `…-cargo-slot-3` → 3. */
function numberOf(id: string): number {
  const m = /-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

export class StationCargo {
  readonly group = new THREE.Group();
  readonly bags = new Map<string, CargoBag>();
  readonly slots = new Map<string, CargoSlot>();

  constructor(layout: StationLayout, materials: StationMaterials) {
    this.group.name = 'station-cargo';
    const bagGeometry = buildPropGeometry('cargo-bag');
    const slotGeometry = buildPropGeometry('slot');

    for (const module of layout.modules) {
      const mMatrix = moduleMatrix(module);
      for (const prop of module.props) {
        if (prop.kind !== 'cargo-bag' && prop.kind !== 'slot') continue;
        const number = numberOf(prop.id);
        const material = materials.createCargoMaterial(Math.max(0, number - 1));
        const geometry = prop.kind === 'cargo-bag' ? bagGeometry : slotGeometry;
        const mesh = new THREE.Mesh(geometry.clone(), material);
        mesh.name = prop.id;
        mesh.applyMatrix4(worldMatrix(mMatrix, prop));
        // §9 budgets one shadow map; neither of these is worth a slot in it.
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.userData.station = {
          type: prop.kind === 'cargo-bag' ? 'cargo-bag' : 'cargo-slot',
          id: prop.id,
          module: module.id,
        };
        this.group.add(mesh);

        const position = mesh.position.clone();
        if (prop.kind === 'cargo-bag') {
          this.bags.set(prop.id, {
            id: prop.id,
            module: module.id,
            number,
            mesh,
            home: position,
          });
        } else {
          this.slots.set(prop.id, {
            id: prop.id,
            module: module.id,
            number,
            mesh,
            target: position,
          });
        }
      }
    }
    bagGeometry.dispose();
    slotGeometry.dispose();
  }

  get size(): number {
    return this.bags.size;
  }

  bag(id: string): CargoBag | undefined {
    return this.bags.get(id);
  }

  slot(id: string): CargoSlot | undefined {
    return this.slots.get(id);
  }

  /** Put every bag back where the level authored it. */
  reset(): void {
    for (const bag of this.bags.values()) {
      bag.mesh.position.copy(bag.home);
      bag.mesh.updateMatrix();
    }
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    for (const bag of this.bags.values()) bag.mesh.visible = visible.has(bag.module);
    for (const slot of this.slots.values()) slot.mesh.visible = visible.has(slot.module);
  }

  dispose(): void {
    for (const bag of this.bags.values()) bag.mesh.geometry.dispose();
    for (const slot of this.slots.values()) slot.mesh.geometry.dispose();
    this.bags.clear();
    this.slots.clear();
    this.group.clear();
  }
}

function worldMatrix(moduleMatrix4: THREE.Matrix4, prop: PropRef): THREE.Matrix4 {
  return moduleMatrix4.clone().multiply(propMatrix(prop));
}
