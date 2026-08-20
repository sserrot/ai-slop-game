/**
 * The rail (handrail) graph (DESIGN.md §2).
 *
 * "Both the player's GRIPPING state (§4) and the alien's in-module navigation
 * (§5) need to know how handrails connect. Neither works without it."
 *
 * Segments are authored per kit piece in module space; this builds the
 * station-wide world-space graph, including continuity through hatches via
 * `RailSegment.portLink`.
 */

import { GRAB_RANGE } from '@shared/constants';
import type {
  GravityScope,
  ModuleId,
  Port,
  PortId,
  RailKey,
  RailSegment,
  RailSegmentId,
  Vec3,
} from '@shared/types';
import {
  add,
  distance,
  dot,
  localToWorld,
  normalize,
  projectOnSegmentInto,
  scale,
  segmentProjection,
  sub,
  v3,
  type SegmentProjection,
} from '@shared/graph/math';
import { ModuleGraph } from '@shared/graph/moduleGraph';

/** `${moduleId}:${segmentId}` — station-wide unique rail id. */
export function railKey(moduleId: ModuleId, segmentId: RailSegmentId): RailKey {
  return `${moduleId}:${segmentId}`;
}

export function parseRailKey(key: RailKey): { module: ModuleId; segment: RailSegmentId } {
  const i = key.indexOf(':');
  if (i < 0) throw new Error(`parseRailKey: malformed rail key '${key}'`);
  return { module: key.slice(0, i), segment: key.slice(i + 1) };
}

/** A rail segment resolved into world space, with its station-wide connections. */
export interface RailNode {
  key: RailKey;
  module: ModuleId;
  segment: RailSegment;
  /** Endpoint A in world space. */
  a: Vec3;
  /** Endpoint B in world space. */
  b: Vec3;
  /** Unit vector a→b. */
  dir: Vec3;
  /** Metres from a to b. */
  length: number;
  /** Midpoint in world space — the A* heuristic anchor. */
  mid: Vec3;
  /** Every segment reachable without letting go, in-module and through hatches. */
  connects: RailKey[];
  /** Port this segment continues through, if any (`${module}:${port}`). */
  portKey: string | null;
}

/** Result of a nearest-rail query. */
export interface RailQuery {
  key: RailKey;
  node: RailNode;
  /** Parameter along the segment, 0 at `a`, 1 at `b`. */
  t: number;
  /** World position of the closest point on the segment. */
  point: Vec3;
  /** Metres from the query position to `point`. */
  distance: number;
}

/**
 * Placeholder `node` for a freshly minted `railQueryBuffer()`.
 *
 * A buffer is only ever handed back to a caller once a query has actually
 * matched a rail, and matching overwrites every field — so this is never
 * observable through a returned `RailQuery`. It exists purely so the buffer can
 * satisfy `RailQuery` without `node` being nullable, which would push a `!` or a
 * null check into every consumer of a real result.
 */
const NO_NODE: RailNode = Object.freeze<RailNode>({
  key: '',
  module: '',
  segment: { id: '', a: v3(), b: v3(), connects: [] },
  a: v3(),
  b: v3(),
  dir: v3(),
  length: 0,
  mid: v3(),
  connects: [],
  portKey: null,
});

/**
 * A reusable result object for the `out` parameter of `nearest`,
 * `nearestInModule` and `grabCandidate`.
 *
 * Pass one and the query writes into it instead of allocating — that is the
 * difference between 30-odd objects per frame and none on the player's grab
 * check (§4) and the alien's rail following (§5). The buffer is CALLER-owned:
 * two rooms in one Node process each hold their own, so there is no shared
 * scratch to make the graph non-re-entrant. Omit `out` and the queries behave
 * exactly as before and return a fresh object.
 *
 * Do not read a buffer that no query has filled, and do not hold a result past
 * the next query on the same buffer.
 */
export function railQueryBuffer(): RailQuery {
  return { key: '', node: NO_NODE, t: 0, point: v3(), distance: 0 };
}

/** Fill `out` from a node and a parameter along it. `point` is recomputed with
 *  the same expression `projectOnSegmentInto` uses, so it is bit-identical. */
function fillQuery(out: RailQuery, node: RailNode, t: number, distanceM: number): RailQuery {
  out.key = node.key;
  out.node = node;
  out.t = t;
  out.point.x = node.a.x + (node.b.x - node.a.x) * t;
  out.point.y = node.a.y + (node.b.y - node.a.y) * t;
  out.point.z = node.a.z + (node.b.z - node.a.z) * t;
  out.distance = distanceM;
  return out;
}

/** A position on the rail graph — what `PlayerSnapshot.gripId` plus a scalar is. */
export interface RailPosition {
  key: RailKey;
  t: number;
  point: Vec3;
  module: ModuleId;
}

/** Result of sliding along the rails. */
export interface RailAdvance extends RailPosition {
  /** Segments entered on the way, in order. Empty if we stayed put. */
  crossed: RailKey[];
  /** True if we ran out of rail and stopped at a dead end. */
  blocked: boolean;
  /** Metres actually travelled (less than requested when blocked). */
  travelled: number;
}

/**
 * A reusable result for `advance`'s optional `out`. Its `crossed` array is
 * truncated and refilled rather than replaced, so the slide costs nothing per
 * frame. Caller-owned, exactly like `railQueryBuffer()`.
 */
export function railAdvanceBuffer(): RailAdvance {
  return { key: '', t: 0, point: { x: 0, y: 0, z: 0 }, module: '', crossed: [], blocked: false, travelled: 0 };
}

const EPS_JOIN = 0.35; // metres; endpoints closer than this count as joined
/** Metres: a rail endpoint this close to a port counts as continuing through it. */
const EPS_PORT_JOIN = 1.0;

/** Shared empty list, so `inModule` on an unknown module allocates nothing. */
const NO_NODES: readonly RailNode[] = Object.freeze([]);

export class RailGraph {
  private readonly _nodes = new Map<RailKey, RailNode>();
  private readonly _byModule = new Map<ModuleId, RailNode[]>();
  /** Every node in insertion order — an indexable array, so the station-wide
   *  `nearest()` scan does not have to build a Map iterator per call. */
  private readonly _all: RailNode[] = [];
  /** Per-INSTANCE projection scratch for the nearest-rail scans. Never escapes
   *  a method, so it stays re-entrant across rooms (one graph per room) — see
   *  `railQueryBuffer` for why the RESULT buffer is caller-owned instead. */
  private readonly _proj: SegmentProjection = segmentProjection();
  /** Per-instance heading scratch for `advance`'s junction hops. Same rules. */
  private readonly _heading: Vec3 = v3();

  constructor(private readonly graph: ModuleGraph) {
    this.rebuild();
  }

  /** Rebuild every node from the module graph. Call if the layout changes. */
  rebuild(): void {
    this._nodes.clear();
    this._byModule.clear();
    this._all.length = 0;

    for (const module of this.graph.all()) {
      const list: RailNode[] = [];
      for (const seg of module.rails) {
        const a = localToWorld(seg.a, module.transform);
        const b = localToWorld(seg.b, module.transform);
        const delta = sub(b, a);
        const len = distance(a, b);
        const node: RailNode = {
          key: railKey(module.id, seg.id),
          module: module.id,
          segment: seg,
          a,
          b,
          dir: normalize(delta),
          length: len,
          mid: add(a, scale(delta, 0.5)),
          connects: [],
          portKey: seg.portLink ? `${module.id}:${seg.portLink}` : null,
        };
        this._nodes.set(node.key, node);
        list.push(node);
        this._all.push(node);
      }
      this._byModule.set(module.id, list);
    }

    // In-module connections, as authored.
    for (const node of this._nodes.values()) {
      for (const other of node.segment.connects) {
        const key = railKey(node.module, other);
        if (!this._nodes.has(key)) {
          throw new Error(
            `RailGraph: ${node.key} connects to '${other}', which does not exist in module '${node.module}'`,
          );
        }
        if (!node.connects.includes(key)) node.connects.push(key);
        // Connections are symmetric even if only one side authored them.
        const back = this._nodes.get(key)!;
        if (!back.connects.includes(node.key)) back.connects.push(node.key);
      }
    }

    // Cross-module connections through hatches.
    //
    // `RailSegment.portLink` is singular (§2), so a straight tube with a hatch at
    // each end is authored as two segments that `connects` each other. Declaring
    // the link on EITHER side is enough: the far segment matches if it declares
    // the mating portLink OR simply has an endpoint at the port. That tolerance
    // is deliberate — a rail that visibly continues through a hatch but does not
    // connect is the single most confusing authoring bug in this system.
    for (const node of this._nodes.values()) {
      const portLink = node.segment.portLink;
      if (!portLink) continue;
      const port = this.graph.port(node.module, portLink);
      if (!port) {
        throw new Error(
          `RailGraph: ${node.key} has portLink '${portLink}', which is not a port of '${node.module}'`,
        );
      }
      if (!port.link) continue; // endcap: rail simply stops at an unlinked port
      const otherModule = port.link.module;
      const otherPortId = port.link.port;
      const portWorld = this.graph.portWorldPos(node.module, portLink);
      for (const candidate of this._byModule.get(otherModule) ?? []) {
        const declares = candidate.segment.portLink === otherPortId;
        const touches =
          portWorld !== undefined &&
          Math.min(distance(candidate.a, portWorld), distance(candidate.b, portWorld)) <=
            EPS_PORT_JOIN;
        if (!declares && !touches) continue;
        if (!node.connects.includes(candidate.key)) node.connects.push(candidate.key);
        if (!candidate.connects.includes(node.key)) candidate.connects.push(node.key);
      }
    }
  }

  // -- gravity scoping ------------------------------------------------------
  //
  // THE PIVOT'S EFFECT ON THIS FILE. Rail segments now only matter in modules
  // with `gravity: 'zero'`: where there is a floor you walk, and the handrails
  // are scenery you can see but not hang from. Everything below reads the
  // module's gravity LIVE off the graph, the same way `jointOpen` reads hatch
  // state live, so a module losing its floor mid-slide takes effect on that
  // frame with nothing to invalidate.
  //
  // WHO PASSES WHAT — this is the part worth getting right:
  //
  //   * The PLAYER uses `grabCandidate` and `slide`, which default to `'zero'`.
  //     Latching onto a handrail in a room with a floor, or sliding through a
  //     hatch into one and hanging there, are both nonsense states, and a
  //     default that had to be remembered at four call sites would eventually
  //     be forgotten at one.
  //   * The ALIEN uses `advance`, `path` and `nearest`, which default to
  //     `'any'`. Its rail-following is how it navigates INSIDE every module
  //     (§5), gravity or not — scoping those would break its pathfinding in
  //     precisely the modules the player spends most of the round in.
  //   * NOISE PROPAGATION never touches this file at all and is unaffected.

  /** True if handrails are load-bearing in this module right now — i.e. it has
   *  no floor. */
  railsActive(moduleId: ModuleId): boolean {
    return this.graph.gravityOf(moduleId) === 'zero';
  }

  /** Does a scope admit this module's current gravity? */
  private inScope(moduleId: ModuleId, scope: GravityScope): boolean {
    return scope === 'any' || this.graph.gravityOf(moduleId) === scope;
  }

  /** Every rail node in modules the scope admits. `'zero'` is the set the
   *  player can actually use; `'any'` is every rail in the station. */
  nodesInScope(scope: GravityScope = 'any'): RailNode[] {
    if (scope === 'any') return [...this._all];
    return this._all.filter((n) => this.inScope(n.module, scope));
  }

  // -- lookups --------------------------------------------------------------

  get size(): number {
    return this._nodes.size;
  }

  keys(): RailKey[] {
    return [...this._nodes.keys()];
  }

  nodes(): RailNode[] {
    return [...this._nodes.values()];
  }

  node(key: RailKey): RailNode | undefined {
    return this._nodes.get(key);
  }

  require(key: RailKey): RailNode {
    const n = this._nodes.get(key);
    if (!n) throw new Error(`RailGraph: unknown rail '${key}'`);
    return n;
  }

  inModule(moduleId: ModuleId): readonly RailNode[] {
    return this._byModule.get(moduleId) ?? NO_NODES;
  }

  /**
   * Segments reachable from `key` without letting go (§2).
   *
   * `scope` filters by the CONNECTED segment's gravity, so a rail that
   * continues through a hatch into a module with a floor is not offered to a
   * caller asking for `'zero'`. Static topology only — whether the hatch
   * between them is open is `advance`'s problem, not this one.
   */
  connections(key: RailKey, scope: GravityScope = 'any'): RailKey[] {
    const connects = this._nodes.get(key)?.connects ?? [];
    if (scope === 'any') return connects;
    return connects.filter((k) => {
      const n = this._nodes.get(k);
      return n !== undefined && this.inScope(n.module, scope);
    });
  }

  // -- position maths -------------------------------------------------------

  /** World position at parameter `t` along a segment. `t` is clamped to [0,1]. */
  pointAt(key: RailKey, t: number): Vec3 {
    return this.pointAtInto(key, t, v3());
  }

  /** `pointAt` writing into `out`. The player holds a rail every frame it is
   *  GRIPPING, which was three objects a frame for a value it copies anyway. */
  pointAtInto(key: RailKey, t: number, out: Vec3): Vec3 {
    const n = this.require(key);
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    out.x = n.a.x + (n.b.x - n.a.x) * clamped;
    out.y = n.a.y + (n.b.y - n.a.y) * clamped;
    out.z = n.a.z + (n.b.z - n.a.z) * clamped;
    return out;
  }

  /** Closest point on one segment to a world position. Pass `out` to reuse a
   *  `segmentProjection()` instead of allocating. */
  project(key: RailKey, worldPos: Vec3, out?: SegmentProjection): SegmentProjection {
    const n = this.require(key);
    return projectOnSegmentInto(worldPos, n.a, n.b, out ?? segmentProjection());
  }

  /** Metres from `t` to the nearer end of a segment, in the direction of travel. */
  metresAlong(key: RailKey, t: number): number {
    return this.require(key).length * (t < 0 ? 0 : t > 1 ? 1 : t);
  }

  /**
   * Nearest rail anywhere in the station.
   *
   * `out` is optional everywhere in this group: pass a `railQueryBuffer()` and
   * the result is written into it with no allocation at all; omit it and you get
   * a fresh object, exactly as before.
   */
  nearest(
    worldPos: Vec3,
    maxDistance = Number.POSITIVE_INFINITY,
    out?: RailQuery,
    scope: GravityScope = 'any',
  ): RailQuery | null {
    return this.nearestAmong(this._all, worldPos, maxDistance, out, scope);
  }

  /** Nearest rail within one module. Cheaper, and what the grip check wants. */
  nearestInModule(
    moduleId: ModuleId,
    worldPos: Vec3,
    maxDistance = Number.POSITIVE_INFINITY,
    out?: RailQuery,
    scope: GravityScope = 'any',
  ): RailQuery | null {
    return this.nearestAmong(this.inModule(moduleId), worldPos, maxDistance, out, scope);
  }

  /**
   * The §4 buffered auto-latch: hold Grip and the first rail entering
   * GRAB_RANGE catches. Searches the player's module and its neighbours, so a
   * rail continuing through an open hatch still latches.
   *
   * DEFAULTS TO `'zero'`, unlike every other query here. There is nothing to
   * latch onto in a room with a floor, and a neighbour scan that reached
   * through a hatch into one would leave a player hanging off a handrail in a
   * corridor they should be walking down. Pass `'any'` only for a debug view.
   */
  grabCandidate(
    moduleId: ModuleId,
    worldPos: Vec3,
    range: number = GRAB_RANGE,
    out?: RailQuery,
    scope: GravityScope = 'zero',
  ): RailQuery | null {
    if (!this.inScope(moduleId, scope)) {
      // Still scan the neighbours: a body drifting in a hatchway can legally
      // reach the zero-G module it is entering before its own module id flips.
      return this.grabNeighbours(moduleId, worldPos, range, out, scope);
    }
    const local = this.nearestInModule(moduleId, worldPos, range, out, scope);
    if (local) return local;
    return this.grabNeighbours(moduleId, worldPos, range, out, scope);
  }

  private grabNeighbours(
    moduleId: ModuleId,
    worldPos: Vec3,
    range: number,
    out: RailQuery | undefined,
    scope: GravityScope,
  ): RailQuery | null {

    // Neighbour scan. Tracked as (node, t, distance) rather than as competing
    // RailQuery objects so nothing is allocated while comparing — the winner is
    // materialised once, at the end.
    let bestNode: RailNode | null = null;
    let bestT = 0;
    let bestDistance = 0;
    // `edges()` hands back the graph's own array; `openNeighbours()` would build
    // two more per call, and this runs at every collision substep while Grip is
    // held down (§4's buffered latch).
    for (const edge of this.graph.edges(moduleId)) {
      if (!edge.open) continue;
      if (!this.inScope(edge.to, scope)) continue;
      const nodes = this.inModule(edge.to);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const p = projectOnSegmentInto(worldPos, node.a, node.b, this._proj);
        if (p.distance > range) continue;
        if (bestNode && p.distance >= bestDistance) continue;
        bestNode = node;
        bestT = p.t;
        bestDistance = p.distance;
      }
    }
    if (!bestNode) return null;
    return fillQuery(out ?? railQueryBuffer(), bestNode, bestT, bestDistance);
  }

  private nearestAmong(
    candidates: readonly RailNode[],
    worldPos: Vec3,
    maxDistance: number,
    out?: RailQuery,
    scope: GravityScope = 'any',
  ): RailQuery | null {
    let bestNode: RailNode | null = null;
    let bestT = 0;
    let bestDistance = 0;
    for (let i = 0; i < candidates.length; i++) {
      const node = candidates[i];
      if (scope !== 'any' && !this.inScope(node.module, scope)) continue;
      const p = projectOnSegmentInto(worldPos, node.a, node.b, this._proj);
      if (p.distance > maxDistance) continue;
      if (bestNode && p.distance >= bestDistance) continue;
      bestNode = node;
      bestT = p.t;
      bestDistance = p.distance;
    }
    if (!bestNode) return null;
    return fillQuery(out ?? railQueryBuffer(), bestNode, bestT, bestDistance);
  }

  // -- traversal ------------------------------------------------------------

  /**
   * Slide `deltaMetres` along the rails from `(key, t)`, continuing into
   * connected segments when an endpoint is reached. Negative delta slides toward
   * `a`, positive toward `b`.
   *
   * This is both the player's 1.2 m/s WASD slide (§4) and the alien's
   * rail-following within a module (§5).
   *
   * `scope` defaults to `'any'`, which is the ALIEN's case: it follows rails to
   * navigate inside every module, floor or no floor. The PLAYER should call
   * `slide()` instead, which scopes to `'zero'` — see the gravity-scoping
   * section above for why the two defaults differ.
   */
  advance(
    key: RailKey,
    t: number,
    deltaMetres: number,
    out?: RailAdvance,
    scope: GravityScope = 'any',
  ): RailAdvance {
    let node = this.require(key);
    let along = node.length * clamp01(t);
    let remaining = deltaMetres;
    const result = out ?? railAdvanceBuffer();
    const crossed = result.crossed;
    crossed.length = 0;
    let travelled = 0;
    let blocked = false;

    // Out of scope before we start: the rail we are on does not exist for this
    // caller. Report a blocked slide at the current position rather than
    // pretending — the controller reads `blocked` and lets go.
    if (!this.inScope(node.module, scope)) {
      const t0 = clamp01(t);
      result.key = node.key;
      result.t = t0;
      this.pointAtInto(node.key, t0, result.point);
      result.module = node.module;
      result.blocked = true;
      result.travelled = 0;
      return result;
    }

    // Cap the hop count: a pathological rail loop must not spin forever.
    for (let guard = 0; guard < 64; guard++) {
      const target = along + remaining;
      if (target >= 0 && target <= node.length) {
        along = target;
        travelled += Math.abs(remaining);
        remaining = 0;
        break;
      }

      const forward = target > node.length;
      const stepToEnd = forward ? node.length - along : -along;
      travelled += Math.abs(stepToEnd);
      remaining -= stepToEnd;

      const junction = forward ? node.b : node.a;
      const heading = this._heading;
      const sign = forward ? 1 : -1;
      heading.x = node.dir.x * sign;
      heading.y = node.dir.y * sign;
      heading.z = node.dir.z * sign;
      const next = this.pickContinuation(node, junction, heading, scope);
      if (!next) {
        along = forward ? node.length : 0;
        blocked = true;
        remaining = 0;
        break;
      }

      // Enter the next segment at whichever of its endpoints sits at the junction.
      const enterAtA = distance(next.a, junction) <= distance(next.b, junction);
      node = next;
      along = enterAtA ? 0 : node.length;
      remaining = enterAtA ? Math.abs(remaining) : -Math.abs(remaining);
      crossed.push(node.key);
    }

    const finalT = node.length > 1e-9 ? clamp01(along / node.length) : 0;
    result.key = node.key;
    result.t = finalT;
    this.pointAtInto(node.key, finalT, result.point);
    result.module = node.module;
    result.blocked = blocked;
    result.travelled = travelled;
    return result;
  }

  /**
   * THE PLAYER'S SLIDE. `advance` scoped to `'zero'`, because handrails only
   * carry a body in a module with no floor.
   *
   * Use this and not `advance` anywhere the mover is a player: it cannot latch
   * you into a room you should be walking through, and a slide that reaches a
   * hatch into a `nominal` module comes back `blocked` rather than dragging you
   * across the threshold still gripping.
   *
   * IMPORTANT — this does NOT weaken the hatch rule. `jointOpen()` still runs
   * first and still refuses to slide through a closed or sealed hatch; the
   * gravity scope is an ADDITIONAL filter layered on top of it, never a
   * replacement. Closed and sealed hatches block the player on the rail path
   * and on the swept-sphere path, in both gravity modes.
   */
  slide(key: RailKey, t: number, deltaMetres: number, out?: RailAdvance): RailAdvance {
    return this.advance(key, t, deltaMetres, out, 'zero');
  }

  /** Straightest continuation from a junction: the connected segment whose free
   *  end runs most nearly in the current direction of travel. */
  private pickContinuation(
    from: RailNode,
    junction: Vec3,
    heading: Vec3,
    scope: GravityScope = 'any',
  ): RailNode | null {
    let best: RailNode | null = null;
    let bestScore = -Infinity;
    for (const otherKey of from.connects) {
      const other = this._nodes.get(otherKey);
      if (!other || other.key === from.key) continue;
      // A hand cannot pass through a shut door. `connects` is STATIC topology —
      // it says the rail continues, not that the way is open right now.
      if (!this.jointOpen(from, other)) continue;
      // Nor can a player slide out of zero-G onto a rail in a room with a
      // floor. The slide stops at the hatch and `blocked` comes back true, so
      // the controller lets go and the body walks in — which is the `settle`
      // transition, arriving on its feet.
      if (!this.inScope(other.module, scope)) continue;
      const dA = distance(other.a, junction);
      const dB = distance(other.b, junction);
      const near = Math.min(dA, dB);
      // Segments in the same module must meet tightly; a cross-module pair meets
      // at a hatch and may be a whole bulkhead thickness apart.
      const tolerance = other.module === from.module ? EPS_JOIN : EPS_PORT_JOIN * 2;
      if (near > tolerance) continue;
      // Outward-facing direction of the candidate. Negating the dot product is
      // exactly negating the vector first (IEEE-754 negation is exact and
      // round-to-nearest is sign-symmetric), and saves a Vec3 per candidate.
      const outwardSign = dA <= dB ? 1 : -1;
      const score = outwardSign * dot(other.dir, heading) - near;
      if (score > bestScore) {
        bestScore = score;
        best = other;
      }
    }
    return best;
  }

  /**
   * Is the join between two connected segments passable RIGHT NOW?
   *
   * In-module joins always are. A cross-module join is a hatchway, and §5 hangs
   * two pillars off that door actually stopping a body: "closing a hatch behind
   * you buys ~3 seconds while it opens the hatch", and SEAL_CHARGES, which is
   * only a barricading mechanic if a sealed bulkhead cannot be slid through.
   * `grabCandidate` already refuses to LATCH through a shut hatch; this is the
   * matching rule for traversal.
   *
   * Read live off the `Port` objects rather than the module edge's cached
   * `open`, so a hatch that swings shut mid-slide takes effect on the same frame
   * whether or not anything has called `refreshHatches()` yet. Runs only when a
   * slide actually reaches a junction, so it costs nothing per frame.
   */
  private jointOpen(from: RailNode, to: RailNode): boolean {
    if (from.module === to.module) return true;

    // The port they meet at, from whichever side authored the link.
    const near =
      this.portTowards(from.module, from.segment.portLink, to.module) ??
      this.portTowards(to.module, to.segment.portLink, from.module);
    if (near) {
      const far = near.link ? this.graph.port(near.link.module, near.link.port) : undefined;
      const sealed = near.hatch.sealed || (far?.hatch.sealed ?? false);
      return !sealed && near.hatch.open && (far?.hatch.open ?? true);
    }

    // Rails joined by proximity alone (the tolerant path in `rebuild`, where
    // neither side declared a `portLink`): fall back to the module edge, which
    // caches the same state.
    const edge = this.graph.edgeBetween(from.module, to.module);
    return edge ? edge.open : true;
  }

  /** `portId` of `module`, but only if it is the port linking toward `toward`. */
  private portTowards(
    module: ModuleId,
    portId: PortId | undefined,
    toward: ModuleId,
  ): Port | undefined {
    if (!portId) return undefined;
    const port = this.graph.port(module, portId);
    return port?.link?.module === toward ? port : undefined;
  }

  // -- pathfinding ----------------------------------------------------------

  /**
   * A* over rail segments (§2 "A* runs over modules, then over rail segments
   * within each"). Returns the chain of rail keys including both endpoints, or
   * null if unreachable without letting go.
   *
   * `scope` defaults to `'any'` and that default is load-bearing: this is how
   * the alien navigates inside a module (§5), and it must keep working across
   * BOTH kinds of module or its pathfinding dies in every room with a floor.
   * Pass `'zero'` for a player-facing route.
   */
  path(fromKey: RailKey, toKey: RailKey, scope: GravityScope = 'any'): RailKey[] | null {
    if (!this._nodes.has(fromKey) || !this._nodes.has(toKey)) return null;
    if (scope !== 'any') {
      const a = this.require(fromKey);
      const b = this.require(toKey);
      if (!this.inScope(a.module, scope) || !this.inScope(b.module, scope)) return null;
    }
    if (fromKey === toKey) return [fromKey];

    const goal = this.require(toKey).mid;
    const gScore = new Map<RailKey, number>([[fromKey, 0]]);
    const cameFrom = new Map<RailKey, RailKey>();
    const closed = new Set<RailKey>();
    const open = new Map<RailKey, number>([[fromKey, distance(this.require(fromKey).mid, goal)]]);

    while (open.size > 0) {
      let current: RailKey | null = null;
      let bestF = Number.POSITIVE_INFINITY;
      for (const [k, f] of open) {
        if (f < bestF) {
          bestF = f;
          current = k;
        }
      }
      if (current === null) break;
      if (current === toKey) {
        const path = [current];
        let cursor = current;
        while (cameFrom.has(cursor)) {
          cursor = cameFrom.get(cursor)!;
          path.push(cursor);
        }
        return path.reverse();
      }

      open.delete(current);
      closed.add(current);
      const node = this.require(current);
      const currentG = gScore.get(current) ?? Number.POSITIVE_INFINITY;

      for (const nextKey of node.connects) {
        if (closed.has(nextKey)) continue;
        const next = this._nodes.get(nextKey);
        if (!next) continue;
        if (!this.inScope(next.module, scope)) continue;
        const tentative = currentG + distance(node.mid, next.mid);
        if (tentative >= (gScore.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
        cameFrom.set(nextKey, current);
        gScore.set(nextKey, tentative);
        open.set(nextKey, tentative + distance(next.mid, goal));
      }
    }
    return null;
  }

  /**
   * Convenience for the alien and for "slide toward that panel": the rail path
   * from wherever you are gripping to the rail nearest a world target.
   */
  pathToPoint(
    fromKey: RailKey,
    worldTarget: Vec3,
    scope: GravityScope = 'any',
  ): RailKey[] | null {
    const target = this.nearest(worldTarget, Number.POSITIVE_INFINITY, undefined, scope);
    if (!target) return null;
    return this.path(fromKey, target.key, scope);
  }

  /** Validation: authored connections that do not meet geometrically. */
  validate(): string[] {
    const problems: string[] = [];
    for (const node of this._nodes.values()) {
      if (node.length < 1e-6) problems.push(`${node.key} is zero length`);
      for (const otherKey of node.connects) {
        const other = this._nodes.get(otherKey);
        if (!other) {
          problems.push(`${node.key} connects to missing rail '${otherKey}'`);
          continue;
        }
        const gap = Math.min(
          distance(node.a, other.a),
          distance(node.a, other.b),
          distance(node.b, other.a),
          distance(node.b, other.b),
        );
        const tolerance = other.module === node.module ? EPS_JOIN : EPS_PORT_JOIN * 2;
        if (gap > tolerance) {
          problems.push(
            `${node.key} ↔ ${otherKey} are authored as connected but their nearest endpoints are ${gap.toFixed(2)}m apart`,
          );
        }
      }
    }
    return problems;
  }
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Copy helper re-exported for callers building RailPositions. */
export function railPosition(node: RailNode, t: number): RailPosition {
  const clamped = clamp01(t);
  return {
    key: node.key,
    t: clamped,
    point: add(node.a, scale(sub(node.b, node.a), clamped)),
    module: node.module,
  };
}
