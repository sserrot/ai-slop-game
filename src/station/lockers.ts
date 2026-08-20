/**
 * Lockers — the station's interactable containers (DESIGN.md §5, §11).
 *
 * The breaker card, the three replacement fuses and the two decoys all spawn in
 * these, which is what turns §11 puzzle 4 into pure traversal and makes a decoy
 * worth crossing the station for. They get individual meshes rather than joining
 * the instanced decor because each one animates its door and each one carries
 * per-instance state the §4 interaction raycaster has to resolve.
 *
 * Nine lockers, so nine extra draw calls — and only the ones inside the two-hop
 * cull set are ever submitted.
 */

import * as THREE from 'three';
import type { ModuleId, PropRef, StationLayout } from '@shared/types';
import { buildLockerParts } from './geometry';
import { PROP_ARCHETYPES } from './kit';
import type { StationMaterials } from './materials';
import type { StationItem } from './lockerContents';
import { moduleMatrix, propMatrix } from './threeUtil';

/** Radians the door swings when opened. */
const DOOR_ANGLE = (100 * Math.PI) / 180;
/** Seconds for the door to swing. Quiet, quick — opening a locker is not a
 *  puzzle, finding the right one is. */
const DOOR_TIME = 0.45;

export interface StationInteractable {
  type: 'locker' | 'panel';
  id: string;
  module: ModuleId;
}

export interface Locker {
  id: string;
  module: ModuleId;
  group: THREE.Group;
  pivot: THREE.Group;
  /** World position of the locker's face — what the raycaster and the audio
   *  panner both want. */
  worldPosition: THREE.Vector3;
  open: boolean;
  /** True once a player has looked inside, whatever was in it. */
  searched: boolean;
  contents: StationItem[];
  progress: number;
  target: number;
}

export class StationLockers {
  readonly group = new THREE.Group();
  readonly lockers = new Map<string, Locker>();
  /** Hand this to the §4 interaction raycaster. */
  readonly interactables: THREE.Object3D[] = [];
  private readonly animating = new Set<Locker>();

  constructor(layout: StationLayout, materials: StationMaterials) {
    this.group.name = 'station-lockers';
    const parts = buildLockerParts();
    const size = PROP_ARCHETYPES.locker.size;

    for (const module of layout.modules) {
      const mMatrix = moduleMatrix(module);
      for (const prop of module.props) {
        if (prop.kind !== 'locker') continue;
        const locker = this.buildLocker(module.id, prop, parts, materials, size, mMatrix);
        this.lockers.set(locker.id, locker);
        this.interactables.push(locker.group);
        this.group.add(locker.group);
      }
    }
    parts.body.dispose();
    parts.door.dispose();
  }

  /** Load a round's item plan (see `planLockerContents`). */
  setContents(plan: ReadonlyMap<string, StationItem[]>): void {
    for (const locker of this.lockers.values()) {
      locker.contents = [...(plan.get(locker.id) ?? [])];
      locker.searched = false;
    }
  }

  /** Swing a locker open. Returns what was inside (and empties it). */
  open(id: string): StationItem[] {
    const locker = this.lockers.get(id);
    if (!locker) return [];
    locker.open = true;
    locker.searched = true;
    locker.target = 1;
    this.animating.add(locker);
    const items = locker.contents;
    locker.contents = [];
    return items;
  }

  close(id: string): void {
    const locker = this.lockers.get(id);
    if (!locker) return;
    locker.open = false;
    locker.target = 0;
    this.animating.add(locker);
  }

  /** Resolve a raycast hit (or any descendant) back to its locker. */
  resolve(object: THREE.Object3D | null): Locker | null {
    let cursor: THREE.Object3D | null = object;
    while (cursor) {
      const tag = cursor.userData.station as StationInteractable | undefined;
      if (tag && tag.type === 'locker') return this.lockers.get(tag.id) ?? null;
      cursor = cursor.parent;
    }
    return null;
  }

  tick(dt: number): void {
    if (this.animating.size === 0) return;
    const step = dt / DOOR_TIME;
    for (const locker of [...this.animating]) {
      const delta = locker.target - locker.progress;
      locker.progress =
        Math.abs(delta) <= step ? locker.target : locker.progress + Math.sign(delta) * step;
      locker.pivot.rotation.z = locker.progress * DOOR_ANGLE;
      if (locker.progress === locker.target) this.animating.delete(locker);
    }
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    for (const locker of this.lockers.values()) {
      locker.group.visible = visible.has(locker.module);
    }
  }

  dispose(): void {
    for (const locker of this.lockers.values()) {
      locker.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      this.group.remove(locker.group);
    }
    this.lockers.clear();
    this.interactables.length = 0;
    this.animating.clear();
  }

  private buildLocker(
    module: ModuleId,
    prop: PropRef,
    parts: { body: THREE.BufferGeometry; door: THREE.BufferGeometry },
    materials: StationMaterials,
    size: { x: number; y: number; z: number },
    mMatrix: THREE.Matrix4,
  ): Locker {
    const group = new THREE.Group();
    group.name = `locker-${prop.id}`;
    group.applyMatrix4(mMatrix.clone().multiply(propMatrix(prop)));

    const body = new THREE.Mesh(parts.body.clone(), materials.locker);
    body.receiveShadow = true;
    group.add(body);

    const pivot = new THREE.Group();
    pivot.position.set(-(size.x - 0.04) / 2, size.y / 2 + 0.02, 0);
    const door = new THREE.Mesh(parts.door.clone(), materials.lockerDoor);
    door.castShadow = true;
    pivot.add(door);
    group.add(pivot);

    const tag: StationInteractable = { type: 'locker', id: prop.id, module };
    group.userData.station = tag;
    body.userData.station = tag;
    door.userData.station = tag;

    return {
      id: prop.id,
      module,
      group,
      pivot,
      worldPosition: new THREE.Vector3().setFromMatrixPosition(group.matrix),
      open: false,
      searched: false,
      contents: [],
      progress: 0,
      target: 0,
    };
  }
}
