/**
 * Puzzle 3 · CARGO STOW — the half that was missing (DESIGN.md §11, §1, §4).
 *
 * `cargoPhysics.ts` has been a complete, correct owner-simulates/server-relays
 * Rapier world since it was written, and nothing ever constructed it. There was
 * no rack in the station the game actually loads either (see `logic/props.ts`),
 * so the puzzle appeared in the objective list, could never be touched, and
 * `SYSTEMS_TO_ESCAPE` quietly had one fewer route through it than §11 says.
 * This file is the missing wiring: rack → bags → hands → `stow` → ballast trim.
 *
 *   layout  → `cargoRackFromLayout()` reads the five authored slot markers and
 *             turns them into world-space slots, bag spawns, and a bounding box
 *             of bulkheads for the bags to bang off.
 *   physics → `CargoBags` (unchanged), owner-simulates, dynamically imported.
 *   hands   → `pick`/`grab`/`carryTo`/`release`, driven by the §4 interaction
 *             raycaster; the bags render from this file, as five numbered boxes.
 *   server  → `onStow` sends `interact { 'cargo-stow', 'stow', bagId }`, and
 *             the authoritative snapshot comes back through `PuzzleStore` and
 *             latches every client's bag home, whoever moved it.
 *
 * §4's pivot puts it in a `zero` module, which is where it always belonged:
 * "it's the only puzzle that could exist nowhere but this game", and the whole
 * of it is that a bag has momentum and you do not have a floor to brace on.
 *
 * THE NOISE CONTRACT IS THE PUZZLE. A bag that hits something hard is a
 * `cargo-bounce` at 30 — one module of sound, above every PATROL threshold —
 * and "then it keeps bouncing, and now you have five problems". Nudges under
 * `BOUNCE_MIN_SPEED` cost nothing. Moving them gently is the whole puzzle, and
 * gentle is slow: exactly §11's loud-fast / quiet-slow rule with no lever to
 * pull, which is why this one has no quiet PATH, only a quiet HAND.
 */

import * as THREE from 'three';

import { CARGO_BAG_COUNT, MODULE_LENGTH_M, TUBE_RADIUS_M } from '@shared/constants';
import type {
  ModuleId,
  NoiseIntentMessage,
  PlayerId,
  Quat,
  StationLayout,
  StationModule,
  Vec3,
} from '@shared/types';
import { localToWorld } from '@shared/graph/math';

import {
  BAG_HALF_EXTENTS,
  CargoBags,
  type CargoBagSpec,
  type CargoSlotSpec,
  type CargoStaticSpec,
} from './cargoPhysics';
import { cargoBagId, cargoSlotId, cargoSlotIndex, puzzlePropRole, PUZZLE_PROP_KINDS } from './logic/index';
// The kit's own slot pitch. `src/station/deckKit.ts` is three.js-free, so this
// is a constant import and not a subsystem dependency — and it is the pitch the
// rack is actually BUILT at, which is the only number the fallback below may use.
import { CARGO_SLOT_PITCH } from '../station/deckKit';
import { puzzleStore, type PuzzleStore } from './store';
import type { CargoPanelState } from './types';

// ---------------------------------------------------------------------------
// Local tuning. Nothing here is a §14 constant — §14's contribution to this
// puzzle is LOUDNESS.CARGO_BOUNCE (30), reached through the 'cargo-bounce'
// kind, and CARGO_BAG_COUNT (5).
// ---------------------------------------------------------------------------

/**
 * The bore the bags bounce around inside (§2's straight kit piece).
 *
 * DERIVED, never typed. It was a literal 1.0 and the tube widened to 1.5 under
 * it, which broke this puzzle twice over: the bags met an invisible wall half a
 * metre inside the hull, and `moduleHalfLength()` — which back-solves length
 * from `volume / (pi r^2)` — read tube-spine's 35.34 m^3 as an 11.25 m module,
 * clamped it to the 4 m cap and put both end bulkheads OUTSIDE the room, so a
 * bag could drift out through a hatch and make §11 puzzle 3 unsolvable.
 */
export const MODULE_INTERIOR_RADIUS_M = TUBE_RADIUS_M;
/** Wall slab thickness for the bounding box. Thick enough that a fast bag
 *  cannot tunnel through it in one 1/60 s step at any speed it can reach. */
const WALL_THICKNESS_M = 0.25;
/**
 * Half-extent of a slot's trigger volume.
 *
 * Generous on purpose — this is a dexterity puzzle about momentum, not about
 * millimetres, and §11 says "the difficulty is the alien, never the logic".
 * Kept under half the `CARGO_SLOT_PITCH` so two slots can never both claim the
 * same bag: 0.33 of trigger either side of a slot is 0.66 m across an 0.85 m
 * pitch, leaving 0.19 m of dead space between neighbours. The trigger is a
 * WORLD-axis-aligned cube, so its own rotation is not a factor — what matters
 * is that the whole 0.85 m of separation lands on one world axis, which it does
 * for every module in the level (all their quats are 90° multiples).
 *
 * The pitch was 0.95 and is now 0.85 — it moved when the props were brought
 * into scale with a 1.6 m crewmember — so the relationship is asserted below
 * rather than left as a sentence that used to be true.
 */
const SLOT_TRIGGER_HALF_M = 0.33;
/** How far in front of your hands a carried bag rides. */
export const CARRY_DISTANCE_M = 0.85;
/** Reach for picking a bag up. Mirrors the §4 interaction raycaster. */
export const CARGO_REACH_M = 2.5;

/**
 * The two relationships this file cannot check by reading itself.
 *
 * Both are §11 puzzle 3 becoming unsolvable rather than looking wrong, which is
 * the failure worth a build-time noise: a trigger wider than half the pitch
 * lets two slots claim one bag, and a shell that does not enclose the room lets
 * a bag drift out of it. The bore has already moved once (1.0 -> 1.5) and the
 * pitch has already moved once (0.95 -> 0.85), each in a pass that had nothing
 * to do with cargo.
 */
export function assertCargoCoherent(): void {
  const failures: string[] = [];
  if (SLOT_TRIGGER_HALF_M >= CARGO_SLOT_PITCH / 2) {
    failures.push(
      `SLOT_TRIGGER_HALF_M ${SLOT_TRIGGER_HALF_M} must stay under half the ` +
        `CARGO_SLOT_PITCH ${CARGO_SLOT_PITCH} — two slots would claim one bag`,
    );
  }
  if (MODULE_INTERIOR_RADIUS_M !== TUBE_RADIUS_M) {
    failures.push(
      `MODULE_INTERIOR_RADIUS_M ${MODULE_INTERIOR_RADIUS_M} must be the kit bore ` +
        `TUBE_RADIUS_M ${TUBE_RADIUS_M}, or the shell is not the room`,
    );
  }
  // A five-slot rack has to fit inside the module the shell encloses. Volume is
  // the only length the level carries (§2), so this is the same arithmetic
  // `moduleHalfLength` runs, against the shortest module a rack can live in.
  const shortest = Math.PI * TUBE_RADIUS_M * TUBE_RADIUS_M * MODULE_LENGTH_M;
  const half = Math.min(Math.max(shortest / (Math.PI * TUBE_RADIUS_M * TUBE_RADIUS_M), 2) / 2, 4);
  const rackHalf = ((CARGO_BAG_COUNT - 1) / 2) * CARGO_SLOT_PITCH + SLOT_TRIGGER_HALF_M;
  if (rackHalf > half) {
    failures.push(
      `the rack reaches ${rackHalf.toFixed(2)} m from the module centre but the ` +
        `shell's bulkheads sit at ${half.toFixed(2)} m`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`cargo stow (§11 puzzle 3) is incoherent: ${failures.join('; ')}`);
  }
}

/** Dev only, at import — the same idiom `src/player/bodyView.ts` uses. A
 *  production bundle must never refuse to boot over a tuning constant. */
export const CARGO_CHECKED: boolean = (() => {
  if (!isDevEnvironment()) return false;
  assertCargoCoherent();
  return true;
})();

function isDevEnvironment(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env && typeof env.DEV === 'boolean') return env.DEV;
  } catch {
    /* plain Node — fall through */
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc && proc.env) return proc.env.NODE_ENV !== 'production';
  return true;
}

/** One player, for the "nearest player owns the bag" rule (§1). */
export interface CargoPlayer {
  id: PlayerId;
  pos: Vec3;
}

/** Where the rack is and what shape the room around it is. */
export interface CargoRackLayout {
  module: ModuleId;
  /** Centre of the rack, world space — the fallback noise origin. */
  centre: Vec3;
  /** The module's own world orientation, so the rack frames sit square to the
   *  tube instead of square to the world. */
  quat: Quat;
  bags: CargoBagSpec[];
  slots: CargoSlotSpec[];
  statics: CargoStaticSpec[];
}

export interface CargoStowOptions {
  layout: StationLayout;
  localPlayerId: PlayerId;
  /**
   * Module the SERVER placed the puzzle in. Pass
   * `puzzleStore.state('cargo-stow')?.module` when you have it: the authored
   * rack and the server's placement agree now that `puzzlePropRole()` resolves
   * the slot markers, but the server is the authority and this is how you say so.
   */
  module?: ModuleId | null;
  /** Mirror of the authoritative state. Defaults to the shared store. */
  store?: PuzzleStore | null;
  /** A bag settled in its slot. Wire to `interactor.stowBag(bagId)`. */
  onStow?: (bagId: string) => void;
  /** A bag hit something hard. Wire to `emitter.cargoBounce(pos, module)`. */
  onNoise?: (intent: NoiseIntentMessage) => void;
  /** Owner-side transform broadcast, if a relay channel ever exists (§1). */
  onTransform?: (bagId: string, pos: Vec3, quat: Quat) => void;
}

// ---------------------------------------------------------------------------
// Reading the rack out of the station
// ---------------------------------------------------------------------------

/**
 * Find the cargo rack and build everything the physics world needs from it.
 *
 * The five slots come straight from the level (`tube-spine-cargo-slot-1` … `-5`,
 * §2 "authoring is then a JSON file"), so the bags go where the artist put the
 * rack rather than where a hardcoded offset guesses it is. A layout that tags
 * one prop `cargo-rack` and no slots still works: the slots are then laid out
 * along the module axis from the rack, which is what `defaultCargoLayout()`
 * always did.
 *
 * Returns null if the layout has no cargo hardware at all — a legitimate state
 * for a cut-down test level, and the caller simply does not build the puzzle.
 */
export function cargoRackFromLayout(
  layout: StationLayout,
  preferredModule?: ModuleId | null,
): CargoRackLayout | null {
  const hits: Array<{ module: StationModule; id: string; pos: Vec3; index: number | null }> = [];
  for (const module of layout.modules) {
    if (preferredModule && module.id !== preferredModule) continue;
    for (const prop of module.props) {
      if (puzzlePropRole(prop) !== PUZZLE_PROP_KINDS.CARGO_RACK) continue;
      hits.push({
        module,
        id: prop.id,
        pos: localToWorld(prop.localPos, module.transform),
        index: cargoSlotIndex(prop.id),
      });
    }
  }
  // A preferred module that turns out to hold no rack falls back to the whole
  // station: the server's placement is authoritative, but a mismatch must not
  // silently delete the puzzle.
  if (hits.length === 0 && preferredModule) return cargoRackFromLayout(layout, null);
  if (hits.length === 0) return null;

  const module = hits[0].module;
  const inModule = hits.filter((h) => h.module.id === module.id);
  const numbered = inModule.filter((h) => h.index !== null).sort((a, b) => a.index! - b.index!);

  const centre = averageOf(inModule.map((h) => h.pos));
  const slots: CargoSlotSpec[] = [];
  const bags: CargoBagSpec[] = [];

  for (let i = 0; i < CARGO_BAG_COUNT; i++) {
    const authored = numbered.find((h) => h.index === i);
    // Fall back to a line along the module's own axis when a slot is missing,
    // so five bags always have five places to go.
    const slotWorld = authored
      ? authored.pos
      : localToWorld(offsetAlongAxis(module, i), module.transform);

    slots.push({
      id: cargoSlotId(i),
      bagId: cargoBagId(i),
      centre: slotWorld,
      halfExtents: { x: SLOT_TRIGGER_HALF_M, y: SLOT_TRIGGER_HALF_M, z: SLOT_TRIGGER_HALF_M },
    });

    // Bags start LOOSE: off the rack face, staggered either side of the axis,
    // drifting. §11 — "five numbered bags float loose". Recovering them is the
    // puzzle; finding them is not, so they start in sight of their own slots.
    bags.push({
      id: cargoBagId(i),
      slot: cargoSlotId(i),
      pos: localToWorld(bagStartLocal(module, i), module.transform),
      mass: 8,
    });
  }

  return {
    module: module.id,
    centre,
    quat: { ...module.transform.quat },
    bags,
    slots,
    statics: moduleShell(module),
  };
}

/** The module as a closed box: four walls and two bulkheads, in world space.
 *
 *  Deliberately conservative — a bag that escapes the module is unrecoverable
 *  and makes the objective unsolvable, which is a worse failure than a bag that
 *  bounces off a wall half a metre from where the wall looks like it is. The
 *  box is the module's own oriented bounding box, so it is right for a straight
 *  and merely tight for a node. */
function moduleShell(module: StationModule): CargoStaticSpec[] {
  const r = MODULE_INTERIOR_RADIUS_M;
  const half = moduleHalfLength(module);
  const t = WALL_THICKNESS_M;
  const quat = module.transform.quat;
  const local: Array<{ c: Vec3; h: Vec3 }> = [
    { c: { x: r + t, y: 0, z: 0 }, h: { x: t, y: r + t, z: half + t } },
    { c: { x: -(r + t), y: 0, z: 0 }, h: { x: t, y: r + t, z: half + t } },
    { c: { x: 0, y: r + t, z: 0 }, h: { x: r + t, y: t, z: half + t } },
    { c: { x: 0, y: -(r + t), z: 0 }, h: { x: r + t, y: t, z: half + t } },
    { c: { x: 0, y: 0, z: half + t }, h: { x: r + t, y: r + t, z: t } },
    { c: { x: 0, y: 0, z: -(half + t) }, h: { x: r + t, y: r + t, z: t } },
  ];
  return local.map((slab) => ({
    centre: localToWorld(slab.c, module.transform),
    halfExtents: slab.h,
    quat: { ...quat },
  }));
}

/** Half the module's length along its own axis, from §2's volume field. */
function moduleHalfLength(module: StationModule): number {
  // volume = π r² L for a tube, so L falls out of the field the level already
  // carries for reverb (§2) — no second source of truth for module size.
  const area = Math.PI * MODULE_INTERIOR_RADIUS_M * MODULE_INTERIOR_RADIUS_M;
  const length = module.volume > 0 ? module.volume / area : 0;
  return Math.min(Math.max(length, 2) / 2, 4);
}

/** Slot i, when the level authored a rack but no numbered slots. */
function offsetAlongAxis(module: StationModule, i: number): Vec3 {
  const spread = (i - (CARGO_BAG_COUNT - 1) / 2) * CARGO_SLOT_PITCH;
  return { x: MODULE_INTERIOR_RADIUS_M - 0.27, y: 0, z: spread };
}

/** Where bag i starts: off the rack, on the far side of the axis. */
function bagStartLocal(module: StationModule, i: number): Vec3 {
  const spread = (i - (CARGO_BAG_COUNT - 1) / 2) * CARGO_SLOT_PITCH;
  return {
    x: -0.32,
    y: i % 2 === 0 ? 0.3 : -0.3,
    z: spread + (i % 2 === 0 ? 0.16 : -0.16),
  };
}

function averageOf(points: readonly Vec3[]): Vec3 {
  if (points.length === 0) return { x: 0, y: 0, z: 0 };
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  return { x: x / points.length, y: y / points.length, z: z / points.length };
}

// ---------------------------------------------------------------------------
// The live puzzle
// ---------------------------------------------------------------------------

interface BagVisual {
  id: string;
  mesh: THREE.Mesh;
  marker: THREE.Mesh;
  texture: THREE.CanvasTexture;
}

/** Turns a plane's own +Z to point down the module's −X, i.e. off the rack face. */
const FACE_NEGATIVE_X = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  -Math.PI / 2,
);

const BAG_COLOUR = 0xd8d2c4;
const BAG_COLOUR_HELD = 0xf2ede0;
const SLOT_COLOUR_EMPTY = 0xffb020;
const SLOT_COLOUR_FULL = 0x4dff9b;

export class CargoStow {
  /** Add this to the scene. Five numbered bags and five numbered slot frames. */
  readonly object3D = new THREE.Group();
  readonly module: ModuleId;
  readonly rack: CargoRackLayout;

  private readonly bags: CargoBags;
  private readonly store: PuzzleStore | null;
  private readonly visuals: BagVisual[] = [];
  private readonly frames = new Map<string, THREE.LineSegments>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly onStowFn: ((bagId: string) => void) | undefined;

  private carried: string | null = null;
  private lastRevision = -1;
  private disposed = false;

  private constructor(bags: CargoBags, rack: CargoRackLayout, opts: CargoStowOptions) {
    this.bags = bags;
    this.rack = rack;
    this.module = rack.module;
    this.store = opts.store === undefined ? puzzleStore : opts.store;
    this.onStowFn = opts.onStow;
    this.object3D.name = `cargo-stow:${rack.module}`;
    this.buildVisuals();
  }

  /**
   * Build the puzzle from the station layout. Resolves once Rapier is loaded —
   * it is imported dynamically, because statically it inlines ~2.8 MB of base64
   * wasm into the main chunk and blocks first paint.
   *
   * Returns null when the layout has no cargo hardware, so a caller can simply
   * `if (cargo)` rather than special-casing a cut-down level.
   */
  static async create(opts: CargoStowOptions): Promise<CargoStow | null> {
    const rack = cargoRackFromLayout(opts.layout, opts.module ?? null);
    if (!rack) return null;

    const bags = await CargoBags.create({
      module: rack.module,
      bags: rack.bags,
      slots: rack.slots,
      statics: rack.statics,
      localPlayerId: opts.localPlayerId,
      ...(opts.onNoise ? { onNoise: opts.onNoise } : {}),
      ...(opts.onStow ? { onStow: opts.onStow } : {}),
      ...(opts.onTransform ? { onTransform: opts.onTransform } : {}),
    });
    return new CargoStow(bags, rack, opts);
  }

  get ready(): boolean {
    return this.bags.ready && !this.disposed;
  }

  get stowedCount(): number {
    return this.bags.stowedCount;
  }

  get required(): number {
    return CARGO_BAG_COUNT;
  }

  get solved(): boolean {
    return this.stowedCount >= this.required;
  }

  /** The bag in your hands, or null. */
  get carrying(): string | null {
    return this.carried;
  }

  setLocalPlayer(id: PlayerId): void {
    this.bags.setLocalPlayer(id);
  }

  /**
   * Drive from the fixed tick.
   *
   * `players` is everyone in this module in world space — ownership is "nearest
   * player" (§1) and has to be recomputed as people move. Passing an empty list
   * means nobody owns anything, and an unowned bag reports neither its bounces
   * nor its stows, so this is not optional in a live round.
   */
  update(dt: number, players: readonly CargoPlayer[]): void {
    if (!this.ready) return;
    this.syncAuthoritative();
    this.bags.step(dt, players);
    this.syncVisuals();
  }

  // -- hands ---------------------------------------------------------------

  /**
   * The bag under a ray, or null. Feed it the camera's own ray and hand the
   * result to `grab()`; the §4 interaction raycaster hits props, and the bags
   * are not props — they are dynamic bodies this file owns.
   */
  pick(origin: Vec3, direction: Vec3, maxDistance = CARGO_REACH_M): string | null {
    if (!this.ready) return null;
    this.raycaster.set(
      new THREE.Vector3(origin.x, origin.y, origin.z),
      new THREE.Vector3(direction.x, direction.y, direction.z).normalize(),
    );
    this.raycaster.far = maxDistance;
    const meshes = this.visuals.filter((v) => !this.bags.isStowed(v.id)).map((v) => v.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? ((hit.object.userData.bagId as string | undefined) ?? null) : null;
  }

  /** Take hold of a bag. Arresting a drifting one is free — a hand is not a
   *  bulkhead — which is what makes chasing a loose bag a real recovery. */
  grab(bagId: string): boolean {
    if (!this.ready || this.bags.isStowed(bagId)) return false;
    const transform = this.bags.transform(bagId);
    if (!transform) return false;
    this.carried = bagId;
    this.bags.hold(bagId, transform.pos, transform.quat);
    return true;
  }

  /** Move the carried bag. Call every frame while holding one. */
  carryTo(pos: Vec3, quat?: Quat): void {
    if (!this.carried || !this.ready) return;
    if (this.bags.isStowed(this.carried)) {
      // It latched home under your hands — that is a stow, not a drop.
      this.carried = null;
      return;
    }
    this.bags.hold(this.carried, pos, quat);
  }

  /** Convenience: park the carried bag in front of the camera. */
  carryFromCamera(origin: Vec3, forward: Vec3, distance = CARRY_DISTANCE_M): void {
    this.carryTo({
      x: origin.x + forward.x * distance,
      y: origin.y + forward.y * distance,
      z: origin.z + forward.z * distance,
    });
  }

  /**
   * Let go.
   *
   * `velocity` is what you push it away at, and it is the entire risk dial of
   * this puzzle: under `BOUNCE_MIN_SPEED` (1.0 m/s) of contact loss the bag
   * arrives silently, over it you have announced yourself at 30 and started a
   * problem that keeps moving. Releasing at zero is always safe and always slow.
   */
  release(velocity: Vec3 = { x: 0, y: 0, z: 0 }): void {
    if (!this.carried) return;
    this.bags.release(this.carried, velocity);
    this.carried = null;
  }

  /** Shove a bag without picking it up. The loud, fast, stupid option. */
  push(bagId: string, impulse: Vec3): void {
    this.bags.push(bagId, impulse);
  }

  /** Prompt text for the §6 crosshair, or null when nothing is in reach. */
  prompt(bagId: string | null): string | null {
    if (this.carried) return 'RELEASE — GENTLY';
    if (!bagId) return null;
    const index = this.visuals.findIndex((v) => v.id === bagId);
    return index >= 0 ? `TAKE BAG ${index + 1}` : 'TAKE BAG';
  }

  // -- state ---------------------------------------------------------------

  /** The server says these are home. Latches them on every client, including
   *  the ones that never saw the bag move (§7 — puzzle state is authoritative). */
  applyState(state: CargoPanelState | null): void {
    if (!state) return;
    for (const bag of state.bags) {
      if (bag.stowed) this.bags.markStowed(bag.id);
    }
  }

  /** New round: every bag back where the level put it. Call on `round:started`,
   *  in step with the server's own `CargoStowPuzzle.reset()`. */
  reset(): void {
    if (this.disposed) return;
    this.carried = null;
    this.lastRevision = -1;
    this.bags.reset();
    this.syncVisuals();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.carried = null;
    this.bags.dispose();
    for (const visual of this.visuals) {
      visual.texture.dispose();
      visual.mesh.geometry.dispose();
      disposeMaterial(visual.mesh.material);
      visual.marker.geometry.dispose();
      disposeMaterial(visual.marker.material);
    }
    this.visuals.length = 0;
    for (const frame of this.frames.values()) {
      frame.geometry.dispose();
      disposeMaterial(frame.material);
    }
    this.frames.clear();
    this.object3D.clear();
  }

  // -----------------------------------------------------------------------

  private syncAuthoritative(): void {
    if (!this.store) return;
    const state = this.store.state('cargo-stow');
    if (!state || state.revision === this.lastRevision) return;
    this.lastRevision = state.revision;
    this.applyState(state);
  }

  private syncVisuals(): void {
    for (const visual of this.visuals) {
      const transform = this.bags.transform(visual.id);
      if (!transform) continue;
      visual.mesh.position.set(transform.pos.x, transform.pos.y, transform.pos.z);
      visual.mesh.quaternion.set(
        transform.quat.x,
        transform.quat.y,
        transform.quat.z,
        transform.quat.w,
      );
      const held = visual.id === this.carried;
      const material = visual.mesh.material as THREE.MeshStandardMaterial;
      const wanted = held ? BAG_COLOUR_HELD : BAG_COLOUR;
      if (material.color.getHex() !== wanted) material.color.setHex(wanted);

      const frame = this.frames.get(visual.id);
      if (frame) {
        const stowed = this.bags.isStowed(visual.id);
        const line = frame.material as THREE.LineBasicMaterial;
        const colour = stowed ? SLOT_COLOUR_FULL : SLOT_COLOUR_EMPTY;
        if (line.color.getHex() !== colour) line.color.setHex(colour);
      }
    }
    // `pick()` raycasts these meshes from the FIXED tick, which runs before the
    // renderer refreshes world matrices — so a bag would be picked at the
    // position it held a frame ago, and a bag drifting at 2 m/s would be 10 cm
    // from where the crosshair says it is. Fifteen matrices at 20 Hz; do it here
    // and let picking depend on nothing outside this file.
    this.object3D.updateMatrixWorld(true);
  }

  /**
   * Five numbered bags and five numbered slot frames.
   *
   * The numbering is the entire user interface of this puzzle — "each goes in
   * its matching rack slot" — so it is printed on both ends of the pairing, in
   * the dark, on emissive material. Nothing else about it needs explaining, and
   * §11 is explicit that the logic must never be the difficulty.
   */
  private buildVisuals(): void {
    const half = BAG_HALF_EXTENTS;
    const geometry = new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
    const moduleQuat = new THREE.Quaternion(
      this.rack.quat.x,
      this.rack.quat.y,
      this.rack.quat.z,
      this.rack.quat.w,
    );

    this.rack.bags.forEach((spec, i) => {
      const texture = numberTexture(i + 1);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: BAG_COLOUR,
          roughness: 0.85,
          metalness: 0.05,
          map: texture,
        }),
      );
      mesh.name = spec.id;
      mesh.userData.bagId = spec.id;
      mesh.position.set(spec.pos.x, spec.pos.y, spec.pos.z);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.object3D.add(mesh);

      // The matching slot: an outlined volume you can see from across the
      // module, amber while it is empty and green the moment it is not.
      const slot = this.rack.slots[i];
      const frameGeometry = new THREE.EdgesGeometry(
        new THREE.BoxGeometry(half.x * 2.3, half.y * 2.6, half.z * 2.2),
      );
      const frame = new THREE.LineSegments(
        frameGeometry,
        new THREE.LineBasicMaterial({ color: SLOT_COLOUR_EMPTY, transparent: true, opacity: 0.75 }),
      );
      frame.position.set(slot.centre.x, slot.centre.y, slot.centre.z);
      frame.quaternion.copy(moduleQuat);
      this.object3D.add(frame);
      this.frames.set(spec.id, frame);

      // The slot's own number, on a small unlit plane facing off the rack face
      // toward the module axis. The rack is authored on the module's +X wall
      // (`cargoSlots()` in the station spec, and the fallback layout above), so
      // the readable direction is local −X: turn the plane's own +Z to face it.
      const marker = new THREE.Mesh(
        new THREE.PlaneGeometry(0.18, 0.18),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
      );
      marker.position.set(slot.centre.x, slot.centre.y, slot.centre.z);
      marker.quaternion.copy(moduleQuat).multiply(FACE_NEGATIVE_X);
      marker.translateZ(half.x * 1.4);
      this.object3D.add(marker);

      this.visuals.push({ id: spec.id, mesh, marker, texture });
    });
  }
}

/** A number on a transparent square, drawn once per bag. No assets (§9). */
function numberTexture(n: number): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(20,22,24,0.82)';
    ctx.fillRect(size * 0.18, size * 0.18, size * 0.64, size * 0.64);
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 4;
    ctx.strokeRect(size * 0.18, size * 0.18, size * 0.64, size * 0.64);
    ctx.fillStyle = '#f4f0e6';
    ctx.font = `bold ${Math.round(size * 0.46)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), size / 2, size * 0.53);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(material)) for (const m of material) m.dispose();
  else material.dispose();
}
