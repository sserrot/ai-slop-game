/**
 * Decks, chase geometry and hide spots — the authoring half of the pivot
 * (DESIGN.md §2 "Gravity modules need geometry — corners, not tubes", §4).
 *
 * Pure plain-object code, no three.js: `buildLevel.ts` runs it under tsx to
 * bake `levels/station.json`, and `geometry.ts` turns the `DeckPart`s it emits
 * into meshes. `kit.ts` is the only importer — the split exists because the kit
 * piece table was already long and this is a separate concern.
 *
 * THE DECK IS ONE SURFACE FOR THE WHOLE STATION.
 * `STATION_DOWN` is a single global (§4), every module in the authored layout is
 * centred on y = 0, and every deck is inset by `DECK_Y_M`. So the walking
 * surface is world y = −0.75 in every module, hatch sills line up, and there is
 * not one step anywhere in the station. That uniformity is what lets §4's
 * controller use one `GROUND_PROBE_M` and one `STEP_HEIGHT_M` everywhere, and
 * it is why `validateLayoutGeometry` refuses a `nominal` module whose local +Y
 * is not world up: every position in this file is authored in module space with
 * +Y meaning up, and a rolled module would bury its own floor in a wall.
 *
 * WHY THE FURNITURE IS HERE AND NOT IN A DECORATION PASS.
 * §2: "the props in a straight piece are doing structural design work and should
 * be laid out as such." A bare 5 m tube with a floor is the same countdown as a
 * bare 5 m tube without one — the fleeing player needs a corner, a partial
 * bulkhead, a side bay or a loop, and the alien is blind, so what these break is
 * not its sight but its *committed path*. Every piece below is one of those four
 * things, sized against the numbers that decide whether it works:
 *
 *   • a walker is `2 × PLAYER_RADIUS` = 0.70 m wide, so any lane left open has
 *     to clear `WALK_LANE_M` (0.90 m) or the obstacle is a wall;
 *   • `JUMP_HEIGHT_M` + `STEP_HEIGHT_M` ≈ 0.85 m is the tallest thing you can
 *     vault, which is why the chicane bulkheads are 1.15 m (no shortcut) and the
 *     node console is 0.76 m (a loud shortcut across the middle of the ring).
 *
 * THE CROSS-SECTION BUDGET, which is much tighter than the deck width suggests.
 *
 * A straight is a 1.0 m bore and `DECK_HEADROOM_M` is 1.75 m against a 1.70 m
 * standing collider, so a STANDING body is a 0.35 m sphere swept up to y = 0.60,
 * where the round wall has closed in hard. Solve it and the walker's centre is
 * confined to a radius of 0.662 m about the axis, which at that height means
 * |x| ≤ 0.28: **a nominal straight is single-file for anyone standing up**, and
 * the 1.32 m of deck is mostly shoulder room and floor to look at. Crouching
 * (1.0 m collider, top sphere at y = −0.10) opens that to |x| ≤ 0.65 and gives
 * you the whole deck — which is a nice accident of the numbers rather than a
 * designed one, and worth knowing before tuning anything here.
 *
 * The practical consequences, both learned the hard way:
 *
 *  1. **No two lane-intruding fittings may overlap along the module axis.** Each
 *     one costs about 0.35 m of centre freedom from its own side, and two facing
 *     each other across the same slice of corridor is a wall.
 *  2. **A 1.0 m bore has no room for a body-sized recess at body height.** A
 *     crew bunk deep enough to climb into leaves 0.12 m of standing lane past
 *     it. That is why the straights carry a chicane and no hide spot, and why
 *     every hide spot in this file lives in a node, the lab or the cupola —
 *     the pieces with the bore to afford one.
 *
 * Both are easy to break by moving one prop 30 cm, which is exactly why the
 * check is machinery and not a comment: `walkable.ts` samples the real collider
 * against the real BVH, and `buildLevel` refuses to write a station whose
 * modules a player cannot walk across.
 */

import {
  DECK_Y_M,
  JUMP_HEIGHT_M,
  PLAYER_CROUCH_HEIGHT_M,
  PLAYER_RADIUS,
  PLAYER_STAND_HEIGHT_M,
  STEP_HEIGHT_M,
  STRIDE_WALK_M,
} from '@shared/constants';
import type { HideSpot, ModuleId, PropRef, Quat, Vec3 } from '@shared/types';
import { v3 } from '@shared/graph/math';
import { roundVec } from './transform';

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Deck plate thickness. Structural, not walkable — the top face is `DECK_Y_M`. */
export const DECK_THICKNESS_M = 0.12;
/** Width of the emissive edge run that makes the floor read as a floor (§9). */
export const DECK_EDGE_W = 0.06;
/** Height of the emissive edge run above the deck. */
export const DECK_EDGE_H = 0.025;

/**
 * Clear lane a walking body needs: 0.70 m of collider plus 0.20 m so a swept
 * capsule at `SPEED_SPRINT` does not grind along both walls at once. Every
 * obstacle below is sized by subtracting this from the deck width.
 */
export const WALK_LANE_M = 2 * PLAYER_RADIUS + 0.2;

/** Tallest ledge a player can mount (jump apex plus a step up onto it). */
export const VAULT_HEIGHT_M = JUMP_HEIGHT_M + STEP_HEIGHT_M;

// ---------------------------------------------------------------------------
// The doorway a hatch is cut down to, and the lane it needs kept clear
// ---------------------------------------------------------------------------
//
// These live here rather than in `geometry.ts`, which draws them, because they
// are an AUTHORING constraint before they are a shape: the hole a linked port
// is cut down to is the narrowest thing in the station, and every fitting in
// this file has to be sized against it the same way it is sized against
// `WALK_LANE_M`. `geometry.ts` imports them back.

/** Half-width of the walk-through slot: a body plus 7 cm a side. */
export const DOORWAY_HALF_W = PLAYER_RADIUS + 0.07;
/** Crown of the arch, above the module axis. A standing capsule's top sphere
 *  needs `DECK_Y_M + PLAYER_STAND_HEIGHT_M` = 0.95; 1 cm over that, and still
 *  inside the 1.0 m bore so the cut never leaves the hull. */
export const DOORWAY_TOP = DECK_Y_M + PLAYER_STAND_HEIGHT_M + 0.01;
/** Sill, just under the deck, so a doorway never has a lip to step over. */
export const DOORWAY_SILL = DECK_Y_M - 0.03;

/**
 * THE PORT LANE. Nothing on the deck may stand inside `|x| < DOORWAY_HALF_W`
 * of a linked port's axis, for as long as the body is still in the doorway.
 *
 * The arithmetic is short and it is the whole rule. A body crossing the port
 * plane has `DOORWAY_HALF_W − PLAYER_RADIUS` = 7 cm of lateral slack, so its
 * centre is inside ±0.07 m of the axis; a fitting whose inner face is `f` from
 * the axis pushes that centre to `f − PLAYER_RADIUS`. The two are compatible
 * only while `f ≥ DOORWAY_HALF_W`, and a fitting closer than that does not
 * narrow the doorway, it CLOSES it — the body cannot be in both places at once
 * and no amount of walking around solves it.
 *
 * This is not hypothetical: the cupola's equipment bay had its inner face at
 * 0.24 m and ran the full depth of the collar, and a standing player could not
 * leave the cupola at all. `walkable.ts` now refuses a station that does it
 * again.
 */
export function bayHalfWidthBesidePort(boreRadius: number): number {
  return (deckHalfWidth(boreRadius) - 2 * HIDE_SHELL_T - DOORWAY_HALF_W) / 2;
}

/**
 * Deck furniture uses its OWN convention, deliberately different from the
 * wall-mounted props in `kit.ts` (where +Y is depth into the wall): these sit on
 * the floor, so **x = width across the lane, y = height, z = depth along the
 * corridor**, `localPos` is the centre of the box, and `localQuat` is either
 * absent or a rotation about +Y. Anything else and the piece would lean.
 */
/** Partial bulkhead — half a lane of steel, too tall to vault. */
export const BULKHEAD_SIZE: Vec3 = v3(0.4, 1.15, 0.18);
/** Wall thickness of a hide spot's shell — the steel between you and it. */
export const HIDE_SHELL_T = 0.08;
/** Bench module for the lab island. Two end to end make a 2.6 m spine. */
export const BENCH_SIZE: Vec3 = v3(0.5, 0.85, 1.3);
/** Equipment bank — a full-height block that turns a wall into a corner. */
export const BANK_SIZE: Vec3 = v3(0.62, 1.3, 0.5);
/**
 * How far the deepest WALL fitting reaches in from the hull: a rack plus the
 * puzzle panel bolted to its face (`RACK_DEPTH` + `PROP_ARCHETYPES.panel.size.y`
 * + the 1 cm standoff, all from `kit.ts`).
 *
 * Restated here rather than imported because `kit.ts` imports THIS file, and it
 * exists because deck furniture and wall furniture are authored in different
 * conventions by different functions and nothing else made them argue: anything
 * standing on the deck against a wall has to leave this much clear or it
 * swallows whatever is bolted there. See `labIsland`, where it was found.
 */
export const WALL_FITTING_DEPTH_M = 0.3;
/** Cargo rack for §11 puzzle 3. Wall convention (y = depth), like `rack`. */
export const CARGO_RACK_SIZE: Vec3 = v3(0.9, 0.24, 4.3);
/** One numbered cargo bag. A Rapier body once §11 puzzle 3 is built. */
export const CARGO_BAG_SIZE: Vec3 = v3(0.46, 0.4, 0.46);

/** Half-width of the walkable inset at `DECK_Y_M` inside a bore of `radius`. */
export function deckHalfWidth(radius: number): number {
  return Math.sqrt(Math.max(0, radius * radius - DECK_Y_M * DECK_Y_M));
}

/** Headroom over the deck inside a bore of `radius`. */
export function deckHeadroom(radius: number): number {
  return radius - DECK_Y_M;
}

// ---------------------------------------------------------------------------
// Plating detail (ISS-GRV-01 — "the surface you now spend the whole game on")
// ---------------------------------------------------------------------------
//
// The deck used to be ONE box per module: correctly dimensioned, and in a
// 5-candela torch beam completely mute. Everything below is relief worked into
// that box — plate joints on the walk stride, a nosing at the lip, fastener
// rows, and a grating that is a different surface rather than a different
// colour — and every bit of it obeys one number.
//
// THE RELIEF CEILING IS 0.010 m, AND IT IS DERIVED, NOT CHOSEN.
//
// `walkable.ts` plants a probe sphere of `PLAYER_RADIUS − 0.012` centred at
// `DECK_Y_M + PLAYER_RADIUS` on every 8 cm cell of every deck and calls the cell
// un-standable if anything is nearer than that. The 12 mm shrink exists because
// the walking collider is TANGENT to the deck by construction — which makes it
// the entire budget available to anything standing PROUD of `DECK_Y_M`. A batten
// 12 mm tall touches that sphere exactly; a batten 13 mm tall reports every cell
// it crosses as blocked, and a batten runs the full width of the lane, so the
// deck comes apart into disconnected pockets, the port-reachability test fails,
// and `buildLevel` refuses to write the station. That is an expensive way to
// find out you drew a nice seam, and it is invisible in the geometry itself.
//
// So: 10 mm for every raised feature, 2 mm of margin, and anything that wants to
// read deeper is cut DOWN into the plate instead. Cutting down costs the probe
// nothing: `grateBand`'s slots are 32 mm deep and the bar tops the body actually
// stands on are still exactly `DECK_Y_M`, so both validators — and the ground
// ray in `walk.ts`, which lands on the slot's backing 32 mm below — see the same
// floor they saw when the deck was one box.
//
// WHY THE JOINTS ARE AT `STRIDE_WALK_M` AND NOT AT SOME PLEASANT SPACING. §4
// measures walking in ground covered rather than in seconds: a footstep fires
// every `STRIDE_WALK_M`, and the head bob dips on the same event. Put the seams
// on that pitch and every footfall visually lands on one, at every gait, for
// free — the floor keeps time with the feet, which is most of what makes a deck
// feel like a floor rather than a texture.

/** Panel pitch. One panel per walking stride, so footfalls land on seams. */
export const DECK_PANEL_M = STRIDE_WALK_M;
/** Hard ceiling on anything standing proud of `DECK_Y_M`. See above. */
export const DECK_RELIEF_MAX_M = 0.01;
/** Width of a plate-joint batten, across the seam it covers. */
export const DECK_JOINT_W = 0.05;
/** How far a joint batten stands proud of the deck. */
export const DECK_JOINT_H = 0.006;
/** Footprint of one fastener head. */
export const DECK_FASTENER_W = 0.036;
/** How far a fastener head stands proud of the deck. */
export const DECK_FASTENER_H = 0.008;
/** Width of the nosing run at the lip of the deck. */
export const DECK_NOSING_W = 0.05;
/** Height of the nosing. At the ceiling, because a lip is the one feature that
 *  has to be felt before it is seen. */
export const DECK_NOSING_H = DECK_RELIEF_MAX_M;
/** Depth of a grating band along the run — a threshold you cross, not a floor
 *  you stand around on. */
export const GRATE_BAND_M = 0.3;
/** Bars per band. Three reads as grating and costs 36 triangles. */
export const GRATE_BARS = 3;
/** How far the slots are cut BELOW the bar tops. Deep enough to read as open at
 *  a grazing torch angle, shallow enough that the ground ray still finds the
 *  backing plate well inside `GROUND_PROBE_M`. */
export const GRATE_DEPTH_M = 0.032;
/** Fraction of the bar pitch that is metal. The rest is slot. */
const GRATE_DUTY = 0.62;
/**
 * How far a raised feature is buried in the plate under it.
 *
 * Not decoration: two boxes that share a face produce a coplanar pair, and a
 * coplanar pair z-fights. Every batten, stud and bar below overlaps whatever it
 * sits on by this much, so no two faces in a merged deck are ever coincident.
 */
const EMBED_M = 0.012;

/** Which surface a deck is plated with. Grating implies a different footfall. */
export type DeckSurface = 'plate' | 'grating';

export interface DeckDetailOptions {
  /**
   * `'plate'` (default): solid panels on the stride pitch with a grating
   * threshold band at each end of the run. `'grating'` — the whole deck is
   * open grating over a utility trench, bars running along the corridor.
   */
  surface?: DeckSurface;
  /** Skip the threshold bands (a piece whose ends are capped, not walked). */
  thresholds?: boolean;
}

type Axis2 = 'x' | 'z';

/** A box on the deck plane, given as extents plus the height of its TOP face. */
function slab(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  top: number,
  thickness: number,
): DeckPart {
  return {
    shape: 'box',
    pos: roundVec(v3((x0 + x1) / 2, top - thickness / 2, (z0 + z1) / 2)),
    size: roundVec(v3(Math.abs(x1 - x0), thickness, Math.abs(z1 - z0))),
  };
}

/** Structural plating: top face exactly on the walking surface. */
function plate(x0: number, x1: number, z0: number, z1: number): DeckPart {
  return slab(x0, x1, z0, z1, DECK_Y_M, DECK_THICKNESS_M);
}

/** A raised strip — a plate joint, a bearer or the nosing. */
function batten(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  height = DECK_JOINT_H,
): DeckPart {
  const h = Math.min(height, DECK_RELIEF_MAX_M);
  return slab(x0, x1, z0, z1, DECK_Y_M + h, h + EMBED_M);
}

/** One fastener head, centred on (x, z). */
function stud(x: number, z: number): DeckPart {
  const r = DECK_FASTENER_W / 2;
  return batten(x - r, x + r, z - r, z + r, DECK_FASTENER_H);
}

/**
 * A band of grating: a backing plate set down by `GRATE_DEPTH_M`, and bars whose
 * tops land exactly on `DECK_Y_M`.
 *
 * `bars` is the axis the bars RUN along, so the count is set by the band's
 * narrow dimension and a 5 m run of grating costs the same as a 0.3 m one.
 */
function grateBand(
  out: DeckPart[],
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  bars: Axis2,
): void {
  out.push(slab(x0, x1, z0, z1, DECK_Y_M - GRATE_DEPTH_M, DECK_THICKNESS_M - GRATE_DEPTH_M));
  const lo = bars === 'x' ? Math.min(z0, z1) : Math.min(x0, x1);
  const hi = bars === 'x' ? Math.max(z0, z1) : Math.max(x0, x1);
  const count = Math.max(2, Math.round((hi - lo) / (GRATE_BAND_M / GRATE_BARS)));
  const pitch = (hi - lo) / count;
  const halfBar = (pitch * GRATE_DUTY) / 2;
  for (let i = 0; i < count; i++) {
    const c = lo + (i + 0.5) * pitch;
    if (bars === 'x') {
      out.push(slab(x0, x1, c - halfBar, c + halfBar, DECK_Y_M, GRATE_DEPTH_M + EMBED_M / 3));
    } else {
      out.push(slab(c - halfBar, c + halfBar, z0, z1, DECK_Y_M, GRATE_DEPTH_M + EMBED_M / 3));
    }
  }
}

/** Joint positions on the stride pitch, symmetric about 0, inside `±limit`. */
function jointStations(limit: number): number[] {
  const out: number[] = [];
  const room = limit - DECK_JOINT_W / 2;
  for (let k = 0; k * DECK_PANEL_M <= room + 1e-6; k++) {
    const z = k * DECK_PANEL_M;
    if (k === 0) out.push(0);
    else out.push(-z, z);
  }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Deck shape
// ---------------------------------------------------------------------------

/** One primitive of a module's deck plate, in module space. */
export type DeckPart =
  /** `pos` is the centre of the box; `size` is its full extent. */
  | { shape: 'box'; pos: Vec3; size: Vec3 }
  /** Horizontal disc, `pos` at the centre of its TOP face. `arc` (three.js
   *  theta, 0 = +Z) trims it to a sector — the cupola's dome pad is a half
   *  disc, because a full one would reach back out through the collar. */
  | {
      shape: 'disc';
      pos: Vec3;
      radius: number;
      thickness: number;
      arc?: { start: number; length: number };
    };

export interface DeckDef {
  /** Walking surface, module-space Y. Always `DECK_Y_M`. */
  y: number;
  /** Half-width of the main lane — what the furniture is sized against. */
  halfWidth: number;
  /** Structural plate. */
  parts: DeckPart[];
  /**
   * Emissive edge runs, so the floor reads as a floor in near-darkness (§9).
   * `pos` is the centre of the run, sitting ON the deck.
   */
  edges: Array<{ pos: Vec3; size: Vec3 }>;
}

/**
 * Deck for a cylindrical piece whose axis runs along local +Z.
 *
 * PLATE (the default) is panels on the stride pitch with a grating threshold at
 * each end of the run, so you cross open grating at every hatch and walk on
 * solid plate in between — the timbre change lands exactly where the room
 * changes, which is the only place a player can use it.
 *
 * GRATING is the whole run: slots along the corridor over a utility trench, with
 * bearers across it on the same stride pitch. It is a different SURFACE rather
 * than a different colour, which is what §9's colourblind rule asks for and what
 * a torch beam at a grazing angle can actually resolve.
 */
export function tubeDeck(radius: number, length: number, opts: DeckDetailOptions = {}): DeckDef {
  const halfWidth = deckHalfWidth(radius);
  const y = DECK_Y_M;
  const half = length / 2;
  // Inboard of the emissive edge run, which owns the outer `DECK_EDGE_W`.
  const nosingX = halfWidth - DECK_EDGE_W - DECK_NOSING_W / 2;
  const parts: DeckPart[] = [];
  let plateHalf = half;

  if ((opts.surface ?? 'plate') === 'grating') {
    grateBand(parts, -halfWidth, halfWidth, -half, half, 'z');
    for (const z of jointStations(half)) {
      parts.push(batten(-halfWidth, halfWidth, z - DECK_JOINT_W / 2, z + DECK_JOINT_W / 2));
    }
  } else {
    const band = opts.thresholds === false ? 0 : GRATE_BAND_M;
    plateHalf = Math.max(0.4, half - band);
    parts.push(plate(-halfWidth, halfWidth, -plateHalf, plateHalf));
    if (band > 0) {
      grateBand(parts, -halfWidth, halfWidth, plateHalf, half, 'x');
      grateBand(parts, -halfWidth, halfWidth, -half, -plateHalf, 'x');
    }
    for (const z of jointStations(plateHalf)) {
      parts.push(batten(-halfWidth, halfWidth, z - DECK_JOINT_W / 2, z + DECK_JOINT_W / 2));
      // Fastener pairs at the ends of every seam: the row you read down the
      // corridor, and the reason a joint looks bolted rather than drawn.
      parts.push(stud(nosingX - 0.07, z));
      parts.push(stud(-(nosingX - 0.07), z));
    }
    // Centre-line seam, 2 mm lower than the cross joints so the two never share
    // a face where they meet. 1.32 m of deck split down the middle gives 0.66 ×
    // 0.75 panels — the bible's 0.75 m square, as near as a 1.0 m bore allows.
    parts.push(
      batten(-DECK_JOINT_W / 2, DECK_JOINT_W / 2, -plateHalf, plateHalf, DECK_JOINT_H - 0.002),
    );
  }

  // The nosing: a lip at the edge of the walkable plate, under the light run.
  for (const s of [-1, 1]) {
    parts.push(
      batten(
        s * (nosingX - DECK_NOSING_W / 2),
        s * (nosingX + DECK_NOSING_W / 2),
        -plateHalf,
        plateHalf,
        DECK_NOSING_H,
      ),
    );
  }

  return {
    y,
    halfWidth,
    parts,
    edges: [
      {
        pos: v3(halfWidth - DECK_EDGE_W / 2, y + DECK_EDGE_H / 2, 0),
        size: v3(DECK_EDGE_W, DECK_EDGE_H, length - 0.1),
      },
      {
        pos: v3(-(halfWidth - DECK_EDGE_W / 2), y + DECK_EDGE_H / 2, 0),
        size: v3(DECK_EDGE_W, DECK_EDGE_H, length - 0.1),
      },
    ],
  };
}

/**
 * Deck for the cubic node: a full-footprint plate with an edge run per face.
 *
 * The node's plating is a square of panels inside a GRATED PERIMETER TRENCH, and
 * the trench is doing three jobs at once. It is where a real spacecraft floor
 * puts its services; it is the same grating language the tube pieces use at
 * their thresholds, so the two read as one station; and because it runs under
 * all four doorways, every threshold in a node is a change of surface underfoot
 * — the node's four exits are legible by sound and by profile, not by a sign.
 */
export function nodeDeck(half: number, opts: DeckDetailOptions = {}): DeckDef {
  const y = DECK_Y_M;
  const edges: Array<{ pos: Vec3; size: Vec3 }> = [];
  const trench = opts.surface === 'grating' ? half : GRATE_BAND_M;
  const inner = half - trench;
  const parts: DeckPart[] = [];

  if (inner > 0.2) {
    parts.push(plate(-inner, inner, -inner, inner));
    // Panels on the stride pitch, both ways. The runs along Z sit 2 mm lower so
    // the crossings are a lap joint rather than a coplanar pair.
    for (const s of jointStations(inner)) {
      parts.push(batten(-inner, inner, s - DECK_JOINT_W / 2, s + DECK_JOINT_W / 2));
      parts.push(
        batten(s - DECK_JOINT_W / 2, s + DECK_JOINT_W / 2, -inner, inner, DECK_JOINT_H - 0.002),
      );
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) parts.push(stud(sx * DECK_PANEL_M, sz * DECK_PANEL_M));
    }
    // Trench: full width along ±Z, then the remaining span along ±X, so the four
    // bands tile the perimeter without overlapping at the corners.
    for (const s of [-1, 1]) {
      grateBand(parts, -half, half, s * inner, s * half, 'x');
      grateBand(parts, s * inner, s * half, -inner, inner, 'z');
    }
  } else {
    grateBand(parts, -half, half, -half, half, 'z');
  }

  // A nosing inboard of each of the four edge runs.
  const nosingA = half - DECK_EDGE_W - DECK_NOSING_W;
  const nosingB = half - DECK_EDGE_W;
  for (const s of [-1, 1]) {
    parts.push(batten(s * nosingA, s * nosingB, -nosingA, nosingA, DECK_NOSING_H));
    parts.push(batten(-nosingA, nosingA, s * nosingA, s * nosingB, DECK_NOSING_H));
  }

  // A run under each of the four side faces: the node's floor reads as four
  // doorway sills, which is exactly what it is.
  for (const s of [-1, 1]) {
    edges.push({
      pos: v3(s * (half - DECK_EDGE_W / 2), y + DECK_EDGE_H / 2, 0),
      size: v3(DECK_EDGE_W, DECK_EDGE_H, half * 2 - 0.1),
    });
    edges.push({
      pos: v3(0, y + DECK_EDGE_H / 2, s * (half - DECK_EDGE_W / 2)),
      size: v3(half * 2 - 0.1, DECK_EDGE_H, DECK_EDGE_W),
    });
  }
  return { y, halfWidth: half, parts, edges };
}

/**
 * Deck for the cupola: a plank through the collar and a round pad under the
 * dome. The dome is glass all the way round, so the pad's rim is the only edge
 * light in the room and does a lot of work.
 *
 * The plank gets the same threshold grating every other piece gets at its port,
 * and the pad gets two chord battens on the stride pitch — chords rather than a
 * ring because a `DeckPart` box is axis-aligned by construction, and a radial
 * seam would need a rotation the type does not carry. Both are trimmed to the
 * disc's own half-chord at their far edge, so nothing overhangs into the dome
 * glass.
 */
export function cupolaDeck(collarR: number, domeR: number, portZ: number, domeZ: number): DeckDef {
  const y = DECK_Y_M;
  const collarHalf = deckHalfWidth(collarR);
  const padR = deckHalfWidth(domeR);
  const plankZ = (portZ + domeZ) / 2;
  const plankLen = domeZ - portZ;
  const band = Math.min(GRATE_BAND_M, plankLen * 0.45);
  const nosingX = collarHalf - DECK_EDGE_W - DECK_NOSING_W / 2;
  const parts: DeckPart[] = [];

  // Collar: grating at the hatch, plate for the rest of the plank.
  grateBand(parts, -collarHalf, collarHalf, portZ, portZ + band, 'x');
  parts.push(plate(-collarHalf, collarHalf, portZ + band, domeZ));
  // Seam where the plank meets the pad, kept just inboard of the join.
  parts.push(batten(-collarHalf, collarHalf, domeZ - DECK_JOINT_W - 0.005, domeZ - 0.005));
  for (const s of [-1, 1]) {
    parts.push(
      batten(
        s * (nosingX - DECK_NOSING_W / 2),
        s * (nosingX + DECK_NOSING_W / 2),
        portZ + band,
        domeZ,
        DECK_NOSING_H,
      ),
    );
    parts.push(stud(s * (nosingX - 0.07), portZ + band + 0.09));
    parts.push(stud(s * (nosingX - 0.07), domeZ - 0.16));
  }

  parts.push({
    shape: 'disc',
    pos: v3(0, y, domeZ),
    radius: padR,
    thickness: DECK_THICKNESS_M,
    arc: { start: -Math.PI / 2, length: Math.PI },
  });
  // Pad seams, on the stride, trimmed to the chord at the batten's far edge.
  for (const k of [1, 2]) {
    const near = k * DECK_PANEL_M - DECK_JOINT_W / 2;
    const far = k * DECK_PANEL_M + DECK_JOINT_W / 2;
    if (far >= padR - 0.05) break;
    const chord = Math.sqrt(Math.max(0, padR * padR - far * far)) - 0.04;
    if (chord < 0.2) break;
    parts.push(batten(-chord, chord, domeZ + near, domeZ + far));
  }

  return {
    y,
    halfWidth: collarHalf,
    parts,
    edges: [
      {
        pos: v3(collarHalf - DECK_EDGE_W / 2, y + DECK_EDGE_H / 2, plankZ),
        size: v3(DECK_EDGE_W, DECK_EDGE_H, plankLen),
      },
      {
        pos: v3(-(collarHalf - DECK_EDGE_W / 2), y + DECK_EDGE_H / 2, plankZ),
        size: v3(DECK_EDGE_W, DECK_EDGE_H, plankLen),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Chase geometry
// ---------------------------------------------------------------------------

function deckProp(id: string, kind: string, size: Vec3, x: number, z: number, quat?: Quat): PropRef {
  const p: PropRef = {
    id,
    kind,
    localPos: roundVec(v3(x, DECK_Y_M + size.y / 2, z)),
  };
  if (quat) p.localQuat = quat;
  return p;
}

/**
 * §2's "partial bulkhead", applied to the kit piece that needs it most.
 *
 * A straight is 1.32 m of walkable deck and a walker is 0.70 m of that, so a
 * bulkhead on alternating sides leaves a 0.92 m lane and turns a 5 m sprint into
 * a weave. Against a blind pursuer that is worth more than it looks: it does not
 * hide you, it forces the thing to commit to a side, and a committed pursuer can
 * be doubled back on. `COAMING_SIZE` at mid-span is under `STEP_HEIGHT_M` so it
 * costs a walker nothing — it is a threshold that reads in the dark and a
 * landing hazard for anyone who tries to jump the chicane.
 */
export function tubeChicane(moduleId: ModuleId, radius: number, length: number): PropRef[] {
  const half = deckHalfWidth(radius);
  const offset = half - BULKHEAD_SIZE.x / 2;
  // Amidships, and spaced so the weave is a metre and a bit rather than a
  // shimmy. The ends of the tube belong to the locker and the crew bunk; see
  // the cross-section budget in the header for why they cannot share a slice.
  //
  // Each side of the weave is TWO panels deep along the corridor rather than
  // one, and that is the only thing about the chicane the art pass changed. The
  // depth costs the lane nothing — it grows along +Z, not across the bore, so
  // every number in the cross-section budget above is untouched — and it buys
  // the two things a single 0.18 m fin could not: a 0.36 m return that reads as
  // built structure instead of a plate stood on edge, and a pocket deep enough
  // that a crouched body (0.85 m eye, against 1.15 m of steel) is behind
  // something rather than beside it. §4's hiding rules do not care, because the
  // alien is blind; the player's read of where cover IS cares a great deal.
  const props: PropRef[] = [];
  const stubs: Array<{ suffix: string; x: number; z: number }> = [
    { suffix: 'a', x: -offset, z: -0.9 },
    { suffix: 'b', x: offset, z: 0.3 },
  ];
  for (const stub of stubs) {
    for (let i = 0; i < 2; i++) {
      const z = stub.z + (i - 0.5) * BULKHEAD_SIZE.z;
      props.push(
        deckProp(
          `${moduleId}-bulkhead-${stub.suffix}${i === 0 ? '' : String(i)}`,
          'bulkhead',
          BULKHEAD_SIZE,
          stub.x,
          z,
        ),
      );
    }
  }
  return props;
}

/**
 * §2's highest-value piece: "a loop you can run around."
 *
 * The lab is 2.36 m of deck, so a 0.5 m island down the middle leaves 0.93 m
 * either side — two lanes, four ways in, and a pursuer that has to guess. The
 * island is 0.85 m, just over `VAULT_HEIGHT_M`, so the loop cannot be
 * short-circuited by jumping it; the banks at the ends turn each entrance into a
 * corner and open the side bays the hide spots live in.
 */
export function labIsland(moduleId: ModuleId, radius: number, length: number): PropRef[] {
  const half = deckHalfWidth(radius);
  // FLUSH WITH THE DECK EDGE IS WRONG HERE, AND IT WAS MEASURED WRONG.
  //
  // `half - BANK_SIZE.x / 2` puts the bank's outer face on the lip of the deck,
  // which is the right answer in a bare bore and the wrong one on a wall that
  // already carries fittings: the lab's aft end has an undock lever panel bolted
  // to the −X rack line at z = −2.0, and a bank flush with the deck edge swallows
  // it — MEASURED at 7 cm of overlap in x and 44 cm in z on the shipped level,
  // i.e. three quarters of a §11 puzzle 6 lever inside a scenery block. Stand the
  // bank off by the depth of the deepest wall fitting and the panel is in front
  // of it, where a lever has to be.
  const bankX = Math.min(
    half - BANK_SIZE.x / 2,
    radius - WALL_FITTING_DEPTH_M - 0.02 - BANK_SIZE.x / 2,
  );
  const bankZ = length / 2 - BANK_SIZE.z / 2 - 0.15;
  return [
    // ONE bench, amidships, and the length is the whole design problem.
    //
    // A swept 0.35 m body has to get PAST the island to use the far lane, and it
    // needs about 0.35 m of clear module axis at each end of the island to make
    // that turn. A 2.6 m island in a 5 m tube leaves 1.2 m at each end, the end
    // fittings claim 0.8 m of it once their own 0.35 m of body clearance is
    // counted, and the loop silently becomes two dead-end lanes — which is
    // exactly what the first draft of this file produced and what `walkable.ts`
    // now catches. 1.3 m of island is enough to have to choose a side and short
    // enough to leave a real turn at both ends.
    deckProp(`${moduleId}-bench-a`, 'bench', BENCH_SIZE, 0, 0),
    // The bank is aft, on the wall the locker is not on, so the aft end reads as
    // a corner without either fitting closing the other's lane.
    deckProp(`${moduleId}-bank-a`, 'bank', BANK_SIZE, -bankX, -bankZ),
  ];
}

/**
 * The node's console island, authored as a HIDE VOLUME rather than as a prop:
 * `geometry.ts` wraps every hide spot in a shell, so this one void produces both
 * the island the room loops around and the box a body fits into.
 *
 * `HIDE_SHELL_T` of wall on each side makes the finished island 1.0 m square and
 * 0.76 m tall — under `VAULT_HEIGHT_M`, so cutting the corner across the top is
 * available and costs a landing (§4). Loud shortcut, quiet detour; the same rule
 * as everything else in §11.
 */
export function nodeConsoleVoid(id: string): HideSpot {
  const halfExtents = v3(0.42, 0.3, 0.42);
  return {
    id,
    kind: 'equipment-bay',
    // Sit the shell's underside exactly on the deck.
    localPos: roundVec(v3(0, DECK_Y_M + HIDE_SHELL_T + halfExtents.y, 0)),
    halfExtents,
    entryPos: roundVec(v3(0, DECK_Y_M + 0.9, 0.95)),
    lookDir: v3(0, 0, 1),
    usableIn: 'any',
  };
}

/** A single bank, for authoring a corner where a piece has room for one. */
export function deckBank(moduleId: ModuleId, suffix: string, x: number, z: number): PropRef {
  return deckProp(`${moduleId}-bank-${suffix}`, 'bank', BANK_SIZE, x, z);
}

// ---------------------------------------------------------------------------
// Hide spots (§4 "Hiding — the genre gap r1 and r2 left open")
// ---------------------------------------------------------------------------

/**
 * Default half-extents of a deck bay: a 0.6 m × 1.1 m × 0.64 m void, 0.42 m³.
 *
 * The lab's 1.4 m bore fits this beside a doorway with 2 mm to spare
 * (`bayHalfWidthBesidePort(1.4)` = 0.301), which is the coincidence that kept
 * the lab walkable while the cupola's 1.25 m collar was not. Narrower bores
 * have to trade width for depth — see `CUPOLA` in `kit.ts`.
 */
export const BAY_HALF_EXTENTS: Vec3 = v3(0.3, 0.55, 0.32);

/**
 * Standing room in front of a bay's mouth, OUTSIDE the shell's outer face.
 *
 * A body radius plus 6 cm. The radius is not negotiable — `walkable.ts` plants a
 * `PLAYER_RADIUS` collider at a spot and a bay whose entry point is inside its
 * own wall is a prompt you cannot walk to — and the 6 cm is the same order of
 * slack `WALK_LANE_M` gives a swept capsule, so a player drifting a little as
 * they arrive still gets the prompt instead of grinding along the shell.
 */
export const HIDE_ENTRY_CLEARANCE_M = PLAYER_RADIUS + 0.06;

/**
 * How far a bay's entry point stands off the bay's CENTRE, across the lane.
 *
 * Derived, because it was hard-coded at 0.7 m and that is only correct for one
 * bay in the kit. The shell wraps the void with `HIDE_SHELL_T` on every face,
 * and — this is the part the hard-coded number missed — the four side panels
 * are cut `(half + t) * 2` across, so they OVERHANG the void's own face by the
 * shell thickness. The nearest steel to a body standing at the entry is
 * therefore `halfExtents.x + HIDE_SHELL_T` from the centre, not `halfExtents.x`,
 * and everything past that is the body's own.
 *
 * At `BAY_HALF_EXTENTS`' 0.30 m width the old constant left 0.32 m of gap for a
 * 0.35 m body: the lab's bay put its entry 1.8 cm INSIDE its own wall, and the
 * "press E" marker sat somewhere a standing player cannot be. The cupola's bay
 * was fine only by accident — it is 0.21 m wide to clear the doorway
 * (`bayHalfWidthBesidePort`), and 0.21 + 0.08 + 0.35 + 0.06 is exactly 0.7.
 *
 * `nodeConsoleVoid` authors its own entry rather than calling this, because the
 * console is approached along +Z and its 0.95 m already clears the 0.91 m this
 * would ask for.
 */
export function bayEntryOffset(halfExtentsX: number): number {
  return halfExtentsX + HIDE_SHELL_T + HIDE_ENTRY_CLEARANCE_M;
}

/**
 * An equipment bay standing on the deck of a cylindrical piece.
 *
 * Deliberately 1.3 m rather than full height: a box on the deck of a bore is
 * bounded by the DECK's half-width (the narrowest cross-section it spans), so
 * making it taller only makes it thinner. You crouch to get in, which is the
 * right verb anyway — `SPEED_CROUCH` is the gait you approach cover in.
 *
 * `halfExtents` is authorable because the two constraints on a bay pull in
 * opposite directions: the deck bounds its WIDTH, and a linked port within
 * reach bounds it further still (`bayHalfWidthBesidePort`), so a piece with a
 * narrow bore keeps the volume by getting DEEPER instead. Keep the volume
 * roughly `BAY_HALF_EXTENTS`' 0.42 m³ — that is the size that reads as
 * something a body climbs into rather than a cupboard.
 *
 * Widening it therefore moves the ENTRY too (`bayEntryOffset`), because the
 * body has to stand clear of the shell the extra width pushes into the lane.
 * A bay wide enough to eat its own approach is `walkable.ts`' problem; a bay
 * whose entry ends up outside the deck is this function's, and neither is
 * something the author sees by reading the half-extents alone.
 */
export function deckBay(
  id: string,
  side: 1 | -1,
  z: number,
  boreRadius: number,
  halfExtents: Vec3 = BAY_HALF_EXTENTS,
): HideSpot {
  // Standing on the deck, the bay's widest constraint is the deck itself — and
  // again it is the SHELL that has to fit, not the volume.
  const outerX = deckHalfWidth(boreRadius) - HIDE_SHELL_T;
  const centreX = side * (outerX - halfExtents.x);
  return {
    id,
    kind: 'equipment-bay',
    // Sit the shell's underside exactly on the deck.
    localPos: roundVec(v3(centreX, DECK_Y_M + HIDE_SHELL_T + halfExtents.y, z)),
    halfExtents,
    entryPos: roundVec(v3(centreX - side * bayEntryOffset(halfExtents.x), DECK_Y_M + 0.9, z)),
    lookDir: v3(-side, 0, 0),
    usableIn: 'any',
  };
}

/**
 * Internal half-extents of a crew sleep station: 0.68 × 1.00 × 0.80 m.
 *
 * The height is `PLAYER_CROUCH_HEIGHT_M` exactly, because that is the verb — you
 * duck in, which costs you your sprint and drops your footstep noise to 4 (§4).
 * The width is what a 1.0 m bore has left over once the shell and the far lane
 * are paid for: 0.68 m of shoulder rather than the bible's 0.80, because at
 * `HIDE_SHELL_T` a side, 0.34 is the widest half-width whose outer face still
 * leaves the corridor beside it something to be.
 *
 * The DEPTH is 0.80 and it is the interesting number. A berth deep enough to
 * take a body lying down (the bible's 2.0 m) would reach 2 m up a 5 m corridor
 * from its capped end, and the last metre of that corridor is where the module's
 * locker and its console panel are: nothing can walk past a berth this wide, so
 * every centimetre of depth is a centimetre of the module's own fittings put out
 * of reach. At 0.80 a standing body gets within 0.78 m of the locker face with a
 * clear line to it — inside `INTERACT_RANGE` with room to spare — and the berth
 * is still 0.54 m³, which is bigger than every equipment bay in the kit.
 */
export const BUNK_HALF_EXTENTS: Vec3 = v3(0.34, PLAYER_CROUCH_HEIGHT_M / 2, 0.4);

/**
 * A crew sleep station built into the CAPPED end of a straight run.
 *
 * This is the answer to the note in `kit.ts` that a `nominal` straight gets no
 * hide spot: "a berth deep enough to climb into reaches 0.18 m from the axis,
 * which leaves 0.12 m of lane past it — a hiding place that plugs the corridor
 * it is hiding you in." That is true of a berth in the MIDDLE of a corridor. It
 * is not true of one at a dead end, and the difference is the whole design:
 *
 *  • the bunk is pushed against the end plate of an UNLINKED port, so the lane it
 *    plugs leads nowhere. Nothing has to get past it, so nothing does;
 *  • it is offset to one side, which keeps the wall opposite — where the module's
 *    locker lives — visible and reachable from the corridor;
 *  • the mouth faces back down the run, so the occupant looks at the way in. §4
 *    is explicit that a hide spot is a pair of ears and a decision about when to
 *    leave, and a spot facing a wall makes the decision blind.
 *
 * Because it is a dead end it is also §2's knowingly-authored commitment: the
 * best cover in the module, with no second way out.
 */
export function crewBunk(
  id: string,
  boreRadius: number,
  /** Module-space z of the capped end the bunk is built into. */
  endZ: number,
  /** +1 if the mouth faces +Z (the cap is at the −Z end), −1 for the mirror. */
  facing: 1 | -1,
  side: 1 | -1 = 1,
  halfExtents: Vec3 = BUNK_HALF_EXTENTS,
): HideSpot {
  const outerX = deckHalfWidth(boreRadius) - HIDE_SHELL_T;
  const centreX = side * (outerX - halfExtents.x);
  const centreZ = endZ + facing * (HIDE_SHELL_T + halfExtents.z);
  const mouthZ = centreZ + facing * (halfExtents.z + HIDE_SHELL_T + HIDE_ENTRY_CLEARANCE_M);
  return {
    id,
    kind: 'crew-bunk',
    localPos: roundVec(v3(centreX, DECK_Y_M + HIDE_SHELL_T + halfExtents.y, centreZ)),
    halfExtents,
    entryPos: roundVec(v3(centreX, DECK_Y_M + 0.9, mouthZ)),
    lookDir: v3(0, 0, facing),
    usableIn: 'any',
  };
}

/**
 * A stowage net you have to FLOAT into — §4's `'zero'`-only spot. Under gravity
 * it is a bag of webbing at head height with nothing to stand on; with the plant
 * off it is the only cover in the room.
 */
export function stowageNet(id: string, pos: Vec3, toward: Vec3): HideSpot {
  const halfExtents = v3(0.32, 0.42, 0.55);
  return {
    id,
    kind: 'equipment-bay',
    localPos: roundVec(pos),
    halfExtents,
    entryPos: roundVec(
      v3(pos.x + toward.x * 0.7, pos.y + toward.y * 0.7, pos.z + toward.z * 0.7),
    ),
    lookDir: v3(toward.x, toward.y, toward.z),
    usableIn: 'zero',
  };
}
