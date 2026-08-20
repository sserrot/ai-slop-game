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
 * • Every rail endpoint that reaches a port sits EXACTLY on the port's
 *   `localPos`, so two mated modules' rails meet with zero gap and
 *   `RailGraph.validate()` stays quiet. This is the §2 note about rail
 *   continuity being the easiest thing in the system to get wrong.
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
import { DECK_Y_M } from '@shared/constants';
import { v3 } from '@shared/graph/math';
import { orientProp, roundVec } from './transform';
import { randRange } from './random';
import {
  BANK_SIZE,
  bayHalfWidthBesidePort,
  BENCH_SIZE,
  BULKHEAD_SIZE,
  CARGO_BAG_SIZE,
  CARGO_RACK_SIZE,
  cupolaDeck,
  deckBank,
  deckBay,
  HIDE_SHELL_T,
  labIsland,
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

/** Radius of a hatch opening. Player capsule radius is 0.35 (§14), so 0.7 is a
 *  0.35m clearance all round — tight enough to feel like a hatch, wide enough
 *  that a 6 m/s push-off through one is a skill and not a coin flip. */
export const PORT_RADIUS = 0.7;
/** Handrail tube radius. Thin: it is a grab rail, not a pipe. */
export const RAIL_RADIUS = 0.04;
/** How far a rack face stands proud of the hull. */
export const RACK_DEPTH = 0.22;
/** Clearance between a handrail and the rack face behind it. */
export const RAIL_CLEARANCE = 0.08;

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
   * What changes with gravity is WHERE they run. In `zero` they are the floor
   * and ceiling pair the movement grammar was designed around; in `nominal`
   * the same six segments run along the two side walls at axis height, which is
   * hip height over the deck — reachable the instant the plant winds down, and
   * out of the walkway instead of lying across it at shin height.
   */
  rails(gravity: GravityMode): RailSegment[];
  strips: StripDef[];
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

export const PROP_ARCHETYPES = {
  /** Equipment rack — the interior detailing on all four walls. */
  rack: { size: v3(1.0, RACK_DEPTH, 1.5), instanced: true, interactable: false },
  /** Cable bundle running the length of a corner. */
  cable: { radius: 0.05, length: 1.6, instanced: true, interactable: false },
  /** White stowage bag strapped to a rack face. */
  stowage: { size: v3(0.52, 0.34, 0.4), instanced: true, interactable: false },
  /** Laptop on an articulated arm — a faint emissive screen in the dark. */
  laptop: { size: v3(0.36, 0.04, 0.26), instanced: true, interactable: false },
  /** Cargo rack slot marker for §11 puzzle 3. */
  slot: { size: v3(0.62, 0.1, 0.5), instanced: true, interactable: false },
  /** Hub ball where a node's six handrail spokes meet. */
  hub: { radius: 0.2, instanced: true, interactable: false },
  /** Interactable container: breaker card, fuses and decoys spawn in these (§5, §11). */
  locker: { size: v3(0.72, 0.42, 0.56), instanced: false, interactable: true },
  /** In-world puzzle panel — the UI agent attaches a CanvasTexture (§6). */
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
 * would be buried under the deck; one on the +Y wall would hang into a standing
 * player's head, because a straight has exactly `DECK_HEADROOM_M` (1.75 m) of
 * clearance against a 1.7 m collider and the ceiling of a gravity module is
 * therefore not authorable space. A `zero` tube keeps all four — with no floor
 * there is no up, and the racks on every wall are what make that legible.
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
 * Two long rails that both terminate on both ports. Six segments; the pair meets
 * at each port so the module's rail graph is a loop and a player can round the
 * tube without letting go.
 *
 * The pair is rotated a quarter turn about the module axis by `gravity`:
 *
 *   zero    — floor (−Y) and ceiling (+Y), the §4 movement grammar unchanged.
 *   nominal — port (−X) and starboard (+X) walls at axis height, which is
 *             `-DECK_Y_M` = 0.75 m over the deck. Hip height, standing in front
 *             of the racks exactly the way the real thing does, and reachable
 *             the moment the plant winds down.
 *
 * Same ids, same count, same `connects`, same port links either way: a module
 * whose gravity the director drops mid-round keeps the rail graph it was
 * authored with, and nothing downstream has a topology change to notice.
 */
function tubeRails(
  halfLength: number,
  offset: number,
  aftPort: PortId,
  fwdPort: PortId,
  straightHalf: number,
  gravity: GravityMode,
): RailSegment[] {
  const aft = v3(0, 0, -halfLength);
  const fwd = v3(0, 0, halfLength);
  // `f` is the rail on the −axis side, `c` the one on the +axis side.
  const at = (sign: number, z: number): Vec3 =>
    gravity === 'zero' ? v3(0, sign * offset, z) : v3(sign * offset, 0, z);
  return [
    seg('rf-a', aft, at(-1, -straightHalf), ['rf-m', 'rc-a'], aftPort),
    seg('rf-m', at(-1, -straightHalf), at(-1, straightHalf), ['rf-a', 'rf-b']),
    seg('rf-b', at(-1, straightHalf), fwd, ['rf-m', 'rc-b'], fwdPort),
    seg('rc-a', aft, at(1, -straightHalf), ['rc-m', 'rf-a'], aftPort),
    seg('rc-m', at(1, -straightHalf), at(1, straightHalf), ['rc-a', 'rc-b']),
    seg('rc-b', at(1, straightHalf), fwd, ['rc-m', 'rf-b'], fwdPort),
  ];
}

/** Two strips in the upper corners, running the length of the tube. */
function tubeStrips(radius: number, length: number): StripDef[] {
  const r = (radius - 0.06) * Math.SQRT1_2;
  const d = Math.max(0.4, length - 0.9);
  return [
    { pos: v3(r, r, 0), size: v3(0.05, 0.05, d) },
    { pos: v3(-r, r, 0), size: v3(0.05, 0.05, d) },
  ];
}

// ---------------------------------------------------------------------------
// Piece 1 — straight, 5 m corridor (§2 "straight 5m")
// ---------------------------------------------------------------------------

const STRAIGHT_R = 1.0;
const STRAIGHT_L = 5.0;

const STRAIGHT: KitPiece = {
  id: 'straight',
  kind: 'straight',
  radius: STRAIGHT_R,
  length: STRAIGHT_L,
  volume: round2(Math.PI * STRAIGHT_R * STRAIGHT_R * STRAIGHT_L),
  railOffset: STRAIGHT_R - RACK_DEPTH - RAIL_CLEARANCE,
  ports: [
    { id: 'aft', localPos: v3(0, 0, -STRAIGHT_L / 2), localDir: v3(0, 0, -1) },
    { id: 'fwd', localPos: v3(0, 0, STRAIGHT_L / 2), localDir: v3(0, 0, 1) },
  ],
  rails: (gravity) =>
    tubeRails(
      STRAIGHT_L / 2,
      STRAIGHT_R - RACK_DEPTH - RAIL_CLEARANCE,
      'aft',
      'fwd',
      1.6,
      gravity,
    ),
  strips: tubeStrips(STRAIGHT_R, STRAIGHT_L),
  deck: tubeDeck(STRAIGHT_R, STRAIGHT_L),
  defaultLighting: 'emergency',
  decor(moduleId, rng, gravity) {
    // In a `nominal` straight the +X wall is reserved for the crew bunk (see
    // `hideSpots` below), so the racks and the locker share the −X wall. A hide
    // spot that intersects a rack is not a hide spot, it is a seam.
    const walls = gravity === 'zero' ? wallsFor(gravity) : [Math.PI];
    const out = [
      ...tubeRacks(moduleId, STRAIGHT_R, [-1.15, 1.15], walls),
      ...tubeCables(moduleId, STRAIGHT_R, [-1.65, 0, 1.65]),
      ...tubeStowage(moduleId, rng, STRAIGHT_R, 2, STRAIGHT_L / 2, walls),
      // Under gravity the scatter band tightens to clear the chicane: a locker
      // that lands inside a bulkhead is a seam, and a random one is a seam you
      // only find in the round where the seed produced it.
      // Under gravity the scatter stops: the −X wall carries the racks, the
      // chicane's aft bulkhead and this locker, and the +X wall carries a crew
      // bunk 1.8 m long. There is exactly one slice of this corridor a locker
      // can occupy without closing it (see `deckKit`'s cross-section budget),
      // and a random one is a blockage you only meet in the round whose seed
      // produced it.
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
   * A `nominal` straight gets NO hide spot, and the reason is arithmetic rather
   * than taste. A standing body in a 1.0 m bore is confined to |x| ≤ 0.28 (see
   * `deckKit`'s cross-section budget); a berth deep enough to climb into reaches
   * 0.18 m from the axis, which leaves 0.12 m of lane past it — a hiding place
   * that plugs the corridor it is hiding you in.
   *
   * Give a straight a hide spot and you have to give it a side bay first: an
   * alcove punched through the hull, widening the deck locally. That is the
   * right answer and it is a hull-geometry change, not an authoring one.
   *
   * A `zero` straight is a different room entirely — the whole bore is usable,
   * so a stowage net costs nothing.
   */
  hideSpots(moduleId, gravity) {
    if (gravity === 'zero') {
      return [stowageNet(`${moduleId}-net`, v3(0.5, 0.1, 1.5), v3(-1, 0, 0))];
    }
    return [];
  },
};

// ---------------------------------------------------------------------------
// Piece 2 — 6-way node (§2 "6-way node")
// ---------------------------------------------------------------------------

const NODE_H = 1.5;

/** Six spokes meeting at the centre. Entering one and holding the slide carries
 *  you straight out of the opposite port, because `RailGraph.advance()` picks
 *  the straightest continuation at a junction. */
function nodeRails(): RailSegment[] {
  const ids: RailSegmentId[] = ['rs-px', 'rs-nx', 'rs-py', 'rs-ny', 'rs-pz', 'rs-nz'];
  const ends: Vec3[] = [
    v3(NODE_H, 0, 0),
    v3(-NODE_H, 0, 0),
    v3(0, NODE_H, 0),
    v3(0, -NODE_H, 0),
    v3(0, 0, NODE_H),
    v3(0, 0, -NODE_H),
  ];
  const ports: PortId[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  return ids.map((id, i) =>
    seg(
      id,
      ends[i] as Vec3,
      v3(0, 0, 0),
      ids.filter((o) => o !== id),
      ports[i] as PortId,
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
  // A node's six spokes meet at the centre in BOTH regimes: they sit at axis
  // height, which is 0.75 m over the deck, so under gravity they read as the
  // grab rails they are rather than as anything underfoot.
  rails: () => nodeRails(),
  strips: [
    { pos: v3(1.34, 0, 1.34), size: v3(0.05, 2.3, 0.05) },
    { pos: v3(-1.34, 0, 1.34), size: v3(0.05, 2.3, 0.05) },
    { pos: v3(1.34, 0, -1.34), size: v3(0.05, 2.3, 0.05) },
    { pos: v3(-1.34, 0, -1.34), size: v3(0.05, 2.3, 0.05) },
  ],
  deck: nodeDeck(NODE_H),
  defaultLighting: 'emergency',
  decor(moduleId, rng, gravity) {
    const out: PropRef[] = [prop(`${moduleId}-hub`, 'hub', v3(0, 0, 0))];
    // Racks flank the hatch on each of the four side faces, clear of the hole.
    const faces: Array<{ inward: Vec3; along: Vec3; base: Vec3 }> = [
      { inward: v3(-1, 0, 0), along: v3(0, 0, 1), base: v3(NODE_H, 0, 0) },
      { inward: v3(1, 0, 0), along: v3(0, 0, 1), base: v3(-NODE_H, 0, 0) },
      { inward: v3(0, 0, -1), along: v3(1, 0, 0), base: v3(0, 0, NODE_H) },
      { inward: v3(0, 0, 1), along: v3(1, 0, 0), base: v3(0, 0, -NODE_H) },
    ];
    const scale = 0.6;
    const inset = (RACK_DEPTH * scale) / 2;
    // The racks flank the hatch VERTICALLY, so their heights are not free to
    // move: anything nearer the middle of a face is a rack bolted across a
    // doorway. Under gravity the lower one is simply dropped, because it would
    // be under the deck.
    //
    // r3: ±1.15 cleared the 0.7 m circular opening this kit was drawn around.
    // The pivot's standing body does not fit through that circle at all, so the
    // opening is a doorway now (`geometry.ts`) reaching `DECK_Y_M +
    // PLAYER_STAND_HEIGHT_M` = 0.96 above the axis — and a rack at 1.15 hangs
    // its lower 0.11 m straight into the top of it, which is exactly the "rack
    // bolted across a doorway" this comment was written to prevent. MEASURED:
    // it stopped a standing body at every node port on the shipped level.
    // 1.30 puts the rack's underside at 1.00, clear of the crown, and its top
    // 0.1 m into the ceiling, where it reads as recessed rather than floating.
    const heights = gravity === 'zero' ? [-1.3, 1.3] : [1.3];
    for (let f = 0; f < faces.length; f++) {
      const face = faces[f] as { inward: Vec3; along: Vec3; base: Vec3 };
      for (const y of heights) {
        out.push(
          prop(
            `${moduleId}-rack-${f}${y > 0 ? 'u' : 'd'}`,
            'rack',
            v3(
              face.base.x + face.inward.x * inset,
              y,
              face.base.z + face.inward.z * inset,
            ),
            orientProp(face.inward, face.along),
            scale,
          ),
        );
      }
    }
    // Cable trunks down the four vertical edges.
    for (let c = 0; c < CORNER_ANGLES.length; c++) {
      const angle = CORNER_ANGLES[c] as number;
      out.push(
        prop(
          `${moduleId}-cable-${c}`,
          'cable',
          v3(Math.cos(angle) * 1.28, 0, Math.sin(angle) * 1.28),
          orientProp(v3(-Math.cos(angle), 0, -Math.sin(angle)), v3(0, 1, 0)),
        ),
      );
    }
    out.push(
      prop(
        `${moduleId}-laptop`,
        'laptop',
        v3(NODE_H - 0.32, -0.55, 0.85),
        orientProp(v3(-1, 0, 0), v3(0, 0, 1)),
      ),
    );
    if (gravity === 'zero') {
      out.push(
        prop(
          `${moduleId}-locker`,
          'locker',
          v3(randRange(rng, -0.9, 0.9), -NODE_H + 0.21, randRange(rng, -0.9, 0.9)),
          orientProp(v3(0, 1, 0), v3(0, 0, 1)),
        ),
      );
    } else {
      // OVERHEAD stowage, and the height is forced rather than chosen.
      //
      // A node with a deck has 1.0 m lanes around its console island, a locker
      // is 0.42 m deep and a walker is 0.70 m wide: 1.5 − 0.42 − 0.35 leaves the
      // player's centre no room at all to pass one on the console side. Any wall
      // locker at body height therefore converts the four-exit ring back into a
      // U, silently, which is exactly the mistake §2 says will feel reasonable
      // at the time. Above the walking envelope (the collider tops out at
      // y = 0.95) it costs the ring nothing, still raycasts from a standing
      // crew member, and is what a real node looks like anyway. Offset along the
      // face so it clears both the hatch and the upper rack.
      out.push(
        prop(
          `${moduleId}-locker`,
          'locker',
          v3(-NODE_H + 0.21, 1.35, rng() < 0.5 ? -1.05 : 1.05),
          orientProp(v3(1, 0, 0), v3(0, 0, 1)),
        ),
      );
    }
    return out;
  },
  /**
   * The node's console island IS its hide spot, and that is the whole design.
   *
   * §2 calls a loop the highest-value piece of geometry in the kit, and a 3 m
   * node with a 1 m island is a genuine four-exit ring: the thing has to pick a
   * direction and it can pick wrong. But a 3 m node with a 1 m island has 1.0 m
   * lanes, and ANY 0.6 m box parked in one of them blocks it — a corner locker
   * would have quietly converted the ring back into a corridor. Putting the
   * void UNDER the console instead costs the ring nothing and puts the hide spot
   * at the centre of the loop, which is the most useful metre in the room during
   * the chase §4 built hiding for.
   *
   * `geometry.ts` builds the shell from this volume, so the console you see and
   * the box the alien has to route around are the same object.
   */
  hideSpots(moduleId, gravity) {
    if (gravity === 'zero') return [];
    return [nodeConsoleVoid(`${moduleId}-console`)];
  },
};

// ---------------------------------------------------------------------------
// Piece 3 — cupola (§2). One port, a dome of windows, and a grab-rail ring.
// ---------------------------------------------------------------------------

const CUPOLA_R = 1.5;
/** Distance from the cupola's centre to its single port. */
const CUPOLA_PORT_Z = -1.2;
/**
 * Radius of the collar between the port and the dome.
 *
 * Widened from 0.9 for the pivot, and the number is not cosmetic. A deck at
 * `DECK_Y_M` inside a 0.9 m collar leaves 1.65 m of headroom against a 1.7 m
 * standing collider and a 0.99 m lane — a vestibule you could not stand up in
 * and could barely walk down. 1.25 m gives 2.0 m of headroom and a 2.0 m lane,
 * which is the same handshake §2 makes about the straight's deck: change the
 * inset and you have changed §14's collider constants.
 */
export const CUPOLA_COLLAR_R = 1.25;
const CUPOLA_DOME_Z = CUPOLA_PORT_Z + 0.75;
const CUPOLA_RING_Z = -0.62;
const CUPOLA_RING_R = 0.78;
/**
 * Half-depth of the equipment bay, along the collar. See `hideSpots` below: the
 * bay is as wide as the doorway leaves it and as deep as it needs to be to keep
 * `BAY_HALF_EXTENTS`' volume, and 0.45 m is where those two meet.
 */
const CUPOLA_BAY_HZ = 0.45;

const CUPOLA: KitPiece = {
  id: 'cupola',
  kind: 'cupola',
  radius: CUPOLA_R,
  length: 2.7,
  volume: round2(
    (2 / 3) * Math.PI * CUPOLA_R ** 3 + Math.PI * CUPOLA_COLLAR_R * CUPOLA_COLLAR_R * 0.75,
  ),
  railOffset: CUPOLA_RING_R,
  ports: [{ id: 'dock', localPos: v3(0, 0, CUPOLA_PORT_Z), localDir: v3(0, 0, -1) }],
  rails: () => [
    seg('cs', v3(0, 0, CUPOLA_PORT_Z), v3(0, -CUPOLA_RING_R, CUPOLA_RING_Z), ['cr0', 'cr3'], 'dock'),
    seg(
      'cr0',
      v3(0, -CUPOLA_RING_R, CUPOLA_RING_Z),
      v3(CUPOLA_RING_R, 0, CUPOLA_RING_Z),
      ['cs', 'cr1'],
    ),
    seg(
      'cr1',
      v3(CUPOLA_RING_R, 0, CUPOLA_RING_Z),
      v3(0, CUPOLA_RING_R, CUPOLA_RING_Z),
      ['cr0', 'cr2'],
    ),
    seg(
      'cr2',
      v3(0, CUPOLA_RING_R, CUPOLA_RING_Z),
      v3(-CUPOLA_RING_R, 0, CUPOLA_RING_Z),
      ['cr1', 'cr3'],
    ),
    seg(
      'cr3',
      v3(-CUPOLA_RING_R, 0, CUPOLA_RING_Z),
      v3(0, -CUPOLA_RING_R, CUPOLA_RING_Z),
      ['cr2', 'cs'],
    ),
  ],
  strips: [
    { pos: v3(0.62, 0.62, CUPOLA_RING_Z - 0.06), size: v3(0.05, 0.05, 0.05) },
    { pos: v3(-0.62, 0.62, CUPOLA_RING_Z - 0.06), size: v3(0.05, 0.05, 0.05) },
    { pos: v3(0.62, -0.62, CUPOLA_RING_Z - 0.06), size: v3(0.05, 0.05, 0.05) },
    { pos: v3(-0.62, -0.62, CUPOLA_RING_Z - 0.06), size: v3(0.05, 0.05, 0.05) },
  ],
  deck: cupolaDeck(CUPOLA_COLLAR_R, CUPOLA_R, CUPOLA_PORT_Z, CUPOLA_DOME_Z),
  defaultLighting: 'dark',
  decor(moduleId, rng, gravity) {
    const out: PropRef[] = [
      prop(
        `${moduleId}-laptop`,
        'laptop',
        v3(0.55, -0.7, CUPOLA_RING_Z - 0.2),
        orientProp(v3(-0.6, 0.8, 0), v3(0, 0, 1)),
      ),
      prop(
        `${moduleId}-bag-0`,
        'stowage',
        v3(randRange(rng, -0.5, 0.5), -0.6, CUPOLA_PORT_Z + 0.45),
        orientProp(v3(0, 1, 0), v3(0, 0, 1)),
      ),
      // Under gravity: the −X wall of the DOME, where the room is widest. The
      // ceiling is 1.6 m over the deck (a jump in the dark) and the collar is
      // spoken for by the equipment bay.
      gravity === 'zero'
        ? moduleLocker(moduleId, CUPOLA_COLLAR_R, CUPOLA_PORT_Z + 0.45, Math.PI / 2)
        : moduleLocker(moduleId, CUPOLA_COLLAR_R, 0.2, Math.PI),
    ];
    return out;
  },
  /**
   * §2 is explicit that a dead-end bay is not escape geometry, it is a hiding
   * place, and that authoring one means authoring it as one, knowingly. This is
   * that: a dark dome at the end of a single corridor with the best cover on the
   * station and no second way out. Going in is a commitment.
   *
   * NARROW AND DEEP, and that shape is forced. The bay stands in the collar,
   * which is also the only way in or out of the module, and the way in is a
   * doorway cut down to the deck: `bayHalfWidthBesidePort(CUPOLA_COLLAR_R)` is
   * 0.21 m, against the 0.30 m a bay gets in the lab's wider bore. A 0.30 m bay
   * here put its inner face 0.24 m off the port axis — inside the doorway's own
   * `DOORWAY_HALF_W` slot — and a standing player could not get out of the
   * cupola at any speed or angle. So it gives up 0.18 m of width and takes 0.26
   * m of depth back along the collar, which the 0.75 m plank and the dome pad
   * behind it both have, and the volume comes out where it started: 0.42 m³.
   *
   * The depth is what puts the far wall at z = −0.14, so the shell runs from
   * the port bulkhead to just inside the dome and the bay reads as built into
   * the corridor rather than parked in it.
   */
  hideSpots(moduleId, gravity) {
    if (gravity === 'zero') return [];
    return [
      deckBay(
        `${moduleId}-bay`,
        1,
        CUPOLA_PORT_Z + CUPOLA_BAY_HZ + HIDE_SHELL_T,
        CUPOLA_COLLAR_R,
        v3(bayHalfWidthBesidePort(CUPOLA_COLLAR_R), 0.55, CUPOLA_BAY_HZ),
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Piece 4 — airlock (§2). Two ports; the outer one opens on vacuum, so the
// level never links it and it always caps with an endcap.
// ---------------------------------------------------------------------------

const AIRLOCK_R = 1.2;
const AIRLOCK_L = 4.0;

const AIRLOCK: KitPiece = {
  id: 'airlock',
  kind: 'airlock',
  radius: AIRLOCK_R,
  length: AIRLOCK_L,
  volume: round2(Math.PI * AIRLOCK_R * AIRLOCK_R * AIRLOCK_L),
  railOffset: AIRLOCK_R - RACK_DEPTH - RAIL_CLEARANCE,
  ports: [
    { id: 'inner', localPos: v3(0, 0, -AIRLOCK_L / 2), localDir: v3(0, 0, -1) },
    { id: 'outer', localPos: v3(0, 0, AIRLOCK_L / 2), localDir: v3(0, 0, 1) },
  ],
  rails: (gravity) =>
    tubeRails(
      AIRLOCK_L / 2,
      AIRLOCK_R - RACK_DEPTH - RAIL_CLEARANCE,
      'inner',
      'outer',
      1.15,
      gravity,
    ),
  strips: tubeStrips(AIRLOCK_R, AIRLOCK_L),
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
    // Two EVA suits on the walls, oversized stowage.
    for (let i = 0; i < 2; i++) {
      const angle = i === 0 ? Math.PI / 2 : Math.PI;
      out.push(
        prop(
          `${moduleId}-suit-${i}`,
          'stowage',
          onWall(AIRLOCK_R, angle, i === 0 ? 1.1 : -1.1, RACK_DEPTH + 0.28),
          orientProp(wallInward(angle), v3(0, 0, 1)),
          1.6,
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

const LAB_R = 1.4;
const LAB_L = 5.0;

const LAB: KitPiece = {
  id: 'lab',
  kind: 'lab',
  radius: LAB_R,
  length: LAB_L,
  volume: round2(Math.PI * LAB_R * LAB_R * LAB_L),
  railOffset: LAB_R - RACK_DEPTH - RAIL_CLEARANCE,
  ports: [
    { id: 'aft', localPos: v3(0, 0, -LAB_L / 2), localDir: v3(0, 0, -1) },
    { id: 'fwd', localPos: v3(0, 0, LAB_L / 2), localDir: v3(0, 0, 1) },
  ],
  rails: (gravity) =>
    tubeRails(LAB_L / 2, LAB_R - RACK_DEPTH - RAIL_CLEARANCE, 'aft', 'fwd', 1.55, gravity),
  strips: tubeStrips(LAB_R, LAB_L),
  deck: tubeDeck(LAB_R, LAB_L),
  defaultLighting: 'emergency',
  decor(moduleId, rng, gravity) {
    // Same reservation as the straight: under gravity the −X wall belongs to the
    // crew bunk, so the racks, bags and the locker live on +X.
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
    // The lab is the only cylindrical piece wide enough for §2's best answer: a
    // 0.5 m bench island down the middle of a 2.36 m deck leaves a 0.93 m lane
    // on each side, which is a LOOP — two ways past, four ways in, and a blind
    // pursuer that has to guess which side you took. The banks at either end
    // turn the entrances into corners and open the side bays the hide spots use.
    if (gravity === 'nominal') out.push(...labIsland(moduleId, LAB_R, LAB_L));
    return out;
  },
  hideSpots(moduleId, gravity) {
    if (gravity === 'zero') {
      return [stowageNet(`${moduleId}-net`, v3(0, 0.55, 1.6), v3(0, -1, 0))];
    }
    // ONE spot, forward on +X, and the restraint is deliberate. A crew bunk
    // amidships would sit on the −X wall for its whole 1.8 m, and the −X wall is
    // one of the two lanes the bench island exists to create: the lab's hide
    // spot would have eaten the lab's LOOP, which is the most valuable piece of
    // geometry in the kit (§2). A module gets a loop or it gets a second locker.
    return [deckBay(`${moduleId}-bay`, 1, 2.0, LAB_R)];
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
