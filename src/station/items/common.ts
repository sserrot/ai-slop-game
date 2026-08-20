/**
 * The carryables' shared vocabulary — ISS-CAR-01…06 (asset bible, "Carryables").
 *
 * Six items, one material. Everything a carryable is made of goes through
 * `paint()` into a `color` attribute and merges into ONE geometry carrying
 * `StationMaterials.vertexPainted` (the palette's single vertex-coloured
 * program, already linked at boot). The reason is a draw-call one and it is
 * worth spelling out, because it is the constraint that shaped every builder in
 * this folder:
 *
 *   A carryable exists in the world (instanced, one `InstancedMesh` per kind)
 *   and in the player's hand (one mesh). If a medkit needed a plastic shell
 *   material AND a webbing material AND an aluminium material, that would be
 *   three `InstancedMesh`es per kind — eighteen draw calls for six items that
 *   are mostly sitting in a closed locker. Vertex colour collapses all of it to
 *   one, at the cost of a single shared roughness/metalness, which at five
 *   candela through fog is a difference nobody has ever seen.
 *
 * Colour values are read out of `PALETTE`, never retyped, so a palette retune
 * moves the items with it.
 *
 * THE CANONICAL FRAME, obeyed by all six builders:
 *
 *   • Origin sits on the surface the item RESTS on: `y = 0` is the deck, the
 *     shelf, the locker floor. So a placement is `pos.y = DECK_Y_M` with no
 *     arithmetic, exactly like `rubberFoot`.
 *   • +Y is up. +Z is the item's FACE — the side its accent is on, the side a
 *     player reads. Business ends that must point away from the holder (the
 *     extinguisher horn, the pry bar claw) point along ±X instead, so the held
 *     pose can swing them forward without turning the face away.
 *   • Metres, always. No unit shapes to be scaled later.
 */

import * as THREE from 'three';
import type { AccentShape, Axis, Size3 } from '../artKit';
import { orientAxis, withVertexColor } from '../artKit';
import { HAZARD_DARK, HAZARD_YELLOW, PALETTE } from '../materials';

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/**
 * Every hex a carryable is allowed to be, pulled from the palette.
 *
 * Two carryables must never be told apart by hue alone (rule 7), so this table
 * is deliberately short: it exists to keep the six items INSIDE the station's
 * palette, not to give each one a signature colour. The signature is the
 * outline.
 */
export const HEX = Object.freeze({
  /** Medkit shell — the palette's suit white, the lightest thing you can hold. */
  shell: PALETTE.suit.color,
  /** Laminated card stock / soft goods. */
  card: PALETTE.stowage.color,
  /** Machined aluminium: valve bodies, collars, grommets. */
  metal: PALETTE.aluminium.color,
  /** Steel: bar stock, bolt heads, hinge pins. */
  steel: PALETTE.frame.color,
  /** Bright metal that catches a torch — fuse caps, a pull ring. */
  brass: PALETTE.brass.color,
  /** Moulded rubber: grips, bumpers, boots, a horn. */
  rubber: PALETTE.rubber.color,
  /** Woven strap. The only thing in the palette that says a person put it there. */
  webbing: PALETTE.webbing.color,
  /** Dark instrument body — gauge cans, a decoy shell. */
  dark: PALETTE.panelBody.color,
  /** Smoked glass. */
  glass: PALETTE.laptop.color,
  /** Rubber hose. */
  hose: PALETTE.cable.color,
  /** Painted fitting. */
  paint: PALETTE.painted.color,
  /** Hazard yellow. Safety equipment and warning markings only. */
  yellow: HAZARD_YELLOW,
  /** Stencil dark, the other half of every hazard pair. */
  stencil: HAZARD_DARK,
});

/** Paint a part and return it, so a parts list reads as one expression. */
export function paint(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  return withVertexColor(geometry, hex);
}

// ---------------------------------------------------------------------------
// What a builder returns
// ---------------------------------------------------------------------------

/**
 * Where an item's one accent goes, in the canonical frame.
 *
 * Items are the reason the accent convention exists: a medkit in an unlit
 * locker is invisible without it, and the bible gives every one of the six a
 * lit cue (`lit cross`, `arming light`, `filament`, `edge tag`, `charge gauge`,
 * `grip band`). One per item, always amber, always `interact: 'carryable'`.
 */
export interface AccentSpot {
  readonly at: Size3;
  readonly normal: Size3;
  readonly shape: AccentShape;
}

/** One carryable, built. `geometry` is vertex-painted and ready to merge into
 *  nothing else — it IS the whole body. */
export interface ItemBuild {
  readonly geometry: THREE.BufferGeometry;
  readonly accent: AccentSpot;
}

/** A carryable builder. Called once per kind, cached by `items.ts`. */
export type ItemBuilder = () => ItemBuild;

// ---------------------------------------------------------------------------
// Two primitives artKit does not have, both needed by more than one item
// ---------------------------------------------------------------------------

type V3 = readonly [number, number, number];

/**
 * A small indexed builder — position / normal / uv / color, flat-shaded per
 * face, wound counter-clockwise from the front.
 *
 * artKit keeps its own copy private, deliberately: this one always writes a
 * `color` attribute, because everything in this folder is vertex-painted.
 */
class Weld {
  private readonly position: number[] = [];
  private readonly normal: number[] = [];
  private readonly uv: number[] = [];
  private readonly color: number[] = [];
  private readonly index: number[] = [];
  private verts = 0;

  quad(a: V3, b: V3, c: V3, d: V3, tint: THREE.Color, uvs?: readonly V2[]): void {
    const n = faceNormal(a, b, c);
    const base = this.verts;
    const corners: V3[] = [a, b, c, d];
    const fallback: V2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let i = 0; i < 4; i++) {
      const p = corners[i] as V3;
      const t = (uvs ?? fallback)[i] as V2;
      this.push(p, n, t, tint);
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  tri(a: V3, b: V3, c: V3, tint: THREE.Color, uvs?: readonly V2[]): void {
    const n = faceNormal(a, b, c);
    const base = this.verts;
    const corners: V3[] = [a, b, c];
    const fallback: V2[] = [
      [0, 0],
      [1, 0],
      [0.5, 1],
    ];
    for (let i = 0; i < 3; i++) {
      this.push(corners[i] as V3, n, (uvs ?? fallback)[i] as V2, tint);
    }
    this.index.push(base, base + 1, base + 2);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    g.setIndex(this.index);
    return g;
  }

  private push(p: V3, n: V3, t: V2, tint: THREE.Color): void {
    this.position.push(p[0], p[1], p[2]);
    this.normal.push(n[0], n[1], n[2]);
    this.uv.push(t[0], t[1]);
    this.color.push(tint.r, tint.g, tint.b);
    this.verts++;
  }
}

type V2 = readonly [number, number];

function faceNormal(a: V3, b: V3, c: V3): V3 {
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
  return [nx, ny, nz];
}

/**
 * A banded ring wrapped around a cylinder: `segments × 2` triangles, the outer
 * face only, colours alternating segment by segment.
 *
 * This is how a carryable gets hazard striping on a round body. `artKit`'s
 * `hazardStripeBand` is a flat slab and cannot wrap, and painting a whole ring
 * one colour would make the band a HUE cue — which rule 7 forbids as the only
 * cue. Alternating light and dark segments is a COUNT and a pattern: it survives
 * every colour-vision deficiency and it survives a torch beam that has washed
 * all the hue out of the yellow anyway.
 *
 * Built as a zero-thickness cuff about `axis`, centred on the origin, facing
 * outward. Lay it on a body at `radius` slightly larger than the body's — it is
 * paint, not a part.
 */
export function stripedRing(
  radius: number,
  height: number,
  segments: number,
  colorA: number,
  colorB: number,
  axis: Axis = 'y',
): THREE.BufferGeometry {
  const n = Math.max(3, Math.floor(segments));
  const h = height / 2;
  const tints = [new THREE.Color(colorA), new THREE.Color(colorB)];
  const weld = new Weld();
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const x0 = Math.cos(a0) * radius;
    const z0 = Math.sin(a0) * radius;
    const x1 = Math.cos(a1) * radius;
    const z1 = Math.sin(a1) * radius;
    const tint = tints[i % 2] as THREE.Color;
    // Wound so the face normal points away from the axis. An inward normal on a
    // band is invisible in an editor and black under one flashlight.
    weld.quad([x0, -h, z0], [x0, h, z0], [x1, h, z1], [x1, -h, z1], tint);
  }
  return orientAxis(weld.build(), axis, 'y');
}

/**
 * A flat prism from a convex outline: `n × 2` side triangles plus `n` per cap.
 *
 * One asset needs it — the sequence card, whose whole identity is an asymmetric
 * outline (a clipped corner and a punched corner: "the only flat asset… reads as
 * paperwork"). A `chamferedBox` clips all four corners symmetrically, which
 * reads as a rounded tile and tells a player nothing about which way up the
 * card is. So the outline is authored by hand.
 *
 * Built in the XY plane, extruded along Z and centred on z = 0. The +Z cap gets
 * UVs spanning 0…1 over the outline's bounding box, so the card's face can take
 * a `CanvasTexture` later with no redesign — that is a bible requirement for
 * this asset, and the reason the UVs are not left to chance.
 *
 * `outline` must be convex and wound counter-clockwise seen from +Z.
 */
export function flatPolyPrism(
  outline: readonly V2[],
  thickness: number,
  color: number,
): THREE.BufferGeometry {
  if (outline.length < 3) throw new Error('flatPolyPrism: need at least three points');
  const t = thickness / 2;
  const tint = new THREE.Color(color);
  const weld = new Weld();

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of outline) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    cx += x;
    cy += y;
  }
  cx /= outline.length;
  cy /= outline.length;
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const faceUv = (x: number, y: number): V2 => [(x - minX) / spanX, (y - minY) / spanY];

  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i] as V2;
    const [x1, y1] = outline[(i + 1) % n] as V2;
    // Rim. CCW outline => (dy, -dx) is outward, which this winding produces.
    weld.quad([x0, y0, -t], [x1, y1, -t], [x1, y1, t], [x0, y0, t], tint);
    // Front cap (+Z) as a fan from the centroid, then the back cap reversed.
    weld.tri([cx, cy, t], [x0, y0, t], [x1, y1, t], tint, [
      faceUv(cx, cy),
      faceUv(x0, y0),
      faceUv(x1, y1),
    ]);
    weld.tri([cx, cy, -t], [x1, y1, -t], [x0, y0, -t], tint, [
      faceUv(cx, cy),
      faceUv(x1, y1),
      faceUv(x0, y0),
    ]);
  }
  return weld.build();
}

// ---------------------------------------------------------------------------
// Small conveniences the builders all want
// ---------------------------------------------------------------------------

/** A capped cone/cylinder section, painted. `rTop`/`rBottom` along +Y. */
export function tube(
  rTop: number,
  rBottom: number,
  height: number,
  segments: number,
  hex: number,
  opts: { open?: boolean; axis?: Axis } = {},
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(
    rTop,
    rBottom,
    height,
    Math.max(3, segments),
    1,
    opts.open === true,
  );
  return paint(orientAxis(g, opts.axis ?? 'y', 'y'), hex);
}

/** Move a part into place. Mutates and returns, so parts lists stay flat. */
export function at(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z = 0,
): THREE.BufferGeometry {
  geometry.translate(x, y, z);
  return geometry;
}

/** Rotate about +Z then translate — the two things a bent part needs. */
export function bent(
  geometry: THREE.BufferGeometry,
  radians: number,
  x: number,
  y: number,
  z = 0,
): THREE.BufferGeometry {
  geometry.rotateZ(radians);
  geometry.translate(x, y, z);
  return geometry;
}
