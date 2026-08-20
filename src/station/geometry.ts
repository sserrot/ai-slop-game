/**
 * The three.js half of the kit (DESIGN.md §2, §9).
 *
 * "Grey-box everything in primitives until M8. Horror lives in lighting, audio
 * and frame pacing, not polygon count. Handrails get a high-contrast material
 * from day one because they're the movement grammar and must be readable in the
 * dark." — §9.
 *
 * Everything here is built from three.js primitives and returned in MODULE
 * space; `loader.ts` merges each list into one mesh per material per module, so
 * a module costs a handful of draw calls and can be hidden wholesale by the
 * two-hop portal culler.
 *
 * Geometry is split by the material it wants:
 *   hull      interior wall surfaces, rendered BackSide (you are always inside)
 *   trim      bulkhead rings, endcaps and window frames, rendered DoubleSide
 *   glass     cupola panes
 *   strips    emissive light strips, one material per module so `setLighting`
 *             can change a single module's mood
 *   collision position-only triangles fed to the station-wide MeshBVH (§1)
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HideSpot, Port, PropRef, StationModule, Vec3 } from '@shared/types';
import {
  CUPOLA_COLLAR_R,
  KIT,
  PORT_RADIUS,
  PROP_ARCHETYPES,
  RAIL_RADIUS,
  propArchetype,
} from './kit';
import type { KitPiece, PropKind } from './kit';
import { HIDE_SHELL_T, DOORWAY_HALF_W, DOORWAY_SILL, DOORWAY_TOP } from './deckKit';
import type { DeckDef } from './deckKit';

const RADIAL_SEGMENTS = 24;
const DOME_SEGMENTS = 20;

// Decorative tube rings (port rims, window frames, the hatch wheel) are the
// densest thing in the kit for what they contribute: a `TorusGeometry` costs
// `radial × tubular × 2` triangles, so the original 8 × 24 rim was 384 triangles
// of chrome trim — more than the 5 m tube it sits on, and repeated on every
// capped port and twice per hatch frame. §9 is explicit that horror lives in
// lighting rather than polygon count, and these segment counts were never
// authored, they were defaults. Halving the radial ring and easing the tubular
// ring back is invisible on a 0.055 m section and takes the worst node's trim
// mesh from 2,416 to 1,552 triangles — geometry that was being re-rasterised
// into the flashlight shadow map every frame as well as drawn.
const RIM_RADIAL_SEGMENTS = 6;
const RIM_TUBULAR_SEGMENTS = 20;
/** The endcap dome is a blank cap on a port nothing links to; it needs a
 *  silhouette, not a smooth normal. */
const ENDCAP_WIDTH_SEGMENTS = 14;
const ENDCAP_HEIGHT_SEGMENTS = 5;

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
function tube(radius: number, length: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, RADIAL_SEGMENTS, 1, true);
  g.rotateX(Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------------------
// The hatch opening — a circle in r2, a DOORWAY since the pivot
// ---------------------------------------------------------------------------
//
// `PORT_RADIUS` is 0.7 and its comment still explains itself against the zero-G
// body: "player capsule radius is 0.35, so 0.7 is a 0.35 m clearance all round."
// That was exactly right when the body WAS a 0.35 m sphere. The pivot made it a
// 1.7 m capsule standing on a deck at `DECK_Y_M` (−0.75), and nobody re-checked
// the hole: a circle of radius 0.7 centred on the module axis is open from 0.10 m
// above the deck to 1.40 m above it, which is 1.30 m of clear height against a
// 1.70 m body. MEASURED on the shipped level: all eighteen linked ports, 1.30 m
// every one. A walking player could not leave the room they woke up in, and
// nothing reported an error — the module graph, the rail graph, the hide graph
// and the walkability validator are all correct and all blind to it, because
// each of them checks reachability WITHIN a module.
//
// No circle fixes it. The top sphere of a standing capsule sits at y = +0.60
// with a 0.35 m radius, so a circular hole must have R ≥ 0.95 to pass it on the
// axis — and R ≥ 1.0, the whole bore, to pass it anywhere else. So the opening
// stops being a circle and becomes what a hatch you walk through actually is: a
// doorway cut down to the deck, with the old round hole still there around it.
//
// The union of the two is what gets punched, so a hatch still reads as a hatch
// from the side and as a door from in front. Every dimension is derived from
// §14 rather than drawn, so if the deck or the collider moves this moves with
// them, and the SAME path is used for the visible bulkhead and for the collision
// triangles — what you can see through is what you can walk through.
//
// What does NOT change: a closed or sealed hatch still blocks. That is the
// blocker disc in `collision.ts` (radius `PORT_RADIUS`), not the bulkhead, and
// the arithmetic still holds — a 0.35 m body would have to get its centre 1.05 m
// off the axis to slip past a 0.7 m disc, and the bore is 1.0. Re-measured
// below by walking a body at a shut hatch, not by inspection.

// `DOORWAY_HALF_W`, `DOORWAY_TOP` and `DOORWAY_SILL` are in `deckKit.ts` with
// the authoring rule they impose on everything standing on a deck near a port.
/** Samples across the half-width of the union. 12 is smooth at this scale. */
const DOORWAY_SEGMENTS = 12;

/**
 * The hole punched through a bulkhead at one port.
 *
 * `linked` false → the old circle, unchanged: an unlinked port is capped by
 * `capPort()` with a solid disc of `PORT_RADIUS`, and cutting a doorway there
 * would open the module to space around the cap.
 *
 * `linked` true → the union of that circle and the doorway. Both regions are a
 * single y-interval at every x, so their union is too, which is why this can be
 * a simple closed polygon: walk the upper boundary left to right, then the lower
 * boundary back.
 */
function portHolePath(linked: boolean): THREE.Path {
  const path = new THREE.Path();
  if (!linked) {
    path.absarc(0, 0, PORT_RADIUS, 0, Math.PI * 2, true);
    return path;
  }

  // Half-width of the union at its widest: the circle is wider than the slot.
  const halfW = Math.max(PORT_RADIUS, DOORWAY_HALF_W);
  const circleTop = (x: number): number =>
    Math.sqrt(Math.max(0, PORT_RADIUS * PORT_RADIUS - x * x));
  const archTop = (x: number): number =>
    Math.abs(x) <= DOORWAY_HALF_W
      ? Math.sqrt(Math.max(0, DOORWAY_TOP * DOORWAY_TOP - x * x))
      : -Infinity;

  const xs: number[] = [];
  const steps = DOORWAY_SEGMENTS * 2;
  for (let i = 0; i <= steps; i++) xs.push(-halfW + (2 * halfW * i) / steps);
  // Force a sample exactly at each slot edge so the corner is square, not
  // chamfered by whatever the sampling happened to land on.
  xs.push(-DOORWAY_HALF_W, DOORWAY_HALF_W);
  xs.sort((a, b) => a - b);

  const top = xs.map((x) => Math.max(circleTop(x), archTop(x)));
  const bottom = xs.map((x) =>
    Math.abs(x) <= DOORWAY_HALF_W ? Math.min(-circleTop(x), DOORWAY_SILL) : -circleTop(x),
  );

  path.moveTo(xs[0] as number, top[0] as number);
  for (let i = 1; i < xs.length; i++) path.lineTo(xs[i] as number, top[i] as number);
  for (let i = xs.length - 1; i >= 0; i--) path.lineTo(xs[i] as number, bottom[i] as number);
  path.closePath();
  return path;
}

/**
 * Bulkhead: the wall between `outer` and the hole in the middle of it.
 *
 * Was a plain `RingGeometry`; it is a shape when — and only when — the hole is a
 * LINKED port's opening, because that opening is the circle-plus-doorway union
 * above and no ring can express it.
 *
 * `portHolePath` only knows how to cut a hole of `PORT_RADIUS`, so every OTHER
 * `inner` has to stay a ring. The cupola's collar-to-dome skirt is the one that
 * matters: it is `annulus(CUPOLA_COLLAR_R, CUPOLA_R)`, and routing it through
 * the shape path silently replaced its 1.25 m hole with a 0.7 m one — a solid
 * wall across the middle of the room, sealing the dome off from its own
 * corridor. `walkable.ts` caught it as "cannot reach port 'dock'"; the assert
 * below is so the next `inner` that is not a port radius fails loudly instead.
 */
function annulus(inner: number, outer: number, linked = false): THREE.BufferGeometry {
  if (!linked) {
    return new THREE.RingGeometry(inner, outer, RADIAL_SEGMENTS, 1);
  }
  if (inner !== PORT_RADIUS) {
    throw new Error(
      `annulus: a linked port's hole is always PORT_RADIUS, got inner=${inner} — ` +
        'portHolePath() cannot cut any other size',
    );
  }
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  shape.holes.push(portHolePath(linked));
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

/** The kit's fifth piece: the cap that closes a port nothing is linked to. */
function endcapDome(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(
    PORT_RADIUS,
    ENDCAP_WIDTH_SEGMENTS,
    ENDCAP_HEIGHT_SEGMENTS,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  g.rotateX(Math.PI / 2);
  g.scale(1, 1, 0.45);
  return g;
}

function portRim(radius = PORT_RADIUS): THREE.BufferGeometry {
  return new THREE.TorusGeometry(radius, 0.055, RIM_RADIAL_SEGMENTS, RIM_TUBULAR_SEGMENTS);
}

function solidDisc(radius: number): THREE.BufferGeometry {
  return new THREE.CircleGeometry(radius, RADIAL_SEGMENTS);
}

function box(size: Vec3): THREE.BufferGeometry {
  return new THREE.BoxGeometry(size.x, size.y, size.z);
}

// ---------------------------------------------------------------------------
// Module shells
// ---------------------------------------------------------------------------

/**
 * Build every piece of geometry for one placed module, in module space.
 * `module.ports[].link` decides whether a port gets an open bulkhead ring or a
 * solid endcap — that is the whole "endcap kit piece", instanced off port data.
 */
export function buildModuleShell(module: StationModule, piece: KitPiece = KIT[module.kind]): ShellGeometry {
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
  return shell;
}

// ---------------------------------------------------------------------------
// The deck (§4)
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
 * the same reason: one source of truth for which way the door is.
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

function buildTubeShell(shell: ShellGeometry, module: StationModule, piece: KitPiece): void {
  const r = piece.radius;
  const len = piece.length;
  shell.hull.push(tube(r, len));
  shell.collision.push(tube(r, len));

  for (const port of module.ports) {
    // Same shape into `trim` and into `collision`: the bulkhead you can see is
    // exactly the bulkhead you can walk into.
    const linked = port.link !== null;
    const ring = toPort(annulus(PORT_RADIUS, r, linked), port);
    shell.trim.push(ring);
    shell.collision.push(toPort(annulus(PORT_RADIUS, r, linked), port));
    capPort(shell, port);
  }
}

function buildNodeShell(shell: ShellGeometry, module: StationModule, piece: KitPiece): void {
  const h = piece.radius;
  for (const port of module.ports) {
    // Every node face is a square with the hatch punched out of its middle.
    const linked = port.link !== null;
    shell.hull.push(toPort(faceWithHole(h, linked), port));
    shell.collision.push(toPort(faceWithHole(h, linked), port));
    capPort(shell, port);
  }
}

function buildCupolaShell(shell: ShellGeometry, module: StationModule, piece: KitPiece): void {
  const port = module.ports[0] as Port;
  const collarR = CUPOLA_COLLAR_R;
  const domeR = piece.radius;
  const portZ = port.localPos.z;
  const domeZ = portZ + 0.75;

  const collar = tube(collarR, 0.75);
  collar.translate(0, 0, portZ + 0.375);
  shell.hull.push(collar);
  shell.collision.push(collar.clone());

  const dome = new THREE.SphereGeometry(
    domeR,
    DOME_SEGMENTS,
    12,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  dome.rotateX(Math.PI / 2);
  dome.translate(0, 0, domeZ);
  shell.hull.push(dome);
  shell.collision.push(dome.clone());

  // Skirt joining the collar to the dome's equator, and the bulkhead ring.
  const skirt = annulus(collarR, domeR);
  skirt.translate(0, 0, domeZ);
  shell.trim.push(skirt);
  shell.collision.push(skirt.clone());

  const collarLinked = port.link !== null;
  shell.trim.push(toPort(annulus(PORT_RADIUS, collarR, collarLinked), port));
  shell.collision.push(toPort(annulus(PORT_RADIUS, collarR, collarLinked), port));
  capPort(shell, port);

  // Seven windows: six around the skirt of the dome, one at the apex (§2 flavour).
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
}

function pane(
  radius: number,
  dir: THREE.Vector3,
  domeR: number,
  domeZ: number,
): THREE.BufferGeometry {
  const g = solidDisc(radius);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  g.applyQuaternion(q);
  g.translate(dir.x * (domeR - 0.02), dir.y * (domeR - 0.02), domeZ + dir.z * (domeR - 0.02));
  return g;
}

function paneFrame(
  radius: number,
  dir: THREE.Vector3,
  domeR: number,
  domeZ: number,
): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(radius, 0.05, 5, 14);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  g.applyQuaternion(q);
  g.translate(dir.x * (domeR - 0.02), dir.y * (domeR - 0.02), domeZ + dir.z * (domeR - 0.02));
  return g;
}

/** Unlinked port → endcap (solid, visible, and solid in the BVH).
 *  Linked port → nothing here; the shared hatch assembly owns the rim. */
function capPort(shell: ShellGeometry, port: Port): void {
  if (port.link) return;
  shell.trim.push(toPort(endcapDome(), port));
  shell.trim.push(toPort(portRim(), port));
  shell.collision.push(toPort(solidDisc(PORT_RADIUS), port));
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Unit archetype geometry, centred on the origin, +Y into the room. */
export function buildPropGeometry(kind: PropKind): THREE.BufferGeometry {
  switch (kind) {
    case 'rack': {
      const size = PROP_ARCHETYPES.rack.size;
      const body = box(size);
      const railTop = box({ x: size.x * 0.94, y: 0.05, z: 0.07 });
      railTop.translate(0, size.y / 2, size.z * 0.32);
      const railBottom = railTop.clone();
      railBottom.translate(0, 0, -size.z * 0.64);
      const handle = box({ x: size.x * 0.2, y: 0.06, z: 0.06 });
      handle.translate(0, size.y / 2 + 0.02, 0);
      return mergeGeometries([body, railTop, railBottom, handle], false);
    }
    case 'cable': {
      const g = new THREE.CylinderGeometry(
        PROP_ARCHETYPES.cable.radius,
        PROP_ARCHETYPES.cable.radius,
        PROP_ARCHETYPES.cable.length,
        8,
        1,
      );
      g.rotateX(Math.PI / 2);
      return g;
    }
    case 'stowage': {
      const size = PROP_ARCHETYPES.stowage.size;
      const body = box(size);
      const strap = box({ x: size.x + 0.02, y: 0.05, z: 0.06 });
      strap.translate(0, 0, size.z * 0.2);
      return mergeGeometries([body, strap], false);
    }
    case 'laptop': {
      const size = PROP_ARCHETYPES.laptop.size;
      const base = box(size);
      const screen = box({ x: size.x, y: 0.02, z: size.z });
      screen.translate(0, 0, -size.z / 2);
      screen.rotateX(-Math.PI / 3);
      screen.translate(0, 0, -size.z / 2);
      return mergeGeometries([base, screen], false);
    }
    case 'slot': {
      const size = PROP_ARCHETYPES.slot.size;
      const parts: THREE.BufferGeometry[] = [];
      const bar = box({ x: size.x, y: size.y, z: 0.05 });
      const a = bar.clone();
      a.translate(0, 0, size.z / 2);
      const b = bar.clone();
      b.translate(0, 0, -size.z / 2);
      const side = box({ x: 0.05, y: size.y, z: size.z });
      const c = side.clone();
      c.translate(size.x / 2, 0, 0);
      const d = side.clone();
      d.translate(-size.x / 2, 0, 0);
      parts.push(a, b, c, d);
      return mergeGeometries(parts, false);
    }
    case 'hub':
      return new THREE.SphereGeometry(PROP_ARCHETYPES.hub.radius, 12, 8);
    case 'bulkhead': {
      const size = PROP_ARCHETYPES.bulkhead.size;
      const web = box(size);
      // A grab edge along the open side, at the height a hand reaches for it.
      const lip = box({ x: 0.06, y: 0.06, z: size.z + 0.06 });
      lip.translate(size.x / 2, size.y / 2 - 0.12, 0);
      return mergeGeometries([web, lip], false);
    }
    case 'bench': {
      const size = PROP_ARCHETYPES.bench.size;
      const top = box({ x: size.x, y: 0.08, z: size.z });
      top.translate(0, size.y / 2 - 0.04, 0);
      const body = box({ x: size.x - 0.12, y: size.y - 0.08, z: size.z - 0.1 });
      body.translate(0, -0.04, 0);
      return mergeGeometries([top, body], false);
    }
    case 'bank': {
      const size = PROP_ARCHETYPES.bank.size;
      const body = box(size);
      const shelfA = box({ x: size.x + 0.04, y: 0.05, z: size.z + 0.04 });
      shelfA.translate(0, size.y * 0.14, 0);
      const shelfB = shelfA.clone();
      shelfB.translate(0, -size.y * 0.3, 0);
      return mergeGeometries([body, shelfA, shelfB], false);
    }
    case 'cargo-rack': {
      const size = PROP_ARCHETYPES['cargo-rack'].size;
      const back = box({ x: size.x, y: 0.06, z: size.z });
      back.translate(0, -size.y / 2 + 0.03, 0);
      const parts: THREE.BufferGeometry[] = [back];
      // Uprights between the five slots, so the rack reads as five bays.
      for (let i = 0; i <= 5; i++) {
        const rib = box({ x: size.x, y: size.y, z: 0.05 });
        rib.translate(0, 0, -size.z / 2 + (i * size.z) / 5);
        parts.push(rib);
      }
      return mergeGeometries(parts, false);
    }
    case 'cargo-bag': {
      const size = PROP_ARCHETYPES['cargo-bag'].size;
      const body = box(size);
      const strap = box({ x: size.x + 0.02, y: 0.05, z: 0.06 });
      const handle = box({ x: 0.08, y: 0.05, z: 0.16 });
      handle.translate(0, size.y / 2 + 0.02, 0);
      return mergeGeometries([body, strap, handle], false);
    }
    case 'locker': {
      const size = PROP_ARCHETYPES.locker.size;
      return box(size);
    }
    case 'panel': {
      const size = PROP_ARCHETYPES.panel.size;
      return box(size);
    }
    default:
      return new THREE.BoxGeometry(0.2, 0.2, 0.2);
  }
}

/** Locker body and its hinged door, as separate geometries so the door swings. */
export function buildLockerParts(): { body: THREE.BufferGeometry; door: THREE.BufferGeometry } {
  const size = PROP_ARCHETYPES.locker.size;
  const body = box({ x: size.x, y: size.y, z: size.z });
  // Door pivots on its -X edge: shift the geometry so the pivot sits at origin.
  const door = box({ x: size.x - 0.04, y: 0.04, z: size.z - 0.04 });
  const latch = box({ x: 0.08, y: 0.05, z: 0.12 });
  latch.translate((size.x - 0.04) / 2 - 0.08, 0.03, 0);
  const merged = mergeGeometries([door, latch], false);
  merged.translate((size.x - 0.04) / 2, 0, 0);
  return { body, door: merged };
}

/** Panel body and the flat face a CanvasTexture gets mapped onto (§6). */
export function buildPanelParts(): { body: THREE.BufferGeometry; screen: THREE.BufferGeometry } {
  const size = PROP_ARCHETYPES.panel.size;
  const body = box(size);
  const screen = new THREE.PlaneGeometry(size.x * 0.86, size.z * 0.82);
  // The plane faces +Z by default; rotate it to face +Y (into the room).
  screen.rotateX(-Math.PI / 2);
  screen.translate(0, size.y / 2 + 0.005, 0);
  return { body, screen };
}

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
// Handrails and hatches
// ---------------------------------------------------------------------------

/** Unit handrail: a cylinder of length 1 along +Y, so one instance matrix can
 *  stretch it onto any RailSegment. */
export function buildRailGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(RAIL_RADIUS, RAIL_RADIUS, 1, 8, 1);
}

export interface HatchGeometry {
  frame: THREE.BufferGeometry;
  door: THREE.BufferGeometry;
  bolt: THREE.BufferGeometry;
  indicator: THREE.BufferGeometry;
}

/**
 * Hatch parts, built in a local frame where +Z is the port's outward normal and
 * the door hinges about the -X edge.
 */
export function buildHatchGeometry(): HatchGeometry {
  const frame = mergeGeometries(
    [portRim(PORT_RADIUS), portRim(PORT_RADIUS + 0.12)],
    false,
  );

  const disc = new THREE.CylinderGeometry(PORT_RADIUS - 0.04, PORT_RADIUS - 0.04, 0.07, RADIAL_SEGMENTS, 1);
  disc.rotateX(Math.PI / 2);
  const wheel = new THREE.TorusGeometry(0.24, 0.035, 5, 12);
  wheel.translate(0, 0, 0.06);
  const spoke = new THREE.BoxGeometry(0.46, 0.05, 0.03);
  spoke.translate(0, 0, 0.06);
  const door = mergeGeometries([disc, wheel, spoke], false);
  // Shift so the hinge edge sits at the origin; the pivot group rotates about +Y.
  door.translate(PORT_RADIUS + 0.02, 0, 0);

  const bolt = new THREE.BoxGeometry(0.16, 0.07, 0.09);
  const indicator = new THREE.BoxGeometry(0.13, 0.06, 0.04);
  return { frame, door, bolt, indicator };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/** Merge a list into one geometry, or null if the list is empty. Disposes the
 *  inputs — they exist only to be merged. */
export function mergeAndDispose(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (list.length === 0) return null;
  const merged = list.length === 1 ? list[0] as THREE.BufferGeometry : mergeGeometries(list, false);
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
