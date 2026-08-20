/**
 * Gravity-era set pieces and escape geometry (DESIGN.md §2 "Gravity modules need
 * geometry — corners, not tubes", §4 "Gravity failure — a set-piece, never a
 * surprise"; asset bible ISS-GRV-02, -04, -08).
 *
 * Three things live here, and they are here together because they are all
 * answers to the same sentence in §2 — "a bare 5-metre tube with a floor is the
 * same countdown as a bare 5-metre tube without one":
 *
 *   1. THE GRAVITY PLANT (ISS-GRV-08). The machine that fails. §4 promises 2.5 s
 *      of warning before a floor lets go and calls that warning the fairness
 *      guarantee; the audio half of it (a plant winding down) already exists, and
 *      this is the half you can look at. The rotor's speed is driven directly off
 *      `pendingGravity(...).ms`, so what you see is not an animation that happens
 *      to look like the timer — it IS the timer, sampled.
 *
 *   2. CORNERS AND PARTIAL DIVIDERS (ISS-GRV-02, -03). Placement helpers that
 *      emit `bulkhead` props, because the alien is blind: a divider does not hide
 *      you, it breaks the thing's COMMITTED PATH, and it can only do that if it
 *      is in the collision BVH. `bulkhead` is in the BVH and instanced, so a
 *      station full of these costs one draw call and no new archetype.
 *
 *   3. SIDE BAYS (ISS-GRV-04), and an honest arithmetic report about where one
 *      can exist. §2: "corners, bays and loops have to widen the deck locally to
 *      exist at all." In a fixed circular bore they cannot, so `sideBayFit()`
 *      measures the bore and says so rather than letting an author draw a recess
 *      that plugs the corridor it is hiding them in.
 *
 * WHAT THIS FILE MAY AND MAY NOT IMPORT. It imports three.js, so `kit.ts` — the
 * pure half of the kit — must never import it. `buildLevel.ts` may (it already
 * pulls in `walkable.ts`, which imports three and three-mesh-bvh), which is what
 * keeps the authoring helpers below usable from the level generator.
 *
 * DRAW CALLS. The plant family is five `InstancedMesh`es for the whole station —
 * housing, rotor, hazard trim, and one lamp mesh per lit state — regardless of
 * how many plants are placed, and every one of them drops to zero instances (and
 * therefore zero GPU work) when no plant is in the visible set.
 */

import * as THREE from 'three';
import {
  DECK_Y_M,
  GRAVITY_WARNING_S,
  PLAYER_RADIUS,
  PLAYER_STAND_HEIGHT_M,
  clamp,
} from '@shared/constants';
import type {
  GravityCause,
  GravityMode,
  HideSpot,
  ModuleId,
  PropRef,
  StationLayout,
  Vec3,
} from '@shared/types';
import { v3 } from '@shared/graph/math';
import {
  accentGeometry,
  box,
  boltRing,
  chamferedBox,
  hazardStripeBand,
  labelPlate,
  louvreSlats,
  mergeParts,
  ribbedCylinder,
  withVertexColor,
  assertPolyBudget,
  triangleCount,
} from './artKit';
import {
  BANK_SIZE,
  HIDE_ENTRY_CLEARANCE_M,
  HIDE_SHELL_T,
  WALK_LANE_M,
  WALL_FITTING_DEPTH_M,
  bayEntryOffset,
  cornerFinGap,
  cornerFins,
  deckHalfWidth,
  divider,
  laneBeside,
  nodeBackWalls,
  standHalfWidth,
} from './deckKit';
import type { DividerOptions } from './deckKit';
import { KIT, NODE_H, NODE_ISLAND_HALF, PORT_RADIUS } from './kit';
import { HAZARD_YELLOW } from './materials';
import type { StationMaterials } from './materials';
import { quatFromAxisAngle, roundQuat, roundVec } from './transform';
import { moduleMatrix } from './threeUtil';

// ===========================================================================
// PART 1 — escape geometry, as level data
// ===========================================================================

/**
 * THE PURE AUTHORING HELPERS MOVED TO `deckKit.ts`.
 *
 * `divider`, `cornerFins`, `cornerFinGap`, `laneBeside` and `standHalfWidth`
 * are chase geometry, and chase geometry now has to be reachable from `kit.ts`
 * — every node in the station gets corner fins as part of the KIT rather than
 * as a level-file decoration, which is what §2 means by "the props in a straight
 * piece are doing structural design work". This file imports three.js, so
 * `kit.ts` may never import it; `deckKit.ts` is the pure half and is where they
 * belong. They are re-exported here so a level script that reaches for the
 * gravity-era set-piece helpers finds all of them in one place.
 */
export { cornerFinGap, cornerFins, divider, laneBeside, nodeBackWalls, standHalfWidth };
export type { DividerOptions };

/** Deck furniture convention: x across the lane, y height, z along the run. */
function deckProp(id: string, kind: string, size: Vec3, x: number, z: number, yaw = 0): PropRef {
  const p: PropRef = { id, kind, localPos: roundVec(v3(x, DECK_Y_M + size.y / 2, z)) };
  if (Math.abs(yaw) > 1e-9) p.localQuat = roundQuat(quatFromAxisAngle(v3(0, 1, 0), yaw));
  return p;
}

export interface SideBayFit {
  /** Depth of the recess including its shell, from the deck lip inwards. */
  depth: number;
  /** Module-space x of the recess's inner face. */
  innerFace: number;
  /** Half-width a STANDING body's centre may occupy in this bore. */
  standHalf: number;
  /** Metres of lateral freedom a standing body has left getting past it. */
  freedom: number;
  /** A body can stand INSIDE the recess rather than crouch. */
  standable: boolean;
  /** A standing body can still get past it at all. */
  passable: boolean;
  /** Why, in one sentence, for the author who is about to ignore this. */
  note: string;
}

/**
 * ISS-GRV-04 — "a 1.2 m recess off the main run" — measured against a real bore
 * rather than assumed.
 *
 * THE ANSWER IS ALMOST ALWAYS NO, AND THAT IS THE USEFUL PART. A recess a body
 * can stand in has to be `PLAYER_RADIUS × 2` deep plus a shell, so 0.86 m; the
 * lane beside it needs another 0.70 m; a straight's deck is 1.32 m wide and a
 * lab's is 2.36 m. The bible's 1.2 m recess is a corridor-and-a-half of deck
 * that no cylinder in this kit has, which is exactly what `kit.ts` says when it
 * refuses to give a `nominal` straight a hide spot: "that is the right answer and
 * it is a hull-geometry change, not an authoring one."
 *
 * So this function exists to be believed rather than argued with, and the two
 * shapes that DO work are elsewhere: `crewBunk` (deckKit) puts the recess at a
 * capped dead end, where the lane it blocks leads nowhere, and `flankedAlcove`
 * below makes a shallow one out of two banks with a gap, which is what a rack
 * bay in a real module is.
 */
export function sideBayFit(boreRadius: number, halfDepth = PLAYER_RADIUS + 0.08): SideBayFit {
  const deckHalf = deckHalfWidth(boreRadius);
  const depth = halfDepth * 2 + HIDE_SHELL_T;
  const innerFace = deckHalf - depth;
  const standHalf = standHalfWidth(boreRadius);
  // The body's centre has to be at least a radius inboard of the recess's face
  // and no further out than the bore lets a standing body go, on the other side.
  const freedom = innerFace - PLAYER_RADIUS + standHalf;
  const standable = halfDepth >= PLAYER_RADIUS;
  // 0.08 m is `walkable.ts`' sample pitch: a corridor narrower than one cell is
  // one the validator may not find a standable sample in even if it exists.
  const passable = freedom >= 0.08;
  return {
    depth,
    innerFace,
    standHalf,
    freedom,
    standable,
    passable,
    note: passable
      ? `${depth.toFixed(2)} m recess in a ${(deckHalf * 2).toFixed(2)} m deck leaves a standing ` +
        `body ${freedom.toFixed(2)} m of lateral freedom past it`
      : `${depth.toFixed(2)} m recess in a ${(deckHalf * 2).toFixed(2)} m deck leaves ` +
        `${freedom.toFixed(2)} m of freedom for a standing body — it plugs the run it hides ` +
        `you in, because a ${(boreRadius * 2).toFixed(2)} m bore is only ` +
        `${(standHalf * 2).toFixed(2)} m wide at shoulder height`,
  };
}

export interface AlcoveOptions {
  /** Half-width of the deck the alcove is cut into. */
  deckHalf: number;
  /** Which side of the run. */
  side: 1 | -1;
  /** Centre of the mouth, along the run. */
  z: number;
  /** Clear width of the mouth between the two banks. */
  mouth?: number;
  /** Keep the banks this far off the wall, for whatever is bolted to it. */
  standoff?: number;
}

/**
 * The alcove a fixed bore CAN have: two equipment banks with a gap between them.
 *
 * Depth is `BANK_SIZE.z` — half a metre of being out of the corridor rather than
 * the bible's 1.2 m — and that is not a compromise so much as what a rack bay
 * actually is on the real station. Against a blind pursuer it does the ISS-GRV-04
 * job: standing in it you are not on the line the thing has committed to, and it
 * still has to choose whether to sweep the bay or run the corridor.
 */
export function flankedAlcove(moduleId: ModuleId, suffix: string, o: AlcoveOptions): PropRef[] {
  const mouth = o.mouth ?? WALK_LANE_M;
  const standoff = o.standoff ?? 0;
  const x = o.side * (o.deckHalf - standoff - BANK_SIZE.x / 2);
  const dz = mouth / 2 + BANK_SIZE.z / 2;
  return [
    deckProp(`${moduleId}-bank-${suffix}1`, 'bank', BANK_SIZE, x, o.z - dz),
    deckProp(`${moduleId}-bank-${suffix}2`, 'bank', BANK_SIZE, x, o.z + dz),
  ];
}

/** A single bank, standing off the wall by whatever is bolted to it. */
export function cornerBank(
  moduleId: ModuleId,
  suffix: string,
  o: { deckHalf: number; side: 1 | -1; z: number; standoff?: number },
): PropRef {
  const standoff = o.standoff ?? 0;
  return deckProp(
    `${moduleId}-bank-${suffix}`,
    'bank',
    BANK_SIZE,
    o.side * (o.deckHalf - standoff - BANK_SIZE.x / 2),
    o.z,
  );
}

/**
 * A crouch-in equipment bay authored as a hide spot, for a deck wide enough to
 * afford one. Returns `null` — loudly, with the arithmetic — when it is not.
 */
export function equipmentBay(
  id: string,
  o: { boreRadius: number; side: 1 | -1; z: number; halfExtents?: Vec3 },
): HideSpot | null {
  const halfExtents = o.halfExtents ?? v3(0.3, 0.5, 0.32);
  const fit = sideBayFit(o.boreRadius, halfExtents.x);
  if (!fit.passable) return null;
  const outerX = deckHalfWidth(o.boreRadius) - HIDE_SHELL_T;
  const centreX = o.side * (outerX - halfExtents.x);
  return {
    id,
    kind: 'equipment-bay',
    localPos: roundVec(v3(centreX, DECK_Y_M + HIDE_SHELL_T + halfExtents.y, o.z)),
    halfExtents,
    entryPos: roundVec(
      v3(centreX - o.side * bayEntryOffset(halfExtents.x), DECK_Y_M + 0.9, o.z),
    ),
    lookDir: v3(-o.side, 0, 0),
    usableIn: 'any',
  };
}

// ===========================================================================
// PART 2 — the gravity plant (ISS-GRV-08)
// ===========================================================================

/**
 * The unit's envelope in its own frame, in metres.
 *
 * IT HANGS FROM THE OVERHEAD, and that is a decision the collider forced rather
 * than a style choice. A floor-standing 1.4 m machine would have to be in the
 * BVH or players would walk through it, and the only things in the BVH are kit
 * pieces, hide shells and the prop archetypes in `kit.ts` — none of which this
 * file may add to. Above the walking envelope the question does not arise: a
 * standing collider tops out at `DECK_Y_M + PLAYER_STAND_HEIGHT_M` = 0.95, and a
 * unit bolted to a node's 1.50 m overhead reaches down to 1.14 — unreachable by
 * construction, so it needs no collision and cannot be clipped through.
 *
 * It is also where a gyro belongs. The bible's ISS-GRV-11 makes the same point
 * from the other direction: "walking means you look up at a ceiling you never saw
 * while floating." This is the thing to look at when you do.
 */
export const PLANT_SIZE = Object.freeze({
  /** Along the unit's long axis (local X). */
  length: 0.86,
  /** Down from the mount plane (local −Y). */
  drop: 0.36,
  /** Local Z, from the back of the fin stack to the face of the gearbox. */
  depth: 0.38,
});

/** Local Z of the gearbox face the vent, lamp and label are mounted on. */
const FACE_Z = 0.18;
/** Local Y of the rotor's centre. */
const ROTOR_Y = -0.308;
/** Blade tip radius. Sets the guard, and the read from below. */
const ROTOR_R = 0.165;
/** Revolutions per second at full speed. Fast enough to blur, slow enough that
 *  the spin-down is legible rather than a strobe. */
const ROTOR_RPS = 1.6;
/** Lowest point of the unit, relative to its mount plane. */
const PLANT_BOTTOM = -PLANT_SIZE.drop;

export type PlantState = 'running' | 'winding' | 'stopped';

export interface PlantPlacement {
  readonly module: ModuleId;
  /** Mount plane, module space: the point on the overhead it bolts to. */
  readonly at: Vec3;
  /** Yaw about +Y. The vent, lamp and label face local +Z after it. */
  readonly yaw: number;
}

/**
 * Where the plants are: one in each of the four nodes, and nowhere else.
 *
 * A NODE, BECAUSE THE CROWN OF A TUBE IS SPOKEN FOR. `kit.ts`' `tubeInterior`
 * gives every cylindrical piece a ring-frame rhythm, two lighting coves, two
 * cable raceways and an overhead service run, and that run puts a duct and two
 * conduits in exactly the 0.4 m of crown a hanging unit would need — a 1.4 m
 * bore has one clear band above the walking envelope and it is already full. A
 * node has the same band and nothing in it but a coffered ceiling, so the unit
 * sits between two coffer beams with 1.5 cm at each end. Two agents' hardware in
 * the same 5 cm of crown is how you get a duct through a flywheel.
 *
 * It is also the better diegesis. A node is where the station's services meet;
 * the four of them are the four places a gravity plant would be, the cupola is a
 * window (and the reason it is dark), and the Soyuz is a capsule that borrows the
 * station's floor rather than making its own. A player who learns to look for the
 * drum learns something true about the map.
 *
 * THE MOUNT PLANE AND THE OFFSET ARE BOTH DERIVED from the node, not typed: the
 * ceiling is `NODE_H` and the clear ring of ceiling runs from the `PORT_RADIUS`
 * hole out to the coffer beam at `NODE_COFFER_INNER_M`, so the envelope is
 * centred between the two. When the kit widened, this followed it — a plant left
 * at y = 1.5 in a 2.25 m node would hang three quarters of a metre below the
 * ceiling it is supposed to be bolted to. The gearbox face is turned inboard
 * (`yaw`) so the lamp is legible from the console island, which is where a
 * player under pressure actually is.
 */
/**
 * Inner edge of a node's coffered ceiling beams, from the module axis.
 *
 * `geometry.ts` builds the coffers at `radius − 0.34` with a 0.1 m beam, so the
 * clear field of ceiling ends at `NODE_H − 0.34 − 0.05`. Restated here because it
 * is not exported there and because a plant is bolted THROUGH that ceiling: if
 * the coffer moves, this number is wrong, and the assert below is what makes
 * that loud rather than a beam through a bearing housing.
 */
export const NODE_COFFER_INNER_M = NODE_H - 0.34 - 0.05;

const PLANT_RING_Z = round3((PORT_RADIUS + NODE_COFFER_INNER_M) / 2);

export const GRAVITY_PLANTS: readonly PlantPlacement[] = Object.freeze([
  { module: 'node-alpha' as ModuleId, at: v3(0, NODE_H, PLANT_RING_Z), yaw: Math.PI },
  { module: 'node-beta' as ModuleId, at: v3(0, NODE_H, -PLANT_RING_Z), yaw: 0 },
  { module: 'node-gamma' as ModuleId, at: v3(PLANT_RING_Z, NODE_H, 0), yaw: -Math.PI / 2 },
  { module: 'node-delta' as ModuleId, at: v3(-PLANT_RING_Z, NODE_H, 0), yaw: Math.PI / 2 },
]);

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  return g;
}

/**
 * The housing: a finned drum on brackets with a gearbox on its face.
 *
 * SILHOUETTE. Nothing else in the station is a horizontal ribbed cylinder slung
 * under the ceiling with a disc under it. The racks are flat boxes on walls, the
 * hub is a sphere at axis height, the valve is a wheel on a panel, the cargo rack
 * is a ladder of ribs — so the plant is identified by the one profile it owns:
 * ribbed barrel above, spinning disc below, at head height and never underfoot.
 */
export function plantHousingGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Mount rail against the overhead, and the two brackets it hangs on.
  parts.push(at(box({ x: PLANT_SIZE.length, y: 0.03, z: 0.11 }), 0, -0.015, 0.01));
  for (const s of [-1, 1]) {
    parts.push(at(box({ x: 0.05, y: 0.12, z: 0.22 }), s * 0.3, -0.08, 0.01));
  }

  // The drum. Ribs ARE the cooling fins — five of them, so the barrel reads as
  // machined even when the torch only catches its top edge.
  parts.push(
    at(
      ribbedCylinder(0.115, 0.56, {
        axis: 'x',
        ribs: 5,
        ribHeight: 0.018,
        ribWidth: 0.026,
        radialSegments: 10,
      }),
      0,
      -0.165,
      0,
    ),
  );

  // Bearing housings at both ends: the chamfer keeps them octagonal, which reads
  // as cast metal rather than as two more boxes.
  for (const s of [-1, 1]) {
    parts.push(
      at(chamferedBox({ x: 0.07, y: 0.26, z: 0.26 }, 0.03, { axis: 'x' }), s * 0.315, -0.165, 0),
    );
  }
  // Bolt circle on the drive end only. Asymmetry is free silhouette information:
  // which way the plant faces is readable from either side of the room.
  parts.push(
    at(boltRing(0.095, 5, { boltRadius: 0.012, height: 0.009, segments: 5, axis: 'x' }), 0.35, -0.165, 0),
  );

  // Gearbox on the face, offset off centre so the unit is not a mirror of itself.
  parts.push(at(box({ x: 0.32, y: 0.19, z: 0.08 }), 0.06, -0.165, FACE_Z - 0.04));
  // Intake louvres on it: slats read as an opening at a grazing torch angle,
  // where a painted rectangle reads as nothing at all.
  parts.push(
    at(
      louvreSlats(0.2, 0.12, { slats: 5, frame: 0.01, depth: 0.024, thickness: 0.006 }),
      -0.02,
      -0.165,
      FACE_Z - 0.012,
    ),
  );

  // Fin stack on the back, four plates along the barrel.
  for (let i = 0; i < 4; i++) {
    parts.push(at(box({ x: 0.014, y: 0.15, z: 0.09 }), -0.27 + i * 0.09, -0.165, -0.135));
  }

  const g = mergeParts(parts);
  assertPolyBudget(g, 'fixture', 'gravity plant housing');
  return g;
}

/**
 * The flywheel, as a five-bladed disc on a vertical axis.
 *
 * VERTICAL, so it is legible from the only place a player ever sees it from: the
 * floor, looking up. A horizontal shaft would show the player its edge, and an
 * edge-on disc slowing down is indistinguishable from an edge-on disc that has
 * stopped — which would quietly break the fairness guarantee this asset exists
 * to keep. Five blades rather than four or six, because a five-fold rotor has no
 * symmetry that can alias against a 60 Hz frame rate and read as stationary.
 */
export function plantRotorGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hub = new THREE.CylinderGeometry(0.05, 0.05, 0.055, 10, 1);
  parts.push(hub);
  // Drive shaft, offset UP so it disappears into the drum rather than poking out
  // below the guard, where it would read as a dropped bolt.
  parts.push(at(new THREE.CylinderGeometry(0.022, 0.022, 0.085, 6, 1), 0, 0.03, 0));
  for (let i = 0; i < 5; i++) {
    const blade = box({ x: 0.115, y: 0.02, z: 0.062 });
    // Pitched, so the blades catch the torch differently as they come round.
    blade.rotateZ(0.28);
    blade.translate(0.05 + 0.115 / 2, 0, 0);
    blade.rotateY((i / 5) * Math.PI * 2);
    parts.push(blade);
  }
  const g = mergeParts(parts);
  assertPolyBudget(g, { label: 'gravity plant rotor', min: 80, max: 260 }, 'gravity plant rotor');
  return g;
}

/**
 * Hazard trim: the rotor guard, a striped band across the gearbox, and a
 * two-bar label plate.
 *
 * All three are vertex-coloured, so they are one geometry on `materials.hazard`
 * and one draw call for every plant in the station. The guard is also the only
 * part of the assembly a player could possibly reach — 1.00 m is head height for
 * nobody, but it is arm height for everybody — so hazard yellow on it is
 * information rather than decoration, and it is the bible's answer for
 * ISS-GRV-10's coaming for the same reason.
 */
export function plantHazardGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Three straps under the flywheel, just past the blade tips.
  for (let i = 0; i < 3; i++) {
    const strap = withVertexColor(
      box({ x: ROTOR_R * 2 + 0.03, y: 0.016, z: 0.028 }),
      HAZARD_YELLOW,
    );
    strap.rotateY((i / 3) * Math.PI);
    strap.translate(0, PLANT_BOTTOM + 0.008, 0);
    parts.push(strap);
  }
  // Striped band along the top of the gearbox.
  const band = hazardStripeBand(0.3, 0.04, { stripes: 6, skew: 0.3, thickness: 0.008 });
  band.translate(0.06, -0.09, FACE_Z - 0.004);
  parts.push(band);
  // Two bars: the station's language for "gravity plant", countable in the dark
  // and identical in every locale.
  const label = labelPlate(0.1, 0.07, { bars: 2 });
  label.translate(0.19, -0.2, FACE_Z + 0.002);
  parts.push(label);
  return mergeParts(parts);
}

/** The state lamp: one bulb on the gearbox face. */
export function plantLampGeometry(): THREE.BufferGeometry {
  const g = accentGeometry('bulb').clone();
  g.translate(-0.14, -0.225, FACE_Z);
  return g;
}

/** Triangles one plant costs, all four streams counted. */
export function plantTriangleCount(): number {
  const parts = [
    plantHousingGeometry(),
    plantRotorGeometry(),
    plantHazardGeometry(),
    plantLampGeometry(),
  ];
  const total = parts.reduce((a, g) => a + triangleCount(g), 0);
  for (const g of parts) g.dispose();
  return total;
}

// ---------------------------------------------------------------------------
// Placement checks
// ---------------------------------------------------------------------------

export class PlantClearanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlantClearanceError';
  }
}

/**
 * Corners of the unit's envelope, in the plant's own frame.
 *
 * `topY` defaults to a hair BELOW the mount plane, because the mount plane is
 * bolted to the shell and is therefore coincident with it by design: including
 * y = 0 would make every correctly mounted plant fail a containment test against
 * the very surface it is fastened to.
 */
function envelopeCorners(topY = -0.002): THREE.Vector3[] {
  const hx = PLANT_SIZE.length / 2;
  const out: THREE.Vector3[] = [];
  for (const x of [-hx, hx]) {
    for (const y of [PLANT_BOTTOM, topY]) {
      for (const z of [-0.185, 0.195]) out.push(new THREE.Vector3(x, y, z));
    }
  }
  return out;
}


/**
 * Every plant is above the walking envelope, inside its module's shell, and in
 * the clear ring of ceiling between the port throat and the coffer beams.
 *
 * Three failures this catches, all silent otherwise. A unit hung low enough to be
 * walked into — there is no collision on it, so a player would pass straight
 * through the machine, which is worse than not having the machine. A unit whose
 * corners are outside a curved crown: a tube's bore closes to about a third of a
 * metre of half-width at the height a plant hangs at, so "it fits in the node"
 * proves nothing about a tube. And a unit that has drifted into the overhead
 * structure another file owns, which is the failure this whole placement table
 * was rewritten to avoid.
 */
export function assertPlantClearance(
  placements: readonly PlantPlacement[] = GRAVITY_PLANTS,
): void {
  const failures: string[] = [];
  const headroom = DECK_Y_M + PLAYER_STAND_HEIGHT_M;
  const corners = envelopeCorners();
  for (const p of placements) {
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(p.at.x, p.at.y, p.at.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw),
      new THREE.Vector3(1, 1, 1),
    );
    let lowest = Infinity;
    let nearest = Infinity;
    let furthest = 0;
    for (const c of corners) {
      const v = c.clone().applyMatrix4(local);
      lowest = Math.min(lowest, v.y);
      // The port throat is a CIRCLE cut in the plate, so that test is radial…
      nearest = Math.min(nearest, Math.hypot(v.x, v.z));
      // …and the coffer field is a SQUARE between four axis-aligned beams, so
      // that one is Chebyshev. Measuring both the same way rejected every legal
      // placement in the room, which is the sort of check that gets deleted.
      furthest = Math.max(furthest, Math.abs(v.x), Math.abs(v.z));
    }
    if (lowest < headroom + 0.03) {
      failures.push(
        `${p.module}: plant hangs to y=${lowest.toFixed(3)}, inside the standing envelope ` +
          `(${headroom.toFixed(2)}) — it has no collision, so a player would walk through it`,
      );
    }
    if (nearest < PORT_RADIUS) {
      failures.push(
        `${p.module}: plant reaches ${nearest.toFixed(3)} m of the axis, inside the ` +
          `${PORT_RADIUS.toFixed(2)} m port throat it is mounted beside`,
      );
    }
    if (furthest > NODE_COFFER_INNER_M) {
      failures.push(
        `${p.module}: plant reaches ${furthest.toFixed(3)} m from the axis, into the coffered ` +
          `ceiling beams at ${NODE_COFFER_INNER_M.toFixed(2)} m`,
      );
    }
  }
  if (failures.length > 0) throw new PlantClearanceError(failures.join('\n  - '));
}

/**
 * Does a placement fit inside the kit piece it is mounted in?
 *
 * Separate from `assertPlantClearance` because it needs `KIT`, and the answer
 * depends on the module KIND rather than on the placement alone: a node is a
 * 1.5 m box and a tube is a 1.0–1.4 m bore about local +Z, and the same pose is
 * legal in one and through the wall in the other.
 */
export function plantFitsPiece(p: PlantPlacement, kind: keyof typeof KIT): boolean {
  const piece = KIT[kind];
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(p.at.x, p.at.y, p.at.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw),
    new THREE.Vector3(1, 1, 1),
  );
  for (const c of envelopeCorners()) {
    const v = c.clone().applyMatrix4(local);
    // 1 mm, not 2 cm: a unit BOLTED to the shell is coincident with it on
    // purpose, so the test is "does anything poke through", not "does it float".
    if (kind === 'node') {
      if (Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) > piece.radius - 0.001) {
        return false;
      }
    } else {
      if (Math.hypot(v.x, v.y) > piece.radius - 0.001) return false;
      if (Math.abs(v.z) > piece.length / 2 - 0.001) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * What a plant needs to know about its module, which is exactly what
 * `StationGravity` already exposes — pass `station.gravity` straight in.
 */
export interface GravityStateSource {
  mode(id: ModuleId): GravityMode;
  pending(id: ModuleId): { to: GravityMode; cause: GravityCause; ms: number } | null;
}

/**
 * One `InstancedMesh` whose instances are REPACKED, never merely hidden.
 *
 * Not `InstancedSet`: that class owns its own packing so it can drop culled
 * modules, and the rotor needs a fresh matrix every frame. The packing rule is
 * the same and it matters for the same reason — a "hidden" instance left in the
 * buffer with a zero scale still runs the vertex shader over all 508 triangles
 * of the housing, so four culled plants would cost 2k transformed vertices a
 * frame to draw nothing. `push` appends only what is actually visible and lit,
 * `commit` shortens `count` to match, and at `count === 0` three's instanced
 * renderer skips the draw entirely.
 */
class PlantSlots {
  readonly mesh: THREE.InstancedMesh;
  private cursor = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    slots: number,
    name: string,
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, slots));
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.userData.noShadow = true;
    this.mesh.userData.noCollide = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  reset(): void {
    this.cursor = 0;
  }

  push(matrix: THREE.Matrix4): void {
    if (this.cursor >= this.mesh.instanceMatrix.count) return;
    this.mesh.setMatrixAt(this.cursor++, matrix);
  }

  commit(): void {
    this.mesh.count = this.cursor;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.cursor > 0) {
      this.mesh.computeBoundingSphere();
    } else {
      const sphere = this.mesh.boundingSphere ?? new THREE.Sphere();
      sphere.makeEmpty();
      this.mesh.boundingSphere = sphere;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

interface PlacedPlant {
  readonly placement: PlantPlacement;
  /** Mount pose in WORLD space (module transform baked in). */
  readonly world: THREE.Matrix4;
  /** Rotor pivot in world space, before the spin. */
  readonly rotorBase: THREE.Matrix4;
  visible: boolean;
  /** 0 stopped, 1 at speed. */
  spin: number;
  angle: number;
  state: PlantState;
}

const _spin = new THREE.Matrix4();
const _scratch = new THREE.Matrix4();

/**
 * Every gravity plant in the station: five draw calls, one clock.
 *
 * THE ROTOR IS THE TIMER, NOT AN ANIMATION OF IT. While a change is pending,
 * `spin` is `pending.ms / (GRAVITY_WARNING_S × 1000)` — sampled, not smoothed —
 * so the wheel reaches a standstill on the frame the floor lets go and on no
 * other frame, at any frame rate, on both the client that scheduled the change
 * and one that received it in a snapshot. §4 calls the 2.5 s of warning the
 * fairness guarantee; a decorative spin-down that finished early or late would
 * turn it back into a surprise, which is the one thing it may not be.
 *
 * Restoring gravity runs the same machinery backwards: the lamp goes amber the
 * moment the change is announced and the wheel spins UP across the window, so
 * "go turn the floor back on" (§11) has the same visible countdown as losing it.
 */
export class StationGravityPlants {
  readonly group = new THREE.Group();
  private readonly plants: PlacedPlant[] = [];
  private readonly housing: PlantSlots;
  private readonly rotor: PlantSlots;
  private readonly hazard: PlantSlots;
  private readonly lampRunning: PlantSlots;
  private readonly lampWinding: PlantSlots;
  private dirty = true;
  /** See `setPrewarm`. Only ever true for the duration of the warm frame. */
  private prewarmAll = false;

  constructor(
    layout: StationLayout,
    materials: StationMaterials,
    placements: readonly PlantPlacement[] = GRAVITY_PLANTS,
  ) {
    this.group.name = 'gravity-plants';
    const byId = new Map(layout.modules.map((m) => [m.id, m]));

    for (const placement of placements) {
      const module = byId.get(placement.module);
      if (!module) continue;
      const world = moduleMatrix(module).multiply(
        new THREE.Matrix4().compose(
          new THREE.Vector3(placement.at.x, placement.at.y, placement.at.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.yaw),
          new THREE.Vector3(1, 1, 1),
        ),
      );
      const rotorBase = world
        .clone()
        .multiply(new THREE.Matrix4().makeTranslation(0, ROTOR_Y, 0));
      this.plants.push({
        placement,
        world,
        rotorBase,
        visible: true,
        spin: module.gravity === 'zero' ? 0 : 1,
        angle: 0,
        state: module.gravity === 'zero' ? 'stopped' : 'running',
      });
    }

    const slots = this.plants.length;
    this.housing = new PlantSlots(plantHousingGeometry(), materials.aluminium, slots, 'plant-housing');
    this.rotor = new PlantSlots(plantRotorGeometry(), materials.brass, slots, 'plant-rotor');
    this.hazard = new PlantSlots(plantHazardGeometry(), materials.hazard, slots, 'plant-hazard');
    this.lampRunning = new PlantSlots(
      plantLampGeometry(),
      materials.indicatorFor('green'),
      slots,
      'plant-lamp-running',
    );
    this.lampWinding = new PlantSlots(
      plantLampGeometry(),
      materials.indicatorFor('amber'),
      slots,
      'plant-lamp-winding',
    );
    for (const set of this.sets()) this.group.add(set.mesh);
    this.flush();
  }

  /** Every plant this station actually placed. */
  get count(): number {
    return this.plants.length;
  }

  /** The lamp state of one module's plant, for tests and for the HUD. */
  stateOf(module: ModuleId): PlantState | null {
    return this.plants.find((p) => p.placement.module === module)?.state ?? null;
  }

  /** Spin factor (0–1) of one module's plant. */
  spinOf(module: ModuleId): number | null {
    const plant = this.plants.find((p) => p.placement.module === module);
    return plant ? plant.spin : null;
  }

  /** Call once a frame with `dt` in seconds. `station.gravity` satisfies `state`. */
  tick(dt: number, state: GravityStateSource): void {
    if (this.plants.length === 0 || dt <= 0) return;
    const window = GRAVITY_WARNING_S * 1000;
    for (const plant of this.plants) {
      const id = plant.placement.module;
      const mode = state.mode(id);
      const pending = state.pending(id);
      let spin: number;
      let next: PlantState;
      if (pending && window > 0) {
        // Sampled straight off the announced countdown — see the class comment.
        const remaining = clamp(pending.ms / window, 0, 1);
        spin = pending.to === 'zero' ? remaining : 1 - remaining;
        next = 'winding';
      } else if (mode === 'zero') {
        spin = 0;
        next = 'stopped';
      } else {
        // Spin-up after an unannounced restore (a snapshot, or level load) is the
        // only place a plant is allowed to ease rather than follow the clock.
        spin = Math.min(1, plant.spin + dt / 1.6);
        next = spin > 0.98 ? 'running' : 'winding';
      }
      if (spin !== plant.spin || next !== plant.state) this.dirty = true;
      plant.spin = spin;
      plant.state = next;
      if (spin > 0) {
        plant.angle = (plant.angle + spin * ROTOR_RPS * Math.PI * 2 * dt) % (Math.PI * 2);
        this.dirty = true;
      }
    }
    if (this.dirty) this.flush();
  }

  /**
   * Two-hop portal culling, driven exactly where `StationProps.setVisible` is.
   *
   * Takes the ARRAY as well as the set, because `main.ts` has both to hand
   * (`applyCull` gets `readonly ModuleId[]`, `applyVisibility` a `Set`) and a
   * caller that has to build a Set to call this will eventually build it every
   * frame. At five plants a linear scan is cheaper than the Set anyway.
   */
  setVisible(visible: ReadonlySet<ModuleId> | readonly ModuleId[]): void {
    const shown = Array.isArray(visible)
      ? (id: ModuleId): boolean => (visible as readonly ModuleId[]).includes(id)
      : (id: ModuleId): boolean => (visible as ReadonlySet<ModuleId>).has(id);
    let changed = false;
    for (const plant of this.plants) {
      const next = shown(plant.placement.module);
      if (next !== plant.visible) {
        plant.visible = next;
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.flush();
    }
  }

  /**
   * Put an instance in EVERY set for the pre-warm's one full-pipeline frame.
   *
   * The amber `winding` lamp is the one that matters. Every plant starts running,
   * so that set is empty at boot with `count === 0`, and `Renderer.prewarm()`
   * forcing `visible = true` does not help an instanced mesh with nothing in it:
   * its vertex buffers would upload the first time a gravity failure was
   * announced. §4 calls that announcement the fairness guarantee — a hitch on
   * exactly that frame is the worst one this file could produce.
   */
  setPrewarm(on: boolean): void {
    if (this.prewarmAll === on) return;
    this.prewarmAll = on;
    this.dirty = true;
    this.flush();
  }

  dispose(): void {
    for (const set of this.sets()) {
      this.group.remove(set.mesh);
      set.dispose();
    }
    this.plants.length = 0;
  }

  private sets(): PlantSlots[] {
    return [this.housing, this.rotor, this.hazard, this.lampRunning, this.lampWinding];
  }

  private flush(): void {
    this.dirty = false;
    for (const set of this.sets()) set.reset();
    for (const plant of this.plants) {
      if (!plant.visible && !this.prewarmAll) continue;
      this.housing.push(plant.world);
      this.hazard.push(plant.world);
      _spin.makeRotationY(plant.angle);
      this.rotor.push(_scratch.copy(plant.rotorBase).multiply(_spin));
      // Dark is the absence of a lamp, not a dimmed one: a stopped plant has
      // nothing lit on it, which is what §4's "green → amber → dark" means and
      // also what keeps the accent budget honest — one self-lit thing per state.
      if (this.prewarmAll) {
        this.lampRunning.push(plant.world);
        this.lampWinding.push(plant.world);
      } else if (plant.state === 'running') {
        this.lampRunning.push(plant.world);
      } else if (plant.state === 'winding') {
        this.lampWinding.push(plant.world);
      }
    }
    for (const set of this.sets()) set.commit();
  }
}

/**
 * Dev self-check, in the same spirit as `assertPaletteCoherent` and
 * `assertArtKitCoherent`: the placements are legal in the pieces they sit in and
 * the whole assembly is inside the bible's budget for a set-piece.
 */
export function assertGravityPropsCoherent(): void {
  assertPlantClearance();
  // Every authored placement is in a node; the map is here rather than inferred
  // so a placement moved into a tube fails this check instead of the wall.
  const kinds: Record<string, keyof typeof KIT> = {
    'node-alpha': 'node',
    'node-beta': 'node',
    'node-gamma': 'node',
    'node-delta': 'node',
  };
  const failures: string[] = [];
  for (const p of GRAVITY_PLANTS) {
    const kind = kinds[p.module];
    if (!kind) {
      failures.push(`${p.module}: no kit kind mapped for this plant placement`);
      continue;
    }
    if (!plantFitsPiece(p, kind)) {
      failures.push(`${p.module}: plant envelope leaves the ${kind} shell`);
    }
  }
  const tris = plantTriangleCount();
  if (tris < 700 || tris > 1100) {
    failures.push(`gravity plant is ${tris} triangles, outside ISS-GRV-08's 700–1100`);
  }
  // 2 mm of slack: `cornerFinGap` measures the ROUNDED authored position, and
  // `roundVec` is deliberately 4 decimal places for diff-stable level files.
  const gap = cornerFinGap(NODE_H, NODE_ISLAND_HALF);
  if (gap + 0.002 < WALK_LANE_M) {
    failures.push(
      `corner fins leave ${gap.toFixed(3)} m past the console island, under WALK_LANE_M`,
    );
  }
  if (failures.length > 0) {
    throw new PlantClearanceError(`gravityProps: \n  - ${failures.join('\n  - ')}`);
  }
}

/** Wall standoff for deck furniture, re-exported so level scripts can use the
 *  same number `labIsland` derives its bank position from. */
export const FURNITURE_STANDOFF_M = WALL_FITTING_DEPTH_M;

/** Entry clearance a hide spot's mouth needs, re-exported for the same reason. */
export const BAY_MOUTH_CLEARANCE_M = HIDE_ENTRY_CLEARANCE_M;

/** Deck half-width of a bore, re-exported so a level script needs one import. */
export const deckHalfWidthOf = deckHalfWidth;

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
 * True when the placement and budget check ran and passed at import (dev only).
 *
 * Same contract as `PALETTE_CHECKED` and `ART_KIT_CHECKED`: the argument for
 * every number in this file is a measurement, so the measurement runs. It costs
 * four geometry merges that are thrown away again — under a millisecond, and it
 * happens while the menu is still up.
 */
export const GRAVITY_PROPS_CHECKED: boolean = (() => {
  if (!isDevEnvironment()) return false;
  assertGravityPropsCoherent();
  return true;
})();
