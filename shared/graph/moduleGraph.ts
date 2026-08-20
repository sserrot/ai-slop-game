/**
 * The station module graph (DESIGN.md §2).
 *
 * "One data structure drives level layout, sound propagation, AI pathfinding, and
 * render culling." This is it. Identical code runs on the client and the server.
 */

import {
  ATTENUATION_PER_M,
  FLOOR,
  GRAVITY_WARNING_S,
  HATCH_CLOSED,
  HATCH_OPEN,
  HATCH_SEALED,
  ZERO_G_AUTHORED_MAX,
  ZERO_G_FRACTION_MAX,
} from '@shared/constants';
import type {
  GravityCause,
  GravityMode,
  GravityShiftEvent,
  HatchState,
  ModuleArrival,
  ModuleGravitySnapshot,
  ModuleId,
  Port,
  PortId,
  PortRef,
  StationModule,
  Vec3,
} from '@shared/types';
import { distance, localToWorld, localToWorldInto } from '@shared/graph/math';

// ---------------------------------------------------------------------------
// Propagation workspace
// ---------------------------------------------------------------------------

/** A pooled arrival record. `portRef` is the record's own `throughPort`, kept
 *  alongside so a reused arrival never has to mint one. */
interface PooledArrival extends ModuleArrival {
  portRef: PortRef;
}

/**
 * Everything `bfsAttenuated` needs to run without allocating.
 *
 * CALLER-OWNED, and that is the whole design. `shared/` runs on the Node
 * server, where several rooms propagate inside one process and a module-level
 * scratch would let one room's walk overwrite another's mid-flight. One
 * workspace per room (or per client) and the re-entrancy problem does not
 * exist — the same rule `projectOnSegmentInto` and `railQueryBuffer` follow.
 *
 * The arrivals it hands back are POOLED: read them, never keep them past the
 * next walk on the same workspace.
 */
export interface ArrivalWorkspace {
  arrivals: Map<ModuleId, ModuleArrival>;
  open: ModuleArrival[];
  settled: Set<ModuleId>;
  /** Grown on demand, never shrunk — a station has 8–10 modules. */
  pool: PooledArrival[];
  used: number;
}

/** Shared empty edge list, so a dead-end module costs no array. */
const NO_EDGES: readonly ModuleEdge[] = Object.freeze([]);

export function arrivalWorkspace(): ArrivalWorkspace {
  return { arrivals: new Map(), open: [], settled: new Set(), pool: [], used: 0 };
}

function takeArrival(work: ArrivalWorkspace): PooledArrival {
  const pool = work.pool;
  if (work.used === pool.length) {
    pool.push({
      module: '',
      level: 0,
      hops: 0,
      distance: 0,
      hatchDb: 0,
      worstHatchDb: 0,
      throughPort: null,
      entryPoint: { x: 0, y: 0, z: 0 },
      via: null,
      portRef: { module: '', port: '' },
    });
  }
  return pool[work.used++]!;
}

// ---------------------------------------------------------------------------
// Hatch attenuation
// ---------------------------------------------------------------------------

/**
 * Authoritative dB offset for a hatch, computed from `open`/`sealed`.
 * NEGATIVE, matching §14 and `Port.hatch.attenuationDb`: add it to a level.
 *
 * `sealed` wins over `open` — a sealed hatch is a powered lock and is closed by
 * definition.
 */
export function hatchAttenuationDb(hatch: HatchState): number {
  if (hatch.sealed) return HATCH_SEALED;
  return hatch.open ? HATCH_OPEN : HATCH_CLOSED;
}

/** The same value as a positive magnitude, for the §3 formula's `Σ hatchAttenuation`. */
export function hatchAttenuationMagnitude(hatch: HatchState): number {
  return -hatchAttenuationDb(hatch);
}

/** True if this hatch muffles as well as attenuates — drives the §8 400 Hz lowpass. */
export function isOccluding(hatch: HatchState): boolean {
  return hatch.sealed || !hatch.open;
}

/** Refresh the denormalised `attenuationDb` cache on a port. */
export function syncHatchAttenuation(port: Port): Port {
  port.hatch.attenuationDb = hatchAttenuationDb(port.hatch);
  return port;
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/** One directed traversal from a module, out through a port, into a neighbour. */
export interface ModuleEdge {
  from: ModuleId;
  /** The port in `from` you leave through. */
  fromPort: Port;
  to: ModuleId;
  /** The port in `to` you arrive through. §8 pans cross-module sound HERE. */
  toPort: Port;
  /** World position of `fromPort` (== `toPort`; ports are snapped together). */
  worldPos: Vec3;
  /**
   * World position of `toPort`, measured in the NEIGHBOUR's own frame.
   *
   * Nominally the same point as `worldPos` — ports are snapped together — but
   * authored layouts are only snapped to within a tolerance, and §8 pans
   * cross-module sound at the port the listener's module owns. Cached here
   * because the propagation walk asked for it per edge per noise event, and
   * `portWorldPos` builds a `"module:port"` key string and two vectors to
   * answer: measured at ~100 B per module reached, ~840 B per event.
   */
  toPortWorldPos: Vec3;
  /**
   * dB offset for crossing this edge, ≤ 0. Both ports carry a hatch; the more
   * attenuating of the two wins, so authoring one side is enough and sealing
   * either side seals the pair.
   */
  attenuationDb: number;
  /** True if either side is closed or sealed. */
  occluding: boolean;
  /** True if either side is sealed — the alien cannot open it (§5). */
  sealed: boolean;
  /** True only if both sides are open. */
  open: boolean;
  /** Straight-line metres between the two module centres. */
  centreDistance: number;
}

/** Predicate deciding whether the alien / a player / sound may cross an edge. */
export type EdgeFilter = (edge: ModuleEdge) => boolean;

/** Sound crosses everything; the hatch just costs dB. */
export const PASSABLE_SOUND: EdgeFilter = () => true;
/** Players and rendering: only through open hatches (§2 two-hop culling). */
export const PASSABLE_OPEN_ONLY: EdgeFilter = (e) => e.open;
/** The alien: opens closed hatches in 3s at loudness 45, but never sealed ones (§5). */
export const PASSABLE_ALIEN: EdgeFilter = (e) => !e.sealed;

// ---------------------------------------------------------------------------
// Pathfinding options
// ---------------------------------------------------------------------------

export interface PathOptions {
  /** Which edges may be crossed. Defaults to `PASSABLE_ALIEN`. */
  passable?: EdgeFilter;
  /** Cost of crossing one edge, in metres-equivalent. Defaults to centre distance,
   *  plus a penalty for a closed hatch the mover has to open. */
  edgeCost?: (edge: ModuleEdge) => number;
}

export interface HopOptions {
  passable?: EdgeFilter;
  /** Stop expanding past this many hops. Defaults to unlimited. */
  maxHops?: number;
}

export interface PropagationOptions {
  /** Defaults to `ATTENUATION_PER_M` (§14). */
  attenuationPerM?: number;
  /** Stop expanding when the level drops below this. Defaults to `FLOOR` (§14). */
  floor?: number;
  /** Hard cap on hatches crossed. Defaults to unlimited (the floor does the work). */
  maxHops?: number;
  /** Which edges sound may cross. Defaults to `PASSABLE_SOUND` — everything. */
  passable?: EdgeFilter;
}

// ---------------------------------------------------------------------------
// ModuleGraph
// ---------------------------------------------------------------------------

/** An announced gravity change that has not landed yet. */
interface PendingGravity {
  to: GravityMode;
  cause: GravityCause;
  /** ms remaining until it takes effect. */
  msLeft: number;
}

export class ModuleGraph {
  private readonly _modules = new Map<ModuleId, StationModule>();
  private readonly _edges = new Map<ModuleId, ModuleEdge[]>();
  private readonly _ports = new Map<string, Port>();
  /** The value the LEVEL authored, so `resetGravity()` can put the station back
   *  and `validate()` can audit what a designer asked for as distinct from what
   *  the §5 director has since done to it. */
  private readonly _authoredGravity = new Map<ModuleId, GravityMode>();
  private readonly _pendingGravity = new Map<ModuleId, PendingGravity>();

  constructor(modules: readonly StationModule[]) {
    for (const m of modules) {
      if (this._modules.has(m.id)) {
        throw new Error(`ModuleGraph: duplicate module id '${m.id}'`);
      }
      // Normalise before anything reads it. A layout parsed from raw JSON that
      // predates the field arrives with `gravity` undefined, and the pivot's
      // default is that a level which says nothing has floors everywhere —
      // zero-G has to be asked for.
      if (m.gravity !== 'zero' && m.gravity !== 'nominal') m.gravity = 'nominal';
      this._authoredGravity.set(m.id, m.gravity);
      this._modules.set(m.id, m);
      this._edges.set(m.id, []);
      for (const p of m.ports) {
        this._ports.set(portKey(m.id, p.id), p);
      }
    }
    this.rebuildEdges();
  }

  // -- gravity (the walking pivot) -----------------------------------------
  //
  // Gravity is per-module state that changes AT RUNTIME: the §5 escalation
  // director drops a module's plant mid-round, and a §11 puzzle can bring it
  // back. It is stored on `StationModule.gravity` and mutated IN PLACE, exactly
  // the way `Port.hatch` is — so every consumer that already holds the layout
  // sees the change with nothing to invalidate and no cache to rebuild. Rail
  // queries read it live (see `RailGraph.railsActive`), which is why a hatch
  // swinging shut and a floor letting go behave the same way mid-frame.
  //
  // NOTE what is deliberately absent: gravity plays no part in noise
  // propagation or in `findPath`. Sound crosses both kinds of module unchanged,
  // and the alien walks through both. Only the RAIL queries are scoped.

  /** The mode in effect right now. Unknown modules report `'nominal'` — a
   *  caller asking about a module that does not exist should not be told the
   *  floor is missing. */
  gravityOf(id: ModuleId): GravityMode {
    return this._modules.get(id)?.gravity ?? 'nominal';
  }

  /** The value the level file authored, ignoring anything the director has done. */
  authoredGravity(id: ModuleId): GravityMode {
    return this._authoredGravity.get(id) ?? 'nominal';
  }

  /** True if the module currently has no floor — i.e. §4's zero-G controller
   *  and the rail graph are the ones in charge there. */
  isZeroG(id: ModuleId): boolean {
    return this.gravityOf(id) === 'zero';
  }

  /** True if the module currently has a floor along `STATION_DOWN`. */
  hasFloor(id: ModuleId): boolean {
    return this.gravityOf(id) === 'nominal';
  }

  /**
   * Set a module's gravity IMMEDIATELY, cancelling any pending change.
   * Returns true if it actually changed.
   *
   * Prefer `scheduleGravity()` for anything the player is meant to survive:
   * `GRAVITY_WARNING_S` of audible warning is the fairness guarantee that keeps
   * this mechanic inside pillar 3. Use this one for the authoritative apply at
   * the end of that timer, for a snapshot reconciliation, or for a round reset.
   */
  setGravity(id: ModuleId, mode: GravityMode): boolean {
    const module = this._modules.get(id);
    if (!module) return false;
    this._pendingGravity.delete(id);
    if (module.gravity === mode) return false;
    module.gravity = mode;
    return true;
  }

  /**
   * Announce a change that lands `delayMs` from now, and return the event to
   * broadcast (§7 `gravity`). Returns null if the module is unknown or is
   * already in that mode with nothing pending.
   *
   * The caller is expected to emit a `gravity-shift` NoiseEvent at
   * `LOUDNESS.GRAVITY_SHIFT` from the MODULE CENTRE alongside this — the plant
   * makes the noise, not whoever happens to be standing under it.
   */
  scheduleGravity(
    id: ModuleId,
    mode: GravityMode,
    cause: GravityCause,
    tick: number,
    delayMs: number = GRAVITY_WARNING_S * 1000,
  ): GravityShiftEvent | null {
    const module = this._modules.get(id);
    if (!module) return null;
    const pending = this._pendingGravity.get(id);

    // Already there and nothing about to move it: nothing to announce.
    if (module.gravity === mode && !pending) return null;

    // Already there, but something was about to change it — call that off. This
    // is the "the puzzle got fixed in time" path, and it must not then fire.
    if (module.gravity === mode) {
      this._pendingGravity.delete(id);
      return null;
    }

    // Already heading there: report the timer that is RUNNING rather than
    // restarting it. Re-announcing must never extend the warning, or a director
    // that re-evaluates every tick would hold the floor up forever.
    if (pending && pending.to === mode) {
      return {
        module: id,
        from: module.gravity,
        to: mode,
        cause: pending.cause,
        inMs: pending.msLeft,
        t: tick,
      };
    }

    const ms = Math.max(0, delayMs);
    const from = module.gravity;
    if (ms === 0) {
      this._pendingGravity.delete(id);
      module.gravity = mode;
      return { module: id, from, to: mode, cause, inMs: 0, t: tick };
    }
    this._pendingGravity.set(id, { to: mode, cause, msLeft: ms });
    return { module: id, from, to: mode, cause, inMs: ms, t: tick };
  }

  /** The announced-but-not-landed change for a module, or null. */
  pendingGravity(id: ModuleId): { to: GravityMode; cause: GravityCause; ms: number } | null {
    const p = this._pendingGravity.get(id);
    return p ? { to: p.to, cause: p.cause, ms: p.msLeft } : null;
  }

  /** Call off an announced change. Returns true if there was one. */
  cancelPendingGravity(id: ModuleId): boolean {
    return this._pendingGravity.delete(id);
  }

  /**
   * Advance every pending gravity timer by `dtMs` and commit the ones that
   * expire. Returns one event per module that actually flipped.
   *
   * Both sides run this: the server authoritatively, the client locally so the
   * floor lets go on the frame the audio says it will rather than a round trip
   * later. The server's `StationState.gravity` corrects any drift, exactly as
   * it does for every other piece of state in §7.
   */
  tickGravity(dtMs: number, tick = 0): GravityShiftEvent[] {
    if (this._pendingGravity.size === 0) return [];
    const events: GravityShiftEvent[] = [];
    for (const [id, pending] of [...this._pendingGravity]) {
      pending.msLeft -= dtMs;
      if (pending.msLeft > 0) continue;
      const module = this._modules.get(id);
      this._pendingGravity.delete(id);
      if (!module || module.gravity === pending.to) continue;
      const from = module.gravity;
      module.gravity = pending.to;
      events.push({ module: id, from, to: pending.to, cause: pending.cause, inMs: 0, t: tick });
    }
    return events;
  }

  /** Every module currently in this mode. */
  modulesWithGravity(mode: GravityMode): ModuleId[] {
    const out: ModuleId[] = [];
    for (const m of this._modules.values()) if (m.gravity === mode) out.push(m.id);
    return out;
  }

  /** How many modules currently have no floor. The §5 director's budget
   *  (`DirectorStageConfig.gravityFailures`) is measured against this. */
  zeroGCount(): number {
    let n = 0;
    for (const m of this._modules.values()) if (m.gravity === 'zero') n++;
    return n;
  }

  /** Wire form of the whole station's gravity (§7 `StationState.gravity`). */
  gravitySnapshot(): ModuleGravitySnapshot[] {
    const out: ModuleGravitySnapshot[] = [];
    for (const m of this._modules.values()) {
      const pending = this._pendingGravity.get(m.id);
      out.push({
        module: m.id,
        gravity: m.gravity,
        pending: pending ? pending.to : null,
        pendingMs: pending ? pending.msLeft : 0,
      });
    }
    return out;
  }

  /** Apply a server snapshot. Returns the modules whose committed mode changed,
   *  so the client can react to exactly those and no others. */
  applyGravitySnapshot(
    snapshots: readonly ModuleGravitySnapshot[],
    cause: GravityCause = 'director',
  ): ModuleId[] {
    const changed: ModuleId[] = [];
    for (const snap of snapshots) {
      const module = this._modules.get(snap.module);
      if (!module) continue;
      if (module.gravity !== snap.gravity) {
        module.gravity = snap.gravity;
        changed.push(snap.module);
      }
      if (snap.pending === null || snap.pending === snap.gravity) {
        this._pendingGravity.delete(snap.module);
      } else {
        this._pendingGravity.set(snap.module, {
          to: snap.pending,
          cause,
          msLeft: Math.max(0, snap.pendingMs),
        });
      }
    }
    return changed;
  }

  /** Put every module back to the value the level authored and drop all pending
   *  changes. Round reset. Returns the modules that changed. */
  resetGravity(): ModuleId[] {
    this._pendingGravity.clear();
    const changed: ModuleId[] = [];
    for (const m of this._modules.values()) {
      const authored = this._authoredGravity.get(m.id) ?? 'nominal';
      if (m.gravity !== authored) {
        m.gravity = authored;
        changed.push(m.id);
      }
    }
    return changed;
  }

  /** Recompute every edge. Call after mutating hatch state in bulk; individual
   *  hatch toggles are read live, so this is only needed if `link`s change. */
  rebuildEdges(): void {
    for (const list of this._edges.values()) list.length = 0;

    for (const m of this._modules.values()) {
      for (const port of m.ports) {
        const link = port.link;
        if (!link) continue;
        const other = this._modules.get(link.module);
        if (!other) {
          throw new Error(
            `ModuleGraph: module '${m.id}' port '${port.id}' links to unknown module '${link.module}'`,
          );
        }
        const otherPort = this._ports.get(portKey(link.module, link.port));
        if (!otherPort) {
          throw new Error(
            `ModuleGraph: module '${m.id}' port '${port.id}' links to unknown port '${link.module}:${link.port}'`,
          );
        }
        this._edges.get(m.id)!.push(this.makeEdge(m, port, other, otherPort));
      }
    }
  }

  private makeEdge(
    from: StationModule,
    fromPort: Port,
    to: StationModule,
    toPort: Port,
  ): ModuleEdge {
    return {
      from: from.id,
      fromPort,
      to: to.id,
      toPort,
      worldPos: localToWorld(fromPort.localPos, from.transform),
      toPortWorldPos: localToWorld(toPort.localPos, to.transform),
      // Live getters would be nicer, but edges are cheap to read and hatch state
      // changes at human speed; `refreshEdge` below keeps them current.
      attenuationDb: Math.min(hatchAttenuationDb(fromPort.hatch), hatchAttenuationDb(toPort.hatch)),
      occluding: isOccluding(fromPort.hatch) || isOccluding(toPort.hatch),
      sealed: fromPort.hatch.sealed || toPort.hatch.sealed,
      open: fromPort.hatch.open && toPort.hatch.open && !fromPort.hatch.sealed && !toPort.hatch.sealed,
      centreDistance: distance(from.transform.pos, to.transform.pos),
    };
  }

  /**
   * Re-derive the cached hatch fields on every edge from the live `Port.hatch`
   * values. Cheap (one pass over edges); call it after any hatch open/close/seal.
   */
  refreshHatches(): void {
    for (const list of this._edges.values()) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!;
        // In place, not a replacement edge: the geometry fields (`worldPos`,
        // `toPortWorldPos`, `centreDistance`) cannot change, only the four
        // hatch-derived ones — and rebuilding every edge object on every hatch
        // cycle handed the GC a burst at exactly the moment a door is swinging.
        const fromHatch = e.fromPort.hatch;
        const toHatch = e.toPort.hatch;
        e.attenuationDb = Math.min(hatchAttenuationDb(fromHatch), hatchAttenuationDb(toHatch));
        e.occluding = isOccluding(fromHatch) || isOccluding(toHatch);
        e.sealed = fromHatch.sealed || toHatch.sealed;
        e.open = fromHatch.open && toHatch.open && !fromHatch.sealed && !toHatch.sealed;
      }
    }
  }

  // -- lookups --------------------------------------------------------------

  get size(): number {
    return this._modules.size;
  }

  ids(): ModuleId[] {
    return [...this._modules.keys()];
  }

  all(): StationModule[] {
    return [...this._modules.values()];
  }

  has(id: ModuleId): boolean {
    return this._modules.has(id);
  }

  get(id: ModuleId): StationModule | undefined {
    return this._modules.get(id);
  }

  /** Throws if the module is missing — use where absence is a bug, not a case. */
  require(id: ModuleId): StationModule {
    const m = this._modules.get(id);
    if (!m) throw new Error(`ModuleGraph: unknown module '${id}'`);
    return m;
  }

  port(moduleId: ModuleId, portId: PortId): Port | undefined {
    return this._ports.get(portKey(moduleId, portId));
  }

  /** World-space position of a port — ALSO the §8 audio panner position. */
  portWorldPos(moduleId: ModuleId, portId: PortId): Vec3 | undefined {
    const m = this._modules.get(moduleId);
    const p = this._ports.get(portKey(moduleId, portId));
    if (!m || !p) return undefined;
    return localToWorld(p.localPos, m.transform);
  }

  /**
   * `portWorldPos` writing into `out`, returning false when the port is
   * unknown. `localToWorld` is `add(applyQuat(…))` — two objects per call, and
   * the propagation walk asks for one per edge on every noise event.
   */
  portWorldPosInto(moduleId: ModuleId, portId: PortId, out: Vec3): boolean {
    const m = this._modules.get(moduleId);
    const p = this._ports.get(portKey(moduleId, portId));
    if (!m || !p) return false;
    localToWorldInto(p.localPos, m.transform, out);
    return true;
  }

  /** Module centre in world space. */
  centre(moduleId: ModuleId): Vec3 | undefined {
    return this._modules.get(moduleId)?.transform.pos;
  }

  edges(moduleId: ModuleId): readonly ModuleEdge[] {
    return this._edges.get(moduleId) ?? [];
  }

  /** The edge leaving `moduleId` through `portId`, if it is linked. */
  edgeThrough(moduleId: ModuleId, portId: PortId): ModuleEdge | undefined {
    return this._edges.get(moduleId)?.find((e) => e.fromPort.id === portId);
  }

  /** The edge from `a` to `b`, if they are directly connected. */
  edgeBetween(a: ModuleId, b: ModuleId): ModuleEdge | undefined {
    return this._edges.get(a)?.find((e) => e.to === b);
  }

  /** All linked neighbours, regardless of hatch state. */
  neighbours(moduleId: ModuleId): ModuleId[] {
    return (this._edges.get(moduleId) ?? []).map((e) => e.to);
  }

  /** Neighbours reachable through OPEN hatches only (§2 culling, player movement). */
  openNeighbours(moduleId: ModuleId): ModuleId[] {
    return (this._edges.get(moduleId) ?? []).filter((e) => e.open).map((e) => e.to);
  }

  // -- hop distance ---------------------------------------------------------

  /**
   * Breadth-first hop count from `origin` to every reachable module.
   * The origin maps to 0.
   */
  hopsFrom(origin: ModuleId, opts: HopOptions = {}): Map<ModuleId, number> {
    const passable = opts.passable ?? PASSABLE_ALIEN;
    const maxHops = opts.maxHops ?? Number.POSITIVE_INFINITY;
    const out = new Map<ModuleId, number>();
    if (!this._modules.has(origin)) return out;

    out.set(origin, 0);
    let frontier: ModuleId[] = [origin];
    let depth = 0;
    while (frontier.length > 0 && depth < maxHops) {
      depth++;
      const next: ModuleId[] = [];
      for (const id of frontier) {
        for (const e of this._edges.get(id) ?? []) {
          if (!passable(e)) continue;
          if (out.has(e.to)) continue;
          out.set(e.to, depth);
          next.push(e.to);
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Hops between two modules, or -1 if unreachable under `opts.passable`. */
  hopDistance(a: ModuleId, b: ModuleId, opts: HopOptions = {}): number {
    if (a === b) return this._modules.has(a) ? 0 : -1;
    const passable = opts.passable ?? PASSABLE_ALIEN;
    const maxHops = opts.maxHops ?? Number.POSITIVE_INFINITY;
    const seen = new Set<ModuleId>([a]);
    let frontier: ModuleId[] = [a];
    let depth = 0;
    while (frontier.length > 0 && depth < maxHops) {
      depth++;
      const next: ModuleId[] = [];
      for (const id of frontier) {
        for (const e of this._edges.get(id) ?? []) {
          if (!passable(e)) continue;
          if (e.to === b) return depth;
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          next.push(e.to);
        }
      }
      frontier = next;
    }
    return -1;
  }

  /** Modules within `hops` of `origin`, inclusive. Two hops is the §2 cull set. */
  withinHops(origin: ModuleId, hops: number, opts: HopOptions = {}): ModuleId[] {
    return [...this.hopsFrom(origin, { ...opts, maxHops: hops }).keys()];
  }

  /** The §2 render set: the player's module plus everything two hops away
   *  through open hatches. */
  cullSet(origin: ModuleId, hops = 2): ModuleId[] {
    return this.withinHops(origin, hops, { passable: PASSABLE_OPEN_ONLY });
  }

  // -- attenuated propagation ----------------------------------------------

  /**
   * Loudest-first expansion from a point inside `originModule`, accumulating
   * distance and hatch attenuation (§3).
   *
   * §3 calls this "BFS outward from the origin module". It is implemented as a
   * best-first (loudest-first) expansion, which is BFS's answer whenever every
   * edge costs the same and strictly better when it does not: a longer detour
   * through open hatches can genuinely beat a short path through a closed one,
   * and plain BFS would report the quieter of the two.
   *
   * Each `ModuleArrival.level` is measured at that module's entry port — the
   * loudest point in the module. Per-listener attenuation is applied by
   * `resolve()` in `noise.ts`.
   */
  bfsAttenuated(
    originModule: ModuleId,
    originPos: Vec3,
    startLevel: number,
    opts: PropagationOptions = {},
    out?: ArrivalWorkspace,
  ): Map<ModuleId, ModuleArrival> {
    const attPerM = opts.attenuationPerM ?? ATTENUATION_PER_M;
    const floor = opts.floor ?? FLOOR;
    const maxHops = opts.maxHops ?? Number.POSITIVE_INFINITY;
    const passable = opts.passable ?? PASSABLE_SOUND;

    // The workspace is CALLER-OWNED, never a module-level singleton: this file
    // is imported by the Node server, where two rooms propagate concurrently
    // inside one process. Omit it and you get a fresh one, which allocates
    // exactly what this function always allocated.
    const work = out ?? arrivalWorkspace();
    const arrivals = work.arrivals;
    const open = work.open;
    const settled = work.settled;
    arrivals.clear();
    settled.clear();
    open.length = 0;
    work.used = 0;

    if (!this._modules.has(originModule)) return arrivals;
    if (startLevel < floor) return arrivals;

    const origin = takeArrival(work);
    origin.module = originModule;
    origin.level = startLevel;
    origin.hops = 0;
    origin.distance = 0;
    origin.hatchDb = 0;
    origin.worstHatchDb = 0;
    origin.throughPort = null;
    origin.entryPoint.x = originPos.x;
    origin.entryPoint.y = originPos.y;
    origin.entryPoint.z = originPos.z;
    origin.via = null;
    arrivals.set(originModule, origin);

    // Small graphs (8–10 modules); a linear scan for the loudest open node is
    // cheaper and simpler than a heap, and this runs 20×/second.
    open.push(origin);

    while (open.length > 0) {
      let bestIndex = 0;
      for (let i = 1; i < open.length; i++) {
        if (open[i]!.level > open[bestIndex]!.level) bestIndex = i;
      }
      // `open.splice(bestIndex, 1)[0]` with the array it returns thrown away.
      // Shifting by hand keeps the surviving order byte for byte — which
      // matters, because a tie is broken by whichever entry the scan above
      // reaches first.
      const current = open[bestIndex]!;
      for (let i = bestIndex; i < open.length - 1; i++) open[i] = open[i + 1]!;
      open.length--;

      if (settled.has(current.module)) continue;
      settled.add(current.module);
      if (current.hops >= maxHops) continue;

      // Index loop over the graph's own edge array: `for…of` mints an array
      // iterator per module per event, and `?? []` mints an empty array for
      // every dead end.
      const edges = this._edges.get(current.module) ?? NO_EDGES;
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei]!;
        if (!passable(e)) continue;
        if (settled.has(e.to)) continue;

        // Travel from where the sound entered this module out to the port…
        const legMetres = distance(current.entryPoint, e.worldPos);
        const distanceOut = current.distance + legMetres;
        const hatchDb = current.hatchDb + e.attenuationDb;
        const level = startLevel - attPerM * distanceOut + hatchDb;
        if (level < floor) continue; // §3: stop expanding when level < FLOOR

        const existing = arrivals.get(e.to);
        if (existing && existing.level >= level) continue;

        const next = takeArrival(work);
        next.module = e.to;
        next.level = level;
        next.hops = current.hops + 1;
        next.distance = distanceOut;
        next.hatchDb = hatchDb;
        next.worstHatchDb = Math.min(current.worstHatchDb, e.attenuationDb);
        // …then it re-enters at the neighbour's own port. That port is what §8
        // pans at for anyone listening in `e.to`.
        next.portRef.module = e.to;
        next.portRef.port = e.toPort.id;
        next.throughPort = next.portRef;
        // `edge.toPortWorldPos` IS `portWorldPos(e.to, e.toPort.id)`, computed
        // once when the edge was built — same port object, same transform.
        next.entryPoint.x = e.toPortWorldPos.x;
        next.entryPoint.y = e.toPortWorldPos.y;
        next.entryPoint.z = e.toPortWorldPos.z;
        next.via = current.module;
        arrivals.set(e.to, next);
        open.push(next);
      }
    }

    return arrivals;
  }

  // -- A* -------------------------------------------------------------------

  /**
   * A* over the module graph (§5 PATROL / INVESTIGATE navigation).
   * Returns the module chain including both endpoints, or null if unreachable.
   *
   * Default cost is straight-line metres between module centres, plus a 6m
   * penalty for a closed hatch the mover has to spend HATCH_OPEN_TIME on — so
   * the alien prefers an open route when one exists but will not refuse to
   * open a door.
   */
  findPath(from: ModuleId, to: ModuleId, opts: PathOptions = {}): ModuleId[] | null {
    if (!this._modules.has(from) || !this._modules.has(to)) return null;
    if (from === to) return [from];

    const passable = opts.passable ?? PASSABLE_ALIEN;
    const edgeCost = opts.edgeCost ?? defaultEdgeCost;
    const goal = this.require(to).transform.pos;

    const gScore = new Map<ModuleId, number>([[from, 0]]);
    const cameFrom = new Map<ModuleId, ModuleId>();
    const closed = new Set<ModuleId>();
    const open = new Map<ModuleId, number>([
      [from, distance(this.require(from).transform.pos, goal)],
    ]);

    while (open.size > 0) {
      let current: ModuleId | null = null;
      let bestF = Number.POSITIVE_INFINITY;
      for (const [id, f] of open) {
        if (f < bestF) {
          bestF = f;
          current = id;
        }
      }
      if (current === null) break;
      if (current === to) return reconstruct(cameFrom, current);

      open.delete(current);
      closed.add(current);
      const currentG = gScore.get(current) ?? Number.POSITIVE_INFINITY;

      for (const e of this._edges.get(current) ?? []) {
        if (!passable(e)) continue;
        if (closed.has(e.to)) continue;
        const tentative = currentG + edgeCost(e);
        if (tentative >= (gScore.get(e.to) ?? Number.POSITIVE_INFINITY)) continue;
        cameFrom.set(e.to, current);
        gScore.set(e.to, tentative);
        // Heuristic: straight-line distance. Admissible — the default edge cost
        // is centre-to-centre distance plus a non-negative penalty.
        open.set(e.to, tentative + distance(this.require(e.to).transform.pos, goal));
      }
    }
    return null;
  }

  /** Nearest module (by centre distance) to a world position. Cheap fallback for
   *  "which module am I in" when you have no better answer. */
  nearestModule(worldPos: Vec3): ModuleId | null {
    let best: ModuleId | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const m of this._modules.values()) {
      const d = distance(worldPos, m.transform.pos);
      if (d < bestD) {
        bestD = d;
        best = m.id;
      }
    }
    return best;
  }

  /** Every module reachable from `origin`. Use it to validate an authored layout. */
  connectedComponent(origin: ModuleId, opts: HopOptions = {}): Set<ModuleId> {
    return new Set(this.hopsFrom(origin, { passable: PASSABLE_SOUND, ...opts }).keys());
  }

  /** Layout validation: returns human-readable problems, empty when clean. */
  validate(): string[] {
    const problems: string[] = [];
    for (const m of this._modules.values()) {
      for (const p of m.ports) {
        if (!p.link) continue;
        const back = this.port(p.link.module, p.link.port);
        if (!back) {
          problems.push(`${m.id}:${p.id} links to missing port ${p.link.module}:${p.link.port}`);
          continue;
        }
        if (!back.link || back.link.module !== m.id || back.link.port !== p.id) {
          problems.push(
            `${m.id}:${p.id} → ${p.link.module}:${p.link.port} is not reciprocated`,
          );
        }
      }
    }
    const ids = this.ids();
    if (ids.length > 0) {
      const reachable = this.connectedComponent(ids[0]!);
      for (const id of ids) {
        if (!reachable.has(id)) problems.push(`module '${id}' is not connected to '${ids[0]}'`);
      }
    }

    // Gravity budget. Walking is the DEFAULT — zero-G is a spike of tension in
    // a few authored places, not a tax on the round. A level that drifts past
    // these has quietly rebuilt the game the pivot exists to replace, and it
    // will do it one well-meaning module at a time, which is why this is a
    // check and not a comment.
    let authoredZeroG = 0;
    for (const id of ids) if (this.authoredGravity(id) === 'zero') authoredZeroG++;
    if (authoredZeroG > ZERO_G_AUTHORED_MAX) {
      problems.push(
        `${authoredZeroG} modules are authored zero-G, over the ZERO_G_AUTHORED_MAX of ${ZERO_G_AUTHORED_MAX} — walking must stay the default`,
      );
    }
    const ceiling = Math.floor(ids.length * ZERO_G_FRACTION_MAX);
    if (ids.length > 0 && authoredZeroG > ceiling) {
      problems.push(
        `${authoredZeroG} of ${ids.length} modules are authored zero-G, over the ${ZERO_G_FRACTION_MAX * 100}% ceiling (${ceiling}) — and the §5 director still needs room to drop more`,
      );
    }
    // An isolated zero-G module surrounded by zero-G modules is one thing; a
    // station where you cannot get anywhere without floating is the old design.
    for (const id of ids) {
      if (this.authoredGravity(id) !== 'nominal') continue;
      const neighbours = this.neighbours(id);
      if (neighbours.length > 0 && neighbours.every((n) => this.authoredGravity(n) === 'zero')) {
        problems.push(
          `module '${id}' has a floor but every route out of it is zero-G — it is a walking island`,
        );
      }
    }
    return problems;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** `${moduleId}:${portId}` — a station-wide unique port key. Matches
 *  `HatchSnapshot.portId` in §7. */
export function portKey(moduleId: ModuleId, portId: PortId): string {
  return `${moduleId}:${portId}`;
}

export function parsePortKey(key: string): { module: ModuleId; port: PortId } {
  const i = key.indexOf(':');
  if (i < 0) throw new Error(`parsePortKey: malformed key '${key}'`);
  return { module: key.slice(0, i), port: key.slice(i + 1) };
}

/** Distance between module centres, plus 6m of "cost" for a hatch that has to be
 *  opened first (HATCH_OPEN_TIME at SPEED_PATROL ≈ 4.5m; rounded up). */
export function defaultEdgeCost(edge: ModuleEdge): number {
  return edge.centreDistance + (edge.open ? 0 : 6);
}

function reconstruct(cameFrom: Map<ModuleId, ModuleId>, end: ModuleId): ModuleId[] {
  const path = [end];
  let cursor = end;
  while (cameFrom.has(cursor)) {
    cursor = cameFrom.get(cursor)!;
    path.push(cursor);
  }
  return path.reverse();
}
