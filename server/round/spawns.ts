/**
 * Random spawns (DESIGN.md §10).
 *
 * "Every player wakes alone, in a random module, on emergency lighting, with no
 * idea where anyone else is."
 *
 * Constraints on the roll:
 *   - No two players in the same module.
 *   - Minimum one hop apart (SPAWN_MIN_HOPS_BETWEEN_PLAYERS).
 *   - Never in the escape module, never in the finale module.
 *   - The alien spawns at least three hops (ALIEN_SPAWN_MIN_HOPS) from the
 *     MAJORITY of players — "without that floor, someone dies at the ten-second
 *     mark and spectates for twenty minutes."
 *
 * This is a constrained random roll, not a puzzle: randomised restarts, then a
 * documented ladder of relaxations. It never loops forever and never throws —
 * a station too small for the constraints still produces a playable round, and
 * says which constraint it had to give up.
 */

import {
  ALIEN_SPAWN_MIN_HOPS,
  SPAWN_MIN_HOPS_BETWEEN_PLAYERS,
} from '@shared/constants';
import type { ModuleId, PlayerId, StationLayout } from '@shared/types';
import { ModuleGraph, PASSABLE_ALIEN } from '@shared/graph/moduleGraph';

export interface SpawnPlan {
  /** Module per player, in the order they were passed in. */
  players: Map<PlayerId, ModuleId>;
  alien: ModuleId;
  /** Constraints that had to be relaxed, in plain language. Empty when clean. */
  relaxed: string[];
}

const MAX_ATTEMPTS = 200;

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    out[i] = out[j];
    out[j] = a;
  }
  return out;
}

/**
 * Modules a player may wake up in: everything except escape, finale, and an
 * AUTHORED zero-G module (§10).
 *
 * The gravity clause is the pivot's addition to this list and §10 states it
 * outright: "Never in an authored zero-G module. The first thirty seconds are
 * when a player builds the mental model of the station that pillar 3 exists to
 * protect, and they should build it standing up." It also front-loads exactly
 * the motion sickness §4's pivot exists to spread thin.
 *
 * MEASURED before this clause existed: on the shipped nine-module level (two
 * authored `zero`, `tube-spine` and `airlock-eva`) two round restarts out of
 * four woke the local player floating in `airlock-eva`.
 *
 * `authoredGravity`, not `gravityOf`: the round begins precisely as authored
 * (§5 — stage 0's failure budget is zero), so at roll time the two agree; using
 * the authored value keeps that true even if a caller ever rolls spawns while a
 * director failure is still standing.
 *
 * The filter is dropped rather than enforced if it would leave nothing to roll,
 * which is the same ladder-of-relaxations rule the rest of this file follows.
 */
export function playerSpawnCandidates(graph: ModuleGraph, layout: StationLayout): ModuleId[] {
  return graph
    .ids()
    .filter((id) => id !== layout.escapeModule && id !== layout.finaleModule);
}

/**
 * The subset of the above that has a floor to wake up on — the set every roll
 * below tries FIRST.
 *
 * It is a preference and not a hard filter for an arithmetic reason worth
 * stating: §2 allows `ZERO_G_AUTHORED_MAX` (2) authored zero-G modules out of
 * 8–10, and §10 already spends two more on the escape and finale rooms. On the
 * shipped nine-module level that leaves five floored candidates against
 * `MAX_PLAYERS` 6, so a hard filter would trade §10's gravity clause for §10's
 * "no two players in the same module" — a worse deal, because a co-located pair
 * loses the reunion phase outright while a zero-G waker loses some comfort.
 * So: floored first, zero-G before sharing, sharing last, and each step says so
 * in `relaxed`.
 */
export function flooredSpawnCandidates(graph: ModuleGraph, layout: StationLayout): ModuleId[] {
  return playerSpawnCandidates(graph, layout).filter(
    (id) => graph.authoredGravity(id) === 'nominal',
  );
}

/** Hop distances from every module to every module, computed once per roll. */
function hopTable(graph: ModuleGraph): Map<ModuleId, Map<ModuleId, number>> {
  const table = new Map<ModuleId, Map<ModuleId, number>>();
  for (const id of graph.ids()) {
    table.set(id, graph.hopsFrom(id, { passable: PASSABLE_ALIEN }));
  }
  return table;
}

function hops(
  table: Map<ModuleId, Map<ModuleId, number>>,
  a: ModuleId,
  b: ModuleId,
): number {
  const value = table.get(a)?.get(b);
  return value === undefined ? -1 : value;
}

/**
 * Roll spawns for the whole crew plus the alien.
 *
 * `rng` is injected so a round can be replayed from a seed.
 */
export function solveSpawns(
  graph: ModuleGraph,
  layout: StationLayout,
  playerIds: readonly PlayerId[],
  rng: () => number = Math.random,
): SpawnPlan {
  const relaxed: string[] = [];
  const candidates = playerSpawnCandidates(graph, layout);
  const table = hopTable(graph);

  const fallbackModule = candidates[0] ?? graph.ids()[0] ?? layout.escapeModule;
  const players = new Map<PlayerId, ModuleId>();

  if (candidates.length === 0) {
    relaxed.push('no module is a legal player spawn; everyone starts in the escape module');
    for (const id of playerIds) players.set(id, fallbackModule);
    return { players, alien: fallbackModule, relaxed };
  }

  // --- players -------------------------------------------------------------
  // Randomised restarts at the full constraint, then a ladder of relaxations.
  let minHops = SPAWN_MIN_HOPS_BETWEEN_PLAYERS;
  let assignment: Map<PlayerId, ModuleId> | null = null;

  // §10's gravity clause is the FIRST thing tried and the first thing given up:
  // "Never in an authored zero-G module … they should build [the mental model]
  // standing up." Waking with no floor front-loads exactly the motion sickness
  // §4's pivot exists to spread thin, so it is only spent when the alternative
  // is two people waking in the same room, which costs the reunion phase itself.
  const floored = flooredSpawnCandidates(graph, layout);
  const pools: ModuleId[][] =
    floored.length > 0 && floored.length < candidates.length ? [floored, candidates] : [candidates];

  for (let p = 0; p < pools.length && assignment === null; p++) {
    // A pool's relaxations are provisional until it produces an assignment: the
    // floored pool may give up a hop and then fail anyway, and a `relaxed` line
    // for something that did not end up happening is worse than none.
    const note: string[] = [];
    if (p > 0) note.push('not enough modules with a floor; somebody wakes up in zero-G');
    minHops = SPAWN_MIN_HOPS_BETWEEN_PLAYERS;
    while (assignment === null && minHops >= 1) {
      assignment = tryAssign(playerIds, pools[p], table, minHops, rng);
      if (assignment !== null) break;
      minHops--;
      if (minHops >= 1) {
        note.push(`could not keep every player ${minHops + 1} hops apart; relaxed to ${minHops}`);
      }
    }
    if (assignment !== null) relaxed.push(...note);
  }

  if (assignment === null) {
    // More players than modules. Share, but spread as evenly as we can.
    relaxed.push('more players than legal spawn modules; some players share a module');
    assignment = new Map<PlayerId, ModuleId>();
    const order = shuffled(candidates, rng);
    playerIds.forEach((id, i) => assignment!.set(id, order[i % order.length]));
  }

  for (const [id, module] of assignment) players.set(id, module);

  // --- alien ---------------------------------------------------------------
  const occupied = new Set(players.values());
  const alienCandidates = shuffled(
    graph.ids().filter((id) => !occupied.has(id)),
    rng,
  );
  const crew = [...players.values()];
  const needed = Math.floor(crew.length / 2) + 1; // strict majority

  let alien: ModuleId | null = null;
  let bestModule: ModuleId | null = null;
  let bestFar = -1;

  for (const candidate of alienCandidates) {
    let far = 0;
    for (const module of crew) {
      const d = hops(table, candidate, module);
      if (d < 0 || d >= ALIEN_SPAWN_MIN_HOPS) far++;
    }
    if (far > bestFar) {
      bestFar = far;
      bestModule = candidate;
    }
    if (crew.length === 0 || far >= needed) {
      alien = candidate;
      break;
    }
  }

  if (alien === null) {
    alien = bestModule ?? shuffled(graph.ids(), rng)[0] ?? fallbackModule;
    if (crew.length > 0) {
      relaxed.push(
        `no module sits ${ALIEN_SPAWN_MIN_HOPS} hops from a majority of the crew; ` +
          `alien placed at the furthest available module (${bestFar}/${crew.length} clear)`,
      );
    }
  }

  return { players, alien, relaxed };
}

/** One randomised attempt at a full player assignment. */
function tryAssign(
  playerIds: readonly PlayerId[],
  candidates: readonly ModuleId[],
  table: Map<ModuleId, Map<ModuleId, number>>,
  minHops: number,
  rng: () => number,
): Map<PlayerId, ModuleId> | null {
  if (playerIds.length === 0) return new Map();
  if (playerIds.length > candidates.length) return null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const order = shuffled(candidates, rng);
    const taken: ModuleId[] = [];
    const assignment = new Map<PlayerId, ModuleId>();

    for (const player of playerIds) {
      const pick = order.find(
        (module) =>
          !taken.includes(module) &&
          taken.every((other) => {
            const d = hops(table, module, other);
            return d < 0 || d >= minHops;
          }),
      );
      if (pick === undefined) break;
      taken.push(pick);
      assignment.set(player, pick);
    }

    if (assignment.size === playerIds.length) return assignment;
  }
  return null;
}

/**
 * Spawn for ONE late joiner, keeping the same constraints against the players
 * already in the station AND against the alien — waking up inside its module is
 * exactly the ten-second death §10 puts the three-hop floor there to prevent.
 *
 * Ladder: legal and clear of the alien → legal but closer to the alien → any
 * free module that is at least not the alien's → anything at all.
 */
export function pickLateSpawn(
  graph: ModuleGraph,
  layout: StationLayout,
  occupied: readonly ModuleId[],
  rng: () => number = Math.random,
  alienModule: ModuleId | null = null,
): { module: ModuleId; relaxed: string | null } {
  // Floored modules first at EVERY rung below, because `find` takes the first
  // match: a late joiner gets a floor unless nothing with one is left (§10).
  const floored = new Set(flooredSpawnCandidates(graph, layout));
  const legal = playerSpawnCandidates(graph, layout);
  const candidates = [
    ...shuffled(legal.filter((id) => floored.has(id)), rng),
    ...shuffled(legal.filter((id) => !floored.has(id)), rng),
  ];
  if (candidates.length === 0) {
    return { module: graph.ids()[0] ?? layout.escapeModule, relaxed: 'no legal spawn module' };
  }
  const table = hopTable(graph);

  const clearOfCrew = (module: ModuleId): boolean =>
    !occupied.includes(module) &&
    occupied.every((other) => {
      const d = hops(table, module, other);
      return d < 0 || d >= SPAWN_MIN_HOPS_BETWEEN_PLAYERS;
    });

  const alienHops = (module: ModuleId): number => {
    if (alienModule === null) return Number.POSITIVE_INFINITY;
    const d = hops(table, module, alienModule);
    // Unreachable is the safest place there is, not the closest.
    return d < 0 ? Number.POSITIVE_INFINITY : d;
  };

  const clean = candidates.find(
    (module) => clearOfCrew(module) && alienHops(module) >= ALIEN_SPAWN_MIN_HOPS,
  );
  if (clean !== undefined) return { module: clean, relaxed: null };

  const crewOnly = candidates.find((module) => clearOfCrew(module) && alienHops(module) > 0);
  if (crewOnly !== undefined) {
    return {
      module: crewOnly,
      relaxed: `late joiner spawned within ${ALIEN_SPAWN_MIN_HOPS} hops of the alien`,
    };
  }

  const free = candidates.find((module) => !occupied.includes(module) && alienHops(module) > 0);
  if (free !== undefined) {
    return { module: free, relaxed: 'late joiner spawned closer than one hop from the crew' };
  }
  return { module: candidates[0], relaxed: 'late joiner shares a module with someone' };
}

/**
 * Deterministic, seedable RNG (mulberry32). A seed of 0 means "surprise me" and
 * returns `Math.random`.
 */
export function makeRng(seed: number): () => number {
  if (!seed) return Math.random;
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
