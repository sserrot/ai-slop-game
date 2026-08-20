/**
 * The station the server runs (DESIGN.md §2).
 *
 * The authoritative layout lives on the SERVER and is shipped to every client in
 * the `welcome` message, so both sides run §3's propagation over byte-identical
 * geometry. Point `STATION_LAYOUT` at an authored JSON file to use a real one;
 * otherwise the procedural station below is generated — ten modules, a straight
 * spine with two branches, which satisfies §2's "8–10 modules" target and gives
 * the §10 spawn solver room to place six players and an alien three hops away.
 *
 * Kit piece: a 5 m straight tube of `TUBE_RADIUS_M`, running along local X.
 * Ports sit on the module's local axes at 2.5 m; handrails run OVERHEAD, in the
 * same single rail plane the authored kit uses, and each spoke ends directly
 * above its port so mated modules' rails meet at one point.
 */

import { readFileSync } from 'node:fs';
import type {
  GravityMode,
  HideSpot,
  ModuleId,
  Port,
  PortId,
  PropRef,
  Quat,
  RailSegment,
  StationLayout,
  StationModule,
  Vec3,
} from '@shared/types';
import {
  DECK_HALF_WIDTH_M,
  DECK_Y_M,
  HIDE_SPOTS_MIN,
  MODULE_LENGTH_M,
  PLAYER_RADIUS,
  PLAYER_STAND_HEIGHT_M,
  RAIL_Y_M,
  TUBE_RADIUS_M,
} from '@shared/constants';
import { ModuleGraph, syncHatchAttenuation } from '@shared/graph/moduleGraph';
import { RailGraph } from '@shared/graph/railGraph';
import { HideSpotGraph } from '@shared/graph/hideSpots';
import { normalizeLayoutGravity } from '@shared/graph/gravity';

const MODULE_LENGTH = MODULE_LENGTH_M;
/**
 * Handrail height above the deck, and the module-space Y that puts them at.
 *
 * Raised twice. It was −0.6, which is 15 cm over a deck at `DECK_Y_M` — a trip
 * hazard bolted across a walkable floor. Then +0.6, which is chest height and
 * still a bar across the room you now walk down. It is overhead now, clearing a
 * standing crew member by 0.22 m, which is the height `src/station/kit.ts`
 * derives for every rail in the authored station.
 *
 * DUPLICATED FROM THE KIT ON PURPOSE, for now. The number belongs in §14 beside
 * `DECK_Y_M` — it is exactly the same kind of handshake, between the piece that
 * builds the rails and the controller that grabs them — but §14 is owned
 * elsewhere this pass, and the server may not import `src/station/**`. When
 * `RAIL_ABOVE_DECK_M` lands in `shared/constants`, both copies should import it
 * and this comment should go.
 */
const RAIL_Y = RAIL_Y_M;

/**
 * Distance from the module axis at which a hide spot's shell sits.
 *
 * A hide box is 0.3 m deep, so this puts its outer face flush against the
 * bulkhead and its inner face 0.6 m further in — against a wall rather than in
 * the middle of the corridor. Derived from `TUBE_RADIUS_M` rather than typed, so
 * widening the bore moves the built-in station's cover out with it instead of
 * leaving it standing in the middle of a wider room.
 */
const WALL_RADIUS_M = TUBE_RADIUS_M - 0.3;

/** Where you stand to climb in — inside the walkable strip, and far enough from
 *  the box that `HideSpotGraph.validate()` does not call the entry "inside its
 *  own volume". */
const ENTRY_RADIUS_M = Math.max(0, Math.min(DECK_HALF_WIDTH_M, WALL_RADIUS_M - 0.62));

type Side = 'w' | 'e' | 'n' | 's';

const SIDE_POS: Record<Side, Vec3> = {
  w: { x: -MODULE_LENGTH / 2, y: 0, z: 0 },
  e: { x: MODULE_LENGTH / 2, y: 0, z: 0 },
  s: { x: 0, y: 0, z: -MODULE_LENGTH / 2 },
  n: { x: 0, y: 0, z: MODULE_LENGTH / 2 },
};

const SIDE_DIR: Record<Side, Vec3> = {
  w: { x: -1, y: 0, z: 0 },
  e: { x: 1, y: 0, z: 0 },
  s: { x: 0, y: 0, z: -1 },
  n: { x: 0, y: 0, z: 1 },
};

function port(side: Side, link: { module: ModuleId; port: PortId } | null): Port {
  return syncHatchAttenuation({
    id: side,
    localPos: { ...SIDE_POS[side] },
    localDir: { ...SIDE_DIR[side] },
    link,
    // Everything starts open: the round begins with the station quiet and the
    // doors as they were left (§10 "you wake alone").
    hatch: { open: true, sealed: false, attenuationDb: 0 },
  });
}

/**
 * One rail from the module centre out to a point directly above `side`'s port,
 * linked through it.
 *
 * The far end is at `RAIL_Y`, not at the port itself: the port is at axis height
 * and a rail that dives to it crosses the doorway a body walks through. Two
 * mated modules put their ports at one world point and their decks on one world
 * plane, so both sides' spokes end at the same world point and the join is still
 * exact — and `RailGraph` resolves the continuation through `portLink` anyway.
 */
function spoke(side: Side): RailSegment {
  return {
    id: `r-${side}`,
    a: { x: 0, y: RAIL_Y, z: 0 },
    b: { x: SIDE_POS[side].x, y: RAIL_Y, z: SIDE_POS[side].z },
    connects: [],
    portLink: side,
  };
}

/** A stowage locker standing on the deck. `y` used to be −0.8, which is under
 *  the floor: the prop was authored before the deck existed. */
function locker(id: string, x: number, z: number): PropRef {
  return {
    id,
    kind: 'locker',
    localPos: { x, y: DECK_Y_M + 0.3, z },
    interactable: true,
  };
}

/**
 * A locker you can climb INTO, co-located with the `locker` prop of the same
 * name (§4's hiding mechanic).
 *
 * `usableIn` is left at its `'any'` default deliberately: a locker with
 * handholds works in both regimes, so the §5 director dropping the floor never
 * silently deletes the only cover in a module. The half-extents hug a body —
 * this is the box the alien must not sweep through, not the prop's bounding box.
 *
 * Geometry is keyed off the deck rather than the module axis. The box stands ON
 * the deck (`DECK_Y_M`), recessed into the bulkhead at `WALL_RADIUS_M` on the
 * bearing `(dirX, dirZ)`, and it is ROTATED to face the axis so its 0.3 m depth
 * runs radially — an axis-aligned box on a diagonal bearing pokes its corners
 * through a 1.0 m hull. `entryPos` sits back inside the walkable strip
 * (`DECK_HALF_WIDTH_M`) so the "press to get in" prompt fires from somewhere a
 * walking player can actually stand, and never from inside the geometry.
 */
function hideLocker(id: string, dirX: number, dirZ: number, kind: HideSpot['kind'] = 'locker'): HideSpot {
  const len = Math.hypot(dirX, dirZ) || 1;
  const ux = dirX / len;
  const uz = dirZ / len;
  // Rotation about the global up that carries the box's own +Z onto the bearing.
  const theta = Math.atan2(ux, uz);
  const half = { x: 0.3, y: 0.9, z: 0.3 };
  return {
    id,
    kind,
    // Feet on the deck, body above it: the centre is half a body up from the floor.
    localPos: { x: ux * WALL_RADIUS_M, y: DECK_Y_M + half.y, z: uz * WALL_RADIUS_M },
    localQuat: { x: 0, y: Math.sin(theta / 2), z: 0, w: Math.cos(theta / 2) },
    halfExtents: { ...half },
    entryPos: { x: ux * ENTRY_RADIUS_M, y: DECK_Y_M, z: uz * ENTRY_RADIUS_M },
    // Facing back out of the locker, into the room you are hiding from.
    lookDir: { x: -ux, y: 0, z: -uz },
  };
}

function panel(id: string, kind: string, x: number, z: number): PropRef {
  return {
    id,
    kind,
    localPos: { x, y: 0.7, z },
    interactable: true,
  };
}

interface ModuleSpec {
  id: ModuleId;
  kind: StationModule['kind'];
  pos: Vec3;
  /** Which sides carry a port, and where each links to. */
  sides: Partial<Record<Side, { module: ModuleId; port: PortId } | null>>;
  props?: PropRef[];
  lighting?: StationModule['lighting'];
  /**
   * Locomotion regime (the walking pivot). Omit for `'nominal'` — a level that
   * says nothing has floors everywhere, and zero-G has to be asked for.
   * `ZERO_G_AUTHORED_MAX` caps how many modules may say `'zero'`;
   * `ModuleGraph.validate()` reports a breach.
   */
  gravity?: GravityMode;
  /** Lockers / bays / bunks you can climb into (§4). Most modules have one. */
  hideSpots?: HideSpot[];
}

function buildModule(spec: ModuleSpec): StationModule {
  const sides = Object.keys(spec.sides) as Side[];
  const rails = sides.map(spoke);
  // Every spoke meets every other at the module centre, so you can traverse the
  // whole module without letting go (§2 `connects`).
  for (const rail of rails) {
    rail.connects = rails.filter((r) => r.id !== rail.id).map((r) => r.id);
  }
  return {
    id: spec.id,
    kind: spec.kind,
    transform: { pos: { ...spec.pos }, quat: { x: 0, y: 0, z: 0, w: 1 } },
    ports: sides.map((side) => port(side, spec.sides[side] ?? null)),
    rails,
    props: spec.props ?? [],
    // §10: "Every player wakes alone, in a random module, on emergency lighting."
    lighting: spec.lighting ?? 'emergency',
    // The walking pivot's default. Every module in the built-in station has a
    // floor; the §5 director is what takes them away, mid-round and announced.
    gravity: spec.gravity ?? 'nominal',
    ...(spec.hideSpots && spec.hideSpots.length > 0 ? { hideSpots: spec.hideSpots } : {}),
    volume: spec.kind === 'node' ? 30 : 23,
  };
}

/**
 * The built-in station.
 *
 *     b0
 *      |
 * m0—m1—m2—m3—m4—m5—m6—m7
 *                |
 *                b1
 *
 * m7 is the escape module and m6 the finale; neither is ever a player spawn (§10).
 */
export function proceduralLayout(): StationLayout {
  const link = (module: ModuleId, portId: PortId) => ({ module, port: portId });

  const specs: ModuleSpec[] = [
    {
      id: 'm0',
      kind: 'cupola',
      pos: { x: 0, y: 0, z: 0 },
      sides: { w: null, e: link('m1', 'w') },
      props: [locker('m0-locker', -1.4, 0)],
      hideSpots: [hideLocker('m0-bunk', 0, -1, 'crew-bunk')],
    },
    {
      id: 'm1',
      kind: 'straight',
      pos: { x: 5, y: 0, z: 0 },
      sides: { w: link('m0', 'e'), e: link('m2', 'w') },
      props: [
        locker('m1-locker', -1.6, 0),
        panel('m1-breakers', 'panel-breaker', 0.5, 0.9),
      ],
      hideSpots: [hideLocker('m1-locker-in', 0, -1)],
    },
    {
      id: 'm2',
      kind: 'node',
      pos: { x: 10, y: 0, z: 0 },
      sides: { w: link('m1', 'e'), e: link('m3', 'w'), n: link('b0', 's') },
      props: [panel('m2-fuses', 'panel-fusebox', -1.2, 0.6)],
      hideSpots: [hideLocker('m2-bay', -1, 0, 'equipment-bay')],
    },
    {
      id: 'm3',
      kind: 'lab',
      pos: { x: 15, y: 0, z: 0 },
      sides: { w: link('m2', 'e'), e: link('m4', 'w') },
      props: [
        locker('m3-locker', 1.5, 0),
        panel('m3-gauge', 'panel-gauge', 0, 0.9),
      ],
      hideSpots: [hideLocker('m3-locker-in', 0, 1)],
    },
    {
      id: 'm4',
      kind: 'straight',
      pos: { x: 20, y: 0, z: 0 },
      sides: { w: link('m3', 'e'), e: link('m5', 'w') },
      props: [
        locker('m4-locker', -1.5, 0),
        panel('m4-lever', 'panel-undock', 0.8, 0.9),
      ],
      hideSpots: [hideLocker('m4-locker-in', 0, -1)],
    },
    {
      id: 'm5',
      kind: 'node',
      pos: { x: 25, y: 0, z: 0 },
      sides: { w: link('m4', 'e'), e: link('m6', 'w'), s: link('b1', 'n') },
      props: [panel('m5-lever', 'panel-undock', 0.8, -0.6)],
      hideSpots: [hideLocker('m5-bay', 0, 1, 'equipment-bay')],
    },
    {
      id: 'm6',
      kind: 'lab',
      pos: { x: 30, y: 0, z: 0 },
      sides: { w: link('m5', 'e'), e: link('m7', 'w') },
      lighting: 'dark',
      props: [panel('m6-lever', 'panel-undock', 0, 0.9)],
    },
    {
      id: 'm7',
      kind: 'airlock',
      pos: { x: 35, y: 0, z: 0 },
      sides: { w: link('m6', 'e'), e: null },
      lighting: 'nominal',
      props: [
        panel('m7-key-a', 'panel-keyswitch', -2, 0.8),
        panel('m7-key-b', 'panel-keyswitch', 2, 0.8),
        panel('m7-capsule', 'capsule-hatch', 2.2, 0),
      ],
    },
    {
      id: 'b0',
      kind: 'lab',
      pos: { x: 10, y: 0, z: 5 },
      sides: { s: link('m2', 'n'), n: null },
      props: [
        locker('b0-locker', 0, -1.4),
        panel('b0-valve', 'panel-valve', 0.9, 0),
      ],
      hideSpots: [hideLocker('b0-locker-in', -1, 0)],
    },
    {
      id: 'b1',
      kind: 'straight',
      pos: { x: 25, y: 0, z: -5 },
      sides: { n: link('m5', 's'), s: null },
      props: [
        locker('b1-locker', 0, 1.4),
        panel('b1-rack', 'cargo-rack', -0.9, 0),
      ],
      hideSpots: [hideLocker('b1-bunk', 1, 0, 'crew-bunk')],
    },
  ];

  return {
    id: 'iss-procedural-10',
    name: 'ISS (procedural, 10 modules)',
    modules: specs.map(buildModule),
    escapeModule: 'm7',
    finaleModule: 'm6',
  };
}

/** Load an authored layout from disk, or `null` if the path is unusable. */
export function loadLayoutFile(path: string): StationLayout | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as StationLayout;
    if (!parsed || !Array.isArray(parsed.modules) || parsed.modules.length === 0) {
      console.warn(`[station] '${path}' has no modules; falling back to the built-in layout`);
      return null;
    }
    for (const m of parsed.modules) {
      if (!Array.isArray(m.rails)) m.rails = [];
      if (!Array.isArray(m.props)) m.props = [];
      for (const p of m.ports) syncHatchAttenuation(p);
    }
    // The pivot's default, applied before anything reads the layout: a level
    // authored before `gravity` existed has floors everywhere, which is the
    // correct reading of a level that says nothing (§2).
    return normalizeLayoutGravity(parsed);
  } catch (err) {
    console.warn(`[station] could not read '${path}':`, (err as Error).message);
    return null;
  }
}

/**
 * Give a layout that authors NO hide spots one per `locker` prop.
 *
 * §4 sets a floor of six hide spots across the station and calls hiding a
 * missing verb rather than a nice-to-have; a level authored before the pivot has
 * none, and the alien's answer to "it's coming" collapses straight back to "move
 * faster". Rather than let that happen silently, the server derives a spot from
 * every locker prop already in the level — the prop is the fiction, the box is
 * the mechanic, and they were always in the same place.
 *
 * Strictly a fallback. It runs only when the layout has ZERO authored spots, so
 * the moment a level author adds one this never fires again. `DERIVE_HIDE_SPOTS=0`
 * turns it off and plays a station with no cover in it.
 *
 * Returns how many spots were added.
 */
export function deriveHideSpots(layout: StationLayout): number {
  let authored = 0;
  for (const m of layout.modules) authored += m.hideSpots?.length ?? 0;
  if (authored > 0) return 0;

  let added = 0;
  for (const module of layout.modules) {
    const spots: HideSpot[] = [];
    for (const prop of module.props) {
      if (prop.kind !== 'locker') continue;
      const spot = placeAgainstBulkhead(module, `${prop.id}-in`, prop.localPos);
      // No bearing clears the handrails: better NO hide spot here than one that
      // walls the alien out of the module the moment somebody climbs in.
      if (spot) spots.push(spot);
    }
    if (spots.length === 0) continue;
    module.hideSpots = spots;
    added += spots.length;
  }
  return added;
}

/**
 * Find a bearing on which a hide box fits against the bulkhead without
 * straddling a handrail.
 *
 * Starts from the prop's own bearing (the fiction should stay where the artist
 * put it) and sweeps outward in `BEARING_STEPS` increments, taking the first
 * clear one — so the box moves as little as it has to. Returns null if the
 * module's rails leave nowhere to put it, which is a real answer for a node
 * piece whose six handrails all meet at the hub.
 *
 * Deliberately a LOCAL-space test rather than one on `HideSpotGraph`: the graph
 * cannot be built until the spots exist, and the module's own transform cancels
 * out of both sides anyway.
 */
function placeAgainstBulkhead(
  module: StationModule,
  id: string,
  near: Vec3,
): HideSpot | null {
  const len = Math.hypot(near.x, near.z);
  const base = len > 1e-3 ? Math.atan2(near.x, near.z) : Math.PI;
  for (let i = 0; i < BEARING_STEPS; i++) {
    // 0, +1, -1, +2, -2 … in steps of a full turn / BEARING_STEPS.
    const offset = (Math.ceil(i / 2) * (i % 2 === 0 ? -1 : 1) * 2 * Math.PI) / BEARING_STEPS;
    const theta = base + offset;
    const spot = hideLocker(id, Math.sin(theta), Math.cos(theta));
    if (!module.rails.some((rail) => railTouchesSpot(rail, spot))) return spot;
  }
  return null;
}

/** How many bearings `placeAgainstBulkhead` will try before giving up. */
const BEARING_STEPS = 24;

/**
 * Margin, in metres, at which a handrail counts as passing through a hide box.
 *
 * The same number the alien routes around with (`HIDE_CLEARANCE_M` in
 * `sim/alien.ts`), so the loader's warning and the AI's collision agree about
 * what "in the way" means. Small on purpose — see the reasoning on that
 * constant; a full body radius would call most of a node piece blocked.
 */
const HIDE_CLEARANCE_M = 0.15;

/** Segment-vs-oriented-box overlap, in module space. Slab method, exact. */
function railTouchesSpot(rail: RailSegment, spot: HideSpot): boolean {
  const q = spot.localQuat ?? { x: 0, y: 0, z: 0, w: 1 };
  const a = intoSpotFrame(rail.a, spot.localPos, q);
  const b = intoSpotFrame(rail.b, spot.localPos, q);
  const h = spot.halfExtents;
  const extents = [h.x + HIDE_CLEARANCE_M, h.y + HIDE_CLEARANCE_M, h.z + HIDE_CLEARANCE_M];
  const from = [a.x, a.y, a.z];
  const to = [b.x, b.y, b.z];

  let tMin = 0;
  let tMax = 1;
  for (let axis = 0; axis < 3; axis++) {
    const origin = from[axis];
    const delta = to[axis] - origin;
    const extent = extents[axis];
    if (Math.abs(delta) < 1e-9) {
      if (origin < -extent || origin > extent) return false;
      continue;
    }
    const inv = 1 / delta;
    let t0 = (-extent - origin) * inv;
    let t1 = (extent - origin) * inv;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tMin) tMin = t0;
    if (t1 < tMax) tMax = t1;
    if (tMin > tMax) return false;
  }
  return true;
}

/** World-ish (module-space) point into a spot's own frame: translate, then
 *  rotate by the conjugate. */
function intoSpotFrame(p: Vec3, centre: Vec3, q: Quat): Vec3 {
  const d = { x: p.x - centre.x, y: p.y - centre.y, z: p.z - centre.z };
  // v' = q* · d · q, written out so this file needs no quaternion import.
  const ix = -q.x;
  const iy = -q.y;
  const iz = -q.z;
  const tx = 2 * (iy * d.z - iz * d.y);
  const ty = 2 * (iz * d.x - ix * d.z);
  const tz = 2 * (ix * d.y - iy * d.x);
  return {
    x: d.x + q.w * tx + (iy * tz - iz * ty),
    y: d.y + q.w * ty + (iz * tx - ix * tz),
    z: d.z + q.w * tz + (ix * ty - iy * tx),
  };
}

export interface LoadedStation {
  layout: StationLayout;
  graph: ModuleGraph;
  rails: RailGraph;
  /** §4's hide spots resolved into world space — geometry only, never sight. */
  hides: HideSpotGraph;
  problems: string[];
}

export interface LoadStationOptions {
  /** Derive hide spots from locker props when the level authors none. Default
   *  true; `DERIVE_HIDE_SPOTS=0` in the environment turns it off. */
  deriveHideSpots?: boolean;
}

/**
 * Build the graphs and report anything wrong with the layout. Problems are
 * logged, not thrown: a station with one bad rail should still boot for a
 * playtest, and `RailGraph.validate()` is the fastest way to find the authoring
 * mistake the foundation warns about (segments authored as connected that do
 * not actually meet).
 */
export function loadStation(layoutPath?: string, opts: LoadStationOptions = {}): LoadedStation {
  const layout = (layoutPath ? loadLayoutFile(layoutPath) : null) ?? proceduralLayout();
  normalizeLayoutGravity(layout);
  if (opts.deriveHideSpots !== false) {
    const added = deriveHideSpots(layout);
    if (added > 0) {
      console.warn(
        `[station] '${layout.id}' authored no hide spots; derived ${added} from its locker props ` +
          `(§4 wants at least ${HIDE_SPOTS_MIN}). Author them in the level to silence this.`,
      );
    }
  }
  const graph = new ModuleGraph(layout.modules);
  const rails = new RailGraph(graph);
  const hides = new HideSpotGraph(graph);
  const problems = [
    ...graph.validate(),
    ...rails.validate(),
    ...hides.validate(),
    ...railsThroughHideSpots(rails, hides, graph),
  ];
  return { layout, graph, rails, hides, problems };
}

/**
 * Authoring note: a hide spot sitting ON a handrail.
 *
 * An OCCUPIED hide volume is solid to the alien (that is the physical half of
 * §4's mechanic), and the alien rail-follows through every module (§2). A box
 * authored across a rail is therefore a box that briefly re-routes the alien's
 * nervous system the moment somebody climbs into it. It recovers — it lets go of
 * the rail, glides around and re-plans — but in a node piece, whose handrails
 * all meet at the hub, one occupant can make it detour around the junction the
 * whole module hangs off. Worth knowing at load rather than discovering as a
 * mysteriously indirect alien.
 *
 * One line per spot, not per rail: a node's six spokes would otherwise print six
 * copies of the same fact.
 */
function railsThroughHideSpots(
  rails: RailGraph,
  hides: HideSpotGraph,
  graph: ModuleGraph,
): string[] {
  const problems: string[] = [];
  for (const volume of hides.volumes()) {
    // Only meaningful where rails ARE the navigation graph. After the pivot the
    // alien walks the deck in a `nominal` module and its handrails are scenery,
    // so a hide spot overlapping one costs nothing — an occupant cannot make it
    // "route around them" via a rail it never uses. Checking every module made
    // this fire on all six floored consoles at once and buried the real
    // authoring mistakes it exists to catch.
    if (graph.hasFloor(volume.module)) continue;
    const straddled = rails
      .inModule(volume.module)
      .filter((node) => hides.segmentHit(volume, node.a, node.b, HIDE_CLEARANCE_M) !== null)
      .map((node) => node.key);
    if (straddled.length === 0) continue;
    problems.push(
      `hide spot '${volume.key}' straddles ${straddled.length} handrail(s) ` +
        `(${straddled.join(', ')}) — an occupant makes the alien route around them`,
    );
  }
  return problems;
}

/**
 * Where a body wakes up in a module (§10 random spawns).
 *
 * Gravity-aware, because the pivot made walking the default: in a `nominal`
 * module you are put on the deck at the module centre, standing, which is what
 * the client's ground probe and `GROUND_SNAP_M` expect to find under a body. In
 * a `zero` module the old behaviour is exactly right and unchanged — the middle
 * of its longest handrail, nudged off the rail so you start FLOATING inside
 * `GRAB_RANGE` of it.
 *
 * `rideHeight` is the height ABOVE THE DECK of the thing being placed, and it is
 * a parameter rather than a constant because the two callers do not agree and
 * cannot: the player controller reports its **eye** as `pos` (§4 — the body
 * hangs below it, so a `settle` does not teleport the camera), while the alien
 * rides at `DECK_Y_M + ALIEN_RADIUS`. Placing a player at a radius above the
 * plating buries the whole capsule in the deck, where the collider wedges it and
 * it can never stand up — a round that ends before it starts, and silently,
 * because nothing on either side is wrong on its own.
 */
export function spawnPointIn(
  graph: ModuleGraph,
  moduleId: ModuleId,
  rails: RailGraph,
  rideHeight: number = PLAYER_RADIUS,
): Vec3 {
  const centre = graph.centre(moduleId);

  if (graph.hasFloor(moduleId) && centre) {
    return { x: centre.x, y: centre.y + DECK_Y_M + rideHeight, z: centre.z };
  }

  const nodes = rails.inModule(moduleId);
  if (nodes.length > 0) {
    let best = nodes[0];
    for (const n of nodes) if (n.length > best.length) best = n;
    return { x: best.mid.x, y: best.mid.y + 0.4, z: best.mid.z };
  }
  return centre ? { ...centre } : { x: 0, y: 0, z: 0 };
}
