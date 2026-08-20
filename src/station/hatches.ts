/**
 * Hatches (DESIGN.md §2 ports, §5 the alien opens them, §8 they occlude sound;
 * asset bible ISS-STR-06, plus ISS-GRV-09 and ISS-GRV-10 which live on the same
 * frame).
 *
 * One physical door per LINKED port pair — both `Port.hatch` records describe
 * the same slab of metal, so rendering one per port would z-fight and, worse,
 * would let the two sides disagree on screen. The owner is whichever side sorts
 * first by `portKey`, and it reads its state from the layout.
 *
 * THREE STATES, READABLE ACROSS A MODULE, AND NOT BY COLOUR ALONE:
 *
 *   open    door swung back against the far bulkhead, lamp green
 *   closed  door shut, lamp dark slate
 *   sealed  door shut AND a dogging spider clamped across it, lamp red
 *
 * §5 is why the geometry carries it: the alien opens a CLOSED hatch in 3 s at
 * loudness 45 and never a SEALED one, so mistaking one for the other is a death.
 * A lamp is a few pixels at 8 m; four bars of steel across a doorway is a
 * silhouette. The lamp is the confirmation, not the message.
 *
 * The cycle animates over `HATCH_OPEN_TIME` (3.0 s, §14) — the same three
 * seconds the alien spends opening one. Seeing a door swing is the visual half
 * of "you hear it coming" (§5).
 *
 * WHY EVERYTHING HERE IS INSTANCED
 * --------------------------------
 * There are nine doors and the old build gave each one its own frame mesh, door
 * mesh, lamp and four bolt meshes: three draw calls per hatch shut, seven
 * sealed, and a two-hop view holds five or six hatches. This art pass roughly
 * triples the geometry in a hatch (a frame that follows the doorway's real
 * outline, dogs, a window, a handwheel, a coaming and a mode marker) and pays
 * for it by making every part ONE `InstancedMesh` with a slot per hatch —
 * `HatchSlots` below. Nine hatches now cost about nine draw calls between them
 * instead of nine each, so the whole family is CHEAPER than what it replaces.
 *
 * The moving parts are moving instance matrices, which is a `Matrix4` compose
 * and a 16-float write per animating door — no geometry is created after boot.
 */

import * as THREE from 'three';
import { HATCH_OPEN_TIME } from '@shared/constants';
import type {
  GravityMode,
  ModuleId,
  Port,
  PortId,
  StationLayout,
  StationModule,
} from '@shared/types';
import { localDirToWorld, localToWorld } from '@shared/graph/math';
import { portKey } from '@shared/graph/moduleGraph';
import { buildHatchGeometry, HATCH_HINGE_X } from './geometry';
import type { HatchGeometry } from './geometry';
import { KIT, PORT_RADIUS } from './kit';
import type { StationMaterials } from './materials';
import { toVector3 } from './threeUtil';

/**
 * Radians the door swings back when fully open.
 *
 * Ninety, not the 105 this used to be, and the 15° matter. A 1.31 m slab hinged
 * 0.72 m off the axis reaches 1.375 m from its hinge; at 90° that is flat against
 * the bulkhead and 0.98 m from the module axis, which fits inside the kit's
 * narrowest bore (a 1.0 m straight) with 2 cm to spare. Past 90° the slab
 * over-rotates and its outer rim swings back INTO the wall — measured 1.18 m at
 * 105°, so both of tube-spine's open doors had their edges buried in the hull.
 * Flat against the wall is also what an open hatch actually looks like.
 */
const OPEN_ANGLE = Math.PI / 2;
/** Seconds for the dogging spider to drive or retract. */
const BOLT_TIME = 0.4;
/** How far the spider is turned back when a hatch is not sealed. The mesh is
 *  hidden below `SEAL_SHOW`, so this is what you see it turn THROUGH. */
const SEAL_TURN = Math.PI / 4;
const SEAL_SHOW = 0.02;

export type HatchVisualState = 'open' | 'closed' | 'sealed';

export interface HatchView {
  /** `${module}:${port}` of the owning side — also the §7 `HatchSnapshot.portId`. */
  key: string;
  module: ModuleId;
  port: PortId;
  /** The far side of the same door. */
  otherModule: ModuleId;
  otherPort: PortId;
  /** World transform of the port: +Z is the outward normal, +Y is up. */
  matrix: THREE.Matrix4;
  /** This hatch's slot in every instanced set. */
  slot: number;
  state: HatchVisualState;
  /** 0 = shut, 1 = swung fully open. */
  progress: number;
  target: number;
  bolt: number;
  boltTarget: number;
  /** Gravity of the module each FACE advertises — the near face shows the room
   *  you would be walking into (ISS-GRV-09). Cached so the per-frame poll only
   *  repacks when a mode actually changes. */
  nearMode: GravityMode;
  farMode: GravityMode;
  /** True when either side of this door has a floor, so the coaming exists. */
  coaming: boolean;
}

/**
 * One `InstancedMesh` with a fixed slot per hatch.
 *
 * `InstancedSet` (props, handrails) is the wrong tool here: it groups by module
 * and repacks by module visibility, and a hatch belongs to TWO modules and moves.
 * This keeps a matrix and a visible flag per slot, and repacks the visible ones
 * to the front of the buffer on `flush()` — the same trick, keyed by slot.
 */
class HatchSlots {
  readonly mesh: THREE.InstancedMesh;
  private readonly matrices: THREE.Matrix4[];
  private readonly shown: boolean[];
  private dirty = true;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    slots: number,
    name: string,
    castShadow = false,
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, slots));
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = castShadow;
    if (!castShadow) this.mesh.userData.noShadow = true;
    this.matrices = Array.from({ length: slots }, () => new THREE.Matrix4());
    this.shown = new Array<boolean>(slots).fill(false);
  }

  set(slot: number, matrix: THREE.Matrix4): void {
    const m = this.matrices[slot];
    if (!m) return;
    m.copy(matrix);
    this.dirty = true;
  }

  show(slot: number, visible: boolean): void {
    if (slot < 0 || slot >= this.shown.length || this.shown[slot] === visible) return;
    this.shown[slot] = visible;
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const target = this.mesh.instanceMatrix.array as Float32Array;
    let cursor = 0;
    for (let i = 0; i < this.matrices.length; i++) {
      if (!this.shown[i]) continue;
      (this.matrices[i] as THREE.Matrix4).toArray(target, cursor * 16);
      cursor++;
    }
    this.mesh.count = cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    // The bounds describe whatever is packed at the front of the buffer, which
    // is exactly what will be drawn — a stale sphere here would cull a doorway.
    if (cursor === 0) {
      const sphere = this.mesh.boundingSphere ?? new THREE.Sphere();
      sphere.makeEmpty();
      this.mesh.boundingSphere = sphere;
    } else {
      this.mesh.computeBoundingSphere();
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

export class StationHatches {
  readonly group = new THREE.Group();
  readonly views: HatchView[] = [];
  private readonly byKey = new Map<string, HatchView>();
  private readonly animating = new Set<HatchView>();
  private readonly moduleById = new Map<ModuleId, StationModule>();
  private readonly sets: HatchSlots[] = [];
  private visible: ReadonlySet<ModuleId> | null = null;

  private readonly frames: HatchSlots;
  private readonly doors: HatchSlots;
  private readonly panes: HatchSlots;
  private readonly seals: HatchSlots;
  private readonly coamings: HatchSlots;
  /** One set per mode, two slots per hatch (near face, far face). */
  private readonly markers: Record<GravityMode, HatchSlots>;
  /** One set per lamp state; a hatch's slot lights up in exactly one of them. */
  private readonly lamps: Record<HatchVisualState, HatchSlots>;

  private readonly scratch = new THREE.Matrix4();
  private readonly spin = new THREE.Matrix4();
  private readonly hinge = new THREE.Matrix4().makeTranslation(HATCH_HINGE_X, 0, 0);
  private readonly flip = new THREE.Matrix4().makeRotationY(Math.PI);

  constructor(
    private readonly layout: StationLayout,
    private readonly materials: StationMaterials,
  ) {
    this.group.name = 'station-hatches';
    for (const module of layout.modules) this.moduleById.set(module.id, module);
    const geo = buildHatchGeometry();

    // Own the doors first: every instanced set is sized by how many there are.
    const owned: Array<{ module: StationModule; port: PortId; other: ModuleId; otherPort: PortId }> = [];
    for (const module of layout.modules) {
      for (const port of module.ports) {
        if (!port.link) continue; // unlinked ports are capped by the module shell
        const key = portKey(module.id, port.id);
        const otherKey = portKey(port.link.module, port.link.port);
        if (otherKey < key) continue; // the far side owns this door
        owned.push({
          module,
          port: port.id,
          other: port.link.module,
          otherPort: port.link.port,
        });
      }
    }
    const n = owned.length;

    this.frames = this.add(new HatchSlots(geo.frame, materials.frame, n, 'hatch-frames', true));
    this.doors = this.add(new HatchSlots(geo.door, materials.door, n, 'hatch-doors', true));
    this.panes = this.add(new HatchSlots(geo.pane, materials.screen, n, 'hatch-panes'));
    this.seals = this.add(new HatchSlots(geo.seal, materials.frame, n, 'hatch-seals', true));
    this.coamings = this.add(new HatchSlots(geo.coaming, materials.hazard, n, 'hatch-coamings', true));
    this.markers = {
      nominal: this.add(
        new HatchSlots(
          geo.markerNominal,
          materials.createModeMarkerMaterial('nominal'),
          n * 2,
          'hatch-mode-nominal',
        ),
      ),
      zero: this.add(
        new HatchSlots(
          geo.markerZero,
          materials.createModeMarkerMaterial('zero'),
          n * 2,
          'hatch-mode-zero',
        ),
      ),
    };
    this.lamps = {
      open: this.add(
        new HatchSlots(geo.indicator.clone(), materials.indicatorOpen, n, 'hatch-lamp-open'),
      ),
      closed: this.add(
        new HatchSlots(geo.indicator.clone(), materials.indicatorClosed, n, 'hatch-lamp-closed'),
      ),
      sealed: this.add(
        new HatchSlots(geo.indicator, materials.indicatorSealed, n, 'hatch-lamp-sealed'),
      ),
    };

    for (let slot = 0; slot < owned.length; slot++) {
      const o = owned[slot] as (typeof owned)[number];
      this.views.push(this.buildView(o.module, o.port, o.other, o.otherPort, slot));
    }
    for (const view of this.views) {
      this.byKey.set(view.key, view);
      this.byKey.set(portKey(view.otherModule, view.otherPort), view);
    }

    this.buildOuterDoors(geo);
    this.syncAll(true);
    // Nothing has told us what is visible yet, and an empty frame reads as a
    // crash: show every hatch until the culler's first update, exactly as
    // `Station`'s constructor does for the module groups.
    this.setVisible(new Set(this.moduleById.keys()));
  }

  /** Re-read every hatch from the layout. `immediate` skips the animation. */
  syncAll(immediate = false): void {
    for (const view of this.views) this.syncView(view, immediate);
    this.flush();
  }

  /** Re-read one hatch after the authoritative state changed. */
  sync(module: ModuleId, port: PortId, immediate = false): void {
    const view = this.byKey.get(portKey(module, port));
    if (!view) return;
    this.syncView(view, immediate);
    this.flush();
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
    // The mode markers are polled here rather than pushed, and that is not
    // laziness: `StationGravity` writes gravity straight onto the layout objects
    // (§4 — "every consumer that reads the layout live sees the change"), and a
    // gravity failure is announced 2.5 s ahead as a FAIRNESS guarantee. A marker
    // that only caught up on the next module transition would break that
    // promise. Nine hatches, two enum compares each.
    for (const view of this.views) this.syncModes(view);

    if (this.animating.size > 0) {
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
    this.flush();
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    this.visible = visible;
    for (const view of this.views) this.applyVisibility(view);
    this.flush();
  }

  dispose(): void {
    for (const set of this.sets) {
      this.group.remove(set.mesh);
      set.dispose();
    }
    this.sets.length = 0;
    this.views.length = 0;
    this.byKey.clear();
    this.animating.clear();
  }

  // -------------------------------------------------------------------------

  private add(set: HatchSlots): HatchSlots {
    this.sets.push(set);
    this.group.add(set.mesh);
    return set;
  }

  private flush(): void {
    for (const set of this.sets) set.flush();
  }

  /**
   * The world transform of a port: +Z along the outward normal, +Y up.
   *
   * Built from an explicit basis rather than the shortest rotation from +Z.
   * Every hatch in the level is on a horizontal port, where the two agree — but
   * the kit's node has vertical ports too, and `setFromUnitVectors` picks an
   * arbitrary roll for those, which would land the coaming on the wall and the
   * mode marker on the ceiling the first time a level links one.
   */
  private portMatrix(module: StationModule, port: Port): THREE.Matrix4 {
    const origin = toVector3(localToWorld(port.localPos, module.transform));
    const fwd = toVector3(localDirToWorld(port.localDir, module.transform)).normalize();
    const reference = Math.abs(fwd.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(reference, fwd).normalize();
    const up = new THREE.Vector3().crossVectors(fwd, right).normalize();
    return new THREE.Matrix4().makeBasis(right, up, fwd).setPosition(origin);
  }

  /** Does this module have a floor to step off? `piece.deck` is the kit's
   *  answer, `module.gravity` the level's. */
  private hasDeck(id: ModuleId): boolean {
    const module = this.moduleById.get(id);
    if (!module) return false;
    return module.gravity !== 'zero' && KIT[module.kind].deck !== null;
  }

  private buildView(
    module: StationModule,
    portId: PortId,
    otherModule: ModuleId,
    otherPort: PortId,
    slot: number,
  ): HatchView {
    const port = module.ports.find((p) => p.id === portId);
    if (!port) throw new Error(`hatch: '${module.id}' has no port '${portId}'`);

    const matrix = this.portMatrix(module, port);
    const view: HatchView = {
      key: portKey(module.id, portId),
      module: module.id,
      port: portId,
      otherModule,
      otherPort,
      matrix,
      slot,
      state: 'closed',
      progress: 0,
      target: 0,
      bolt: 0,
      boltTarget: 0,
      // Read straight away rather than defaulted: the first frame of the round
      // must already say which side of this door has a floor.
      nearMode: this.moduleById.get(otherModule)?.gravity ?? 'nominal',
      farMode: module.gravity,
      // A coaming is a step off a floor. Two zero-G modules joined to each other
      // have no floor on either side, and a threshold lip there would be a
      // hazard stripe around nothing.
      coaming: this.hasDeck(module.id) || this.hasDeck(otherModule),
    };

    this.frames.set(slot, matrix);
    if (view.coaming) this.coamings.set(slot, matrix);
    for (const state of ['open', 'closed', 'sealed'] as const) {
      this.lamps[state].set(slot, matrix);
    }
    // The mode marker's geometry is ONE glyph, on the far face. The near face is
    // the same glyph turned about +Y, which mirrors it in x and z — so both
    // plaques land on the RIGHT of whoever is walking toward the door.
    this.scratch.multiplyMatrices(matrix, this.flip);
    for (const mode of ['nominal', 'zero'] as const) {
      this.markers[mode].set(slot * 2, this.scratch);
      this.markers[mode].set(slot * 2 + 1, matrix);
    }
    this.applyPose(view);
    return view;
  }

  /**
   * ISS-STR-04, and the one asset in this file that never moves.
   *
   * An airlock's outer port is authored `outerPorts` in the kit and is never
   * linked by a level, so it has no `HatchView` and no state: it is a wall with
   * vacuum behind it. It gets its own two slots — the heavy door and its hazard
   * banding — placed off the same port transform as everything else here, so
   * "the outer door reads as a threat" is a silhouette that lines up with the
   * armoured blank `geometry.ts` capped the port with.
   */
  private buildOuterDoors(geo: HatchGeometry): void {
    const entries: Array<{ module: StationModule; port: Port }> = [];
    for (const module of this.layout.modules) {
      const outer = KIT[module.kind].outerPorts;
      if (!outer) continue;
      for (const port of module.ports) {
        if (port.link || !outer.includes(port.id)) continue;
        entries.push({ module, port });
      }
    }
    if (entries.length === 0) return;
    const door = this.add(
      new HatchSlots(geo.outerDoor, this.materials.frame, entries.length, 'hatch-outer-door', true),
    );
    const hazard = this.add(
      new HatchSlots(geo.outerHazard, this.materials.hazard, entries.length, 'hatch-outer-hazard', true),
    );
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as (typeof entries)[number];
      const matrix = this.portMatrix(e.module, e.port);
      door.set(i, matrix);
      hazard.set(i, matrix);
      // An outer door is not culled with a neighbour — there is nothing on the
      // other side of it — so it follows its own module and nothing else.
      this.outerSlots.push({ module: e.module.id, slot: i, door, hazard });
    }
  }

  private readonly outerSlots: Array<{
    module: ModuleId;
    slot: number;
    door: HatchSlots;
    hazard: HatchSlots;
  }> = [];

  private syncView(view: HatchView, immediate: boolean): void {
    const module = this.moduleById.get(view.module);
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
    if (immediate) {
      view.progress = view.target;
      view.bolt = view.boltTarget;
      this.animating.delete(view);
    } else if (view.progress !== view.target || view.bolt !== view.boltTarget) {
      this.animating.add(view);
    }
    this.applyPose(view);
    this.applyVisibility(view);
  }

  /** Push a view's animation state into its instance matrices. */
  private applyPose(view: HatchView): void {
    this.spin.makeRotationY(-view.progress * OPEN_ANGLE);
    this.scratch.multiplyMatrices(view.matrix, this.hinge).multiply(this.spin);
    this.doors.set(view.slot, this.scratch);
    this.panes.set(view.slot, this.scratch);
    // The spider turns as it drives, so sealing LOOKS like a mechanism locking
    // rather than a decal appearing.
    this.spin.makeRotationZ((1 - view.bolt) * SEAL_TURN);
    this.scratch.multiplyMatrices(view.matrix, this.spin);
    this.seals.set(view.slot, this.scratch);
    this.seals.show(view.slot, view.bolt > SEAL_SHOW && this.isShown(view));
  }

  /** Re-read the two modules' CURRENT gravity and move the marker instances. */
  private syncModes(view: HatchView): void {
    const near = this.moduleById.get(view.otherModule)?.gravity ?? 'nominal';
    const far = this.moduleById.get(view.module)?.gravity ?? 'nominal';
    if (near === view.nearMode && far === view.farMode) return;
    view.nearMode = near;
    view.farMode = far;
    this.applyVisibility(view);
  }

  private isShown(view: HatchView): boolean {
    if (!this.visible) return true;
    return this.visible.has(view.module) || this.visible.has(view.otherModule);
  }

  private applyVisibility(view: HatchView): void {
    const shown = this.isShown(view);
    const slot = view.slot;
    this.frames.show(slot, shown);
    this.doors.show(slot, shown);
    this.panes.show(slot, shown);
    this.coamings.show(slot, shown && view.coaming);
    this.seals.show(slot, shown && view.bolt > SEAL_SHOW);
    for (const state of ['open', 'closed', 'sealed'] as const) {
      this.lamps[state].show(slot, shown && view.state === state);
    }
    for (const mode of ['nominal', 'zero'] as const) {
      this.markers[mode].show(slot * 2, shown && view.nearMode === mode);
      this.markers[mode].show(slot * 2 + 1, shown && view.farMode === mode);
    }
    for (const outer of this.outerSlots) {
      const on = !this.visible || this.visible.has(outer.module);
      outer.door.show(outer.slot, on);
      outer.hazard.show(outer.slot, on);
    }
  }
}

function approach(value: number, target: number, step: number): number {
  if (value === target) return target;
  const delta = target - value;
  if (Math.abs(delta) <= step) return target;
  return value + Math.sign(delta) * step;
}

/** Re-exported so a caller reasoning about doorway clearance does not have to
 *  guess which radius this file used. `collision.ts` and `hatchBarrier.ts` block
 *  on exactly this. */
export { PORT_RADIUS };
