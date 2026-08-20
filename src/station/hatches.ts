/**
 * Hatches (DESIGN.md §2 ports, §5 the alien opens them, §8 they occlude sound).
 *
 * One physical door per LINKED port pair — both `Port.hatch` records describe
 * the same slab of metal, so rendering one per port would z-fight and, worse,
 * would let the two sides disagree on screen. The owner is whichever side sorts
 * first by `portKey`, and it reads its state from the layout.
 *
 * Three visual states, because the player has to be able to answer "can I get
 * through, and can it?" from across a module:
 *   open    door swung back against the bulkhead, indicator green
 *   closed  door shut, indicator amber
 *   sealed  door shut, four bolts driven into the frame, indicator red
 *
 * The cycle animates over `HATCH_OPEN_TIME` (3.0s, §14) — the same three
 * seconds the alien spends opening one, at loudness 45. Seeing a door swing is
 * the visual half of "you hear it coming" (§5).
 */

import * as THREE from 'three';
import { HATCH_OPEN_TIME } from '@shared/constants';
import type { ModuleId, PortId, StationLayout, StationModule } from '@shared/types';
import { localDirToWorld, localToWorld } from '@shared/graph/math';
import { portKey } from '@shared/graph/moduleGraph';
import { buildHatchGeometry } from './geometry';
import { PORT_RADIUS } from './kit';
import type { StationMaterials } from './materials';
import { toVector3 } from './threeUtil';

/** Radians the door swings back when fully open. */
const OPEN_ANGLE = (105 * Math.PI) / 180;
/** Seconds for the seal bolts to drive or retract. */
const BOLT_TIME = 0.4;

export type HatchVisualState = 'open' | 'closed' | 'sealed';

export interface HatchView {
  /** `${module}:${port}` of the owning side — also the §7 `HatchSnapshot.portId`. */
  key: string;
  module: ModuleId;
  port: PortId;
  /** The far side of the same door. */
  otherModule: ModuleId;
  otherPort: PortId;
  group: THREE.Group;
  pivot: THREE.Group;
  indicator: THREE.Mesh;
  bolts: THREE.Mesh[];
  state: HatchVisualState;
  /** 0 = shut, 1 = swung fully open. */
  progress: number;
  target: number;
  bolt: number;
  boltTarget: number;
}

export class StationHatches {
  readonly group = new THREE.Group();
  readonly views: HatchView[] = [];
  private readonly byKey = new Map<string, HatchView>();
  private readonly animating = new Set<HatchView>();

  constructor(
    private readonly layout: StationLayout,
    private readonly materials: StationMaterials,
  ) {
    this.group.name = 'station-hatches';
    const geo = buildHatchGeometry();

    for (const module of layout.modules) {
      for (const port of module.ports) {
        if (!port.link) continue; // unlinked ports are capped by the module shell
        const key = portKey(module.id, port.id);
        const otherKey = portKey(port.link.module, port.link.port);
        if (otherKey < key) continue; // the far side owns this door

        const view = this.buildView(module, port.id, port.link.module, port.link.port, geo);
        this.views.push(view);
        this.byKey.set(key, view);
        this.byKey.set(otherKey, view);
        this.group.add(view.group);
      }
    }
    this.syncAll(true);
  }

  /** Re-read every hatch from the layout. `immediate` skips the animation. */
  syncAll(immediate = false): void {
    for (const view of this.views) this.syncView(view, immediate);
  }

  /** Re-read one hatch after the authoritative state changed. */
  sync(module: ModuleId, port: PortId, immediate = false): void {
    const view = this.byKey.get(portKey(module, port));
    if (view) this.syncView(view, immediate);
  }

  /** True while a door is still swinging — the 3s window in §5's chase loop. */
  isAnimating(module: ModuleId, port: PortId): boolean {
    const view = this.byKey.get(portKey(module, port));
    return view ? this.animating.has(view) : false;
  }

  view(module: ModuleId, port: PortId): HatchView | undefined {
    return this.byKey.get(portKey(module, port));
  }

  tick(dt: number): void {
    if (this.animating.size === 0) return;
    const doorStep = dt / HATCH_OPEN_TIME;
    const boltStep = dt / BOLT_TIME;
    for (const view of [...this.animating]) {
      view.progress = approach(view.progress, view.target, doorStep);
      view.bolt = approach(view.bolt, view.boltTarget, boltStep);
      this.applyPose(view);
      if (view.progress === view.target && view.bolt === view.boltTarget) {
        this.animating.delete(view);
      }
    }
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    for (const view of this.views) {
      view.group.visible = visible.has(view.module) || visible.has(view.otherModule);
    }
  }

  dispose(): void {
    for (const view of this.views) {
      view.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      this.group.remove(view.group);
    }
    this.views.length = 0;
    this.byKey.clear();
    this.animating.clear();
  }

  // -------------------------------------------------------------------------

  private buildView(
    module: StationModule,
    portId: PortId,
    otherModule: ModuleId,
    otherPort: PortId,
    geo: ReturnType<typeof buildHatchGeometry>,
  ): HatchView {
    const port = module.ports.find((p) => p.id === portId);
    if (!port) throw new Error(`hatch: '${module.id}' has no port '${portId}'`);

    const group = new THREE.Group();
    group.name = `hatch-${module.id}-${portId}`;
    group.position.copy(toVector3(localToWorld(port.localPos, module.transform)));
    group.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      toVector3(localDirToWorld(port.localDir, module.transform)).normalize(),
    );

    const frame = new THREE.Mesh(geo.frame.clone(), this.materials.frame);
    group.add(frame);

    const pivot = new THREE.Group();
    pivot.position.set(-(PORT_RADIUS + 0.02), 0, 0);
    const door = new THREE.Mesh(geo.door.clone(), this.materials.door);
    door.castShadow = true;
    pivot.add(door);
    group.add(pivot);

    const bolts: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const bolt = new THREE.Mesh(geo.bolt.clone(), this.materials.frame);
      bolt.rotation.z = (i * Math.PI) / 2;
      bolts.push(bolt);
      group.add(bolt);
    }

    const indicator = new THREE.Mesh(geo.indicator.clone(), this.materials.indicatorClosed);
    indicator.position.set(0, PORT_RADIUS + 0.16, 0.01);
    group.add(indicator);

    return {
      key: portKey(module.id, portId),
      module: module.id,
      port: portId,
      otherModule,
      otherPort,
      group,
      pivot,
      indicator,
      bolts,
      state: 'closed',
      progress: 0,
      target: 0,
      bolt: 0,
      boltTarget: 0,
    };
  }

  private syncView(view: HatchView, immediate: boolean): void {
    const module = this.layout.modules.find((m) => m.id === view.module);
    const port = module?.ports.find((p) => p.id === view.port);
    if (!port) return;
    const state: HatchVisualState = port.hatch.sealed
      ? 'sealed'
      : port.hatch.open
        ? 'open'
        : 'closed';
    view.state = state;
    view.target = state === 'open' ? 1 : 0;
    view.boltTarget = state === 'sealed' ? 1 : 0;
    view.indicator.material =
      state === 'open'
        ? this.materials.indicatorOpen
        : state === 'sealed'
          ? this.materials.indicatorSealed
          : this.materials.indicatorClosed;
    if (immediate) {
      view.progress = view.target;
      view.bolt = view.boltTarget;
      this.animating.delete(view);
    } else if (view.progress !== view.target || view.bolt !== view.boltTarget) {
      this.animating.add(view);
    }
    this.applyPose(view);
  }

  private applyPose(view: HatchView): void {
    view.pivot.rotation.y = -view.progress * OPEN_ANGLE;
    const reach = 0.6 + view.bolt * 0.18;
    for (let i = 0; i < view.bolts.length; i++) {
      const bolt = view.bolts[i] as THREE.Mesh;
      const angle = (i * Math.PI) / 2;
      bolt.position.set(Math.cos(angle) * reach, Math.sin(angle) * reach, 0);
      bolt.visible = view.bolt > 0.02;
    }
  }
}

function approach(value: number, target: number, step: number): number {
  if (value === target) return target;
  const delta = target - value;
  if (Math.abs(delta) <= step) return target;
  return value + Math.sign(delta) * step;
}
