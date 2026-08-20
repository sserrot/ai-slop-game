/**
 * The three.js half of the kit (DESIGN.md §2, §9; asset bible ISS-STR-01..07,
 * ISS-GRV-09, ISS-GRV-10, ISS-GRV-11).
 *
 * Everything here is built from three.js primitives and returned in MODULE
 * space; `loader.ts` merges each list into one mesh per material per module, so
 * a module costs a handful of draw calls and can be hidden wholesale by the
 * two-hop portal culler.
 *
 * Geometry is split by the material it wants:
 *   hull      interior wall surfaces, rendered BackSide (you are always inside)
 *   trim      ring frames, coves, raceways, overhead runs, bulkheads, endcaps
 *             and window frames — everything structural, rendered DoubleSide
 *   glass     cupola panes
 *   strips    emissive light strips, one material per module so `setLighting`
 *             can change a single module's mood
 *   deck      the walking surface (`deckKit` owns every dimension of it)
 *   deckEdge  emissive deck rim, one material per module so gravity state shows
 *   collision position-only triangles fed to the station-wide MeshBVH (§1)
 *
 * THE ART PASS, AND THE ONE RULE IT OBEYS
 * ---------------------------------------
 * The bible's verdict on this family was "all blob", and the budget explains
 * why: a straight was a 48-triangle tube with two rings in it — 900 under its
 * own floor — while the endcap on a port nobody can pass through was 366
 * triangles of dome and torus, fifteen times over. The station was spending
 * 5,500 triangles on dead ends and nothing on the nine rooms people stand in.
 *
 * So this pass moves the budget rather than growing it. `blankCap` is a third of
 * the old endcap, rings are a flange plus a web instead of a torus, and what
 * that frees pays for ring frames, shielded lighting coves, cable raceways and
 * an overhead run: the things that give a corridor a rhythm now that players
 * WALK down it and look up (§4 r3).
 *
 * **Interior detailing is never collision.** The BVH gets the bare bore, the
 * bulkheads, the deck, the solid props and the hide shells, exactly as before.
 * A rib standing 7.5 cm off the hull is well outside the walking envelope, but
 * `walkable.ts` proves a module walkable by planting a `PLAYER_RADIUS` collider
 * tangent to the deck — so anything more than about a centimetre proud of the
 * floor inside a doorway fails the level build outright, and a rib at the wall
 * would delete a strip of walkable deck at every frame station. Detail you can
 * walk through is the price of having detail at all, and it is the right trade:
 * none of it is anywhere a body can reach.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  DECK_Y_M,
  PLAYER_RADIUS,
  PLAYER_STAND_HEIGHT_M,
  STEP_HEIGHT_M,
} from '@shared/constants';
import type { HideSpot, Port, PropRef, StationModule, Vec3 } from '@shared/types';
import {
  COVE_D,
  COVE_LIP,
  COVE_W,
  CUPOLA_COLLAR_R,
  KIT,
  NODE_CHASE_R,
  NODE_CORNER_ANGLES,
  PORT_RADIUS,
  RAIL_RADIUS,
  coveSign,
  propArchetype,
} from './kit';
import type { KitPiece } from './kit';
import {
  DOORWAY_HALF_W,
  DOORWAY_SILL,
  DOORWAY_TOP,
  HIDE_SHELL_T,
  deckHalfWidth,
} from './deckKit';
import type { DeckDef } from './deckKit';
import { HAZARD_DARK, HAZARD_YELLOW } from './materials';
import { checkPolyBudget, hazardStripeBand, withVertexColor } from './artKit';

const RADIAL_SEGMENTS = 24;
const DOME_SEGMENTS = 16;

/**
 * Ring frames, port collars, window frames and the hatch wheel are all rings,
 * and a ring is the easiest place in a kit to lose a thousand triangles by
 * accident: a `TorusGeometry` costs `radial × tubular × 2`, so this kit's
 * original 8 × 24 port rim was 384 triangles of decorative doughnut on every
 * capped port and twice per hatch frame. Nothing at 5 candela reads the
 * difference between a torus and a machined flange, and a flange is what the
 * real thing is — so every ring here is a flat annulus plus a short band, which
 * is 4 triangles per segment instead of 16 and has a squarer, more legible
 * silhouette in a torch beam.
 */
const RIB_SEGMENTS = 20;
/** Samples across the half-width of a doorway outline. 12 is smooth at 0.7 m. */
const DOORWAY_SEGMENTS = 12;
/** Coarser sampling for hatch hardware, which is one geometry instanced nine
 *  times — every triangle in it is paid for at every doorway in the station. */
const DOORWAY_FRAME_SEGMENTS = 5;

/** How far a ring frame stands proud of the hull, inward. */
const RIB_DEPTH = 0.075;
/** A ring frame's width along the module axis. */
const RIB_W = 0.05;

/** Cable raceway (ISS-STR-01 "cable raceways"): tray width and rail height. */
const TRAY_W = 0.17;
const TRAY_D = 0.055;

export interface ShellGeometry {
  hull: THREE.BufferGeometry[];
  trim: THREE.BufferGeometry[];
  glass: THREE.BufferGeometry[];
  strips: THREE.BufferGeometry[];
  /** Walking surface — its own material, so a floor reads as a floor (§9). */
  deck: THREE.BufferGeometry[];
  /** Emissive rim along the deck. Gets a per-module material so gravity state
   *  can be shown by recolouring it (§4 gravity failure). */
  deckEdge: THREE.BufferGeometry[];
  /** Hide spot shells (§4): solid, and open on the face you get in through. */
  hideShells: THREE.BufferGeometry[];
  collision: THREE.BufferGeometry[];
}

function emptyShell(): ShellGeometry {
  return {
    hull: [],
    trim: [],
    glass: [],
    strips: [],
    deck: [],
    deckEdge: [],
    hideShells: [],
    collision: [],
  };
}

// ---------------------------------------------------------------------------
// Primitive helpers — all in module space, all axis conventions from kit.ts
// ---------------------------------------------------------------------------

function vec(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z);
}

/** Open-ended tube whose axis runs along local +Z. */
function tube(radius: number, length: number, segments = RADIAL_SEGMENTS): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, segments, 1, true);
  g.rotateX(Math.PI / 2);
  return g;
}

function box(size: Vec3): THREE.BufferGeometry {
  return new THREE.BoxGeometry(size.x, size.y, size.z);
}

/** A box placed by its centre. The workhorse of every fitting below. */
function boxAt(size: Vec3, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(size.x, size.y, size.z);
  g.translate(x, y, z);
  return g;
}

function solidDisc(radius: number, segments = RADIAL_SEGMENTS): THREE.BufferGeometry {
  return new THREE.CircleGeometry(radius, segments);
}

/**
 * Flat annulus in the XY plane facing +Z, optionally a sector. `thetaStart` and
 * `thetaLength` use the convention everything else here does: radians about +Z,
 * zero on +X, counter-clockwise.
 */
function ringArc(
  inner: number,
  outer: number,
  thetaStart = 0,
  thetaLength = Math.PI * 2,
  segments = RIB_SEGMENTS,
): THREE.BufferGeometry {
  return new THREE.RingGeometry(inner, outer, segments, 1, thetaStart, thetaLength);
}

/**
 * Open cylindrical band about +Z, optionally a sector.
 *
 * `CylinderGeometry` measures theta from +Z toward +X about its own +Y axis, so
 * after the `rotateX(π/2)` that stands it up along +Z a vertex at cylinder angle
 * θ lands at planar angle θ − π/2. Hence the offset — get it wrong and every rib
 * sector ends up a quarter turn from the flange it belongs to.
 */
function bandArc(
  radius: number,
  width: number,
  thetaStart = 0,
  thetaLength = Math.PI * 2,
  segments = RIB_SEGMENTS,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(
    radius,
    radius,
    width,
    segments,
    1,
    true,
    thetaStart + Math.PI / 2,
    thetaLength,
  );
  g.rotateX(Math.PI / 2);
  return g;
}

/**
 * Move geometry built in a WALL FRAME onto the hull at `angle`.
 *
 * In the wall frame: +X is tangential (counter-clockwise), **+Y is inward**
 * (toward the module axis, so a fitting's depth is its Y size and y = 0 is flush
 * with the hull), +Z is the module axis. Every cove, tray and corner chase below
 * is authored that way and placed with this, which is what keeps their
 * cross-sections readable as cross-sections.
 */
function wallPlace(g: THREE.BufferGeometry, radius: number, angle: number): THREE.BufferGeometry {
  g.rotateZ(angle + Math.PI / 2);
  g.translate(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
  return g;
}

// ---------------------------------------------------------------------------
// The hatch opening — a circle in r2, a DOORWAY since the pivot
// ---------------------------------------------------------------------------
//
// `PORT_RADIUS` is 0.7, which was a 0.35 m clearance all round when the body WAS
// a 0.35 m sphere. The pivot made it a 1.7 m capsule standing on a deck at
// `DECK_Y_M`, and a circle of radius 0.7 about the module axis is then 1.30 m of
// clear height against a 1.70 m body: a walking player could not leave the room
// they woke up in, and every validator was blind to it because each checks
// reachability WITHIN a module.
//
// No circle fixes it (R ≥ 1.0 — the whole bore — to pass a standing capsule
// anywhere off-axis), so the opening is the union of the old round hole and a
// doorway cut down to the deck. It reads as a hatch from the side and as a door
// from in front, every dimension comes from §14 rather than from taste, and the
// SAME path is used for the visible bulkhead and for the collision triangles —
// what you can see through is what you can walk through.
//
// What does NOT change: a closed or sealed hatch still blocks. That is the
// blocker disc in `collision.ts` / `hatchBarrier.ts` (radius `PORT_RADIUS`), not
// the bulkhead.

/**
 * The opening's top and bottom edge at one x, or null outside it.
 *
 * `inflate` grows the whole outline outward (the hatch frame's raised collar),
 * and `clampR` trims it to a bore — which is not a nicety. The doorway's own
 * upper corners sit at (±0.42, 0.96), i.e. 1.048 m from the axis, so in a 1.0 m
 * straight the hole is WIDER THAN THE TUBE at head height and the bulkhead was
 * being handed a self-intersecting polygon to triangulate. Clamping shaves the
 * corner against the hull, which is what a real cut does, and it cannot reach
 * the walking envelope: the standing collider's top sphere is 8 cm clear of the
 * slot edge at every height the clamp touches.
 */
function doorwayEdges(
  x: number,
  inflate: number,
  clampR: number,
): { top: number; bottom: number } | null {
  const r = PORT_RADIUS + inflate;
  const halfW = DOORWAY_HALF_W + inflate;
  if (Math.abs(x) > Math.max(r, halfW)) return null;
  const circle = Math.abs(x) <= r ? Math.sqrt(Math.max(0, r * r - x * x)) : -Infinity;
  const inSlot = Math.abs(x) <= halfW;
  let top = Math.max(circle, inSlot ? DOORWAY_TOP + inflate : -Infinity);
  let bottom = Math.min(inSlot ? DOORWAY_SILL - inflate : Infinity, -circle);
  if (Number.isFinite(clampR)) {
    const lid = Math.sqrt(Math.max(0, clampR * clampR - x * x));
    top = Math.min(top, lid);
    bottom = Math.max(bottom, -lid);
  }
  if (!(top > bottom)) return null;
  return { top, bottom };
}

/**
 * The outline of one port's opening, as a closed counter-clockwise polygon.
 *
 * Both regions are a single y-interval at every x, so their union is too, which
 * is why this can be a simple closed polygon: walk the upper boundary left to
 * right, then the lower boundary back.
 */
function doorwayOutline(
  inflate = 0,
  clampR = Number.POSITIVE_INFINITY,
  segments = DOORWAY_SEGMENTS,
): THREE.Vector2[] {
  const widest = Math.max(PORT_RADIUS, DOORWAY_HALF_W) + inflate;
  const limit = Math.min(widest, Number.isFinite(clampR) ? clampR - 1e-4 : widest);
  const xs: number[] = [];
  const steps = segments * 2;
  for (let i = 0; i <= steps; i++) xs.push(-limit + (2 * limit * i) / steps);
  // Force a sample either side of each slot edge so the corner stays square
  // rather than being chamfered by wherever the sampling happened to land.
  for (const edge of [-(DOORWAY_HALF_W + inflate), DOORWAY_HALF_W + inflate]) {
    if (Math.abs(edge) < limit) xs.push(edge - 1e-4, edge + 1e-4);
  }
  xs.sort((a, b) => a - b);

  const top: THREE.Vector2[] = [];
  const bottom: THREE.Vector2[] = [];
  for (const x of xs) {
    const e = doorwayEdges(x, inflate, clampR);
    if (!e) continue;
    top.push(new THREE.Vector2(x, e.top));
    bottom.push(new THREE.Vector2(x, e.bottom));
  }
  bottom.reverse();
  return [...top, ...bottom];
}

/** The hole punched through a bulkhead at one port. An UNLINKED port keeps the
 *  round hole: an endcap closes it, and a doorway there would open the module to
 *  space around the cap. */
function portHolePath(linked: boolean, clampR = Number.POSITIVE_INFINITY): THREE.Path {
  const path = new THREE.Path();
  if (!linked) {
    path.absarc(0, 0, PORT_RADIUS, 0, Math.PI * 2, true);
    return path;
  }
  path.setFromPoints(doorwayOutline(0, clampR));
  path.closePath();
  return path;
}

/**
 * Bulkhead: the wall between `outer` and the hole in the middle of it.
 *
 * A plain `RingGeometry` when the hole is round; a shape when it is a linked
 * port's doorway, because no ring can express that union. `outer` doubles as the
 * clamp radius, so the hole can never be cut wider than the plate it is cut in.
 */
function annulus(inner: number, outer: number, linked = false): THREE.BufferGeometry {
  if (!linked) {
    return new THREE.RingGeometry(inner, outer, RADIAL_SEGMENTS, 1);
  }
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  shape.holes.push(portHolePath(true, outer));
  return new THREE.ShapeGeometry(shape, RADIAL_SEGMENTS);
}

/** A flat square face with the hatch opening punched out of its middle. */
function faceWithHole(half: number, linked: boolean): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-half, -half);
  shape.lineTo(half, -half);
  shape.lineTo(half, half);
  shape.lineTo(-half, half);
  shape.closePath();
  shape.holes.push(portHolePath(linked));
  return new THREE.ShapeGeometry(shape, RADIAL_SEGMENTS);
}

/** Move a geometry so its local +Z lands on the port's outward normal. */
function toPort(g: THREE.BufferGeometry, port: Port): THREE.BufferGeometry {
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    vec(port.localDir).normalize(),
  );
  g.applyQuaternion(q);
  g.translate(port.localPos.x, port.localPos.y, port.localPos.z);
  return g;
}

// ---------------------------------------------------------------------------
// Port hardware
// ---------------------------------------------------------------------------

/** A machined collar: a flange with a short band behind it. 80 triangles where
 *  the torus it replaces was 240, and it reads as a pressure fitting rather than
 *  as a doughnut. */
function portCollar(radius: number, reach = 0.055, width = 0.06): THREE.BufferGeometry {
  const flange = ringArc(radius, radius + reach);
  flange.translate(0, 0, width / 2);
  const band = bandArc(radius + reach, width);
  return mergeGeometries([flange, band], false);
}

/**
 * The kit's fifth piece: the blank that closes a port nothing links to.
 *
 * §2 calls the endcap a kit piece rather than a module kind, and there are
 * FIFTEEN of them in the shipped level — three or four per node. At the old 366
 * triangles (a 14 × 5 dome plus an 8 × 24 torus) that was 5,500 triangles spent
 * on the one thing in the station guaranteed to be a dead end. This is 120: a
 * shallow welded dome, a collar, and a centre boss to give the profile something
 * to catch the torch on.
 */
function blankCap(radius = PORT_RADIUS): THREE.BufferGeometry {
  const dome = new THREE.SphereGeometry(radius, 12, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateX(Math.PI / 2);
  dome.scale(1, 1, 0.42);
  const collar = portCollar(radius, 0.05, 0.05);
  const boss = new THREE.CylinderGeometry(0.09, 0.11, 0.07, 8, 1);
  boss.rotateX(Math.PI / 2);
  boss.translate(0, 0, radius * 0.42 - 0.01);
  return mergeGeometries([dome, collar, boss], false);
}

/**
 * The blank behind an OUTER port (ISS-STR-04): vacuum is on the other side.
 *
 * Flat and armoured rather than domed, because `hatches.ts` builds the heavy
 * outer door on top of it and a dome would push through the door's face. The
 * threat reading is that door's job; this is the pressure plate it seals
 * against, and it is what keeps the port solid in the BVH.
 */
function outerBlank(radius = PORT_RADIUS): THREE.BufferGeometry {
  const plate = solidDisc(radius + 0.02, 20);
  plate.translate(0, 0, 0.055);
  const rim = bandArc(radius + 0.02, 0.055, 0, Math.PI * 2, 20);
  rim.translate(0, 0, 0.0275);
  const collar = portCollar(radius + 0.02, 0.07, 0.05);
  return mergeGeometries([plate, rim, collar], false);
}

/** Unlinked port → blank (visible, and solid in the BVH).
 *  Linked port → nothing here; the shared hatch assembly owns the collar. */
function capPort(shell: ShellGeometry, port: Port, outer: boolean): void {
  if (port.link) return;
  shell.trim.push(toPort(outer ? outerBlank() : blankCap(), port));
  shell.collision.push(toPort(solidDisc(PORT_RADIUS), port));
}

// ---------------------------------------------------------------------------
// The interior kit (ISS-STR-01, ISS-STR-07, ISS-GRV-11)
// ---------------------------------------------------------------------------

/**
 * How close to the module axis a fitting at wall `angle` may come, in a module
 * with a deck. The whole interior kit is sized by this rather than by eye.
 *
 * §2's deck handshake is explicit that `DECK_HEADROOM_M` (1.75 m) leaves a 1.70 m
 * standing collider **5 cm** of clear air and that those 5 cm are deliberate. In
 * a 1.0 m straight that is the entire ceiling budget: the hull at the crown is
 * 0.40 m from the standing capsule's top sphere centre against a 0.35 m radius,
 * so a rib 7.5 cm deep at the crown is 2.5 cm INSIDE a walking player's head.
 * (Measured: it was, at every frame station in both straights.)
 *
 * Off the crown it opens up fast — a fitting at 60° may be 21 cm deep, at 45°
 * 36 cm — which is why the coves, trays and services all live in the upper
 * quadrants and the crown carries only a strap. Returns the smallest radius a
 * fitting may reach to; `Infinity` in for a module with no floor, where there is
 * no walking envelope to protect.
 */
function hullClearance(angle: number): number {
  const bottom = DECK_Y_M + PLAYER_RADIUS;
  const top = DECK_Y_M + PLAYER_STAND_HEIGHT_M - PLAYER_RADIUS;
  const cx = Math.cos(angle);
  const cy = Math.sin(angle);
  // Monotonic in t, so a short bisection is exact enough and cannot be wrong
  // about which branch of the capsule is nearest.
  const distance = (t: number): number => {
    const y = t * cy;
    const clamped = Math.min(top, Math.max(bottom, y));
    return Math.hypot(t * cx, y - clamped);
  };
  let lo = 0;
  let hi = 4;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (distance(mid) < PLAYER_RADIUS) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Deepest a fitting spanning `width` tangentially at `angle` may be. */
function fittingDepth(
  radius: number,
  angle: number,
  width: number,
  want: number,
  hasDeck: boolean,
): number {
  if (!hasDeck) return want;
  let limit = Infinity;
  const halfSpan = width / (2 * radius);
  for (let i = 0; i <= 4; i++) {
    const a = angle - halfSpan + (halfSpan * 2 * i) / 4;
    limit = Math.min(limit, radius - hullClearance(a) - 0.012);
  }
  return Math.max(0.018, Math.min(want, limit));
}

/**
 * A ring frame (ISS-STR-01: "ring frames at intervals give length a rhythm").
 *
 * Flange plus web, 80 triangles, standing `RIB_DEPTH` proud of the hull —
 * except over the walkway, where it TAPERS to whatever `hullClearance` allows.
 * That notch is not a compromise, it is what a real ring frame does: the deep
 * section is out where the racks are and it thins where heads go. Uniformly
 * shallow would have been the lazy fix and would have cost the rib its profile
 * in the only place a torch beam rakes across it.
 *
 * In a module with a deck the arc also STOPS at the deck edge on both sides
 * rather than running through the floor — a full ring in a gravity module lays a
 * rib across the walkway at ankle height, which is wrong and reads as a bug. In
 * a zero module there is no floor and no head height, and it closes.
 */
function ringFrame(radius: number, z: number, deckHalf: number | null): THREE.BufferGeometry {
  let start = 0;
  let length = Math.PI * 2;
  if (deckHalf !== null && deckHalf < radius) {
    // Angle of the deck edge about +Z. `DECK_Y_M` is negative, so this is the
    // clockwise-from-+X edge; the arc runs from there counter-clockwise over the
    // crown to its mirror image, and the missing wedge is the floor.
    const edge = Math.atan2(DECK_Y_M, deckHalf);
    start = edge;
    length = Math.PI * 2 + 2 * edge;
  }
  const hasDeck = deckHalf !== null;
  const segments = RIB_SEGMENTS;
  // The strip's inner boundary is a CHORD between samples, so it dips inside the
  // radius it was sampled at. Measured: 5 mm at the crown of a 1.0 m bore, which
  // is exactly enough to put the rib back inside a walking head. Pay the sagitta
  // rather than sample finer — 20 segments is what the flange costs.
  const sag = radius * (1 - Math.cos(length / (2 * segments)));
  const inner = (i: number): number => {
    const a = start + (length * i) / segments;
    const want = radius - RIB_DEPTH;
    if (!hasDeck) return want;
    return Math.max(want, hullClearance(a) + 0.014 + sag);
  };
  return ribStrip(radius, inner, start, length, segments, z);
}

/**
 * Flange-and-web strip with a per-vertex inner radius. `RingGeometry` and
 * `CylinderGeometry` can only do a constant radius, and the taper above is the
 * whole point, so this builds both surfaces as one indexed strip: 4 triangles
 * per segment, the same cost as the two primitives it replaces.
 */
function ribStrip(
  radius: number,
  inner: (i: number) => number,
  start: number,
  length: number,
  segments: number,
  z: number,
): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = start + (length * i) / segments;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ri = inner(i);
    const u = i / segments;
    // 0: outer flange edge (on the hull), 1: inner flange edge, 2: web's far lip
    position.push(radius * c, radius * s, z + RIB_W, ri * c, ri * s, z + RIB_W, ri * c, ri * s, z);
    normal.push(0, 0, 1, 0, 0, 1, -c, -s, 0);
    uv.push(u, 1, u, 0.5, u, 0);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 3;
    const b = (i + 1) * 3;
    // flange quad
    index.push(a, b, a + 1, b, b + 1, a + 1);
    // web quad
    index.push(a + 1, b + 1, a + 2, b + 1, b + 2, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

/**
 * A shielded lighting cove (ISS-STR-07). "Not a light — geometry that HIDES
 * one": a channel with an unequal pair of cheeks, so from the deck you see the
 * lit inside of the channel and not the bar. `kit.ts` puts the emissive bar in
 * the same channel from the same numbers (`coveStrips`), which is why the two
 * cannot drift apart.
 */
function cove(radius: number, angle: number, length: number): THREE.BufferGeometry {
  // `coveSign` decides which cheek is the long one, so the lip always ends up
  // between the bar and the deck. Same call `kit.ts` makes to place the bar.
  const sign = coveSign(angle);
  const edge = COVE_W / 2 - 0.007;
  const back = boxAt({ x: COVE_W, y: 0.014, z: length }, 0, 0.007, 0);
  const cheek = boxAt({ x: 0.014, y: COVE_D, z: length }, sign * edge, COVE_D / 2, 0);
  const lip = boxAt({ x: 0.014, y: COVE_LIP, z: length }, -sign * edge, COVE_LIP / 2, 0);
  return wallPlace(mergeGeometries([back, cheek, lip], false), radius, angle);
}

/**
 * A cable raceway (ISS-STR-01: "cable raceways"): a tray with two rails and a
 * clamp every metre and a half. The kit's cable-bundle props already run at
 * these wall angles, so the tray is the thing they have always been lying in.
 */
function raceway(
  radius: number,
  angle: number,
  length: number,
  clamps: number,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    boxAt({ x: TRAY_W, y: 0.014, z: length }, 0, 0.007, 0),
    boxAt({ x: 0.014, y: TRAY_D, z: length }, TRAY_W / 2 - 0.007, TRAY_D / 2, 0),
    boxAt({ x: 0.014, y: TRAY_D, z: length }, -(TRAY_W / 2 - 0.007), TRAY_D / 2, 0),
  ];
  for (let i = 0; i < clamps; i++) {
    const z = clamps === 1 ? 0 : -length / 2 + 0.3 + ((length - 0.6) * i) / (clamps - 1);
    parts.push(boxAt({ x: TRAY_W + 0.03, y: 0.02, z: 0.035 }, 0, TRAY_D + 0.01, z));
  }
  return wallPlace(mergeGeometries(parts, false), radius, angle);
}

/**
 * The overhead run (ISS-GRV-11).
 *
 * "Newly important: walking means you look UP at a ceiling you never saw while
 * floating." A duct, two conduits and a hanger at every frame station — all of
 * it OFF the crown, because `DECK_HEADROOM_M` leaves a standing player 5 cm of
 * clear air on the axis and §14 says those 5 cm are deliberate. Off-axis the
 * hull has already curved away, so a 9 cm duct at a third of the radius hangs
 * well clear of the collider while sitting right in the eyeline of anyone
 * looking up.
 */
function overheadRun(
  radius: number,
  length: number,
  ribs: readonly number[],
  hasDeck: boolean,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const deg = (d: number): number => (d * Math.PI) / 180;

  // Rectangular duct, port side of the crown. Its angle is not decorative: at
  // 108° a 0.26 m duct clears the walking capsule with 10 cm of depth to spare,
  // and it is still the first thing in the eyeline of anyone who looks up.
  const ductAngle = deg(108);
  const ductW = 0.26;
  const ductD = fittingDepth(radius, ductAngle, ductW, 0.085, hasDeck);
  const duct = mergeGeometries(
    [
      boxAt({ x: ductW, y: ductD, z: length }, 0, ductD / 2, 0),
      // A flange down each side reads as sheet metal rather than as a bar.
      boxAt({ x: 0.016, y: ductD + 0.025, z: length }, ductW / 2 - 0.008, ductD / 2, 0),
      boxAt({ x: 0.016, y: ductD + 0.025, z: length }, -(ductW / 2 - 0.008), ductD / 2, 0),
    ],
    false,
  );
  parts.push(wallPlace(duct, radius, ductAngle));

  // Two conduits, starboard side, between the cove and the crown.
  for (const angle of [deg(74), deg(83)]) {
    const d = fittingDepth(radius, angle, 0.09, 0.1, hasDeck);
    const pipe = new THREE.CylinderGeometry(0.042, 0.042, length, 8, 1, true);
    pipe.rotateX(Math.PI / 2);
    pipe.translate(0, Math.max(0.05, d) - 0.045, 0);
    parts.push(wallPlace(pipe, radius, angle));
  }

  // A strap over the crown at every frame station, tying the two sides
  // together. Curved rather than a chord: a straight bar across a 1.0 m crown
  // dips 9 cm at the middle and there are only 5 cm to give.
  const strapD = fittingDepth(radius, Math.PI / 2, 0.02, 0.03, hasDeck);
  for (const z of ribs) {
    const strap = bandArc(radius - strapD, 0.05, deg(58), deg(64), 6);
    strap.translate(0, 0, z);
    parts.push(strap);
  }
  return mergeGeometries(parts, false);
}

// ---------------------------------------------------------------------------
// Module shells
// ---------------------------------------------------------------------------

/**
 * Build every piece of geometry for one placed module, in module space.
 * `module.ports[].link` decides whether a port gets an open bulkhead ring or a
 * solid endcap — that is the whole "endcap kit piece", instanced off port data.
 */
export function buildModuleShell(
  module: StationModule,
  piece: KitPiece = KIT[module.kind],
): ShellGeometry {
  const shell = emptyShell();

  switch (module.kind) {
    case 'node':
      buildNodeShell(shell, module, piece);
      break;
    case 'cupola':
      buildCupolaShell(shell, module, piece);
      break;
    case 'straight':
    case 'lab':
    case 'airlock':
    default:
      buildTubeShell(shell, module, piece);
      break;
  }

  for (const strip of piece.strips) {
    const g = box(strip.size);
    g.translate(strip.pos.x, strip.pos.y, strip.pos.z);
    shell.strips.push(g);
  }

  // The deck is built from the module's AUTHORED gravity, and it is permanent.
  // A gravity failure (§4) is a plant winding down, not a floor evaporating: the
  // deck stays exactly where it is, you just stop being held against it. That is
  // also why nothing here has to be rebuilt when the director drops a module —
  // only the edge lighting changes, and that is a material write.
  if (module.gravity !== 'zero' && piece.deck) buildDeck(shell, piece.deck);

  // Props that are solid enough to swim into: racks line every wall and are the
  // main reason a module's usable bore is narrower than its hull (§4 sweeps a
  // 0.35m sphere against this).
  shell.collision.push(...buildPropCollision(module));
  buildHideShells(shell, module);
  reportShellBudget(module, shell);
  return shell;
}

/**
 * Dev-only budget report for one module shell.
 *
 * `assertPolyBudget` throws, which is right for a builder that returns one asset
 * and wrong here: this runs at level load on the real client, and a shell three
 * triangles over budget must not be a black screen. So it warns, in exactly the
 * places the bible's per-piece ranges say to look — under-spending is the actual
 * bug in this family ("everything is just blobs and rails").
 */
function reportShellBudget(module: StationModule, shell: ShellGeometry): void {
  const lists = [shell.hull, shell.trim, shell.glass, shell.strips];
  let triangles = 0;
  for (const list of lists) {
    for (const g of list) {
      triangles += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
  }
  const probe = new THREE.BufferGeometry();
  probe.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(triangles * 9), 3),
  );
  const result = checkPolyBudget(probe, 'structure', `${module.kind} shell '${module.id}'`);
  probe.dispose();
  if (result.message) console.warn(result.message);
}

// ---------------------------------------------------------------------------
// The deck (§4) — `deckKit` owns every number in here
// ---------------------------------------------------------------------------

function buildDeck(shell: ShellGeometry, deck: DeckDef): void {
  for (const part of deck.parts) {
    if (part.shape === 'box') {
      const g = box(part.size);
      g.translate(part.pos.x, part.pos.y, part.pos.z);
      shell.deck.push(g);
      shell.collision.push(g.clone());
      continue;
    }
    const g = new THREE.CylinderGeometry(
      part.radius,
      part.radius,
      part.thickness,
      RADIAL_SEGMENTS,
      1,
      false,
      part.arc?.start ?? 0,
      part.arc?.length ?? Math.PI * 2,
    );
    g.translate(part.pos.x, part.pos.y - part.thickness / 2, part.pos.z);
    shell.deck.push(g);
    shell.collision.push(g.clone());
  }
  // The edge runs are NOT collision: they are 2.5 cm of light, and a walker
  // catching on them at the lip of every deck would be maddening.
  for (const edge of deck.edges) {
    const g = box(edge.size);
    g.translate(edge.pos.x, edge.pos.y, edge.pos.z);
    shell.deckEdge.push(g);
  }
}

// ---------------------------------------------------------------------------
// Hide spot shells (§4)
// ---------------------------------------------------------------------------

/**
 * Five slabs around a hide volume, open on the face you enter through.
 *
 * §4: "A box the alien can walk through is not a hide spot, it is a decoration."
 * The shell is that box — it goes into the BVH, so you cannot walk through the
 * back of a locker, and `HideSpotGraph.sweepBlocked` reasons about exactly the
 * same volume. What the alien routes around and what you can see are therefore
 * one object rather than two that can drift apart.
 *
 * The open face is derived from `entryPos` rather than authored separately, for
 * the same reason: one source of truth for which way the door is. Left as plain
 * slabs by the art pass on purpose — every face of this is load-bearing for the
 * collider AND for `walkable.ts`'s entry clearance, and a lip added for looks is
 * a lip a body has to squeeze past.
 */
export function buildHideSpotShell(spot: HideSpot): THREE.BufferGeometry[] {
  const half = new THREE.Vector3(
    Math.abs(spot.halfExtents.x),
    Math.abs(spot.halfExtents.y),
    Math.abs(spot.halfExtents.z),
  );
  const quat = spot.localQuat
    ? new THREE.Quaternion(spot.localQuat.x, spot.localQuat.y, spot.localQuat.z, spot.localQuat.w)
    : new THREE.Quaternion();
  // Entry direction in the SPOT's own frame.
  const toEntry = new THREE.Vector3(
    spot.entryPos.x - spot.localPos.x,
    spot.entryPos.y - spot.localPos.y,
    spot.entryPos.z - spot.localPos.z,
  ).applyQuaternion(quat.clone().invert());

  const axes: Array<['x' | 'y' | 'z', number]> = [
    ['x', Math.abs(toEntry.x)],
    ['y', Math.abs(toEntry.y)],
    ['z', Math.abs(toEntry.z)],
  ];
  axes.sort((a, b) => b[1] - a[1]);
  const openAxis = (axes[0] as ['x' | 'y' | 'z', number])[0];
  const openSign = Math.sign(toEntry[openAxis]) || 1;

  const t = HIDE_SHELL_T;
  const parts: THREE.BufferGeometry[] = [];
  const faces: Array<{ axis: 'x' | 'y' | 'z'; sign: number }> = [
    { axis: 'x', sign: 1 },
    { axis: 'x', sign: -1 },
    { axis: 'y', sign: 1 },
    { axis: 'y', sign: -1 },
    { axis: 'z', sign: 1 },
    { axis: 'z', sign: -1 },
  ];
  for (const face of faces) {
    if (face.axis === openAxis && face.sign === openSign) continue;
    const g = new THREE.BoxGeometry(
      face.axis === 'x' ? t : (half.x + t) * 2,
      face.axis === 'y' ? t : (half.y + t) * 2,
      face.axis === 'z' ? t : (half.z + t) * 2,
    );
    const offset = new THREE.Vector3();
    offset[face.axis] = face.sign * (half[face.axis] + t / 2);
    g.translate(offset.x, offset.y, offset.z);
    parts.push(g);
  }
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(spot.localPos.x, spot.localPos.y, spot.localPos.z),
    quat,
    new THREE.Vector3(1, 1, 1),
  );
  for (const g of parts) g.applyMatrix4(local);
  return parts;
}

function buildHideShells(shell: ShellGeometry, module: StationModule): void {
  for (const spot of module.hideSpots ?? []) {
    for (const g of buildHideSpotShell(spot)) {
      shell.hideShells.push(g);
      shell.collision.push(g.clone());
    }
  }
}

// ---------------------------------------------------------------------------
// Cylindrical pieces — straight, lab, airlock (ISS-STR-01, ISS-STR-04)
// ---------------------------------------------------------------------------

function buildTubeShell(shell: ShellGeometry, module: StationModule, piece: KitPiece): void {
  const r = piece.radius;
  const len = piece.length;
  shell.hull.push(tube(r, len));
  shell.collision.push(tube(r, len));

  const outerPorts = new Set<string>(piece.outerPorts ?? []);
  for (const port of module.ports) {
    // Same shape into `trim` and into `collision`: the bulkhead you can see is
    // exactly the bulkhead you can walk into.
    const linked = port.link !== null;
    shell.trim.push(toPort(annulus(PORT_RADIUS, r, linked), port));
    shell.collision.push(toPort(annulus(PORT_RADIUS, r, linked), port));
    capPort(shell, port, outerPorts.has(port.id));
  }

  const interior = piece.interior;
  if (!interior) return;
  // A module with a deck stops its ribs at the deck edge; one without closes
  // them. `deckHalfWidth` is deckKit's, so a rib and the floor cannot disagree.
  const deckHalf = module.gravity === 'zero' || !piece.deck ? null : deckHalfWidth(r);
  const ribs = interior.ribs ?? [];
  for (const z of ribs) shell.trim.push(ringFrame(r, z, deckHalf));
  const runLength = len - 0.5;
  for (const angle of interior.coves ?? []) shell.trim.push(cove(r, angle, runLength));
  for (const angle of interior.trays ?? []) {
    shell.trim.push(raceway(r, angle, runLength, Math.max(2, Math.round(len / 1.8))));
  }
  if (interior.overhead) shell.trim.push(overheadRun(r, runLength, ribs, deckHalf !== null));
}

// ---------------------------------------------------------------------------
// The six-way node (ISS-STR-02)
// ---------------------------------------------------------------------------

function buildNodeShell(shell: ShellGeometry, module: StationModule, piece: KitPiece): void {
  const h = piece.radius;
  for (const port of module.ports) {
    // Every node face is a square with the hatch punched out of its middle.
    const linked = port.link !== null;
    shell.hull.push(toPort(faceWithHole(h, linked), port));
    shell.collision.push(toPort(faceWithHole(h, linked), port));
    capPort(shell, port, false);
  }

  const interior = piece.interior;
  if (!interior?.posts) return;

  // Four corner chases, full height, each shielding one of the node's strips.
  // A node is a cube, so its "walls" are six flat plates and its four vertical
  // edges are a 90° notch — which is where a real junction puts its service
  // runs, and where this kit already put the node's four light strips. The chase
  // runs the full height, so a node reads as four glowing corners rather than as
  // a room with bars in it.
  for (const angle of NODE_CORNER_ANGLES) {
    const chase = cove(NODE_CHASE_R * h, angle, h * 2 - 0.12);
    // `cove` builds its run along +Z; stand it up so the run is along +Y.
    chase.rotateX(-Math.PI / 2);
    shell.trim.push(chase);
  }

  // A coffered ceiling. §2 wants a node to "feel like a decision point, not a
  // corridor", and the ceiling is the one surface a node has that a tube does
  // not: four exits at eye level, and something overhead to say you have
  // arrived somewhere.
  const cof = h - 0.34;
  for (const s of [-1, 1]) {
    shell.trim.push(boxAt({ x: cof * 2, y: 0.05, z: 0.1 }, 0, h - 0.06, s * cof));
    shell.trim.push(boxAt({ x: 0.1, y: 0.05, z: cof * 2 }, s * cof, h - 0.06, 0));
  }
  shell.trim.push(boxAt({ x: cof * 1.1, y: 0.03, z: 0.06 }, 0, h - 0.08, 0));

  // Border frames on the four SIDE faces, so each reads as a bolted plate with a
  // hatch in it rather than as a wall that happens to have a hole.
  const border = 0.13;
  const edge = h - border / 2 - 0.05;
  const inset = h - 0.025;
  for (const axis of ['x', 'z'] as const) {
    const along = axis === 'x' ? 'z' : 'x';
    for (const sign of [-1, 1]) {
      for (const s of [-1, 1]) {
        const rail: Record<'x' | 'y' | 'z', number> = { x: 0, y: border, z: 0 };
        const railAt: Record<'x' | 'y' | 'z', number> = { x: 0, y: s * edge, z: 0 };
        rail[axis] = 0.05;
        railAt[axis] = sign * inset;
        rail[along] = h * 2 - 0.1;
        shell.trim.push(boxAt(rail, railAt.x, railAt.y, railAt.z));

        const stile: Record<'x' | 'y' | 'z', number> = {
          x: 0,
          y: (h - border - 0.05) * 2,
          z: 0,
        };
        const stileAt: Record<'x' | 'y' | 'z', number> = { x: 0, y: 0, z: 0 };
        stile[axis] = 0.05;
        stileAt[axis] = sign * inset;
        stile[along] = border;
        stileAt[along] = s * edge;
        shell.trim.push(boxAt(stile, stileAt.x, stileAt.y, stileAt.z));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The cupola (ISS-STR-03)
// ---------------------------------------------------------------------------

function buildCupolaShell(shell: ShellGeometry, module: StationModule, piece: KitPiece): void {
  const port = module.ports[0] as Port;
  const collarR = CUPOLA_COLLAR_R;
  const domeR = piece.radius;
  const portZ = port.localPos.z;
  const domeZ = portZ + 0.75;

  // Collar, skirt and dome all use DOME_SEGMENTS. They meet edge to edge, and a
  // 24-gon plate against a 16-gon tube leaves slivers you can see the fog
  // through — the hull is BackSide, so a gap in it is a black seam.
  const collar = tube(collarR, 0.75, DOME_SEGMENTS);
  collar.translate(0, 0, portZ + 0.375);
  shell.hull.push(collar);
  shell.collision.push(collar.clone());

  const dome = new THREE.SphereGeometry(domeR, DOME_SEGMENTS, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.rotateX(Math.PI / 2);
  dome.translate(0, 0, domeZ);
  shell.hull.push(dome);
  shell.collision.push(dome.clone());

  // Skirt joining the collar to the dome's equator, and the bulkhead ring.
  const skirt = ringArc(collarR, domeR, 0, Math.PI * 2, DOME_SEGMENTS);
  skirt.translate(0, 0, domeZ);
  shell.trim.push(skirt);
  shell.collision.push(skirt.clone());

  const collarLinked = port.link !== null;
  shell.trim.push(toPort(annulus(PORT_RADIUS, collarR, collarLinked), port));
  shell.collision.push(toPort(annulus(PORT_RADIUS, collarR, collarLinked), port));
  capPort(shell, port, false);

  // A ring frame at each end of the collar, and the collar's two coves. The
  // cupola is the darkest room in the station (`defaultLighting: 'dark'`) and
  // its vestibule is where a player stops being in a corridor, so it gets the
  // corridor's own rhythm cue and the corridor's own hidden light.
  shell.trim.push(ringFrame(collarR, domeZ - 0.14, null));
  shell.trim.push(ringFrame(collarR, portZ + 0.18, null));
  for (const angle of piece.interior?.coves ?? []) {
    const channel = cove(collarR, angle, 0.62);
    channel.translate(0, 0, portZ + 0.375);
    shell.trim.push(channel);
  }

  // Seven windows: six around the skirt of the dome, one at the apex (§2).
  //
  // The panes are `materials.glass` — 0x05070d at roughness 0.12 and metalness
  // 0.85, which is not transparent and is not trying to be. Night side, cabin
  // dark: what a real window does then is turn into a black mirror with your
  // torch streaked across it, and that is a stronger read than a hole with
  // nothing behind it. Each gets a recessed well and a heavy flange, because the
  // FRAME is what says "window" at 4 m in a torch beam.
  const paneR = 0.42;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const el = Math.PI / 4;
    const dir = new THREE.Vector3(
      Math.cos(a) * Math.sin(el),
      Math.sin(a) * Math.sin(el),
      Math.cos(el),
    ).normalize();
    shell.glass.push(pane(paneR, dir, domeR, domeZ));
    shell.trim.push(paneFrame(paneR, dir, domeR, domeZ));
  }
  const up = new THREE.Vector3(0, 0, 1);
  shell.glass.push(pane(0.5, up, domeR, domeZ));
  shell.trim.push(paneFrame(0.5, up, domeR, domeZ));

  // Mullions: six ribs from the skirt toward the apex, between the windows.
  // This is the cupola's silhouette — a ribbed dome, not a bubble.
  for (let i = 0; i < 6; i++) {
    const a = ((i + 0.5) / 6) * Math.PI * 2;
    const rib = boxAt({ x: 0.1, y: 0.055, z: domeR * 0.95 }, 0, 0, 0);
    rib.rotateY(Math.PI / 2.7);
    rib.rotateZ(a);
    rib.translate(Math.cos(a) * domeR * 0.5, Math.sin(a) * domeR * 0.5, domeZ + domeR * 0.44);
    shell.trim.push(rib);
  }
}

function pane(
  radius: number,
  dir: THREE.Vector3,
  domeR: number,
  domeZ: number,
): THREE.BufferGeometry {
  const g = solidDisc(radius, 12);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  g.applyQuaternion(q);
  g.translate(dir.x * (domeR - 0.03), dir.y * (domeR - 0.03), domeZ + dir.z * (domeR - 0.03));
  return g;
}

/**
 * A window's well and flange: a band sunk into the dome, a lip around it, and an
 * inner ring for the pane to sit at the bottom of. 96 triangles where the torus
 * it replaces was 140, and unlike a torus it has a depth you can see.
 */
function paneFrame(
  radius: number,
  dir: THREE.Vector3,
  domeR: number,
  domeZ: number,
): THREE.BufferGeometry {
  const well = bandArc(radius, 0.1, 0, Math.PI * 2, 10);
  well.translate(0, 0, 0.05);
  const flange = ringArc(radius, radius + 0.075, 0, Math.PI * 2, 10);
  flange.translate(0, 0, 0.1);
  const seat = ringArc(radius - 0.045, radius, 0, Math.PI * 2, 10);
  const g = mergeGeometries([well, flange, seat], false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  g.applyQuaternion(q);
  g.translate(dir.x * (domeR - 0.1), dir.y * (domeR - 0.1), domeZ + dir.z * (domeR - 0.1));
  return g;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

// Prop geometry USED to live here, next to the module shells, and the split was
// the wrong one: a prop kind's silhouette, its instancing decision and its
// material assignment are one design choice, and they were three edits in three
// files. All of it moved to `props.ts` — "one file, one dispatch" — and these
// three exports stay as the names the rest of the tree already imports
// (`cargo.ts`, `lockers.ts`, `panels.ts`, `index.ts`). No behaviour lives here
// any more; nothing new should be added here either.
export { buildPropGeometry, buildLockerParts, buildPanelParts } from './props';

/**
 * Prop kinds that are solid in the BVH.
 *
 * The deck furniture is on this list and that is the point of it: against a
 * blind pursuer, geometry is the ONLY thing that routes anybody, so a bulkhead
 * that is not in the collider is not a partial bulkhead, it is a poster of one.
 * Cables, strips, laptops and bags stay out — you brush past those.
 */
const SOLID_PROP_KINDS: ReadonlySet<string> = new Set([
  'rack',
  'locker',
  'bulkhead',
  'bench',
  'bank',
  'cargo-rack',
]);

/** Solid props, in module space, for the static BVH. */
export function buildPropCollision(module: StationModule): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const p of module.props) {
    if (!SOLID_PROP_KINDS.has(p.kind)) continue;
    const arch = propArchetype(p.kind);
    if (!arch?.size) continue;
    const s = p.scale ?? 1;
    const g = box({ x: arch.size.x * s, y: arch.size.y * s, z: arch.size.z * s });
    applyPropTransform(g, p);
    out.push(g);
  }
  return out;
}

/** Apply a PropRef's module-space pose to a geometry. */
export function applyPropTransform(g: THREE.BufferGeometry, p: PropRef): void {
  if (p.localQuat) {
    g.applyQuaternion(
      new THREE.Quaternion(p.localQuat.x, p.localQuat.y, p.localQuat.z, p.localQuat.w),
    );
  }
  g.translate(p.localPos.x, p.localPos.y, p.localPos.z);
}

// ---------------------------------------------------------------------------
// Handrails (ISS-STR-05)
// ---------------------------------------------------------------------------

/**
 * Unit handrail: a cylinder of length 1 along +Y, so one instance matrix can
 * stretch it onto any `RailSegment`.
 *
 * Ten sides rather than eight. A handrail is a HERO asset inside a zero-G module
 * — "there it is the only way to move" — and section is the one thing a
 * stretched instance gets for free, so the extra triangles buy the roundness
 * that reads as "grab me" instead of "pipe".
 */
export function buildRailGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(RAIL_RADIUS, RAIL_RADIUS, 1, 10, 1);
}

/**
 * A standoff bracket (ISS-STR-05: "a round rail on two standoff brackets").
 *
 * Built in a frame where the rail runs along +Y through the origin and the wall
 * is at −Z, so `handrails.ts` can place one with the same basis it already
 * builds for the tube. Never merged into the rail itself: the rail is stretched
 * to each segment's length by its instance matrix, and a bracket stretched with
 * it would be a smear.
 */
export function buildRailBracketGeometry(): THREE.BufferGeometry {
  const standoff = 0.075;
  const plate = boxAt({ x: 0.055, y: 0.1, z: 0.018 }, 0, 0, -standoff + 0.009);
  const post = boxAt({ x: 0.03, y: 0.034, z: standoff }, 0, 0, -standoff / 2);
  const saddle = boxAt({ x: 0.052, y: 0.052, z: 0.03 }, 0, 0, -0.015);
  return mergeGeometries([plate, post, saddle], false);
}

// ---------------------------------------------------------------------------
// Hatches (ISS-STR-06) and the two threshold assets (ISS-GRV-09, ISS-GRV-10)
// ---------------------------------------------------------------------------

/**
 * Every part of a pressure hatch, in a local frame where **+Z is the port's
 * outward normal** (so +Z points into the module on the FAR side), +Y is up and
 * the door hinges about the −X edge.
 *
 * `hatches.ts` instances all of it station-wide: the frame, coaming and mode
 * markers never move, and the door, pane, seal and lamps move as one matrix
 * each, so nine hatches cost about eight draw calls between them instead of
 * three to seven each.
 */
export interface HatchGeometry {
  /** Static: the doorway band, its two raised collars, eight dogs, and the two
   *  status plaques the lamp and the mode marker are mounted on. */
  frame: THREE.BufferGeometry;
  /** The swinging slab: window well, handwheel, stiffeners, grab handle. */
  door: THREE.BufferGeometry;
  /** The window's pane. Moves with the door, hence its own geometry. */
  pane: THREE.BufferGeometry;
  /** The dogging spider — present only while a hatch is SEALED, and the reason
   *  sealed and closed can be told apart from across a module. */
  seal: THREE.BufferGeometry;
  /** Two state lamps, one per face, so a hatch reads from both sides. */
  indicator: THREE.BufferGeometry;
  /** ISS-GRV-10. Vertex-coloured: hazard stripes want one material. */
  coaming: THREE.BufferGeometry;
  /** ISS-GRV-09 — the module beyond has a floor. Horizontal bars. */
  markerNominal: THREE.BufferGeometry;
  /** ISS-GRV-09 — the module beyond does not. Chevrons, pointing up. */
  markerZero: THREE.BufferGeometry;
  /** ISS-STR-04's outer door: the heavy one, with vacuum behind it. */
  outerDoor: THREE.BufferGeometry;
  /** Hazard striping around the outer door. Vertex-coloured. */
  outerHazard: THREE.BufferGeometry;
}

/** Depth of the frame band through the bulkhead. */
const FRAME_DEPTH = 0.22;
/** How far the frame's collar stands proud of the opening. */
const FRAME_LIP = 0.055;
/** Door slab radius — inside `PORT_RADIUS`, so it swings clear of its own frame. */
const DOOR_R = PORT_RADIUS - 0.045;
const DOOR_T = 0.075;
/** Where the door's hinge axis sits, in x. `hatches.ts` composes the swing
 *  matrix from this, so the two cannot disagree about where the hinge is. */
export const HATCH_HINGE_X = -(PORT_RADIUS + 0.02);
/** Radius the seal spider's dogs reach to. */
const SEAL_R = PORT_RADIUS + 0.03;
/**
 * The status column: a plaque on each face carrying the state lamp above the
 * mode marker, on the upper shoulder of the doorway.
 *
 * The obvious place for both is above the crown of the arch, and it is not
 * available: `DOORWAY_TOP` is 0.96 and the narrowest bore in the kit is 1.0, so
 * a straight leaves 4 cm of wall over a doorway. The shoulder has room in every
 * piece — `hypot(0.71, 0.62)` is 0.94, inside the 1.0 m hull — and it is at
 * standing eye height, 1.2 m over the deck.
 *
 * Mirrored in x between the two faces so both plaques land on the RIGHT of
 * whoever is walking toward the door. That is a convention a player can learn in
 * one round, which is the entire point of ISS-GRV-09.
 */
const PLAQUE_X = 0.6;
const PLAQUE_Y = 0.48;
const LAMP_Y = 0.56;
const MARK_Y = 0.4;

/**
 * A wall following a closed outline, as a quad strip.
 *
 * The only way to give this doorway a real lip: its outline is a circle unioned
 * with a slot, so no primitive expresses it, and `ExtrudeGeometry` would hand
 * back two caps nobody can see plus a bevel nobody asked for.
 */
function bandAlongOutline(
  points: readonly THREE.Vector2[],
  z0: number,
  z1: number,
): THREE.BufferGeometry {
  const n = points.length;
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i] as THREE.Vector2;
    const prev = points[(i - 1 + n) % n] as THREE.Vector2;
    const next = points[(i + 1) % n] as THREE.Vector2;
    // The outline runs counter-clockwise, so the left-hand normal points at the
    // axis — which is the face a player standing in the doorway can see.
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const u = i / n;
    position.push(p.x, p.y, z0, p.x, p.y, z1);
    normal.push(nx, ny, 0, nx, ny, 0);
    uv.push(u, 0, u, 1);
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    index.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

/** A flat frame plate: the doorway outline inflated, with the doorway as a hole. */
function framePlate(inflate: number, z: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(
    doorwayOutline(inflate, Number.POSITIVE_INFINITY, DOORWAY_FRAME_SEGMENTS),
  );
  const hole = new THREE.Path(
    doorwayOutline(0, Number.POSITIVE_INFINITY, DOORWAY_FRAME_SEGMENTS),
  );
  hole.closePath();
  shape.holes.push(hole);
  const g = new THREE.ShapeGeometry(shape);
  g.translate(0, 0, z);
  return g;
}

/**
 * Where the eight dogs sit around the rim.
 *
 * Six land on the round part of the outline, one on the crown of the arch and
 * one on the sill — which is what makes a hatch read as a hatch from in front
 * and still line up with the slot at top and bottom.
 */
function dogStations(): Array<{ x: number; y: number; angle: number }> {
  const out: Array<{ x: number; y: number; angle: number }> = [];
  for (const deg of [0, 45, 135, 180, -135, -45]) {
    const a = (deg * Math.PI) / 180;
    out.push({ x: Math.cos(a) * PORT_RADIUS, y: Math.sin(a) * PORT_RADIUS, angle: a });
  }
  out.push({ x: 0, y: DOORWAY_TOP, angle: Math.PI / 2 });
  out.push({ x: 0, y: DOORWAY_SILL, angle: -Math.PI / 2 });
  return out;
}

export function buildHatchGeometry(): HatchGeometry {
  // -- frame: band, two collars, eight dogs, two status plaques -------------
  const outline = doorwayOutline(0, Number.POSITIVE_INFINITY, DOORWAY_FRAME_SEGMENTS);
  const frameParts: THREE.BufferGeometry[] = [
    bandAlongOutline(outline, -FRAME_DEPTH / 2, FRAME_DEPTH / 2),
    framePlate(FRAME_LIP, FRAME_DEPTH / 2),
    framePlate(FRAME_LIP, -FRAME_DEPTH / 2),
  ];
  for (const dog of dogStations()) {
    const g = boxAt({ x: 0.08, y: 0.05, z: FRAME_DEPTH + 0.07 }, 0, 0, 0);
    g.rotateZ(dog.angle);
    g.translate(dog.x + Math.cos(dog.angle) * 0.028, dog.y + Math.sin(dog.angle) * 0.028, 0);
    frameParts.push(g);
  }
  for (const s of [-1, 1]) {
    frameParts.push(
      boxAt(
        { x: 0.22, y: 0.3, z: 0.018 },
        s * PLAQUE_X,
        PLAQUE_Y,
        s * (FRAME_DEPTH / 2 + 0.009),
      ),
    );
  }
  const frame = mergeGeometries(frameParts, false);

  // -- door: slab, window, handwheel, stiffeners ----------------------------
  const slab = new THREE.CylinderGeometry(DOOR_R, DOOR_R - 0.02, DOOR_T, 20, 1);
  slab.rotateX(Math.PI / 2);
  const doorParts: THREE.BufferGeometry[] = [slab];

  // The window sits above centre, where a face looks through it. Everything
  // below is spaced against the coaming and the wheel, not eyeballed: the wheel
  // clears the coaming's top lip by 1.5 cm and the window's seat by 3 cm.
  const windowR = 0.125;
  const windowY = 0.3;
  const well = bandArc(windowR, DOOR_T + 0.03, 0, Math.PI * 2, 10);
  well.translate(0, windowY, 0);
  const seat = ringArc(windowR, windowR + 0.045, 0, Math.PI * 2, 10);
  seat.translate(0, windowY, -DOOR_T / 2 - 0.015);
  doorParts.push(well, seat);

  // Handwheel: ring, four spokes, hub. A torus is 120 triangles for the same
  // silhouette; this is 96 and has a rim you can see the depth of.
  const wheelR = 0.19;
  const wheelY = -0.12;
  const wheelZ = -DOOR_T / 2 - 0.055;
  const wheelBand = bandArc(wheelR, 0.05, 0, Math.PI * 2, 12);
  wheelBand.translate(0, wheelY, wheelZ);
  const wheelFace = ringArc(wheelR - 0.028, wheelR, 0, Math.PI * 2, 12);
  wheelFace.translate(0, wheelY, wheelZ - 0.025);
  doorParts.push(wheelBand, wheelFace);
  for (let i = 0; i < 3; i++) {
    const spoke = boxAt({ x: wheelR * 2 - 0.02, y: 0.032, z: 0.028 }, 0, 0, 0);
    spoke.rotateZ((i * Math.PI) / 3);
    spoke.translate(0, wheelY, wheelZ);
    doorParts.push(spoke);
  }
  const hub = new THREE.CylinderGeometry(0.05, 0.065, 0.075, 8, 1);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, wheelY, wheelZ - 0.02);
  doorParts.push(hub);

  // Radial stiffeners on the far face, so the door reads as pressure-bearing
  // from the side you are not opening it from.
  for (let i = 0; i < 3; i++) {
    const rib = boxAt({ x: DOOR_R * 1.9, y: 0.05, z: 0.03 }, 0, 0, DOOR_T / 2 + 0.014);
    rib.rotateZ((i * Math.PI) / 3);
    doorParts.push(rib);
  }
  // Grab handle on the swinging edge — what a hand actually pulls.
  doorParts.push(boxAt({ x: 0.05, y: 0.22, z: 0.06 }, DOOR_R - 0.11, 0.02, -DOOR_T / 2 - 0.04));
  const door = mergeGeometries(doorParts, false);
  // Shift so the hinge sits at the origin; the instance matrix rotates about +Y.
  door.translate(-HATCH_HINGE_X, 0, 0);

  const pane = solidDisc(windowR - 0.004, 10);
  pane.translate(-HATCH_HINGE_X, windowY, -DOOR_T / 2 - 0.016);

  // -- seal: the dogging spider --------------------------------------------
  // Four bars clamped across the door on BOTH faces, at the cardinals — so the
  // vertical pair crosses the open slot of the doorway at head height and at the
  // sill, and "you are not walking through this" is a silhouette rather than a
  // colour. §5: the alien opens a closed hatch in 3 s and never a sealed one, so
  // confusing the two is a death and the lamp is not allowed to carry it alone.
  const sealParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    for (const z of [-FRAME_DEPTH / 2 - 0.05, FRAME_DEPTH / 2 + 0.05]) {
      const bar = boxAt({ x: SEAL_R * 1.05, y: 0.07, z: 0.05 }, SEAL_R * 0.5, 0, z);
      bar.rotateZ(a);
      sealParts.push(bar);
      const claw = boxAt({ x: 0.09, y: 0.11, z: 0.12 }, SEAL_R * 0.99, 0, z);
      claw.rotateZ(a);
      sealParts.push(claw);
    }
  }
  const seal = mergeGeometries(sealParts, false);

  // -- indicator: one lamp per face, on the status plaque -------------------
  const indicator = mergeGeometries(
    [-1, 1].map((s) =>
      boxAt({ x: 0.13, y: 0.045, z: 0.028 }, s * PLAQUE_X, LAMP_Y, s * (FRAME_DEPTH / 2 + 0.03)),
    ),
    false,
  );

  // -- coaming (ISS-GRV-10) -------------------------------------------------
  // 0.40 m, exactly `STEP_HEIGHT_M`, whose comment in §14 names "the lip of a
  // hatch coaming" as the thing that height is for. Vertex-coloured, so the
  // striped face and the painted body are ONE material and one draw call.
  //
  // TWO lips, one either side of the door plane, rather than one box across the
  // threshold: the door is a 0.655 m disc centred on the axis, so a single lip
  // would occupy the same space as the shut door. Split, the door drops into the
  // channel between them, which is how a real sill works, and the threshold
  // still reads from both sides.
  //
  // Deliberately NOT in the BVH, and not because it was easier. `walkable.ts`
  // plants a standing collider IN the doorway to prove a body fits through, and
  // that probe's lower sphere is tangent to the deck — so ANY lip over about a
  // centimetre inside a doorway fails the level build. A collidable coaming
  // would also be stepped straight over by the controller, `STEP_HEIGHT_M`
  // being what it is, so all it could add is a stumble the validator refuses.
  const coamW = (DOORWAY_HALF_W + 0.04) * 2;
  const coamH = STEP_HEIGHT_M;
  const coamY = DECK_Y_M + coamH / 2;
  const coamParts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const z = s * 0.095;
    coamParts.push(withVertexColor(boxAt({ x: coamW, y: coamH, z: 0.09 }, 0, coamY, z), HAZARD_DARK));
    coamParts.push(
      withVertexColor(
        boxAt({ x: coamW + 0.03, y: 0.04, z: 0.12 }, 0, DECK_Y_M + coamH, z),
        HAZARD_YELLOW,
      ),
    );
    const band = hazardStripeBand(coamW - 0.16, coamH - 0.12, { stripes: 6 });
    if (s < 0) band.rotateY(Math.PI);
    band.translate(0, coamY - 0.03, s * 0.141);
    coamParts.push(band);
  }
  const coaming = mergeGeometries(coamParts, false);

  // -- mode markers (ISS-GRV-09) -------------------------------------------
  // One glyph per face, and the two faces advertise DIFFERENT modules: the glyph
  // you can see is the room you are about to step into. Bars mean a floor,
  // chevrons mean you will float — geometry, not colour, because the material is
  // deliberately the deck edge's own (`createModeMarkerMaterial`) and a marker
  // must never be able to disagree with the floor it advertises.
  const barParts: THREE.BufferGeometry[] = [];
  const chevParts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const x = s * PLAQUE_X;
    const z = s * (FRAME_DEPTH / 2 + 0.026);
    for (let i = 0; i < 3; i++) {
      const y = MARK_Y - i * 0.05;
      barParts.push(boxAt({ x: 0.17 - i * 0.025, y: 0.022, z: 0.02 }, x, y, z));
      for (const arm of [-1, 1]) {
        const g = new THREE.BoxGeometry(0.1, 0.022, 0.02);
        g.rotateZ(-arm * 0.55);
        g.translate(x + arm * 0.043, y - 0.02, z);
        chevParts.push(g);
      }
    }
  }
  const markerNominal = mergeGeometries(barParts, false);
  const markerZero = mergeGeometries(chevParts, false);

  // -- the outer door (ISS-STR-04) -----------------------------------------
  // "The outer door must read as a THREAT — heavier than any internal hatch."
  // So it is: a thicker slab, a full dogging ring instead of four dogs, six
  // radial ribs, no window at all, and it never opens. Built about the same
  // origin as the internal frame, so `hatches.ts` places it with the port
  // transform it already has.
  const outerR = PORT_RADIUS + 0.16;
  const outerParts: THREE.BufferGeometry[] = [];
  const outerRim = bandArc(outerR, 0.16, 0, Math.PI * 2, 20);
  outerRim.translate(0, 0, -0.08);
  const outerFlange = ringArc(PORT_RADIUS + 0.02, outerR, 0, Math.PI * 2, 20);
  outerFlange.translate(0, 0, -0.16);
  const outerSlab = new THREE.CylinderGeometry(PORT_RADIUS - 0.01, PORT_RADIUS - 0.01, 0.13, 20, 1);
  outerSlab.rotateX(Math.PI / 2);
  outerSlab.translate(0, 0, -0.02);
  outerParts.push(outerRim, outerFlange, outerSlab);
  for (let i = 0; i < 6; i++) {
    const rib = boxAt({ x: PORT_RADIUS * 1.9, y: 0.07, z: 0.05 }, 0, 0, -0.11);
    rib.rotateZ((i * Math.PI) / 6);
    outerParts.push(rib);
  }
  // Dogging ring: eight lugs on a band. The heavy-machinery read.
  const dogBand = bandArc(PORT_RADIUS * 0.62, 0.06, 0, Math.PI * 2, 12);
  dogBand.translate(0, 0, -0.14);
  outerParts.push(dogBand);
  for (let i = 0; i < 8; i++) {
    const lug = boxAt({ x: 0.13, y: 0.06, z: 0.07 }, PORT_RADIUS * 0.62, 0, -0.14);
    lug.rotateZ((i * Math.PI) / 4);
    outerParts.push(lug);
  }
  const outerDoor = mergeGeometries(outerParts, false);

  const outerHazParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const band = hazardStripeBand(0.85, 0.14, { stripes: 7 });
    band.rotateX(Math.PI);
    band.translate(0, outerR + 0.03, -0.165);
    band.rotateZ((i * Math.PI) / 2 + Math.PI / 4);
    outerHazParts.push(band);
  }
  const outerHazard = mergeGeometries(outerHazParts, false);

  return {
    frame,
    door,
    pane,
    seal,
    indicator,
    coaming,
    markerNominal,
    markerZero,
    outerDoor,
    outerHazard,
  };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/** Merge a list into one geometry, or null if the list is empty. Disposes the
 *  inputs — they exist only to be merged. */
export function mergeAndDispose(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (list.length === 0) return null;
  const merged =
    list.length === 1 ? (list[0] as THREE.BufferGeometry) : mergeGeometries(list, false);
  if (list.length > 1) for (const g of list) g.dispose();
  return merged;
}

/**
 * Strip everything but position and bake a world matrix in — MeshBVH only needs
 * triangles, and matching attribute sets are what `mergeGeometries` requires.
 */
export function toCollisionGeometry(
  g: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
): THREE.BufferGeometry {
  const out = g.clone();
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position') out.deleteAttribute(name);
  }
  out.morphAttributes = {};
  out.applyMatrix4(matrix);
  return out;
}
