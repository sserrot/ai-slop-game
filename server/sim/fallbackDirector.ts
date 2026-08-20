/**
 * A working escalation director (DESIGN.md §5) — the fallback the room uses
 * until `server/sim/director.ts` lands.
 *
 * "The station gets more dangerous as it comes back to life. Stage advances per
 * system brought online (diegetic, and it rewards progress with pressure), plus
 * one free stage every 8 minutes so a stalling team escalates anyway."
 *
 * Everything the stage *means* — patrol speed, PATROL threshold, crowd bias,
 * SEARCH duration, HUNT trigger — lives in `DIRECTOR_STAGES` (§14) and is read
 * through `directorConfig(stage)` by whoever needs it. This class only decides
 * which row is current.
 */

import { CREW_FULL, MAX_DIRECTOR_STAGE, clamp, stageTimeoutMs } from '@shared/constants';
import type { DirectorStage, EscapeSystemId } from '@shared/types';
import { livingPlayerCount } from './contracts';
import type { DirectorSim, SimContext } from './contracts';

export class FallbackDirector implements DirectorSim {
  private readonly systems = new Set<EscapeSystemId>();
  private freeStages = 0;
  private msSinceFreeStage = 0;
  private _stage: DirectorStage = 0;
  /** §5 stage 4 is "all systems / undock live" — this is the second half. */
  private _undockLive = false;
  /** Living players last seen, for the crew-scaled free-stage clock (§14 crew
   *  scaling). Starts at CREW_FULL so an un-ticked director is §14 verbatim. */
  private livingPlayers = CREW_FULL;

  get stage(): DirectorStage {
    return this._stage;
  }

  get systemsOnline(): number {
    return this.systems.size;
  }

  get msToNextFreeStage(): number {
    if (this._stage >= MAX_DIRECTOR_STAGE) return 0;
    return Math.max(0, stageTimeoutMs(this.livingPlayers) - this.msSinceFreeStage);
  }

  update(dtMs: number, ctx: SimContext): boolean {
    // §5's free stage exists to punish a STALLING team, and it was sized against
    // six people working in parallel. One pair of hands is not stalling, so the
    // clock is crew-scaled (§14 crew scaling) exactly as the real director's is.
    this.livingPlayers = livingPlayerCount(ctx);
    const timeout = stageTimeoutMs(this.livingPlayers);
    if (this._stage < MAX_DIRECTOR_STAGE) {
      this.msSinceFreeStage += dtMs;
      if (this.msSinceFreeStage >= timeout) {
        this.msSinceFreeStage -= timeout;
        this.freeStages++;
      }
    }
    return this.recompute();
  }

  systemOnline(system: EscapeSystemId): void {
    if (this.systems.has(system)) return;
    this.systems.add(system);
    this.recompute();
  }

  /**
   * The undock sequence is live: stage 4 outright, the other half of §5's
   * stage-4 trigger.
   *
   * Not redundant with "all systems": `SYSTEMS_TO_ESCAPE` is 4 of the 5 gating
   * puzzles (§11 — exactly one may be skipped, which is how cargo stow stays
   * the designated cut), and the free-stage clock only reaches stage 4 after 32
   * minutes. A crew that skipped a puzzle and ran the finale early would
   * otherwise pull three levers at loudness 60 with the alien still on stage 3.
   * Idempotent.
   */
  undockLive(): void {
    if (this._undockLive) return;
    this._undockLive = true;
    this.recompute();
  }

  reset(): void {
    this.systems.clear();
    this.freeStages = 0;
    this.msSinceFreeStage = 0;
    this._stage = 0;
    this._undockLive = false;
  }

  /**
   * Stage is systems online plus free stages, clamped to the table (§5) — or
   * the top of the table outright once the undock sequence is live.
   *
   * Monotonic: the station never gets safer, so an escalation is never undone.
   */
  private recompute(): boolean {
    const raw = this._undockLive ? MAX_DIRECTOR_STAGE : this.systems.size + this.freeStages;
    const next = clamp(Math.max(raw, this._stage), 0, MAX_DIRECTOR_STAGE) as DirectorStage;
    if (next === this._stage) return false;
    this._stage = next;
    return true;
  }
}
