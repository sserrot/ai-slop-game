/**
 * The narrow interfaces StationRoom needs from the three server-side sims that
 * other agents own: `server/sim/alien.ts` (§5), `server/sim/director.ts` (§5
 * escalation) and `server/sim/puzzles.ts` (§11).
 *
 * The room drives all three and owns nothing about their internals. Working
 * fallbacks live in `fallbackAlien.ts` / `fallbackDirector.ts` /
 * `fallbackPuzzles.ts` so `npm run server` is a playable server today; the
 * integrator swaps them out in `StationRoom.createSims()`.
 */

import type {
  AlienState,
  DeathCause,
  DirectorStage,
  EscapeSystemId,
  Gait,
  GravityMode,
  HideSpotKey,
  InteractMessage,
  ModuleId,
  NoiseEvent,
  NoiseKind,
  PlayerId,
  Puzzle,
  PuzzleId,
  Quat,
  StationLayout,
  Vec3,
} from '@shared/types';
import type { ListenerResolution } from '@shared/types';
import type { ModuleGraph } from '@shared/graph/moduleGraph';
import type { RailGraph } from '@shared/graph/railGraph';
import type { HideSpotGraph } from '@shared/graph/hideSpots';
import type { CoalescerDecision } from '@shared/graph/noise';

/** Read-only view of one player, as the sims see them. */
export interface PlayerView {
  id: PlayerId;
  pos: Vec3;
  module: ModuleId;
  alive: boolean;
  escaped: boolean;
  heartRate: number;
  /** Gait held right now (§4). The server re-derives footstep and landing
   *  loudness from it, so it is authoritative state rather than decoration. */
  gait: Gait;
  /**
   * `HideSpotKey` being occupied, or null (§4 hiding).
   *
   * This is NOT sight: it is the same category of fact as `pos`, and the alien
   * needs it for exactly two things — it may not kill through the shell by
   * contact, and it may not sweep its body through an occupied volume. Nothing
   * may path toward a hidden player because of this field; the only thing that
   * ever resolves a hide spot is a noise arriving from inside it.
   */
  hideSpot: HideSpotKey | null;
}

/** Options for a noise the sim itself makes (§5: the alien is loud when it hunts). */
export interface EmitNoiseOptions {
  /** m/s, for the speed-scaled 'catch' / 'impact' / 'landing' kinds (§14). */
  speed?: number;
  /** 0–1, for 'breathing' / 'voice' / 'hide-enter' / 'hide-exit'. */
  intensity?: number;
  /** Required for 'footstep' and 'landing' — loudness is a function of gait. */
  gait?: Gait;
  /** The emitter was inside a hide spot; the shell takes `muffleDb` off it. */
  hidden?: boolean;
  /** The occupied spot's own muffle, when it overrides `HIDE_MUFFLE_DB`. */
  muffleDb?: number;
  actor?: PlayerId;
}

/**
 * Everything a sim may read or do to the world, handed in fresh every tick.
 * Sims must not hold on to it past the call.
 */
export interface SimContext {
  graph: ModuleGraph;
  rails: RailGraph;
  /**
   * §4's hide spots, resolved into world space. Pure geometry — containment,
   * sweeps and distances. There is no sight logic in it and none may be added.
   */
  hideSpots: HideSpotGraph;
  layout: StationLayout;
  /** Server tick (§7). */
  tick: number;
  /** `Date.now()` at the top of this tick. */
  now: number;
  /** Current escalation stage — speeds, thresholds and durations come from
   *  `directorConfig(stage)` (§5). */
  stage: DirectorStage;
  /** Escape systems online so far (§11: four, then the undock sequence). */
  systemsOnline: number;
  /** Living, un-escaped players first; escaped/dead included with their flags. */
  players: readonly PlayerView[];
  /** Seeded RNG for the round. Use it instead of `Math.random` so a round can
   *  be replayed. */
  rng: () => number;
  /** Make a noise into the §3 pipeline. Loudness is re-derived from §14 — a sim
   *  cannot decide it was quiet. */
  emitNoise(kind: NoiseKind, pos: Vec3, module: ModuleId, opts?: EmitNoiseOptions): void;
  /** Kill a player (§10). Idempotent. */
  killPlayer(id: PlayerId, cause: DeathCause): void;
  /** Open / close / seal a hatch. Used by the alien opening a closed hatch —
   *  3 s and loudness 45, which the caller emits itself (§5). */
  setHatch(module: ModuleId, port: string, open: boolean, sealed?: boolean): void;
  /** A system came online (§5 stage advance, §11 gates). */
  systemOnline(system: EscapeSystemId): void;
  /** One-line feedback to a player, e.g. "no medkit". */
  toast(id: PlayerId, text: string): void;
  /**
   * Announce a gravity change (§4's set-piece rule). Goes through the
   * `GRAVITY_WARNING_S` warning and the `gravity-shift` noise; a sim must never
   * reach for `ModuleGraph.setGravity()` for anything a player is meant to
   * survive. Returns false when the module is ineligible or the change was
   * already pending.
   */
  setGravity(module: ModuleId, mode: GravityMode, cause?: 'director' | 'puzzle' | 'damage'): boolean;
}

/**
 * Players still alive and still on the station — the crew size every §14
 * crew-scaled value is interpolated on (`crewPressure`, `crewScaledStage`,
 * `roundGraceSeconds`, `stageTimeoutMs`, `patrolStandoffM`).
 *
 * Escaped crew are excluded deliberately, for the same reason the dead are:
 * someone strapped into the Soyuz is no longer making noise, no longer a target
 * and no longer part of the budget DESIGN.md's numbers were tuned against.
 * Never below 1 — a round with nobody in it has already ended, and none of the
 * scaling functions have anything sensible to say about zero players.
 */
export function livingPlayerCount(ctx: SimContext): number {
  let n = 0;
  for (const p of ctx.players) if (p.alive && !p.escaped) n++;
  return Math.max(1, n);
}

/** What the alien heard, already resolved through the graph at its position. */
export interface AlienHearing {
  event: NoiseEvent;
  /** Arrival level AT THE ALIEN (§3), not source loudness. */
  level: number;
  /** Metres, origin → alien. */
  distance: number;
  hops: number;
  resolution: ListenerResolution;
}

/**
 * §5's alien. The room owns perception plumbing (propagation, coalescing,
 * thresholds); the alien owns the FSM and movement.
 */
export interface AlienSim {
  readonly pos: Vec3;
  readonly quat: Quat;
  readonly state: AlienState;
  readonly module: ModuleId;
  /**
   * True if this alien runs its own §3 coalescer and attention thresholds. The
   * room then feeds it EVERY audible arrival through `hear()` and never calls
   * `investigate()`. False (or absent) and the room coalesces on its behalf.
   */
  readonly ownsCoalescing?: boolean;
  /** Place it at round start (§10: at least three hops from the crew). */
  spawn(module: ModuleId, pos: Vec3, ctx: SimContext): void;
  /**
   * The round has begun (§5's FSM leaves the pre-round DORMANT).
   *
   * `spawn()` deliberately leaves the alien DORMANT so it does not wander a
   * LOBBY; the room calls this the moment the round starts. What the sim does
   * with it is the sim's business — the shipping `Alien` starts a crew-scaled
   * round-start grace rather than patrolling immediately, because §10's reunion
   * phase has to be survivable and the three-hop spawn floor it was leaning on
   * is worth roughly ten seconds at `SPEED_PATROL`. Optional: a sim with no
   * dormant state can ignore it. Must be idempotent.
   */
  wake?(ctx: SimContext): void;
  /** Fixed step, `dt` in seconds. */
  update(dt: number, ctx: SimContext): void;
  /**
   * An arrival that passed the current attention threshold (§3). Called as it
   * happens, because the HUNT trigger ("an arrival above 50 within 10m") must
   * not wait for the coalescing window.
   */
  hear(input: AlienHearing, ctx: SimContext): void;
  /**
   * The coalescer closed a window (§3). `point` is already jittered by
   * `errorRadius(level) + repeatPenalty` — the §3 fairness mechanic.
   */
  investigate(decision: CoalescerDecision, point: Vec3, ctx: SimContext): void;
  /** Round reset. */
  reset(): void;
}

/** §5's escalation director. */
export interface DirectorSim {
  readonly stage: DirectorStage;
  readonly systemsOnline: number;
  /** ms until the next free stage (§14 STAGE_TIMEOUT_MS). */
  readonly msToNextFreeStage: number;
  /** Fixed step, `dtMs` in milliseconds. Returns true if the stage changed. */
  update(dtMs: number, ctx: SimContext): boolean;
  /** A puzzle brought a system online (§5 "stage advances per system"). */
  systemOnline(system: EscapeSystemId): void;
  /**
   * The undock sequence is live — stage 4 outright.
   *
   * §5's stage table triggers stage 4 on "all systems / undock live", and the
   * second half is not redundant: `SYSTEMS_TO_ESCAPE` is 4 of 5 gating
   * puzzles (§11), so a crew can run the finale having skipped one and would
   * otherwise pull the levers at stage 3. Idempotent.
   */
  undockLive?(): void;
  reset(): void;
}

/** Result of routing one `interact` into a puzzle. */
export interface PuzzleInteractResult {
  puzzle: Puzzle;
  /** State changed and should be re-broadcast. */
  changed: boolean;
  /** Systems unlocked by this interaction (§11 `gates`). */
  systemsUnlocked: EscapeSystemId[];
  /** Feedback for the acting player. */
  message?: string;
}

/** §11's puzzle registry. */
export interface PuzzleSim {
  readonly puzzles: readonly Puzzle[];
  get(id: PuzzleId): Puzzle | undefined;
  /**
   * Optional: which module an `interact.targetId` physically lives in. The room
   * uses it to refuse remote-control puzzle solving — §6's whole argument for
   * in-world panels is that you must "physically be at the panel, one hand on a
   * rail, back exposed". Return null when the target is not a puzzle.
   */
  moduleFor?(targetId: string): ModuleId | null;
  /**
   * Optional: true when this locker prop is JAMMED and has to be pried (60, 3 s)
   * or hand-pumped (6, 25 s) before anything comes out of it (§11).
   *
   * The room hands out medkits and decoys from its own `ItemRegistry`, which
   * scans the same locker props — so without this a jammed locker still opens
   * for half its contents and the mechanic reads as broken.
   */
  lockerJammed?(targetId: string): boolean;
  /** Route a client `interact`. Return null if the message was not for a
   *  puzzle — the room then handles it as a world interaction (loot, revive…). */
  interact(playerId: PlayerId, msg: InteractMessage, ctx: SimContext): PuzzleInteractResult | null;
  /** Fixed step, `dt` in seconds — timed holds (§11 undock, override levers). */
  update(dt: number, ctx: SimContext): PuzzleInteractResult[];
  reset(): void;
}
