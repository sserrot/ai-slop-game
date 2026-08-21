/**
 * src/station/stationItems.ts — the six carryables, placed in the level.
 *
 * `items.ts` is the geometry and the two forms (world / held); this is the file
 * that decides WHERE the world form goes and what makes one appear or vanish.
 *
 * THE RULE THAT SHAPES IT: nothing may be created after `Renderer.prewarm()`.
 * A locker's contents are rolled from the round seed, and the server re-rolls
 * them at `roundStart`, so building an item mesh when a locker turns out to hold
 * one would allocate geometry and link a program on first sight of that locker —
 * exactly the first-visit hitch the pre-warm exists to pay off. So every slot
 * that could EVER hold something exists from load: three per locker, one for
 * each kind a locker can hold (`sequence-card`, `fuse`, `decoy`), plus the three
 * kinds no locker holds. Appearing and vanishing is `setInstanceHidden` on an
 * already-built instance — a few float copies, no allocation, no draw call for a
 * hidden one.
 *
 * WHERE THEY SIT
 *
 *   • IN A LOCKER CAVITY. `buildLockerParts` makes the locker a five-slab cavity
 *     with two dividers at ±0.115, so the three bays are real and each slot goes
 *     in one of them. The item's rest origin sits on the cavity's inner face with
 *     its own +Y along the locker's +Y, which `kit.ts` points into the room — so
 *     an item reads as stowed against the back of the box and is legible the
 *     moment the door swings up.
 *   • ON A RACK FACE, like the stowage bags: the rack's local +Y is the wall
 *     normal, so `+RACK_DEPTH/2` along it is the face and the item stands on it.
 *   • FLOATING, in an authored `zero` module. There is no floor to sit on and no
 *     physics to drift with, so it is placed off-axis and tilted: in a room with
 *     no down, a tilted object at chest height reads as adrift.
 *
 * The medkit, the extinguisher and the pry bar have no spawner anywhere in the
 * game — `planLockerContents` only ever hides the card, the fuses and the decoys
 * — so they are placed as fixed level furniture. That is not a stopgap: §10's
 * revival needs a medkit to exist somewhere, §4 spends the extinguisher as a
 * thruster, and §11's jammed lockers want a pry bar findable before you need it.
 */

import * as THREE from 'three';
import type { ModuleId, PropRef, StationLayout, StationModule } from '@shared/types';
import { PROP_ARCHETYPES } from './kit';
import type { ItemKind, ItemPlacement } from './items';
import { StationItemInstances } from './items';
import type { StationItem, StationItemKind } from './lockerContents';
import type { StationMaterials } from './materials';
import { moduleMatrix, propMatrix } from './threeUtil';

/** The three kinds a locker can hold, in slot order. */
export const LOCKER_ITEM_KINDS: readonly ItemKind[] = Object.freeze([
  'sequence-card',
  'fuse',
  'decoy',
]);

/** `StationItemKind` (what the locker plan speaks) → `ItemKind` (what the art
 *  speaks). The card is the only one whose name differs. */
export function itemKindOf(kind: StationItemKind): ItemKind {
  return kind === 'breaker-card' ? 'sequence-card' : kind;
}

/** Local offsets of the three cavity bays, in the locker prop's own frame. */
function lockerSlotOffset(slot: number): THREE.Vector3 {
  const s = PROP_ARCHETYPES.locker.size;
  // The cavity floor is `t` thick at −s.y/2; sit on it with a hair of clearance.
  const y = -s.y / 2 + 0.03 + 0.004;
  // Pitch derived from the carcass rather than typed at 0.22: the locker came
  // down from 0.72 to 0.60 across in the art pass, and a fixed pitch would have
  // parked the outer two bays 0.02 m inside the end walls with a 0.14 m decoy
  // sitting in them. `s.x / 2 − 0.11` keeps the outer bay a decoy's half-width
  // plus the 0.03 m wall clear of the end, at any carcass size.
  const pitch = Math.min(0.22, s.x / 2 - 0.11);
  return new THREE.Vector3((slot - 1) * pitch, y, 0);
}

function offsetMatrix(parent: THREE.Matrix4, offset: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4().multiplyMatrices(
    parent,
    new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z),
  );
}

interface LockerSlotIndex {
  /** Placement index per kind, in `LOCKER_ITEM_KINDS` order. */
  readonly byKind: Map<ItemKind, number>;
  /** What this round's plan (or the room's own records) put in here. */
  readonly present: Set<ItemKind>;
  /** True once somebody has swung the door. A shut locker is a steel box: what
   *  is inside it is not visible, and neither is its amber lamp. */
  open: boolean;
}

/**
 * Every loose carryable in the level: one `InstancedMesh` per kind plus one
 * accent set, module-culled, and nothing built after construction.
 */
export class StationItems {
  readonly group = new THREE.Group();
  readonly instances: StationItemInstances;
  /** Locker prop id → its three slots. */
  private readonly lockers = new Map<string, LockerSlotIndex>();
  /** Placement indices that are always visible (the three fixed items). */
  private readonly fixed: number[] = [];
  /** Show everything regardless of state — the pre-warm's one frame. */
  private prewarm = false;

  constructor(layout: StationLayout, materials: StationMaterials) {
    this.group.name = 'station-items';

    const placements: ItemPlacement[] = [];

    for (const module of layout.modules) {
      const mMatrix = moduleMatrix(module);
      for (const prop of module.props) {
        if (prop.kind !== 'locker') continue;
        const world = new THREE.Matrix4().multiplyMatrices(mMatrix, propMatrix(prop));
        const byKind = new Map<ItemKind, number>();
        for (let slot = 0; slot < LOCKER_ITEM_KINDS.length; slot++) {
          const kind = LOCKER_ITEM_KINDS[slot] as ItemKind;
          byKind.set(kind, placements.length);
          placements.push({
            kind,
            module: module.id,
            matrix: offsetMatrix(world, lockerSlotOffset(slot)),
          });
        }
        this.lockers.set(prop.id, { byKind, present: new Set<ItemKind>(), open: false });
      }
    }

    for (const fixed of planFixedItems(layout)) {
      this.fixed.push(placements.length);
      placements.push(fixed);
    }

    // One accent SHAPE for the lot. Per-kind shapes are worth paying for in the
    // hand and at two metres (see `ItemInstanceOptions.accentShape`); thirty
    // world instances across a nine-module station are not.
    this.instances = new StationItemInstances(materials, placements, {
      accentShape: 'dot',
      name: 'station-item-instances',
    });
    this.group.add(this.instances.group);

    // Every locker starts shut, so every slot starts dark: `setLockerContents`
    // says what is in them and `setLockerOpen` is what reveals it.
    for (const index of this.lockers.values()) this.apply(index);
  }

  /** Upper bound on draw calls: one per kind present plus one accent set. */
  get drawCalls(): number {
    return this.instances.drawCalls;
  }

  /** Show exactly what this round's plan puts in each locker (§5, §11). */
  setLockerContents(plan: ReadonlyMap<string, readonly StationItem[]>): void {
    for (const [lockerId, index] of this.lockers) {
      const contents = plan.get(lockerId) ?? EMPTY_CONTENTS;
      index.present.clear();
      for (const item of contents) index.present.add(itemKindOf(item.kind));
      this.apply(index);
    }
  }

  /**
   * Put one kind exactly where the SERVER says it is, and nowhere else.
   *
   * The client's own `planLockerContents` is a deterministic mirror, but the
   * room's puzzle state is the truth: `FuseHuntState.fuses[i].locker` and
   * `BreakerState.card.locker` are the authoritative locations, and a fuse that
   * has been picked up or fitted has to leave the locker it was in. Pass the
   * lockers that still hold one; every other slot of that kind goes dark.
   */
  setKindLocations(kind: ItemKind, lockerIds: Iterable<string>): void {
    const wanted = new Set(lockerIds);
    for (const [lockerId, index] of this.lockers) {
      if (!index.byKind.has(kind)) continue;
      if (wanted.has(lockerId)) index.present.add(kind);
      else index.present.delete(kind);
      this.apply(index);
    }
  }

  /** The door swung. A shut locker shows nothing — not the item, not its lamp. */
  setLockerOpen(lockerId: string, open: boolean): void {
    const index = this.lockers.get(lockerId);
    if (!index || index.open === open) return;
    index.open = open;
    this.apply(index);
  }

  /** Somebody took it out (`kind`), or took everything (`kind` omitted). */
  takeFrom(lockerId: string, kind?: ItemKind): void {
    const index = this.lockers.get(lockerId);
    if (!index) return;
    if (kind) index.present.delete(kind);
    else index.present.clear();
    this.apply(index);
  }

  /** What this locker holds right now, door or no door. */
  contentsOf(lockerId: string): ItemKind[] {
    const index = this.lockers.get(lockerId);
    return index ? [...index.present] : [];
  }

  /**
   * Force every slot visible for the pre-warm's one full-pipeline frame.
   *
   * Without this the card, fuse and decoy meshes would have zero live instances
   * behind the menu — every locker starts shut — so `compileAsync` would link
   * their program but the frame would upload none of their vertex buffers, and
   * the first locker anybody opened would pay for three of them. Turn it off
   * again immediately after; the state is unchanged underneath.
   */
  setPrewarm(on: boolean): void {
    if (this.prewarm === on) return;
    this.prewarm = on;
    for (const index of this.lockers.values()) this.apply(index);
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    this.instances.setVisible(visible);
  }

  dispose(): void {
    this.instances.dispose();
    this.group.clear();
    this.lockers.clear();
  }

  /** One locker's three slots, from its state. Idempotent and allocation-free. */
  private apply(index: LockerSlotIndex): void {
    for (const [kind, placement] of index.byKind) {
      const shown = this.prewarm || (index.open && index.present.has(kind));
      this.instances.setPlacementHidden(placement, !shown);
    }
  }
}

const EMPTY_CONTENTS: readonly StationItem[] = Object.freeze([]);

/**
 * The three carryables no locker ever holds, placed as level furniture.
 *
 * Derived from the layout rather than authored per level, so a second map gets
 * them too: the first two nominal modules with a rack get the medkit and the
 * extinguisher on a rack face, and the first authored `zero` module gets the pry
 * bar adrift in it. A layout with neither falls back rather than dropping the
 * item, because an unreachable medkit is a round §10 cannot resolve.
 */
function planFixedItems(layout: StationLayout): ItemPlacement[] {
  const out: ItemPlacement[] = [];
  const racked: Array<{ module: StationModule; prop: PropRef }> = [];
  const floating: StationModule[] = [];

  for (const module of layout.modules) {
    if (module.gravity === 'zero') floating.push(module);
    const rack = module.props.find((p) => p.kind === 'rack');
    if (rack && module.gravity !== 'zero') racked.push({ module, prop: rack });
  }

  const onRack = (kind: ItemKind, host: { module: StationModule; prop: PropRef } | undefined) => {
    if (!host) return;
    const depth = PROP_ARCHETYPES.rack.size.y;
    const world = new THREE.Matrix4().multiplyMatrices(
      moduleMatrix(host.module),
      propMatrix(host.prop),
    );
    out.push({
      kind,
      module: host.module.id,
      // On the face, a third of the way up the rack: `rack`'s local +Y is the
      // wall normal and its local +Z runs along the module axis.
      matrix: offsetMatrix(world, new THREE.Vector3(0, depth / 2 + 0.002, -0.3)),
    });
  };

  onRack('medkit', racked[0]);
  onRack('extinguisher', racked[1] ?? racked[0]);

  const drift = floating[0];
  if (drift) {
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, 0.4, -0.9));
    out.push({
      kind: 'pry-bar',
      module: drift.id,
      matrix: new THREE.Matrix4()
        .multiplyMatrices(
          moduleMatrix(drift),
          new THREE.Matrix4().compose(
            new THREE.Vector3(0.22, 0.18, 0.9),
            tilt,
            new THREE.Vector3(1, 1, 1),
          ),
        ),
    });
  } else {
    onRack('pry-bar', racked[2] ?? racked[0]);
  }

  return out;
}
