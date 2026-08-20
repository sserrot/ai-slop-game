/**
 * Can a player actually walk across this module? (DESIGN.md §2, §4.)
 *
 * The pivot added a floor, a chase-geometry pass and a hide spot to almost every
 * module, and the first draft of that authoring produced three modules a player
 * could not cross — not by any single mistake, but because a 1.0 m bore has
 * about 0.92 m of usable width at head height and the crew bunk, the stowage
 * locker and the chicane each quietly took 0.3–0.5 m of it. Two fittings facing
 * each other across the same slice of corridor is a wall, and nothing in the
 * existing validators had any opinion about that: `ModuleGraph.validate()`
 * checks topology, `RailGraph.validate()` checks rail joints, and both were
 * perfectly happy with a station you cannot walk through.
 *
 * So this is the third validator, and it is deliberately empirical rather than
 * analytic. It builds the SAME collision geometry the game builds, drops a grid
 * of standing colliders onto the deck, keeps the ones that fit, and flood-fills.
 * A module passes when every linked port is reachable from one connected pocket
 * of free deck, AND a standing body fits in the doorway at each of those ports.
 * That catches blockages regardless of which prop caused them, including ones
 * introduced by a level author who never reads this file — which is the whole
 * point, because "move that locker 30 cm" is a change nobody will think to
 * re-test.
 *
 * The two port tests are separate on purpose and the second one was added after
 * the first passed a station nobody could get out of: reaching a hatch is a
 * question about the DECK and clears at 0.6 m, while getting through one is a
 * question about a 0.84 m slot whose edges no amount of route-finding avoids.
 *
 * `buildLevel.ts` refuses to write a station that fails it.
 *
 * It is a build-time tool: it imports three.js and `three-mesh-bvh`, both of
 * which run fine under tsx, and it is not on any runtime path.
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DECK_Y_M, PLAYER_RADIUS, PLAYER_STAND_HEIGHT_M } from '@shared/constants';
import type { ModuleId, StationLayout, StationModule } from '@shared/types';
import { buildModuleShell, toCollisionGeometry } from './geometry';
import { KIT } from './kit';
import { moduleMatrix } from './threeUtil';
import { DOORWAY_HALF_W } from './deckKit';

/** Grid spacing for the sample. 8 cm — a quarter of a body. */
const SAMPLE_M = 0.08;
/**
 * The collider is TANGENT to the deck by construction (its lower sphere sits at
 * `DECK_Y_M + PLAYER_RADIUS`), so an exact-radius overlap test reports every
 * cell on the floor as blocked. Shrink by a hair.
 */
const PROBE_R = PLAYER_RADIUS - 0.012;
/** How near a linked port a walkable cell has to get to count as "reachable". */
const PORT_REACH_M = 0.6;
/**
 * How far INSIDE the module the doorway test steps before it stops caring.
 *
 * Reaching a port is not the same as getting through it, which is what the
 * shipped level proved: the cupola's deck came within 2 cm of its hatch and a
 * standing body still could not leave the room, because the equipment bay's
 * inner face stood inside the `DOORWAY_HALF_W` slot the hatch is cut down to
 * and there is no way around a doorway. So the body is planted IN the opening
 * and one step inboard of it — far enough to clear the bulkhead plate and catch
 * whatever is parked against it, near enough that the module's own furniture
 * two metres away is none of this test's business.
 */
const DOORWAY_STEP_M = 0.25;

export interface ModuleWalkReport {
  module: ModuleId;
  /** Skipped: `zero` modules have no deck, by design. */
  skipped: boolean;
  /** Walkable deck area in the largest connected pocket, m². */
  area: number;
  /** How many disconnected pockets of free deck the module has. */
  islands: number;
  /**
   * How many islands of obstruction the walkable deck completely SURROUNDS.
   *
   * §2 calls a loop "the highest-value piece of geometry in the kit… the thing
   * has to pick a direction, and it can pick wrong", so it is worth measuring
   * rather than assuming: a console the deck runs all the way around registers
   * here, and one that turns out to be welded to a wall by a locker somebody
   * moved does not. Reported, never enforced — a straight legitimately has none.
   */
  loops: number;
  /**
   * Per linked port: how far the nearest cell of the largest pocket is, and
   * whether a standing body actually FITS in the opening (see `DOORWAY_STEP_M`
   * — the two are different questions and only the second one is about hatches).
   */
  ports: Array<{ port: string; distance: number; doorway: boolean }>;
  problems: string[];
}

export interface WalkReport {
  modules: ModuleWalkReport[];
  problems: string[];
}

/**
 * Sample every decked module and report what a walking body can reach.
 *
 * Cheap enough to run on every level build: nine modules at 8 cm is a few tens
 * of thousands of closest-point queries against a 2k-triangle BVH.
 */
export function checkWalkable(layout: StationLayout): WalkReport {
  const bvh = buildLayoutBvh(layout);
  const modules: ModuleWalkReport[] = [];
  const problems: string[] = [];

  for (const module of layout.modules) {
    const report = checkModule(module, bvh);
    modules.push(report);
    problems.push(...report.problems);
  }
  return { modules, problems };
}

// ---------------------------------------------------------------------------

function buildLayoutBvh(layout: StationLayout): MeshBVH {
  const parts: THREE.BufferGeometry[] = [];
  for (const module of layout.modules) {
    const shell = buildModuleShell(module, KIT[module.kind]);
    const matrix = moduleMatrix(module);
    for (const g of shell.collision) {
      parts.push(toCollisionGeometry(g, matrix));
      g.dispose();
    }
    for (const list of [shell.hull, shell.trim, shell.glass, shell.strips, shell.deck, shell.deckEdge, shell.hideShells]) {
      for (const g of list) g.dispose();
    }
  }
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return new MeshBVH(merged);
}

const hitInfo = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const probe = new THREE.Vector3();

function clear(bvh: MeshBVH, x: number, y: number, z: number): boolean {
  probe.set(x, y, z);
  // `maxThreshold` is a search hint, not a filter: this build of three-mesh-bvh
  // still returns the closest point when it lies beyond it. Compare the distance
  // rather than trusting the null.
  const hit = bvh.closestPointToPoint(probe, hitInfo, 0, PROBE_R);
  return hit === null || hitInfo.distance > PROBE_R;
}

/** Does a standing collider fit with its feet on the deck at (x, z)? */
function standFits(bvh: MeshBVH, x: number, z: number): boolean {
  const bottom = DECK_Y_M + PLAYER_RADIUS;
  const top = DECK_Y_M + PLAYER_STAND_HEIGHT_M - PLAYER_RADIUS;
  if (!clear(bvh, x, bottom, z)) return false;
  if (!clear(bvh, x, top, z)) return false;
  // Samples up the shaft, so a waist-height bar between the two spheres is not
  // stepped straight through.
  for (let i = 1; i < 4; i++) {
    if (!clear(bvh, x, bottom + ((top - bottom) * i) / 4, z)) return false;
  }
  return true;
}

/** Is there deck (and not the top of a console) directly under (x, z)? */
function onDeck(bvh: MeshBVH, x: number, z: number): boolean {
  // The deck plate's top face is exactly `DECK_Y_M`, and it is the only surface
  // at that height; a point a centimetre above it is within reach of it and
  // nothing else. Cheaper and more robust here than a raycast.
  probe.set(x, DECK_Y_M + 0.05, z);
  const hit = bvh.closestPointToPoint(probe, hitInfo, 0, 0.08);
  if (hit === null || hitInfo.distance > 0.08) return false;
  return Math.abs(hitInfo.point.y - DECK_Y_M) < 0.02;
}

function checkModule(module: StationModule, bvh: MeshBVH): ModuleWalkReport {
  const report: ModuleWalkReport = {
    module: module.id,
    skipped: module.gravity === 'zero',
    area: 0,
    islands: 0,
    loops: 0,
    ports: [],
    problems: [],
  };
  if (report.skipped) return report;

  const piece = KIT[module.kind];
  const half = piece.radius;
  const halfLen = module.kind === 'node' ? piece.radius : piece.length / 2;
  const matrix = moduleMatrix(module);

  const cells = new Map<string, { i: number; j: number; x: number; z: number }>();
  const nx = Math.floor((2 * half) / SAMPLE_M);
  const nz = Math.floor((2 * halfLen) / SAMPLE_M);
  const world = new THREE.Vector3();
  const inward = new THREE.Vector3();
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      world.set(-half + i * SAMPLE_M, DECK_Y_M, -halfLen + j * SAMPLE_M).applyMatrix4(matrix);
      if (!onDeck(bvh, world.x, world.z)) continue;
      if (!standFits(bvh, world.x, world.z)) continue;
      cells.set(`${i},${j}`, { i, j, x: world.x, z: world.z });
    }
  }

  // Flood fill into connected pockets.
  const seen = new Set<string>();
  let biggest: Array<{ i: number; j: number; x: number; z: number }> = [];
  for (const key of cells.keys()) {
    if (seen.has(key)) continue;
    report.islands++;
    const pocket: Array<{ i: number; j: number; x: number; z: number }> = [];
    const stack = [key];
    seen.add(key);
    while (stack.length > 0) {
      const k = stack.pop() as string;
      const c = cells.get(k);
      if (!c) continue;
      pocket.push(c);
      for (const [di, dj] of NEIGHBOURS) {
        const nk = `${c.i + di},${c.j + dj}`;
        if (cells.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
    if (pocket.length > biggest.length) biggest = pocket;
  }
  report.area = biggest.length * SAMPLE_M * SAMPLE_M;
  report.loops = countEnclosed(new Set(biggest.map((c) => `${c.i},${c.j}`)), nx, nz);

  for (const port of module.ports) {
    if (!port.link) continue;
    world.set(port.localPos.x, DECK_Y_M, port.localPos.z).applyMatrix4(matrix);
    let best = Number.POSITIVE_INFINITY;
    for (const c of biggest) {
      const d = Math.hypot(c.x - world.x, c.z - world.z);
      if (d < best) best = d;
    }
    // Stand IN the doorway, then one step inboard. `localDir` is the outward
    // normal, so the step is against it; both samples are on the deck, because
    // a doorway is only a doorway to a body with its feet on the floor.
    inward
      .set(-port.localDir.x, -port.localDir.y, -port.localDir.z)
      .transformDirection(matrix)
      .normalize();
    const doorway =
      standFits(bvh, world.x, world.z) &&
      standFits(
        bvh,
        world.x + inward.x * DOORWAY_STEP_M,
        world.z + inward.z * DOORWAY_STEP_M,
      );
    report.ports.push({ port: port.id, distance: best, doorway });
    if (!(best <= PORT_REACH_M)) {
      report.problems.push(
        `${module.id}: a walking body cannot reach port '${port.id}' from the module's main deck ` +
          `(nearest walkable cell ${Number.isFinite(best) ? `${best.toFixed(2)}m` : 'nowhere'} away) — ` +
          'two fittings are probably facing each other across the same slice of corridor',
      );
    }
    if (!doorway) {
      report.problems.push(
        `${module.id}: a standing body does not fit THROUGH the hatch at port '${port.id}' — ` +
          `something is standing inside the ±${DOORWAY_HALF_W.toFixed(2)} m slot the doorway ` +
          'is cut down to, and a doorway is the one thing in the station you cannot walk ' +
          'around (see `DOORWAY_HALF_W` and `bayHalfWidthBesidePort` in deckKit.ts)',
      );
    }
  }
  if (biggest.length === 0) {
    report.problems.push(`${module.id}: no walkable deck at all`);
  }
  return report;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * How many pockets of NON-walkable grid the walkable pocket entirely encloses.
 *
 * Flood the complement inward from the border of the sample grid; anything it
 * cannot reach is surrounded by walkable deck, which is exactly the definition
 * of "you can run around it". One island of obstruction enclosed = one loop.
 */
function countEnclosed(free: ReadonlySet<string>, nx: number, nz: number): number {
  const outside = new Set<string>();
  const stack: Array<[number, number]> = [];
  const push = (i: number, j: number): void => {
    const k = `${i},${j}`;
    if (i < 0 || j < 0 || i > nx || j > nz) return;
    if (free.has(k) || outside.has(k)) return;
    outside.add(k);
    stack.push([i, j]);
  };
  for (let i = 0; i <= nx; i++) {
    push(i, 0);
    push(i, nz);
  }
  for (let j = 0; j <= nz; j++) {
    push(0, j);
    push(nx, j);
  }
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number];
    for (const [di, dj] of NEIGHBOURS) push(i + di, j + dj);
  }

  let enclosed = 0;
  const seen = new Set<string>();
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      const k = `${i},${j}`;
      if (free.has(k) || outside.has(k) || seen.has(k)) continue;
      enclosed++;
      const walk: Array<[number, number]> = [[i, j]];
      seen.add(k);
      while (walk.length > 0) {
        const [a, b] = walk.pop() as [number, number];
        for (const [di, dj] of NEIGHBOURS) {
          const na = a + di;
          const nb = b + dj;
          const nk = `${na},${nb}`;
          if (na < 0 || nb < 0 || na > nx || nb > nz) continue;
          if (free.has(nk) || outside.has(nk) || seen.has(nk)) continue;
          seen.add(nk);
          walk.push([na, nb]);
        }
      }
    }
  }
  return enclosed;
}
