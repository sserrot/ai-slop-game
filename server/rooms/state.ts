/**
 * Colyseus room state (DESIGN.md §7).
 *
 *   players: { id, pos, quat, state, gripId, alive }[]
 *   alien:   { pos, quat, state }
 *   hatches: { portId, open, sealed }[]
 *   puzzles: { id, state, solved }[]
 *   director:{ stage, systemsOnline }
 *
 * Two deliberate shape changes from that sketch, both noted in the foundation's
 * API contract:
 *
 * - The three "[]" collections are `MapSchema`s keyed by their natural id
 *   (session id / `${module}:${port}` / puzzle id). Colyseus encodes a keyed
 *   removal far more cheaply than an array splice, and every one of these
 *   collections is looked up by id far more often than it is iterated.
 * - `Puzzle.state` is `unknown` in `@shared/types`; the wire cannot carry
 *   `unknown`, so it travels as `stateJson`. Puzzle handlers own the shape;
 *   the client `JSON.parse`s it.
 *
 * Field sets otherwise follow `@shared/types` exactly — `module`, `charge` and
 * `heartRate` are on the player because noise resolution (§3), the charge arc
 * (§4) and the breathing loop (§6) cannot work without them.
 */

import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';
import type {
  AlienSnapshot,
  DirectorSnapshot,
  Gait,
  GravityMode,
  HatchSnapshot,
  ModuleGravitySnapshot,
  PlayerSnapshot,
  PlayerState,
  PuzzleSnapshot,
  Quat,
  StationState,
  Vec3,
} from '@shared/types';
import { MAX_DIRECTOR_STAGE } from '@shared/constants';

export class Vec3Schema extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;

  set(v: Vec3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  toVec3(): Vec3 {
    return { x: this.x, y: this.y, z: this.z };
  }
}

export class QuatSchema extends Schema {
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('number') w = 1;

  set(q: Quat): this {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  toQuat(): Quat {
    return { x: this.x, y: this.y, z: this.z, w: this.w };
  }
}

export class PlayerSchema extends Schema {
  @type('string') id = '';
  /** Display name, purely cosmetic. */
  @type('string') name = '';
  @type(Vec3Schema) pos = new Vec3Schema();
  @type(QuatSchema) quat = new QuatSchema();
  /** `PlayerState` (§4 FSM) as a string — schema has no union type. */
  @type('string') state = 'FLOATING';
  /** RailKey being gripped. Empty string encodes `null` (§7 `gripId`). */
  @type('string') gripId = '';
  @type('string') module = '';
  @type('boolean') alive = true;
  /** 0–1 push-off charge, only meaningful while CHARGING (§4). */
  @type('number') charge = 0;
  /** bpm — drives the breathing loop's 6–14 loudness (§6). */
  @type('number') heartRate = 60;
  /** Reached the capsule (§11). Escaped players are alive but out of the sim. */
  @type('boolean') escaped = false;
  /** Module a dead player is watching through the cameras (§10 spectating). */
  @type('string') spectating = '';
  /** Carried items — medkit, decoy, fuse… (§10, §5, §11). */
  @type(['string']) items = new ArraySchema<string>();
  /**
   * `Gait` — crouch / walk / sprint. Meaningful while GROUNDED or AIRBORNE, and
   * carried in every other state so a `liftoff` still knows what you were doing.
   * The server re-derives footstep and landing loudness from it (§14), so it is
   * authoritative state, not decoration.
   */
  @type('string') gait = 'walk';
  /** `HideSpotKey` being occupied. Empty string encodes `null`. Non-empty
   *  implies `state === 'HIDDEN'`. */
  @type('string') hideSpot = '';

  toSnapshot(): PlayerSnapshot {
    return {
      id: this.id,
      pos: this.pos.toVec3(),
      quat: this.quat.toQuat(),
      state: this.state as PlayerState,
      gripId: this.gripId === '' ? null : this.gripId,
      module: this.module,
      alive: this.alive,
      charge: this.charge,
      heartRate: this.heartRate,
      gait: this.gait as Gait,
      hideSpot: this.hideSpot === '' ? null : this.hideSpot,
    };
  }
}

/**
 * Per-module gravity (the walking pivot), synced continuously rather than only
 * as the ephemeral `gravity` message.
 *
 * Continuous because a client that joins late — or that missed one broadcast —
 * still has to know which rooms have a floor, and getting that wrong is a player
 * walking into a wall or stepping off one. The `gravity` message is the
 * ANNOUNCEMENT (with its `GRAVITY_WARNING_S` of warning); this map is the truth.
 *
 * The server is authoritative for it: `ModuleGraph.setGravity` /
 * `scheduleGravity` / `tickGravity` run on the server only, and this map mirrors
 * `ModuleGraph.gravitySnapshot()` every tick it changes.
 */
export class ModuleGravitySchema extends Schema {
  @type('string') module = '';
  /** `GravityMode` in effect right now — 'nominal' | 'zero'. */
  @type('string') gravity = 'nominal';
  /** Announced change that has not landed yet. Empty string encodes `null`. */
  @type('string') pending = '';
  /** ms until `pending` takes effect. 0 when `pending` is empty. */
  @type('number') pendingMs = 0;

  toSnapshot(): ModuleGravitySnapshot {
    const pending = this.pending === '' ? null : (this.pending as GravityMode);
    return {
      module: this.module,
      gravity: this.gravity as GravityMode,
      pending,
      pendingMs: pending === null ? 0 : this.pendingMs,
    };
  }

  /** Write one `ModuleGravitySnapshot` in. Returns true if anything changed —
   *  the room uses that to avoid re-broadcasting an unchanged map. */
  apply(snap: ModuleGravitySnapshot): boolean {
    const pending = snap.pending ?? '';
    const pendingMs = snap.pending === null ? 0 : Math.max(0, Math.round(snap.pendingMs));
    let changed = false;
    if (this.module !== snap.module) {
      this.module = snap.module;
      changed = true;
    }
    if (this.gravity !== snap.gravity) {
      this.gravity = snap.gravity;
      changed = true;
    }
    if (this.pending !== pending) {
      this.pending = pending;
      changed = true;
    }
    // Quantised to 100 ms: the countdown ticks 20 times a second and nothing
    // downstream needs that resolution, but every write is a schema delta.
    const quantised = Math.round(pendingMs / 100) * 100;
    if (this.pendingMs !== quantised) {
      this.pendingMs = quantised;
      changed = true;
    }
    return changed;
  }
}

export class AlienSchema extends Schema {
  @type(Vec3Schema) pos = new Vec3Schema();
  @type(QuatSchema) quat = new QuatSchema();
  /** `AlienState` (§5 FSM) as a string. */
  @type('string') state = 'DORMANT';
  @type('string') module = '';

  toSnapshot(): AlienSnapshot {
    return {
      pos: this.pos.toVec3(),
      quat: this.quat.toQuat(),
      state: this.state as AlienSnapshot['state'],
      module: this.module,
    };
  }
}

export class HatchSchema extends Schema {
  /** `${ModuleId}:${PortId}` — `portKey()` from `@shared/graph/moduleGraph`. */
  @type('string') portId = '';
  @type('boolean') open = true;
  /** Powered lock. Blocks the alien; costs one of SEAL_CHARGES (§5). */
  @type('boolean') sealed = false;

  toSnapshot(): HatchSnapshot {
    return { portId: this.portId, open: this.open, sealed: this.sealed };
  }
}

export class PuzzleSchema extends Schema {
  @type('string') id = '';
  @type('string') module = '';
  /** `Puzzle.state` serialised — the puzzle's own handler owns the shape. */
  @type('string') stateJson = '{}';
  @type('boolean') solved = false;
  /** Escape systems this puzzle unlocks (§11 `gates`). */
  @type(['string']) gates = new ArraySchema<string>();

  toSnapshot(): PuzzleSnapshot {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(this.stateJson);
    } catch {
      parsed = {};
    }
    return { id: this.id as PuzzleSnapshot['id'], state: parsed, solved: this.solved };
  }
}

export class DirectorSchema extends Schema {
  @type('number') stage = 0;
  @type('number') systemsOnline = 0;
  /** ms until the free escalation (§14 STAGE_TIMEOUT_MS). */
  @type('number') msToNextFreeStage = 0;

  toSnapshot(): DirectorSnapshot {
    const stage = Math.max(0, Math.min(MAX_DIRECTOR_STAGE, Math.round(this.stage)));
    return {
      stage: stage as DirectorSnapshot['stage'],
      systemsOnline: this.systemsOnline,
      msToNextFreeStage: this.msToNextFreeStage,
    };
  }
}

export class StationRoomState extends Schema {
  @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();
  @type(AlienSchema) alien = new AlienSchema();
  @type({ map: HatchSchema }) hatches = new MapSchema<HatchSchema>();
  @type({ map: PuzzleSchema }) puzzles = new MapSchema<PuzzleSchema>();
  @type(DirectorSchema) director = new DirectorSchema();
  /** Per-module gravity, keyed by ModuleId (the walking pivot). */
  @type({ map: ModuleGravitySchema }) gravity = new MapSchema<ModuleGravitySchema>();

  /** Server tick (§7, 20 Hz). */
  @type('number') tick = 0;
  /** `RoundPhase` — 'LOBBY' | 'RUNNING' | 'ENDED'. */
  @type('string') phase = 'LOBBY';
  /** Layout id, so a client can tell it loaded the right station. */
  @type('string') layoutId = '';
  /** Decoys left in the world (§5: two per round, no respawn). */
  @type('number') decoysRemaining = 0;
  /** Hatch seal charges left (§5: two per round). */
  @type('number') sealCharges = 0;
  /** `Date.now()` when the round started; 0 in LOBBY. */
  @type('number') startedAtMs = 0;

  /** Plain-object mirror, matching `StationState` in `@shared/types`. */
  toSnapshot(): StationState {
    const players: PlayerSnapshot[] = [];
    this.players.forEach((p) => players.push(p.toSnapshot()));
    const hatches: HatchSnapshot[] = [];
    this.hatches.forEach((h) => hatches.push(h.toSnapshot()));
    const puzzles: PuzzleSnapshot[] = [];
    this.puzzles.forEach((p) => puzzles.push(p.toSnapshot()));
    const gravity: ModuleGravitySnapshot[] = [];
    this.gravity.forEach((g) => gravity.push(g.toSnapshot()));
    return {
      players,
      alien: this.alien.toSnapshot(),
      hatches,
      puzzles,
      director: this.director.toSnapshot(),
      gravity,
      tick: this.tick,
    };
  }
}
