/**
 * Every scatter prop in the station, and the meshes that draw them.
 *
 * ISS-PRP-01…08 and ISS-PZL-06 of `docs/asset-bible.html`, plus ISS-GRV-03's
 * partial bulkhead and the two pieces of deck furniture (`bench`, `bank`) that
 * carry the hide-spot family resemblance. One file, one dispatch — the geometry
 * and the instancing decision for a prop kind are never two edits in two
 * places.
 *
 * ---------------------------------------------------------------------------
 * THE TWO LOCAL FRAMES, and why getting them wrong is the classic mistake
 * ---------------------------------------------------------------------------
 *
 * WALL PROPS (rack, cable, stowage, laptop, slot, locker, panel, cargo-rack)
 * are authored by `kit.ts` through `orientProp(inward, along)`, which builds
 * the basis `x = cross(y, z)` with y = inward and z = along. On a cylindrical
 * module's side wall (`wallInward(0)` / `wallInward(π)`, the only two walls a
 * deck module uses) that works out to:
 *
 *     local +X  →  UP            (module +Y)
 *     local +Y  →  OUT of the wall, into the room
 *     local +Z  →  ALONG the corridor
 *
 * So a rack's authored `size` of 1.0 × 0.22 × 1.5 is 1.0 m TALL, 0.22 m deep
 * and 1.5 m long — not 1.0 m wide. Every builder below is written in that
 * frame, and helpers that come out of `artKit` in the XY plane facing +Z are
 * turned with `faceOut()` (its width stays on local X, i.e. vertical).
 *
 * Two placements deliberately invert it: a node's ±Z faces are oriented
 * `along = (1,0,0)`, which puts local +X pointing DOWN. Those racks sit at
 * y = ±1.3, hard against the ceiling, so every rack variant is kept
 * near-symmetric about its own X midplane and reads the same either way up.
 *
 * DECK FURNITURE (bulkhead, bench, bank) uses `deckKit`'s convention instead —
 * x = width across the lane, y = HEIGHT, z = depth along the corridor — and is
 * placed with its underside on the deck (`localPos.y = DECK_Y_M + size.y / 2`).
 *
 * ---------------------------------------------------------------------------
 * DRAW CALLS AND MATERIALS
 * ---------------------------------------------------------------------------
 *
 * Eight kinds instance; two of them ship in variants, because the bible is
 * explicit that a wall of 33 identical racks visibly tiles and the cable runs
 * butt end to end down a corner (z = −1.65 / 0 / +1.65 for a 1.6 m piece, so
 * three of them form one continuous 4.9 m run). Variants are separate
 * `InstancedMesh`es — one draw call each, chosen per prop by `variantIndex`,
 * which hashes the authored id so the pattern is stable across runs and
 * neighbouring ids land in different buckets.
 *
 * Almost everything shares ONE material: `StationMaterials.vertexPainted`, the
 * palette's single vertex-coloured program. That is what buys the racks their
 * dark vents and light frames, the bulkhead its hazard band and the cargo rack
 * its five bay numbers without a second draw call — the same trick
 * `items/common.ts` uses for the carryables, and the reason `hazardStripeBand`
 * and `labelPlate` exist at all. The exceptions are the four kinds whose mesh
 * is owned elsewhere and already has a material assigned to it (`laptop` keeps
 * `materials.laptop` for its faint screen wash; `slot` and `cargo-bag` are
 * tinted per number by `cargo.ts`; `locker` and `panel` are split across two
 * materials by `lockers.ts` / `panels.ts`), and those four are built WITHOUT a
 * colour attribute so they merge cleanly in their own stream.
 *
 * ---------------------------------------------------------------------------
 * EMISSIVE
 * ---------------------------------------------------------------------------
 *
 * Amber means "you can act on this", so no prop geometry here is self-lit.
 * The lockers, the cargo slots and the hide spots ARE interactable (E opens a
 * locker, E stows a bag, T gets you into a spot), and they get the accent —
 * but through `buildAccentInstances`, so every amber dot in the station is one
 * draw call in total instead of one per object. Racks, cables, wall panels,
 * stowage bags, bulkheads, benches, banks, the cargo rack and the junction hub
 * are inert and stay dark; the hub's "indicator cluster" from the bible is
 * deliberately NOT built, because `PROP_ARCHETYPES.hub` is
 * `interactable: false` and a lit prop a player cannot touch costs the game
 * every true accent it has.
 */

import * as THREE from 'three';
import type { HideSpot, ModuleId, StationLayout, StationModule } from '@shared/types';
import { PROP_ARCHETYPES, propArchetype } from './kit';
import type { PropKind } from './kit';
import { BULKHEAD_SIZE, HIDE_SHELL_T } from './deckKit';
import { InstancedSet, variantIndex } from './instancing';
import type { InstanceEntry } from './instancing';
import type { StationMaterials } from './materials';
import { HAZARD_DARK, HAZARD_YELLOW, PALETTE } from './materials';
import {
  accentMatrix,
  box,
  buildAccentInstances,
  chamferedBox,
  bezelledPanel,
  grille,
  hazardStripeBand,
  labelPlate,
  latch,
  louvreSlats,
  mergeParts,
  ribbedCylinder,
  webbingStrap,
  withVertexColor,
} from './artKit';
import type { AccentPlacement, PolyBudget, Size3 } from './artKit';
import { assertPolyBudget } from './artKit';
import { moduleMatrix, propWorldMatrix } from './threeUtil';

// ===========================================================================
// Palette — every hex a prop is allowed to be, read out of PALETTE
// ===========================================================================

/**
 * Props are identified by silhouette, so this table exists to keep them INSIDE
 * the palette rather than to give each kind a signature colour. Values come
 * from `PALETTE` so a retune moves the props with it.
 */
const C = Object.freeze({
  /** Equipment rack carcass. */
  rack: PALETTE.rack.color,
  /** Bright machined edge: rails, cowls, collars, latch plates. */
  frame: PALETTE.frame.color,
  /** Painted sheet: drawer faces, doors, aprons. */
  paint: PALETTE.painted.color,
  /** Bare aluminium: base plates, bolt heads, glands. */
  metal: PALETTE.aluminium.color,
  /** The dark inside of a recess, a vent or a slot. */
  recess: PALETTE.slot.color,
  /** Rubber-jacketed cable. */
  cable: PALETTE.cable.color,
  /** Moulded rubber: grommets, saddles, feet. */
  rubber: PALETTE.rubber.color,
  /** Woven strap. The one colour that says a person put it there. */
  webbing: PALETTE.webbing.color,
  /** Soft stowage fabric. */
  stowage: PALETTE.stowage.color,
  /** Deck furniture body. */
  furniture: PALETTE.furniture.color,
  /** The cargo rack. */
  cargoRack: PALETTE.cargoRack.color,
  /** Junction hub shell. */
  hub: PALETTE.hub.color,
  /** Instrument body. */
  instrument: PALETTE.panelBody.color,
  /** Hazard yellow, and the dark half of every hazard pair. */
  yellow: HAZARD_YELLOW,
  stencil: HAZARD_DARK,
});

/** Paint a part so it can join the vertex-coloured stream. */
function p(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  return withVertexColor(geometry, hex);
}

// ===========================================================================
// Local transform sugar
// ===========================================================================

function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  return g;
}

/** An artKit flat helper (XY plane, facing +Z) turned to face a wall prop's
 *  +Y. Its width stays on local X — which on a side wall is vertical. */
function faceOut(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.rotateX(-Math.PI / 2);
  return g;
}

/** …turned to face +X (a deck fitting's lane side). Width runs along −Z. */
function facePosX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.rotateY(Math.PI / 2);
  return g;
}

/** …turned to face −X. */
function faceNegX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.rotateY(-Math.PI / 2);
  return g;
}

/** …turned to face −Z. */
function faceNegZ(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.rotateY(Math.PI);
  return g;
}

/** A cylinder along +Z, which is the long axis of every wall prop. */
function tubeZ(radius: number, length: number, segments = 6, capped = true): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, segments, 1, !capped);
  g.rotateX(Math.PI / 2);
  return g;
}

/** A cylinder along +Y. */
function tubeY(radius: number, length: number, segments = 6, capped = true): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius, radius, length, segments, 1, !capped);
}

// ===========================================================================
// Two primitives artKit does not have
// ===========================================================================

type V3 = readonly [number, number, number];

/**
 * A minimal indexed quad soup — position / normal / uv, flat-shaded per face.
 *
 * Same attribute set as every three primitive and every artKit helper, so
 * anything built here merges with them (after `p()` if it is joining the
 * vertex-coloured stream). Wind a…d counter-clockwise as seen from the front
 * and the normal follows; getting that backwards is invisible under ambient
 * light and catastrophic under one 5 cd cone.
 */
class Quads {
  private readonly position: number[] = [];
  private readonly normal: number[] = [];
  private readonly uv: number[] = [];
  private readonly index: number[] = [];
  private verts = 0;

  quad(a: V3, b: V3, c: V3, d: V3): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const base = this.verts;
    const corners: Array<[V3, number, number]> = [
      [a, 0, 0],
      [b, 1, 0],
      [c, 1, 1],
      [d, 0, 1],
    ];
    for (const [q, u, v] of corners) {
      this.position.push(q[0], q[1], q[2]);
      this.normal.push(nx, ny, nz);
      this.uv.push(u, v);
      this.verts++;
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.index);
    return g;
  }
}

/** The chamfered-square outline `chamferedBox` uses, as 2-D points. */
function chamferRing(u: number, v: number, chamfer: number): Array<[number, number]> {
  const c = Math.max(0, Math.min(chamfer, u * 0.9, v * 0.9));
  return [
    [u, v - c],
    [u - c, v],
    [-(u - c), v],
    [-u, v - c],
    [-u, -(v - c)],
    [-(u - c), -v],
    [u - c, -v],
    [u, -(v - c)],
  ];
}

/**
 * An open band wrapped around a chamfered-box cross-section. **16 triangles.**
 *
 * The cheapest thing in the game that reads as a strap, a tie-wrap or a
 * numbered stripe from every angle, which is exactly what a cargo bag needs:
 * it is a Rapier body in a zero-G module, it tumbles, and a band painted on two
 * of its six faces is a label that is missing half the time. Eight side quads,
 * no caps — the band's own edges are inside whatever it is wrapped around.
 *
 * `axis` is the axis the band encircles; `u`/`v` are the half-extents of the
 * cross-section in the other two, in the same order `chamferedBox` takes them.
 */
function chamferBand(
  u: number,
  v: number,
  chamfer: number,
  width: number,
  axis: 'x' | 'y' | 'z' = 'y',
): THREE.BufferGeometry {
  const ring = chamferRing(u, v, chamfer);
  const q = new Quads();
  const lo = -width / 2;
  const hi = width / 2;
  // Built encircling +Y with the section in X/Z, then turned. Winding copied
  // from `chamferedBox` so the normals point out of the band.
  const put = (i: number, y: number): V3 => {
    const pt = ring[i % ring.length] as [number, number];
    return [pt[0], y, pt[1]];
  };
  for (let i = 0; i < ring.length; i++) {
    q.quad(put(i, lo), put(i, hi), put(i + 1, hi), put(i + 1, lo));
  }
  const g = q.build();
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  return g;
}

/**
 * A slack cable strand: a tube through three control points. Triangle count is
 * `tubular × radial × 2`, so 4 × 5 = 40 at the values used below.
 *
 * The bow is what does the work. A straight cylinder in a corner is a pipe; the
 * same cylinder with 4 cm of sag in the middle is something somebody ran and
 * cable-tied, and the bible is blunt that this one asset is what makes the
 * station read as lived-in rather than modelled. The bow is toward local +Y —
 * AWAY from the wall the run is clipped to — because that is the one direction
 * that reads as slack in every placement the level authors: the corner runs of
 * a tube (where local −X happens to be down) and the vertical trunks down a
 * node's edges (where it is not) both get the same believable belly.
 */
function strand(
  radius: number,
  halfLength: number,
  offset: readonly [number, number],
  bow: readonly [number, number],
  tubular = 4,
  // Four sides, not six. A 2 cm cable is under one pixel of curvature at the
  // 4 m a torch reaches, and 38 bundles of three strands is the one place in
  // the prop set where a radial segment is worth counting: 4 instead of 6 is
  // 900 triangles off the worst two-hop view for a difference nobody can see.
  radial = 4,
): THREE.BufferGeometry {
  const [ox, oy] = offset;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(ox, oy, -halfLength),
    new THREE.Vector3(ox + bow[0] * 0.6, oy + bow[1] * 0.6, -halfLength * 0.5),
    new THREE.Vector3(ox + bow[0], oy + bow[1], 0),
    new THREE.Vector3(ox + bow[0] * 0.6, oy + bow[1] * 0.6, halfLength * 0.5),
    new THREE.Vector3(ox, oy, halfLength),
  ]);
  return new THREE.TubeGeometry(curve, tubular, radius, radial, false);
}

// ===========================================================================
// Budgets
// ===========================================================================

/** Bands the bible publishes per asset, so a builder that drifts fails loudly. */
const BUDGETS = Object.freeze({
  /** ISS-PRP-01. */
  rack: { label: 'equipment rack (ISS-PRP-01)', min: 250, max: 400 } as PolyBudget,
  /** ISS-PRP-02. */
  cable: { label: 'cable bundle (ISS-PRP-02)', min: 120, max: 220 } as PolyBudget,
  /** ISS-PRP-03 — the housing only; `puzzleProps` adds the hardware. */
  panel: { label: 'wall panel (ISS-PRP-03)', min: 80, max: 140 } as PolyBudget,
  /** ISS-PRP-04. */
  stowage: { label: 'stowage bag (ISS-PRP-04)', min: 180, max: 300 } as PolyBudget,
  /** ISS-PRP-05 — body plus door, since the two are one object to a player. */
  locker: { label: 'stowage locker (ISS-PRP-05)', min: 300, max: 450 } as PolyBudget,
  /** ISS-PRP-06. */
  laptop: { label: 'crew laptop (ISS-PRP-06)', min: 200, max: 320 } as PolyBudget,
  /** ISS-PRP-07. */
  slot: { label: 'cargo slot (ISS-PRP-07)', min: 150, max: 250 } as PolyBudget,
  /** ISS-PRP-08. */
  hub: { label: 'junction hub (ISS-PRP-08)', min: 200, max: 300 } as PolyBudget,
  /** ISS-GRV-03. */
  bulkhead: { label: 'partial bulkhead (ISS-GRV-03)', min: 180, max: 300 } as PolyBudget,
  /** ISS-PZL-06's bag. One instance per number, five in the level. */
  cargoBag: { label: 'cargo bag (ISS-PZL-06)', min: 180, max: 400 } as PolyBudget,
  /** ISS-PZL-06's rack. 4.3 m of hardware and exactly one of them. */
  cargoRack: { label: 'cargo rack (ISS-PZL-06)', min: 300, max: 900 } as PolyBudget,
});

// ===========================================================================
// ISS-PRP-01 · Equipment rack — 33 instances, three variants
// ===========================================================================

const RACK = PROP_ARCHETYPES.rack.size;
/** Half height (local X), half depth (local Y), half length (local Z). */
const RK_H = RACK.x / 2;
const RK_D = RACK.y / 2;
const RK_L = RACK.z / 2;
/** Top and bottom rails, and therefore the height of a bay. */
const RK_RAIL = 0.075;
/** Stile thickness, and therefore the gap between bays. */
const RK_STILE = 0.055;
/** Bay centres along local Z: three bays across 1.5 m. */
const RK_BAYS: readonly number[] = [-(RK_L - RK_STILE / 2) / 1.5, 0, (RK_L - RK_STILE / 2) / 1.5];
/** Clear width of one bay along local Z. */
const RK_BAY_W = (RACK.z - 4 * RK_STILE) / 3;
/** Clear height of one bay along local X. */
const RK_BAY_H = RACK.x - 2 * RK_RAIL;

/**
 * The frame all three variants share: a back sheet, two chamfered rails top and
 * bottom, and four stiles that cut the face into three bays.
 *
 * Symmetric about its own X midplane on purpose — a node's ±Z faces mount racks
 * with local +X pointing down (see the header), and a rack that only reads one
 * way up would be visibly upside down on half the node walls.
 */
function rackFrame(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [
    p(at(box({ x: RACK.x, y: 0.03, z: RACK.z }), 0, -RK_D + 0.015, 0), C.rack),
  ];
  for (const sign of [1, -1]) {
    parts.push(
      p(
        at(
          chamferedBox({ x: RK_RAIL, y: RACK.y, z: RACK.z }, 0.014, { axis: 'z' }),
          sign * (RK_H - RK_RAIL / 2),
          0,
          0,
        ),
        C.frame,
      ),
    );
  }
  const stileZ = [
    -(RK_L - RK_STILE / 2),
    -(RK_BAY_W / 2 + RK_STILE / 2),
    RK_BAY_W / 2 + RK_STILE / 2,
    RK_L - RK_STILE / 2,
  ];
  for (const z of stileZ) {
    parts.push(p(at(box({ x: RK_BAY_H, y: RACK.y * 0.96, z: RK_STILE }), 0, 0, z), C.rack));
  }
  return parts;
}

/** One drawer face plus its pull, in the bay at `z`, `n` of them stacked. */
function rackDrawers(z: number, n: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const pitch = RK_BAY_H / n;
  const faceH = pitch * 0.82;
  for (let i = 0; i < n; i++) {
    const x = -RK_BAY_H / 2 + (i + 0.5) * pitch;
    parts.push(
      p(at(box({ x: faceH, y: 0.05, z: RK_BAY_W * 0.92 }), x, RK_D - 0.06, z), C.paint),
      p(
        at(box({ x: 0.03, y: 0.035, z: RK_BAY_W * 0.42 }), x, RK_D - 0.0175, z),
        C.frame,
      ),
    );
  }
  return parts;
}

/** Variant 0 — blank. Six drawer pulls; the silhouette is a ladder of bars. */
function rackBlank(): THREE.BufferGeometry {
  const parts = rackFrame();
  for (const z of RK_BAYS) parts.push(...rackDrawers(z, 2));
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.rack, 'rack/blank');
  return g;
}

/** Variant 1 — vented. Two deep grilles and a chamfered cowl along the top
 *  rail, so the outline breaks where the blank variant's is straight. */
function rackVented(): THREE.BufferGeometry {
  const parts = rackFrame();
  for (const z of [RK_BAYS[0] as number, RK_BAYS[2] as number]) {
    parts.push(
      p(at(box({ x: RK_BAY_H * 0.96, y: 0.02, z: RK_BAY_W * 0.96 }), 0, RK_D - 0.075, z), C.recess),
      p(
        at(
          faceOut(
            grille(RK_BAY_H * 0.94, RK_BAY_W * 0.94, {
              bars: 4,
              frame: 0.016,
              depth: 0.022,
            }),
          ),
          0,
          RK_D - 0.03,
          z,
        ),
        C.frame,
      ),
    );
  }
  parts.push(...rackDrawers(RK_BAYS[1] as number, 1));
  // A chamfered extract cowl along the top rail. Sized so its front face lands
  // exactly on the archetype's +Y plane: the collider is `box(arch.size)` and a
  // cowl that pokes through it is a lip a swept body stops short of.
  parts.push(
    p(
      at(
        chamferedBox({ x: 0.075, y: 0.075, z: RACK.z * 0.86 }, 0.022, { axis: 'z' }),
        RK_H - 0.05,
        RK_D - 0.0375,
        0,
      ),
      C.metal,
    ),
  );
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.rack, 'rack/vented');
  return g;
}

/** Variant 2 — instrumented. A recessed instrument panel amidships, a pair of
 *  ribbed tank stubs at one end and a stencilled bay count at the other. */
function rackInstrumented(): THREE.BufferGeometry {
  const parts = rackFrame();
  parts.push(
    p(
      at(
        faceOut(
          bezelledPanel(RK_BAY_H * 0.9, RK_BAY_W * 0.9, {
            depth: 0.055,
            bezel: 0.035,
            recess: 0.014,
            chamfer: 0.01,
          }),
        ),
        0,
        RK_D - 0.0275,
        RK_BAYS[1] as number,
      ),
      C.instrument,
    ),
  );
  const tankZ = RK_BAYS[0] as number;
  for (const sign of [1, -1]) {
    parts.push(
      p(
        at(
          ribbedCylinder(0.072, RK_BAY_H * 0.9, {
            axis: 'x',
            ribs: 2,
            ribHeight: 0.009,
            ribWidth: 0.028,
            radialSegments: 6,
          }),
          0,
          RK_D - 0.078,
          tankZ + sign * RK_BAY_W * 0.24,
        ),
        C.metal,
      ),
    );
  }
  parts.push(
    at(
      faceOut(labelPlate(RK_BAY_H * 0.42, RK_BAY_W * 0.6, { bars: 4 })),
      0,
      RK_D - 0.006,
      RK_BAYS[2] as number,
    ),
    ...rackDrawers(RK_BAYS[2] as number, 1),
  );
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.rack, 'rack/instrumented');
  return g;
}

// ===========================================================================
// ISS-PRP-02 · Cable bundle — 38 instances, two variants
// ===========================================================================

const CABLE_R = PROP_ARCHETYPES.cable.radius;
const CABLE_L = PROP_ARCHETYPES.cable.length;
/** The wall sits at local −Y of this, because `kit.ts` insets by r + 0.03. */
const CB_WALL = -(CABLE_R + 0.03);
const CB_HALF = CABLE_L / 2;

/** A P-clamp bolted to the wall at each end of a run. */
function cableAnchor(z: number): THREE.BufferGeometry[] {
  return [
    p(at(box({ x: 0.10, y: 0.035, z: 0.05 }), 0, CB_WALL + 0.02, z), C.metal),
    p(at(box({ x: 0.055, y: 0.05, z: 0.032 }), 0, CB_WALL + 0.055, z), C.rubber),
  ];
}

/** Variant 0 — three sagging runs, tie-wrapped twice, anchored at both ends. */
function cableBundle(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    p(strand(0.021, CB_HALF, [0.034, -0.026], [-0.022, 0.042]), C.cable),
    p(strand(0.021, CB_HALF, [-0.034, -0.026], [-0.022, 0.042]), C.cable),
    p(strand(0.019, CB_HALF, [0, 0.014], [-0.018, 0.05]), C.rubber),
  ];
  for (const z of [-CB_HALF * 0.52, CB_HALF * 0.52]) {
    parts.push(p(at(tubeZ(0.061, 0.016, 6, false), -0.013, 0.006, z), C.webbing));
  }
  parts.push(...cableAnchor(-CB_HALF + 0.03), ...cableAnchor(CB_HALF - 0.03));
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.cable, 'cable/bundle');
  return g;
}

/** Variant 1 — a rigid ribbed conduit with two slack drops beside it, unions
 *  at both ends. Alternated with variant 0 down a corner, the joint bulges
 *  land at different places and the 4.9 m run stops reading as one extrusion. */
function cableConduit(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    p(
      at(
        ribbedCylinder(0.04, CABLE_L - 0.1, {
          axis: 'z',
          ribs: 3,
          ribHeight: 0.008,
          ribWidth: 0.03,
          radialSegments: 6,
        }),
        0.016,
        0.002,
        0,
      ),
      C.metal,
    ),
    p(strand(0.016, CB_HALF, [-0.042, -0.018], [-0.014, 0.038]), C.cable),
    p(strand(0.014, CB_HALF, [-0.03, 0.026], [-0.01, 0.03]), C.rubber),
  ];
  for (const z of [-CB_HALF * 0.62, 0, CB_HALF * 0.62]) {
    parts.push(p(at(box({ x: 0.11, y: 0.03, z: 0.034 }), 0, CB_WALL + 0.018, z), C.metal));
  }
  for (const sign of [1, -1]) {
    parts.push(
      p(at(tubeZ(0.054, 0.05, 5), 0.016, 0.002, sign * (CB_HALF - 0.028)), C.frame),
    );
  }
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.cable, 'cable/conduit');
  return g;
}

// ===========================================================================
// ISS-PRP-04 · Stowage bag — soft, bulged, under two straps
// ===========================================================================

function stowageBag(): THREE.BufferGeometry {
  const s = PROP_ARCHETYPES.stowage.size;
  const front = s.y / 2;
  const parts: THREE.BufferGeometry[] = [
    // Two unequal lobes rather than one box: the only non-rigid silhouette in
    // the scatter set, and a lumpy outline is the whole reason it sells.
    p(
      at(
        chamferedBox({ x: s.x * 0.96, y: s.y * 0.92, z: s.z * 0.6 }, 0.062, {
          axis: 'z',
          capChamfer: 0.05,
        }),
        0,
        -0.012,
        -s.z * 0.19,
      ),
      C.stowage,
    ),
    p(
      at(
        chamferedBox({ x: s.x * 0.88, y: s.y * 0.8, z: s.z * 0.55 }, 0.055, {
          axis: 'z',
          capChamfer: 0.045,
        }),
        0,
        -0.03,
        s.z * 0.22,
      ),
      C.stowage,
    ),
  ];
  for (const z of [-s.z * 0.26, s.z * 0.26]) {
    parts.push(
      p(webbingStrap(s.x * 1.06, 0.055, { sag: 0.03, segments: 4 }), C.webbing).translate(
        0,
        front - 0.02,
        z,
      ) as THREE.BufferGeometry,
    );
    for (const sign of [1, -1]) {
      // Buckle where the strap turns, not where it sags: it has to look like
      // the thing holding the strap down or the strap reads as a moulded rib.
      parts.push(
        p(
          at(box({ x: 0.07, y: 0.05, z: 0.075 }), sign * s.x * 0.5, front - 0.02, z),
          C.metal,
        ),
      );
    }
  }
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.stowage, 'stowage bag');
  return g;
}

// ===========================================================================
// ISS-PRP-06 · Crew laptop — angled on an arm mount
// ===========================================================================

/**
 * The one prop kind that keeps its own material.
 *
 * `materials.laptop` carries the palette's faint cold emissive (0x0d3242 at
 * 0.55, inside the `surface` band), which is the bible's "screen dark with a
 * faint glow". Splitting the chassis onto a second material to keep the glow
 * strictly on the screen would cost a second `InstancedMesh` for six objects,
 * and the palette author lowered that intensity specifically so a whole laptop
 * wearing it still reads as a dark device rather than a lamp. So: no colour
 * attribute here, one mesh, one draw call.
 *
 * The bible's "power led" is deliberately not built. `PROP_ARCHETYPES.laptop`
 * is `interactable: false` and the laptop is not in the raycaster's list, so an
 * amber dot on it would be a promise the game cannot keep.
 */
function crewLaptop(): THREE.BufferGeometry {
  // `kit.ts` mounts this 0.32 m off the wall, so local −0.32 is the bulkhead
  // and everything between it and the device is arm.
  const wallY = -0.32;
  // The arm RISES along local +X, which on every wall the level mounts a laptop
  // on is up (measured: all six placements put local +X within 37° of world
  // up). That is what an articulated mount does, and here it is also a fix —
  // four of the six are bolted at module y = −0.55 over a deck at −0.75, i.e.
  // 0.20 m off the floor, and the cupola's sits at 0.05 m. A device modelled
  // centred on its own origin would be at a walker's ankle. Standing the head
  // 0.24…0.46 m up its own column puts the node screens at knee-to-thigh and
  // the lab's at 1.0 m, without touching a single authored position.
  //
  // It also stops reaching into the lane: nothing here goes past local y = 0,
  // so the whole assembly lives inside the 0.32 m the mount already claims.
  const deckX = 0.235;
  const parts: THREE.BufferGeometry[] = [
    at(box({ x: 0.16, y: 0.035, z: 0.14 }), 0, wallY + 0.0175, 0),
    at(box({ x: 0.06, y: 0.05, z: 0.06 }), 0, wallY + 0.06, 0),
  ];
  // Column up the wall — a +Y cylinder laid over onto +X.
  parts.push(at(tubeY(0.018, deckX, 6).rotateZ(Math.PI / 2), deckX / 2, wallY + 0.055, 0));
  parts.push(at(tubeZ(0.026, 0.05, 6), deckX, wallY + 0.055, 0));
  // Elbow out to the head, drooping slightly so the arm reads as jointed.
  const forearm = tubeY(0.016, 0.155, 6);
  forearm.rotateZ(0.30);
  parts.push(at(forearm, deckX - 0.012, wallY + 0.135, 0));
  parts.push(at(tubeZ(0.024, 0.052, 6), deckX, -0.19, 0));

  // Keyboard deck: a thin slab whose long side runs along the corridor.
  parts.push(
    at(chamferedBox({ x: 0.024, y: 0.20, z: 0.30 }, 0.022, { axis: 'x' }), deckX, -0.10, 0),
  );
  parts.push(
    at(facePosX(grille(0.26, 0.15, { bars: 4, frame: 0, depth: 0.007 })), deckX + 0.015, -0.10, 0),
  );
  parts.push(at(tubeZ(0.013, 0.28, 5), deckX + 0.012, -0.19, 0));

  // Screen, hinged at the deck's rear edge and leaning back over the wall.
  const screen = chamferedBox({ x: 0.23, y: 0.022, z: 0.30 }, 0.016, { axis: 'y' });
  screen.rotateZ(-0.30);
  parts.push(at(screen, deckX + 0.115, -0.155, 0));
  const face = box({ x: 0.19, y: 0.006, z: 0.265 });
  face.rotateZ(-0.30);
  parts.push(at(face, deckX + 0.118, -0.145, 0));

  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.laptop, 'crew laptop');
  return g;
}

// ===========================================================================
// ISS-PRP-07 · Cargo slot — "emptiness is the whole message"
// ===========================================================================

/**
 * A lipped recess with an alignment chevron in the back of it.
 *
 * The bay number is geometry, not text and not hue: `bars` raised ribs beside
 * the chevron, matching the band count stencilled on the cargo rack's bay and
 * on the bag itself. `cargo.ts` also tints slot and bag from one index, so a
 * player has two independent cues and neither of them is only colour.
 *
 * No colour attribute: `cargo.ts` gives each slot a per-number tinted material.
 */
function cargoSlot(bars: number): THREE.BufferGeometry {
  const s = PROP_ARCHETYPES.slot.size;
  const hx = s.x / 2;
  const hy = s.y / 2;
  const hz = s.z / 2;
  const wall = 0.05;
  const parts: THREE.BufferGeometry[] = [
    at(box({ x: s.x, y: 0.02, z: s.z }), 0, -hy + 0.01, 0),
  ];
  for (const sign of [1, -1]) {
    parts.push(at(box({ x: wall, y: s.y, z: s.z }), sign * (hx - wall / 2), 0, 0));
    parts.push(at(box({ x: s.x - 2 * wall, y: s.y, z: wall }), 0, 0, sign * (hz - wall / 2)));
  }
  // A proud rim: the lip is what says "something goes in here" at a glance.
  const lip = 0.035;
  for (const sign of [1, -1]) {
    parts.push(at(box({ x: lip, y: lip, z: s.z }), sign * (hx - lip / 2), hy + lip / 2, 0));
    parts.push(
      at(box({ x: s.x - 2 * lip, y: lip, z: lip }), 0, hy + lip / 2, sign * (hz - lip / 2)),
    );
  }
  // Chevron, pointing along −X (down, on a side wall): two bars meeting at a
  // vertex, standing off the back plate so a torch throws a shadow off it.
  for (const sign of [1, -1]) {
    const bar = box({ x: 0.032, y: 0.028, z: 0.21 });
    bar.rotateY(sign * 0.62);
    parts.push(at(bar, 0.05, -hy + 0.035, sign * 0.075));
  }
  // Bay number, as raised ribs above the chevron.
  const pitch = 0.036;
  for (let i = 0; i < bars; i++) {
    parts.push(
      at(
        box({ x: 0.02, y: 0.022, z: 0.10 }),
        -hx + wall + 0.045 + i * pitch,
        -hy + 0.031,
        0,
      ),
    );
  }
  // Guide rails on the floor of the recess, so a bag has somewhere to land.
  for (const sign of [1, -1]) {
    parts.push(at(box({ x: 0.028, y: 0.05, z: 0.4 }), -hx + wall + 0.02, 0, sign * 0.13));
  }
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.slot, `cargo slot ${bars}`);
  return g;
}

// ===========================================================================
// ISS-PRP-08 · Junction hub — infrastructure, not a lamp
// ===========================================================================

function junctionHub(): THREE.BufferGeometry {
  const r = PROP_ARCHETYPES.hub.radius;
  const core = r * 1.4;
  const parts: THREE.BufferGeometry[] = [
    p(
      chamferedBox({ x: core, y: core, z: core }, core * 0.22, {
        axis: 'y',
        capChamfer: core * 0.21,
      }),
      C.hub,
    ),
  ];
  const stubR = r * 0.26;
  const axes: Array<['x' | 'y' | 'z', number]> = [
    ['x', 1],
    ['x', -1],
    ['y', 1],
    ['y', -1],
    ['z', 1],
    ['z', -1],
  ];
  for (const [axis, sign] of axes) {
    // The lateral trunks run out to meet the node's six rail spokes; the
    // vertical pair is deliberately shorter. Under gravity a node's hub sits
    // over the console island at chest height and nothing colliderless should
    // reach further up into a walker's envelope than it has to.
    const stubL = axis === 'y' ? r * 0.7 : r * 1.1;
    const centre = sign * ((axis === 'y' ? r * 1.15 : r * 1.5) - stubL / 2);
    const stub =
      axis === 'z' ? tubeZ(stubR, stubL, 5) : tubeY(stubR, stubL, 5);
    if (axis === 'x') stub.rotateZ(Math.PI / 2);
    parts.push(
      p(
        at(stub, axis === 'x' ? centre : 0, axis === 'y' ? centre : 0, axis === 'z' ? centre : 0),
        C.cable,
      ),
    );
    const collarCentre = sign * (r * 0.62);
    const collar =
      axis === 'y' ? tubeY(stubR * 1.4, 0.028, 5, false) : tubeZ(stubR * 1.4, 0.028, 5, false);
    if (axis === 'x') collar.rotateZ(Math.PI / 2);
    parts.push(
      p(
        at(
          collar,
          axis === 'x' ? collarCentre : 0,
          axis === 'y' ? collarCentre : 0,
          axis === 'z' ? collarCentre : 0,
        ),
        C.frame,
      ),
    );
  }
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.hub, 'junction hub');
  return g;
}

// ===========================================================================
// ISS-GRV-03 · Partial bulkhead — "that single number is the whole asset"
// ===========================================================================

/**
 * `BULKHEAD_SIZE` verbatim from `deckKit`: 0.40 × 1.15 × 0.18.
 *
 * 1.15 m clears the 0.85 m crouched eye line with room to spare and sits far
 * above the 0.40 m step-over, so a crouching player is hidden and the alien has
 * to go around. Nothing here may change that, and nothing here may leave the
 * archetype box either: `buildPropCollision` puts a solid `box(arch.size)` into
 * the BVH, and cover you can see but not stand behind is worse than no cover.
 * The hazard band at the top is the one deliberate exception, standing 6 mm
 * proud of the collider so the painted edge catches the torch.
 */
function partialBulkhead(): THREE.BufferGeometry {
  const s = BULKHEAD_SIZE;
  const hy = s.y / 2;
  const hz = s.z / 2;
  const parts: THREE.BufferGeometry[] = [
    p(chamferedBox({ x: s.x, y: s.y, z: s.z }, 0.024, { axis: 'y' }), C.furniture),
    p(at(box({ x: s.x, y: 0.05, z: s.z }), 0, -hy + 0.025, 0), C.metal),
    p(
      at(chamferedBox({ x: s.x, y: 0.06, z: s.z }, 0.02, { axis: 'z' }), 0, hy - 0.03, 0),
      C.frame,
    ),
  ];
  // Bolted down. A bolt ring is how a player reads "structural, not a door".
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    parts.push(
      p(
        at(tubeY(0.012, 0.01, 4), Math.cos(a) * 0.13, -hy + 0.055, Math.sin(a) * 0.055),
        C.metal,
      ),
    );
  }
  // Hazard band on both faces, and a grab ledge at the height a hand finds it.
  for (const sign of [1, -1]) {
    const band = hazardStripeBand(0.32, 0.13, { stripes: 6, thickness: 0.012, axis: 'x' });
    if (sign < 0) faceNegZ(band);
    parts.push(at(band, 0, hy - 0.145, sign * hz));
    parts.push(
      p(at(box({ x: s.x, y: 0.05, z: 0.03 }), 0, 0.10, sign * (hz - 0.02)), C.paint),
    );
  }
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.bulkhead, 'partial bulkhead');
  return g;
}

// ===========================================================================
// Deck furniture — bench and bank
// ===========================================================================

/**
 * The lab island's bench.
 *
 * Read the collision model before touching this: `bench` is in
 * `SOLID_PROP_KINDS`, so the BVH holds a solid `box(arch.size)`. It is
 * therefore NOT enterable, however much it looks like it should be, and cutting
 * a body-sized void into the underside would advertise a hiding place the
 * sweep refuses — which is strictly worse than a plain box, because a player
 * fleeing a blind thing spends a second on it and a second is a footstep.
 *
 * So it is honestly a bench: a lab worktop with a spill lip, a drawer bank on
 * the lane side, a full-height vent grille on the other, and a recessed plinth
 * so the flashlight draws a shadow line where it meets the deck. The
 * "get in there" affordance lives on the real hide spots instead, which carry
 * the amber accent (see `hideSpotAccents`) — closed cabinets look like closed
 * cabinets, and the ones with a dot are the ones you fit inside.
 */
function labBench(): THREE.BufferGeometry {
  const s = PROP_ARCHETYPES.bench.size;
  const hx = s.x / 2;
  const hy = s.y / 2;
  const hz = s.z / 2;
  const topT = 0.055;
  const topY = hy - topT / 2;
  const parts: THREE.BufferGeometry[] = [
    p(
      at(chamferedBox({ x: s.x, y: topT, z: s.z }, 0.014, { axis: 'z' }), 0, topY, 0),
      C.frame,
    ),
    p(
      at(
        chamferedBox({ x: s.x - 0.04, y: s.y - topT - 0.14, z: s.z - 0.04 }, 0.02, { axis: 'z' }),
        0,
        -0.03,
        0,
      ),
      C.furniture,
    ),
    p(at(box({ x: s.x - 0.10, y: 0.10, z: s.z - 0.12 }), 0, -hy + 0.05, 0), C.metal),
  ];
  for (const sign of [1, -1]) {
    parts.push(
      p(at(box({ x: 0.028, y: 0.03, z: s.z }), sign * (hx - 0.014), hy - 0.015, 0), C.metal),
    );
  }
  // Drawers, lane side.
  for (const z of [-s.z * 0.315, 0, s.z * 0.315]) {
    parts.push(
      p(at(box({ x: 0.02, y: 0.155, z: s.z * 0.28 }), hx - 0.03, 0.02, z), C.paint),
      p(at(box({ x: 0.028, y: 0.028, z: s.z * 0.13 }), hx - 0.008, 0.02, z), C.frame),
    );
  }
  // Full-height vent on the far side. Width runs along −Z after `faceNegX`.
  parts.push(
    p(
      at(
        faceNegX(grille(s.z * 0.82, s.y * 0.5, { bars: 4, frame: 0.014, depth: 0.016 })),
        -hx + 0.024,
        0.0,
        0,
      ),
      C.recess,
    ),
  );
  parts.push(at(labelPlate(0.10, 0.14, { bars: 2 }), hx - 0.16, 0.24, hz - 0.006));
  const g = mergeParts(parts);
  assertPolyBudget(g, 'hideShell', 'lab bench');
  return g;
}

/**
 * The equipment bank — a full-height cabinet that turns a flat wall into a
 * corner.
 *
 * Deliberately the "bigger sibling" shape the bible wants players to
 * generalise from: a plinth, two louvred door leaves, a centre latch and a vent
 * header. Its doors are SHUT and it is solid in the BVH, so it teaches the
 * silhouette without promising the volume; the enterable member of the family
 * is a hide spot, and the amber dot is the difference.
 */
function equipmentBank(): THREE.BufferGeometry {
  const s = PROP_ARCHETYPES.bank.size;
  const hx = s.x / 2;
  const hy = s.y / 2;
  const hz = s.z / 2;
  const parts: THREE.BufferGeometry[] = [
    p(chamferedBox({ x: s.x, y: s.y, z: s.z }, 0.024, { axis: 'y' }), C.furniture),
    p(at(box({ x: s.x - 0.06, y: 0.09, z: s.z - 0.06 }), 0, -hy + 0.045, 0), C.metal),
    p(
      at(
        facePosX(grille(s.z * 0.8, 0.16, { bars: 3, frame: 0.012, depth: 0.016 })),
        hx - 0.008,
        hy - 0.13,
        0,
      ),
      C.recess,
    ),
  ];
  for (const sign of [1, -1]) {
    const doorY = sign * (hy - 0.30 - 0.26);
    parts.push(
      p(
        at(
          chamferedBox({ x: 0.032, y: 0.5, z: s.z - 0.07 }, 0.018, { axis: 'x' }),
          hx - 0.019,
          doorY,
          0,
        ),
        C.paint,
      ),
      p(
        at(
          facePosX(louvreSlats(s.z * 0.72, 0.42, { slats: 4, frame: 0, depth: 0.02 })),
          hx - 0.006,
          doorY,
          0,
        ),
        C.recess,
      ),
    );
  }
  parts.push(
    p(
      at(
        facePosX(
          latch({ x: 0.10, y: 0.055, z: 0.014 }, { lift: 0.02, barThickness: 0.01 }),
        ),
        hx - 0.012,
        0,
        0,
      ),
      C.frame,
    ),
  );
  parts.push(at(labelPlate(0.12, 0.16, { bars: 3 }), 0, hy - 0.34, hz - 0.005));
  const g = mergeParts(parts);
  assertPolyBudget(g, 'hideShell', 'equipment bank');
  return g;
}

// ===========================================================================
// ISS-PZL-06 · Cargo rack and the five numbered bags
// ===========================================================================

/** Slot centres along the rack, straight out of `stationSpec`'s `cargoStow`. */
const CARGO_SLOT_Z: readonly number[] = [-1.9, -0.95, 0, 0.95, 1.9];

/**
 * Five bays, numbered by band count.
 *
 * The dividers land on the midpoints between the authored slot positions rather
 * than on an even division of the rack, so bay three is genuinely the bay slot
 * three sits in. Each bay carries a `labelPlate` whose bar count is its number
 * — language-free, colourblind-safe, and readable across a module because the
 * bars are extruded rather than drawn.
 */
function cargoRack(): THREE.BufferGeometry {
  const s = PROP_ARCHETYPES['cargo-rack'].size;
  const hx = s.x / 2;
  const hy = s.y / 2;
  const hz = s.z / 2;
  const rail = 0.075;
  const parts: THREE.BufferGeometry[] = [
    p(at(box({ x: s.x, y: 0.03, z: s.z }), 0, -hy + 0.015, 0), C.cargoRack),
  ];
  for (const sign of [1, -1]) {
    parts.push(
      p(
        at(
          chamferedBox({ x: rail, y: s.y, z: s.z }, 0.016, { axis: 'z' }),
          sign * (hx - rail / 2),
          0,
          0,
        ),
        C.frame,
      ),
    );
  }
  const dividers = [-hz, -1.425, -0.475, 0.475, 1.425, hz];
  for (const z of dividers) {
    const inset = Math.abs(z) >= hz ? 0.025 : 0;
    parts.push(
      p(
        at(box({ x: s.x - 2 * rail, y: s.y, z: 0.05 }), 0, 0, z - Math.sign(z) * inset),
        C.cargoRack,
      ),
    );
  }
  for (let i = 0; i < CARGO_SLOT_Z.length; i++) {
    const z = CARGO_SLOT_Z[i] as number;
    parts.push(
      at(faceOut(labelPlate(0.095, 0.13, { bars: i + 1 })), -hx + rail + 0.06, hy - 0.008, z),
    );
    // Retention bar across the bay mouth. 0.5 long, not 0.66: at the two end
    // bays a longer bar reaches past the rack's own end and out of the
    // `box(arch.size)` the BVH holds, which puts steel in the lane that the
    // sweep does not know about.
    parts.push(
      p(at(box({ x: 0.03, y: 0.05, z: 0.5 }), hx - rail - 0.06, hy - 0.035, z), C.metal),
    );
  }
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.cargoRack, 'cargo rack');
  return g;
}

/**
 * One numbered cargo bag. `bars` bands, 1 to 5.
 *
 * It is a Rapier dynamic body in a zero-G module, so the shape has to survive
 * tumbling: a soft-cornered near-cube with its mass where its bounding box is,
 * bands that wrap all the way round (`chamferBand`, 16 triangles apiece) rather
 * than stripes on two faces, and corner patches instead of anything that could
 * read as a fragile protrusion. No colour attribute — `cargo.ts` tints it.
 */
function cargoBag(bars: number): THREE.BufferGeometry {
  const s = PROP_ARCHETYPES['cargo-bag'].size;
  const hx = s.x / 2;
  const hy = s.y / 2;
  const hz = s.z / 2;
  const chamfer = 0.055;
  const parts: THREE.BufferGeometry[] = [
    chamferedBox({ x: s.x, y: s.y, z: s.z }, chamfer, { axis: 'y', capChamfer: 0.05 }),
  ];
  const span = s.y - 2 * 0.05 - 0.06;
  for (let i = 0; i < bars; i++) {
    const y = bars === 1 ? 0 : -span / 2 + (i * span) / (bars - 1);
    parts.push(at(chamferBand(hx * 1.035, hz * 1.035, chamfer, 0.036, 'y'), 0, y, 0));
  }
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      parts.push(
        at(box({ x: 0.10, y: 0.055, z: 0.10 }), sx * (hx - 0.06), hy - 0.035, sz * (hz - 0.06)),
      );
    }
  }
  for (const z of [-hz * 0.55, hz * 0.55]) {
    parts.push(
      webbingStrap(s.x * 1.02, 0.06, { sag: 0.022, segments: 4 }).translate(
        0,
        hy - 0.012,
        z,
      ) as THREE.BufferGeometry,
    );
  }
  parts.push(at(box({ x: 0.13, y: 0.028, z: 0.032 }), 0, hy + 0.012, 0));
  const g = mergeParts(parts);
  assertPolyBudget(g, BUDGETS.cargoBag, `cargo bag ${bars}`);
  return g;
}

// ===========================================================================
// ISS-PRP-05 · Stowage locker — body and its hinged door
// ===========================================================================

export interface LockerParts {
  body: THREE.BufferGeometry;
  door: THREE.BufferGeometry;
}

/**
 * The locker, split the way `lockers.ts` animates it.
 *
 * The contract that file relies on and this one must honour: `body` is centred
 * on the prop origin, and `door` has its HINGE EDGE at the origin and grows
 * along +X, because the pivot group is parked at
 * `(-(size.x - 0.04) / 2, size.y / 2 + 0.02, 0)` and rotates about local Z.
 * With local +X up on a side wall, that makes it a bottom-hinged hatch that
 * swings up and out.
 *
 * The body is a CAVITY — five slabs and two shelves — rather than a solid
 * block, so opening it reveals somewhere for the items to have been. That is
 * the readable open/closed state the bible asks for: the door's angle plus a
 * dark interior with shelf lines in it, not a colour change. Two materials
 * (`locker`, `lockerDoor`) are already assigned by `lockers.ts`, so neither
 * half carries a colour attribute.
 */
export function buildLockerParts(): LockerParts {
  const s = PROP_ARCHETYPES.locker.size;
  const hx = s.x / 2;
  const hy = s.y / 2;
  const hz = s.z / 2;
  const t = 0.03;

  const bodyParts: THREE.BufferGeometry[] = [
    at(box({ x: s.x, y: t, z: s.z }), 0, -hy + t / 2, 0),
  ];
  for (const sign of [1, -1]) {
    bodyParts.push(at(box({ x: t, y: s.y, z: s.z }), sign * (hx - t / 2), 0, 0));
    bodyParts.push(at(box({ x: s.x - 2 * t, y: s.y, z: t }), 0, 0, sign * (hz - t / 2)));
  }
  // Mouth frame: 0.05 of lip all round, which is also where the accent goes.
  const lip = 0.05;
  for (const sign of [1, -1]) {
    bodyParts.push(
      at(box({ x: lip, y: 0.03, z: s.z }), sign * (hx - lip / 2), hy - 0.015, 0),
    );
    bodyParts.push(
      at(
        box({ x: s.x - 2 * lip, y: 0.03, z: lip }),
        0,
        hy - 0.015,
        sign * (hz - lip / 2),
      ),
    );
  }
  for (const sign of [1, -1]) {
    bodyParts.push(at(box({ x: 0.025, y: s.y - 0.1, z: s.z - 2 * t }), sign * 0.115, -0.03, 0));
  }
  bodyParts.push(
    at(facePosX(grille(s.z * 0.8, 0.28, { bars: 2, frame: 0.012, depth: 0.014 })), hx + 0.005, 0, 0),
  );
  bodyParts.push(at(tubeZ(0.014, s.z * 0.78, 6), -hx + 0.012, hy + 0.012, 0));
  const body = mergeParts(bodyParts);

  // Door: hinge edge on the origin, leaf out along +X.
  const leafX = s.x - 0.04;
  const doorParts: THREE.BufferGeometry[] = [
    at(
      chamferedBox({ x: leafX, y: 0.032, z: s.z - 0.04 }, 0.014, { axis: 'y' }),
      leafX / 2,
      0,
      0,
    ),
    at(
      faceOut(louvreSlats(leafX * 0.66, (s.z - 0.04) * 0.6, { slats: 3, frame: 0.012, depth: 0.018 })),
      leafX / 2,
      0.022,
      0,
    ),
    at(faceOut(latch({ x: 0.085, y: 0.085, z: 0.018 }, { lift: 0.028 })), leafX - 0.075, 0.016, 0),
    at(box({ x: 0.06, y: 0.026, z: s.z - 0.06 }), 0.03, 0, 0),
  ];
  const door = mergeParts(doorParts);

  assertPolyBudget(mergeLockerCheck(body, door), BUDGETS.locker, 'stowage locker');
  return { body, door };
}

/** Budget the locker as ONE object, because that is what a player sees. The
 *  clone is thrown away immediately; the two halves stay separate. */
function mergeLockerCheck(
  body: THREE.BufferGeometry,
  door: THREE.BufferGeometry,
): THREE.BufferGeometry {
  return mergeParts([body.clone(), door.clone()]);
}

/** Where the locker's one amber dot lives: the mouth frame, latch side, so it
 *  stays visible with the door swung open. */
const LOCKER_ACCENT_AT: Size3 = Object.freeze({
  x: PROP_ARCHETYPES.locker.size.x / 2 - 0.025,
  y: PROP_ARCHETYPES.locker.size.y / 2 + 0.001,
  z: 0,
});
const OUT_Y: Size3 = Object.freeze({ x: 0, y: 1, z: 0 });

// ===========================================================================
// ISS-PRP-03 · Wall panel housing
// ===========================================================================

export interface PanelParts {
  body: THREE.BufferGeometry;
  screen: THREE.BufferGeometry;
}

/**
 * The panel carcass and the flat face a `CanvasTexture` maps onto (§6).
 *
 * `screen` is untouched from r2 on purpose: `puzzleProps.ts` derives
 * `SCREEN_ACROSS`, `SCREEN_UP` and `SCREEN_Z` from these exact expressions, and
 * every §11 readout is laid out against them. The bezel's aperture is sized to
 * clear that plane rather than the other way round.
 *
 * The body is the bible's "dullest asset here — it exists to be ignored", and
 * it never glows: `materials.panel` has no emissive and the lit rectangle is
 * the screen's own `panelScreen`. Note that `puzzleProps.panelShellGeometry`
 * supersedes this body once the fixtures are wired in; the two agree on the
 * plate outline and the screen plane, so either can draw first.
 */
export function buildPanelParts(): PanelParts {
  const s = PROP_ARCHETYPES.panel.size;
  const hx = s.x / 2;
  const hz = s.z / 2;
  const faceY = s.y / 2;
  const parts: THREE.BufferGeometry[] = [
    at(chamferedBox({ x: s.x, y: s.y * 0.9, z: s.z }, 0.014, { axis: 'z' }), 0, -0.003, 0),
  ];
  // Bezel rim, standing 0.014 proud of the canvas face so the rim throws a hard
  // shadow line across the readout at any grazing angle.
  const apX = (s.x * 0.86) / 2 + 0.014;
  const apZ = (s.z * 0.82) / 2 + 0.013;
  const rimY = faceY + 0.004;
  for (const sign of [1, -1]) {
    parts.push(at(box({ x: hx - apX, y: 0.02, z: s.z }), sign * (hx + apX) / 2, rimY, 0));
    parts.push(at(box({ x: apX * 2, y: 0.02, z: hz - apZ }), 0, rimY, sign * (hz + apZ) / 2));
  }
  const gland = tubeY(0.022, 0.07, 5);
  parts.push(at(gland, -hx - 0.005, 0, hz * 0.55));
  const body = mergeParts(parts);
  assertPolyBudget(body, BUDGETS.panel, 'wall panel housing');

  const screen = new THREE.PlaneGeometry(s.x * 0.86, s.z * 0.82);
  // The plane faces +Z by default; rotate it to face +Y (into the room).
  screen.rotateX(-Math.PI / 2);
  screen.translate(0, s.y / 2 + 0.005, 0);
  return { body, screen };
}

// ===========================================================================
// The dispatch
// ===========================================================================

/** How many `InstancedMesh` variants a kind ships. 1 unless stated. */
export const PROP_VARIANTS: Readonly<Partial<Record<PropKind, number>>> = Object.freeze({
  rack: 3,
  cable: 2,
});

/** Variants a kind ships, defaulting to one. */
export function propVariantCount(kind: PropKind): number {
  return PROP_VARIANTS[kind] ?? 1;
}

/**
 * Unit archetype geometry for one prop kind, in the prop's own local frame.
 *
 * `variant` picks between the silhouettes a kind ships (see `PROP_VARIANTS`);
 * for `slot` and `cargo-bag` it is the bay NUMBER minus one, because those two
 * are numbered by band count and `cargo.ts` builds one mesh per number.
 */
export function buildPropGeometry(kind: PropKind, variant = 0): THREE.BufferGeometry {
  switch (kind) {
    case 'rack':
      return variant === 1 ? rackVented() : variant === 2 ? rackInstrumented() : rackBlank();
    case 'cable':
      return variant === 1 ? cableConduit() : cableBundle();
    case 'stowage':
      return stowageBag();
    case 'laptop':
      return crewLaptop();
    case 'slot':
      return cargoSlot(clampBars(variant + 1));
    case 'hub':
      return junctionHub();
    case 'bulkhead':
      return partialBulkhead();
    case 'bench':
      return labBench();
    case 'bank':
      return equipmentBank();
    case 'cargo-rack':
      return cargoRack();
    case 'cargo-bag':
      return cargoBag(clampBars(variant + 1));
    case 'locker': {
      const parts = buildLockerParts();
      return mergeParts([parts.body, parts.door]);
    }
    case 'panel': {
      const parts = buildPanelParts();
      parts.screen.dispose();
      return parts.body;
    }
    default:
      // `PropKind` is exhaustive above; this is the runtime guard for a level
      // file that names a kind this build does not have.
      return box({ x: 0.2, y: 0.2, z: 0.2 });
  }
}

function clampBars(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)));
}

/** One numbered cargo bag's geometry. `number` is 1…5. Fresh each call — the
 *  caller owns it. */
export function cargoBagGeometry(number: number): THREE.BufferGeometry {
  return cargoBag(clampBars(number));
}

/** One numbered cargo slot's geometry. `number` is 1…5. Fresh each call. */
export function cargoSlotGeometry(number: number): THREE.BufferGeometry {
  return cargoSlot(clampBars(number));
}

// ===========================================================================
// Accents — one draw call for every amber dot in the station
// ===========================================================================

/** Where a cargo slot's dot sits: on the lip above the chevron. */
const SLOT_ACCENT_AT: Size3 = Object.freeze({
  x: PROP_ARCHETYPES.slot.size.x / 2 - 0.0175,
  y: PROP_ARCHETYPES.slot.size.y / 2 + 0.034,
  z: 0,
});

/**
 * A hide spot's dot, on the lintel over its mouth.
 *
 * Hiding is a real mechanic now and the alien is blind, so finding a spot in
 * the dark while something walks toward you is the whole verb — which makes
 * `interact: 'hide-spot'` exactly what the accent convention is for. The shell
 * `geometry.ts` builds around the volume overhangs it by `HIDE_SHELL_T`, so the
 * lamp goes that far out along the spot's `lookDir` (which points from the
 * volume toward the entry point) and up onto the top edge.
 */
function hideSpotAccent(module: StationModule, spot: HideSpot): AccentPlacement | null {
  // `lookDir` is optional and defaults to "face `entryPos` from `localPos`",
  // which is the same fallback `buildHideSpotShell` uses to decide which face
  // of the shell to leave open. Same rule, same mouth.
  const look = spot.lookDir
    ? new THREE.Vector3(spot.lookDir.x, spot.lookDir.y, spot.lookDir.z)
    : new THREE.Vector3(
        spot.entryPos.x - spot.localPos.x,
        spot.entryPos.y - spot.localPos.y,
        spot.entryPos.z - spot.localPos.z,
      );
  if (look.lengthSq() < 1e-9) return null;
  look.normalize();
  const half = new THREE.Vector3(
    Math.abs(spot.halfExtents.x),
    Math.abs(spot.halfExtents.y),
    Math.abs(spot.halfExtents.z),
  );
  // Reach along `lookDir` to the outside of the shell, then up to the lintel.
  const reach =
    Math.abs(look.x) * half.x + Math.abs(look.y) * half.y + Math.abs(look.z) * half.z;
  const local = new THREE.Vector3(spot.localPos.x, spot.localPos.y, spot.localPos.z).add(
    look.clone().multiplyScalar(reach + HIDE_SHELL_T + 0.004),
  );
  // Only lift onto the lintel when the mouth is a side face; a spot entered
  // from above has no lintel and the dot belongs in the middle of the opening.
  if (Math.abs(look.y) < 0.7) local.y += half.y + HIDE_SHELL_T * 0.5;

  const spotLocal = new THREE.Matrix4();
  if (spot.localQuat) {
    spotLocal.makeRotationFromQuaternion(
      new THREE.Quaternion(spot.localQuat.x, spot.localQuat.y, spot.localQuat.z, spot.localQuat.w),
    );
    local.applyMatrix4(spotLocal);
  }
  return {
    module: module.id,
    interact: 'hide-spot',
    matrix: accentMatrix(
      { x: local.x, y: local.y, z: local.z },
      { x: look.x, y: look.y, z: look.z },
      moduleMatrix(module),
    ),
  };
}

interface AccentIndex {
  readonly placements: AccentPlacement[];
  /** Hide spot id → its index in `placements`, so its lamp can be suppressed
   *  while somebody is inside (see `StationProps.setHideSpotOccupied`). */
  readonly hideSpots: Map<string, number>;
}

/** Every amber placement in the level, from every source. */
function collectAccents(layout: StationLayout): AccentIndex {
  const placements: AccentPlacement[] = [];
  const hideSpots = new Map<string, number>();
  for (const module of layout.modules) {
    for (const prop of module.props) {
      if (prop.kind === 'locker') {
        placements.push({
          module: module.id,
          interact: 'locker',
          matrix: accentMatrix(LOCKER_ACCENT_AT, OUT_Y, propWorldMatrix(module, prop)),
        });
      } else if (prop.kind === 'slot') {
        placements.push({
          module: module.id,
          interact: 'cargo-slot',
          matrix: accentMatrix(SLOT_ACCENT_AT, OUT_Y, propWorldMatrix(module, prop)),
        });
      }
    }
    for (const spot of module.hideSpots ?? []) {
      const placement = hideSpotAccent(module, spot);
      if (!placement) continue;
      hideSpots.set(spot.id, placements.length);
      placements.push(placement);
    }
  }
  return { placements, hideSpots };
}

// ===========================================================================
// The meshes
// ===========================================================================

/**
 * Kinds that render from here.
 *
 * `slot` and `cargo-bag` are not on the list and that is deliberate: they are
 * numbered one to five and tinted to match, and one `InstancedMesh` has one
 * material and one geometry, so `cargo.ts` owns both halves of that pairing.
 * `locker` and `panel` animate and carry per-instance state, so `lockers.ts`
 * and `panels.ts` give them their own meshes. All four still get their geometry
 * from this file.
 */
const INSTANCED_KINDS: readonly PropKind[] = Object.freeze([
  'rack',
  'cable',
  'stowage',
  'laptop',
  'hub',
  'bulkhead',
  'bench',
  'bank',
  'cargo-rack',
]);

export class StationProps {
  readonly group = new THREE.Group();
  /** Amber dots for every locker, cargo slot and hide spot — one draw call. */
  readonly accents: InstancedSet | null;
  private readonly sets: InstancedSet[] = [];
  private readonly hideSpotAccentIndex: ReadonlyMap<string, number>;

  constructor(layout: StationLayout, materials: StationMaterials) {
    this.group.name = 'station-props';

    // kind → variant → entries. A variant with no instances is never built.
    const byKind = new Map<PropKind, InstanceEntry[][]>();
    for (const kind of INSTANCED_KINDS) {
      const variants: InstanceEntry[][] = [];
      for (let v = 0; v < propVariantCount(kind); v++) variants.push([]);
      byKind.set(kind, variants);
    }

    const unknown = new Set<string>();
    for (const module of layout.modules) {
      for (const prop of module.props) {
        const arch = propArchetype(prop.kind);
        if (!arch) {
          unknown.add(prop.kind);
          continue;
        }
        if (!arch.instanced) continue; // lockers, panels, cargo bags
        const variants = byKind.get(prop.kind as PropKind);
        if (!variants) continue;
        // Hash the authored id, so the pattern is identical every run and two
        // props whose ids differ in the last character land in different
        // buckets — which is the case that matters, because that is what
        // `tubeRacks` and `tubeCables` generate down one wall.
        const v = variantIndex(prop.id, variants.length);
        (variants[v] as InstanceEntry[]).push({
          module: module.id,
          matrix: propWorldMatrix(module, prop),
        });
      }
    }
    if (unknown.size > 0) {
      console.warn(`station: no prop archetype for ${[...unknown].join(', ')} — not rendered`);
    }

    for (const kind of INSTANCED_KINDS) {
      const variants = byKind.get(kind) as InstanceEntry[][];
      const material = materialFor(materials, kind);
      for (let v = 0; v < variants.length; v++) {
        const entries = variants[v] as InstanceEntry[];
        if (entries.length === 0) continue;
        const name = variants.length > 1 ? `props-${kind}-${v}` : `props-${kind}`;
        const set = new InstancedSet(buildPropGeometry(kind, v), material, entries, name);
        this.sets.push(set);
        this.group.add(set.mesh);
      }
    }

    const index = collectAccents(layout);
    this.hideSpotAccentIndex = index.hideSpots;
    this.accents = index.placements.length
      ? buildAccentInstances(materials, index.placements, {
          shape: 'dot',
          name: 'props-accents',
        })
      : null;
    if (this.accents) {
      this.sets.push(this.accents);
      this.group.add(this.accents.mesh);
    }

    assertScatterInert(this.sets, this.accents);
  }

  /** Draw calls this subsystem can submit, i.e. every mesh it owns. */
  get meshCount(): number {
    return this.sets.length;
  }

  /**
   * Show a hide spot as taken, by putting its lamp out.
   *
   * The bible wants an occupied/empty state a TEAMMATE can read, and this is
   * the only version of it that survives the constraints: the alien is blind so
   * there is no sight logic to hang it on, the spot's shell is one instanced
   * mesh so its geometry cannot change per instance, and a second lamp colour
   * would be a second draw call and a second meaning for a channel that only
   * has one. A dot that is lit means you can get in; a dot that has gone out
   * means somebody already did.
   *
   * Wire it to whatever owns hide state — `StationRoom.onHide` / the local
   * `HideController`. Returns false if `spotId` has no lamp, so a caller can
   * tell a typo from a no-op.
   */
  setHideSpotOccupied(spotId: string, occupied: boolean): boolean {
    const index = this.hideSpotAccentIndex.get(spotId);
    if (index === undefined || !this.accents) return false;
    this.accents.setInstanceHidden(index, occupied);
    return true;
  }

  /** True while `spotId`'s lamp is out. */
  hideSpotOccupied(spotId: string): boolean {
    const index = this.hideSpotAccentIndex.get(spotId);
    if (index === undefined || !this.accents) return false;
    return this.accents.isInstanceHidden(index);
  }

  setVisible(visible: ReadonlySet<ModuleId>): void {
    for (const set of this.sets) set.setVisible(visible);
  }

  dispose(): void {
    for (const set of this.sets) {
      this.group.remove(set.mesh);
      set.dispose();
    }
    this.sets.length = 0;
  }
}

/**
 * `assertInert`, for a subsystem whose assets are `InstancedMesh`es.
 *
 * `artKit.assertInert` walks an `Object3D` subtree, which is the right shape for
 * a hero asset built as a group and the wrong one here: a scatter kind is one
 * mesh with one material and no children, so the question is not "does the
 * subtree contain an accent" but "is this kind's material self-lit at all". Six
 * agents share one palette; the cheap failure mode is somebody widening a
 * palette entry's emissive for one asset and quietly lighting up 38 cable runs.
 *
 * The one sanctioned exception is `props-laptop` (see `crewLaptop`). The accent
 * set is expected to glow — it is the accent — and is checked the other way
 * round, because an accent that stopped being self-lit would be worse than one
 * that never existed.
 */
function assertScatterInert(sets: readonly InstancedSet[], accents: InstancedSet | null): void {
  if (!isDev()) return;
  const failures: string[] = [];
  for (const set of sets) {
    if (set === accents) continue;
    const m = set.mesh.material as THREE.MeshStandardMaterial;
    const lit =
      (m.emissive && m.emissive.getHex() !== 0 && (m.emissiveIntensity ?? 0) > 0) ||
      m.toneMapped === false;
    if (lit && set.mesh.name !== 'props-laptop') {
      failures.push(
        `${set.mesh.name} is self-lit (emissive #${m.emissive.getHex().toString(16)} @ ` +
          `${m.emissiveIntensity}, toneMapped ${m.toneMapped}) but nothing in it is ` +
          `interactable — amber means "you can touch this", and one false positive ` +
          `devalues every true one`,
      );
    }
  }
  if (accents) {
    const m = accents.mesh.material as THREE.MeshStandardMaterial;
    if (m.emissive.getHex() === 0 || (m.emissiveIntensity ?? 0) <= 0) {
      failures.push('props-accents is not self-lit — the interactable cue is invisible');
    }
  }
  if (failures.length > 0) {
    throw new Error(`station props: emissive discipline broken:\n  - ${failures.join('\n  - ')}`);
  }
}

function isDev(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env && typeof env.DEV === 'boolean') return env.DEV;
  } catch {
    /* absent under plain Node — fall through. */
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc && proc.env) return proc.env.NODE_ENV !== 'production';
  return true;
}

export function materialFor(materials: StationMaterials, kind: PropKind): THREE.Material {
  switch (kind) {
    // The laptop keeps its own faintly emissive material (see `crewLaptop`).
    case 'laptop':
      return materials.laptop;
    // Owned elsewhere; listed so this function stays a complete map of the
    // kinds rather than a map of the ones that happen to instance here.
    case 'slot':
      return materials.slot;
    case 'locker':
      return materials.locker;
    case 'panel':
      return materials.panel;
    case 'cargo-bag':
      return materials.stowage;
    // Everything else rides the palette's one vertex-coloured program, which is
    // what pays for the racks' vents, the bulkhead's hazard band and the cargo
    // rack's five bay numbers at zero extra draw calls.
    case 'rack':
    case 'cable':
    case 'stowage':
    case 'hub':
    case 'bulkhead':
    case 'bench':
    case 'bank':
    case 'cargo-rack':
      return materials.vertexPainted;
    default:
      return materials.vertexPainted;
  }
}
