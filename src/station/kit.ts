/**
 * The modular kit (DESIGN.md §2).
 *
 * "Modules are cylinders — build a kit of five pieces (straight 5m, 6-way node,
 * endcap, cupola, airlock) and snap them via ports. Authoring is then a JSON
 * file, and you get a level editor almost free."
 *
 * This file is the PURE half of the kit: dimensions, ports, handrail segments,
 * light-strip placement and deterministic decor. It imports no three.js, so
 * `buildLevel.ts` (which regenerates `levels/station.json` under tsx) and the
 * runtime loader share exactly one definition of what a piece is.
 * `geometry.ts` is the three.js half and turns these numbers into meshes.
 *
 * The endcap is the fifth piece and is not a module kind: it is the cap that
 * closes any port with `link === null`, so it instances off port data rather
 * than appearing in this table. `lab` is the sixth entry because `ModuleKind`
 * (shared/types) has one and a station of nothing but corridors is dull.
 *
 * Conventions
 * -----------
 * • Cylindrical pieces run along local **+Z**; their axial ports sit at ±L/2.
 * • Local **+Y is "up"** inside a module, purely so decor reads consistently.
 * • Wall-mounted props are authored with local **+Y pointing into the interior**
 *   and local **+Z along their long axis** (see `orientProp`).
 * • Every rail endpoint that reaches a port sits EXACTLY on that port's
 *   RAIL JUNCTION — `(0, RAIL_Y_M, portZ)`, the point on the station's single
 *   overhead rail plane directly above the port axis. Two mated modules put
 *   their ports at one world point and their decks on one world plane, so both
 *   sides' junctions are the same world point and their rails meet with zero
 *   gap. This is the §2 note about rail continuity being the easiest thing in
 *   the system to get wrong; `buildLevel.ts` also refuses a level that links a
 *   port no rail declares.
 */

import type {
  GravityMode,
  HideSpot,
  LightingLevel,
  ModuleId,
  ModuleKind,
  PortId,
  PropRef,
  Quat,
  RailSegment,
  RailSegmentId,
  Vec3,
} from '@shared/types';
import { DECK_Y_M, PLAYER_STAND_HEIGHT_M, TUBE_RADIUS_M,
  RAIL_ABOVE_DECK_M,
  RAIL_Y_M,
} from '@shared/constants';

export { RAIL_ABOVE_DECK_M, RAIL_Y_M };
import { v3 } from '@shared/graph/math';
import { orientProp, roundVec } from './transform';
import { randRange } from './random';
import {
  BANK_SIZE,
  BENCH_SIZE,
  BULKHEAD_SIZE,
  CARGO_BAG_SIZE,
  CARGO_RACK_SIZE,
  cornerFins,
  cupolaDeck,
  deckBay,
  labIsland,
  nodeBackWalls,
  nodeConsoleVoid,
  nodeDeck,
  stowageNet,
  tubeChicane,
  tubeDeck,
} from './deckKit';
import type { DeckDef } from './deckKit';

// ---------------------------------------------------------------------------
// Shared dimensions
// ---------------------------------------------------------------------------

/**
 * The radius this kit's proportions were drawn at.
 *
 * Every other radius below is a MULTIPLE of the straight tube's bore, never an
 * offset from it, so that widening the corridor widens the whole station
 * coherently instead of leaving the lab and the airlock as the two rooms that
 * did not get the memo. `KIT_SCALE` is the one place the widening enters: it is
 * 1.0 while `TUBE_RADIUS_M` is 1.0, and 1.5 now that §14 has widened the bore.
 */
const KIT_BASE_R = 1.0;
const KIT_SCALE = TUBE_RADIUS_M / KIT_BASE_R;

/** Scale a dimension drawn against `KIT_BASE_R` onto the current bore. */
function scaled(v: number): number {
  return round2(v * KIT_SCALE);
}

/**
 * Radius of a hatch opening.
 *
 * DELIBERATELY NOT SCALED with the bore. A hatch is sized to the BODY that goes
 * through it, not to the room on either side — every port in the station is the
 * same fitting, which is what lets a 1.5 m straight mate to a 2.1 m lab with no
 * seam and no step, and what keeps `collision.ts`' blocker disc, `hatches.ts`'
 * door and `player/hatchBarrier.ts` agreeing about one number. Widening the
 * tubes and leaving this alone is what turns a hatch back into a threshold you
 * notice rather than an arbitrary hole.
 *
 * A standing body does not pass a 0.7 m circle at all; the walk-through slot cut
 * down to the deck is what it uses (`DOORWAY_HALF_W`, `deckKit.ts`).
 */
export const PORT_RADIUS = 0.7;
/** Handrail tube radius. Thin: it is a grab rail, not a pipe. */
export const RAIL_RADIUS = 0.04;
/** How far a rack face stands proud of the hull. */
export const RACK_DEPTH = 0.22;
/** Clearance between a handrail and the rack face behind it. */
export const RAIL_CLEARANCE = 0.08;

/**
 * HEIGHT ABOVE THE DECK OF EVERY HANDRAIL IN THE STATION.
 *
 * The rails used to run at axis height in a `nominal` module and along the floor
 * and the crown in a `zero` one. A playtester walking a gravity module put it
 * plainly — "move all the rails on the floor to the ceiling, otherwise it looks
 * very clunky when you walk" — and they were right twice over: a rail at the
 * floor is something you step over, and a rail at axis height (0.75 m over the
 * deck) is a bar across your hips in the one room the pivot made you walk down.
 *
 * So there is now ONE rail plane for the whole station, overhead, and it is
 * derived rather than chosen:
 *
 *   • it clears a standing crew member — `PLAYER_STAND_HEIGHT_M` plus 0.22 m,
 *     which leaves 0.18 m of air over the head after the rail's own 0.04 m
 *     radius, at every bore, because the HEIGHT is fixed and the lateral offset
 *     is whatever that height meets the hull at;
 *   • it stays inside `GRAB_RANGE` (0.8 m) of a standing eye 0.37 m below it, so
 *     §4's gravity-failure fairness guarantee — 2.5 s of warning is only fair if
 *     there is something to grab at the end of it — survives the move;
 *   • it is well under `DECK_HEADROOM_M` (2.25 m), so the rail hangs from the
 *     upper wall rather than being buried in the crown.
 *
 * In a `zero` module nothing about this is a compromise: zero-G has no up, and a
 * rail overhead is a rail. Both rails of a pair stay on the graph, still loop
 * through both ports, and `RailGraph` never learns that anything moved.
 */
/** Module-space Y of that plane. Every module's deck is at `DECK_Y_M`, and every
 *  `nominal` module's local +Y is world up, so this is one number station-wide. */

export type KitPieceId = ModuleKind;

export interface KitPortDef {
  id: PortId;
  localPos: Vec3;
  /** Outward normal, unit length. */
  localDir: Vec3;
}

/** An emissive light strip (§9 "everything else is emissive strips"). */
export interface StripDef {
  pos: Vec3;
  /** Full box size. */
  size: Vec3;
}

// ---------------------------------------------------------------------------
// The interior kit (asset bible ISS-STR-01, ISS-STR-07, ISS-GRV-11)
// ---------------------------------------------------------------------------

/**
 * Shielded lighting cove: channel width, cheek depth, and the reach of the lip
 * that hides the bar (ISS-STR-07 — "you see the wash, never the source").
 *
 * These live in this file rather than in `geometry.ts` because the CHANNEL and
 * the BAR INSIDE IT are authored in two different places — the channel is trim
 * geometry, the bar is one of the module's emissive strips — and a cove whose
 * lamp has drifted out of it is a lamp in a torch beam. `geometry.ts` imports
 * these to build the channel; `coveStrips` below uses the same numbers to place
 * the bar, so there is one source of truth for both halves.
 */
export const COVE_W = 0.13;
export const COVE_D = 0.062;
export const COVE_LIP = 0.085;
/** Square section of the emissive bar, so it needs no rotation to sit straight
 *  in a channel at any wall angle. */
export const COVE_STRIP = 0.04;
/** Where the bar sits in the channel: pushed against the shallow cheek, and
 *  deep enough that the lip covers it from below. */
export const COVE_STRIP_U = 0.026;
export const COVE_STRIP_V = 0.036;

/**
 * Which tangential side of a cove the shielding lip goes on: always the side
 * facing the DECK, so the lip is between the bar and the player.
 *
 * The wall frame's +X is the counter-clockwise tangent, whose vertical component
 * is `cos(angle)` — so on the +X half of a tube (`cos > 0`) counter-clockwise is
 * up and the lip belongs on −X, and on the −X half it is the other way round.
 * Get this wrong on one side of a corridor and half the coves are floodlights
 * pointed at the floor.
 */
export function coveSign(angle: number): 1 | -1 {
  return Math.cos(angle) >= 0 ? 1 : -1;
}

/**
 * A point in a wall frame, in module space: `u` tangential (counter-clockwise),
 * `v` inward from the hull, `z` along the module axis. The pure twin of
 * `geometry.ts`'s `wallPlace`.
 */
export function wallFrameVec(
  radius: number,
  angle: number,
  u: number,
  v: number,
  z: number,
): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return v3(radius * c - u * s - v * c, radius * s + u * c - v * s, z);
}

/** What a piece's interior is made of. Read at RUNTIME by `geometry.ts`, so it
 *  is not baked into `levels/station.json` and can change with the art pass
 *  without a level rebuild. */
export interface InteriorDef {
  /** Ring-frame stations along +Z. Cylindrical pieces only. */
  ribs?: readonly number[];
  /** Wall angles (radians about +Z, 0 on +X) carrying a shielded cove. */
  coves?: readonly number[];
  /** Wall angles carrying a cable raceway tray. */
  trays?: readonly number[];
  /** Build the overhead service run (ISS-GRV-11). */
  overhead?: boolean;
  /** Node only: corner chases and a coffered ceiling. */
  posts?: boolean;
}

/**
 * Ring-frame stations for a run of `length`: `count` evenly spaced, half a
 * spacing in from each bulkhead. Four in a 5 m tube is a station every 1.25 m —
 * a rhythm a walking player reads as distance covered, which is the whole point
 * of ISS-STR-01, and it is close enough to `STRIDE_WALK_M × 1.67` that footfalls
 * and frames do not beat against each other.
 */
export function ribStations(length: number, count: number): number[] {
  const step = length / count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(-length / 2 + step / 2 + i * step);
  return out;
}

/** The emissive bars that live inside `angles`' coves, on a run of `length`
 *  centred at `z`. */
export function coveStrips(
  radius: number,
  angles: readonly number[],
  length: number,
  z = 0,
): StripDef[] {
  return angles.map((angle) => ({
    pos: roundVec(
      wallFrameVec(radius, angle, coveSign(angle) * COVE_STRIP_U, COVE_STRIP_V, z),
    ),
    size: v3(COVE_STRIP, COVE_STRIP, length),
  }));
}

export interface KitPiece {
  id: KitPieceId;
  kind: ModuleKind;
  /** Hull radius for cylinders; half-extent for the cubic node. */
  radius: number;
  /** Length along local +Z; full width for the node. */
  length: number;
  /** m³ — drives reverb selection (§2, §8). */
  volume: number;
  /** Distance from the axis to the handrails. */
  railOffset: number;
  ports: KitPortDef[];
  /**
   * Handrails for this piece under `gravity` (§2 "Author rails in every module,
   * but only zero-G modules use them for player movement").
   *
   * Rails are authored in BOTH regimes and that is not negotiable, for two
   * reasons the pivot makes sharper rather than softer: the alien rail-follows
   * inside every module at scope `any` (§5), and §4's gravity-failure fairness
   * guarantee — 2.5 s of warning is only fair if there is something to grab at
   * the end of it — is a promise about geometry, not about timing. The server's
   * own director agrees: it refuses to drop the floor in a module with no rails.
   *
   * `gravity` no longer changes WHERE they run, and this signature is the
   * vestige of when it did. There were three layouts — a floor-and-ceiling pair
   * in `zero`, a side-wall pair at axis height in `nominal` — and the playtest
   * that produced `RAIL_ABOVE_DECK_M` collapsed all of them into one overhead
   * plane for the whole station. What `gravity` still decides is the piece's
   * rail TOPOLOGY, and in the shipped kit that is exactly one segment: a node's
   * `rs-ny` floor spoke, which exists only where there is no deck plated over
   * the −Y port (see `nodeRails`). Every other piece returns the same six
   * segments either way. Keep the parameter — it is what lets a piece drop a
   * spoke that leads into plating — but do not reintroduce a height.
   */
  rails(gravity: GravityMode): RailSegment[];
  strips: StripDef[];
  /**
   * What the inside of this piece is built from (ISS-STR-01/07, ISS-GRV-11).
   * Optional so a new piece is a bare shell until somebody dresses it.
   */
  interior?: InteriorDef;
  /**
   * Ports that open on VACUUM (ISS-STR-04). The level never links one, so it is
   * always capped — but it is capped with an armoured plate and `hatches.ts`
   * builds the heavy outer door on it, because "the outer door must read as a
   * threat" and a threat that looks like every other blank is not one.
   */
  outerPorts?: readonly PortId[];
  /** The walkable deck (§4), or null for a piece that never has one. */
  deck: DeckDef | null;
  /** Deterministic decor for one instance of this piece. */
  decor(moduleId: ModuleId, rng: () => number, gravity: GravityMode): PropRef[];
  /** Hide spots this piece carries by default (§4). */
  hideSpots(moduleId: ModuleId, gravity: GravityMode): HideSpot[];
  /** Suggested default lighting when the level author does not say (§10 — the
   *  station wakes on emergency power). */
  defaultLighting: LightingLevel;
}

// ---------------------------------------------------------------------------
// Prop archetypes — one draw call per type (§9)
// ---------------------------------------------------------------------------

export interface PropArchetype {
  /** Box props: full size, x = width, y = depth into the wall, z = length. */
  size?: Vec3;
  /** Cylinder props. */
  radius?: number;
  length?: number;
  /** false → gets its own mesh because it animates or carries a unique texture. */
  instanced: boolean;
  /** Raycastable by the §4 interaction raycaster. */
  interactable: boolean;
}

// PROP SIZES ARE MEASURED AGAINST A 1.6 m CREWMEMBER, not against the tube.
//
// The same playtest that called the corridors too narrow called the props too
// big, and the two complaints are one complaint: everything in here had quietly
// been drawn to fill a 1.0 m bore, so a "wall panel" was 0.86 m across — half a
// person — and a stowage bag was the size of a washing machine. Widening the
// hull does not fix that, it hides it; the fix is to size each prop against the
// body that stands in front of it. The reference figures used below are the real
// station's, scaled to a 1.6 m crew member:
//
//   rack face      0.90 × 1.30 m   (an ISPR bay, chest to over the head)
//   stowage bag    0.46 × 0.30 × 0.34 m  (a CTB, two hands and a knee)
//   locker face    0.60 × 0.46 m, 0.34 m deep
//   laptop         0.34 × 0.24 m   (unchanged: it was already right)
//
// The PANEL is the one entry with no reference figure here, because it is the
// one prop that did not move — see its own note below for why 0.86 × 0.58 stays.
//
// Deck FURNITURE (`bulkhead`, `bench`, `bank`) is the exception and is sized
// against the DECK instead — it is chase geometry, and §2's job for it is to
// leave a lane rather than to look like an object. See `deckKit.ts`.
export const PROP_ARCHETYPES = {
  /** Equipment rack — the interior detailing on all four walls. */
  rack: { size: v3(0.9, RACK_DEPTH, 1.3), instanced: true, interactable: false },
  /** Cable bundle running the length of a corner. */
  cable: { radius: 0.042, length: 1.6, instanced: true, interactable: false },
  /** White stowage bag strapped to a rack face. */
  stowage: { size: v3(0.46, 0.3, 0.34), instanced: true, interactable: false },
  /** Laptop on an articulated arm — a faint emissive screen in the dark. */
  laptop: { size: v3(0.34, 0.04, 0.24), instanced: true, interactable: false },
  /** Cargo rack slot marker for §11 puzzle 3. */
  slot: { size: v3(0.54, 0.09, 0.46), instanced: true, interactable: false },
  /** Hub ball where a node's handrail spokes meet. */
  hub: { radius: 0.14, instanced: true, interactable: false },
  /** Interactable container: breaker card, fuses and decoys spawn in these (§5, §11). */
  locker: { size: v3(0.6, 0.34, 0.46), instanced: false, interactable: true },
  /**
   * In-world puzzle panel — the UI agent attaches a CanvasTexture (§6).
   *
   * LEFT ALONE at 0.86 × 0.58, deliberately, while everything around it came
   * down. It is the one prop in the table that is not free to move: §11's
   * fixtures — the breaker gang, the valve wheel, the gauge can, the keyswitch,
   * the undock plinth — are hand-placed in absolute metres against this plate
   * and deliberately overhang it, and `assertFixturesCoherent()` measures the
   * lot against `SCREEN_ACROSS`, which is derived from it. Shrinking the plate
   * without re-authoring five fixtures leaves a small rectangle floating inside
   * a full-sized instrument. It is also not egregious against a 1.6 m crew
   * member — waist to chin, which is what a rack-front control panel is.
   */
  panel: { size: v3(0.86, 0.07, 0.58), instanced: false, interactable: true },

  // -- deck furniture (§2 "corners, not tubes") -----------------------------
  // These use `deckKit`'s convention, NOT the wall convention above: x = width
  // across the lane, y = HEIGHT, z = depth along the corridor, and they stand on
  // the deck rather than hanging off a wall. Every one of them is solid in the
  // BVH — that is the entire point, since a blind pursuer is routed by geometry
  // and nothing else.
  /** Partial bulkhead — half a lane, too tall to vault. Makes a straight weave. */
  bulkhead: { size: BULKHEAD_SIZE, instanced: true, interactable: false },
  /** Lab bench; two end to end make the island the lab loops around. */
  bench: { size: BENCH_SIZE, instanced: true, interactable: false },
  /** Full-height equipment bank — turns a flat wall into a corner and a bay. */
  bank: { size: BANK_SIZE, instanced: true, interactable: false },
  /** §11 puzzle 3's rack. Wall convention (y = depth), like `rack`. */
  'cargo-rack': { size: CARGO_RACK_SIZE, instanced: true, interactable: false },
  /** One of the five numbered bags. Its own mesh: it becomes a rigid body. */
  'cargo-bag': { size: CARGO_BAG_SIZE, instanced: false, interactable: true },
} as const satisfies Record<string, PropArchetype>;

export type PropKind = keyof typeof PROP_ARCHETYPES;

export function propArchetype(kind: string): PropArchetype | undefined {
  return (PROP_ARCHETYPES as Record<string, PropArchetype>)[kind];
}

// ---------------------------------------------------------------------------
// Small authoring helpers
// ---------------------------------------------------------------------------

function seg(
  id: RailSegmentId,
  a: Vec3,
  b: Vec3,
  connects: RailSegmentId[],
  portLink?: PortId,
): RailSegment {
  const s: RailSegment = { id, a, b, connects };
  if (portLink) s.portLink = portLink;
  return s;
}

/** The four cardinal wall angles of a cylindrical module, measured about +Z. */
const WALL_ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
/** The four diagonal corners, where cable runs live. */
const CORNER_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, -Math.PI / 4];

function onWall(radius: number, angle: number, z: number, inset: number): Vec3 {
  const r = radius - inset;
  return v3(Math.cos(angle) * r, Math.sin(angle) * r, z);
}

function wallInward(angle: number): Vec3 {
  return v3(-Math.cos(angle), -Math.sin(angle), 0);
}

function prop(
  id: string,
  kind: PropKind,
  localPos: Vec3,
  localQuat?: Quat,
  scale?: number,
): PropRef {
  const arch = PROP_ARCHETYPES[kind];
  const p: PropRef = { id, kind, localPos: roundVec(localPos) };
  if (localQuat) p.localQuat = localQuat;
  if (scale !== undefined && scale !== 1) p.scale = scale;
  if (arch.interactable) p.interactable = true;
  return p;
}

/**
 * Which walls a tube may carry racks on, by gravity mode.
 *
 * A `nominal` tube gets the two SIDE walls and no others. A rack on the −Y wall
 * would be buried under the deck, and the +Y wall — the crown — is now the
 * HANDRAIL's quadrant: the overhead pair runs at `RAIL_Y_M` where that height
 * meets the rack circle, which in a 1.5 m bore is about 68° and 112°, and a
 * 1.3 m rack centred on the crown would span 65°–115° and swallow both of them.
 * (Before the widening the reason was different and harsher: `DECK_HEADROOM_M`
 * was 1.75 m against a 1.7 m collider, so the ceiling of a gravity module was
 * not authorable space at all.)
 *
 * A `zero` tube keeps all four — with no floor there is no up, and racks on
 * every wall are what make that legible. Its crown rack is also what the
 * overhead rails stand off, which is why they are `RACK_DEPTH + RAIL_CLEARANCE`
 * in from the hull rather than bolted to it.
 */
const DECK_WALL_ANGLES: readonly number[] = [0, Math.PI];

function wallsFor(gravity: GravityMode): readonly number[] {
  return gravity === 'zero' ? WALL_ANGLES : DECK_WALL_ANGLES;
}

/** Racks on `walls`, `bays` deep along the module axis. */
function tubeRacks(
  moduleId: ModuleId,
  radius: number,
  bays: readonly number[],
  walls: readonly number[],
  scale = 1,
): PropRef[] {
  const out: PropRef[] = [];
  const inset = (RACK_DEPTH * scale) / 2;
  for (let w = 0; w < walls.length; w++) {
    const angle = walls[w] as number;
    for (let i = 0; i < bays.length; i++) {
      out.push(
        prop(
          `${moduleId}-rack-${w}${i}`,
          'rack',
          onWall(radius, angle, bays[i] as number, inset),
          orientProp(wallInward(angle), v3(0, 0, 1)),
          scale,
        ),
      );
    }
  }
  return out;
}

/** Cable bundles in the upper corners, running the module axis. */
function tubeCables(
  moduleId: ModuleId,
  radius: number,
  zs: readonly number[],
  corners: readonly number[] = [CORNER_ANGLES[0] as number, CORNER_ANGLES[1] as number],
): PropRef[] {
  const out: PropRef[] = [];
  const arch = PROP_ARCHETYPES.cable;
  for (let c = 0; c < corners.length; c++) {
    const angle = corners[c] as number;
    for (let i = 0; i < zs.length; i++) {
      out.push(
        prop(
          `${moduleId}-cable-${c}${i}`,
          'cable',
          onWall(radius, angle, zs[i] as number, arch.radius + 0.03),
          orientProp(wallInward(angle), v3(0, 0, 1)),
        ),
      );
    }
  }
  return out;
}

/** A handful of stowage bags strapped to random rack faces. */
function tubeStowage(
  moduleId: ModuleId,
  rng: () => number,
  radius: number,
  count: number,
  halfLength: number,
  walls: readonly number[],
): PropRef[] {
  const out: PropRef[] = [];
  const depth = (PROP_ARCHETYPES.stowage.size.y as number) / 2;
  for (let i = 0; i < count; i++) {
    const angle =
      (walls[Math.floor(rng() * walls.length) % walls.length] as number) +
      randRange(rng, -0.3, 0.3);
    const z = randRange(rng, -halfLength + 0.6, halfLength - 0.6);
    out.push(
      prop(
        `${moduleId}-bag-${i}`,
        'stowage',
        onWall(radius, angle, z, RACK_DEPTH + depth),
        orientProp(wallInward(angle), v3(0, 0, 1)),
      ),
    );
  }
  return out;
}

/** Every module carries exactly one locker (§5 decoys / §11 card and fuses). */
function moduleLocker(moduleId: ModuleId, radius: number, z: number, angle: number): PropRef {
  const depth = (PROP_ARCHETYPES.locker.size.y as number) / 2;
  return prop(
    `${moduleId}-locker`,
    'locker',
    onWall(radius, angle, z, RACK_DEPTH + depth),
    orientProp(wallInward(angle), v3(0, 0, 1)),
  );
}

/**
 * Where a cylindrical piece's overhead rail pair sits, across the bore.
 *
 * The rail hangs off the same line the racks do (`RACK_DEPTH` proud of the hull
 * plus `RAIL_CLEARANCE` of knuckle room), and the HEIGHT is fixed station-wide
 * at `RAIL_Y_M` — so the lateral offset is simply where that height crosses that
 * circle. A wider bore therefore pushes its rails further apart instead of
 * higher, which is exactly the behaviour you want: head clearance is identical
 * in every room in the station, and the widest room gets the widest ladder.
 */
export function tubeRailX(radius: number): number {
  const r = radius - RACK_DEPTH - RAIL_CLEARANCE;
  return round2(Math.sqrt(Math.max(0.04, r * r - RAIL_Y_M * RAIL_Y_M)));
}

/**
 * A port's rail junction: the point on the overhead rail plane directly above
 * the port's axis.
 *
 * THIS IS THE JOIN, AND IT IS THE EASIEST THING IN THE SYSTEM TO BREAK (§2). Two
 * mated modules put their ports at one world point and their decks on one world
 * plane, so `(0, RAIL_Y_M, portZ)` in one module's frame is bit-for-bit the same
 * world point as the far module's — the rails meet with zero gap, exactly as
 * they used to when they met ON the port, and `RailGraph.validate()` stays
 * quiet. What changes is that they now meet 1.07 m up, ABOVE the doorway crown
 * (`DOORWAY_TOP` = 0.86) rather than through the middle of the opening, so no
 * rail crosses a hatch a body has to walk through.
 *
 * Cross-module continuation still resolves through `portLink` (`declares`),
 * which is distance-independent; `EPS_PORT_JOIN`'s 1 m proximity test is the
 * belt-and-braces path and is not needed here.
 */
function railJunction(port: Vec3): Vec3 {
  return v3(0, RAIL_Y_M, port.z);
}

/**
 * Two long rails that both terminate on both ports. Six segments; the pair meets
 * at each port so the module's rail graph is a loop and a player can round the
 * tube without letting go.
 *
 * BOTH RAILS ARE OVERHEAD, in both gravity modes, and the pair is flat: every
 * endpoint sits on the `RAIL_Y_M` plane. See `RAIL_ABOVE_DECK_M` for why, and
 * note what did NOT change — same ids, same count, same `connects`, same port
 * links, so a module whose gravity the director drops mid-round keeps the rail
 * graph it was authored with and nothing downstream has a topology change to
 * notice.
 */
function tubeRails(
  halfLength: number,
  radius: number,
  aftPort: PortId,
  fwdPort: PortId,
  straightHalf: number,
): RailSegment[] {
  const aft = railJunction(v3(0, 0, -halfLength));
  const fwd = railJunction(v3(0, 0, halfLength));
  const offset = tubeRailX(radius);
  // `f` is the rail on the −X side, `c` the one on the +X side.
  const at = (sign: number, z: number): Vec3 => v3(sign * offset, RAIL_Y_M, z);
  return [
    seg('rf-a', aft, at(-1, -straightHalf), ['rf-m', 'rc-a'], aftPort),
    seg('rf-m', at(-1, -straightHalf), at(-1, straightHalf), ['rf-a', 'rf-b']),
    seg('rf-b', at(-1, straightHalf), fwd, ['rf-m', 'rc-b'], fwdPort),
    seg('rc-a', aft, at(1, -straightHalf), ['rc-m', 'rf-a'], aftPort),
    seg('rc-m', at(1, -straightHalf), at(1, straightHalf), ['rc-a', 'rc-b']),
    seg('rc-b', at(1, straightHalf), fwd, ['rc-m', 'rf-b'], fwdPort),
  ];
}

/**
 * The cross-section every cylindrical piece is dressed on, by wall angle.
 *
 * Nothing shares an angle, which was survival in a 1.0 m bore and is still how
 * the room reads as built rather than dressed:
 *
 *   0° / 180°  racks (`tubeRacks`)
 *   45° / 135° cable raceway trays, which is exactly where `tubeCables` already
 *              puts its bundles — the tray is the thing they lie in
 *   60° / 120° shielded lighting coves, with the module's emissive bars inside
 *   74–113°    the overhead run (`geometry.ts`), hugging the hull
 *
 * The HANDRAILS no longer belong to an angle at all: they run at a fixed height
 * (`RAIL_Y_M`) and meet the rack circle wherever that height crosses it, which
 * in a 1.5 m bore is about 68° and 112°. They pass a clear 0.2 m INSIDE the
 * overhead run — nothing in that run comes below `radius − 0.1` — so the two
 * families share the upper quadrants without sharing a millimetre.
 */
const TUBE_COVE_ANGLES: readonly number[] = [Math.PI / 3, (2 * Math.PI) / 3];
const TUBE_TRAY_ANGLES: readonly number[] = [Math.PI / 4, (3 * Math.PI) / 4];

/** The interior of a cylindrical piece: ring frames on the stride rhythm, two
 *  coves, two raceways and an overhead run. */
function tubeInterior(length: number, ribs = 4): InteriorDef {
  return {
    ribs: ribStations(length, ribs),
    coves: TUBE_COVE_ANGLES,
    trays: TUBE_TRAY_ANGLES,
    overhead: true,
  };
}

/** The emissive bars for a cylindrical piece — one inside each cove. */
function tubeStrips(radius: number, length: number): StripDef[] {
  return coveStrips(radius, TUBE_COVE_ANGLES, Math.max(0.4, length - 0.6));
}

/**
 * How far into a node's corner notch its service chase sits, as a multiple of
 * the node half-extent. Deep enough that the chase's back plate clears both
 * faces, shallow enough that it is a corner and not a pillar.
 */
export const NODE_CHASE_R = 1.345;
/** The four vertical corners of a node, as wall angles. */
export const NODE_CORNER_ANGLES: readonly number[] = [
  Math.PI / 4,
  (3 * Math.PI) / 4,
  (-3 * Math.PI) / 4,
  -Math.PI / 4,
];

/**
 * The four bars inside a node's corner chases.
 *
 * A node's chase is the tube cove stood on end: `geometry.ts` builds it in the
 * XY plane running along +Z, then rotates −90° about X so the run is vertical,
 * which maps a module-space point (x, y, z) to (x, z, −y). These bars go through
 * the same map, which is why they land inside the channel rather than beside it.
 */
function nodeChaseStrips(half: number, height: number): StripDef[] {
  return NODE_CORNER_ANGLES.map((angle) => {
    const p = wallFrameVec(
      NODE_CHASE_R * half,
      angle,
      coveSign(angle) * COVE_STRIP_U,
      COVE_STRIP_V,
      0,
    );
    return {
      pos: roundVec(v3(p.x, 0, -p.y)),
      size: v3(COVE_STRIP, height, COVE_STRIP),
    };
  });
}

// ---------------------------------------------------------------------------
// Piece 1 — straight, 5 m corridor (§2 "straight 5m")
// ---------------------------------------------------------------------------

const STRAIGHT_R = TUBE_RADIUS_M;
const STRAIGHT_L = 5.0;

const STRAIGHT: KitPiece = {
  id: 'straight',
  kind: 'straight',
  radius: STRAIGHT_R,
  length: STRAIGHT_L,
  volume: round2(Math.PI * STRAIGHT_R * STRAIGHT_R * STRAIGHT_L),
  railOffset: tubeRailX(STRAIGHT_R),
  ports: [
    { id: 'aft', localPos: v3(0, 0, -STRAIGHT_L / 2), localDir: v3(0, 0, -1) },
    { id: 'fwd', localPos: v3(0, 0, STRAIGHT_L / 2), localDir: v3(0, 0, 1) },
  ],
  rails: () => tubeRails(STRAIGHT_L / 2, STRAIGHT_R, 'aft', 'fwd', 1.6),
  strips: tubeStrips(STRAIGHT_R, STRAIGHT_L),
  interior: tubeInterior(STRAIGHT_L),
  deck: tubeDeck(STRAIGHT_R, STRAIGHT_L),
  defaultLighting: 'emergency',
  decor(moduleId, rng, gravity) {
    // In a `nominal` straight the +X wall forward of amidships is reserved for
    // the equipment bay (see `hideSpots` below), so the racks and the locker
    // share the −X wall. A hide spot that intersects a rack is not a hide spot,
    // it is a seam.
    const walls = gravity === 'zero' ? wallsFor(gravity) : [Math.PI];
    const out = [
      ...tubeRacks(moduleId, STRAIGHT_R, [-1.15, 1.15], walls),
      ...tubeCables(moduleId, STRAIGHT_R, [-1.65, 0, 1.65]),
      ...tubeStowage(moduleId, rng, STRAIGHT_R, 2, STRAIGHT_L / 2, walls),
      // Under gravity the scatter stops: the −X wall carries the racks, the
      // chicane's aft stub and this locker, and the +X wall carries the bay.
      // A randomly-placed locker is a blockage you only meet in the round whose
      // seed produced it, so the aft end is authored, not rolled.
      moduleLocker(
        moduleId,
        STRAIGHT_R,
        gravity === 'zero' ? randRange(rng, -1.6, 1.6) : -2.05,
        Math.PI,
      ),
    ];
    // §2: the straight is the piece you use most and the one that gets no
    // geometry for free, so its props ARE the chase design.
    if (gravity === 'nominal') out.push(...tubeChicane(moduleId, STRAIGHT_R, STRAIGHT_L));
    return out;
  },
  /**
   * A `nominal` straight NOW GETS A HIDE SPOT, and the reason is the same
   * arithmetic that used to refuse it.
   *
   * The old note read: "a standing body in a 1.0 m bore is confined to
   * |x| ≤ 0.28; a berth deep enough to climb into reaches 0.18 m from the axis,
   * which leaves 0.12 m of lane past it — a hiding place that plugs the corridor
   * it is hiding you in. Give a straight a hide spot and you have to give it a
   * side bay first: an alcove punched through the hull, widening the deck
   * locally. That is the right answer and it is a hull-geometry change, not an
   * authoring one."
   *
   * The hull geometry changed. At `TUBE_RADIUS_M` 1.5 the deck is 2.60 m and a
   * standing body may put its centre anywhere in |x| ≤ 1.09. A `BAY_HALF_EXTENTS`
   * bay against the +X wall reaches its inner face to x = 0.54, so a body passing
   * it has its centre free from 0.24 all the way across to −1.09 — 1.33 m of lane
   * where there used to be 0.12 m. It is the single clearest thing the wider bore
   * bought, and §4 wants six hide spots across the station.
   *
   * FORWARD OF AMIDSHIPS, clear of the chicane and opposite the locker rather
   * than beside it. A `zero` straight is a different room entirely — the whole
   * bore is usable, so a stowage net costs nothing.
   */
  hideSpots(moduleId, gravity) {
    if (gravity === 'zero') {
      return [stowageNet(`${moduleId}-net`, v3(0.5, 0.1, 1.5), v3(-1, 0, 0))];
    }
    return [deckBay(`${moduleId}-bay`, 1, 2.0, STRAIGHT_R)];
  },
};

// ---------------------------------------------------------------------------
// Piece 2 — 6-way node (§2 "6-way node")
// ---------------------------------------------------------------------------

/**
 * Node half-extent. `scaled(2.0)` = 3.0 m, a 6 m room.
 *
 * Was `scaled(1.5)` (a 4.5 m room), and the playtest read that as cramped: with
 * a 1.36 m console island in the middle, the lanes were 1.57 m and the island
 * filled a third of the view from any doorway. At 6 m the lanes round the
 * island are 2.3 m+, the island reads as furniture rather than a roadblock,
 * and a node finally feels like the junction room §2 describes instead of a
 * wide bit of corridor. Everything below — ports, rails, deck, strips, chases,
 * decor — derives from this one number; re-run `buildLevel.ts` after touching
 * it.
 */
export const NODE_H = scaled(2.0);

/**
 * How far off a node face's centre its rack bay sits, along the face.
 *
 * The doorway is 1.4 m across at its widest (`PORT_RADIUS` doubled), so a 1.3 m
 * rack centred here starts 0.90 m off the axis and is clear of the opening with
 * room to spare, while its far end stops 0.05 m short of the corner chase.
 */
const NODE_RACK_OFFSET = 1.55;

/**
 * Which flank of a node face is CLEAR — the side with no rack bay on it.
 *
 * The four rack bays are arranged as a pinwheel: +X and +Z faces carry theirs on
 * the −tangent flank, −X and −Z faces on the +tangent flank, so no two racks in
 * the room are opposite each other and each lane of the ring has exactly one
 * fitting in it. This function is the other half of that arrangement, and it is
 * exported because `stationSpec.ts` authors the puzzle panels: it is the
 * handshake that keeps a breaker plate from being welded to the front of a rack.
 */
export function nodeClearFlank(faceNormal: Vec3): 1 | -1 {
  return faceNormal.x + faceNormal.z > 0 ? 1 : -1;
}

/** How far along its face a node's wall panel sits, on the clear flank. */
export const NODE_PANEL_OFFSET = 1.05;

/**
 * Half-width of the void inside a node's console island (`nodeConsoleVoid`).
 *
 * The shell adds `HIDE_SHELL_T` a side, so the finished island is 1.36 m square
 * in a 4.5 m node — lanes of 1.57 m all the way round, against the 1.0 m the old
 * 3 m node could afford. `cornerFins` derives its inset from this, so the two
 * cannot drift apart.
 */
export const NODE_ISLAND_HALF = 0.6;

/**
 * Spokes meeting at an OVERHEAD hub. Entering one and holding the slide carries
 * you straight out of the opposite port, because `RailGraph.advance()` picks the
 * straightest continuation at a junction.
 *
 * The hub used to sit on the module axis, which put the −Y spoke through the
 * deck, through the console island and out of the floor — a handrail rising out
 * of the walkway, which is precisely the thing the playtest complained about.
 * Now every spoke lies in the station's one rail plane (`RAIL_Y_M`), meeting
 * above the middle of the room, and each side spoke ends directly above its
 * port so it lands on the mating tube's own junction point exactly.
 *
 * THE FLOOR SPOKE IS DROPPED IN A `nominal` NODE, and that is a statement about
 * the deck rather than about the rails: `nodeDeck` plates the module's whole
 * footprint, so a node with a floor has no floor port — anything mated there
 * would open under 4.5 m of deck plate. In `zero` there is no deck, the −Y port
 * is a real way out, and the spoke is authored. `buildLevel.ts` refuses a level
 * that links a port no rail declares, so this cannot rot into a silent gap in
 * the rail graph.
 */
function nodeRails(half: number, gravity: GravityMode): RailSegment[] {
  const hub = v3(0, RAIL_Y_M, 0);
  const spokes: Array<{ id: RailSegmentId; port: PortId; end: Vec3 }> = [
    { id: 'rs-px', port: 'px', end: v3(half, RAIL_Y_M, 0) },
    { id: 'rs-nx', port: 'nx', end: v3(-half, RAIL_Y_M, 0) },
    { id: 'rs-pz', port: 'pz', end: v3(0, RAIL_Y_M, half) },
    { id: 'rs-nz', port: 'nz', end: v3(0, RAIL_Y_M, -half) },
    // The ceiling port: its junction is the port itself, since "overhead" and
    // "the +Y face" are the same place.
    { id: 'rs-py', port: 'py', end: v3(0, half, 0) },
  ];
  if (gravity === 'zero') {
    spokes.push({ id: 'rs-ny', port: 'ny', end: v3(0, -half, 0) });
  }
  const ids = spokes.map((s) => s.id);
  return spokes.map((s) =>
    seg(
      s.id,
      s.end,
      hub,
      ids.filter((o) => o !== s.id),
      s.port,
    ),
  );
}

const NODE: KitPiece = {
  id: 'node',
  kind: 'node',
  radius: NODE_H,
  length: NODE_H * 2,
  volume: round2(NODE_H * 2 * (NODE_H * 2) * (NODE_H * 2)),
  railOffset: 0,
  ports: [
    { id: 'px', localPos: v3(NODE_H, 0, 0), localDir: v3(1, 0, 0) },
    { id: 'nx', localPos: v3(-NODE_H, 0, 0), localDir: v3(-1, 0, 0) },
    { id: 'py', localPos: v3(0, NODE_H, 0), localDir: v3(0, 1, 0) },
    { id: 'ny', localPos: v3(0, -NODE_H, 0), localDir: v3(0, -1, 0) },
    { id: 'pz', localPos: v3(0, 0, NODE_H), localDir: v3(0, 0, 1) },
    { id: 'nz', localPos: v3(0, 0, -NODE_H), localDir: v3(0, 0, -1) },
  ],
  // Overhead in both regimes, meeting above the middle of the room. See
  // `nodeRails` for why the floor spoke exists only where there is no floor.
  rails: (gravity) => nodeRails(NODE_H, gravity),
  // Four vertical bars, one in each corner chase. A node reads as four glowing
  // corners around a dark middle, which is what makes it a place rather than a
  // wide bit of corridor.
  strips: nodeChaseStrips(NODE_H, NODE_H * 2 - 0.4),
  interior: { posts: true },
  deck: nodeDeck(NODE_H),
  defaultLighting: 'emergency',
  decor(moduleId, rng, gravity) {
    const out: PropRef[] = [prop(`${moduleId}-hub`, 'hub', v3(0, RAIL_Y_M, 0))];
    // Racks flank the hatch on each of the four side faces, clear of the hole.
    const faces: Array<{ inward: Vec3; along: Vec3; base: Vec3 }> = [
      { inward: v3(-1, 0, 0), along: v3(0, 0, 1), base: v3(NODE_H, 0, 0) },
      { inward: v3(1, 0, 0), along: v3(0, 0, 1), base: v3(-NODE_H, 0, 0) },
      { inward: v3(0, 0, -1), along: v3(1, 0, 0), base: v3(0, 0, NODE_H) },
      { inward: v3(0, 0, 1), along: v3(1, 0, 0), base: v3(0, 0, -NODE_H) },
    ];
    const inset = RACK_DEPTH / 2;
    // THE RACKS FLANK THE HATCH SIDEWAYS NOW, which the old 3 m node could not
    // afford and a 4.5 m one can.
    //
    // They used to be stacked above and below the opening, and the height was a
    // running battle with it: the doorway reaches `DOORWAY_TOP` (0.86) and a rack
    // any lower was a rack bolted across a doorway — MEASURED stopping a standing
    // body at every node port on the shipped level — while a rack any higher was
    // buried in the ceiling. Sideways there is no battle to fight, and the room
    // gains a rhythm it did not have: ONE rack per face, always on the face's
    // −tangent flank, so every face reads as a rack bay on one side of the hatch
    // and clear wall on the other. `NODE_PANEL_OFFSET` is that clear side, and
    // the two never have to be checked against each other again.
    //
    // In `zero` a second rack goes overhead on the same flank — with no floor
    // there is no reason to leave the upper half of a wall bare.
    const heights = gravity === 'zero' ? [0, 1.35] : [0];
    for (let f = 0; f < faces.length; f++) {
      const face = faces[f] as { inward: Vec3; along: Vec3; base: Vec3 };
      // Opposite the clear flank, which makes the four bays a pinwheel.
      const t = -nodeClearFlank(v3(-face.inward.x, 0, -face.inward.z)) * NODE_RACK_OFFSET;
      for (const y of heights) {
        out.push(
          prop(
            `${moduleId}-rack-${f}${y > 0 ? 'u' : ''}`,
            'rack',
            v3(
              face.base.x + face.inward.x * inset + face.along.x * t,
              y,
              face.base.z + face.inward.z * inset + face.along.z * t,
            ),
            orientProp(face.inward, face.along),
          ),
        );
      }
    }
    // Cable trunks down the four vertical edges, tucked just inboard of the
    // corner chases (`NODE_CHASE_R`) rather than floating in the middle of the
    // room, which is where a radius drawn for a 1.5 m node left them.
    const cornerR = NODE_CHASE_R * NODE_H - 0.2;
    for (let c = 0; c < CORNER_ANGLES.length; c++) {
      const angle = CORNER_ANGLES[c] as number;
      out.push(
        prop(
          `${moduleId}-cable-${c}`,
          'cable',
          v3(Math.cos(angle) * cornerR, 0, Math.sin(angle) * cornerR),
          orientProp(v3(-Math.cos(angle), 0, -Math.sin(angle)), v3(0, 1, 0)),
        ),
      );
    }
    // On the rack face, a hand's width proud of it, at the height a laptop on an
    // articulated arm actually sits: 1.0 m over the deck.
    out.push(
      prop(
        `${moduleId}-laptop`,
        'laptop',
        v3(NODE_H - RACK_DEPTH - 0.1, 0.25, -NODE_RACK_OFFSET + 0.35),
        orientProp(v3(-1, 0, 0), v3(0, 0, 1)),
      ),
    );
    if (gravity === 'zero') {
      out.push(
        prop(
          `${moduleId}-locker`,
          'locker',
          v3(randRange(rng, -0.9, 0.9), -NODE_H + 0.17, randRange(rng, -0.9, 0.9)),
          orientProp(v3(0, 1, 0), v3(0, 0, 1)),
        ),
      );
    } else {
      // ON THE DECK NOW, and the width is what changed.
      //
      // The old note read: "a node with a deck has 1.0 m lanes around its console
      // island, a locker is 0.42 m deep and a walker is 0.70 m wide, so any wall
      // locker at body height converts the four-exit ring back into a U" — and
      // it was right, so the locker went overhead where nobody could reach it
      // comfortably. A 4.5 m node has 1.57 m lanes; a 0.34 m locker leaves 1.23 m,
      // which is a walk lane and a third. It goes where stowage goes: on the
      // deck, on the clear flank of the −X face, out of the doorway and out of
      // the rack bay opposite it.
      out.push(
        prop(
          `${moduleId}-locker`,
          'locker',
          v3(
            -NODE_H + PROP_ARCHETYPES.locker.size.y / 2,
            DECK_Y_M + PROP_ARCHETYPES.locker.size.x / 2,
            nodeClearFlank(v3(-1, 0, 0)) * 2.0,
          ),
          orientProp(v3(1, 0, 0), v3(0, 0, 1)),
        ),
      );
    }
    // §2, "nodes get this for free" — a node has four exits and an island to run
    // round, but its four OPEN CORNERS let a pursuer that guessed wrong cut the
    // diagonal and get most of its guess back. A fin across each corner closes
    // the shortcut and leaves the ring; `cornerFins` derives the inset so the gap
    // past the island is exactly one walk lane. The two back walls turn the
    // remaining pair of corners into a proper dead-ish pocket rather than a
    // rounded-off square.
    if (gravity === 'nominal') {
      out.push(
        ...cornerFins(
          moduleId,
          NODE_H,
          [
            [1, 1],
            [-1, -1],
          ],
          NODE_ISLAND_HALF,
        ),
        ...nodeBackWalls(moduleId, NODE_H, NODE_RACK_OFFSET),
      );
    }
    return out;
  },
  /**
   * The node's console island IS its hide spot, and that is the whole design.
   *
   * §2 calls a loop the highest-value piece of geometry in the kit, and a node
   * with an island in it is a genuine four-exit ring: the thing has to pick a
   * direction and it can pick wrong. Putting the hide volume UNDER the console
   * costs the ring nothing.
   *
   * OFF-CENTRE now, toward the (−X, +Z) quarter — the corner the fins do NOT
   * occupy. Dead centre it was the first thing every doorway framed and the
   * one obstacle every crossing had to route around, which the playtest read
   * as "a cabinet in the middle of the room". Pushed to a quarter it still
   * closes the diagonal on its own side of the ring (a loop survives an
   * asymmetric island), but the straight walk between any two opposite
   * doorways is now clear. The offset scales with the room so the clearances
   * hold if `NODE_H` moves again: at 3.0 m half-extent the island's outer face
   * keeps 0.75 m to the nearest rack and the doorway lanes keep a body width
   * plus margin, which `buildLevel.ts`'s walkable check proves on every run.
   *
   * `geometry.ts` builds the shell from this volume, so the console you see and
   * the box the alien has to route around are the same object.
   */
  hideSpots(moduleId, gravity) {
    if (gravity === 'zero') return [];
    const off = round2(NODE_H * 0.45);
    return [nodeConsoleVoid(`${moduleId}-console`, NODE_ISLAND_HALF, -off, off)];
  },
};

// ---------------------------------------------------------------------------
// Piece 3 — cupola (§2). One port, a dome of windows, and a grab-rail ring.
// ---------------------------------------------------------------------------

const CUPOLA_R = scaled(1.5);
/** Distance from the cupola's centre to its single port. */
const CUPOLA_PORT_Z = -scaled(1.2);
/**
 * Radius of the collar between the port and the dome.
 *
 * Widened from 0.9 for the pivot and again with the bore, and the number has
 * never been cosmetic: a deck at `DECK_Y_M` inside a 0.9 m collar left 1.65 m of
 * headroom and a 0.99 m lane — a vestibule you could not stand up in and could
 * barely walk down. It stays at 1.25× the straight's bore, so the cupola's
 * vestibule is always the widest short corridor in the station rather than the
 * narrowest.
 */
export const CUPOLA_COLLAR_R = scaled(1.25);
/** Length of the collar, from the port bulkhead to the dome's equator. */
export const CUPOLA_COLLAR_L = scaled(0.75);
const CUPOLA_DOME_Z = round2(CUPOLA_PORT_Z + CUPOLA_COLLAR_L);
const CUPOLA_RING_Z = -scaled(0.62);
/** How far the dome's two grab arms fan out either side of the spine. */
const CUPOLA_ARM_X = scaled(0.78);

const CUPOLA: KitPiece = {
  id: 'cupola',
  kind: 'cupola',
  radius: CUPOLA_R,
  length: round2(CUPOLA_R + CUPOLA_COLLAR_L + 0.45),
  volume: round2(
    (2 / 3) * Math.PI * CUPOLA_R ** 3 +
      Math.PI * CUPOLA_COLLAR_R * CUPOLA_COLLAR_R * CUPOLA_COLLAR_L,
  ),
  railOffset: CUPOLA_ARM_X,
  ports: [{ id: 'dock', localPos: v3(0, 0, CUPOLA_PORT_Z), localDir: v3(0, 0, -1) }],
  /**
   * A grab spine down the collar and two arms fanning into the dome.
   *
   * It used to be a RING around the module axis at `CUPOLA_RING_Z`, and half of
   * that ring was below the deck — a handrail buried in the floor of the one
   * room in the station whose whole job is that you stand in it and look. The
   * arms do what the ring did (a loop, two ways round, something to hold while
   * you hang at a window) at the station's one rail height, so the cupola joins
   * the same overhead plane as everything else and its rail still lands exactly
   * on the mating node's junction point.
   */
  rails: () => {
    const spineZ = CUPOLA_RING_Z;
    const armZ = round2(CUPOLA_DOME_Z + 0.55);
    const dock = railJunction(v3(0, 0, CUPOLA_PORT_Z));
    const knee = v3(0, RAIL_Y_M, spineZ);
    const armP = v3(CUPOLA_ARM_X, RAIL_Y_M, armZ);
    const armN = v3(-CUPOLA_ARM_X, RAIL_Y_M, armZ);
    return [
      seg('cs', dock, knee, ['cr0', 'cr1'], 'dock'),
      seg('cr0', knee, armP, ['cs', 'cr2']),
      seg('cr1', knee, armN, ['cs', 'cr3']),
      seg('cr2', armP, v3(0, RAIL_Y_M, armZ), ['cr0', 'cr3']),
      seg('cr3', v3(0, RAIL_Y_M, armZ), armN, ['cr2', 'cr1']),
    ];
  },
  // The light in the cupola lives in the VESTIBULE, not in the dome: §2 makes
  // this the one room you can see out of, `defaultLighting` is 'dark', and a
  // lamp inside a glass bubble is a lamp reflected in seven panes. Two coves in
  // the collar wash the way in and leave the dome to the torch and the windows.
  strips: coveStrips(
    CUPOLA_COLLAR_R,
    TUBE_COVE_ANGLES,
    round2(CUPOLA_COLLAR_L * 0.77),
    round2(CUPOLA_PORT_Z + CUPOLA_COLLAR_L / 2),
  ),
  interior: { coves: TUBE_COVE_ANGLES },
  deck: cupolaDeck(CUPOLA_COLLAR_R, CUPOLA_R, CUPOLA_PORT_Z, CUPOLA_DOME_Z),
  defaultLighting: 'dark',
  decor(moduleId, rng, gravity) {
    const out: PropRef[] = [
      prop(
        `${moduleId}-laptop`,
        'laptop',
        v3(0.55, -0.35, CUPOLA_RING_Z - 0.2),
        orientProp(v3(-0.6, 0.8, 0), v3(0, 0, 1)),
      ),
      prop(
        `${moduleId}-bag-0`,
        'stowage',
        v3(randRange(rng, -0.5, 0.5), -0.45, CUPOLA_PORT_Z + 0.45),
        orientProp(v3(0, 1, 0), v3(0, 0, 1)),
      ),
      // Under gravity: the −X wall of the collar, opposite the equipment bay.
      gravity === 'zero'
        ? moduleLocker(moduleId, CUPOLA_COLLAR_R, CUPOLA_PORT_Z + 0.45, Math.PI / 2)
        : moduleLocker(moduleId, CUPOLA_COLLAR_R, CUPOLA_DOME_Z - 0.2, Math.PI),
    ];
    return out;
  },
  /**
   * §2 is explicit that a dead-end bay is not escape geometry, it is a hiding
   * place, and that authoring one means authoring it as one, knowingly. This is
   * that: a dark dome at the end of a single corridor with the best cover on the
   * station and no second way out. Going in is a commitment.
   *
   * IT IS A NORMAL BAY NOW. The old note explained a deliberately narrow, deep
   * shape: "`bayHalfWidthBesidePort(CUPOLA_COLLAR_R)` is 0.21 m against the
   * 0.30 m a bay gets in the lab's wider bore. A 0.30 m bay here put its inner
   * face 0.24 m off the port axis — inside the doorway's own `DOORWAY_HALF_W`
   * slot — and a standing player could not get out of the cupola at any speed
   * or angle." At 1.25× a 1.5 m bore the collar allows 0.55 m of bay beside the
   * doorway, so the standard `BAY_HALF_EXTENTS` fits with 0.25 m to spare and
   * the kit has one bay shape instead of two.
   */
  hideSpots(moduleId, gravity) {
    if (gravity === 'zero') return [];
    return [deckBay(`${moduleId}-bay`, 1, round2(CUPOLA_PORT_Z + 0.85), CUPOLA_COLLAR_R)];
  },
};

// ---------------------------------------------------------------------------
// Piece 4 — airlock (§2). Two ports; the outer one opens on vacuum, so the
// level never links it and it always caps with an endcap.
// ---------------------------------------------------------------------------

const AIRLOCK_R = scaled(1.2);
const AIRLOCK_L = 4.0;

const AIRLOCK: KitPiece = {
  id: 'airlock',
  kind: 'airlock',
  radius: AIRLOCK_R,
  length: AIRLOCK_L,
  volume: round2(Math.PI * AIRLOCK_R * AIRLOCK_R * AIRLOCK_L),
  railOffset: tubeRailX(AIRLOCK_R),
  ports: [
    { id: 'inner', localPos: v3(0, 0, -AIRLOCK_L / 2), localDir: v3(0, 0, -1) },
    { id: 'outer', localPos: v3(0, 0, AIRLOCK_L / 2), localDir: v3(0, 0, 1) },
  ],
  rails: () => tubeRails(AIRLOCK_L / 2, AIRLOCK_R, 'inner', 'outer', 1.15),
  strips: tubeStrips(AIRLOCK_R, AIRLOCK_L),
  interior: tubeInterior(AIRLOCK_L),
  // The one port in the station that opens on vacuum, and the level never links
  // it (§2). `geometry.ts` caps it with an armoured plate; `hatches.ts` puts the
  // heavy door on it.
  outerPorts: ['outer'],
  deck: tubeDeck(AIRLOCK_R, AIRLOCK_L),
  defaultLighting: 'dark',
  decor(moduleId, rng, gravity) {
    const walls = wallsFor(gravity);
    const out: PropRef[] = [
      ...tubeRacks(moduleId, AIRLOCK_R, [0], walls),
      ...tubeCables(moduleId, AIRLOCK_R, [-1.2, 0.5]),
      moduleLocker(
        moduleId,
        AIRLOCK_R,
        randRange(rng, -1.2, 1.2),
        gravity === 'zero' ? -Math.PI / 2 : Math.PI,
      ),
    ];
    if (gravity === 'nominal') out.push(...tubeChicane(moduleId, AIRLOCK_R, AIRLOCK_L));
    // Two EVA suits on the walls. Scaled stowage, and 1.9× a 0.46 m bag is
    // 0.87 m across — a suit torso beside a 1.6 m crew member, which is what it
    // is meant to read as. (It was 1.6× a 0.52 m bag: a 0.83 m box, and against
    // the old 1.0 m bore it filled a third of the room.)
    for (let i = 0; i < 2; i++) {
      const angle = i === 0 ? Math.PI / 2 : Math.PI;
      out.push(
        prop(
          `${moduleId}-suit-${i}`,
          'stowage',
          onWall(AIRLOCK_R, angle, i === 0 ? 1.1 : -1.1, RACK_DEPTH + 0.3),
          orientProp(wallInward(angle), v3(0, 0, 1)),
          1.9,
        ),
      );
    }
    return out;
  },
  hideSpots(moduleId, gravity) {
    // The suit bay: a webbing pocket between the two EVA suits. Under gravity it
    // is a bag at head height with nothing to stand on, which is exactly what
    // §4 means by a `'zero'`-only spot.
    if (gravity === 'zero') {
      return [stowageNet(`${moduleId}-suit-bay`, v3(-0.55, 0.1, 0), v3(1, 0, 0))];
    }
    return [deckBay(`${moduleId}-bay`, -1, 0, AIRLOCK_R)];
  },
};

// ---------------------------------------------------------------------------
// Piece 5 — lab. Wider, denser, the same axial-port grammar as a straight.
// ---------------------------------------------------------------------------

const LAB_R = scaled(1.4);
const LAB_L = 5.0;

const LAB: KitPiece = {
  id: 'lab',
  kind: 'lab',
  radius: LAB_R,
  length: LAB_L,
  volume: round2(Math.PI * LAB_R * LAB_R * LAB_L),
  railOffset: tubeRailX(LAB_R),
  ports: [
    { id: 'aft', localPos: v3(0, 0, -LAB_L / 2), localDir: v3(0, 0, -1) },
    { id: 'fwd', localPos: v3(0, 0, LAB_L / 2), localDir: v3(0, 0, 1) },
  ],
  rails: () => tubeRails(LAB_L / 2, LAB_R, 'aft', 'fwd', 1.55),
  strips: tubeStrips(LAB_R, LAB_L),
  interior: tubeInterior(LAB_L),
  deck: tubeDeck(LAB_R, LAB_L),
  defaultLighting: 'emergency',
  decor(moduleId, rng, gravity) {
    // Same reservation as the straight: under gravity the −X wall belongs to the
    // bench island's port lane, so the racks, bags and the locker live on +X.
    const walls = gravity === 'zero' ? wallsFor(gravity) : [0];
    const out = [
      ...tubeRacks(moduleId, LAB_R, [-1.6, 0, 1.6], walls),
      ...tubeCables(moduleId, LAB_R, [-1.65, 0, 1.65]),
      ...tubeStowage(moduleId, rng, LAB_R, 3, LAB_L / 2, walls),
      prop(
        `${moduleId}-laptop`,
        'laptop',
        onWall(LAB_R, 0, -0.8, RACK_DEPTH + 0.05),
        orientProp(wallInward(0), v3(0, 0, 1)),
      ),
      // Aft end of the +X wall, past the island. Anything in the island's own
      // 2.6 m closes the lane it is standing in.
      moduleLocker(
        moduleId,
        LAB_R,
        gravity === 'zero' ? randRange(rng, -1.8, 1.8) : -2.0,
        gravity === 'zero' ? -Math.PI / 2 : 0,
      ),
    ];
    // The lab is §2's best answer: an island down the middle of a 3.92 m deck
    // leaves a lane either side, which is a LOOP — two ways past, four ways in,
    // and a blind pursuer that has to guess which side you took. The banks at
    // either end turn the entrances into corners and open the side bay the hide
    // spot lives in. At the old 2.36 m deck the island had to be one 1.3 m bench
    // and nothing else fitted beside it; now it is a full 2.6 m spine.
    if (gravity === 'nominal') out.push(...labIsland(moduleId, LAB_R, LAB_L));
    return out;
  },
  hideSpots(moduleId, gravity) {
    if (gravity === 'zero') {
      return [stowageNet(`${moduleId}-net`, v3(0, 0.55, 1.6), v3(0, -1, 0))];
    }
    // TWO spots, one at each end, on opposite walls. The old restraint —
    // "a module gets a loop or it gets a second locker" — was a 2.36 m deck
    // talking: a bay on the −X wall would have eaten one of the two lanes the
    // island exists to create. At 3.92 m a bay costs its lane 0.68 m and leaves
    // 1.24 m, so the lab can have the loop AND cover at both ends of it, which
    // is what makes running the loop a decision rather than a lap.
    return [
      deckBay(`${moduleId}-bay`, 1, 2.0, LAB_R),
      deckBay(`${moduleId}-bay-aft`, -1, -2.0, LAB_R),
    ];
  },
};

// ---------------------------------------------------------------------------

export const KIT: Record<KitPieceId, KitPiece> = {
  straight: STRAIGHT,
  node: NODE,
  cupola: CUPOLA,
  airlock: AIRLOCK,
  lab: LAB,
};

export function kitPiece(kind: ModuleKind): KitPiece {
  const piece = KIT[kind];
  if (!piece) throw new Error(`kit: unknown module kind '${kind}'`);
  return piece;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
