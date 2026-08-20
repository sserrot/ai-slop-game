/**
 * Noise propagation and coalescing (DESIGN.md §3).
 *
 * "The heart of the project. Lives in shared/ because the server is
 * authoritative but clients need it locally for audio."
 *
 *   level(module) = loudness
 *                 - ATTENUATION_PER_M * distanceMetres
 *                 - Σ hatchAttenuation(edges crossed)
 *   stop expanding when level < FLOOR
 *
 * §14 stores hatch attenuation as NEGATIVE dB offsets (-3 / -25 / -40), so the
 * implementation ADDS them, which is the same arithmetic as the doc's `Σ`.
 */

import {
  ATTENUATION_PER_M,
  DISCARD_MARGIN,
  FLOOR,
  HATCH_OPEN,
  REPEAT_PENALTY_M,
  REPEAT_PENALTY_MAX_M,
  WINDOW_MS,
  errorRadius,
} from '@shared/constants';
import type {
  ListenerResolution,
  ModuleArrival,
  ModuleId,
  NoiseEvent,
  Vec3,
} from '@shared/types';
import { cloneV3, distance, jitterPoint } from '@shared/graph/math';
import { arrivalWorkspace, type ArrivalWorkspace } from '@shared/graph/moduleGraph';
import type { ModuleGraph, PropagationOptions } from '@shared/graph/moduleGraph';

export { errorRadius } from '@shared/constants';
export type { PropagationOptions } from '@shared/graph/moduleGraph';
export { arrivalWorkspace, type ArrivalWorkspace } from '@shared/graph/moduleGraph';

/** One propagated NoiseEvent, resolvable against any listener. */
export interface Propagation {
  readonly event: NoiseEvent;
  /** Best-case level in each reachable module, measured at its entry port. */
  readonly levels: ReadonlyMap<ModuleId, number>;
  /** Full arrival record per module, including the port the sound came through. */
  readonly arrivals: ReadonlyMap<ModuleId, ModuleArrival>;
  /** True if the sound reaches this module above the floor at all. */
  reaches(module: ModuleId): boolean;
  /**
   * What one listener hears. `throughPort` is the Port the sound arrives
   * through for cross-module paths and is REQUIRED — §8 pans audio there.
   */
  resolve(listenerPos: Vec3, listenerModule: ModuleId): ListenerResolution;
}

/**
 * Level reported when a sound does not reach the listener's module at all.
 * Deliberately 0 and not -Infinity: an inaudible result is still fed into gain
 * maths by callers, and a single non-finite value poisons a Web Audio
 * AudioParam permanently. ALWAYS check `audible` before using the rest.
 */
const INAUDIBLE_LEVEL = 0;

/**
 * THE propagation function. Run it once per event, then `resolve()` per listener
 * — the graph walk is shared, the per-listener part is a distance and a lookup.
 */
export function propagate(
  event: NoiseEvent,
  graph: ModuleGraph,
  opts: PropagationOptions = {},
  out?: PropagationBuffer,
): Propagation {
  const buffer = out ?? propagationBuffer();
  buffer.run(event, graph, opts);
  return buffer;
}

/**
 * A reusable `Propagation`.
 *
 * `propagate()` used to mint the arrivals map, a levels map, three closures and
 * a `ModuleArrival` per module on every single noise event — measured at 7.4 KB
 * a go, and a busy round runs ten to fifteen of them a second between the local
 * player, five peers and the tracker. A caller that propagates repeatedly
 * (`NoiseRuntime`, `NetClient`) keeps one of these and hands it in.
 *
 * CALLER-OWNED for the same reason as `ArrivalWorkspace`: `shared/` runs on the
 * server, where rooms are concurrent. The buffer, the arrivals it exposes and
 * the levels map are all overwritten by the next `propagate()` on the same
 * buffer — READ THEM, NEVER KEEP THEM. What `resolve()` returns is a fresh
 * object every time and is safe to keep, which is what matters, because that is
 * the one that goes out on the bus (§8).
 */
export class PropagationBuffer implements Propagation {
  event: NoiseEvent = EMPTY_EVENT;
  arrivals: ReadonlyMap<ModuleId, ModuleArrival> = EMPTY_ARRIVALS;

  private readonly work: ArrivalWorkspace = arrivalWorkspace();
  private readonly levelsMap = new Map<ModuleId, number>();
  private levelsFresh = false;
  private attPerM = ATTENUATION_PER_M;
  private floor = FLOOR;

  /**
   * Built on demand. Nothing in the client or the server reads it — `resolve()`
   * and `carryReport()` both go through `arrivals` — and rebuilding a Map per
   * event for a view nobody asks for was pure garbage.
   */
  get levels(): ReadonlyMap<ModuleId, number> {
    if (!this.levelsFresh) {
      this.levelsFresh = true;
      this.levelsMap.clear();
      for (const [id, arrival] of this.arrivals) this.levelsMap.set(id, arrival.level);
    }
    return this.levelsMap;
  }

  /** Re-run the walk in place. */
  run(event: NoiseEvent, graph: ModuleGraph, opts: PropagationOptions = {}): this {
    this.event = event;
    this.attPerM = opts.attenuationPerM ?? ATTENUATION_PER_M;
    this.floor = opts.floor ?? FLOOR;
    this.arrivals = graph.bfsAttenuated(
      event.module,
      event.origin,
      event.loudness,
      opts,
      this.work,
    );
    this.levelsFresh = false;
    return this;
  }

  reaches(module: ModuleId): boolean {
    return this.arrivals.has(module);
  }

  resolve(listenerPos: Vec3, listenerModule: ModuleId): ListenerResolution {
    const event = this.event;
    const arrival = this.arrivals.get(listenerModule);
    if (!arrival) {
      return {
        level: INAUDIBLE_LEVEL,
        audible: false,
        throughPort: null,
        panPosition: cloneV3(event.origin),
        distance: Number.MAX_VALUE,
        hops: -1,
        hatchDb: 0,
        worstHatchDb: 0,
        occluded: true,
      };
    }

    // Distance from where the sound entered this module to the listener.
    const lastLeg = distance(arrival.entryPoint, listenerPos);
    const totalDistance = arrival.distance + lastLeg;
    const level = event.loudness - this.attPerM * totalDistance + arrival.hatchDb;

    // §8: cross-module sound is panned at the connecting port, never along the
    // source's true bearing through the bulkhead.
    const panPosition =
      arrival.throughPort === null ? cloneV3(event.origin) : cloneV3(arrival.entryPoint);

    return {
      level,
      audible: level >= this.floor,
      // Copied, not shared: the arrival is pooled and will be rewritten by the
      // next walk, and this resolution outlives it — it goes on the bus.
      throughPort:
        arrival.throughPort === null
          ? null
          : { module: arrival.throughPort.module, port: arrival.throughPort.port },
      panPosition,
      distance: totalDistance,
      hops: arrival.hops,
      hatchDb: arrival.hatchDb,
      worstHatchDb: arrival.worstHatchDb,
      // Any closed or sealed hatch on the path → lowpass at 400 Hz (§8).
      // `worstHatchDb` is 0 when nothing was crossed, -3 through open hatches.
      occluded: arrival.worstHatchDb < HATCH_OPEN,
    };
  }
}

/** One propagation buffer. Keep it next to whatever propagates repeatedly. */
export function propagationBuffer(): PropagationBuffer {
  return new PropagationBuffer();
}

const EMPTY_ARRIVALS: ReadonlyMap<ModuleId, ModuleArrival> = new Map();
const EMPTY_EVENT: NoiseEvent = {
  kind: 'footstep',
  origin: { x: 0, y: 0, z: 0 },
  module: '',
  loudness: 0,
  t: 0,
};

/**
 * Convenience: propagate and resolve for a single listener in one call.
 * Use `propagate()` directly when several listeners share one event.
 */
export function resolveFor(
  event: NoiseEvent,
  graph: ModuleGraph,
  listenerPos: Vec3,
  listenerModule: ModuleId,
  opts: PropagationOptions = {},
  out?: PropagationBuffer,
): ListenerResolution {
  return propagate(event, graph, opts, out).resolve(listenerPos, listenerModule);
}

/**
 * The §5 INVESTIGATE target: `origin + randomInSphere(errorRadius(level))`.
 * Pass `extraRadius` for the coalescer's per-module repeat penalty.
 */
export function investigationPoint(
  origin: Vec3,
  arrivalLevel: number,
  extraRadius = 0,
  rng: () => number = Math.random,
): Vec3 {
  return jitterPoint(origin, errorRadius(arrivalLevel) + extraRadius, rng);
}

// ===========================================================================
// Coalescing (§3)
// ===========================================================================

/** One candidate inside a coalescing window: the event plus the level that
 *  actually arrived at the alien. */
export interface CoalescerInput {
  event: NoiseEvent;
  /** Arrival level at the listener (the alien), NOT source loudness. */
  level: number;
  /** Wall-clock ms the event was pushed. */
  at: number;
}

/** The alien's re-target decision for one window. */
export interface CoalescerDecision {
  /** Loudest arrival in the window — the primary investigation target. */
  primary: CoalescerInput;
  /** Everything within DISCARD_MARGIN of the primary: secondary targets, kept
   *  so a hatch cycle masked under a decoy is still remembered (§3). */
  secondary: CoalescerInput[];
  /** How many arrivals fell more than DISCARD_MARGIN below the primary. */
  discarded: number;
  /** Module the primary came from. */
  module: ModuleId;
  /** Consecutive windows this module has been the loudest, beyond the first. */
  repeatCount: number;
  /** Metres of extra slop from diminishing returns: `repeatCount * 3`, max 12. */
  repeatPenaltyM: number;
  /** `errorRadius(primary.level) + repeatPenaltyM` — what INVESTIGATE should use. */
  errorRadius: number;
  /** Wall-clock ms this window closed. */
  windowEndMs: number;
}

export interface CoalescerOptions {
  /** Rolling window length. Defaults to WINDOW_MS (1000). */
  windowMs?: number;
  /** Discard-by-margin threshold. Defaults to DISCARD_MARGIN (15). */
  discardMargin?: number;
  /** Metres added per consecutive same-module window. Defaults to 3. */
  repeatPenaltyM?: number;
  /** Cap on the repeat penalty. Defaults to 12. */
  repeatPenaltyMaxM?: number;
  /** Ignore arrivals below this. Set it to the alien's current attention
   *  threshold (§3) and the coalescer only ever sees what it would react to. */
  minLevel?: number;
}

/**
 * The §3 coalescer. Six players generate a continuous stream of events; if the
 * alien re-targets on every one it thrashes and reads as broken.
 *
 * - Rolling 1.0s window; act on the loudest event in it.
 * - Discard BY MARGIN: only drop events more than 15 points below the loudest.
 * - Diminishing returns: each consecutive window whose loudest event comes from
 *   the same module widens that module's error radius by 3m, max +12. Resets
 *   when the loudest comes from anywhere else.
 *
 * The server drives this: `push()` every arrival as it happens, `flush(now)`
 * once per tick. `flush` returns a decision at most once per window.
 */
export class NoiseCoalescer {
  private readonly windowMs: number;
  private readonly discardMargin: number;
  private readonly penaltyStep: number;
  private readonly penaltyMax: number;
  private readonly minLevel: number;

  private events: CoalescerInput[] = [];
  private windowStart: number | null = null;
  private lastModule: ModuleId | null = null;
  private repeatCount = 0;

  constructor(opts: CoalescerOptions = {}) {
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.discardMargin = opts.discardMargin ?? DISCARD_MARGIN;
    this.penaltyStep = opts.repeatPenaltyM ?? REPEAT_PENALTY_M;
    this.penaltyMax = opts.repeatPenaltyMaxM ?? REPEAT_PENALTY_MAX_M;
    this.minLevel = opts.minLevel ?? Number.NEGATIVE_INFINITY;
  }

  /** Record one arrival. `level` is what reached the alien, not source loudness. */
  push(event: NoiseEvent, level: number, nowMs: number): void {
    if (level < this.minLevel) return;
    if (this.windowStart === null) this.windowStart = nowMs;
    this.events.push({ event, level, at: nowMs });
    this.prune(nowMs);
  }

  /**
   * Non-destructive read of the current rolling window. Use it for HUD/debug;
   * it does not advance the repeat-penalty state.
   */
  evaluate(nowMs: number): CoalescerDecision | null {
    this.prune(nowMs);
    return this.decide(nowMs, this.repeatCount, this.lastModule, false);
  }

  /**
   * Close the window if a full `windowMs` has elapsed and return the decision,
   * advancing the diminishing-returns state. Returns null in between — call it
   * every tick and act only when it hands you something.
   */
  flush(nowMs: number): CoalescerDecision | null {
    if (this.windowStart === null) return null;
    if (nowMs - this.windowStart < this.windowMs) return null;

    this.prune(nowMs);
    const decision = this.decide(nowMs, this.repeatCount, this.lastModule, true);
    this.windowStart = nowMs;

    if (decision === null) {
      // A silent window breaks the streak — the alien stops being suspicious of
      // a module nothing is coming from any more.
      this.lastModule = null;
      this.repeatCount = 0;
    }
    return decision;
  }

  /** Current extra error radius for a module, without closing a window. */
  penaltyFor(module: ModuleId): number {
    if (module !== this.lastModule) return 0;
    return Math.min(this.repeatCount * this.penaltyStep, this.penaltyMax);
  }

  /** Module that has been winning windows, if any. */
  get suspectModule(): ModuleId | null {
    return this.lastModule;
  }

  /** Consecutive same-module windows beyond the first. */
  get repeats(): number {
    return this.repeatCount;
  }

  /** Events currently inside the rolling window. */
  get pending(): readonly CoalescerInput[] {
    return this.events;
  }

  /** Forget everything — call on a round reset or when the alien RETREATs. */
  reset(): void {
    this.events = [];
    this.windowStart = null;
    this.lastModule = null;
    this.repeatCount = 0;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    if (this.events.length === 0) return;
    let i = 0;
    while (i < this.events.length && this.events[i]!.at < cutoff) i++;
    if (i > 0) this.events = this.events.slice(i);
  }

  private decide(
    nowMs: number,
    repeatCount: number,
    lastModule: ModuleId | null,
    commit: boolean,
  ): CoalescerDecision | null {
    if (this.events.length === 0) return null;

    let primary = this.events[0]!;
    for (const candidate of this.events) {
      if (candidate.level > primary.level) primary = candidate;
    }

    const secondary: CoalescerInput[] = [];
    let discarded = 0;
    for (const candidate of this.events) {
      if (candidate === primary) continue;
      if (primary.level - candidate.level <= this.discardMargin) secondary.push(candidate);
      else discarded++;
    }
    secondary.sort((a, b) => b.level - a.level);

    const module = primary.event.module;
    const nextRepeat = module === lastModule ? repeatCount + 1 : 0;
    const penalty = Math.min(nextRepeat * this.penaltyStep, this.penaltyMax);

    if (commit) {
      this.lastModule = module;
      this.repeatCount = nextRepeat;
    }

    return {
      primary,
      secondary,
      discarded,
      module,
      repeatCount: nextRepeat,
      repeatPenaltyM: penalty,
      errorRadius: errorRadius(primary.level) + penalty,
      windowEndMs: nowMs,
    };
  }
}
