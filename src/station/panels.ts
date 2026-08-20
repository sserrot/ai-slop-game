/**
 * In-world puzzle panels (DESIGN.md §6, §11).
 *
 * "Puzzle panels rendered in-world — but as `CanvasTexture`, not
 * render-to-texture of a second 3D scene… update at 10 Hz only while a player is
 * in the module." — §6
 *
 * The station owns the physical panel: a box on a wall with a flat screen face
 * and its own material, placed where §11 says the puzzle lives. It does not own
 * what is drawn on it. The puzzle/UI code calls `setTexture()` with its
 * CanvasTexture and drives its own 10 Hz redraw; `moduleVisible` tells it
 * whether anyone can see it.
 */

import * as THREE from 'three';
import type { ModuleId, PropRef, StationLayout } from '@shared/types';
import { buildPanelParts } from './geometry';
import type { StationMaterials } from './materials';
import type { StationInteractable } from './lockers';
import { moduleMatrix, propMatrix } from './threeUtil';

export interface StationPanel {
  /** PropRef id, e.g. 'node-beta-panel-breaker'. */
  id: string;
  module: ModuleId;
  group: THREE.Group;
  /** The flat face. Assign a CanvasTexture to its material's `map`. */
  screen: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  worldPosition: THREE.Vector3;
  /** World-space normal of the screen — face a player toward this. */
  worldNormal: THREE.Vector3;
  /** True while the panel's module is inside the render set (§6's 10 Hz gate). */
  moduleVisible: boolean;
  setTexture(texture: THREE.Texture | null): void;
}

export class StationPanels {
  readonly group = new THREE.Group();
  readonly panels = new Map<string, StationPanel>();
  readonly interactables: THREE.Object3D[] = [];

  constructor(layout: StationLayout, materials: StationMaterials) {
    this.group.name = 'station-panels';
    const parts = buildPanelParts();

    for (const module of layout.modules) {
      const mMatrix = moduleMatrix(module);
      for (const prop of module.props) {
        if (prop.kind !== 'panel') continue;
        const panel = this.buildPanel(module.id, prop, parts, materials, mMatrix);
        this.panels.set(panel.id, panel);
        this.interactables.push(panel.group);
        this.group.add(panel.group);
      }
    }
    parts.body.dispose();
    parts.screen.dispose();
  }

  /** Every panel in one module — what a puzzle handler asks for. */
  inModule(module: ModuleId): StationPanel[] {
    return [...this.panels.values()].filter((p) => p.module === module);
  }

  /** Panels whose id contains `role`, e.g. 'undock' → the three finale levers. */
  byRole(role: string): StationPanel[] {
    return [...this.panels.values()].filter((p) => p.id.includes(role));
  }

  resolve(object: THREE.Object3D | null): StationPanel | null {
    let cursor: THREE.Object3D | null = object;
    while (cursor) {
      const tag = cursor.userData.station as StationInteractable | undefined;
      if (tag && tag.type === 'panel') return this.panels.get(tag.id) ?? null;
      cursor = cursor.parent;
    }
    return null;
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    for (const panel of this.panels.values()) {
      panel.moduleVisible = visible.has(panel.module);
      panel.group.visible = panel.moduleVisible;
    }
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      panel.material.dispose();
      this.group.remove(panel.group);
    }
    this.panels.clear();
    this.interactables.length = 0;
  }

  private buildPanel(
    module: ModuleId,
    prop: PropRef,
    parts: { body: THREE.BufferGeometry; screen: THREE.BufferGeometry },
    materials: StationMaterials,
    mMatrix: THREE.Matrix4,
  ): StationPanel {
    const group = new THREE.Group();
    group.name = `panel-${prop.id}`;
    group.applyMatrix4(mMatrix.clone().multiply(propMatrix(prop)));

    const body = new THREE.Mesh(parts.body.clone(), materials.panel);
    group.add(body);

    const material = materials.panelScreen.clone();
    const screen = new THREE.Mesh(parts.screen.clone(), material);
    group.add(screen);

    const tag: StationInteractable = { type: 'panel', id: prop.id, module };
    group.userData.station = tag;
    body.userData.station = tag;
    screen.userData.station = tag;

    const panel: StationPanel = {
      id: prop.id,
      module,
      group,
      screen,
      material,
      worldPosition: new THREE.Vector3().setFromMatrixPosition(group.matrix),
      // The screen faces the prop's local +Y, which kit.ts points into the room.
      worldNormal: new THREE.Vector3(0, 1, 0).applyQuaternion(group.quaternion).normalize(),
      moduleVisible: true,
      setTexture(texture: THREE.Texture | null) {
        material.map = texture;
        material.color.setHex(texture ? 0xffffff : 0x0b2a33);
        material.needsUpdate = true;
      },
    };
    return panel;
  }
}
