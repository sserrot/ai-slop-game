/**
 * ISS-CAR — the six carryables (asset bible, "Carryables"; DESIGN.md §5, §10, §11).
 *
 * "The largest gap in the game. All six exist only as `ItemKind` strings on the
 * server and have never been visible to a player."
 *
 * They are visible now. Medkit, decoy, fuse, sequence card, extinguisher, pry
 * bar — one builder each under `items/`, one factory here, and nothing outside
 * this file ever switches on the string again.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A CARRYABLE IS, MECHANICALLY
 *
 * Two forms, from ONE geometry:
 *
 *   • the WORLD form — resting on a locker shelf, a rack or the deck, or drifting
 *     in a `gravity: 'zero'` module. `buildItemMesh` for a one-off,
 *     `StationItemInstances` for a level's worth.
 *   • the HELD form — in the player's own hands in first person, or in another
 *     crew member's hands in third. `buildHeldItem` / `buildFirstPersonItem`.
 *
 * The held form is the same buffers under a per-kind pose, not a second model.
 * That is not a shortcut, it is the point: a player who learns a shape in their
 * hand has to recognise the same shape on a shelf across a dark module, and the
 * fastest way to guarantee that is for it to be the same shape. What the pose
 * buys is presentation — the medkit hangs from its handle, the extinguisher
 * swings its horn forward, the card tilts up to be read — and it costs one
 * `Object3D` transform.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DRAW-CALL ARITHMETIC, WHICH DECIDED THE ART
 *
 * The station runs at 55–100 draw calls and that ceiling is not moving. So:
 *
 *   • every carryable's whole body is ONE merged geometry on ONE material —
 *     `materials.vertexPainted`, the palette's single vertex-coloured program,
 *     already linked by `Renderer.prewarm()`. Six items, zero new shader
 *     programs. Part colours come from `PALETTE` via `items/common.ts`.
 *   • world items instance per kind (`StationItemInstances`), module-culled, so a
 *     kind whose instances are all outside the two-hop set packs to `count = 0`
 *     and is frustum-rejected without a draw call.
 *   • every accent in the set shares one `InstancedSet` per accent SHAPE — three
 *     shapes across six items, so at most three, usually one visible.
 *   • a held item is 2 draw calls (body + lamp) and there is at most one held
 *     item per camera.
 *
 * In the shipping level that is 1–3 draw calls for every carryable a player can
 * see, against the six invisible strings we started with.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EMISSIVE
 *
 * Every one of the six carries the accent, and that is not decoration: an item
 * lying in an unlit locker in a module on emergency lighting is invisible
 * without it. `interact: 'carryable'` is honest for all six — you press E on
 * every one — so this is the accent convention working as designed rather than
 * being bent. One lamp each, enforced by `attachAccent`.
 */

import * as THREE from 'three';
import type { ModuleId } from '@shared/types';
import type { AccentPlacement, AccentShape, PolyBudget, Size3 } from './artKit';
import {
  accentGeometry,
  accentMatrix,
  assertPolyBudget,
  attachAccent,
  checkPolyBudget,
  countAccents,
  triangleCount,
} from './artKit';
import { InstancedSet } from './instancing';
import type { InstanceEntry } from './instancing';
import type { StationMaterials } from './materials';
import type { ItemKind } from '../net/protocol';
import type { AccentSpot, ItemBuilder } from './items/common';
import { MEDKIT_GRIP, buildMedkit } from './items/medkit';
import { DECOY_GRIP, buildDecoy } from './items/decoy';
import { FUSE_GRIP, buildFuse } from './items/fuse';
import { CARD_GRIP, buildSequenceCard } from './items/sequenceCard';
import { EXTINGUISHER_GRIP, buildExtinguisher } from './items/extinguisher';
import { PRY_BAR_GRIP, buildPryBar } from './items/pryBar';

export type { ItemKind } from '../net/protocol';
export type { AccentSpot, ItemBuild } from './items/common';
export { SEQUENCE_CARD_FACE } from './items/sequenceCard';

/** Authored order, matching `ItemKind` and the bible's ISS-CAR-01…06. */
export const ITEM_KINDS: readonly ItemKind[] = Object.freeze([
  'medkit',
  'decoy',
  'fuse',
  'sequence-card',
  'extinguisher',
  'pry-bar',
]);

// ---------------------------------------------------------------------------
// Per-kind specification — the bible, as data
// ---------------------------------------------------------------------------

/**
 * Coarse shape class. Two carryables may never share one.
 *
 * This is the *machinery* behind "a player who grabs a decoy thinking it was a
 * medkit dies, so those two must be unmistakable from any angle". Colour cannot
 * carry that (rule 7, and 5 candela through fog eats hue first) and neither can
 * a size check on its own, because a medkit and a decoy are both mid-sized
 * chunky objects. What separates them is CLASS: a rectangular case with a grab
 * handle spanning its top versus a round canister with a pull ring standing
 * clear above it. `assertItemsCoherent` requires all six classes to be distinct,
 * so the guarantee is checked rather than remembered.
 */
export type ItemProfile = 'case' | 'canister' | 'cartridge' | 'card' | 'bottle' | 'rod';

/**
 * How the item sits in a hand, as a transform of the canonical (resting)
 * geometry about its grip point.
 *
 * Euler angles in three's default `'XYZ'` order, radians. These are a sane
 * default — an aiming pose, a reading pose, a hanging pose — not a rig
 * specification: `buildHeldItem` takes a `pose` override so a first-person rig
 * or a character's hand bone can say something different without touching this
 * file.
 */
export interface HoldPose {
  readonly rotation: Size3;
  /** Where the grip goes in CAMERA space for a first-person view model. */
  readonly cameraOffset: Size3;
}

export interface ItemSpec {
  /** Asset bible designation. */
  readonly designation: string;
  /** Human label, for toasts and debug overlays. */
  readonly label: string;
  /** Triangle band from the bible's own per-asset budget, not artKit's generic
   *  `carryable` 200–800: the fuse (120–200) and the card (40–80) are both
   *  deliberately below it, because they are deliberately tiny. */
  readonly budget: PolyBudget;
  readonly profile: ItemProfile;
  /** Longest dimension the bible states, metres. The scale guard — "doll
   *  furniture is the most common failure". */
  readonly bibleLongest: number;
  /** Local point a hand closes on, in the canonical frame. */
  readonly grip: Size3;
  readonly hold: HoldPose;
  readonly build: ItemBuilder;
}

export const ITEM_SPECS: Readonly<Record<ItemKind, ItemSpec>> = Object.freeze({
  medkit: {
    designation: 'ISS-CAR-01',
    label: 'medkit',
    budget: { label: 'medkit (ISS-CAR-01)', min: 400, max: 600 },
    profile: 'case',
    bibleLongest: 0.3,
    grip: MEDKIT_GRIP,
    hold: {
      // Hangs from the handle, face turned in toward the screen centre.
      rotation: { x: 0, y: -0.55, z: -0.1 },
      cameraOffset: { x: 0.24, y: -0.3, z: -0.44 },
    },
    build: buildMedkit,
  },
  decoy: {
    designation: 'ISS-CAR-02',
    label: 'decoy',
    budget: { label: 'decoy (ISS-CAR-02)', min: 300, max: 450 },
    profile: 'canister',
    bibleLongest: 0.2,
    grip: DECOY_GRIP,
    hold: {
      // Gripped mid-body, top tipped away — the attitude of something about to
      // be thrown, and nothing like the medkit's hang from any angle.
      rotation: { x: -0.25, y: -0.45, z: 0.2 },
      cameraOffset: { x: 0.22, y: -0.22, z: -0.36 },
    },
    build: buildDecoy,
  },
  fuse: {
    designation: 'ISS-CAR-03',
    label: 'fuse',
    budget: { label: 'fuse (ISS-CAR-03)', min: 120, max: 200 },
    profile: 'cartridge',
    bibleLongest: 0.11,
    grip: FUSE_GRIP,
    hold: {
      // Pinched and turned across the view, close in: the only way to sell 11 cm
      // is to bring it near the eye.
      rotation: { x: 0.2, y: -1.0, z: 0.3 },
      cameraOffset: { x: 0.17, y: -0.15, z: -0.28 },
    },
    build: buildFuse,
  },
  'sequence-card': {
    designation: 'ISS-CAR-04',
    label: 'sequence card',
    budget: { label: 'sequence card (ISS-CAR-04)', min: 40, max: 80 },
    profile: 'card',
    bibleLongest: 0.14,
    grip: CARD_GRIP,
    hold: {
      // Lifted off the flat and tilted up: §11 puzzle 1 is a thing you READ.
      rotation: { x: 1.15, y: -0.3, z: 0.12 },
      cameraOffset: { x: 0.16, y: -0.18, z: -0.32 },
    },
    build: buildSequenceCard,
  },
  extinguisher: {
    designation: 'ISS-CAR-05',
    label: 'extinguisher',
    budget: { label: 'extinguisher (ISS-CAR-05)', min: 500, max: 800 },
    profile: 'bottle',
    bibleLongest: 0.42,
    grip: EXTINGUISHER_GRIP,
    hold: {
      // Yawed so the horn — built along +X for exactly this — swings forward and
      // right, off the player's own body. §4 spends this as a thruster; the
      // vector has to be legible before the burst, not after.
      rotation: { x: -0.1, y: 1.15, z: -0.2 },
      cameraOffset: { x: 0.28, y: -0.22, z: -0.5 },
    },
    build: buildExtinguisher,
  },
  'pry-bar': {
    designation: 'ISS-CAR-06',
    label: 'pry bar',
    budget: { label: 'pry bar (ISS-CAR-06)', min: 200, max: 320 },
    profile: 'rod',
    bibleLongest: 0.68,
    grip: PRY_BAR_GRIP,
    hold: {
      // Across the view, claw forward and raised. A 0.68 m bar held along the
      // view axis is a grey disc; held across it, it is unmistakable.
      rotation: { x: -0.15, y: 1.15, z: 0.28 },
      cameraOffset: { x: 0.22, y: -0.26, z: -0.34 },
    },
    build: buildPryBar,
  },
});

/** Recommended camera-space grip position for a first-person view model. */
export const HELD_CAMERA_OFFSET: Readonly<Record<ItemKind, Size3>> = Object.freeze(
  Object.fromEntries(
    ITEM_KINDS.map((k) => [k, (ITEM_SPECS[k] as ItemSpec).hold.cameraOffset]),
  ) as Record<ItemKind, Size3>,
);

// ---------------------------------------------------------------------------
// The model cache
// ---------------------------------------------------------------------------

/** One carryable, built and measured. The geometry is SHARED — every world
 *  instance and every held mesh of this kind points at these buffers. Do not
 *  dispose it or mutate it; `disposeItemModels()` is the teardown. */
export interface ItemModel {
  readonly kind: ItemKind;
  readonly spec: ItemSpec;
  readonly geometry: THREE.BufferGeometry;
  readonly accent: AccentSpot;
  readonly triangles: number;
  /** Bounding-box extents of the body, metres. */
  readonly size: Size3;
  /** Bounding-box centre relative to the rest origin. Add this to a resting
   *  position to get the centroid — what a floating item in a `zero` module
   *  should tumble about. */
  readonly centre: Size3;
}

const models = new Map<ItemKind, ItemModel>();

/**
 * The factory. One entry point, keyed by `ItemKind` — callers never switch on
 * the string, and adding a seventh item means adding a row to `ITEM_SPECS`.
 *
 * Cached: the geometry is built once per kind per process and shared by every
 * mesh and every instance of it.
 */
export function itemModel(kind: ItemKind): ItemModel {
  const hit = models.get(kind);
  if (hit) return hit;
  const spec = ITEM_SPECS[kind];
  if (!spec) throw new Error(`items: unknown ItemKind "${String(kind)}"`);

  const built = spec.build();
  const geometry = built.geometry;
  geometry.name = `item-${kind}`;
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox ?? new THREE.Box3();
  const size = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
  const centre = {
    x: (bb.min.x + bb.max.x) / 2,
    y: (bb.min.y + bb.max.y) / 2,
    z: (bb.min.z + bb.max.z) / 2,
  };
  // Throws over the bible's max, warns under its min. Under-spending is the bug
  // the whole art pass exists to fix.
  assertPolyBudget(geometry, spec.budget, `${spec.designation} ${spec.label}`);

  const model: ItemModel = {
    kind,
    spec,
    geometry,
    accent: built.accent,
    triangles: triangleCount(geometry),
    size,
    centre,
  };
  models.set(kind, model);
  return model;
}

/** Shared body geometry for a kind. Do not dispose. */
export function itemGeometry(kind: ItemKind): THREE.BufferGeometry {
  return itemModel(kind).geometry;
}

/** Release every cached carryable geometry. Teardown only — every item mesh in
 *  the scene points at these buffers. */
export function disposeItemModels(): void {
  for (const m of models.values()) m.geometry.dispose();
  models.clear();
}

// ---------------------------------------------------------------------------
// World form
// ---------------------------------------------------------------------------

export interface ItemMeshOptions {
  /**
   * Cast into the §9 flashlight shadow map. Default TRUE for a world item, and
   * deliberately so: `rubberFoot`'s whole argument is that the dark line the one
   * shadow map draws under a footed object is what tells a player which side of
   * a coaming it is on. A loose carryable is small enough to afford it.
   */
  readonly castShadow?: boolean;
  /** Include the amber accent. Default true — turn it off only for an item that
   *  is no longer pickable (already stowed in a solved cargo slot, say). */
  readonly accent?: boolean;
  readonly name?: string;
}

/**
 * One carryable, resting. The group's origin is the point the item SITS on, so
 * `mesh.position.set(x, DECK_Y_M, z)` puts it on the deck with no arithmetic.
 *
 * For more than a handful, use `StationItemInstances` instead — this costs two
 * draw calls each.
 */
export function buildItemMesh(
  kind: ItemKind,
  materials: StationMaterials,
  opts: ItemMeshOptions = {},
): THREE.Group {
  const model = itemModel(kind);
  const group = new THREE.Group();
  group.name = opts.name ?? `item-${kind}`;

  const mesh = new THREE.Mesh(model.geometry, materials.vertexPainted);
  mesh.name = `${kind}-body`;
  mesh.castShadow = opts.castShadow !== false;
  mesh.receiveShadow = true;
  group.add(mesh);

  if (opts.accent !== false) attachItemAccent(group, materials, model, { x: 0, y: 0, z: 0 });
  return group;
}

// ---------------------------------------------------------------------------
// Held form — the entry point the characters agent wants
// ---------------------------------------------------------------------------

export interface HeldItemOptions {
  /** Override the per-kind default pose. */
  readonly pose?: Pick<HoldPose, 'rotation'>;
  /** Include the amber accent. Default true. */
  readonly accent?: boolean;
  readonly name?: string;
}

/**
 * One carryable, in a hand.
 *
 * THE FRAME, which is the whole contract:
 *
 *   • the returned group's ORIGIN is the item's grip point — the spot a palm
 *     closes on. Parent it to a hand node, or to a camera, and set `position`;
 *     there is no offset to work out and no geometry to re-centre.
 *   • axes are the holder's: **+X right, +Y up, −Z forward**, i.e. three's camera
 *     convention. So `camera.add(held)` works directly, and a character rig
 *     multiplies by its own hand orientation.
 *   • the item's own pose about the grip is already applied (`ITEM_SPECS[kind]
 *     .hold.rotation`), so the medkit hangs, the horn points away from the
 *     holder and the card faces them. Override with `opts.pose`.
 *
 * Two draw calls: the body on `materials.vertexPainted`, the lamp on
 * `materials.interact`. Neither casts a shadow — a view model in the flashlight's
 * own shadow map is a black bar across the screen.
 */
export function buildHeldItem(
  kind: ItemKind,
  materials: StationMaterials,
  opts: HeldItemOptions = {},
): THREE.Group {
  const model = itemModel(kind);
  const spec = model.spec;
  const rotation = opts.pose?.rotation ?? spec.hold.rotation;

  const group = new THREE.Group();
  group.name = opts.name ?? `held-${kind}`;

  // The pose rotates the item ABOUT ITS GRIP, so the grip stays at the group's
  // origin whatever the rotation is. That is what makes the origin a contract a
  // rig can rely on.
  const pose = new THREE.Group();
  pose.name = `${kind}-pose`;
  pose.rotation.set(rotation.x, rotation.y, rotation.z);
  group.add(pose);

  const mesh = new THREE.Mesh(model.geometry, materials.vertexPainted);
  mesh.name = `${kind}-body`;
  mesh.position.set(-spec.grip.x, -spec.grip.y, -spec.grip.z);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  pose.add(mesh);

  if (opts.accent !== false) attachItemAccent(pose, materials, model, spec.grip);
  return group;
}

/**
 * `buildHeldItem` with the recommended camera-space offset already applied, for
 * a first-person view model: `camera.add(buildFirstPersonItem(kind, materials))`
 * and you are done.
 */
export function buildFirstPersonItem(
  kind: ItemKind,
  materials: StationMaterials,
  opts: HeldItemOptions = {},
): THREE.Group {
  const group = buildHeldItem(kind, materials, opts);
  const o = ITEM_SPECS[kind].hold.cameraOffset;
  group.position.set(o.x, o.y, o.z);
  return group;
}

function attachItemAccent(
  parent: THREE.Object3D,
  materials: StationMaterials,
  model: ItemModel,
  origin: Size3,
): THREE.Mesh {
  const a = model.accent;
  return attachAccent(parent, materials, {
    interact: 'carryable',
    at: { x: a.at.x - origin.x, y: a.at.y - origin.y, z: a.at.z - origin.z },
    normal: a.normal,
    shape: a.shape,
    name: `accent-${model.kind}`,
  });
}

// ---------------------------------------------------------------------------
// World form, instanced
// ---------------------------------------------------------------------------

export interface ItemPlacement {
  readonly kind: ItemKind;
  readonly module: ModuleId;
  /** World matrix of the item's REST ORIGIN — the point it sits on. */
  readonly matrix: THREE.Matrix4;
}

export interface ItemInstanceOptions {
  /** Build the accent lamps. Default true. */
  readonly accents?: boolean;
  /**
   * Force every world accent to one shape, collapsing the accent sets to a
   * single draw call.
   *
   * The default keeps each kind's own shape — the fuse's `bar` is its filament,
   * the extinguisher's `bulb` is its gauge — which costs one `InstancedMesh` per
   * shape in use (at most three across the six). That distinction is worth
   * paying for in the hand and at two metres; if a level puts enough items in
   * one two-hop view that the draw calls matter, pass `'dot'` and lose nothing
   * a player can resolve at range.
   */
  readonly accentShape?: AccentShape;
  readonly name?: string;
}

/**
 * Every loose carryable in the level, in 1–3 draw calls, module-culled.
 *
 * One `InstancedMesh` per kind present (all six share `materials.vertexPainted`,
 * so this is a draw call per kind and not per material), plus one for each
 * distinct accent SHAPE in use. `InstancedSet` repacks by module and rebuilds its
 * bounds, so a kind with no instances inside the two-hop set packs to
 * `count = 0` and is frustum-rejected — it costs nothing at all.
 *
 * Add `group` to the scene BEFORE `Renderer.prewarm()`, the same requirement
 * `main.ts` already documents for the cargo bag meshes, and drive `setVisible`
 * from wherever `StationProps.setVisible` is driven.
 */
/**
 * Where one placement's instances ended up, so a single world item can be shown
 * or hidden without a second draw call and without building anything.
 *
 * The case this exists for: a locker's contents are rolled from the round seed
 * and re-rolled at `roundStart`, so an item mesh built when a locker turns out to
 * hold one would allocate geometry and link a program on first sight of that
 * locker — the first-visit hitch `Renderer.prewarm()` exists to pay off. Build
 * every slot the level could ever use, hide them all, and let the plan reveal
 * them (see `src/station/stationItems.ts`).
 */
interface PlacementSlot {
  readonly body: InstancedSet;
  readonly bodyEntry: number;
  readonly accent: InstancedSet | null;
  readonly accentEntry: number;
}

export class StationItemInstances {
  readonly group = new THREE.Group();
  readonly bodies = new Map<ItemKind, InstancedSet>();
  readonly accents: InstancedSet[] = [];
  /** Upper bound on draw calls: one per kind present, one per accent shape. */
  readonly drawCalls: number;

  /** Indexed by the caller's `placements` array. */
  private readonly slots: PlacementSlot[] = [];

  constructor(
    materials: StationMaterials,
    placements: readonly ItemPlacement[],
    opts: ItemInstanceOptions = {},
  ) {
    this.group.name = opts.name ?? 'station-items';

    const byKind = new Map<ItemKind, InstanceEntry[]>();
    const byShape = new Map<AccentShape, AccentPlacement[]>();
    /** placement index → (kind, entry-within-kind, shape, entry-within-shape). */
    const routing: Array<{
      kind: ItemKind;
      bodyEntry: number;
      shape: AccentShape | null;
      accentEntry: number;
    }> = [];

    for (const p of placements) {
      const model = itemModel(p.kind);
      let list = byKind.get(p.kind);
      if (!list) {
        list = [];
        byKind.set(p.kind, list);
      }
      const bodyEntry = list.length;
      list.push({ module: p.module, matrix: p.matrix });

      if (opts.accents === false) {
        routing.push({ kind: p.kind, bodyEntry, shape: null, accentEntry: -1 });
        continue;
      }
      const shape = opts.accentShape ?? model.accent.shape;
      let spots = byShape.get(shape);
      if (!spots) {
        spots = [];
        byShape.set(shape, spots);
      }
      routing.push({ kind: p.kind, bodyEntry, shape, accentEntry: spots.length });
      spots.push({
        module: p.module,
        interact: 'carryable',
        matrix: accentMatrix(model.accent.at, model.accent.normal, p.matrix),
      });
    }

    for (const [kind, entries] of byKind) {
      // The geometry is CLONED per set because `InstancedSet.dispose()` disposes
      // whatever it was handed, and the cached model geometry outlives any one
      // set of instances.
      const set = new InstancedSet(
        itemGeometry(kind).clone(),
        materials.vertexPainted,
        entries,
        `items-${kind}`,
      );
      this.bodies.set(kind, set);
      this.group.add(set.mesh);
    }

    const accentByShape = new Map<AccentShape, InstancedSet>();
    for (const [shape, spots] of byShape) {
      const set = new InstancedSet(
        accentGeometry(shape).clone(),
        materials.interact,
        spots.map((s) => ({ module: s.module, matrix: s.matrix })),
        `item-accents-${shape}`,
      );
      this.accents.push(set);
      accentByShape.set(shape, set);
      this.group.add(set.mesh);
    }

    for (const route of routing) {
      const body = this.bodies.get(route.kind);
      if (!body) continue; // unreachable: every kind in `routing` built a set
      this.slots.push({
        body,
        bodyEntry: route.bodyEntry,
        accent: route.shape ? (accentByShape.get(route.shape) ?? null) : null,
        accentEntry: route.accentEntry,
      });
    }

    this.drawCalls = this.bodies.size + this.accents.length;
  }

  /**
   * Show or hide ONE world item — body and lamp together — addressed by its
   * index in the `placements` array this was built from.
   *
   * A hidden instance is packed out of the buffer by `InstancedSet`, so it costs
   * nothing to draw and nothing to bring back. Nothing is created or destroyed.
   */
  setPlacementHidden(placement: number, hidden: boolean): void {
    const slot = this.slots[placement];
    if (!slot) return;
    slot.body.setInstanceHidden(slot.bodyEntry, hidden);
    slot.accent?.setInstanceHidden(slot.accentEntry, hidden);
  }

  isPlacementHidden(placement: number): boolean {
    const slot = this.slots[placement];
    return slot ? slot.body.isInstanceHidden(slot.bodyEntry) : false;
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    for (const set of this.bodies.values()) set.setVisible(visible);
    for (const set of this.accents) set.setVisible(visible);
  }

  dispose(): void {
    for (const set of this.bodies.values()) set.dispose();
    for (const set of this.accents) set.dispose();
    this.bodies.clear();
    this.accents.length = 0;
    this.slots.length = 0;
    this.group.clear();
  }
}

/**
 * The accent placement for one world item, for callers batching every amber
 * lamp in the station into a single `buildAccentInstances` call rather than
 * letting `StationItemInstances` make its own.
 */
export function itemAccentPlacement(
  kind: ItemKind,
  module: ModuleId,
  world: THREE.Matrix4,
): AccentPlacement {
  const model = itemModel(kind);
  return {
    module,
    interact: 'carryable',
    matrix: accentMatrix(model.accent.at, model.accent.normal, world),
  };
}

/** The accent shape a kind uses — needed to bucket placements by shape. */
export function itemAccentShape(kind: ItemKind): AccentShape {
  return itemModel(kind).accent.shape;
}

// ---------------------------------------------------------------------------
// The self-check
// ---------------------------------------------------------------------------

/**
 * Minimum log-ratio separation, on at least one sorted extent, between any two
 * carryables. 0.25 is a factor of 1.28 — the point at which two objects are
 * different *sizes* rather than the same object measured twice.
 */
export const SILHOUETTE_JND = 0.25;
/**
 * The medkit/decoy pair gets a wider margin. Grabbing one for the other is a
 * death (§10 revival versus §5's loudness-70 throw), so a factor of 1.28 is not
 * enough: they must differ by 1.4× on some axis AND belong to different profile
 * classes.
 */
export const SILHOUETTE_JND_LETHAL = 0.33;
/** How far a built envelope may drift from the bible's longest dimension. */
export const SCALE_TOLERANCE = 0.06;

export class ItemCoherenceError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(`items: ${failures.length} coherence failure(s):\n  - ${failures.join('\n  - ')}`);
    this.name = 'ItemCoherenceError';
    this.failures = failures;
  }
}

/** Sorted extents, largest first. The shape signature a torch beam resolves. */
function extents(model: ItemModel): [number, number, number] {
  const e = [model.size.x, model.size.y, model.size.z].sort((a, b) => b - a);
  return [e[0] as number, e[1] as number, e[2] as number];
}

/** Largest log-ratio between two signatures — how different two outlines are. */
export function silhouetteDistance(a: ItemModel, b: ItemModel): number {
  const ea = extents(a);
  const eb = extents(b);
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    const x = Math.max(1e-6, ea[i] as number);
    const y = Math.max(1e-6, eb[i] as number);
    worst = Math.max(worst, Math.abs(Math.log(x / y)));
  }
  return worst;
}

/**
 * Prove the six carryables are what the bible asked for. Everything checked here
 * is something a plausible edit could quietly break.
 */
export function assertItemsCoherent(materials?: StationMaterials): void {
  const failures: string[] = [];
  const built = ITEM_KINDS.map((k) => itemModel(k));

  for (const model of built) {
    const spec = model.spec;
    const tag = `${spec.designation} ${spec.label}`;

    // 1. Triangles, against the bible's own band for this asset.
    const budget = checkPolyBudget(model.geometry, spec.budget, tag);
    if (budget.over || budget.under) failures.push(budget.message);

    // 2. Attributes. Anything missing `color` renders black on the vertex-painted
    //    material; anything non-indexed refuses to merge or instance.
    const attrs = Object.keys(model.geometry.attributes).sort();
    for (const need of ['color', 'normal', 'position', 'uv']) {
      if (!attrs.includes(need)) failures.push(`${tag}: geometry has no "${need}" attribute`);
    }
    if (!model.geometry.index) failures.push(`${tag}: geometry is not indexed`);

    // 3. It rests on y = 0. An item whose box floats hangs in the air above a
    //    shelf; one that dips sinks into the deck.
    const bb = model.geometry.boundingBox as THREE.Box3;
    if (Math.abs(bb.min.y) > 0.0015) {
      failures.push(
        `${tag}: rests at y = ${bb.min.y.toFixed(4)}, not 0 — a placement at DECK_Y_M would ` +
          `${bb.min.y > 0 ? 'float' : 'sink'} by ${Math.abs(bb.min.y * 1000).toFixed(1)} mm`,
      );
    }

    // 4. Scale. Doll furniture is the most common failure in this kind of work.
    const longest = Math.max(model.size.x, model.size.y, model.size.z);
    const drift = Math.abs(longest - spec.bibleLongest) / spec.bibleLongest;
    if (drift > SCALE_TOLERANCE) {
      failures.push(
        `${tag}: longest dimension ${longest.toFixed(3)} m is ${(drift * 100).toFixed(1)}% off ` +
          `the bible's ${spec.bibleLongest} m (tolerance ${SCALE_TOLERANCE * 100}%)`,
      );
    }

    // 5. The grip is somewhere on the object. A grip outside the body would make
    //    a held item float beside the hand.
    const grip = new THREE.Vector3(spec.grip.x, spec.grip.y, spec.grip.z);
    if (bb.distanceToPoint(grip) > 0.02) {
      failures.push(
        `${tag}: grip ${JSON.stringify(spec.grip)} is ` +
          `${(bb.distanceToPoint(grip) * 1000).toFixed(0)} mm outside the body`,
      );
    }

    // 6. The accent sits ON a surface, not adrift, and its normal is a direction.
    const spot = new THREE.Vector3(model.accent.at.x, model.accent.at.y, model.accent.at.z);
    if (bb.distanceToPoint(spot) > 0.01) {
      failures.push(`${tag}: accent is off the body by ${(bb.distanceToPoint(spot) * 1000).toFixed(0)} mm`);
    }
    const n = new THREE.Vector3(model.accent.normal.x, model.accent.normal.y, model.accent.normal.z);
    if (n.lengthSq() < 1e-6) failures.push(`${tag}: accent normal is zero`);
  }

  // 7. Silhouette separation. Six distinct profile classes, and no two envelopes
  //    close enough to be the same object measured twice.
  const seen = new Map<ItemProfile, ItemKind>();
  for (const model of built) {
    const other = seen.get(model.spec.profile);
    if (other) {
      failures.push(
        `${model.kind} and ${other} are both profile "${model.spec.profile}" — two carryables ` +
          `must never share a shape class`,
      );
    }
    seen.set(model.spec.profile, model.kind);
  }
  for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
      const a = built[i] as ItemModel;
      const b = built[j] as ItemModel;
      const lethal =
        (a.kind === 'medkit' && b.kind === 'decoy') || (a.kind === 'decoy' && b.kind === 'medkit');
      const need = lethal ? SILHOUETTE_JND_LETHAL : SILHOUETTE_JND;
      const d = silhouetteDistance(a, b);
      if (d < need) {
        failures.push(
          `${a.kind} and ${b.kind} differ by only ${d.toFixed(3)} in log-extent (need ` +
            `${need})${lethal ? ' — and confusing these two is a death' : ''}`,
        );
      }
    }
  }

  // 8. The draw-call promise: every body on ONE material, every lamp on the
  //    accent. Only checkable with real materials, so it is opt-in.
  if (materials) {
    const bodyMaterials = new Set<THREE.Material>();
    for (const kind of ITEM_KINDS) {
      const group = buildItemMesh(kind, materials, { name: `check-${kind}` });
      let accents = 0;
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (o.userData.accent) {
          accents++;
          if (mesh.material !== materials.interact) {
            failures.push(`${kind}: accent is not on materials.interact`);
          }
          if (o.userData.accent !== 'carryable') {
            failures.push(`${kind}: accent claims interact "${String(o.userData.accent)}"`);
          }
        } else {
          bodyMaterials.add(mesh.material as THREE.Material);
        }
      });
      if (accents !== 1) failures.push(`${kind}: ${accents} accents, expected exactly 1`);
      if (countAccents(buildHeldItem(kind, materials)) !== 1) {
        failures.push(`${kind}: held form does not carry exactly one accent`);
      }
    }
    if (bodyMaterials.size !== 1) {
      failures.push(
        `carryable bodies use ${bodyMaterials.size} materials — they must share exactly one ` +
          `(materials.vertexPainted), or world instancing costs a draw call per material per kind`,
      );
    }
  }

  if (failures.length > 0) throw new ItemCoherenceError(failures);
}

function isDevEnvironment(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env && typeof env.DEV === 'boolean') return env.DEV;
  } catch {
    /* import.meta.env is absent under plain Node — fall through. */
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc && proc.env) return proc.env.NODE_ENV !== 'production';
  return true;
}

/**
 * True when the geometry half of the check ran and passed at import (dev only).
 *
 * It also warms the model cache, which is exactly what you want before
 * `Renderer.prewarm()`. The material half needs a `StationMaterials` and so runs
 * only when someone calls `assertItemsCoherent(materials)`.
 */
export const ITEMS_CHECKED: boolean = (() => {
  if (!isDevEnvironment()) return false;
  assertItemsCoherent();
  return true;
})();
