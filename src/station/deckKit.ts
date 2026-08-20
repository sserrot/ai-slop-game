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
  PLAYER_RADIUS,
  PLAYER_STAND_HEIGHT_M,
  STEP_HEIGHT_M,
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

/** Deck for a cylindrical piece whose axis runs along local +Z. */
export function tubeDeck(radius: number, length: number): DeckDef {
  const halfWidth = deckHalfWidth(radius);
  const y = DECK_Y_M;
  return {
    y,
    halfWidth,
    parts: [
      {
        shape: 'box',
        pos: v3(0, y - DECK_THICKNESS_M / 2, 0),
        size: v3(halfWidth * 2, DECK_THICKNESS_M, length),
      },
    ],
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

/** Deck for the cubic node: a full-footprint plate with an edge run per face. */
export function nodeDeck(half: number): DeckDef {
  const y = DECK_Y_M;
  const edges: Array<{ pos: Vec3; size: Vec3 }> = [];
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
  return {
    y,
    halfWidth: half,
    parts: [
      {
        shape: 'box',
        pos: v3(0, y - DECK_THICKNESS_M / 2, 0),
        size: v3(half * 2, DECK_THICKNESS_M, half * 2),
      },
    ],
    edges,
  };
}

/**
 * Deck for the cupola: a plank through the collar and a round pad under the
 * dome. The dome is glass all the way round, so the pad's rim is the only edge
 * light in the room and does a lot of work.
 */
export function cupolaDeck(collarR: number, domeR: number, portZ: number, domeZ: number): DeckDef {
  const y = DECK_Y_M;
  const collarHalf = deckHalfWidth(collarR);
  const padR = deckHalfWidth(domeR);
  const plankZ = (portZ + domeZ) / 2;
  const plankLen = domeZ - portZ;
  return {
    y,
    halfWidth: collarHalf,
    parts: [
      {
        shape: 'box',
        pos: v3(0, y - DECK_THICKNESS_M / 2, plankZ),
        size: v3(collarHalf * 2, DECK_THICKNESS_M, plankLen),
      },
      {
        shape: 'disc',
        pos: v3(0, y, domeZ),
        radius: padR,
        thickness: DECK_THICKNESS_M,
        arc: { start: -Math.PI / 2, length: Math.PI },
      },
    ],
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
  return [
    deckProp(`${moduleId}-bulkhead-a`, 'bulkhead', BULKHEAD_SIZE, -offset, -0.9),
    deckProp(`${moduleId}-bulkhead-b`, 'bulkhead', BULKHEAD_SIZE, offset, 0.3),
  ];
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
  const bankX = half - BANK_SIZE.x / 2;
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
