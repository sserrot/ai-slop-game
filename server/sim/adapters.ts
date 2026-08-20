/**
 * Adapters from the real sims to the room's contracts.
 *
 * `server/sim/alien.ts` (§5), `server/sim/director.ts` (§5 escalation) and
 * `server/sim/puzzles.ts` (§11) are owned by other agents and have their own,
 * richer APIs. `StationRoom` drives everything through `sim/contracts.ts`, so
 * the shims live here rather than as concessions in either file.
 *
 * `StationPuzzles` already implements `PuzzleSim` directly and needs no adapter.
 */

import type {
  AlienState,
  DirectorStage,
  EscapeSystemId,
  ModuleId,
  NoiseEvent,
  PlayerId,
  PortId,
  Quat,
  Vec3,
} from '@shared/types';
import { Alien, type AlienPlayerView, type AlienWorld } from './alien';
import { EscalationDirector } from './director';
import { livingPlayerCount } from './contracts';
import type { AlienHearing, AlienSim, DirectorSim, SimContext } from './contracts';

/**
 * §5's escalation director behind the room's `DirectorSim`.
 *
 * The real director counts systems as a NUMBER; the room knows them by id and
 * must not double-count a puzzle that reports the same gate twice, so the set
 * of ids lives here and the count is pushed down.
 */
export class DirectorAdapter implements DirectorSim {
  private readonly systems = new Set<EscapeSystemId>();

  constructor(readonly inner: EscalationDirector = new EscalationDirector()) {}

  get stage(): DirectorStage {
    return this.inner.stage;
  }

  get systemsOnline(): number {
    return this.inner.systemsOnline;
  }

  get msToNextFreeStage(): number {
    return this.inner.msToNextFreeStage;
  }

  update(dtMs: number, ctx: SimContext): boolean {
    // The roster drives escalation, not just the clock: §5's stage table and its
    // 8-minute free stage were both sized for six people working in parallel.
    // Push the living count down before advancing so the timer this tick uses is
    // the one the current crew should be on (`stageTimeoutMs`, §14 crew scaling).
    this.inner.setLivingPlayers(livingPlayerCount(ctx));
    const before = this.inner.stage;
    this.inner.advanceMs(dtMs);
    return this.inner.stage !== before;
  }

  systemOnline(system: EscapeSystemId): void {
    if (this.systems.has(system)) return;
    this.systems.add(system);
    this.inner.setSystemsOnline(this.systems.size);
  }

  /** §5 stage 4 is "all systems / undock live". */
  undockLive(): void {
    this.inner.undockLive();
  }

  reset(): void {
    this.systems.clear();
    this.inner.reset();
  }
}

/**
 * §5's alien behind the room's `AlienSim`.
 *
 * `ownsCoalescing` is true: the real alien runs its own `NoiseCoalescer` and its
 * own attention thresholds, so the room hands it every audible arrival and never
 * calls `investigate()` — one coalescer per alien, which is what §3 describes.
 */
export class AlienAdapter implements AlienSim {
  readonly ownsCoalescing = true;

  constructor(readonly inner: Alien) {}

  get pos(): Vec3 {
    return this.inner.position;
  }

  get quat(): Quat {
    return this.inner.orientation;
  }

  get state(): AlienState {
    return this.inner.state;
  }

  get module(): ModuleId {
    return this.inner.module;
  }

  spawn(module: ModuleId, pos: Vec3, _ctx: SimContext): void {
    this.inner.spawn(module, pos);
  }

  /**
   * The round has started (§5's FSM leaves the pre-round DORMANT).
   *
   * It does NOT go straight to PATROL. `Alien.wake()` starts the round-start
   * grace instead — `roundGraceSeconds(livingPlayers)`, 75 s solo and 25 s at a
   * full crew — during which it does not move and hears nothing below its HUNT
   * trigger. §10's reunion phase is quiet but not safe, and the three-hop spawn
   * floor it was relying on for the opening is worth about ten seconds at
   * `SPEED_PATROL`; see `Alien.wake()` for the arithmetic.
   */
  wake(_ctx: SimContext): void {
    this.inner.wake();
  }

  update(dt: number, ctx: SimContext): void {
    this.inner.tick(dt, ctx.now, ctx.tick);
  }

  hear(input: AlienHearing, ctx: SimContext): void {
    this.inner.hearResolved(input.event, input.level, input.distance, ctx.now);
  }

  /** Never called while `ownsCoalescing` is true — the alien coalesces itself. */
  investigate(): void {
    /* intentionally empty */
  }

  reset(): void {
    this.inner.reset();
  }
}

/** What the room has to provide to build the real alien's world view. */
export interface AlienWorldHooks {
  graph: AlienWorld['graph'];
  rails: AlienWorld['rails'];
  /** §4's hide spots — geometry the alien routes around, never a sight query. */
  hides: AlienWorld['hides'];
  players: () => readonly AlienPlayerView[];
  emitNoise: (event: NoiseEvent) => void;
  onKill: (playerId: PlayerId, at: Vec3) => void;
  onHatchChanged: (module: ModuleId, port: PortId, open: boolean, sealed: boolean) => void;
}

export function makeAlienWorld(hooks: AlienWorldHooks): AlienWorld {
  return {
    graph: hooks.graph,
    rails: hooks.rails,
    hides: hooks.hides,
    players: hooks.players,
    emitNoise: hooks.emitNoise,
    onKill: hooks.onKill,
    onHatchChanged: hooks.onHatchChanged,
  };
}
