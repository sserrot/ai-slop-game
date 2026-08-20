/**
 * artKit — the shared geometry vocabulary for every asset in the station.
 *
 * Six agents are building 41 assets against `materials.ts` and this file. Its
 * whole reason to exist is that none of them should have to invent a chamfer, a
 * hinge or a hazard band, and that a latch on a locker should be the same latch
 * as the one on a hide spot. Detail that repeats belongs here; detail that is
 * unique to one asset belongs in that asset.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FOUR RULES EVERY HELPER OBEYS
 *
 *  1. **Dimensions are METRES, always, and always explicit.** No unit cubes to
 *     be scaled later: a scale on the matrix scales the chamfer and the rib
 *     spacing with it, and doll furniture is the single most common failure in
 *     this kind of work. Scale comes from `@shared/constants` and
 *     `deckKit.ts` — 1.55 m standing eye, 0.85 crouched, 0.35 m body radius,
 *     0.40 m step-over, 0.75 m stride — never from taste.
 *
 *  2. **Everything returns a `BufferGeometry`, INDEXED, with
 *     `position`/`normal`/`uv`.** That is exactly the attribute set three's own
 *     primitives carry, which is what `mergeGeometries(list, false)` demands:
 *     it refuses to mix indexed with non-indexed and refuses mismatched
 *     attributes. So anything here merges with a `BoxGeometry` and anything
 *     merged can be instanced. The two vertex-coloured helpers
 *     (`hazardStripeBand`, `labelPlate`) add a `color` attribute and therefore
 *     merge only with each other or with `withVertexColor()`-painted geometry —
 *     they also carry the palette's one vertex-coloured material.
 *
 *  3. **Detail goes into the OUTLINE.** A 5 candela torch through fog resolves
 *     a handle, a horn, a claw, a spoke. It never resolves a bevel. So a
 *     "chamfered" box here cuts four edges into an octagonal prism, because
 *     that changes the profile; it does not subdivide, because that would only
 *     change a normal nobody will see.
 *
 *  4. **Nothing allocates geometry per frame or per instance.** Build once at
 *     load, merge, hand it to an `InstancedMesh`. The accent geometry is cached
 *     per shape at module scope for the same reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ACCENT CONVENTION — READ THIS BEFORE YOU MAKE ANYTHING GLOW
 *
 * Emissive is the readability budget and it means one thing: YOU CAN TOUCH
 * THIS. One false positive devalues every true one, so the rule is encoded
 * rather than written down:
 *
 *   • `attachAccent()` is the only sanctioned way to place one, and it demands
 *     an `InteractKind`. There is no member of that union an author of an
 *     equipment rack, a cable bundle or a wall panel could honestly pass — the
 *     type system is the gate.
 *   • Size and brightness are constants (`ACCENT_SIZE_M`, and the palette's
 *     `interact` material), not arguments, so six authors produce one cue.
 *   • `MAX_ACCENTS_PER_ASSET` is 1 and `attachAccent` enforces it in dev.
 *   • `assertInert()` is the other half: point it at a scatter prop and it
 *     proves nothing in the subtree glows.
 *
 * `ACCENT_SIZE_M` is also load-bearing for the palette's coherence argument.
 * `assertPaletteCoherent()` scopes "nothing out-contrasts a handrail" to
 * SURFACE materials, on the grounds that an indicator is a lamp a couple of
 * centimetres across rather than something an object is made of. That is only
 * true while the accent stays small, so `assertArtKitCoherent()` caps it.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ModuleId } from '@shared/types';
import {
  EMISSIVE_BANDS,
  HAZARD_DARK,
  HAZARD_YELLOW,
  PALETTE,
  type AccentChannel,
  type StationMaterials,
} from './materials';
import { InstancedSet } from './instancing';
import type { InstanceEntry } from './instancing';

// ===========================================================================
// Shared vocabulary
// ===========================================================================

/** Full extent of a box in metres, or a direction. Structurally a `Vec3`. */
export interface Size3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Which world axis a helper's long dimension runs along. */
export type Axis = 'x' | 'y' | 'z';

const AXIS_VEC: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/**
 * Rotate a geometry built along `from` so its long axis runs along `to`.
 *
 * Every helper below documents the frame it builds in; this is how you move it.
 * Mutates and returns the geometry, so it chains.
 */
export function orientAxis(
  geometry: THREE.BufferGeometry,
  to: Axis,
  from: Axis = 'y',
): THREE.BufferGeometry {
  if (to === from) return geometry;
  const q = new THREE.Quaternion().setFromUnitVectors(
    AXIS_VEC[from] as THREE.Vector3,
    AXIS_VEC[to] as THREE.Vector3,
  );
  geometry.applyQuaternion(q);
  return geometry;
}

/**
 * Merge a list into one geometry and dispose the inputs.
 *
 * `mergeGeometries` is strict — all indexed or all non-indexed, identical
 * attribute sets — and everything in this file plus every three primitive
 * satisfies it. Throws rather than returning null, because a silent null here
 * shows up as an invisible asset three files away.
 */
export function mergeParts(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 0) throw new Error('artKit.mergeParts: nothing to merge');
  if (parts.length === 1) return parts[0] as THREE.BufferGeometry;
  const merged = mergeGeometries(parts as THREE.BufferGeometry[], false);
  if (!merged) {
    throw new Error(
      'artKit.mergeParts: mergeGeometries refused the list — mixed indexed/non-indexed ' +
        'geometry, or mismatched attributes (did one part come from withVertexColor()?)',
    );
  }
  for (const g of parts) g.dispose();
  return merged;
}

/**
 * Paint a whole geometry one colour and add the `color` attribute.
 *
 * For merging plain primitives into a vertex-coloured stream — the palette's
 * `hazard` material is the one vertex-coloured program in the game, and hazard
 * bands and label plates both ride it, so anything joining them needs colours
 * too. `new THREE.Color(hex)` already converts sRGB to the linear working space
 * (three's colour management is on and the renderer outputs sRGB), so the
 * values written here are the ones the shader wants.
 *
 * Mutates and returns the geometry.
 */
export function withVertexColor(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geometry.attributes.position?.count ?? 0;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geometry;
}

// ---------------------------------------------------------------------------
// Internal: an indexed quad soup with position / normal / uv (+ optional color)
// ---------------------------------------------------------------------------

type V3 = readonly [number, number, number];

class Soup {
  private readonly position: number[] = [];
  private readonly normal: number[] = [];
  private readonly uv: number[] = [];
  private readonly color: number[] = [];
  private readonly index: number[] = [];
  private verts = 0;
  private coloured = false;

  /** Wind a…d counter-clockwise seen from the front; the normal follows. */
  quad(a: V3, b: V3, c: V3, d: V3, tint?: THREE.Color): void {
    const n = faceNormal(a, b, c);
    const base = this.verts;
    for (const [p, u, v] of [
      [a, 0, 0],
      [b, 1, 0],
      [c, 1, 1],
      [d, 0, 1],
    ] as Array<[V3, number, number]>) {
      this.position.push(p[0], p[1], p[2]);
      this.normal.push(n[0], n[1], n[2]);
      this.uv.push(u, v);
      if (tint) {
        this.coloured = true;
        this.color.push(tint.r, tint.g, tint.b);
      } else {
        this.color.push(1, 1, 1);
      }
      this.verts++;
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  tri(a: V3, b: V3, c: V3, tint?: THREE.Color): void {
    const n = faceNormal(a, b, c);
    const base = this.verts;
    for (const [p, u, v] of [
      [a, 0, 0],
      [b, 1, 0],
      [c, 0.5, 1],
    ] as Array<[V3, number, number]>) {
      this.position.push(p[0], p[1], p[2]);
      this.normal.push(n[0], n[1], n[2]);
      this.uv.push(u, v);
      if (tint) {
        this.coloured = true;
        this.color.push(tint.r, tint.g, tint.b);
      } else {
        this.color.push(1, 1, 1);
      }
      this.verts++;
    }
    this.index.push(base, base + 1, base + 2);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.coloured) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    }
    g.setIndex(this.index);
    return g;
  }
}

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

/** A plain box, so callers never reach for `new THREE.BoxGeometry` and get the
 *  argument order wrong. 12 triangles. */
export function box(size: Size3): THREE.BufferGeometry {
  return new THREE.BoxGeometry(size.x, size.y, size.z);
}

// ===========================================================================
// Poly budgets (the art direction, as machinery)
// ===========================================================================

export interface PolyBudget {
  /** What kind of thing this budget is for, echoed in failures. */
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

/**
 * Triangle budgets straight out of the art direction and the asset bible.
 *
 * The `min` matters as much as the `max`. Under-spending is how you get
 * "everything is just blobs and rails" — the current state of the game — and it
 * is a quality bug, not a saving. `assertPolyBudget` throws over the max
 * (a real frame-time cost) and warns under the min (a legibility cost).
 */
export const POLY_BUDGETS = {
  /** Instanced scatter: racks, cables, bags, laptops, slots, hubs. */
  scatterProp: { label: 'instanced scatter prop', min: 100, max: 400 },
  /** Hero carryables: medkit, decoy, fuse, card, extinguisher, pry bar. */
  carryable: { label: 'hero carryable', min: 200, max: 800 },
  /** Puzzle fixtures and set-pieces: breaker, valve, gauge, keyswitch, lever. */
  fixture: { label: 'puzzle fixture', min: 300, max: 1200 },
  /** The alien. Long, thin, pale, no eyes. */
  alien: { label: 'the alien', min: 600, max: 1500 },
  /** Hide-spot shells: bays, bunks, enterable lockers. */
  hideShell: { label: 'hide-spot shell', min: 250, max: 700 },
  /** A module shell — straight, node, cupola, airlock. */
  structure: { label: 'module shell', min: 600, max: 1600 },
  /** Crew body, or the first-person hands. */
  character: { label: 'character body', min: 400, max: 1200 },
  /** One 0.75 m deck panel, spaced to the walk stride. */
  deckPanel: { label: 'deck plating panel', min: 200, max: 340 },
  /** Threshold markers, coaming bands, hazard runs, label plates. */
  marking: { label: 'marking or threshold band', min: 40, max: 200 },
  /** A single accent indicator. Tiny by design — see the header. */
  accent: { label: 'accent indicator', min: 2, max: 40 },
} as const satisfies Record<string, PolyBudget>;

export type PolyBudgetName = keyof typeof POLY_BUDGETS;

/** Triangles in a geometry. Indexed or not, both are handled. */
export function triangleCount(geometry: THREE.BufferGeometry): number {
  if (geometry.index) return geometry.index.count / 3;
  const pos = geometry.attributes.position;
  return pos ? pos.count / 3 : 0;
}

export interface GeometryReport {
  readonly triangles: number;
  readonly vertices: number;
  readonly indexed: boolean;
  readonly attributes: readonly string[];
}

/** Everything worth knowing about a finished geometry, for logging and for the
 *  budget check. Cheap — no allocation beyond the report. */
export function describeGeometry(geometry: THREE.BufferGeometry): GeometryReport {
  return {
    triangles: triangleCount(geometry),
    vertices: geometry.attributes.position?.count ?? 0,
    indexed: geometry.index !== null,
    attributes: Object.keys(geometry.attributes).sort(),
  };
}

export class PolyBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolyBudgetError';
  }
}

function resolveBudget(budget: PolyBudgetName | PolyBudget): PolyBudget {
  return typeof budget === 'string' ? POLY_BUDGETS[budget] : budget;
}

export interface PolyBudgetResult {
  readonly triangles: number;
  readonly budget: PolyBudget;
  readonly over: boolean;
  readonly under: boolean;
  /** Empty when the geometry is inside its budget. */
  readonly message: string;
}

/** Non-throwing form, for tooling and tests that want to report many assets. */
export function checkPolyBudget(
  geometry: THREE.BufferGeometry,
  budget: PolyBudgetName | PolyBudget,
  label = 'geometry',
): PolyBudgetResult {
  const b = resolveBudget(budget);
  const tris = triangleCount(geometry);
  const over = tris > b.max;
  const under = tris < b.min;
  let message = '';
  if (over) {
    message =
      `${label}: ${tris} triangles, over the ${b.min}–${b.max} budget for one ${b.label}. ` +
      `Cut segment counts before you cut shape — the profile is what a torch beam resolves.`;
  } else if (under) {
    message =
      `${label}: only ${tris} triangles against the ${b.min}–${b.max} budget for one ${b.label}. ` +
      `Under-spending is why the station reads as blobs; put the triangles in the silhouette.`;
  }
  return { triangles: tris, budget: b, over, under, message };
}

/**
 * Dev-only budget assertion. Throws when a geometry is over its budget, warns
 * when it is suspiciously under it, and compiles to nothing you will notice in
 * production. Call it once, at build time, next to the `return`.
 *
 * ```ts
 * const g = mergeParts([body, handle, catch_]);
 * assertPolyBudget(g, 'carryable', 'medkit');
 * return g;
 * ```
 */
export function assertPolyBudget(
  geometry: THREE.BufferGeometry,
  budget: PolyBudgetName | PolyBudget,
  label = 'geometry',
): void {
  if (!isDevEnvironment()) return;
  const r = checkPolyBudget(geometry, budget, label);
  if (r.over) throw new PolyBudgetError(r.message);
  if (r.under) console.warn(`artKit: ${r.message}`);
}

// ===========================================================================
// The accent convention
// ===========================================================================

/**
 * Edge length of an accent, in metres. 22 mm.
 *
 * Chosen from the other end: it has to be *findable* with the torch off across
 * a 5 m module and *deniable* as a light source. At 22 mm and
 * `PALETTE.interact`'s output it subtends about 0.25° at 5 m — a clear point of
 * light after the §9 bloom pass, and far too small to wash any surface. It is
 * also the number `assertPaletteCoherent()` leans on when it excludes lamps
 * from "nothing out-contrasts a handrail", so `assertArtKitCoherent()` caps it.
 */
export const ACCENT_SIZE_M = 0.022;
/** Radius of a `'bulb'` accent. Half the quad's edge, so the two read at the
 *  same size from across a module. */
export const ACCENT_BULB_R_M = 0.011;
/** How far an accent stands off its mounting surface. Enough to avoid z-fighting
 *  and to catch a rim of torchlight on its edge. */
export const ACCENT_DEPTH_M = 0.004;
/** Length of a `'bar'` accent, across its long axis. */
export const ACCENT_BAR_LENGTH_M = 0.066;

/**
 * One accent per asset. Not a style guide — a signal-to-noise budget. Two dots
 * on one object teaches a player that dots are decoration.
 */
export const MAX_ACCENTS_PER_ASSET = 1;

/**
 * Shape of the cue. Colour is never the only cue, and neither is shape: pick
 * the one that reads on the surface you are mounting to.
 *
 *  • `dot`  — the default. A small square lamp. Anything you press or pick up.
 *  • `bulb` — a half-dome. Reads from a wider angle than a flat quad, so it is
 *             right for something approached from any side (a valve, a hub).
 *  • `bar`  — a short line. Right where a dot would be lost against a busy
 *             face, or where the accent doubles as a direction (a latch, a
 *             lever throw, a locker door edge).
 */
export type AccentShape = 'dot' | 'bulb' | 'bar';

/**
 * The closed set of things a player can act on, and therefore the closed set of
 * things allowed to glow.
 *
 * `attachAccent` requires one. This union IS the "inert props get none" rule:
 * an author building an equipment rack, a cable bundle, a wall panel, a bench,
 * a bulkhead or a conduit run has nothing here they could honestly pass, and
 * the compiler will not let them invent one. If you find yourself wanting a new
 * member, the question to answer first is "can a player press E on it?"
 */
export type InteractKind =
  /** ISS-CAR — you can pick it up and carry it. */
  | 'carryable'
  /** ISS-PRP-05 — a stowage locker you can loot, or jam. */
  | 'locker'
  /** ISS-GRV-04/05/06/07 — a bay, bunk or locker you can get INSIDE. */
  | 'hide-spot'
  /** §6 canvas readout you can operate. */
  | 'panel'
  /** ISS-PZL-01 breaker levers. */
  | 'breaker'
  /** ISS-PZL-02 coolant valve wheel. */
  | 'valve'
  /** ISS-PZL-03 coolant gauge — you read it aloud, so it has to be lit. */
  | 'gauge'
  /** ISS-PZL-04 keyswitch. */
  | 'keyswitch'
  /** ISS-PZL-05 undock lever, under its cover. */
  | 'undock-lever'
  /** ISS-PRP-07 / ISS-PZL-06 cargo slot — "something goes here". */
  | 'cargo-slot'
  /** ISS-STR-06 pressure hatch. */
  | 'hatch'
  /** ISS-GRV-08 gravity plant. Its stage lamp is the §4 fairness warning. */
  | 'gravity-plant'
  /** ISS-CHR-03 crew ID band. A downed crewmate is a revive target (§10), so
   *  this is an interaction, and the band is how six people tell each other
   *  apart in the dark. */
  | 'crew-id';

/**
 * Assets that must NEVER carry an accent, spelled out so the rule is greppable
 * and so `assertInert` has something to be pointed at. Every one of these is
 * identified by silhouette alone; that is the deal that keeps amber meaningful.
 */
export const INERT_ASSETS: readonly string[] = Object.freeze([
  'rack',
  'cable',
  'stowage',
  'wall-panel',
  'bulkhead',
  'bench',
  'bank',
  'cargo-rack',
  'deck',
  'grating',
  'coaming',
  'overhead-run',
  'lighting-cove',
  'hub-shell',
  'alien',
]);

const accentGeometryCache = new Map<AccentShape, THREE.BufferGeometry>();

/**
 * Geometry for one accent, in a local frame where the MOUNTING SURFACE is the
 * z = 0 plane and the lamp pokes out along +Z.
 *
 * Shared and cached per shape — do not dispose it, and do not mutate it. If you
 * need to bake one into a merged asset, `clone()` first. For a scatter prop
 * kind, do not bake it at all: send the placements to `buildAccentInstances`
 * so every amber dot in the station costs one draw call in total.
 */
export function accentGeometry(shape: AccentShape = 'dot'): THREE.BufferGeometry {
  const hit = accentGeometryCache.get(shape);
  if (hit) return hit;
  let g: THREE.BufferGeometry;
  switch (shape) {
    case 'bulb':
      // 6 × 3 segments = 24 triangles. A dome, not a ball: the lower half is
      // inside whatever it is mounted to.
      g = new THREE.SphereGeometry(ACCENT_BULB_R_M, 6, 3);
      g.translate(0, 0, ACCENT_BULB_R_M * 0.35);
      break;
    case 'bar':
      g = new THREE.BoxGeometry(ACCENT_BAR_LENGTH_M, ACCENT_SIZE_M / 3, ACCENT_DEPTH_M);
      g.translate(0, 0, ACCENT_DEPTH_M / 2);
      break;
    case 'dot':
    default:
      g = new THREE.BoxGeometry(ACCENT_SIZE_M, ACCENT_SIZE_M, ACCENT_DEPTH_M);
      g.translate(0, 0, ACCENT_DEPTH_M / 2);
      break;
  }
  accentGeometryCache.set(shape, g);
  return g;
}

/** Release the shared accent geometry. Teardown only — every accent in the
 *  scene points at these buffers. */
export function disposeAccentGeometry(): void {
  for (const g of accentGeometryCache.values()) g.dispose();
  accentGeometryCache.clear();
}

export interface AccentOptions {
  /**
   * What a player can DO with the thing you are lighting. Required, and it is
   * the whole gate — see `InteractKind`.
   */
  readonly interact: InteractKind;
  /** Local position of the mounting point, in the parent's space, metres. */
  readonly at: Size3;
  /** Outward surface normal at the mounting point. Defaults to +Z. */
  readonly normal?: Size3;
  readonly shape?: AccentShape;
  /**
   * Which channel the lamp speaks on. Defaults to `'amber'` — the accent, "you
   * can act on this". Use another channel only for a STATE lamp on something
   * that already has an accent (a hatch's green/red, a gauge's white, the
   * gravity plant's amber→dark), never as a second way to say "interactable".
   */
  readonly channel?: AccentChannel;
  readonly name?: string;
}

/**
 * Attach the station's one interactable cue to an asset.
 *
 * Consistent size, consistent brightness, consistent shadow and collision
 * behaviour, and a hard dev-time cap of `MAX_ACCENTS_PER_ASSET` per subtree, so
 * six authors working in parallel produce a cue a player can learn once.
 *
 * ```ts
 * const locker = new THREE.Group();
 * locker.add(bodyMesh, doorMesh);
 * attachAccent(locker, materials, {
 *   interact: 'locker',
 *   at: { x: 0.28, y: 0.1, z: 0.25 },   // on the door face, by the latch
 *   normal: { x: 0, y: 0, z: 1 },
 * });
 * ```
 *
 * The mesh it returns never casts into the §9 shadow map (a 22 mm lamp cannot
 * cast anything worth 1024² of texel) and is flagged `noCollide` so a collider
 * builder skips it.
 */
export function attachAccent(
  parent: THREE.Object3D,
  materials: StationMaterials,
  opts: AccentOptions,
): THREE.Mesh {
  const shape = opts.shape ?? 'dot';
  const channel = opts.channel ?? 'amber';
  const material =
    channel === 'amber' ? materials.interact : materials.indicatorFor(channel);
  const mesh = new THREE.Mesh(accentGeometry(shape), material);
  mesh.name = opts.name ?? `accent-${opts.interact}`;
  mesh.position.set(opts.at.x, opts.at.y, opts.at.z);
  if (opts.normal) {
    const n = new THREE.Vector3(opts.normal.x, opts.normal.y, opts.normal.z);
    if (n.lengthSq() > 1e-9) {
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n.normalize());
    }
  }
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.accent = opts.interact;
  mesh.userData.accentChannel = channel;
  mesh.userData.noShadow = true;
  mesh.userData.noCollide = true;
  parent.add(mesh);

  if (isDevEnvironment()) {
    const total = countAccents(parent);
    if (total > MAX_ACCENTS_PER_ASSET) {
      throw new AccentBudgetError(
        `${parent.name || 'asset'} now carries ${total} accents (limit ` +
          `${MAX_ACCENTS_PER_ASSET}). Emissive means "you can touch this"; a second dot on ` +
          `one object teaches the player that dots are decoration. Differentiate by ` +
          `geometry — a latch, a handle, a chevron — not by another lamp.`,
      );
    }
  }
  return mesh;
}

export class AccentBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccentBudgetError';
  }
}

/** How many accents live in a subtree. */
export function countAccents(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (o.userData && o.userData.accent) n++;
  });
  return n;
}

export class InertAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InertAssetError';
  }
}

/**
 * Prove an asset is inert: nothing in the subtree carries an accent, and
 * nothing in it glows harder than a surface is allowed to.
 *
 * The half of the accent convention that cannot be enforced by a type. Call it
 * on every scatter prop, every piece of chase geometry and the alien — the
 * things whose whole contribution is that they DON'T glow. Dev-only; throws
 * `InertAssetError` naming the offender.
 */
export function assertInert(root: THREE.Object3D, label = 'asset'): void {
  if (!isDevEnvironment()) return;
  const offenders: string[] = [];
  root.traverse((o) => {
    if (o.userData && o.userData.accent) {
      offenders.push(`${o.name || o.type} carries an accent (${String(o.userData.accent)})`);
    }
    const mesh = o as Partial<THREE.Mesh>;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      const std = m as Partial<THREE.MeshStandardMaterial>;
      const glowing =
        std.emissiveIntensity !== undefined &&
        std.emissiveIntensity > EMISSIVE_BANDS.surface.max;
      const unmapped = (m as THREE.Material).toneMapped === false;
      if (glowing || (unmapped && std.emissive && std.emissive.getHex() !== 0)) {
        offenders.push(
          `${o.name || o.type} uses self-lit material "${m.name || m.type}" ` +
            `(emissiveIntensity ${String(std.emissiveIntensity)}, toneMapped ${String(
              (m as THREE.Material).toneMapped,
            )})`,
        );
      }
    }
  });
  if (offenders.length > 0) {
    throw new InertAssetError(
      `${label} is supposed to be inert but glows (${offenders.length}):\n  - ` +
        `${offenders.join('\n  - ')}\n` +
        `One false positive devalues every true one — inert props get no accent, ever.`,
    );
  }
}

export interface AccentPlacement {
  readonly module: ModuleId;
  readonly interact: InteractKind;
  /** Module-to-world matrix for the lamp. Build it with `accentMatrix`. */
  readonly matrix: THREE.Matrix4;
}

/**
 * The matrix for an accent mounted at `position` with surface normal `normal`,
 * optionally premultiplied by the prop's own world matrix.
 *
 * `accentGeometry` is built facing +Z, so this is just "point +Z along the
 * normal, then translate" — spelled out here so six authors do not each get the
 * quaternion argument order wrong.
 */
export function accentMatrix(
  position: Size3,
  normal: Size3 = { x: 0, y: 0, z: 1 },
  parentWorld?: THREE.Matrix4,
): THREE.Matrix4 {
  const n = new THREE.Vector3(normal.x, normal.y, normal.z);
  const q =
    n.lengthSq() > 1e-9
      ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n.normalize())
      : new THREE.Quaternion();
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z),
    q,
    new THREE.Vector3(1, 1, 1),
  );
  return parentWorld ? new THREE.Matrix4().multiplyMatrices(parentWorld, m) : m;
}

/**
 * ONE draw call for every accent in the station.
 *
 * The scatter props are `InstancedMesh`es (one per kind) and a per-kind accent
 * mesh would cost a draw call per kind. Accents all share one geometry and one
 * material, so they instead share one `InstancedSet` across every kind — which
 * also keeps them inside the two-hop portal culling, because `InstancedSet`
 * repacks by module.
 *
 * Pass every amber placement in the level, from every prop kind, in one list.
 * A second call for a different `channel` is a second draw call, so only do
 * that for state lamps that genuinely need it.
 */
export function buildAccentInstances(
  materials: StationMaterials,
  placements: readonly AccentPlacement[],
  opts: { shape?: AccentShape; channel?: AccentChannel; name?: string } = {},
): InstancedSet {
  const channel = opts.channel ?? 'amber';
  const material = channel === 'amber' ? materials.interact : materials.indicatorFor(channel);
  const entries: InstanceEntry[] = placements.map((p) => ({ module: p.module, matrix: p.matrix }));
  return new InstancedSet(
    accentGeometry(opts.shape ?? 'dot').clone(),
    material,
    entries,
    opts.name ?? `accents-${channel}`,
  );
}

// ===========================================================================
// Geometry helpers
// ===========================================================================

export interface ChamferedBoxOptions {
  /** Long axis of the prism — the four edges parallel to it get cut. `'y'`. */
  readonly axis?: Axis;
  /** Also cut the two end rings, turning a slab into a lozenge. 0 = flat ends. */
  readonly capChamfer?: number;
}

/**
 * A box with its four long edges cut off — an octagonal prism with rectangular
 * proportions. **32 triangles** flat-ended, 64 with `capChamfer`.
 *
 * Cheap on purpose: it does not subdivide anything. Chamfering the long edges
 * changes the OUTLINE, which is the only thing a 5 candela cone at 4 m
 * resolves; chamfering everything would only smooth normals nobody sees. Use it
 * anywhere a plain box reads as programmer art — equipment cases, fixture
 * bodies, carryable shells, latch plates.
 *
 * `size` is the full extent before the cut, so the prism still fits the
 * bounding box you sized against the player capsule. Built centred on the
 * origin with the long axis along `axis` (default +Y).
 */
export function chamferedBox(
  size: Size3,
  chamfer = 0.02,
  opts: ChamferedBoxOptions = {},
): THREE.BufferGeometry {
  const axis = opts.axis ?? 'y';
  // Work in a canonical frame: length along +Y, cross-section in X/Z.
  const length = axis === 'y' ? size.y : axis === 'x' ? size.x : size.z;
  const u = (axis === 'y' ? size.x : axis === 'x' ? size.y : size.x) / 2;
  const v = (axis === 'y' ? size.z : axis === 'x' ? size.z : size.y) / 2;
  const c = Math.max(0, Math.min(chamfer, u * 0.9, v * 0.9));
  const cap = Math.max(0, Math.min(opts.capChamfer ?? 0, length * 0.45));

  const rings: Array<{ y: number; inset: number }> =
    cap > 0
      ? [
          { y: -length / 2, inset: cap },
          { y: -length / 2 + cap, inset: 0 },
          { y: length / 2 - cap, inset: 0 },
          { y: length / 2, inset: cap },
        ]
      : [
          { y: -length / 2, inset: 0 },
          { y: length / 2, inset: 0 },
        ];

  const soup = new Soup();
  const ringPoints = (inset: number): V3[] => {
    const uu = Math.max(1e-4, u - inset);
    const vv = Math.max(1e-4, v - inset);
    const cc = Math.min(c, uu * 0.9, vv * 0.9);
    return [
      [uu, 0, vv - cc],
      [uu - cc, 0, vv],
      [-(uu - cc), 0, vv],
      [-uu, 0, vv - cc],
      [-uu, 0, -(vv - cc)],
      [-(uu - cc), 0, -vv],
      [uu - cc, 0, -vv],
      [uu, 0, -(vv - cc)],
    ];
  };
  const at = (pts: V3[], i: number, y: number): V3 => {
    const p = pts[i % pts.length] as V3;
    return [p[0], y, p[2]];
  };

  for (let r = 0; r < rings.length - 1; r++) {
    const lo = rings[r] as { y: number; inset: number };
    const hi = rings[r + 1] as { y: number; inset: number };
    const pl = ringPoints(lo.inset);
    const ph = ringPoints(hi.inset);
    for (let i = 0; i < 8; i++) {
      // Wound so the face normal points OUT of the prism. Getting this backwards
      // is invisible on a lit surface and catastrophic under one flashlight:
      // an inward normal makes the face black wherever the cone hits it.
      soup.quad(at(pl, i, lo.y), at(ph, i, hi.y), at(ph, i + 1, hi.y), at(pl, i + 1, lo.y));
    }
  }
  // Caps as fans. 8 triangles each; an octagon is not worth an ear-clipper.
  const bottom = rings[0] as { y: number; inset: number };
  const top = rings[rings.length - 1] as { y: number; inset: number };
  const pb = ringPoints(bottom.inset);
  const pt = ringPoints(top.inset);
  for (let i = 0; i < 8; i++) {
    soup.tri([0, bottom.y, 0], at(pb, i, bottom.y), at(pb, i + 1, bottom.y));
    soup.tri([0, top.y, 0], at(pt, i + 1, top.y), at(pt, i, top.y));
  }
  return orientAxis(soup.build(), axis, 'y');
}

export interface BezelledPanelOptions {
  /** Total front-to-back thickness. Default 0.05. */
  readonly depth?: number;
  /** Width of the raised rim. Default 0.03. */
  readonly bezel?: number;
  /** How far the face sits behind the rim. Default 0.012. */
  readonly recess?: number;
  /** Corner cut on the body's outline. Default 0.008. */
  readonly chamfer?: number;
}

/**
 * A rectangular instrument panel with a raised rim and a recessed face.
 * **80 triangles.**
 *
 * Everything in the station that a player reads or presses is one of these:
 * puzzle panels, breaker faces, gauge surrounds, keyswitch escutcheons. Built
 * centred on the origin, facing +Z.
 *
 * The recess is the point. A flat plate on a wall is invisible in a torch beam;
 * a rim throws a hard shadow line across the face at any grazing angle, and
 * that line is what makes the panel a *thing* rather than a decal. It also
 * gives the §6 canvas readout somewhere to sit that is not coplanar with the
 * wall — put the screen plane at `panelFaceZ(...)`.
 */
export function bezelledPanel(
  width: number,
  height: number,
  opts: BezelledPanelOptions = {},
): THREE.BufferGeometry {
  const depth = opts.depth ?? 0.05;
  const bezel = Math.min(opts.bezel ?? 0.03, width / 3, height / 3);
  const recess = Math.min(opts.recess ?? 0.012, depth * 0.6);
  const chamfer = opts.chamfer ?? 0.008;

  const body = chamferedBox({ x: width, y: height, z: depth - recess }, chamfer, { axis: 'z' });
  body.translate(0, 0, -recess / 2);

  const rimZ = depth / 2 - recess / 2;
  const parts: THREE.BufferGeometry[] = [body];
  const top = box({ x: width, y: bezel, z: recess });
  top.translate(0, height / 2 - bezel / 2, rimZ);
  const bottom = box({ x: width, y: bezel, z: recess });
  bottom.translate(0, -(height / 2 - bezel / 2), rimZ);
  const left = box({ x: bezel, y: height - 2 * bezel, z: recess });
  left.translate(-(width / 2 - bezel / 2), 0, rimZ);
  const right = box({ x: bezel, y: height - 2 * bezel, z: recess });
  right.translate(width / 2 - bezel / 2, 0, rimZ);
  parts.push(top, bottom, left, right);
  return mergeParts(parts);
}

/** Local Z of a `bezelledPanel`'s recessed face — where a readout plane, a
 *  gauge dial or a label plate goes. Add a hair of standoff yourself. */
export function panelFaceZ(depth = 0.05, recess = 0.012): number {
  return depth / 2 - recess;
}

export interface RibbedCylinderOptions {
  readonly axis?: Axis;
  /** Number of raised rings. Default 4. */
  readonly ribs?: number;
  /** How far a rib stands off the barrel. Default 0.012. */
  readonly ribHeight?: number;
  /** Rib width along the axis. Default 0.02. */
  readonly ribWidth?: number;
  /** Barrel segments. Default 10 — enough for a round profile at 2 m. */
  readonly radialSegments?: number;
  /** Cap the barrel ends. Default true. */
  readonly capped?: boolean;
}

/**
 * A cylinder with raised rings along it. **~120 triangles** at defaults
 * (4 ribs, 10 segments).
 *
 * The station's most reusable shape: extinguisher bodies, fuse barrels, conduit
 * runs, tank stubs, valve bodies, junction hub trunks. The ribs are what make a
 * cylinder read as *manufactured* — and, more usefully in a torch beam, they
 * give the moving highlight something to break on, so the object registers as
 * you sweep past it instead of sitting there as a grey tube.
 *
 * Ribs are open-ended rings: their end faces are inside the barrel, which saves
 * `4 × radialSegments` triangles you would never see. Built along `axis`
 * (default +Y), centred on the origin.
 */
export function ribbedCylinder(
  radius: number,
  length: number,
  opts: RibbedCylinderOptions = {},
): THREE.BufferGeometry {
  const seg = Math.max(5, opts.radialSegments ?? 10);
  const ribs = Math.max(0, opts.ribs ?? 4);
  const ribHeight = opts.ribHeight ?? 0.012;
  const ribWidth = Math.min(opts.ribWidth ?? 0.02, length / Math.max(1, ribs * 2));
  const parts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(radius, radius, length, seg, 1, opts.capped === false),
  ];
  for (let i = 0; i < ribs; i++) {
    // Evenly spaced with a half-gap at each end, so a rib never sits exactly on
    // the rim where it would read as a lip instead of a rib.
    const t = (i + 0.5) / ribs;
    const rib = new THREE.CylinderGeometry(
      radius + ribHeight,
      radius + ribHeight,
      ribWidth,
      seg,
      1,
      true,
    );
    rib.translate(0, -length / 2 + t * length, 0);
    parts.push(rib);
  }
  return orientAxis(mergeParts(parts), opts.axis ?? 'y', 'y');
}

export interface WebbingStrapOptions {
  /** How far the middle droops. Default 0.04. Zero gives a flat band. */
  readonly sag?: number;
  /** Strap thickness. Default 0.004 — webbing, not a belt. */
  readonly thickness?: number;
  /** Samples along the run. Default 5, which is 44 triangles. */
  readonly segments?: number;
}

/**
 * A flat woven strap with a catenary droop. **44 triangles** at defaults.
 *
 * The single cheapest way to make the station look lived in. Cargo bag
 * lashings, bunk curtains pushed aside, stowage nets, tool tethers, the two
 * straps a stowage bag is Velcro'd down under. The sag is the whole asset: a
 * straight strap reads as a moulded rib, a sagging one reads as fabric, and
 * fabric is the only thing in this palette that says a person put it there.
 *
 * Runs along +X, width along +Z, sagging toward −Y, centred on the origin.
 * `orientAxis` it if you need it elsewhere.
 */
export function webbingStrap(
  length: number,
  width: number,
  opts: WebbingStrapOptions = {},
): THREE.BufferGeometry {
  const sag = opts.sag ?? 0.04;
  const t = (opts.thickness ?? 0.004) / 2;
  const segs = Math.max(1, opts.segments ?? 5);
  const w = width / 2;
  const soup = new Soup();

  // Parabolic droop: y = -4·sag·s·(1-s), which is the catenary to within a few
  // percent over this span and costs one multiply.
  const sample = (i: number): { x: number; y: number } => {
    const s = i / segs;
    return { x: -length / 2 + s * length, y: -4 * sag * s * (1 - s) };
  };

  for (let i = 0; i < segs; i++) {
    const a = sample(i);
    const b = sample(i + 1);
    // top, bottom, front (+Z), back (-Z)
    soup.quad([a.x, a.y + t, w], [b.x, b.y + t, w], [b.x, b.y + t, -w], [a.x, a.y + t, -w]);
    soup.quad([a.x, a.y - t, -w], [b.x, b.y - t, -w], [b.x, b.y - t, w], [a.x, a.y - t, w]);
    soup.quad([a.x, a.y - t, w], [b.x, b.y - t, w], [b.x, b.y + t, w], [a.x, a.y + t, w]);
    soup.quad([a.x, a.y + t, -w], [b.x, b.y + t, -w], [b.x, b.y - t, -w], [a.x, a.y - t, -w]);
  }
  const first = sample(0);
  const last = sample(segs);
  soup.quad(
    [first.x, first.y - t, -w],
    [first.x, first.y - t, w],
    [first.x, first.y + t, w],
    [first.x, first.y + t, -w],
  );
  soup.quad(
    [last.x, last.y - t, w],
    [last.x, last.y - t, -w],
    [last.x, last.y + t, -w],
    [last.x, last.y + t, w],
  );
  return soup.build();
}

export interface HingeOptions {
  readonly axis?: Axis;
  /** Knuckle radius. Default 0.012. */
  readonly radius?: number;
  /** Number of knuckles. Default 3. */
  readonly knuckles?: number;
  /** How far the pin sticks out past the last knuckle. Default 0.006. */
  readonly pinOverhang?: number;
  /** Knuckle segments. Default 8. */
  readonly radialSegments?: number;
}

/**
 * A barrel hinge: alternating knuckles on a through pin. **~72 triangles.**
 *
 * Put one on every door in the game — hatches, locker doors, the undock lever's
 * safety cover, the enterable locker. It is the cheapest possible answer to
 * "why does this door look like a floating slab": a visible pivot tells the
 * player which edge it swings on before they touch it, which for a hide spot is
 * the difference between committing and hesitating with a blind thing nearby.
 *
 * Built along +Y, centred on the origin, so the geometry's axis IS the rotation
 * axis — parent it to the pivot group and both agree by construction.
 */
export function hinge(length: number, opts: HingeOptions = {}): THREE.BufferGeometry {
  const r = opts.radius ?? 0.012;
  const n = Math.max(1, opts.knuckles ?? 3);
  const seg = Math.max(5, opts.radialSegments ?? 8);
  const overhang = opts.pinOverhang ?? 0.006;
  // n knuckles and n-1 gaps of the same height: 2n-1 slots.
  const slot = length / (2 * n - 1);
  const parts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(r * 0.45, r * 0.45, length + 2 * overhang, 6, 1),
  ];
  for (let i = 0; i < n; i++) {
    const k = new THREE.CylinderGeometry(r, r, slot, seg, 1, true);
    k.translate(0, -length / 2 + slot * (2 * i) + slot / 2, 0);
    parts.push(k);
  }
  return orientAxis(mergeParts(parts), opts.axis ?? 'y', 'y');
}

export interface LatchOptions {
  /** How far the handle stands off the plate. Default 0.03. */
  readonly lift?: number;
  /** Handle bar thickness. Default 0.012. */
  readonly barThickness?: number;
  readonly chamfer?: number;
}

/**
 * A lift-and-turn latch: keeper plate, chamfered cam body, handle bar.
 * **56 triangles.**
 *
 * The bible asks the enterable locker (ISS-GRV-05) to read as "a bigger sibling
 * of ISS-PRP-05, so players generalise the affordance without a tutorial". This
 * is the shape that carries that family resemblance — put the same latch on the
 * small locker and the big one and the generalisation is free.
 *
 * `size` is the keeper plate's extent; the handle grows out along +Z. Built
 * centred on the plate, facing +Z.
 */
export function latch(size: Size3, opts: LatchOptions = {}): THREE.BufferGeometry {
  const lift = opts.lift ?? 0.03;
  const bar = opts.barThickness ?? 0.012;
  const chamfer = opts.chamfer ?? 0.006;
  const plate = box({ x: size.x, y: size.y, z: size.z });
  const cam = chamferedBox(
    { x: size.x * 0.55, y: size.y * 0.55, z: lift * 0.6 },
    chamfer,
    { axis: 'z' },
  );
  cam.translate(0, 0, size.z / 2 + lift * 0.3);
  const handle = box({ x: size.x * 0.9, y: bar, z: bar });
  handle.translate(0, 0, size.z / 2 + lift);
  return mergeParts([plate, cam, handle]);
}

export interface GrilleOptions {
  /** Horizontal bars. Default 5. */
  readonly bars?: number;
  /** Vertical bars crossing them. Default 0. */
  readonly crossBars?: number;
  /** Bar depth, front to back. Default 0.012. */
  readonly depth?: number;
  /** Surround width. 0 for a bare set of bars. Default 0.012. */
  readonly frame?: number;
  /** Bar thickness. Default: a third of the gap, so the vent reads as open. */
  readonly barThickness?: number;
}

/**
 * A vent grille: a surround with bars across it. **~108 triangles** at
 * defaults; `frame: 0` drops 48 of them.
 *
 * Air handling is everywhere on a real station, and here it does a second job:
 * a grille is the readable difference between a rack that is just a box and a
 * rack that is *equipment*. The bible wants the 64 racks in three variants —
 * blank, vented, instrumented — and this is the vented one. It is also the
 * breaker panel's buzzer grille (ISS-PZL-01), which is the only geometry that
 * explains where the wrong-order reset noise comes from.
 *
 * Built in the XY plane facing +Z, centred on the origin.
 */
export function grille(
  width: number,
  height: number,
  opts: GrilleOptions = {},
): THREE.BufferGeometry {
  const bars = Math.max(0, opts.bars ?? 5);
  const cross = Math.max(0, opts.crossBars ?? 0);
  const depth = opts.depth ?? 0.012;
  const frame = Math.max(0, opts.frame ?? 0.012);
  const inner = { x: width - 2 * frame, y: height - 2 * frame };
  const thickness = opts.barThickness ?? Math.max(0.004, inner.y / Math.max(1, bars) / 3);
  const parts: THREE.BufferGeometry[] = [];

  if (frame > 0) {
    const top = box({ x: width, y: frame, z: depth });
    top.translate(0, height / 2 - frame / 2, 0);
    const bottom = box({ x: width, y: frame, z: depth });
    bottom.translate(0, -(height / 2 - frame / 2), 0);
    const left = box({ x: frame, y: height - 2 * frame, z: depth });
    left.translate(-(width / 2 - frame / 2), 0, 0);
    const right = box({ x: frame, y: height - 2 * frame, z: depth });
    right.translate(width / 2 - frame / 2, 0, 0);
    parts.push(top, bottom, left, right);
  }
  for (let i = 0; i < bars; i++) {
    const y = -inner.y / 2 + ((i + 0.5) * inner.y) / bars;
    const b = box({ x: inner.x, y: thickness, z: depth * 0.7 });
    b.translate(0, y, 0);
    parts.push(b);
  }
  for (let i = 0; i < cross; i++) {
    const x = -inner.x / 2 + ((i + 0.5) * inner.x) / cross;
    const b = box({ x: thickness, y: inner.y, z: depth * 0.7 });
    b.translate(x, 0, 0);
    parts.push(b);
  }
  if (parts.length === 0) throw new Error('artKit.grille: no frame and no bars');
  return mergeParts(parts);
}

export interface BoltRingOptions {
  /** Head radius. Default 0.011. */
  readonly boltRadius?: number;
  /** How far a head stands off the face. Default 0.008. */
  readonly height?: number;
  /** Head segments. 5 reads as round, 6 as hex. Default 5. */
  readonly segments?: number;
  /** Face normal the heads point along. Default `'z'`. */
  readonly axis?: Axis;
  /** Rotate the whole ring, so two stacked rings do not line up. Radians. */
  readonly phase?: number;
}

/**
 * A ring of bolt heads on a face. **`count × 4 × segments` triangles** — 120 at
 * the defaults (6 bolts, 5 segments).
 *
 * The station's punctuation. A bolt ring is how a player knows a plate is
 * STRUCTURAL and not a door, which matters a lot when they are looking for
 * something to hide in with a blind thing three metres away and every second of
 * hesitation is another footstep. Hatch collars, pressure plates, the airlock's
 * outer frame, endcaps, gravity plant mounts.
 *
 * Laid out in the plane perpendicular to `axis`, centred on the origin, heads
 * pointing along +axis.
 */
export function boltRing(
  radius: number,
  count: number,
  opts: BoltRingOptions = {},
): THREE.BufferGeometry {
  const n = Math.max(1, Math.floor(count));
  const r = opts.boltRadius ?? 0.011;
  const h = opts.height ?? 0.008;
  const seg = Math.max(4, opts.segments ?? 5);
  const phase = opts.phase ?? 0;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const head = new THREE.CylinderGeometry(r, r, h, seg, 1);
    // Built along +Y; lay it down so it points along +Z, then place it.
    head.rotateX(Math.PI / 2);
    head.translate(Math.cos(a) * radius, Math.sin(a) * radius, h / 2);
    parts.push(head);
  }
  const g = mergeParts(parts);
  // The ring is built facing +Z; orientAxis maps +Z onto the requested axis.
  return orientAxis(g, opts.axis ?? 'z', 'z');
}

export interface RubberFootOptions {
  /** Segments. Default 8. */
  readonly segments?: number;
  /** Top radius as a fraction of the base. Default 0.75 — a squat taper. */
  readonly taper?: number;
  readonly axis?: Axis;
}

/**
 * A tapered rubber foot. **32 triangles.**
 *
 * Four of these under a crate, a bench, a gravity plant or a floor-standing
 * fixture, and the thing is sitting on the deck instead of intersecting it.
 * That gap is worth more than it sounds: the flashlight's one shadow map draws
 * a dark line under a footed object and nothing under a floating one, and the
 * line is what tells the player which side of a bulkhead an object is on.
 *
 * Built along +Y with its BASE on y = 0, so `mesh.position.y = deckY` is
 * correct with no arithmetic.
 */
export function rubberFoot(
  radius: number,
  height: number,
  opts: RubberFootOptions = {},
): THREE.BufferGeometry {
  const seg = Math.max(5, opts.segments ?? 8);
  const taper = opts.taper ?? 0.75;
  const g = new THREE.CylinderGeometry(radius * taper, radius, height, seg, 1);
  g.translate(0, height / 2, 0);
  return orientAxis(g, opts.axis ?? 'y', 'y');
}

export interface LouvreSlatsOptions {
  /** Number of slats. Default 7. */
  readonly slats?: number;
  /** Slat tilt in radians. Default −0.5 — angled down and out, so a standing
   *  player inside sees out and a torch outside does not see in. */
  readonly tilt?: number;
  /** Slat thickness. Default 0.006. */
  readonly thickness?: number;
  /** Slat depth, front to back. Default 0.03. */
  readonly depth?: number;
  /** Surround width. 0 for bare slats. Default 0.012. */
  readonly frame?: number;
}

/**
 * A louvred vent or door panel. **~132 triangles** at defaults.
 *
 * This is the horror of the enterable locker (ISS-GRV-05), and it should be
 * built with that in mind: "Louvres let you see out, which is the whole horror
 * of it — you watch it pass." The slats need to be angled and separate, not a
 * flat panel with lines on it, because the player's eye has to be able to find
 * the gaps between them from inside while a 2.4 m pale thing walks past
 * outside.
 *
 * Built in the XY plane facing +Z, centred on the origin.
 */
export function louvreSlats(
  width: number,
  height: number,
  opts: LouvreSlatsOptions = {},
): THREE.BufferGeometry {
  const slats = Math.max(1, opts.slats ?? 7);
  const tilt = opts.tilt ?? -0.5;
  const thickness = opts.thickness ?? 0.006;
  const depth = opts.depth ?? 0.03;
  const frame = Math.max(0, opts.frame ?? 0.012);
  const inner = { x: width - 2 * frame, y: height - 2 * frame };
  const parts: THREE.BufferGeometry[] = [];

  if (frame > 0) {
    const top = box({ x: width, y: frame, z: depth });
    top.translate(0, height / 2 - frame / 2, 0);
    const bottom = box({ x: width, y: frame, z: depth });
    bottom.translate(0, -(height / 2 - frame / 2), 0);
    const left = box({ x: frame, y: height - 2 * frame, z: depth });
    left.translate(-(width / 2 - frame / 2), 0, 0);
    const right = box({ x: frame, y: height - 2 * frame, z: depth });
    right.translate(width / 2 - frame / 2, 0, 0);
    parts.push(top, bottom, left, right);
  }
  // Slat depth is `depth`, full stop — NOT the depth that would make the panel
  // opaque head-on. Full opacity needs `slats ≥ height / (depth·|sin tilt|)`,
  // which at any affordable slat count means a 20 cm-deep door, and it is the
  // wrong goal anyway: the bible wants louvres you can see OUT of. A hider
  // watching the alien walk past through the gaps is the asset working.
  const pitch = inner.y / slats;
  for (let i = 0; i < slats; i++) {
    const y = -inner.y / 2 + (i + 0.5) * pitch;
    const s = box({ x: inner.x, y: thickness, z: depth });
    s.rotateX(tilt);
    s.translate(0, y, 0);
    parts.push(s);
  }
  return mergeParts(parts);
}

export interface HazardStripeBandOptions {
  /** Number of stripes. Default 8. Even numbers keep both ends the same. */
  readonly stripes?: number;
  /** Slab thickness. Default 0.01 — a band applied ONTO a surface. */
  readonly thickness?: number;
  /** Diagonal lean, as a fraction of the band height. Default 0.35. */
  readonly skew?: number;
  /** Long axis. Default `'x'`. */
  readonly axis?: Axis;
  /** The two stripe colours. Defaults to the palette's hazard pair. */
  readonly colors?: readonly [number, number];
}

/**
 * A diagonally striped hazard band. **`stripes × 6` triangles** — 48 at
 * defaults.
 *
 * Carries `StationMaterials.hazard`, which is the palette's one vertex-coloured
 * material: the stripes are baked into a `color` attribute so a band is one
 * draw call, one program, and instanceable. It therefore merges ONLY with other
 * vertex-coloured geometry (`labelPlate`, or anything you run through
 * `withVertexColor`).
 *
 * Where it earns its keep: the hatch coaming (ISS-GRV-10) is 0.40 m, exactly
 * `STEP_HEIGHT_M`, so you step over it without jumping — but only if you SEE
 * it, and "in the dark a shin-height lip you didn't see is a stumble, and a
 * stumble is noise". Also the undock lever's base, the airlock floor, and the
 * edge of anything that will hurt you.
 *
 * Built as a thin slab running along `axis` with its face toward +Z, centred on
 * the origin. Open at the back and the ends — it is meant to be laid onto
 * geometry, not to float. The diagonal lean makes the total extent along the
 * axis `length + skew × height`, symmetric about the origin.
 */
export function hazardStripeBand(
  length: number,
  height: number,
  opts: HazardStripeBandOptions = {},
): THREE.BufferGeometry {
  const n = Math.max(2, opts.stripes ?? 8);
  const t = (opts.thickness ?? 0.01) / 2;
  const skew = (opts.skew ?? 0.35) * height;
  const [ca, cb] = opts.colors ?? [HAZARD_YELLOW, HAZARD_DARK];
  const tints = [new THREE.Color(ca), new THREE.Color(cb)];
  const soup = new Soup();
  const h = height / 2;
  const sw = length / n;
  // The lean pushes the top of the band `skew` further along the axis, so shift
  // by half of it: the band's extent is `length + skew` and it is symmetric
  // about the origin, which is what a caller placing it on a coaming assumes.
  const x00 = -length / 2 - skew / 2;

  for (let i = 0; i < n; i++) {
    const tint = tints[i % 2] as THREE.Color;
    const x0 = x00 + i * sw;
    const x1 = x0 + sw;
    // Front face, leaning by `skew` from bottom to top.
    soup.quad([x0, -h, t], [x1, -h, t], [x1 + skew, h, t], [x0 + skew, h, t], tint);
    // Top and bottom edges, so the band has a silhouette at grazing angles.
    soup.quad([x0 + skew, h, t], [x1 + skew, h, t], [x1 + skew, h, -t], [x0 + skew, h, -t], tint);
    soup.quad([x0, -h, -t], [x1, -h, -t], [x1, -h, t], [x0, -h, t], tint);
  }
  return orientAxis(soup.build(), opts.axis ?? 'x', 'x');
}

export interface LabelPlateOptions {
  /** Number of extruded bars. Default 3. */
  readonly bars?: number;
  /** Plate thickness. Default 0.006. */
  readonly depth?: number;
  /** How far the bars stand off the plate. Default 0.003. */
  readonly barDepth?: number;
  /** Plate colour. Default the palette's hazard dark. */
  readonly plateColor?: number;
  /** Bar colour. Default the palette's warning yellow. */
  readonly barColor?: number;
}

/**
 * A stencilled label: a dark plate with `bars` raised bars across it.
 * **`12 + bars × 12` triangles** — 48 at defaults.
 *
 * There are no fonts and there never will be — no asset loads, ever — so
 * "labelled" has to mean something geometric. Bars do the job: the station is
 * full of plates that clearly say *something*, and the count is a
 * language-free identifier a player can read at a glance and say out loud on
 * voice comms. That is exactly how the bible numbers the cargo bags: "by band
 * count, not text — one to five stripes, language-free." Use the same trick for
 * module designations, breaker numbering and locker ranks, and colourblindness
 * and localisation both stop being problems.
 *
 * Vertex-coloured, so it carries `StationMaterials.hazard` and merges with
 * `hazardStripeBand`. Built in the XY plane facing +Z, centred on the origin.
 * For a lit tag, add `labelTag()` on a channel material.
 */
export function labelPlate(
  width: number,
  height: number,
  opts: LabelPlateOptions = {},
): THREE.BufferGeometry {
  const bars = Math.max(1, opts.bars ?? 3);
  const depth = opts.depth ?? 0.006;
  const barDepth = opts.barDepth ?? 0.003;
  const plateColor = opts.plateColor ?? HAZARD_DARK;
  const barColor = opts.barColor ?? HAZARD_YELLOW;

  const plate = withVertexColor(box({ x: width, y: height, z: depth }), plateColor);
  const parts: THREE.BufferGeometry[] = [plate];
  // Bars run the short way across the plate, inset so the plate reads as a
  // border. Pitch is 2:1 bar-to-gap, which stays countable at 3 m.
  const usable = height * 0.72;
  const pitch = usable / bars;
  for (let i = 0; i < bars; i++) {
    const y = -usable / 2 + (i + 0.5) * pitch;
    const b = withVertexColor(
      box({ x: width * 0.74, y: pitch * 0.45, z: barDepth }),
      barColor,
    );
    b.translate(0, y, depth / 2 + barDepth / 2);
    parts.push(b);
  }
  return mergeParts(parts);
}

/**
 * The lit tag half of a label: a small slab for a channel material.
 * **12 triangles.**
 *
 * Keep it OFF anything inert. A tag on a rack is a promise the game cannot
 * keep; a tag on a breaker panel telling you which of the six levers is live is
 * the whole point of the fixture. Built facing +Z with its back at z = 0, so it
 * sits on a surface the way `accentGeometry` does.
 */
export function labelTag(width: number, height: number, depth = 0.004): THREE.BufferGeometry {
  const g = box({ x: width, y: height, z: depth });
  g.translate(0, 0, depth / 2);
  return g;
}

// ===========================================================================
// The self-check
// ===========================================================================

export class ArtKitCoherenceError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(`artKit coherence failed (${failures.length}):\n  - ${failures.join('\n  - ')}`);
    this.name = 'ArtKitCoherenceError';
    this.failures = failures;
  }
}

/**
 * artKit's own invariants, and the one that ties this file to the palette.
 *
 * `assertPaletteCoherent()` scopes "nothing out-contrasts a handrail" to
 * surfaces, arguing that an indicator is a lamp a couple of centimetres across
 * rather than something an object is made of. That argument is only sound while
 * the accent stays small, so the cap lives here, next to the constant it caps.
 */
export function assertArtKitCoherent(): void {
  const fail: string[] = [];
  const check = (ok: boolean, msg: string): void => {
    if (!ok) fail.push(msg);
  };

  // 1 — the accent stays a lamp, not a surface.
  check(
    ACCENT_SIZE_M >= 0.012 && ACCENT_SIZE_M <= 0.03,
    `accent size: ${ACCENT_SIZE_M} m is outside 0.012–0.030. Smaller and it is invisible ` +
      `at 8 m even after bloom; larger and it becomes a light source, which would break ` +
      `assertPaletteCoherent()'s reason for excluding lamps from the handrail check.`,
  );
  check(
    ACCENT_SIZE_M * ACCENT_SIZE_M <= 0.001,
    `accent area: ${(ACCENT_SIZE_M * ACCENT_SIZE_M).toFixed(5)} m² exceeds the 0.001 m² cap ` +
      `the palette's handrail check depends on`,
  );
  check(
    MAX_ACCENTS_PER_ASSET === 1,
    `accent budget: MAX_ACCENTS_PER_ASSET is ${MAX_ACCENTS_PER_ASSET}. The art direction is ` +
      `"one small self-lit accent", singular — a second lamp on one object teaches the ` +
      `player that lamps are decoration.`,
  );
  check(
    PALETTE.interact.role === 'accent',
    `accent material: PALETTE.interact has role "${PALETTE.interact.role}", expected "accent"`,
  );
  check(
    ACCENT_BULB_R_M * 2 <= ACCENT_SIZE_M * 1.05,
    `accent shapes: a bulb (⌀ ${(ACCENT_BULB_R_M * 2).toFixed(3)} m) must read the same size ` +
      `as a dot (${ACCENT_SIZE_M} m) so shape carries meaning and size does not`,
  );

  // 2 — every accent shape fits the accent triangle budget.
  for (const shape of ['dot', 'bulb', 'bar'] as AccentShape[]) {
    const r = checkPolyBudget(accentGeometry(shape), 'accent', `accent '${shape}'`);
    check(!r.over, r.message);
  }

  // 3 — the budget table is well-formed and matches the art direction.
  for (const [name, b] of Object.entries(POLY_BUDGETS)) {
    check(b.min > 0 && b.min < b.max, `budget ${name}: ${b.min}–${b.max} is not an ordered range`);
  }
  const anchors: Array<[PolyBudgetName, number, number]> = [
    ['scatterProp', 100, 400],
    ['carryable', 200, 800],
    ['fixture', 300, 1200],
    ['alien', 600, 1500],
    ['hideShell', 250, 700],
  ];
  for (const [name, min, max] of anchors) {
    const b = POLY_BUDGETS[name];
    check(
      b.min === min && b.max === max,
      `budget ${name}: ${b.min}–${b.max} no longer matches the art direction's ${min}–${max}`,
    );
  }

  if (fail.length > 0) throw new ArtKitCoherenceError(fail);
}

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

/** True when the artKit check ran and passed at import time (dev only). */
export const ART_KIT_CHECKED: boolean = (() => {
  if (!isDevEnvironment()) return false;
  assertArtKitCoherent();
  return true;
})();
