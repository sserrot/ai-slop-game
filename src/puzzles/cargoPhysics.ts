/**
 * Puzzle 3 · CARGO STOW — the physics half (DESIGN.md §1, §11).
 *
 * Five numbered bags, rigid bodies, CLIENT-AUTHORITATIVE with the nearest
 * player as owner. §1's r1 reversal deleted server-side physics outright:
 * "running WASM Rapier in Node and keeping rigid-body state in lockstep is a
 * real integration tax for five bags. Instead: the nearest player is authority
 * for a bag (owner simulates, server relays)."
 *
 * So: every client runs this world. The owner of a bag integrates it and
 * broadcasts the result; everybody else pins that bag to whatever the owner
 * last said. Ownership changes when someone else is meaningfully closer, with
 * enough hysteresis that two players either side of a bag do not fight over it.
 *
 * The noise contract is the point of the puzzle: a bag that hits a bulkhead
 * hard emits `cargo-bounce` (30) — "push one too hard and it bounces off a
 * bulkhead at loudness 30, then keeps bouncing, and now you have five problems".
 * Nudges below `BOUNCE_MIN_SPEED` are free, which is what makes gentle-and-slow
 * a real strategy rather than a slogan.
 *
 * Rapier is imported DYNAMICALLY — statically it inlines ~2.8 MB of base64 wasm
 * into the main chunk and blocks first paint.
 */

import type { ModuleId, NoiseIntentMessage, PlayerId, Quat, Vec3 } from '@shared/types';
import { CARGO_BAG_COUNT } from '@shared/constants';
import { cargoBagId, cargoSlotId } from './logic/index';

type RapierModule = typeof import('@dimforge/rapier3d-compat');
type RapierWorld = import('@dimforge/rapier3d-compat').World;
type RapierBody = import('@dimforge/rapier3d-compat').RigidBody;

// --- Local tuning. Not §14 constants; §14's contribution here is
//     LOUDNESS.CARGO_BOUNCE (30), reached through the 'cargo-bounce' kind. -----

/** m/s of speed LOST in one contact before it counts as a bang. */
export const BOUNCE_MIN_SPEED = 1.0;
/** Seconds a bag stays quiet after banging, so one collision is one sound. */
export const BOUNCE_COOLDOWN_S = 0.35;
/** A bag this slow inside its slot latches home. */
export const STOW_SPEED = 0.35;
/** Seconds it must stay slow and inside before latching. */
export const STOW_SETTLE_S = 0.3;
/** Metres a rival must beat the current owner by before ownership moves. */
export const OWNERSHIP_HYSTERESIS_M = 0.75;
/** Fixed physics step. Rapier wants a constant timestep. */
export const PHYSICS_STEP_S = 1 / 60;
/** Never integrate more than this many substeps in one frame. */
export const MAX_SUBSTEPS = 4;
/** Half-extents of a standard cargo bag, metres. */
export const BAG_HALF_EXTENTS: Vec3 = { x: 0.22, y: 0.16, z: 0.3 };

export interface CargoBagSpec {
  id: string;
  /** Slot this bag belongs in. */
  slot: string;
  pos: Vec3;
  quat?: Quat;
  halfExtents?: Vec3;
  /** kg. Heavy bags are harder to stop, which is the dexterity in the puzzle. */
  mass?: number;
}

export interface CargoSlotSpec {
  id: string;
  bagId: string;
  /** Trigger volume centre and half-extents, world space. */
  centre: Vec3;
  halfExtents: Vec3;
}

/** Static geometry the bags bounce off: bulkheads, the rack, a crate. */
export interface CargoStaticSpec {
  centre: Vec3;
  halfExtents: Vec3;
  /**
   * Orientation in WORLD space. Omit for axis-aligned.
   *
   * Needed because modules are placed with arbitrary rotations (§2 — the level
   * mates kit pieces through ports), so the walls of the module the bags are
   * in are almost never axis-aligned. Without this the bulkheads a bag bounces
   * off are in a different place from the ones you can see.
   */
  quat?: Quat;
}

export interface CargoBagsOptions {
  module: ModuleId;
  bags: readonly CargoBagSpec[];
  slots: readonly CargoSlotSpec[];
  statics?: readonly CargoStaticSpec[];
  /** Who we are. Determines which bags we simulate rather than mirror. */
  localPlayerId: PlayerId;
  /** A bag hit something hard. Send this straight down the `noise` channel. */
  onNoise?: (intent: NoiseIntentMessage) => void;
  /** A bag latched into its slot. Send `interact { 'cargo-stow', 'stow', id }`. */
  onStow?: (bagId: string) => void;
  /** Owner-side transform broadcast. Relay it to the other clients. */
  onTransform?: (bagId: string, pos: Vec3, quat: Quat) => void;
  /** Broadcast rate for owned bags. Default 20 Hz — the server tick (§7). */
  transformHz?: number;
}

interface BagRuntime {
  spec: CargoBagSpec;
  body: RapierBody;
  slot: CargoSlotSpec | null;
  owner: PlayerId | null;
  stowed: boolean;
  settle: number;
  cooldown: number;
  lastSpeed: number;
  /** Last transform an owner sent us, for bags we do not own. */
  remote: { pos: Vec3; quat: Quat } | null;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/** Default bag/slot pair layout along a rack — good enough to grey-box with. */
export function defaultCargoLayout(rackCentre: Vec3): {
  bags: CargoBagSpec[];
  slots: CargoSlotSpec[];
} {
  const bags: CargoBagSpec[] = [];
  const slots: CargoSlotSpec[] = [];
  for (let i = 0; i < CARGO_BAG_COUNT; i++) {
    const offset = (i - (CARGO_BAG_COUNT - 1) / 2) * 0.7;
    bags.push({
      id: cargoBagId(i),
      slot: cargoSlotId(i),
      // Loose, floating a little away from the rack — they start as a problem.
      pos: { x: rackCentre.x + offset, y: rackCentre.y + 0.9, z: rackCentre.z - 0.6 },
      mass: 8,
    });
    slots.push({
      id: cargoSlotId(i),
      bagId: cargoBagId(i),
      centre: { x: rackCentre.x + offset, y: rackCentre.y, z: rackCentre.z },
      halfExtents: { x: 0.3, y: 0.24, z: 0.36 },
    });
  }
  return { bags, slots };
}

export class CargoBags {
  readonly module: ModuleId;
  private rapier: RapierModule | null = null;
  private world: RapierWorld | null = null;
  private readonly bagRuntimes = new Map<string, BagRuntime>();
  private readonly options: CargoBagsOptions;
  private localPlayer: PlayerId;
  private accumulator = 0;
  private broadcastAccum = 0;
  private readonly broadcastPeriod: number;
  private disposed = false;

  private constructor(opts: CargoBagsOptions) {
    this.options = opts;
    this.module = opts.module;
    this.localPlayer = opts.localPlayerId;
    this.broadcastPeriod = 1 / Math.max(1, opts.transformHz ?? 20);
  }

  /** Build the world. Loads Rapier on first use — keep it off the critical path. */
  static async create(opts: CargoBagsOptions): Promise<CargoBags> {
    const bags = new CargoBags(opts);
    await bags.init();
    return bags;
  }

  private async init(): Promise<void> {
    const RAPIER = (await import('@dimforge/rapier3d-compat')) as RapierModule;
    await RAPIER.init();
    this.rapier = RAPIER;

    // Zero gravity. Nobody walks (pillar 2), and neither does the cargo.
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    world.timestep = PHYSICS_STEP_S;
    this.world = world;

    for (const spec of this.options.statics ?? []) {
      const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(
        spec.centre.x,
        spec.centre.y,
        spec.centre.z,
      );
      if (spec.quat) desc.setRotation(spec.quat);
      const body = world.createRigidBody(desc);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(
          spec.halfExtents.x,
          spec.halfExtents.y,
          spec.halfExtents.z,
        ).setRestitution(0.35),
        body,
      );
    }

    for (const spec of this.options.bags) {
      const half = spec.halfExtents ?? BAG_HALF_EXTENTS;
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spec.pos.x, spec.pos.y, spec.pos.z)
        // Air drag: bags coast, they do not sail forever. §4 half-life thinking
        // applied to cargo — Rapier's damping is per-second, which is fine here
        // because it is Rapier's own integrator, not our fixed step.
        .setLinearDamping(0.25)
        .setAngularDamping(0.35);
      if (spec.quat) desc.setRotation(spec.quat);
      const body = world.createRigidBody(desc);
      const collider = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setRestitution(0.45)
        .setFriction(0.6);
      const mass = spec.mass ?? 8;
      collider.setDensity(mass / (8 * half.x * half.y * half.z));
      world.createCollider(collider, body);

      this.bagRuntimes.set(spec.id, {
        spec,
        body,
        slot: this.options.slots.find((s) => s.bagId === spec.id) ?? null,
        owner: null,
        stowed: false,
        settle: 0,
        cooldown: 0,
        lastSpeed: 0,
        remote: null,
      });
    }
  }

  get ready(): boolean {
    return this.world !== null && !this.disposed;
  }

  /** Change identity after a reconnect. */
  setLocalPlayer(id: PlayerId): void {
    this.localPlayer = id;
  }

  bagIds(): string[] {
    return [...this.bagRuntimes.keys()];
  }

  ownerOf(bagId: string): PlayerId | null {
    return this.bagRuntimes.get(bagId)?.owner ?? null;
  }

  isStowed(bagId: string): boolean {
    return this.bagRuntimes.get(bagId)?.stowed ?? false;
  }

  transform(bagId: string): { pos: Vec3; quat: Quat } | null {
    const bag = this.bagRuntimes.get(bagId);
    if (!bag) return null;
    const t = bag.body.translation();
    const r = bag.body.rotation();
    return { pos: { x: t.x, y: t.y, z: t.z }, quat: { x: r.x, y: r.y, z: r.z, w: r.w } };
  }

  /** Shove a bag. This is what "push one too hard" means, mechanically. */
  push(bagId: string, impulse: Vec3): void {
    const bag = this.bagRuntimes.get(bagId);
    if (!bag || bag.stowed) return;
    bag.body.applyImpulse(impulse, true);
  }

  /** Carry it: park the bag at a point with no velocity, e.g. in front of a hand. */
  hold(bagId: string, pos: Vec3, quat?: Quat): void {
    const bag = this.bagRuntimes.get(bagId);
    if (!bag || bag.stowed) return;
    bag.owner = this.localPlayer;
    bag.body.setTranslation(pos, true);
    if (quat) bag.body.setRotation(quat, true);
    bag.body.setLinvel(ZERO, true);
    bag.body.setAngvel(ZERO, true);
    // Catching a drifting bag arrests it in one step, which `detectBounces`
    // would otherwise read as a large loss of speed and report as a 30. A hand
    // is not a bulkhead: the whole puzzle is that you can arrest a bag quietly
    // if you get to it in time, and charging for it would delete that.
    bag.lastSpeed = 0;
  }

  /** True while this bag is being carried by the local player. */
  isHeldLocally(bagId: string): boolean {
    const bag = this.bagRuntimes.get(bagId);
    return bag !== undefined && !bag.stowed && bag.owner === this.localPlayer;
  }

  /** How many are home. `CARGO_BAG_COUNT` of them and ballast trim is online. */
  get stowedCount(): number {
    let n = 0;
    for (const bag of this.bagRuntimes.values()) if (bag.stowed) n++;
    return n;
  }

  /** Where a bag is supposed to end up, world space. Null if it has no slot. */
  slotCentre(bagId: string): Vec3 | null {
    const slot = this.bagRuntimes.get(bagId)?.slot;
    return slot ? { ...slot.centre } : null;
  }

  /** Release with a velocity — gently, if you have any sense. */
  release(bagId: string, velocity: Vec3 = ZERO): void {
    const bag = this.bagRuntimes.get(bagId);
    if (!bag || bag.stowed) return;
    bag.body.setLinvel(velocity, true);
  }

  /** A remote owner told us where their bag is. */
  applyRemote(bagId: string, pos: Vec3, quat: Quat, owner: PlayerId): void {
    const bag = this.bagRuntimes.get(bagId);
    if (!bag) return;
    bag.owner = owner;
    bag.remote = { pos: { ...pos }, quat: { ...quat } };
  }

  /** The server says this bag is stowed — latch it even if we did not see it. */
  markStowed(bagId: string): void {
    const bag = this.bagRuntimes.get(bagId);
    if (!bag || bag.stowed) return;
    bag.stowed = true;
    if (bag.slot) {
      bag.body.setTranslation(bag.slot.centre, true);
      bag.body.setLinvel(ZERO, true);
      bag.body.setAngvel(ZERO, true);
    }
  }

  /**
   * Step the world. `players` is everyone in this module, world positions —
   * ownership is "nearest player", so it has to be recomputed as people move.
   */
  step(dt: number, players: readonly { id: PlayerId; pos: Vec3 }[]): void {
    const world = this.world;
    if (!world || this.disposed) return;

    this.assignOwners(players);

    // Fixed-step integration with a bounded catch-up.
    this.accumulator = Math.min(this.accumulator + dt, PHYSICS_STEP_S * MAX_SUBSTEPS);
    let steps = 0;
    while (this.accumulator >= PHYSICS_STEP_S && steps < MAX_SUBSTEPS) {
      this.pinNonOwned();
      world.step();
      this.accumulator -= PHYSICS_STEP_S;
      steps++;
      this.detectBounces(PHYSICS_STEP_S);
    }

    this.checkSlots(dt);
    this.broadcast(dt);
  }

  private assignOwners(players: readonly { id: PlayerId; pos: Vec3 }[]): void {
    if (players.length === 0) return;
    for (const bag of this.bagRuntimes.values()) {
      if (bag.stowed) continue;
      const t = bag.body.translation();
      let best: PlayerId | null = null;
      let bestDist = Number.MAX_VALUE;
      let currentDist = Number.MAX_VALUE;
      for (const p of players) {
        const dx = p.pos.x - t.x;
        const dy = p.pos.y - t.y;
        const dz = p.pos.z - t.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (p.id === bag.owner) currentDist = d;
        if (d < bestDist) {
          bestDist = d;
          best = p.id;
        }
      }
      if (bag.owner === null) {
        bag.owner = best;
      } else if (best !== bag.owner && bestDist < currentDist - OWNERSHIP_HYSTERESIS_M) {
        bag.owner = best;
      }
    }
  }

  /** Bags we do not own are not simulated — they are whatever their owner said. */
  private pinNonOwned(): void {
    for (const bag of this.bagRuntimes.values()) {
      if (bag.stowed) {
        if (bag.slot) {
          bag.body.setTranslation(bag.slot.centre, false);
          bag.body.setLinvel(ZERO, false);
          bag.body.setAngvel(ZERO, false);
        }
        continue;
      }
      if (bag.owner === this.localPlayer || bag.owner === null) continue;
      if (!bag.remote) continue;
      bag.body.setTranslation(bag.remote.pos, false);
      bag.body.setRotation(bag.remote.quat, false);
      bag.body.setLinvel(ZERO, false);
      bag.body.setAngvel(ZERO, false);
    }
  }

  /**
   * A bang is a large loss of speed in one step. Cheaper and more predictable
   * than contact-force events, and it maps exactly onto the design's rule:
   * hitting something hard is loud, drifting into it is not.
   */
  private detectBounces(dt: number): void {
    for (const bag of this.bagRuntimes.values()) {
      if (bag.cooldown > 0) bag.cooldown -= dt;
      const v = bag.body.linvel();
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      const lost = bag.lastSpeed - speed;
      bag.lastSpeed = speed;
      if (bag.stowed) continue;
      // Only OUR bags report noise; the owner is the authority (§1).
      if (bag.owner !== this.localPlayer) continue;
      if (bag.cooldown > 0) continue;
      if (lost < BOUNCE_MIN_SPEED) continue;

      bag.cooldown = BOUNCE_COOLDOWN_S;
      const t = bag.body.translation();
      this.options.onNoise?.({
        kind: 'cargo-bounce',
        pos: { x: t.x, y: t.y, z: t.z },
        module: this.module,
      });
    }
  }

  private checkSlots(dt: number): void {
    for (const bag of this.bagRuntimes.values()) {
      if (bag.stowed || !bag.slot) continue;
      if (bag.owner !== this.localPlayer) continue;
      const t = bag.body.translation();
      const s = bag.slot;
      const inside =
        Math.abs(t.x - s.centre.x) <= s.halfExtents.x &&
        Math.abs(t.y - s.centre.y) <= s.halfExtents.y &&
        Math.abs(t.z - s.centre.z) <= s.halfExtents.z;
      const v = bag.body.linvel();
      const slow = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) < STOW_SPEED;
      if (inside && slow) {
        bag.settle += dt;
        if (bag.settle >= STOW_SETTLE_S) {
          bag.stowed = true;
          bag.body.setTranslation(s.centre, true);
          bag.body.setLinvel(ZERO, true);
          bag.body.setAngvel(ZERO, true);
          this.options.onStow?.(bag.spec.id);
        }
      } else {
        bag.settle = 0;
      }
    }
  }

  private broadcast(dt: number): void {
    if (!this.options.onTransform) return;
    this.broadcastAccum += dt;
    if (this.broadcastAccum < this.broadcastPeriod) return;
    this.broadcastAccum = 0;
    for (const bag of this.bagRuntimes.values()) {
      if (bag.stowed || bag.owner !== this.localPlayer) continue;
      const t = bag.body.translation();
      const r = bag.body.rotation();
      this.options.onTransform(
        bag.spec.id,
        { x: t.x, y: t.y, z: t.z },
        { x: r.x, y: r.y, z: r.z, w: r.w },
      );
    }
  }

  /**
   * Put every bag back where the level put it.
   *
   * A new round re-runs `CargoStowPuzzle.reset()` on the server, which unstows
   * every bag in the authoritative state — so without this the client would
   * keep five bags latched into slots the server no longer believes are full,
   * and the puzzle would look solved and be unsolvable. Rebuilding the Rapier
   * world instead would mean paying for the wasm import again.
   */
  reset(): void {
    for (const bag of this.bagRuntimes.values()) {
      bag.stowed = false;
      bag.settle = 0;
      bag.cooldown = 0;
      bag.lastSpeed = 0;
      bag.owner = null;
      bag.remote = null;
      bag.body.setTranslation(bag.spec.pos, true);
      if (bag.spec.quat) bag.body.setRotation(bag.spec.quat, true);
      bag.body.setLinvel(ZERO, true);
      bag.body.setAngvel(ZERO, true);
    }
    this.accumulator = 0;
    this.broadcastAccum = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bagRuntimes.clear();
    this.world?.free();
    this.world = null;
    this.rapier = null;
  }
}
