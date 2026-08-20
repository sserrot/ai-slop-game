/**
 * `Station` — the whole of DESIGN.md §2 behind one object.
 *
 * It owns the level data, the two graphs every other subsystem navigates
 * (`ModuleGraph` for sound/AI/culling, `RailGraph` for grip and rail-following),
 * the renderable group, the static BVH, and the two-hop portal culler.
 *
 *     const station = await Station.load();
 *     scene.add(station.group);
 *     // once per frame:
 *     station.update(player.module, dt);
 *
 * Everything the rest of the game needs from the station is a property or a
 * method here; nothing else in `src/station/**` needs to be imported directly,
 * though it all is exported for the odd special case.
 *
 * IMPORTANT: keep `station.group` at the origin with no rotation or scale. The
 * BVH, the handrail instances and the hatch transforms are all baked in WORLD
 * space, because that is the space the module graph, the rail graph and the
 * noise system all speak.
 */

import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { CULL_HOPS } from '@shared/constants';
import type {
  GravityCause,
  GravityMode,
  GravityShiftEvent,
  HatchSnapshot,
  HideSpotKey,
  LightingLevel,
  ModuleGravitySnapshot,
  ModuleId,
  PortId,
  StationLayout,
  StationModule,
  Vec3,
} from '@shared/types';
import { v3, worldToLocalInto } from '@shared/graph/math';
import { ModuleGraph, hatchAttenuationDb, parsePortKey, portKey } from '@shared/graph/moduleGraph';
import { RailGraph } from '@shared/graph/railGraph';
import { HideSpotGraph } from '@shared/graph/hideSpots';
import type { HideVolume } from '@shared/graph/hideSpots';
import { StationCargo } from './cargo';
import { HatchBlockers } from './collision';
import type { PortDisc } from './collision';
import { PortalCuller } from './culling';
import { StationFixtures } from './fixtures';
import { StationGravity } from './gravity';
import type { GravityShift } from './gravity';
import { StationGravityPlants } from './gravityProps';
import { StationHandrails } from './handrails';
import { StationHatches } from './hatches';
import { StationItems } from './stationItems';
import type { ItemKind } from './items';
import { KIT } from './kit';
import { defaultStationLayout, fetchStationLayout } from './layout';
import { StationLockers } from './lockers';
import type { Locker } from './lockers';
import { planLockerContents } from './lockerContents';
import type { StationItem } from './lockerContents';
import { StationMaterials } from './materials';
import { buildStationScene } from './loader';
import type { ModuleView, StationScene } from './loader';
import { StationPanels } from './panels';
import type { StationPanel } from './panels';
import { StationProps } from './props';
import { toVector3 } from './threeUtil';

export interface StationOptions {
  /** Use this layout instead of the bundled `levels/station.json`. */
  layout?: StationLayout;
  /** …or fetch one from here (a level editor, or a server-chosen map). */
  url?: string;
  /** Add a dim AmbientLight to the group so nothing is ever pure black.
   *  §9 budgets "everything else is emissive strips and cheap ambient". */
  ambient?: boolean;
  /** Override the §2 two-hop render depth. Don't. */
  cullHops?: number;
  /** Seeds locker contents (§11). Pass the round seed from the server. */
  seed?: number;
  /** Throw if `ModuleGraph`/`RailGraph` report problems. Default true. */
  validate?: boolean;
}

export interface HatchChange {
  module: ModuleId;
  port: PortId;
  open: boolean;
  sealed: boolean;
}

export class Station {
  readonly layout: StationLayout;
  readonly graph: ModuleGraph;
  readonly rails: RailGraph;
  /**
   * Lockers, equipment bays and crew bunks (§4). Pure geometry — containment,
   * sweeps and distances. THERE IS NO SIGHT LOGIC HERE OR ANYWHERE, and hiding
   * does not introduce any: the alien is blind, so a hide spot is exactly two
   * things, a volume its body will not sweep through and −8 dB off everything
   * you emit inside it.
   */
  readonly hideSpots: HideSpotGraph;
  /** Per-module gravity and the visual state that follows it (§4). */
  readonly gravity: StationGravity;
  /** §11 puzzle 3's five bags and five colour-matched slots. */
  readonly cargo: StationCargo;
  readonly materials: StationMaterials;
  readonly scene: StationScene;
  readonly props: StationProps;
  readonly handrails: StationHandrails;
  readonly hatches: StationHatches;
  readonly lockers: StationLockers;
  readonly panels: StationPanels;
  /** §11's hardware — the levers, the handwheel, the needle, the red covers.
   *  Drive it from the puzzle store; `tick` animates the joints. */
  readonly fixtures: StationFixtures;
  /** ISS-GRV-11, one per node. Its rotor IS §4's 2.5 s warning clock. */
  readonly plants: StationGravityPlants;
  /** The six carryables, in the world (§5, §10, §11). */
  readonly items: StationItems;
  readonly culler: PortalCuller;
  readonly blockers: HatchBlockers;
  /** The static station BVH (§1 `three-mesh-bvh`). Sweep the §4 player sphere
   *  against this; hatch doors are handled by `blockedByHatch` instead. */
  readonly bvh: MeshBVH;
  readonly collider: THREE.Mesh;
  /** Add this to your scene. Keep it at the origin. */
  readonly group = new THREE.Group();
  /** Lockers and panels, for the §4 interaction raycaster. */
  readonly interactables: THREE.Object3D[] = [];

  /** Wire to `bus.emit('cull:changed', { visible })`. */
  onCullChanged: ((visible: readonly ModuleId[]) => void) | null = null;
  /** Wire to `bus.emit('hatch:changed', …)`. */
  onHatchChanged: ((change: HatchChange) => void) | null = null;
  /** A gravity change that has LANDED. Carries the module-centre origin and the
   *  loudness of the `gravity-shift` noise the caller should emit (§4). */
  onGravityShift: ((shift: GravityShift) => void) | null = null;
  /** A gravity change ANNOUNCED `GRAVITY_WARNING_S` ahead — the plant winding
   *  down. This is the fairness guarantee; do not skip it. */
  onGravityWarning: ((event: GravityShiftEvent) => void) | null = null;

  private readonly ambientLight: THREE.AmbientLight | null;
  /** Module-space scratch for `contains`. Never escapes the method. */
  private readonly localProbe = v3();

  constructor(layout: StationLayout, opts: StationOptions = {}) {
    this.layout = layout;
    this.graph = new ModuleGraph(layout.modules);
    this.rails = new RailGraph(this.graph);
    this.hideSpots = new HideSpotGraph(this.graph);

    if (opts.validate !== false) {
      const problems = [
        ...this.graph.validate(),
        ...this.rails.validate(),
        ...this.hideSpots.validate(),
      ];
      if (problems.length > 0) {
        throw new Error(`station layout is broken:\n  - ${problems.join('\n  - ')}`);
      }
    }

    this.group.name = 'station';
    this.materials = new StationMaterials();
    this.scene = buildStationScene(layout, this.materials);
    this.props = new StationProps(layout, this.materials);
    this.handrails = new StationHandrails(this.rails, this.materials);
    this.hatches = new StationHatches(layout, this.materials);
    this.lockers = new StationLockers(layout, this.materials);
    // `body: false` — `StationFixtures` draws the panel shell as part of its own
    // per-module merged mesh, with the bezel recess round this screen. Two
    // carcasses in one place is the only way to get this wrong.
    this.panels = new StationPanels(layout, this.materials, { body: false });
    this.fixtures = new StationFixtures(layout, this.materials);
    this.plants = new StationGravityPlants(layout, this.materials);
    this.items = new StationItems(layout, this.materials);
    this.cargo = new StationCargo(layout, this.materials);
    this.blockers = new HatchBlockers(layout);
    this.culler = new PortalCuller(this.graph, opts.cullHops ?? CULL_HOPS);
    this.gravity = new StationGravity(this.graph, this.scene.modules, this.materials);
    this.gravity.onShift = (shift) => this.onGravityShift?.(shift);
    this.gravity.onWarning = (event) => this.onGravityWarning?.(event);
    this.bvh = this.scene.collider.bvh;
    this.collider = this.scene.collider.mesh;

    this.group.add(
      this.scene.group,
      this.props.group,
      this.handrails.group,
      this.hatches.group,
      this.lockers.group,
      this.panels.group,
      this.fixtures.group,
      this.plants.group,
      this.items.group,
      this.cargo.group,
    );
    this.interactables.push(...this.lockers.interactables, ...this.panels.interactables);

    this.ambientLight = opts.ambient === false ? null : new THREE.AmbientLight(0x2a3238, 0.35);
    if (this.ambientLight) this.group.add(this.ambientLight);

    this.stockLockers(opts.seed ?? 0);
    // Show everything until the first `update(playerModule)` — an empty frame
    // reads as a crash, and the culler treats a null module as "show all".
    this.update(null);
  }

  /** Load the bundled station (or `opts.url` / `opts.layout`). */
  static async load(opts: StationOptions = {}): Promise<Station> {
    const layout = opts.layout
      ? opts.layout
      : opts.url
        ? await fetchStationLayout(opts.url)
        : defaultStationLayout();
    return new Station(layout, opts);
  }

  // -- the module list ------------------------------------------------------

  /** The `StationModule[]` the shared graph consumes. Live: hatch state on
   *  these objects is what `ModuleGraph` and the noise system read. */
  get modules(): StationModule[] {
    return this.layout.modules;
  }

  module(id: ModuleId): StationModule | undefined {
    return this.graph.get(id);
  }

  view(id: ModuleId): ModuleView | undefined {
    return this.scene.modules.get(id);
  }

  get escapeModule(): ModuleId {
    return this.layout.escapeModule;
  }

  get finaleModule(): ModuleId {
    return this.layout.finaleModule;
  }

  /** §10: never spawn a player in the escape module or the finale module. */
  spawnCandidates(): ModuleId[] {
    return this.graph
      .ids()
      .filter((id) => id !== this.layout.escapeModule && id !== this.layout.finaleModule);
  }

  // -- per-frame ------------------------------------------------------------

  /**
   * Update the two-hop render set for the module the local player is in, and
   * advance hatch/locker animations by `dt` seconds.
   *
   * Call it every frame with the player's current module; it is a no-op unless
   * the module changed or a hatch moved.
   */
  update(playerModule: ModuleId | null, dt = 0): void {
    if (this.culler.update(playerModule)) {
      this.applyVisibility();
      this.onCullChanged?.(this.culler.list);
    }
    if (dt > 0) this.tick(dt);
  }

  /** Animations and announced gravity timers. */
  tick(dt: number, serverTick = 0): void {
    this.hatches.tick(dt);
    this.lockers.tick(dt);
    this.fixtures.tick(dt);
    // §4: both sides run the timer, so the floor lets go on the frame the audio
    // said it would rather than a round trip later.
    this.gravity.tick(dt, serverTick);
    // AFTER the gravity timer, never before. §4's fairness guarantee is that the
    // rotor IS the announced countdown — sampled off `StationGravity.pending`
    // rather than eased — so it has to read the countdown this frame advanced,
    // not last frame's. Ticked the other way round it lags by a frame, which is
    // invisible at 60 fps and a fifth of the whole warning at 5.
    this.plants.tick(dt, this.gravity);
  }

  /**
   * Fill every instanced set in the station for the pre-warm's one frame.
   *
   * `Renderer.prewarm()` makes every object visible and turns frustum culling
   * off, which is the whole answer for a plain mesh and only half of it for an
   * `InstancedMesh`: a set with `count === 0` is skipped by the draw call, so its
   * vertex buffers never upload and the first frame that DOES have something to
   * put in it pays for them. Measured at boot on `levels/station.json`, six sets
   * were empty — `hatch-seals` and `hatch-lamp-sealed` (nothing starts sealed),
   * `plant-lamp-winding` (every plant starts running) and the card / fuse / decoy
   * world items (every locker starts shut). So the first seal, the first
   * announced gravity failure and the first locker each paid for an upload, at
   * three of the tensest moments the game has.
   *
   * Call it `true` immediately before `prewarm()` and `false` immediately after.
   */
  setPrewarm(on: boolean): void {
    this.hatches.setPrewarm(on);
    this.plants.setPrewarm(on);
    this.items.setPrewarm(on);
  }

  get visibleModules(): readonly ModuleId[] {
    return this.culler.list;
  }

  isVisible(id: ModuleId): boolean {
    return this.culler.visible.has(id);
  }

  // -- hatches --------------------------------------------------------------

  /**
   * Set the state of one hatch. BOTH sides of the pair are written, because
   * they are one door — then `ModuleGraph.refreshHatches()` runs, because its
   * edges cache hatch state and stale doors silently break propagation and
   * pathfinding alike.
   *
   * `sealed` implies closed (§2). Pass `immediate` to skip the 3s animation
   * (e.g. when applying a server snapshot on join).
   */
  setHatch(
    module: ModuleId,
    port: PortId,
    state: { open?: boolean; sealed?: boolean },
    immediate = false,
  ): void {
    const near = this.graph.port(module, port);
    if (!near) return;
    const sealed = state.sealed ?? near.hatch.sealed;
    const open = sealed ? false : (state.open ?? near.hatch.open);

    const sides = [{ module, port, p: near }];
    if (near.link) {
      const far = this.graph.port(near.link.module, near.link.port);
      if (far) sides.push({ module: near.link.module, port: near.link.port, p: far });
    }
    for (const side of sides) {
      side.p.hatch.open = open;
      side.p.hatch.sealed = sealed;
      side.p.hatch.attenuationDb = hatchAttenuationDb(side.p.hatch);
    }

    // §2/foundation: the graph caches hatch state on its edges.
    this.graph.refreshHatches();
    this.hatches.sync(module, port, immediate);
    this.culler.markDirty();
    this.update(this.culler.playerModule);
    for (const side of sides) {
      this.onHatchChanged?.({ module: side.module, port: side.port, open, sealed });
    }
  }

  hatchState(module: ModuleId, port: PortId): { open: boolean; sealed: boolean } | null {
    const p = this.graph.port(module, port);
    return p ? { open: p.hatch.open, sealed: p.hatch.sealed } : null;
  }

  /** True while a door is mid-swing — the ~3s window §5's chase loop buys you. */
  isHatchAnimating(module: ModuleId, port: PortId): boolean {
    return this.hatches.isAnimating(module, port);
  }

  /** Apply the server's `hatches:` array (§7) wholesale. */
  applyHatchSnapshots(snapshots: readonly HatchSnapshot[], immediate = true): void {
    for (const snap of snapshots) {
      const { module, port } = parsePortKey(snap.portId);
      this.setHatch(module, port, { open: snap.open, sealed: snap.sealed }, immediate);
    }
  }

  /** The §7 `hatches:` view of the station, one entry per port. */
  hatchSnapshots(): HatchSnapshot[] {
    const out: HatchSnapshot[] = [];
    for (const m of this.layout.modules) {
      for (const p of m.ports) {
        if (!p.link) continue;
        out.push({ portId: portKey(m.id, p.id), open: p.hatch.open, sealed: p.hatch.sealed });
      }
    }
    return out;
  }

  /** Does this movement push through a shut hatch? (§4 collision, doors only.) */
  blockedByHatch(from: Vec3, to: Vec3, radius?: number): PortDisc | null {
    return this.blockers.blocking(toVector3(from), toVector3(to), radius);
  }

  // -- gravity (§4) ---------------------------------------------------------

  /** The regime a module is in RIGHT NOW. Unknown module → `'nominal'`. */
  moduleGravity(id: ModuleId): GravityMode {
    return this.graph.gravityOf(id);
  }

  /** What the LEVEL says, ignoring anything the director has done. */
  authoredGravity(id: ModuleId): GravityMode {
    return this.graph.authoredGravity(id);
  }

  /**
   * Announce a gravity change `GRAVITY_WARNING_S` ahead.
   *
   * The route for anything a player is meant to survive (§4). `setGravity` is
   * the immediate setter and is for level load, puzzle scripting and server
   * snapshots — using it to drop a floor under somebody deletes the 2.5 s of
   * warning that is the whole reason a failure reads as dramatic and not cheap.
   */
  scheduleGravity(
    id: ModuleId,
    mode: GravityMode,
    cause: GravityCause,
    tick = 0,
    delayMs?: number,
  ): GravityShiftEvent | null {
    return this.gravity.schedule(id, mode, cause, tick, delayMs);
  }

  setGravity(id: ModuleId, mode: GravityMode, cause: GravityCause = 'puzzle'): boolean {
    return this.gravity.set(id, mode, cause);
  }

  /** Apply the server's `gravity:` array (§7) wholesale. */
  applyGravitySnapshots(
    snapshots: readonly ModuleGravitySnapshot[],
    cause: GravityCause = 'director',
  ): ModuleId[] {
    return this.gravity.applySnapshot(snapshots, cause);
  }

  /** The §7 `gravity:` view of the station. */
  gravitySnapshots(): ModuleGravitySnapshot[] {
    return this.gravity.snapshot();
  }

  /** Back to what the level authored. */
  resetGravity(): ModuleId[] {
    return this.gravity.reset();
  }

  // -- hide spots (§4) ------------------------------------------------------

  /** The spot whose entry is nearest `worldPos` and usable in this module's
   *  CURRENT gravity — the "press E to get in" query. */
  hideSpotNear(module: ModuleId, worldPos: Vec3, maxDistance: number): HideVolume | null {
    return this.hideSpots.nearestEntry(module, worldPos, maxDistance);
  }

  hideSpot(key: HideSpotKey): HideVolume | undefined {
    return this.hideSpots.volume(key);
  }

  // -- lighting -------------------------------------------------------------

  setLighting(module: ModuleId, level: LightingLevel): void {
    const view = this.scene.modules.get(module);
    const data = this.graph.get(module);
    if (!view || !data) return;
    view.lighting = level;
    data.lighting = level;
    if (view.stripMaterial) this.materials.applyLighting(view.stripMaterial, level);
  }

  lighting(module: ModuleId): LightingLevel | null {
    return this.graph.get(module)?.lighting ?? null;
  }

  /** Bring the whole station up — what "systems online" (§5, §11) looks like. */
  setAllLighting(level: LightingLevel): void {
    for (const id of this.graph.ids()) this.setLighting(id, level);
  }

  // -- lockers and panels ---------------------------------------------------

  /** Roll this round's locker contents (§5 decoys, §11 card and fuses). */
  stockLockers(seed: number): Map<string, StationItem[]> {
    const plan = planLockerContents(this.layout, seed);
    this.lockers.setContents(plan);
    // The world form of every one of them, revealed from the same plan. No
    // geometry is built here — the slots all exist from load.
    this.items.setLockerContents(plan);
    return plan;
  }

  /**
   * Swing a locker open and reveal what is in it. Returns the contents.
   *
   * Cosmetic and client-side: the SERVER owns who gets what out of a locker
   * (§7), and there is no message for the door — so this is the local feedback
   * for having pressed E on one, and the reason the item inside becomes visible
   * at all. `StationItems` gates on the door precisely so a shut steel box does
   * not show its contents, or its amber lamp, through 3 cm of plate.
   */
  openLocker(id: string): StationItem[] {
    const items = this.lockers.open(id);
    this.items.setLockerOpen(id, true);
    return items;
  }

  /** Somebody took `kind` out of that locker — or everything, if omitted. */
  takeFromLocker(id: string, kind?: ItemKind): void {
    this.items.takeFrom(id, kind);
  }

  /** Put a hide spot's lamp out while somebody is inside it (§4). Returns false
   *  if `spotId` has no lamp, so a typo reads differently from a no-op. */
  setHideSpotOccupied(spotId: string, occupied: boolean): boolean {
    return this.props.setHideSpotOccupied(spotId, occupied);
  }

  locker(id: string): Locker | undefined {
    return this.lockers.lockers.get(id);
  }

  panel(id: string): StationPanel | undefined {
    return this.panels.panels.get(id);
  }

  /** Resolve a raycast hit to whatever station thing it belongs to. */
  interactableAt(object: THREE.Object3D | null): Locker | StationPanel | null {
    return this.lockers.resolve(object) ?? this.panels.resolve(object);
  }

  // -- queries --------------------------------------------------------------

  /**
   * Which module contains a world position. Tests the kit piece's actual bounds
   * first and only falls back to nearest-centre, so a player at the far end of
   * the lab is never reported as being in the node next door — noise resolution
   * (§3) and culling both depend on this being right.
   */
  moduleAt(worldPos: Vec3, hint?: ModuleId | null): ModuleId | null {
    if (hint) {
      const hinted = this.graph.get(hint);
      if (hinted && this.contains(hinted, worldPos)) return hint;
    }
    for (const m of this.layout.modules) {
      if (this.contains(m, worldPos)) return m.id;
    }
    return this.graph.nearestModule(worldPos);
  }

  private contains(module: StationModule, worldPos: Vec3): boolean {
    const piece = KIT[module.kind];
    // `moduleAt` runs once per rendered frame and walks up to nine modules when
    // the hint misses; a fresh Vec3 per test (three, counting the intermediates
    // `worldToLocal` used to build) is pure garbage for a bounds check.
    const p = worldToLocalInto(worldPos, module.transform, this.localProbe);
    if (module.kind === 'node') {
      const h = piece.radius;
      return Math.abs(p.x) <= h && Math.abs(p.y) <= h && Math.abs(p.z) <= h;
    }
    if (module.kind === 'cupola') {
      const port = module.ports[0];
      const zMin = port ? port.localPos.z : -piece.length / 2;
      return p.z >= zMin && p.z <= zMin + 0.75 + piece.radius && Math.hypot(p.x, p.y) <= piece.radius;
    }
    return Math.abs(p.z) <= piece.length / 2 && Math.hypot(p.x, p.y) <= piece.radius;
  }

  // -- teardown -------------------------------------------------------------

  dispose(): void {
    this.cargo.dispose();
    this.props.dispose();
    this.handrails.dispose();
    this.hatches.dispose();
    this.lockers.dispose();
    this.panels.dispose();
    this.fixtures.dispose();
    this.plants.dispose();
    this.items.dispose();
    for (const view of this.scene.modules.values()) {
      view.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    this.scene.collider.geometry.dispose();
    this.materials.dispose();
    this.group.clear();
    this.interactables.length = 0;
  }

  private applyVisibility(): void {
    const visible = this.culler.visible;
    for (const [id, view] of this.scene.modules) view.group.visible = visible.has(id);
    this.props.setVisible(visible);
    this.handrails.setVisible(visible);
    this.hatches.setVisible(visible);
    this.lockers.setVisible(visible);
    this.panels.setVisible(visible);
    this.fixtures.setVisible(visible);
    this.plants.setVisible(visible);
    this.items.setVisible(visible);
    this.cargo.setVisible(visible);
  }
}
