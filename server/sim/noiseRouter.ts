/**
 * The server's end of the noise system (DESIGN.md §3).
 *
 * One place where every sound in the game becomes a `NoiseEvent`:
 *
 *   1. Loudness is re-derived from the §14 tables via `noiseLoudness()`. The
 *      client says WHAT it did and WHERE; it never says how loud it was.
 *   2. `propagate()` runs the graph walk ONCE per event.
 *   3. The alien's own arrival is resolved from that same walk, filtered by the
 *      state's attention threshold (§3), and pushed into the shared coalescer.
 *   4. The room broadcasts the event to the clients whose module it reaches, and
 *      each client resolves it locally for audio (§8) with the same shared code.
 */

import { CREW_FULL, attentionThreshold, noiseLoudness } from '@shared/constants';
import type {
  AlienState,
  DirectorStage,
  Gait,
  ListenerResolution,
  ModuleId,
  NoiseEvent,
  NoiseKind,
  PlayerId,
  Vec3,
} from '@shared/types';
import type { ModuleGraph } from '@shared/graph/moduleGraph';
import {
  NoiseCoalescer,
  investigationPoint,
  propagate,
  type CoalescerDecision,
  type Propagation,
} from '@shared/graph/noise';

export interface EmitOptions {
  /** m/s for the speed-scaled kinds — `catch`, `impact` and `landing` (§14). */
  speed?: number;
  /** 0–1 for `breathing`, `voice`, `hide-enter` and `hide-exit` (§6, §7, §4). */
  intensity?: number;
  /**
   * Required for `footstep` and `landing`: loudness is a function of gait
   * (crouch 4 / walk 12 / sprint 30), and the client reports WHICH stride it
   * took, never how loud it was.
   */
  gait?: Gait;
  /**
   * The emitter was inside a hide spot (§4). `muffleDb` — negative, additive,
   * exactly like a hatch offset — comes off the source loudness before the
   * graph walk, so a hidden player's own sounds propagate quieter from the
   * moment they leave the shell.
   *
   * The SERVER decides this from its own record of who is hidden; a client
   * claiming it would be claiming a discount on its own noise.
   */
  hidden?: boolean;
  /** The occupied spot's own muffle, when it overrides `HIDE_MUFFLE_DB`. */
  muffleDb?: number;
  actor?: PlayerId;
}

/** An event plus its single graph walk, reusable for every listener. */
export interface EmittedNoise {
  event: NoiseEvent;
  propagation: Propagation;
}

export class NoiseRouter {
  private readonly coalescer = new NoiseCoalescer();

  constructor(private graph: ModuleGraph) {}

  /** Swap the graph when a round loads a different station. */
  setGraph(graph: ModuleGraph): void {
    this.graph = graph;
  }

  /**
   * Build the authoritative event and propagate it. Returns the walk so callers
   * can resolve it per listener without repeating it.
   */
  emit(
    kind: NoiseKind,
    origin: Vec3,
    module: ModuleId,
    tick: number,
    opts: EmitOptions = {},
  ): EmittedNoise {
    const event: NoiseEvent = {
      kind,
      origin: { x: origin.x, y: origin.y, z: origin.z },
      module,
      loudness: noiseLoudness(kind, {
        speed: opts.speed,
        intensity: opts.intensity,
        gait: opts.gait,
        hidden: opts.hidden,
        muffleDb: opts.muffleDb,
      }),
      t: tick,
    };
    if (opts.actor !== undefined) event.actor = opts.actor;
    return { event, propagation: propagate(event, this.graph) };
  }

  /** What the alien hears of an event, from the walk we already have. */
  resolveAt(emitted: EmittedNoise, pos: Vec3, module: ModuleId): ListenerResolution {
    return emitted.propagation.resolve(pos, module);
  }

  /**
   * Feed one arrival to the coalescer if the alien is listening for something
   * that quiet (§3: "it hears better when it's already looking for you").
   * Returns the arrival level when it was taken, or null when it was ignored.
   *
   * `livingPlayers` crew-scales the threshold (§14 crew scaling): §3's numbers
   * are a filter for six people's noise and filter nothing when applied to one.
   * It defaults to `CREW_FULL`, i.e. the §14 table verbatim.
   *
   * This path only runs for an `AlienSim` that does NOT own its coalescing —
   * the shipping `Alien` does, and gates on its own director-scaled thresholds,
   * so this is the fallback sim's gate. The room currently omits the argument;
   * passing the living count there makes the fallback alien scale too.
   */
  offerToAlien(
    emitted: EmittedNoise,
    resolution: ListenerResolution,
    alienState: AlienState,
    stage: DirectorStage,
    nowMs: number,
    livingPlayers: number = CREW_FULL,
  ): number | null {
    // It does not hear itself. §5 makes it loud while hunting so the PLAYERS
    // can hear it coming; feeding that back into its own attention would have
    // it investigating its own footsteps at 55 and chasing its tail.
    if (emitted.event.kind === 'alien') return null;
    if (!resolution.audible) return null;
    if (resolution.level < attentionThreshold(alienState, stage, livingPlayers)) return null;
    this.coalescer.push(emitted.event, resolution.level, nowMs);
    return resolution.level;
  }

  /** Close the rolling window, at most once per WINDOW_MS. */
  flush(nowMs: number): CoalescerDecision | null {
    return this.coalescer.flush(nowMs);
  }

  /**
   * The §5 INVESTIGATE destination for a decision: the primary event's origin,
   * offset by `errorRadius(level)` plus the coalescer's per-module repeat
   * penalty. The alien never learns an exact position (§3).
   */
  investigationPointFor(decision: CoalescerDecision, rng: () => number): Vec3 {
    return investigationPoint(
      decision.primary.event.origin,
      decision.primary.level,
      decision.repeatPenaltyM,
      rng,
    );
  }

  /** Forget the window — round reset, or the alien RETREATing. */
  reset(): void {
    this.coalescer.reset();
  }

  get suspectModule(): ModuleId | null {
    return this.coalescer.suspectModule;
  }
}
