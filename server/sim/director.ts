/**
 * The escalation director (DESIGN.md §5 — "the biggest thing r1 was missing").
 *
 * The station gets more dangerous as it comes back to life. Stage advances
 * **per system brought online** (diegetic, and it rewards progress with
 * pressure), plus **one free stage every 8 minutes** so a stalling team
 * escalates anyway. That caps a round at roughly 20–25 minutes and gives every
 * run an arc — it is the direct counter to silent-slow play strictly
 * dominating (§13).
 *
 * The stage table itself lives in `@shared/constants` as `DIRECTOR_STAGES`;
 * this class owns only *when* the stage changes. Never re-type the table.
 *
 *   | Stage | Trigger            | Patrol speed | PATROL threshold | Also            |
 *   |-------|--------------------|--------------|------------------|-----------------|
 *   | 0     | start              | 1.5          | 12               | —               |
 *   | 1     | 1 system           | 1.6          | 10               | —               |
 *   | 2     | 2 systems          | 1.8          | 8                | crowd bias on   |
 *   | 3     | 3 systems          | 2.0          | 6                | SEARCH → 25s    |
 *   | 4     | all / undock live  | 2.2          | 4                | HUNT at 35      |
 *
 * **Crew scaling.** That table is the six-player game. Every row is served
 * through `crewScaledStage()` against the current living-player count, so a solo
 * round runs a gentler version of the same arc and a full crew runs the table
 * verbatim (`crewPressure(5) === 1`). See the crew-scaling block in
 * `@shared/constants` for why each lever scales the way it does; the short
 * version is that rising patrol speed, the longer SEARCH sweep and the stage-4
 * HUNT discount are all pressure on a CROWD, and with one player they compound
 * with "you are the only thing it can hear" instead of counteracting it. The
 * PATROL threshold still sharpens stage by stage at every crew size, because
 * that is the half of §5's escalation which works with one player: progress
 * always buys pressure.
 */

import {
  CREW_FULL,
  MAX_DIRECTOR_STAGE,
  SYSTEMS_TO_ESCAPE,
  clamp,
  crewScaledStage,
  directorConfig,
  searchThreshold,
  stageTimeoutMs,
} from '@shared/constants';
import type { DirectorSnapshot, DirectorStage, DirectorStageConfig } from '@shared/types';

/** Why the director escalated. Useful for logging and for the round summary. */
export type StageAdvanceReason = 'system' | 'timer' | 'undock' | 'forced';

export interface StageChange {
  from: DirectorStage;
  to: DirectorStage;
  config: DirectorStageConfig;
  reason: StageAdvanceReason;
  systemsOnline: number;
}

export type StageChangeListener = (change: StageChange) => void;

export interface DirectorOptions {
  /**
   * ms between free stages. Defaults to the crew-scaled `stageTimeoutMs()` —
   * §14's STAGE_TIMEOUT_MS (8 min) at CREW_FULL, stretched toward
   * STAGE_TIMEOUT_SOLO_MS (12 min) as the crew shrinks. Pass a number to pin it
   * (debug and round scripting only; it disables crew scaling of the timer).
   */
  stageTimeoutMs?: number;
  /** Systems required to reach stage 4 outright. Defaults to SYSTEMS_TO_ESCAPE. */
  systemsToEscape?: number;
  /** Living players at construction. `setLivingPlayers()` keeps it current. */
  livingPlayers?: number;
  /** Fired on every stage change; the room broadcasts a `stage` message (§7). */
  onStageChange?: StageChangeListener;
}

/**
 * Server-authoritative escalation state. The room owns one of these, ticks it
 * with the 20 Hz simulation clock, and mirrors `snapshot()` into the Colyseus
 * `director` field (§7).
 */
export class EscalationDirector {
  /** null = follow the crew-scaled timer; a number pins it (debug / scripting). */
  private readonly pinnedStageTimeoutMs: number | null;
  private readonly systemsToEscape: number;
  private readonly listeners = new Set<StageChangeListener>();
  private _livingPlayers: number;

  private _stage: DirectorStage = 0;
  private _systemsOnline = 0;
  /** Stages granted purely by the clock. Additive with systems online. */
  private _freeStages = 0;
  private _sinceFreeStageMs = 0;
  private _elapsedMs = 0;
  private _undockLive = false;
  /** Reason for the pending recompute; used only to label the change event. */
  private _pendingReason: StageAdvanceReason = 'forced';

  constructor(opts: DirectorOptions = {}) {
    this.pinnedStageTimeoutMs = opts.stageTimeoutMs ?? null;
    this.systemsToEscape = opts.systemsToEscape ?? SYSTEMS_TO_ESCAPE;
    // Default to a full crew so a director nobody tells about the roster behaves
    // exactly as §14 specifies. The room pushes the real count every tick.
    this._livingPlayers = Math.max(1, opts.livingPlayers ?? CREW_FULL);
    if (opts.onStageChange) this.listeners.add(opts.onStageChange);
  }

  // -- reads ----------------------------------------------------------------

  get stage(): DirectorStage {
    return this._stage;
  }

  /** Living, un-escaped players the escalation is currently scaled for. */
  get livingPlayers(): number {
    return this._livingPlayers;
  }

  /**
   * The §5 row for the current stage — patrol speed, PATROL attention threshold,
   * crowd bias on/off, SEARCH duration, HUNT trigger — **scaled for the current
   * crew** (`crewScaledStage`, see the crew-scaling block in §14's constants).
   *
   * At `CREW_FULL` and above this is byte-for-byte `directorConfig(stage)`; use
   * `unscaledConfig` when you specifically want the §5 table as written.
   */
  get config(): DirectorStageConfig {
    return crewScaledStage(this._stage, this._livingPlayers);
  }

  /** The §5 table row as written, ignoring the crew. Diagnostics and UI. */
  get unscaledConfig(): DirectorStageConfig {
    return directorConfig(this._stage);
  }

  /** ms between free stages right now: pinned, or scaled for the crew. */
  get stageTimeoutMs(): number {
    return this.pinnedStageTimeoutMs ?? stageTimeoutMs(this._livingPlayers);
  }

  get systemsOnline(): number {
    return this._systemsOnline;
  }

  /** Stages handed out by the 8-minute timer so far. */
  get freeStages(): number {
    return this._freeStages;
  }

  /** Round time the director has seen, in ms. */
  get elapsedMs(): number {
    return this._elapsedMs;
  }

  /** ms until the next free stage. 0 once the director is maxed out. */
  get msToNextFreeStage(): number {
    if (this._stage >= MAX_DIRECTOR_STAGE) return 0;
    return Math.max(0, this.stageTimeoutMs - this._sinceFreeStageMs);
  }

  /** True once every escape system is online or the undock sequence is live. */
  get maxed(): boolean {
    return this._stage >= MAX_DIRECTOR_STAGE;
  }

  // -- convenience accessors onto the current row ---------------------------

  /** m/s — PATROL / INVESTIGATE / RETREAT locomotion speed at this stage. */
  get patrolSpeed(): number {
    return this.config.patrolSpeed;
  }

  /** Arrival level PATROL bothers to react to at this stage (§3). */
  get patrolThreshold(): number {
    return this.config.patrolThreshold;
  }

  /**
   * Arrival level INVESTIGATE / SEARCH react to (§3's `ATTN_SEARCH`), scaled for
   * the crew. It does not vary by stage — §5's table never sharpens it — but it
   * lives here so the alien reads every attention number from one place.
   */
  get searchThreshold(): number {
    return searchThreshold(this._livingPlayers);
  }

  /** Weight target selection 2:1 toward the biggest player cluster (stage 2+). */
  get crowdBias(): boolean {
    return this.config.crowdBias;
  }

  /** Seconds a SEARCH sweep lasts — 15, or 25 from stage 3. */
  get searchDuration(): number {
    return this.config.searchDuration;
  }

  /** Arrival level within 10m that triggers HUNT — 50, or 35 at stage 4. */
  get huntTrigger(): number {
    return this.config.huntTrigger;
  }

  // -- writes ---------------------------------------------------------------

  /**
   * How many players are still alive and on the station.
   *
   * The room pushes this every tick. It scales the whole §5 escalation row plus
   * the free-stage clock: DESIGN.md's numbers assume up to six people sharing
   * one noise budget, and with one or two of them left every one of those
   * numbers is being applied to a station that no longer works the way they were
   * tuned for. §10 plans for attrition explicitly ("escaping with three of six
   * is a win"), so a round that loses people should ease off as it does.
   *
   * Never below 1: a round with nobody left in it is over, and dividing the
   * escalation by zero players is not a state worth encoding.
   */
  setLivingPlayers(n: number): void {
    const next = Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));
    this._livingPlayers = next;
  }

  /** Subscribe to stage changes. Returns an unsubscribe function. */
  onStageChange(fn: StageChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Advance the free-stage clock. Call once per simulation tick with the fixed
   * dt in SECONDS (the room's 20 Hz step), or use `advanceMs`.
   */
  tick(dtSeconds: number): void {
    this.advanceMs(dtSeconds * 1000);
  }

  /** Advance the free-stage clock by wall-clock milliseconds. */
  advanceMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this._elapsedMs += ms;
    if (this.maxed) return; // no point counting once there is nothing left to give
    this._sinceFreeStageMs += ms;
    let granted = false;
    while (this._sinceFreeStageMs >= this.stageTimeoutMs) {
      this._sinceFreeStageMs -= this.stageTimeoutMs;
      this._freeStages++;
      granted = true;
    }
    if (granted) this.recompute('timer');
  }

  /** One more escape system came online (§11 `Puzzle.gates`). */
  systemOnline(count = 1): void {
    this.setSystemsOnline(this._systemsOnline + count);
  }

  /** Set the absolute number of systems online. Never decreases the stage. */
  setSystemsOnline(n: number): void {
    const next = Math.max(0, Math.floor(n));
    if (next === this._systemsOnline) return;
    this._systemsOnline = next;
    this.recompute('system');
  }

  /** The undock sequence is live — stage 4 outright (§5 table). */
  undockLive(): void {
    if (this._undockLive) return;
    this._undockLive = true;
    this.recompute('undock');
  }

  /** Force a stage directly. Debug / round scripting only; never lowers it. */
  forceStage(stage: number): void {
    const target = clamp(Math.round(stage), 0, MAX_DIRECTOR_STAGE);
    if (target <= this._stage) return;
    // Encode the forced stage as free stages so `recompute` stays the one place
    // that decides what the stage actually is.
    this._freeStages = Math.max(this._freeStages, target - this._systemsOnline);
    this.recompute('forced');
  }

  /** Back to stage 0 for a fresh round. Listeners and the crew size are kept —
   *  the roster does not change because the round restarted. */
  reset(): void {
    this._stage = 0;
    this._systemsOnline = 0;
    this._freeStages = 0;
    this._sinceFreeStageMs = 0;
    this._elapsedMs = 0;
    this._undockLive = false;
  }

  /** §7 `director:` — mirror this into the room's schema every tick. */
  snapshot(): DirectorSnapshot {
    return {
      stage: this._stage,
      systemsOnline: this._systemsOnline,
      msToNextFreeStage: this.msToNextFreeStage,
    };
  }

  // -- internals ------------------------------------------------------------

  private recompute(reason: StageAdvanceReason): void {
    this._pendingReason = reason;
    const bySystems = this._systemsOnline + this._freeStages;
    const raw = this._undockLive || this._systemsOnline >= this.systemsToEscape
      ? MAX_DIRECTOR_STAGE
      : bySystems;
    // Monotonic: the station never gets safer (§5 — progress buys pressure).
    const next = clamp(Math.max(raw, this._stage), 0, MAX_DIRECTOR_STAGE) as DirectorStage;
    if (next === this._stage) return;
    const from = this._stage;
    this._stage = next;
    const change: StageChange = {
      from,
      to: next,
      // The row the alien will actually run on, not the §5 table row — a
      // listener that logs "stage 4: patrol 2.2" for a solo round would be
      // reporting numbers nothing in the sim is using.
      config: crewScaledStage(next, this._livingPlayers),
      reason: this._pendingReason,
      systemsOnline: this._systemsOnline,
    };
    for (const fn of [...this.listeners]) {
      try {
        fn(change);
      } catch (err) {
        console.error('[director] stage listener threw:', err);
      }
    }
  }
}
