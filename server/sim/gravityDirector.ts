/**
 * Gravity failure as an escalation beat (DESIGN.md §4 "Gravity failure — a
 * set-piece, never a surprise", §5's escalation table).
 *
 * The locomotion pivot made walking the default and zero-G a per-module
 * condition. This class is the half of that condition the *round* owns: the
 * escalation director says how many modules may be floorless at the current
 * stage (`DirectorStageConfig.gravityFailures`, crew-scaled), and this decides
 * WHICH ones, WHEN, and when the floor comes back.
 *
 * It never writes gravity directly. Every change goes through
 * `ModuleGraph.scheduleGravity()`, which is the announced path:
 *
 *   1. `GRAVITY_WARNING_S` (2.5 s) of warning, broadcast to every client as a
 *      `gravity` message carrying `inMs`. The plant winds down audibly first;
 *      the floor never simply vanishes under anyone. 2.5 s is 6.0 m at a sprint,
 *      more than a module length, so from anywhere in the room you can reach a
 *      rail — that is the fairness guarantee the whole beat rests on.
 *   2. On landing, a `gravity-shift` NoiseEvent at `LOUDNESS.GRAVITY_SHIFT` (35,
 *      about two modules) emitted **at the module centre, not at any player**.
 *      Nobody caused it, so nobody is blamed for it — but the alien hears it and
 *      moves, so a failure is a real event on the map rather than weather.
 *   3. Everyone standing gets a `liftoff`; anyone already airborne keeps
 *      floating. That is the client's half (§4) and needs nothing from here.
 *
 * A director failure self-repairs after `GRAVITY_FAIL_DURATION_MS` (90 s),
 * announced exactly the same way with cause `'restored'`, so the floor coming
 * back is as legible as it going away. A §11 puzzle can restore it sooner
 * through `restore()`.
 *
 * ===========================================================================
 * ELIGIBILITY — the decisions this file makes, written down
 * ===========================================================================
 *
 * "Never drop gravity in a module in a way that traps a player with no route
 * out" is the hard constraint. Five rules implement it, and the fifth is the
 * one that matters most:
 *
 * 1. **Budget.** `zeroGCount()` (authored + dropped) may never exceed the
 *    authored count plus the current stage's crew-scaled `gravityFailures`, nor
 *    `ZERO_G_FRACTION_MAX` of the station. The table is [0, 0, 1, 1, 2] by
 *    stage, so nothing at all happens before stage 2 and the pair only arrives
 *    at stage 4 with undock live. Solo crews are capped at one by
 *    `crewScaledStage` — a lone player has nobody to cycle a hatch for them.
 *
 * 2. **Never the escape or finale module.** §11's finale is three players
 *    holding levers in three modules and the escape module is where a round
 *    ends; dropping the floor there turns the climax into a physics accident
 *    nobody can read. Not in the design doc — a judgement call, made here.
 *
 * 3. **The module must have handrails, and a way out through them.** A module
 *    with no rails is a room with nothing to grab: `LIFTOFF_IMPULSE_M_S` is
 *    0.6 m/s and there is no wall-push verb, so a body that drifts away from the
 *    deck there has no way to move at all. That is the literal trap. It must
 *    also have at least one unsealed port, or the room is a box with the floor
 *    removed.
 *
 * 4. **Never adjacent to another zero-G module.** This is what keeps a chain
 *    from forming. Every floorless module is guaranteed a neighbouring module
 *    with a floor, so the worst case a player ever faces is ONE room of
 *    zero-G between them and a deck — never a corridor of it. It also means the
 *    authored zero-G modules (§2's budget of two, chosen for meaning) are never
 *    extended into a region.
 *
 * 5. **Never a cut vertex of the walking graph.** A module every route between
 *    two halves of the station passes through is not allowed to lose its floor:
 *    a crew separated by a floorless bottleneck is a crew that cannot regroup on
 *    foot, and §11's parallel puzzles converge. Computed by removing the
 *    candidate and asking whether the remaining modules are still connected
 *    through unsealed hatches.
 *
 * And one preference rather than a rule: the roll is weighted toward a module
 * holding exactly ONE living player. §5 puts the first failure at stage 2,
 * "where §11 has the team split across parallel puzzles, so it lands on somebody
 * working alone" — that is the beat, and an empty module losing its floor is a
 * fact nobody experiences.
 */

import {
  GRAVITY_FAIL_DURATION_MS,
  GRAVITY_WARNING_S,
  ZERO_G_FRACTION_MAX,
  crewScaledStage,
} from '@shared/constants';
import type {
  DirectorStage,
  GravityCause,
  GravityMode,
  GravityShiftEvent,
  ModuleId,
} from '@shared/types';
import type { ModuleGraph } from '@shared/graph/moduleGraph';
import { PASSABLE_ALIEN } from '@shared/graph/moduleGraph';
import type { PlayerView, SimContext } from './contracts';
import { livingPlayerCount } from './contracts';

/**
 * ms between one failure landing and the next being considered.
 *
 * Two modules losing their floor inside the same breath is the difference
 * between an escalation beat and a physics accident: the crew has to be able to
 * attribute the sound to a place. Long enough to also cover the 2.5 s warning of
 * whichever failure is currently in flight.
 */
export const GRAVITY_FAILURE_SPACING_MS = 25_000;

/**
 * ms after the round starts before the first failure may be announced.
 *
 * §10's reunion phase is the one stretch of the round where players are alone,
 * unarmed and have not found each other yet, and the alien's own round-start
 * grace covers the same window. Losing the floor in it would be the least
 * legible possible introduction to a mechanic nobody has seen work yet.
 */
export const GRAVITY_FIRST_FAILURE_DELAY_MS = 60_000;

/** Relative weight of a module holding exactly one living player. §5's stage-2
 *  beat is meant to land on somebody working alone. */
export const WEIGHT_LONE_PLAYER = 4;
/** …two or more. A crowd can help each other; it is a weaker beat. */
export const WEIGHT_CROWD = 0.5;
/** …and nobody at all. Still legal — the floor failing somewhere you have to
 *  walk through later is a real complication — just not the first choice. */
export const WEIGHT_EMPTY = 1;

export interface GravityDirectorOptions {
  /** ms between failures. Defaults to `GRAVITY_FAILURE_SPACING_MS`. */
  spacingMs?: number;
  /** ms of round-start quiet. Defaults to `GRAVITY_FIRST_FAILURE_DELAY_MS`. */
  firstFailureDelayMs?: number;
  /** ms a director-dropped module stays floorless. Defaults to
   *  `GRAVITY_FAIL_DURATION_MS` (90 s). `Infinity` never repairs. */
  failureDurationMs?: number;
  /** Modules the director must never touch, on top of escape and finale. */
  neverDrop?: readonly ModuleId[];
}

/** What one `GravityDirector.update()` produced. */
export interface GravityUpdate {
  /** Changes scheduled this tick, still counting down their 2.5 s warning. */
  announced: GravityShiftEvent[];
  /** Changes whose warning ran out this tick — the floor has actually moved. */
  landed: GravityShiftEvent[];
}

/** One module the director is currently holding floorless. */
interface Failure {
  module: ModuleId;
  /** ms until it repairs itself. `Infinity` for a permanent failure. */
  msLeft: number;
  /** True once the repair has been announced and is counting down its warning. */
  repairing: boolean;
}

export class GravityDirector {
  private readonly spacingMs: number;
  private readonly firstDelayMs: number;
  private readonly durationMs: number;
  private readonly never = new Set<ModuleId>();

  private failures: Failure[] = [];
  private sinceStartMs = 0;
  private cooldownMs = 0;
  /** Announcements made during the current `update()`, drained by it. */
  private announced: GravityShiftEvent[] = [];

  constructor(private readonly graph: ModuleGraph, opts: GravityDirectorOptions = {}) {
    this.spacingMs = opts.spacingMs ?? GRAVITY_FAILURE_SPACING_MS;
    this.firstDelayMs = opts.firstFailureDelayMs ?? GRAVITY_FIRST_FAILURE_DELAY_MS;
    this.durationMs = opts.failureDurationMs ?? GRAVITY_FAIL_DURATION_MS;
    for (const id of opts.neverDrop ?? []) this.never.add(id);
  }

  /** Modules the director is currently holding floorless. */
  get held(): readonly ModuleId[] {
    return this.failures.map((f) => f.module);
  }

  /** ms until the next failure may be announced. 0 when one could land now. */
  get msToNextFailure(): number {
    return Math.max(this.cooldownMs, this.firstDelayMs - this.sinceStartMs);
  }

  /**
   * One simulation step.
   *
   * Returns both halves of §4's beat, because the room does something different
   * with each:
   *
   * - `announced` — a change that has just been scheduled and is counting down
   *   its `GRAVITY_WARNING_S`. The room broadcasts it so every client can start
   *   the plant winding down. The floor has NOT moved yet.
   * - `landed` — a countdown that ran out this tick. The room emits the
   *   `gravity-shift` NoiseEvent at the module centre and the regime is now
   *   actually different.
   *
   * Nothing else in the server may write gravity: `ModuleGraph.setGravity()` is
   * for level load, and this is the announced path everything else goes through.
   */
  update(dtMs: number, ctx: SimContext): GravityUpdate {
    this.sinceStartMs += dtMs;
    if (this.cooldownMs > 0) this.cooldownMs = Math.max(0, this.cooldownMs - dtMs);

    this.tickRepairs(dtMs, ctx.tick);
    this.considerFailure(ctx);

    // The graph owns the countdown for every announced change, ours and any a
    // puzzle scheduled; this is the single place it is advanced.
    const landed = this.graph.tickGravity(dtMs, ctx.tick);
    // DRAINED, not cleared at the top: `drop()` and `restore()` are also called
    // straight from a message handler between ticks (a puzzle turning the floor
    // back on), and clearing first would throw that announcement away before
    // anybody heard about it — a floor that moves with no warning, which is the
    // one thing §4 forbids.
    const announced = this.announced;
    this.announced = [];
    return { announced, landed };
  }

  /**
   * Restore a module's floor early — §11's "go turn the floor back on".
   * Announced like everything else, so the crew hears the plant spin up.
   * Returns the announcement, or null if the module was not ours to fix.
   */
  restore(module: ModuleId, tick: number, cause: GravityCause = 'puzzle'): GravityShiftEvent | null {
    const at = this.failures.findIndex((f) => f.module === module);
    if (at < 0) return null;
    const event = this.graph.scheduleGravity(module, 'nominal', cause, tick);
    if (!event) return null;
    this.failures.splice(at, 1);
    this.announced.push(event);
    return event;
  }

  /**
   * Announce a specific module (damage, scripting, a test). Runs the same
   * eligibility gate as the automatic roll, so nothing can bypass the traps
   * check by calling this instead. Returns the announcement, or null.
   */
  drop(
    module: ModuleId,
    ctx: SimContext,
    cause: GravityCause = 'director',
  ): GravityShiftEvent | null {
    if (!this.eligible(module, ctx)) return null;
    const event = this.graph.scheduleGravity(module, 'zero', cause, ctx.tick);
    if (!event) return null;
    this.failures.push({ module, msLeft: this.durationMs, repairing: false });
    this.cooldownMs = this.spacingMs;
    this.announced.push(event);
    return event;
  }

  /** Round reset: every module back to the value the level authored. */
  reset(): ModuleId[] {
    this.failures = [];
    this.sinceStartMs = 0;
    this.cooldownMs = 0;
    return this.graph.resetGravity();
  }

  // -- internals ------------------------------------------------------------

  private tickRepairs(dtMs: number, tick: number): void {
    if (this.failures.length === 0) return;
    const still: Failure[] = [];
    for (const failure of this.failures) {
      const pending = this.graph.pendingGravity(failure.module);
      const floorless = this.graph.gravityOf(failure.module) === 'zero';

      if (failure.repairing) {
        // Hold it until the repair has actually landed — it still counts
        // against the budget while the floor is on its way back, or the
        // director would start a second failure during the announcement.
        if (!floorless && !pending) continue;
        still.push(failure);
        continue;
      }

      // Announced but not landed yet: ours, counted, and the 90 s clock has not
      // started. Starting it here would run most of the failure's life down
      // during a 2.5 s warning nobody has felt yet — and, worse, the module is
      // still `'nominal'` at this point, so the "somebody restored it" test
      // below would throw the failure away one tick after announcing it and let
      // the director drop another module every `spacingMs` forever.
      if (pending && pending.to === 'zero') {
        still.push(failure);
        continue;
      }

      // Somebody (a puzzle, a hand edit) put the floor back: no longer ours.
      if (!floorless) continue;

      failure.msLeft -= dtMs;
      if (failure.msLeft > 0) {
        still.push(failure);
        continue;
      }
      // 90 s are up. The floor comes back on the same announced path it left by,
      // because a floor reappearing under a floating body without warning is the
      // same unfairness as one vanishing under a standing one.
      const event = this.graph.scheduleGravity(failure.module, 'nominal', 'restored', tick);
      if (event) {
        this.announced.push(event);
        failure.repairing = true;
      }
      still.push(failure);
    }
    this.failures = still;
  }

  private considerFailure(ctx: SimContext): void {
    if (this.cooldownMs > 0) return;
    if (this.sinceStartMs < this.firstDelayMs) return;
    if (this.budgetLeft(ctx) <= 0) return;
    // Never two announcements in flight at once: the warning is the mechanic.
    for (const id of this.graph.ids()) if (this.graph.pendingGravity(id)) return;

    const module = this.pick(ctx);
    if (!module) return;
    this.drop(module, ctx);
  }

  /**
   * How many more modules the director may be holding floorless right now.
   *
   * Two ceilings, and the tighter one wins: the crew-scaled stage row, and
   * `ZERO_G_FRACTION_MAX` of the whole station. The second is the one that
   * survives somebody raising the first — §14 pins the two to each other so the
   * check fails the moment they drift apart.
   */
  private budgetLeft(ctx: SimContext): number {
    const stage = crewScaledStage(ctx.stage as DirectorStage, livingPlayerCount(ctx));
    const byStage = stage.gravityFailures - this.failures.length;
    const total = this.graph.size;
    const byFraction = Math.floor(total * ZERO_G_FRACTION_MAX) - this.graph.zeroGCount();
    return Math.min(byStage, byFraction);
  }

  /** Weighted roll over the eligible modules. Null if none qualify. */
  private pick(ctx: SimContext): ModuleId | null {
    const weights = new Map<ModuleId, number>();
    for (const id of this.graph.ids()) {
      if (!this.eligible(id, ctx)) continue;
      weights.set(id, this.weightOf(id, ctx.players));
    }
    if (weights.size === 0) return null;

    let total = 0;
    for (const w of weights.values()) total += w;
    let roll = ctx.rng() * total;
    for (const [id, w] of weights) {
      roll -= w;
      if (roll <= 0) return id;
    }
    let last: ModuleId | null = null;
    for (const id of weights.keys()) last = id;
    return last;
  }

  private weightOf(module: ModuleId, players: readonly PlayerView[]): number {
    let here = 0;
    for (const p of players) {
      if (!p.alive || p.escaped) continue;
      if (p.module === module) here++;
    }
    if (here === 1) return WEIGHT_LONE_PLAYER;
    if (here > 1) return WEIGHT_CROWD;
    return WEIGHT_EMPTY;
  }

  /** The five rules at the top of this file, in order. */
  eligible(module: ModuleId, ctx: SimContext): boolean {
    const m = this.graph.get(module);
    if (!m) return false;
    if (this.never.has(module)) return false;
    if (module === ctx.layout.escapeModule || module === ctx.layout.finaleModule) return false;

    // Already floorless, or already on its way there.
    if (this.graph.gravityOf(module) === 'zero') return false;
    if (this.graph.pendingGravity(module)) return false;
    // Authored zero-G is §2's deliberate budget, not the director's to spend.
    if (this.graph.authoredGravity(module) === 'zero') return false;

    // Rule 3 — something to grab, and somewhere to go.
    if (m.rails.length === 0) return false;
    if (!m.ports.some((p) => p.link !== null && !p.hatch.sealed)) return false;

    // Rule 4 — never adjacent to another floorless module.
    for (const edge of this.graph.edges(module)) {
      if (this.graph.gravityOf(edge.to) === 'zero') return false;
      const pending = this.graph.pendingGravity(edge.to);
      if (pending && pending.to === 'zero') return false;
    }

    // Rule 5 — never a bottleneck the crew has to walk through.
    if (this.isCutVertex(module)) return false;

    return true;
  }

  /**
   * Would removing `module` from the walking graph split the station?
   *
   * Uses the same `PASSABLE_ALIEN` predicate the alien's A* does — an unsealed
   * hatch is a route, because a closed one can be cycled — so this asks the
   * question a player asks: "can I still get from here to there on foot?"
   */
  private isCutVertex(module: ModuleId): boolean {
    const ids = this.graph.ids().filter((id) => id !== module);
    if (ids.length <= 1) return false;

    const remaining = new Set(ids);
    const start = ids[0];
    const seen = new Set<ModuleId>([start]);
    const queue: ModuleId[] = [start];
    while (queue.length > 0) {
      const at = queue.shift() as ModuleId;
      for (const edge of this.graph.edges(at)) {
        if (edge.to === module) continue;
        if (!remaining.has(edge.to) || seen.has(edge.to)) continue;
        if (!PASSABLE_ALIEN(edge)) continue;
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
    return seen.size < remaining.size;
  }
}

/** Seconds of warning every announced change carries. Re-exported so the room
 *  and any test read the same number the graph schedules with. */
export const GRAVITY_WARNING_SECONDS = GRAVITY_WARNING_S;

/** Handy for logging: is this module floorless right now? */
export function isZeroG(graph: ModuleGraph, module: ModuleId): boolean {
  return graph.gravityOf(module) === ('zero' satisfies GravityMode);
}
