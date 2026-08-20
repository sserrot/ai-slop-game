/**
 * The loader (DESIGN.md §2).
 *
 * Reads a `StationLayout`, instantiates a kit piece at each module's transform,
 * merges each module's geometry into one mesh per material, and bakes the whole
 * station into a single static BVH. What comes out is a `THREE.Group` you add
 * to the scene and a per-module view the culler can switch on and off.
 *
 * Draw-call budget per module: hull + trim (+ glass in the cupola) + strips —
 * three or four, times however many modules survive the two-hop cull. Props and
 * handrails are instanced station-wide (see `props.ts` / `handrails.ts`).
 */

import * as THREE from 'three';
import type {
  GravityMode,
  LightingLevel,
  ModuleId,
  StationLayout,
  StationModule,
} from '@shared/types';
import { KIT } from './kit';
import { buildModuleShell, mergeAndDispose, toCollisionGeometry } from './geometry';
import { buildStationCollider } from './collision';
import type { StationCollider } from './collision';
import type { StationMaterials } from './materials';
import { moduleMatrix } from './threeUtil';

export interface ModuleView {
  id: ModuleId;
  module: StationModule;
  group: THREE.Group;
  /** This module's own light-strip material — `setLighting` writes to it. */
  stripMaterial: THREE.MeshStandardMaterial | null;
  /**
   * This module's own deck-edge material — `StationGravity` writes to it, which
   * is the whole of the pivot's visual state. There is nothing to rebuild when a
   * module loses its floor: the deck is still there (the PLANT failed, §4), so
   * the only thing that changes is what the rim of it is doing.
   */
  edgeMaterial: THREE.MeshStandardMaterial | null;
  lighting: LightingLevel;
  /** Live locomotion regime. Mirrors `module.gravity`, which mutates in place. */
  gravity: GravityMode;
}

export interface StationScene {
  group: THREE.Group;
  modules: Map<ModuleId, ModuleView>;
  collider: StationCollider;
}

export function buildStationScene(
  layout: StationLayout,
  materials: StationMaterials,
): StationScene {
  const group = new THREE.Group();
  group.name = 'station-shell';
  const modules = new Map<ModuleId, ModuleView>();
  const collisionParts: THREE.BufferGeometry[] = [];

  for (const module of layout.modules) {
    const piece = KIT[module.kind];
    const shell = buildModuleShell(module, piece);
    const matrix = moduleMatrix(module);

    const view: ModuleView = {
      id: module.id,
      module,
      group: new THREE.Group(),
      stripMaterial: null,
      edgeMaterial: null,
      lighting: module.lighting,
      gravity: module.gravity,
    };
    view.group.name = `module-${module.id}`;
    view.group.applyMatrix4(matrix);

    const hull = mergeAndDispose(shell.hull);
    if (hull) {
      const mesh = new THREE.Mesh(hull, materials.hull);
      mesh.name = `${module.id}-hull`;
      mesh.receiveShadow = true;
      view.group.add(mesh);
    }
    const trim = mergeAndDispose(shell.trim);
    if (trim) {
      const mesh = new THREE.Mesh(trim, materials.trim);
      mesh.name = `${module.id}-trim`;
      mesh.receiveShadow = true;
      view.group.add(mesh);
    }
    const glass = mergeAndDispose(shell.glass);
    if (glass) {
      const mesh = new THREE.Mesh(glass, materials.glass);
      mesh.name = `${module.id}-glass`;
      view.group.add(mesh);
    }
    const strips = mergeAndDispose(shell.strips);
    if (strips) {
      view.stripMaterial = materials.createStripMaterial(module.lighting);
      const mesh = new THREE.Mesh(strips, view.stripMaterial);
      mesh.name = `${module.id}-strips`;
      view.group.add(mesh);
    }
    const deck = mergeAndDispose(shell.deck);
    if (deck) {
      const mesh = new THREE.Mesh(deck, materials.deck);
      mesh.name = `${module.id}-deck`;
      mesh.receiveShadow = true;
      view.group.add(mesh);
    }
    const deckEdge = mergeAndDispose(shell.deckEdge);
    if (deckEdge) {
      view.edgeMaterial = materials.createEdgeMaterial(module.gravity);
      const mesh = new THREE.Mesh(deckEdge, view.edgeMaterial);
      mesh.name = `${module.id}-deck-edge`;
      view.group.add(mesh);
    }
    const hideShells = mergeAndDispose(shell.hideShells);
    if (hideShells) {
      const mesh = new THREE.Mesh(hideShells, materials.hideShell);
      mesh.name = `${module.id}-hide-shells`;
      mesh.receiveShadow = true;
      view.group.add(mesh);
    }

    for (const part of shell.collision) {
      collisionParts.push(toCollisionGeometry(part, matrix));
      part.dispose();
    }

    group.add(view.group);
    modules.set(module.id, view);
  }

  const collider = buildStationCollider(collisionParts);
  group.add(collider.mesh);

  return { group, modules, collider };
}
