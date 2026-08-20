/**
 * The alien (DESIGN.md §5). Server-authoritative; `src/alien/` is only a visual
 * proxy.
 *
 *     DORMANT → PATROL → INVESTIGATE → SEARCH → HUNT → ATTACK
 *                            ↑____________|        |
 *                            └── RETREAT ←─────────┘
 *
 * **Perception is sound + contact only. No vision cone, ever.** It consumes
 * NoiseEvents, resolves them through the shared graph propagation, coalesces
 * them with the shared §3 coalescer, and reacts according to state-dependent
 * attention thresholds. Everything it knows about a player it learned by
 * hearing them or by touching them.
 *
 * Locomotion is rail-following over the shared rail graph — "it moves the way
 * the player does" (§5) — with A* over the module graph choosing the route.
 * Sealed hatches are impassable (`PASSABLE_ALIEN`); closed ones cost it
 * HATCH_OPEN_TIME and a loudness-45 announcement.
 *
 * The room owns one of these and ticks it at 20 Hz:
 *
 *     alien.tick(TICK_MS / 1000, Date.now(), this.state.tick);
 */

import {
  ANTICAMP_RADIUS_M,
  ALIEN_SPAWN_MIN_HOPS,
  ATTN_HUNT,
  CROWD_BIAS_WEIGHT,
  DECK_Y_M,
  FLOOR,
  HATCH_OPEN_TIME,
  HIDE_BREACH_RANGE_M,
  HIDE_BREACH_TIME_S,
  HUNT_TRIGGER_RANGE_M,
  PLAYER_RADIUS,
  SPEED_HUNT,
  SPEED_SEARCH,
  anticampMs,
  clamp,
  gaitProfile,
  noiseLoudness,
  patrolStandoffM,
  roundGraceSeconds,
} from '@shared/constants';
import type {
  AlienSnapshot,
  AlienState,
  Gait,
  HideSpotKey,
  ModuleId,
  NoiseEvent,
  PlayerId,
  PortId,
  Quat,
  RailKey,
  Vec3,
} from '@shared/types';
import {
  NoiseCoalescer,
  PASSABLE_ALIEN,
  add,
  cloneV3,
  cross,
  distance,
  dot,
  groundDistance,
  investigationPoint,
  length,
  lengthSq,
  quat,
  resolveFor,
  scale,
  sub,
  syncHatchAttenuation,
  v3,
} from '@shared/graph';
import type {
  CoalescerDecision,
  CoalescerInput,
  HideSpotGraph,
  HideVolume,
  ModuleEdge,
  ModuleGraph,
  Propagation,
  RailGraph,
  RailQuery,
} from '@shared/graph';
import type { EscalationDirector } from './director';

// ===========================================================================
// Supporting constants
//
// None of these are in §14 — they are the mechanical glue §5 implies but does
// not number. Every §14 value is imported above; nothing here duplicates one.
// ===========================================================================

/** `NoiseEvent.actor` used for the alien's own noise, so it never investigates
 *  the door it just opened. */
export const ALIEN_ACTOR_ID = 'alien';

/** m — capsule radius of the placeholder body (§5/§9: it is a capsule until M8).
 *  Matches `src/alien/alienView.ts`. */
export const ALIEN_RADIUS = 0.45;

/** m — contact. Touch is the alien's only sense besides hearing (§5). */
export const CONTACT_RANGE_M = PLAYER_RADIUS + ALIEN_RADIUS;

/** Scratch for `contactDistance()`. One alien, one thread, no re-entry. */
const _contactPoint: Vec3 = { x: 0, y: 0, z: 0 };

/** m — close enough to a port to start cranking the hatch open. */
export const HATCH_REACH_M = 1.5;

/** m — close enough to a waypoint or a goal to count as arrived. */
export const ARRIVE_EPSILON_M = 0.6;

/** m — glide distance at which the alien grabs the rail it was gliding to. */
export const RAIL_ATTACH_M = 0.35;

/** m — a goal further than this from every handrail in its module is pulled
 *  back onto the rail graph. See `snapGoal`. */
export const GOAL_SNAP_M = 2.5;

/** m — it will detour to a handrail within this range rather than free-glide. */
export const RAIL_SEEK_M = 8;

/** s — after letting go of a rail it free-glides at least this long, so it
 *  cannot flicker between gripping and gliding on the spot. */
export const RAIL_RELEASE_COOLDOWN_S = 0.5;

/** s — HUNT is not silent (§5, non-negotiable). It roars this often. */
export const HUNT_NOISE_INTERVAL_S = 0.75;

/** s — a fix older than this, once arrived at, means it lost you → SEARCH. */
export const HUNT_FIX_STALE_S = 3.0;

/** s — the ATTACK animation window. The kill lands on entry; this is the beat
 *  before it disengages (§5: RETREAT after a kill). */
export const ATTACK_DURATION_S = 0.8;

/** s — DORMANT gives way to PATROL on its own if nobody makes a sound. §5's
 *  diagram has the transition but no number; this is the one timing invented
 *  here, and it is a constructor option.
 *
 *  This is the BACKSTOP, for a sim that was spawned and then never told the
 *  round began. The real round-start grace is `roundGraceSeconds()` and is set
 *  by `wake()`. */
export const DORMANT_SECONDS = 15;

/** s — the standoff re-target cannot fire more often than this. Without it the
 *  alien re-plans every tick while a player wanders in and out of the standoff
 *  radius, and never actually goes anywhere. */
export const STANDOFF_REPLAN_COOLDOWN_S = 4;

/** ms — after an anti-camp eviction the alien only reacts to hunt-level noise
 *  for this long, so the eviction is real rather than instantly undone by the
 *  camper's next breath (§5 "force PATROL to a distant module"). */
export const ANTICAMP_LOCK_MS = 5_000;

/** How many retained §3 secondaries it carries at once. A memory, not a plan:
 *  six players in one window must not queue up a six-stop tour. */
export const SECONDARY_QUEUE_MAX = 3;

/** ms — how long a retained secondary stays worth walking to. §3 says a masked
 *  event is "still remembered"; this is how long "still" lasts. Long enough to
 *  outlive a decoy pull and the SEARCH sweep that follows it (≈12s + 25s at
 *  stage 3), short enough that it never investigates ancient history. */
export const SECONDARY_MEMORY_MS = 45_000;

/** s — no measurable progress for this long means the goal is unreachable;
 *  treat it as arrived and re-plan rather than grinding into a wall. */
export const STUCK_TIMEOUT_S = 1.5;

/** s — module A* is cheap on 8–10 modules, but there is no reason to redo it
 *  every tick when nothing has changed. */
export const REPATH_INTERVAL_S = 1.0;

/**
 * ms a hide spot stays "suspect" after something was heard coming out of it.
 *
 * The suspicion is NOT sight and NOT a fix on a player: it is the fact that an
 * arrival which cleared the current attention threshold originated inside a hide
 * volume. For a muffled occupant that means the alien was already inside
 * `HIDE_SAFE_RADIUS_M` when they made the sound (§4 derives the 3 m from
 * `HIDE_MUFFLE_DB` and `ATTN_SEARCH`), so the suspicion is earned by hearing and
 * nothing else.
 *
 * 15 s is one stage-0 SEARCH sweep: keep making noise in there and it works out
 * which box; go silent and it forgets and wanders off, which is the entire
 * mechanic.
 */
export const HIDE_SUSPECT_MEMORY_MS = 15_000;

/** m — margin around a hide volume within which a noise counts as having come
 *  OUT of it. A body is not a point, and the occupant's reported position is
 *  their own, not the box centre. */
export const HIDE_ORIGIN_MARGIN_M = 0.35;

/**
 * m — clearance the alien's body keeps from a hide volume.
 *
 * Deliberately NOT the full `ALIEN_RADIUS`. `HideSpotGraph.sweepBlocked` is an
 * exact segment-vs-slab test against the box expanded by this radius, which
 * treats the swept sphere's rounded corners as square and therefore already
 * errs toward reporting a block. Feeding it a 0.45 m body on top of a box that
 * hugs an occupant would fence off a metre of a five-metre module — and in a
 * node piece, whose handrails all meet at the hub, it can wall the thing out of
 * the room outright.
 *
 * 0.15 m keeps its body out of the box, which is the guarantee §4 actually
 * asks for, without turning a locker into a bollard.
 */
export const HIDE_CLEARANCE_M = 0.15;

/** m — how far off a walking module's deck the alien's centre rides. Its body
 *  is a capsule (§5/§9 — it is one until M8), so its centre sits one radius
 *  above whatever it is standing on. */
export const DECK_RIDE_HEIGHT_M = DECK_Y_M + ALIEN_RADIUS;

/** Fraction of a step the alien closes onto the deck height per tick while
 *  walking. Not physics — it does not fall, it stalks — just enough that a
 *  `settle` into a walking module does not read as teleporting to the floor. */
export const DECK_SETTLE_RATE = 6;

const EPS = 1e-6;

// ===========================================================================
// The world the alien is allowed to see
// ===========================================================================

/**
 * The alien's read-only view of a player. Deliberately narrow: it gets a
 * position because it needs contact and anti-camp distance checks, NOT because
 * it can see anybody. Nothing in the FSM may path toward `pos` except through
 * contact or through a heard fix.
 */
export interface AlienPlayerView {
  id: PlayerId;
  pos: Vec3;
  module: ModuleId;
  alive: boolean;
  /**
   * `HideSpotKey` this player is inside, or null (§4 hiding).
   *
   * Read for exactly two things, both physical: the alien cannot touch a body
   * through the shell, and it cannot sweep its own body through an occupied
   * volume. Nothing in the FSM may path toward a hidden player because of this
   * field — the ONLY thing that ever resolves a hide spot is a noise arriving
   * from inside it. Hiding does not introduce sight logic, here or anywhere.
   */
  hideSpot: HideSpotKey | null;
  /**
   * The player's gait, for ONE purpose: `pos` is the EYE, and the body hangs
   * below it (§4 — "position IS the eye in both regimes"). Contact is the only
   * sense besides hearing, so the alien has to know where the body actually is.
   *
   * Not perception. It never reaches the FSM, the pathfinder or the coalescer —
   * only `contactDistance()`, which turns an eye into a body.
   */
  gait: Gait;
}

/** Everything the sim needs from the room. The integrator supplies this. */
export interface AlienWorld {
  readonly graph: ModuleGraph;
  readonly rails: RailGraph;
  /** §4's hide spots in world space. Pure geometry: containment, sweeps,
   *  distances. No sight query exists on it and none may be added. */
  readonly hides: HideSpotGraph;
  /** Living and dead players; the alien filters for `alive` itself. */
  players(): readonly AlienPlayerView[];
  /** Push a NoiseEvent into the server's noise pipeline (propagate + broadcast). */
  emitNoise(event: NoiseEvent): void;
  /** The alien caught someone. The room marks them dead and sends `death`. */
  onKill(playerId: PlayerId, at: Vec3): void;
  /** The alien opened a hatch; mirror it into the room schema (§7 `hatches`). */
  onHatchChanged?(module: ModuleId, port: PortId, open: boolean, sealed: boolean): void;
}

export interface AlienOptions {
  /** Injectable RNG so a round can be replayed. Defaults to Math.random. */
  rng?: () => number;
  /** Seconds before DORMANT wakes on its own if `wake()` is never called.
   *  Defaults to DORMANT_SECONDS. */
  dormantSeconds?: number;
  /** Override the crew-scaled round-start grace `wake()` rolls (§10). Round
   *  scripting and A/B measurement only — leave it unset in a real round, or
   *  the whole point of `roundGraceSeconds()` is gone. */
  roundGraceSeconds?: number;
  /** Seconds between HUNT roars. Defaults to HUNT_NOISE_INTERVAL_S. */
  huntNoiseIntervalS?: number;
  /** Fired on every FSM transition — the room can broadcast or log it. */
  onStateChange?: (from: AlienState, to: AlienState) => void;
}

/** What the alien currently believes about where a noise came from. */
interface HuntFix {
  playerId: PlayerId | null;
  pos: Vec3;
  module: ModuleId;
  atMs: number;
}

/**
 * A §3 secondary: an arrival within `DISCARD_MARGIN` of the window's loudest,
 * kept for later rather than thrown away with the window.
 *
 * The origin and level are stored raw so the §3 fairness jitter is rolled when
 * the alien actually commits to walking there — a remembered noise is no more
 * precisely located than a fresh one.
 */
interface RetainedTarget {
  origin: Vec3;
  module: ModuleId;
  /** Arrival level at the alien, for `errorRadius` and for ordering. */
  level: number;
  /** The window's diminishing-returns penalty (§3), frozen at retention time. */
  penaltyM: number;
  /** Wall clock it was retained, for `SECONDARY_MEMORY_MS`. */
  atMs: number;
}

/**
 * A hide spot the alien has HEARD something come out of (§4).
 *
 * Not a sighting and not a player fix — the origin of an arrival that cleared
 * the attention threshold happened to lie inside a hide volume. For a muffled
 * occupant that can only happen from inside `HIDE_SAFE_RADIUS_M`.
 */
interface HideSuspect {
  key: HideSpotKey;
  module: ModuleId;
  /** Wall clock the last such arrival landed. */
  atMs: number;
}

/** Debug view for the dev free-camera (§7 "spawn a free camera and watch"). */
export interface AlienDebug {
  state: AlienState;
  module: ModuleId;
  pos: Vec3;
  goal: Vec3 | null;
  goalModule: ModuleId | null;
  railKey: RailKey | null;
  modulePath: readonly ModuleId[];
  attention: number;
  /** Living players the crew scaling is currently running against (§14). */
  livingPlayers: number;
  /** s of round-start grace left; 0 once it is awake (§10). */
  graceRemaining: number;
  /** m — the low-crew PATROL standoff in force right now. 0 at CREW_FULL. */
  standoffM: number;
  campMs: number;
  campLimitMs: number;
  searchRemaining: number;
  hatchRemaining: number;
  /** True while the module underfoot has a deck and it is walking rather than
   *  rail-following (§4's pivot). */
  walking: boolean;
  /** Hide spot it has heard something in, if any. */
  suspectHide: HideSpotKey | null;
  /** s left on a breach in progress, 0 when it is not breaching (§4). */
  breachRemaining: number;
  fix: HuntFix | null;
  /** Retained §3 secondaries still queued for investigation, loudest first. */
  secondary: readonly { module: ModuleId; level: number; ageMs: number }[];
}

// ===========================================================================
// Alien
// ===========================================================================

export class Alien {
  private readonly world: AlienWorld;
  private readonly director: EscalationDirector;
  private readonly rng: () => number;
  private readonly dormantSeconds: number;
  private readonly graceOverrideS: number | null;
  private readonly huntNoiseIntervalS: number;
  private readonly onStateChange: ((from: AlienState, to: AlienState) => void) | null;

  /** §3 coalescer. No `minLevel`: the attention threshold is state-dependent and
   *  changes with the director, so filtering happens at `hear()` time. */
  private readonly coalescer = new NoiseCoalescer();

  private _state: AlienState = 'DORMANT';
  private _pos: Vec3 = v3();
  private _quat: Quat = quat();
  private _module: ModuleId = '';
  private _tick = 0;
  private nowMs = 0;
  /** dt of the tick currently being stepped, seconds. `walkDeck` needs it for a
   *  frame-rate-independent settle onto the floor. */
  private lastDt = 1 / 20;

  // Locomotion
  private railKey: RailKey | null = null;
  private railT = 0;
  private railPath: RailKey[] = [];
  private railIndex = 0;
  private railPathGoal: RailKey | null = null;
  private railCooldownS = 0;
  private goalPos: Vec3 | null = null;
  private goalModule: ModuleId | null = null;
  private modulePath: ModuleId[] | null = null;
  private repathTimerS = 0;
  private stuckTimerS = 0;

  // Per-state timers
  private stateTimeS = 0;
  private searchRemainingS = 0;
  private huntNoiseTimerS = 0;
  private retreatReason: 'kill' | 'decoy' = 'kill';
  /** s of DORMANT left before it starts patrolling. Set by `spawn()` to the
   *  `DORMANT_SECONDS` backstop and by `wake()` to the real round-start grace. */
  private graceRemainingS = DORMANT_SECONDS;
  /** s until the low-crew PATROL standoff may re-target again. */
  private standoffCooldownS = 0;

  // Hatch work
  private hatchWork: { module: ModuleId; port: PortId; remainingS: number } | null = null;

  // Hiding (§4). A suspect is EARNED BY HEARING; a breach is what it does about it.
  private suspect: HideSuspect | null = null;
  private breachWork: { key: HideSpotKey; remainingS: number } | null = null;
  private occupiedCache: Set<HideSpotKey> | null = null;
  private occupiedAtTick = -1;

  // Perception
  private fix: HuntFix | null = null;
  /** §3 secondaries retained from closed windows, loudest first. */
  private retained: RetainedTarget[] = [];

  // Anti-camping (§5)
  private campMs = 0;
  private campLimitMs: number;
  private attentionLockUntilMs = 0;
  /** Set by `wake()`; keeps the round-start grace from being re-rolled. */
  private woken = false;

  constructor(world: AlienWorld, director: EscalationDirector, opts: AlienOptions = {}) {
    this.world = world;
    this.director = director;
    this.rng = opts.rng ?? Math.random;
    this.dormantSeconds = opts.dormantSeconds ?? DORMANT_SECONDS;
    this.graceOverrideS = opts.roundGraceSeconds ?? null;
    this.huntNoiseIntervalS = opts.huntNoiseIntervalS ?? HUNT_NOISE_INTERVAL_S;
    this.onStateChange = opts.onStateChange ?? null;
    this.campLimitMs = anticampMs(this.rng);
    const first = world.graph.ids()[0];
    this._module = first ?? '';
    if (first) {
      const centre = world.graph.centre(first);
      if (centre) this._pos = cloneV3(centre);
    }
  }

  // -- reads ----------------------------------------------------------------

  get state(): AlienState {
    return this._state;
  }

  get position(): Vec3 {
    return cloneV3(this._pos);
  }

  get module(): ModuleId {
    return this._module;
  }

  get orientation(): Quat {
    return { ...this._quat };
  }

  /** True while it is cranking a closed hatch open (§5 — 3s, loudness 45). */
  get openingHatch(): boolean {
    return this.hatchWork !== null;
  }

  /** §7 `alien:` — mirror this into the room schema every tick. */
  snapshot(): AlienSnapshot {
    return {
      pos: cloneV3(this._pos),
      quat: { ...this._quat },
      state: this._state,
      module: this._module,
    };
  }

  /** Straight-line metres to a world position. The wrist tracker (§6) is
   *  computed client-side from the synced transform; this is for the sim. */
  distanceTo(pos: Vec3): number {
    return distance(this._pos, pos);
  }

  debug(): AlienDebug {
    return {
      state: this._state,
      module: this._module,
      pos: cloneV3(this._pos),
      goal: this.goalPos ? cloneV3(this.goalPos) : null,
      goalModule: this.goalModule,
      railKey: this.railKey,
      modulePath: this.modulePath ? [...this.modulePath] : [],
      attention: this.currentAttention(),
      livingPlayers: this.livingPlayers(),
      graceRemaining: this.graceRemaining,
      standoffM: patrolStandoffM(this.livingPlayers()),
      campMs: this.campMs,
      campLimitMs: this.campLimitMs,
      searchRemaining: this.searchRemainingS,
      hatchRemaining: this.hatchWork?.remainingS ?? 0,
      walking: this.onDeck(),
      suspectHide: this.suspect?.key ?? null,
      breachRemaining: this.breachWork?.remainingS ?? 0,
      fix: this.fix ? { ...this.fix, pos: cloneV3(this.fix.pos) } : null,
      secondary: this.retained.map((q) => ({
        module: q.module,
        level: q.level,
        ageMs: Math.max(0, this.nowMs - q.atMs),
      })),
    };
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Place the alien for a fresh round (§10 — "the alien spawns randomly too, at
   * least three hops from the majority of players"). Use `chooseAlienSpawn()`
   * to pick the module.
   */
  spawn(moduleId: ModuleId, pos?: Vec3): void {
    const module = this.world.graph.get(moduleId);
    if (!module) throw new Error(`Alien.spawn: unknown module '${moduleId}'`);
    this._module = moduleId;
    this._pos = cloneV3(pos ?? module.transform.pos);
    // Snap onto a handrail if the module has any — it lives on the rails.
    const rail = this.world.rails.nearestInModule(moduleId, this._pos);
    if (rail) {
      this.railKey = rail.key;
      this.railT = rail.t;
      this._pos = cloneV3(rail.point);
    } else {
      this.railKey = null;
    }
    this.clearGoal();
    this.fix = null;
    this.retained = [];
    this.coalescer.reset();
    this.campMs = 0;
    this.campLimitMs = anticampMs(this.rng);
    this.attentionLockUntilMs = 0;
    this.hatchWork = null;
    this.suspect = null;
    this.breachWork = null;
    // Back to the un-woken backstop: `wake()` rolls the real round-start grace,
    // and re-arming `woken` here is what makes a bare `spawn()` (no `reset()`
    // first) start a fresh round rather than one with no grace at all.
    this.woken = false;
    this.graceRemainingS = this.dormantSeconds;
    this.standoffCooldownS = 0;
    this.setState('DORMANT');
  }

  /**
   * The round has begun. Start the round-start grace (§10's reunion phase).
   *
   * `spawn()` leaves the alien DORMANT so one sitting in a LOBBY does not
   * wander; this is the room saying "now". It does **not** go straight to
   * PATROL, and the reason is measured rather than felt:
   *
   * §10 claims the fairness floor for the opening is the three-hop spawn
   * separation. On the shipped nine-module level three hops is about 15 m and
   * `SPEED_PATROL` is 1.5 m/s, so that floor is worth **ten seconds** — and the
   * alien spends those ten seconds walking, which with a solo player means it
   * arrives before the reunion phase has begun. A spawn constraint is not a
   * grace period. Wiring `wake()` straight into PATROL removed the only real one
   * and made §10's opening unsurvivable alone.
   *
   * So the alien stays DORMANT for `roundGraceSeconds(livingPlayers)` — 75 s
   * solo, 25 s at a full crew — during which it does not move and its attention
   * is pinned at the HUNT trigger. Quiet play is genuinely safe; a full-speed
   * crash, a pry bar, an extinguisher, a decoy or a hand on its back is not.
   * It is a grace period, not an invulnerability window.
   *
   * Idempotent: calling it twice does not extend the grace.
   */
  wake(): void {
    if (this._state !== 'DORMANT') return;
    if (this.woken) return;
    this.woken = true;
    this.graceRemainingS = this.graceOverrideS ?? roundGraceSeconds(this.livingPlayers());
    this.stateTimeS = 0;
  }

  /** True once the grace has run out (or something loud cut it short). */
  get awake(): boolean {
    return this._state !== 'DORMANT';
  }

  /** s of round-start grace left. 0 once it is hunting the station. */
  get graceRemaining(): number {
    return this._state === 'DORMANT' ? Math.max(0, this.graceRemainingS) : 0;
  }

  /** Full reset without moving it. `spawn()` is the usual entry point. */
  reset(): void {
    this.coalescer.reset();
    this.clearGoal();
    this.fix = null;
    this.retained = [];
    this.hatchWork = null;
    this.suspect = null;
    this.breachWork = null;
    this.campMs = 0;
    this.campLimitMs = anticampMs(this.rng);
    this.attentionLockUntilMs = 0;
    this.woken = false;
    this.graceRemainingS = this.dormantSeconds;
    this.standoffCooldownS = 0;
    this.setState('DORMANT');
  }

  /** Living, un-escaped players. The room's `AlienPlayerView.alive` already
   *  excludes anyone who has escaped. Never below 1 — see §14 crew scaling. */
  private livingPlayers(): number {
    let n = 0;
    for (const p of this.world.players()) if (p.alive) n++;
    return Math.max(1, n);
  }

  // -- perception (§5: sound and contact only) ------------------------------

  /**
   * Hear one NoiseEvent, resolving it through the module graph at the alien's
   * own position. Use `hearPropagation()` instead when the room has already
   * propagated the event for the other listeners — the graph walk is the
   * expensive half.
   */
  hear(event: NoiseEvent, nowMs: number = this.nowMs): void {
    if (this.ignores(event)) return;
    const res = resolveFor(event, this.world.graph, this._pos, this._module);
    if (!res.audible) return;
    this.hearResolved(event, res.level, res.distance, nowMs);
  }

  /** Same, reusing a `Propagation` the room already computed. */
  hearPropagation(event: NoiseEvent, propagation: Propagation, nowMs: number = this.nowMs): void {
    if (this.ignores(event)) return;
    const res = propagation.resolve(this._pos, this._module);
    if (!res.audible) return;
    this.hearResolved(event, res.level, res.distance, nowMs);
  }

  /**
   * Hear an arrival whose level and path distance are already known.
   *
   * `level` is the ARRIVAL level at the alien, never source loudness, and
   * `distanceM` is the propagated path length origin → alien (§3).
   */
  hearResolved(event: NoiseEvent, level: number, distanceM: number, nowMs: number = this.nowMs): void {
    if (this.ignores(event)) return;
    if (level < FLOOR) return;
    this.nowMs = nowMs;

    // A decoy always goes through the coalescer: §3's margin rule is what stops
    // it being a remote control, and `consider()` turns it into RETREAT.
    if (event.kind !== 'decoy') {
      // §5: HUNT triggers on an arrival ABOVE 50 (above 35 at stage 4) within
      // 10m. Immediate — this is a reflex, not a considered re-target.
      const trigger = this.director.huntTrigger;
      if (
        triggersHunt(level, trigger) &&
        distanceM <= HUNT_TRIGGER_RANGE_M &&
        this._state !== 'ATTACK' &&
        nowMs >= this.attentionLockUntilMs
      ) {
        this.enterHunt(event.origin, event.module, event.actor ?? null, nowMs);
        return;
      }
    }

    if (level < this.currentAttention()) return;
    // §4: a sound that came OUT of a hide spot resolves the box. This is the
    // only mechanism by which a hidden player is ever found, and it costs the
    // occupant exactly what §4 says it costs — noise.
    this.noteHideSuspect(event, nowMs);
    this.coalescer.push(event, level, nowMs);
  }

  /**
   * Did this arrival come from inside an OCCUPIED hide volume?
   *
   * Deliberately gated on occupancy: an empty locker rattling is a locker
   * rattling. And deliberately downstream of the attention threshold — the
   * shell's −8 dB has already been applied to the source loudness by the time
   * the room resolves it, so a calm occupant simply never gets this far, and a
   * panicked one only does from inside `HIDE_SAFE_RADIUS_M`. That derivation is
   * §4's, not this file's; all this does is notice.
   */
  private noteHideSuspect(event: NoiseEvent, nowMs: number): void {
    if (this.world.hides.size === 0) return;
    const occupied = this.occupiedHideSpots();
    if (occupied.size === 0) return;
    const volume = this.world.hides.containing(
      event.origin,
      event.module,
      HIDE_ORIGIN_MARGIN_M,
    );
    if (!volume || !occupied.has(volume.key)) return;
    this.suspect = { key: volume.key, module: volume.module, atMs: nowMs };
  }

  /**
   * Hide spots with a living body in them right now.
   *
   * Memoised per tick: `stepBlocked` asks several times inside one step and the
   * answer cannot change between those calls.
   */
  private occupiedHideSpots(): Set<HideSpotKey> {
    if (this.occupiedAtTick === this._tick && this.occupiedCache) return this.occupiedCache;
    const out = new Set<HideSpotKey>();
    for (const p of this.world.players()) {
      if (!p.alive || p.hideSpot === null) continue;
      out.add(p.hideSpot);
    }
    this.occupiedCache = out;
    this.occupiedAtTick = this._tick;
    return out;
  }

  /** The suspect volume, if it is still fresh and still occupied. */
  private liveSuspect(nowMs: number): HideVolume | null {
    const suspect = this.suspect;
    if (!suspect) return null;
    if (nowMs - suspect.atMs > HIDE_SUSPECT_MEMORY_MS) {
      this.suspect = null;
      return null;
    }
    const volume = this.world.hides.volume(suspect.key);
    if (!volume) {
      this.suspect = null;
      return null;
    }
    if (!this.occupiedHideSpots().has(suspect.key)) {
      // They got out. The box is no longer interesting; the room is.
      this.suspect = null;
      return null;
    }
    return volume;
  }

  /** Events the alien is structurally incapable of reacting to. */
  private ignores(event: NoiseEvent): boolean {
    return event.actor === ALIEN_ACTOR_ID || event.kind === 'alien';
  }

  // -- the 20 Hz step -------------------------------------------------------

  /**
   * One simulation step. `dt` is seconds (the room's fixed 1/20), `nowMs` is
   * wall clock for the coalescer's rolling window, `serverTick` stamps any
   * NoiseEvent the alien emits.
   */
  tick(dt: number, nowMs: number = Date.now(), serverTick?: number): void {
    this.nowMs = nowMs;
    this.lastDt = dt > 0 ? dt : this.lastDt;
    this._tick = serverTick ?? this._tick + 1;
    this.stateTimeS += dt;
    if (this.railCooldownS > 0) this.railCooldownS = Math.max(0, this.railCooldownS - dt);
    if (this.repathTimerS > 0) this.repathTimerS -= dt;

    // 1. Contact. Touch beats everything — it is the alien's other sense.
    if (this.checkContact(nowMs)) return;

    // 1b. Breaching a hide spot it has heard somebody in (§4). Consumes the
    //     tick: for those two seconds it does nothing else, which is what makes
    //     them a window to bail out rather than a cutscene.
    if (this.tickBreach(dt, nowMs)) return;

    // 2. Coalesced hearing: at most one re-target per §3 window.
    const decision = this.coalescer.flush(nowMs);
    if (decision) this.consider(decision, nowMs);

    // 3. Anti-camping (§5): fuzzed 60–150s within 15m of a living player
    //    without a kill, and it is evicted to a distant module.
    this.updateAntiCamp(dt, nowMs);

    // 4. Behaviour.
    switch (this._state) {
      case 'DORMANT':
        this.tickDormant(dt);
        break;
      case 'PATROL':
        this.tickPatrol(dt);
        break;
      case 'INVESTIGATE':
        this.tickInvestigate(dt);
        break;
      case 'SEARCH':
        this.tickSearch(dt);
        break;
      case 'HUNT':
        this.tickHunt(dt, nowMs);
        break;
      case 'ATTACK':
        this.tickAttack(dt);
        break;
      case 'RETREAT':
        this.tickRetreat(dt);
        break;
      default:
        break;
    }
  }

  // -- states ---------------------------------------------------------------

  /**
   * The round-start grace (§10). It does not move and does not investigate;
   * `currentAttention()` pins it at the HUNT trigger, so only something loud
   * enough to hunt — or a hand on its back — starts the round early.
   */
  private tickDormant(dt: number): void {
    this.graceRemainingS -= dt;
    if (this.graceRemainingS <= 0) {
      this.setState('PATROL');
      this.pickPatrolTarget();
    }
  }

  private tickPatrol(dt: number): void {
    if (this.standoffCooldownS > 0) this.standoffCooldownS -= dt;
    if (!this.goalPos) this.pickPatrolTarget();
    if (this.applyPatrolStandoff()) return;
    const result = this.navigate(dt, this.director.patrolSpeed);
    if (result === 'arrived' || result === 'blocked') this.pickPatrolTarget();
  }

  /**
   * The low-crew PATROL standoff — §5's crowd bias run in reverse. Returns true
   * when it re-targeted this tick.
   *
   * §5 justifies crowd bias as PACING, not perception: "weight target selection
   * 2:1 toward the module holding the largest cluster of players, so the far
   * side of a ten-module station doesn't have a boring round." With one player
   * that same rule has nothing to weigh and degenerates into a homing beacon,
   * and the ordinary uniform patrol underneath it is barely better: measured on
   * the shipped nine-module level (mean hop distance 2.07, 84.9 m of handrail,
   * one alien) a purely random patrol walks onto a solo player's handrail inside
   * about thirty seconds, and contact is an instant kill. Six players make that
   * a shared risk with a revive (§10); one player makes it the whole round, and
   * it happens without the alien having heard a thing — which is the exact
   * opposite of "perception is sound and contact only" being *legible*.
   *
   * So at low crew, and ONLY while patrolling with nothing to show for it, the
   * alien keeps its distance and drifts elsewhere. The moment it has heard
   * something — a fix, or a retained §3 secondary — the standoff is off and it
   * comes for you from any range. `patrolStandoffM` reaches 0 at CREW_FULL, so a
   * full crew is never avoided.
   */
  private applyPatrolStandoff(): boolean {
    if (this.standoffCooldownS > 0) return false;
    if (this.fix || this.retained.length > 0) return false;
    const standoff = patrolStandoffM(this.livingPlayers());
    if (standoff <= 0) return false;

    let near = false;
    for (const p of this.world.players()) {
      if (!p.alive) continue;
      if (distance(p.pos, this._pos) <= standoff) {
        near = true;
        break;
      }
    }
    if (!near) return false;

    this.standoffCooldownS = STANDOFF_REPLAN_COOLDOWN_S;
    this.setGoalModule(this.farthestModuleFromPlayers());
    return true;
  }

  private tickInvestigate(dt: number): void {
    if (!this.goalPos) {
      this.beginSearch();
      return;
    }
    const result = this.navigate(dt, this.director.patrolSpeed);
    if (result === 'arrived' || result === 'blocked') this.beginSearch();
  }

  private tickSearch(dt: number): void {
    this.searchRemainingS -= dt;
    if (this.searchRemainingS <= 0) {
      // The primary is resolved: this module has been swept. Anything §3
      // retained under it is the next place to look, before patrol.
      if (this.nextRetained(this.nowMs)) return;
      this.setState('PATROL');
      this.pickPatrolTarget();
      return;
    }
    if (!this.goalPos) {
      this.pickSweepTarget();
      return;
    }
    const result = this.navigate(dt, SPEED_SEARCH);
    if (result === 'arrived' || result === 'blocked') this.pickSweepTarget();
  }

  private tickHunt(dt: number, nowMs: number): void {
    // §5, non-negotiable: it makes loud noise while hunting. A silent charge is
    // unfair and reads as a bug.
    this.huntNoiseTimerS -= dt;
    if (this.huntNoiseTimerS <= 0) {
      this.roar();
      this.huntNoiseTimerS = this.huntNoiseIntervalS;
    }

    if (!this.fix) {
      this.beginSearch();
      return;
    }
    const result = this.navigate(dt, SPEED_HUNT);
    if (result === 'arrived' || result === 'blocked') {
      // Reached the last thing it heard. If nothing has updated the fix since,
      // it has lost you: sweep from here.
      if (nowMs - this.fix.atMs >= HUNT_FIX_STALE_S * 1000) {
        this.fix = null;
        this.beginSearch();
      }
      // Otherwise: fresh fix, already standing on it. Hold position and keep
      // roaring until the next sound gives it a new bearing. Holding still on
      // top of someone who has just gone silent is the correct, awful answer.
    }
  }

  private tickAttack(_dt: number): void {
    if (this.stateTimeS >= ATTACK_DURATION_S) {
      this.beginRetreat('kill');
    }
  }

  private tickRetreat(dt: number): void {
    if (!this.goalPos) {
      this.setState('PATROL');
      this.pickPatrolTarget();
      return;
    }
    const result = this.navigate(dt, this.director.patrolSpeed);
    if (result === 'arrived' || result === 'blocked') {
      if (this.retreatReason === 'decoy') {
        // Pulled by a decoy: it commits to sweeping where the decoy landed,
        // which is exactly what makes a decoy worth one of the two per round.
        this.beginSearch();
      } else {
        this.setState('PATROL');
        this.pickPatrolTarget();
      }
    }
  }

  // -- transitions ----------------------------------------------------------

  private setState(next: AlienState): void {
    if (next === this._state) return;
    const from = this._state;
    this._state = next;
    this.stateTimeS = 0;
    this.stuckTimerS = 0;
    if (next === 'HUNT') this.huntNoiseTimerS = 0;
    if (this.onStateChange) {
      try {
        this.onStateChange(from, next);
      } catch (err) {
        console.error('[alien] state listener threw:', err);
      }
    }
  }

  /** Act on one closed §3 window. */
  private consider(decision: CoalescerDecision, nowMs: number): void {
    const window: CoalescerInput[] = [decision.primary, ...decision.secondary];

    // A decoy anywhere in the retained window pulls the alien and triggers
    // RETREAT (§5). Retained, not necessarily loudest: §3 keeps everything
    // within DISCARD_MARGIN precisely so a masked event is still remembered.
    const decoy = window.find((c) => c.event.kind === 'decoy');
    if (decoy && decoy.level >= this.currentAttention()) {
      // THE anti-leash rule, both halves. The decoy takes it away; everything
      // the decoy masked — the primary included, since the decoy may not have
      // been the loudest arrival — is retained and visited afterwards. Without
      // this, one player kites it with a repeating 70 while five teammates
      // cycle hatches at 45 in total impunity (§3).
      this.retain(window, decision.repeatPenaltyM, nowMs, null);
      this.beginRetreat('decoy', decoy.event.origin, decoy.event.module);
      return;
    }

    const primary = decision.primary;
    if (primary.level < this.currentAttention()) return;

    if (this._state === 'ATTACK') return;

    if (this._state === 'HUNT') {
      // While hunting it reacts to anything; the loudest arrival re-fixes it.
      this.setFix(primary.event.origin, primary.event.module, primary.event.actor ?? null, nowMs);
      this.setGoal(cloneV3(primary.event.origin), primary.event.module);
      return;
    }

    if (this._state === 'RETREAT' && nowMs < this.attentionLockUntilMs) return;

    // §3: "Anything within 15 is retained as a secondary investigation target."
    // The primary's own module is skipped — arriving there ends in a SEARCH
    // sweep of that module and its neighbours anyway (§5), so re-queuing it
    // would only make the alien sweep the same room twice.
    this.retain(
      decision.secondary,
      decision.repeatPenaltyM,
      nowMs,
      primary.event.module,
    );

    // §5 INVESTIGATE: move to `origin + randomInSphere(errorRadius)`, widened by
    // the coalescer's per-module diminishing-returns penalty (§3).
    const point = investigationPoint(
      primary.event.origin,
      primary.level,
      decision.repeatPenaltyM,
      this.rng,
    );
    this.setState('INVESTIGATE');
    this.setGoal(point, primary.event.module);
  }

  // -- retained secondaries (§3) --------------------------------------------

  /**
   * Remember the arrivals a closed window retained.
   *
   * §3's discard rule is margin-based *so that* the quieter events survive:
   * "only drop events more than 15 points below the window's loudest. Anything
   * within 15 is retained as a secondary investigation target," whose stated
   * purpose is that "a hatch cycle under a decoy is still remembered." Building
   * the list and dropping it on the next window remembers nothing, so the list
   * is queued here and drained by `nextRetained()` once the primary is done.
   *
   * `skipModule` is the primary's module when the alien is on its way there.
   */
  private retain(
    candidates: readonly CoalescerInput[],
    penaltyM: number,
    nowMs: number,
    skipModule: ModuleId | null,
  ): void {
    const attention = this.currentAttention();
    for (const candidate of candidates) {
      // A decoy is a pull and a RETREAT, never a place to go and look later.
      if (candidate.event.kind === 'decoy') continue;
      if (candidate.level < attention) continue;
      const module = candidate.event.module;
      if (skipModule !== null && module === skipModule) continue;

      // One entry per module: six players in one room are one destination, and
      // the loudest of them is the one worth walking to.
      const at = this.retained.findIndex((q) => q.module === module);
      if (at >= 0) {
        const prev = this.retained[at]!;
        prev.atMs = nowMs; // still going on — keep the memory fresh either way
        if (candidate.level <= prev.level) continue;
        this.retained.splice(at, 1);
      }
      this.retained.push({
        origin: cloneV3(candidate.event.origin),
        module,
        level: candidate.level,
        penaltyM,
        atMs: nowMs,
      });
    }
    if (this.retained.length === 0) return;
    this.retained.sort((a, b) => b.level - a.level || b.atMs - a.atMs);
    if (this.retained.length > SECONDARY_QUEUE_MAX) {
      this.retained.length = SECONDARY_QUEUE_MAX;
    }
  }

  /** Drop retained targets nobody would still care about. */
  private forgetStale(nowMs: number): void {
    if (this.retained.length === 0) return;
    this.retained = this.retained.filter((q) => nowMs - q.atMs < SECONDARY_MEMORY_MS);
  }

  /**
   * Commit to the best retained secondary, if any. Called when the primary is
   * resolved — the SEARCH sweep it ended in has expired — so the alien walks
   * the masked hatch cycle down instead of wandering back onto patrol.
   */
  private nextRetained(nowMs: number): boolean {
    this.forgetStale(nowMs);
    const next = this.retained.shift();
    if (!next) return false;
    const point = investigationPoint(next.origin, next.level, next.penaltyM, this.rng);
    this.setState('INVESTIGATE');
    this.setGoal(point, next.module);
    return true;
  }

  private enterHunt(origin: Vec3, module: ModuleId, actor: PlayerId | null, nowMs: number): void {
    this.setFix(origin, module, actor, nowMs);
    this.setState('HUNT');
    this.setGoal(cloneV3(origin), module);
    this.roar();
    this.huntNoiseTimerS = this.huntNoiseIntervalS;
  }

  private setFix(pos: Vec3, module: ModuleId, playerId: PlayerId | null, nowMs: number): void {
    this.fix = { playerId, pos: cloneV3(pos), module, atMs: nowMs };
  }

  private beginSearch(): void {
    // §5: on arrival, sweep that module and its neighbours for ~15s at 1.2 m/s
    // (25s from director stage 3).
    this.searchRemainingS = this.director.searchDuration;
    this.setState('SEARCH');
    this.clearGoal();
    this.pickSweepTarget();
  }

  private beginRetreat(reason: 'kill' | 'decoy', pullTo?: Vec3, pullModule?: ModuleId): void {
    this.retreatReason = reason;
    this.setState('RETREAT');
    this.fix = null;
    this.coalescer.reset();
    if (reason === 'decoy' && pullTo && pullModule) {
      this.setGoal(cloneV3(pullTo), pullModule);
      return;
    }
    const away = this.farthestModuleFromPlayers();
    this.setGoalModule(away);
  }

  // -- hiding (§4) ----------------------------------------------------------

  /**
   * Breach a hide spot it has heard somebody in — 1.2 m contact range, 2
   * seconds, loudness 55. Returns true when the tick was consumed.
   *
   * §4: "A heard hide spot is not a coffin." The two seconds are loud (55 is
   * `ALIEN_HUNT`, because §5 forbids it doing anything decisive in silence) and
   * they are a window: get out, loudly, into a room with the thing in it. If the
   * occupant takes it, the breach aborts and it hunts them in the open, which is
   * a worse position but a live one.
   *
   * A hidden player is therefore never invulnerable and never untouchable-by-
   * luck either — the ONLY thing that ever starts this is a noise that came out
   * of the box and cleared the attention threshold.
   */
  private tickBreach(dt: number, nowMs: number): boolean {
    const work = this.breachWork;
    if (work) {
      const volume = this.world.hides.volume(work.key);
      const occupants = this.occupantsOf(work.key);
      if (!volume || occupants.length === 0) {
        // Bailed out. It is already standing on the entry and already HUNTing;
        // the fix stays where the box is, so it turns and comes after them.
        this.breachWork = null;
        this.suspect = null;
        return false;
      }
      work.remainingS -= dt;
      if (work.remainingS > 0) return true;
      this.breachWork = null;
      this.suspect = null;
      for (const victim of occupants) this.kill(victim);
      return true;
    }

    if (this._state === 'DORMANT' || this._state === 'ATTACK' || this._state === 'RETREAT') {
      return false;
    }
    const volume = this.liveSuspect(nowMs);
    if (!volume) return false;
    if (volume.module !== this._module) return false;
    if (distance(this._pos, volume.centre) > HIDE_BREACH_RANGE_M + ALIEN_RADIUS) return false;

    // It has resolved the box. That is decisive, so it is loud and it hunts.
    this.setFix(cloneV3(volume.centre), volume.module, null, nowMs);
    this.setState('HUNT');
    this.clearGoal();
    this.emit('hide-breach', volume.centre, volume.module);
    this.breachWork = { key: volume.key, remainingS: HIDE_BREACH_TIME_S };
    return true;
  }

  /** Living bodies inside one hide spot. */
  private occupantsOf(key: HideSpotKey): AlienPlayerView[] {
    const out: AlienPlayerView[] = [];
    for (const p of this.world.players()) {
      if (p.alive && p.hideSpot === key) out.push(p);
    }
    return out;
  }

  // -- contact --------------------------------------------------------------

  /**
   * Metres from the alien's body to a player's, NOT to their camera.
   *
   * §4's pivot moved the ground out from under this check without touching it.
   * A player's transform `pos` is the EYE in both regimes; in a `zero` module
   * the body IS the eye (one swept sphere) and a plain distance was right. On a
   * deck the body hangs below: feet at `eye − eyeHeight`, head a `bodyHeight`
   * above that, while the alien's own capsule centre rides the deck around
   * `DECK_Y_M + ALIEN_RADIUS`.
   *
   * MEASURED before this existed, standing in `lab-atlas` with the thing
   * HUNTING on top of me: the closest it could physically get was **1.10 m**
   * against a `CONTACT_RANGE_M` of 0.80 — the vertical term alone exceeded the
   * range, so a STANDING player could not be touched at any horizontal
   * distance, at all, ever. It held that position for 23 s and then wandered
   * off. Pressing crouch dropped the eye to 0.85 above the feet and it killed
   * me **0.1 s later**. So the pivot had quietly inverted the risk dial §4 is
   * built on: the loud, fast, upright option was the invulnerable one, and the
   * quiet one was the only way to die on contact.
   *
   * The fix is the smallest honest one: clamp the alien's height onto the
   * player's own vertical span before measuring, so contact is a body-to-body
   * test in a gravity module and the untouched §4 sphere test in a zero-G one.
   * No sight logic, no new perception — the alien still only knows this because
   * it is touching them.
   */
  private contactDistance(p: AlienPlayerView): number {
    if (!this.world.graph.hasFloor(p.module)) return distance(p.pos, this._pos);
    const profile = gaitProfile(p.gait);
    // STATION_DOWN is the frozen global −Y (§4), which is why this is a plain
    // component and not a projection: there is exactly one down in the station.
    const feet = p.pos.y - profile.eyeHeight;
    const head = feet + profile.bodyHeight;
    _contactPoint.x = p.pos.x;
    _contactPoint.y = clamp(this._pos.y, feet, head);
    _contactPoint.z = p.pos.z;
    return distance(_contactPoint, this._pos);
  }

  /** Returns true if the tick was consumed by a kill. */
  private checkContact(nowMs: number): boolean {
    if (this._state === 'ATTACK') return false;
    let touched: AlienPlayerView | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const p of this.world.players()) {
      if (!p.alive) continue;
      // §4: the shell is geometry. You cannot be touched through a locker door,
      // and the alien's own body never sweeps through the box either (see
      // `blockedByHide`). The only way in is a breach, and the only way to earn
      // a breach is to make a noise it can hear.
      if (p.hideSpot !== null) continue;
      const d = this.contactDistance(p);
      if (d <= CONTACT_RANGE_M && d < best) {
        best = d;
        touched = p;
      }
    }
    if (!touched) return false;

    if (this._state === 'HUNT') {
      this.kill(touched);
      return true;
    }
    // Contact in any other state is perception, not a kill: it grabs for you.
    this.enterHunt(touched.pos, touched.module, touched.id, nowMs);
    return false;
  }

  private kill(player: AlienPlayerView): void {
    this.setState('ATTACK');
    this.clearGoal();
    this.fix = null;
    // A kill wipes the slate: RETREAT is supposed to take it away from the
    // scene, not straight on to the next thing it half-heard beforehand.
    this.retained = [];
    this.coalescer.reset();
    this.campMs = 0;
    this.campLimitMs = anticampMs(this.rng);
    this.roar();
    try {
      this.world.onKill(player.id, cloneV3(this._pos));
    } catch (err) {
      console.error('[alien] onKill threw:', err);
    }
  }

  // -- anti-camping ---------------------------------------------------------

  private updateAntiCamp(dt: number, nowMs: number): void {
    if (this._state === 'DORMANT' || this._state === 'RETREAT') {
      this.campMs = 0;
      return;
    }
    // Never evict it mid-breach: two seconds from the end of a locker is not the
    // moment for the anti-camping valve, and a hidden player who has been heard
    // has not been camping — they have been found.
    if (this.breachWork) return;
    let near = false;
    for (const p of this.world.players()) {
      if (!p.alive) continue;
      if (distance(p.pos, this._pos) <= ANTICAMP_RADIUS_M) {
        near = true;
        break;
      }
    }
    if (!near) {
      this.campMs = 0;
      return;
    }
    this.campMs += dt * 1000;
    if (this.campMs < this.campLimitMs) return;

    // Evicted. Fuzzed and undisclosed on purpose (§5): freezing is a gamble,
    // never a proof. The attention lock is what makes the eviction stick —
    // without it the camper's next rail pull drags it straight back.
    this.campMs = 0;
    this.campLimitMs = anticampMs(this.rng);
    this.attentionLockUntilMs = nowMs + ANTICAMP_LOCK_MS;
    this.coalescer.reset();
    this.fix = null;
    // The eviction has to be real (§5): a retained secondary back in the room
    // it was just thrown out of would undo it on arrival — and so would a hide
    // spot it was still suspicious of.
    this.retained = [];
    this.suspect = null;
    this.setState('PATROL');
    this.setGoalModule(this.farthestModuleFromPlayers());
  }

  // -- target selection -----------------------------------------------------

  /** §5 PATROL: A* over the module graph, with 2:1 crowd bias from stage 2. */
  private pickPatrolTarget(): void {
    const graph = this.world.graph;
    const reachable = [...graph.connectedComponent(this._module, { passable: PASSABLE_ALIEN })];
    const candidates = reachable.filter((id) => id !== this._module);
    if (candidates.length === 0) {
      this.clearGoal();
      return;
    }

    const weights = new Map<ModuleId, number>();
    for (const id of candidates) weights.set(id, 1);

    if (this.director.crowdBias) {
      // "Weight target selection 2:1 toward the module holding the largest
      // cluster of players" — the only place player positions influence
      // targeting, and it is a pacing tool, not perception (§5).
      const crowd = this.largestCluster();
      if (crowd && weights.has(crowd)) {
        weights.set(crowd, (weights.get(crowd) ?? 1) * CROWD_BIAS_WEIGHT);
      }
    }

    this.setGoalModule(weightedPick(weights, this.rng) ?? candidates[0]);
  }

  /** §5 SEARCH: sweep this module and its neighbours. */
  private pickSweepTarget(): void {
    const graph = this.world.graph;

    // A hide spot it has heard something in is the first thing it checks. This
    // is not a shortcut past §3's fairness jitter: the alien only got to this
    // module by the ordinary INVESTIGATE path, and a muffled occupant can only
    // have been heard from inside `HIDE_SAFE_RADIUS_M` in the first place.
    // Checking the locker once you are already in the room is what a predator
    // that hunts by ear does.
    const suspect = this.liveSuspect(this.nowMs);
    if (suspect && suspect.module === this._module) {
      this.setGoal(cloneV3(suspect.entry), suspect.module);
      return;
    }

    const pool: ModuleId[] = [this._module];
    for (const edge of graph.edges(this._module)) {
      if (!PASSABLE_ALIEN(edge)) continue;
      pool.push(edge.to);
    }
    // Bias toward staying in the module it is sweeping; neighbours are checked
    // often enough at one entry each.
    const weights = new Map<ModuleId, number>();
    for (const id of pool) weights.set(id, id === this._module ? 2 : 1);
    const target = weightedPick(weights, this.rng) ?? this._module;

    const rails = this.world.rails.inModule(target);
    if (rails.length > 0) {
      const node = rails[Math.floor(this.rng() * rails.length) % rails.length];
      const t = this.rng();
      this.setGoal(this.world.rails.pointAt(node.key, t), target);
      return;
    }
    const centre = graph.centre(target);
    this.setGoal(centre ? cloneV3(centre) : cloneV3(this._pos), target);
  }

  /** Module holding the largest cluster of living players. */
  private largestCluster(): ModuleId | null {
    const counts = new Map<ModuleId, number>();
    for (const p of this.world.players()) {
      if (!p.alive) continue;
      counts.set(p.module, (counts.get(p.module) ?? 0) + 1);
    }
    let best: ModuleId | null = null;
    let bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        best = id;
      }
    }
    return best;
  }

  /** Reachable module maximising hop distance from the living crew — where it
   *  goes after a kill, and where anti-camping sends it. */
  private farthestModuleFromPlayers(): ModuleId {
    const graph = this.world.graph;
    const reachable = [...graph.connectedComponent(this._module, { passable: PASSABLE_ALIEN })];
    const alive = this.world.players().filter((p) => p.alive);
    let best = this._module;
    let bestScore = -1;
    for (const id of reachable) {
      if (id === this._module) continue;
      let score = 0;
      if (alive.length === 0) {
        score = graph.hopDistance(this._module, id, { passable: PASSABLE_ALIEN });
      } else {
        let sum = 0;
        for (const p of alive) {
          const hops = graph.hopDistance(p.module, id, { passable: PASSABLE_ALIEN });
          sum += hops < 0 ? 0 : hops;
        }
        score = sum / alive.length;
      }
      // Tie-break with a little noise so it does not always pick the same corner.
      score += this.rng() * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  // -- goals and navigation -------------------------------------------------

  private setGoal(pos: Vec3, module: ModuleId): void {
    const target = this.world.graph.has(module) ? module : this._module;
    this.goalPos = this.snapGoal(pos, target);
    this.goalModule = target;
    this.modulePath = null;
    this.railPath = [];
    this.railPathGoal = null;
    this.repathTimerS = 0;
    this.stuckTimerS = 0;
  }

  private setGoalModule(module: ModuleId): void {
    const rails = this.world.rails.inModule(module);
    if (rails.length > 0) {
      const node = rails[Math.floor(this.rng() * rails.length) % rails.length];
      this.setGoal(cloneV3(node.mid), module);
      return;
    }
    const centre = this.world.graph.centre(module);
    this.setGoal(centre ? cloneV3(centre) : cloneV3(this._pos), module);
  }

  /**
   * The alien has no collision geometry — it rides rails and glides between
   * them — so a goal outside the hull would have it swimming through a
   * bulkhead. §5's INVESTIGATE point is `origin + randomInSphere(errorRadius)`
   * and that sphere reaches 12m, so this genuinely happens. A point that far
   * from every handrail in the module is pulled back onto the nearest one;
   * anything inside the tube is left exactly where the jitter put it, which is
   * what keeps the §3 fairness mechanic intact.
   */
  private snapGoal(pos: Vec3, module: ModuleId): Vec3 {
    if (this.world.graph.hasFloor(module)) {
      // A walking module's goals live on the deck. §5's INVESTIGATE point is
      // `origin + randomInSphere(errorRadius)` and that sphere reaches 12 m, so
      // a goal genuinely can land in the ceiling or outside the hull; the rails
      // are still the module's interior skeleton, so a point too far from every
      // one of them is pulled back onto the nearest, then dropped to the floor.
      const near = this.world.rails.nearestInModule(module, pos);
      const onFloor = near && near.distance > GOAL_SNAP_M ? cloneV3(near.point) : cloneV3(pos);
      onFloor.y = this.deckHeight(module);
      return onFloor;
    }
    const near = this.world.rails.nearestInModule(module, pos);
    if (near && near.distance > GOAL_SNAP_M) return cloneV3(near.point);
    return cloneV3(pos);
  }

  /** World height the alien's centre rides at while standing on a module's
   *  deck. One global down (§4), so this is a y offset and nothing else. */
  private deckHeight(module: ModuleId): number {
    const m = this.world.graph.get(module);
    return (m ? m.transform.pos.y : this._pos.y) + DECK_RIDE_HEIGHT_M;
  }

  /** True while the module underfoot has a floor — walk it rather than the
   *  rails (§4: rails are only movement in a `zero` module). */
  private onDeck(): boolean {
    return this.world.graph.hasFloor(this._module);
  }

  /**
   * Distance for "have I got there yet".
   *
   * On a deck it is the GROUND-PLANE distance, because ports and rails are
   * authored on the module axis and the alien is walking `DECK_RIDE_HEIGHT_M`
   * below them: a full 3-D test would leave it circling a hatch it is already
   * standing under, forever a fixed 0.3 m short of arriving. Floating, the
   * 3-D distance is the honest one.
   */
  private reachDistance(a: Vec3, b: Vec3): number {
    return this.onDeck() ? groundDistance(a, b) : distance(a, b);
  }

  private clearGoal(): void {
    this.goalPos = null;
    this.goalModule = null;
    this.modulePath = null;
    this.railPath = [];
    this.railPathGoal = null;
    this.stuckTimerS = 0;
  }

  /**
   * Move toward the current goal for one tick.
   *
   * 'busy' means it is cranking a hatch; 'blocked' means the goal is
   * unreachable and the caller should pick another.
   */
  private navigate(dt: number, speed: number): 'moving' | 'arrived' | 'blocked' | 'busy' {
    if (this.hatchWork) {
      this.tickHatch(dt);
      return 'busy';
    }
    if (!this.goalPos || !this.goalModule) return 'arrived';

    const waypoint = this.nextWaypoint();
    if (!waypoint) return 'blocked';

    // A closed hatch on the route: crank it open. It cannot open a sealed one —
    // `PASSABLE_ALIEN` keeps those out of the module path in the first place.
    if (waypoint.edge && !waypoint.edge.open) {
      if (waypoint.edge.sealed) return 'blocked';
      if (this.reachDistance(this._pos, waypoint.pos) <= HATCH_REACH_M) {
        this.beginHatch(waypoint.edge);
        return 'busy';
      }
    }

    const before = cloneV3(this._pos);
    this.walk(speed * dt, waypoint.pos, waypoint.edge);
    const moved = distance(before, this._pos);
    if (moved > EPS) this.faceAlong(sub(this._pos, before));

    // Crossing through an open hatch while gliding: the rail walk sets the
    // module itself when it steps onto a rail on the far side.
    if (waypoint.edge && waypoint.edge.open) {
      if (this.reachDistance(this._pos, waypoint.pos) <= ARRIVE_EPSILON_M) {
        this._module = waypoint.edge.to;
        this.modulePath = null;
        this.railPathGoal = null;
      }
    }

    if (moved < speed * dt * 0.05) {
      this.stuckTimerS += dt;
      if (this.stuckTimerS >= STUCK_TIMEOUT_S) {
        this.stuckTimerS = 0;
        return 'blocked';
      }
    } else {
      this.stuckTimerS = 0;
    }

    if (
      this._module === this.goalModule &&
      this.reachDistance(this._pos, this.goalPos) <= ARRIVE_EPSILON_M
    ) {
      return 'arrived';
    }
    return 'moving';
  }

  /** The next thing to move to: the goal itself, or the port on the way there. */
  private nextWaypoint(): { pos: Vec3; edge: ModuleEdge | null } | null {
    if (!this.goalPos || !this.goalModule) return null;
    if (this.goalModule === this._module) return { pos: this.goalPos, edge: null };

    const graph = this.world.graph;
    const stale =
      this.modulePath === null ||
      this.modulePath.length < 2 ||
      this.modulePath[0] !== this._module ||
      this.modulePath[this.modulePath.length - 1] !== this.goalModule ||
      this.repathTimerS <= 0;

    if (stale) {
      // §5: A* over the module graph. Sealed hatches are impassable edges.
      this.modulePath = graph.findPath(this._module, this.goalModule, {
        passable: PASSABLE_ALIEN,
      });
      this.repathTimerS = REPATH_INTERVAL_S;
      this.railPathGoal = null;
    }
    if (!this.modulePath || this.modulePath.length < 2) return null;

    const next = this.modulePath[1];
    const edge = this.bestEdgeTo(next);
    if (!edge) {
      this.modulePath = null;
      return null;
    }
    return { pos: cloneV3(edge.worldPos), edge };
  }

  /**
   * The hatch to use for the next hop. Two modules can be joined by more than
   * one port; prefer an open one, then the nearest, and never a sealed one —
   * it cannot open those (§5), and the module A* already routed around them.
   */
  private bestEdgeTo(to: ModuleId): ModuleEdge | null {
    let best: ModuleEdge | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const edge of this.world.graph.edges(this._module)) {
      if (edge.to !== to || edge.sealed) continue;
      const score = (edge.open ? 100 : 0) - distance(this._pos, edge.worldPos);
      if (score > bestScore) {
        bestScore = score;
        best = edge;
      }
    }
    return best;
  }

  /** The module the current route wants next, or null if we are in the goal. */
  private plannedNextModule(): ModuleId | null {
    if (!this.modulePath || this.modulePath.length < 2) return null;
    if (this.modulePath[0] !== this._module) return null;
    return this.modulePath[1];
  }

  // -- locomotion: rails first, glide as a fallback -------------------------

  /**
   * Spend `budget` metres moving toward `target`.
   *
   * Rails are the primary mode — "it moves the way the player does" (§5). When
   * the rails run out it lets go and glides, and when a rail is worth grabbing
   * it glides to that first.
   */
  private walk(budget: number, target: Vec3, edge: ModuleEdge | null): void {
    if (budget <= EPS) return;

    // THE PIVOT, on the alien's side. A module with a floor is walked; a module
    // without one is climbed. §2 is explicit that the alien queries the rail
    // graph at scope `any` and rail-follows inside EVERY module — that is what
    // keeps its pathfinding working across the whole station — but "it moves the
    // way the player does" (§5) now means feet on the deck wherever the player
    // has one, and hauling itself hand over hand along an overhead rail through
    // a room with a floor reads as a bug rather than as a predator.
    //
    // Module A* above this is untouched and still runs on `PASSABLE_ALIEN`, so
    // sealed hatches remain impassable and closed ones still cost it 3 s and 45
    // loudness, in both regimes.
    if (this.onDeck()) {
      if (this.railKey) this.releaseRail();
      this.walkDeck(budget, target);
      return;
    }

    if (this.railKey) {
      budget = this.walkRails(budget, target, edge);
      if (budget <= EPS) return;
      // Already through the hatch the waypoint was aiming at: keep the grip and
      // let the next tick re-plan from the far side, rather than letting go to
      // drift the last half-metre back to the port's centreline.
      if (edge && this._module === edge.to) return;
      if (distance(this._pos, target) <= ARRIVE_EPSILON_M) return;
      this.releaseRail();
    }

    const seek = this.railCooldownS > 0 ? null : this.seekRail(target);
    const via = seek ? seek.point : target;
    budget = this.glide(budget, via);

    if (seek && distance(this._pos, seek.point) <= RAIL_ATTACH_M) {
      this.grabRail(seek);
      if (budget > EPS) this.walkRails(budget, target, edge);
    }
  }

  /**
   * Walk the deck of a module that has one.
   *
   * The whole budget is spent in the ground plane — §4's single global
   * `STATION_DOWN` is what makes that one line rather than a per-module frame —
   * and the height is eased onto the deck separately, so a body that just
   * `settle`d in from a floorless module walks down onto the floor instead of
   * snapping to it.
   *
   * Hide volumes are solid here (`stepBlocked`), so it routes around a locker
   * rather than through one. That is the entire physical half of §4's hiding
   * mechanic: "a box the alien can walk through is not a hide spot, it is a
   * decoration."
   */
  private walkDeck(budget: number, target: Vec3): void {
    const deck = this.deckHeight(this._module);
    const to = { x: target.x - this._pos.x, y: 0, z: target.z - this._pos.z };
    const flat = Math.hypot(to.x, to.z);

    if (flat > EPS) {
      const step = Math.min(budget, flat);
      const desired = {
        x: this._pos.x + (to.x / flat) * step,
        y: this._pos.y,
        z: this._pos.z + (to.z / flat) * step,
      };
      this._pos = this.stepAvoidingHides(desired, step);
    }

    // Ease onto the floor rather than snapping: k is a per-second half-life, so
    // it is frame-rate independent at any tick length the room might run at.
    const k = 1 - Math.exp(-DECK_SETTLE_RATE * this.lastDt);
    this._pos.y += (deck - this._pos.y) * k;
    if (Math.abs(this._pos.y - deck) < 0.01) this._pos.y = deck;
  }

  /**
   * Take one step, or route around the occupied hide volume in the way.
   *
   * Deliberately not pathfinding: three lateral offsets either side of the
   * travel direction, tried nearest-first, then a pure sidestep with no forward
   * component (which is what gets it out of a corner it has already walked
   * into). If none clear, it holds position and `navigate()`'s existing stuck
   * timer re-plans the goal after `STUCK_TIMEOUT_S`. A hide box is under a metre
   * across in a five-metre module; anything cleverer would be navmesh work for
   * one piece of furniture.
   */
  private stepAvoidingHides(desired: Vec3, step: number): Vec3 {
    if (!this.stepBlocked(this._pos, desired)) return desired;

    const dx = desired.x - this._pos.x;
    const dz = desired.z - this._pos.z;
    const len = Math.hypot(dx, dz);
    if (len < EPS) return cloneV3(this._pos);
    const fx = dx / len;
    const fz = dz / len;
    // Perpendicular in the ground plane.
    const px = -fz;
    const pz = fx;
    const unit = Math.max(step, HIDE_CLEARANCE_M);

    for (const forward of [0.5, 0]) {
      for (const reach of [1, 2, 4]) {
        for (const sign of [1, -1]) {
          const slide = unit * reach;
          const candidate = {
            x: this._pos.x + fx * step * forward + px * sign * slide,
            y: desired.y,
            z: this._pos.z + fz * step * forward + pz * sign * slide,
          };
          if (!this.stepBlocked(this._pos, candidate)) return candidate;
        }
      }
    }
    // Boxed in. Hold position; the stuck timer re-plans.
    return cloneV3(this._pos);
  }

  /**
   * Would moving from `a` to `b` sweep the alien's body through a hide volume
   * that somebody is INSIDE?
   *
   * Occupancy is the whole test, and that is a deliberate narrowing. §4 asks for
   * one guarantee — "the hide volume is geometry the alien's body has to route
   * around" — and the reason it asks is the body in it. The alien otherwise has
   * no collision geometry at all: it rides rails and glides, and passes through
   * racks, bulkheads and consoles without noticing (see `snapGoal`). Making
   * every empty locker solid would give it exactly one piece of world collision,
   * arbitrarily, and the cost is not theoretical: measured against the shipped
   * nine-module level, whose node pieces put an equipment bay on the hub where
   * all six handrails meet, always-solid volumes cut the alien's distance
   * travelled by 20% in the walking configuration and pinned it in place
   * outright — 0 m in 180 s — with the whole station floorless.
   *
   * An occupied box, by contrast, is rare, temporary, and exactly the thing that
   * is supposed to make it detour.
   */
  private stepBlocked(a: Vec3, b: Vec3): boolean {
    if (this.world.hides.size === 0) return false;
    const occupied = this.occupiedHideSpots();
    if (occupied.size === 0) return false;
    return (
      this.world.hides.sweepBlocked(this._module, a, b, HIDE_CLEARANCE_M, (v) =>
        occupied.has(v.key),
      ) !== null
    );
  }

  /** A handrail worth detouring to, or null if gliding straight is better. */
  private seekRail(target: Vec3): RailQuery | null {
    const q = this.world.rails.nearestInModule(this._module, this._pos, RAIL_SEEK_M);
    if (!q) return null;
    // Not worth grabbing if we are practically on top of the target already.
    if (distance(this._pos, target) <= q.distance + ARRIVE_EPSILON_M) return null;
    return q;
  }

  private grabRail(q: RailQuery): void {
    this.railKey = q.key;
    this.railT = q.t;
    this._pos = cloneV3(q.point);
    this.railPath = [];
    this.railIndex = 0;
    this.railPathGoal = null;
    this._module = q.node.module;
  }

  private releaseRail(): void {
    this.railKey = null;
    this.railPath = [];
    this.railPathGoal = null;
    this.railIndex = 0;
    this.railCooldownS = RAIL_RELEASE_COOLDOWN_S;
  }

  /**
   * Follow the rail graph toward `target`, returning the unspent budget.
   *
   * Rail segments join through hatches (§2 `portLink`), and the rail graph does
   * not know about hatch state — so every cross-module step is checked against
   * the module route and the live hatch before it is taken. That check is what
   * stops it walking through a sealed hatch.
   */
  private walkRails(budget: number, target: Vec3, edge: ModuleEdge | null): number {
    const rails = this.world.rails;
    if (!this.railKey) return budget;
    this.ensureRailPath(target, edge);

    for (let guard = 0; guard < 64 && budget > EPS; guard++) {
      const node = rails.node(this.railKey);
      if (!node) {
        this.releaseRail();
        return budget;
      }
      const nextKey =
        this.railIndex + 1 < this.railPath.length ? this.railPath[this.railIndex + 1] : null;

      let targetT: number;
      if (nextKey) {
        const next = rails.node(nextKey);
        if (!next) {
          this.railPath = [this.railKey];
          this.railIndex = 0;
          continue;
        }
        targetT = endpointToward(node.a, node.b, next.a, next.b);
      } else {
        targetT = clamp(rails.project(node.key, target).t, 0, 1);
      }

      const deltaT = targetT - this.railT;
      const metres = Math.abs(deltaT) * node.length;

      if (metres > budget) {
        const step = node.length > EPS ? (Math.sign(deltaT) * budget) / node.length : 0;
        const at = clamp(this.railT + step, 0, 1);
        const to = rails.pointAt(node.key, at);
        // §4: an OCCUPIED hide volume is solid on the rail path as much as on
        // the swept one. Let go rather than pulling itself through a locker
        // somebody is in; the glide path routes around it, and the stuck timer
        // re-plans if the rail was the only way through. The loader warns about
        // a spot authored across a rail (`railsThroughHideSpots`) precisely so
        // this stays a detour rather than a surprise.
        if (this.stepBlocked(this._pos, to)) {
          this.releaseRail();
          return budget;
        }
        this.railT = at;
        this._pos = to;
        return 0;
      }

      const junctionPoint = rails.pointAt(node.key, targetT);
      if (this.stepBlocked(this._pos, junctionPoint)) {
        this.releaseRail();
        return budget;
      }
      budget -= metres;
      this.railT = targetT;
      this._pos = junctionPoint;

      if (!nextKey) return budget;

      const next = rails.require(nextKey);
      if (next.module !== node.module) {
        // Only cross where the module route says to, and only through a hatch
        // that is actually open. If it is merely closed we stop here — we are
        // standing at the port, so `navigate()` will start cranking it.
        const allowed = this.plannedNextModule() === next.module;
        const crossing = this.world.graph.edgeBetween(node.module, next.module);
        if (!allowed || !crossing || !crossing.open) return budget;
      }

      this.railKey = next.key;
      this.railT =
        distance(next.a, junctionPoint) <= distance(next.b, junctionPoint) ? 0 : 1;
      this.railIndex++;
      this._module = next.module;
      this._pos = rails.pointAt(next.key, this.railT);
    }
    return budget;
  }

  /** Plan (or reuse) the chain of rail segments leading toward `target`. */
  private ensureRailPath(target: Vec3, edge: ModuleEdge | null): void {
    const rails = this.world.rails;
    if (!this.railKey) {
      this.railPath = [];
      this.railIndex = 0;
      return;
    }
    // Heading for a hatch: aim at the rail on the FAR side so the chain runs
    // through the port and the alien keeps its grip across the bulkhead.
    const goalModule = edge ? edge.to : this._module;
    const goal =
      rails.nearestInModule(goalModule, target) ?? rails.nearestInModule(this._module, target);
    const goalKey = goal ? goal.key : this.railKey;

    if (
      this.railPathGoal === goalKey &&
      this.railPath.length > 0 &&
      this.railPath[this.railIndex] === this.railKey
    ) {
      return;
    }
    const path = rails.path(this.railKey, goalKey);
    this.railPath = path && path.length > 0 ? path : [this.railKey];
    this.railIndex = 0;
    this.railPathGoal = goalKey;
  }

  /**
   * Free-float straight toward a point. Returns the unspent budget.
   *
   * Hide volumes are solid on this path too: a stowage net you float into is a
   * legal `usableIn: 'zero'` spot (§4), so the floorless half of the station
   * needs the same guarantee the walking half gets.
   */
  private glide(budget: number, target: Vec3): number {
    const to = sub(target, this._pos);
    const d = length(to);
    if (d < EPS) return budget;
    const step = Math.min(budget, d);
    const desired = add(this._pos, scale(to, step / d));
    const next = this.stepAvoidingHides(desired, step);
    const moved = distance(this._pos, next);
    this._pos = next;
    return Math.max(0, budget - moved);
  }

  private faceAlong(delta: Vec3): void {
    if (lengthSq(delta) < 1e-9) return;
    this._quat = quatFromForward(delta);
  }

  // -- hatches (§5) ---------------------------------------------------------

  /** Start cranking a closed hatch: 3 seconds, loudness 45, announced. */
  private beginHatch(edge: ModuleEdge): void {
    if (edge.sealed) return;
    this.hatchWork = {
      module: edge.from,
      port: edge.fromPort.id,
      remainingS: HATCH_OPEN_TIME,
    };
    // It announces itself the moment it starts, so you hear it coming for the
    // whole three seconds (§5 — that is the point of the number).
    this.emit('hatch-cycle', edge.worldPos, edge.from);
  }

  private tickHatch(dt: number): void {
    const work = this.hatchWork;
    if (!work) return;
    work.remainingS -= dt;
    if (work.remainingS > 0) return;
    this.hatchWork = null;
    this.openHatch(work.module, work.port);
    this.modulePath = null;
    this.railPathGoal = null;
  }

  private openHatch(moduleId: ModuleId, portId: PortId): void {
    const graph = this.world.graph;
    const port = graph.port(moduleId, portId);
    if (!port || port.hatch.sealed) return;
    port.hatch.open = true;
    syncHatchAttenuation(port);
    const link = port.link;
    let other: { module: ModuleId; port: PortId } | null = null;
    if (link) {
      const far = graph.port(link.module, link.port);
      if (far && !far.hatch.sealed) {
        far.hatch.open = true;
        syncHatchAttenuation(far);
        other = { module: link.module, port: link.port };
      }
    }
    // The graph caches hatch state on its edges — propagation and pathfinding
    // both read stale doors without this.
    graph.refreshHatches();
    this.world.onHatchChanged?.(moduleId, portId, true, false);
    if (other) this.world.onHatchChanged?.(other.module, other.port, true, false);
  }

  // -- noise emission -------------------------------------------------------

  /** The HUNT roar (§5 — "it makes loud noise while hunting"). */
  private roar(): void {
    this.emit('alien', this._pos, this._module);
  }

  private emit(kind: NoiseEvent['kind'], origin: Vec3, module: ModuleId): void {
    const event: NoiseEvent = {
      kind,
      origin: cloneV3(origin),
      module,
      loudness: noiseLoudness(kind),
      t: this._tick,
      actor: ALIEN_ACTOR_ID,
    };
    try {
      this.world.emitNoise(event);
    } catch (err) {
      console.error('[alien] emitNoise threw:', err);
    }
  }

  // -- attention ------------------------------------------------------------

  /**
   * Arrival level the alien bothers to react to right now (§3): PATROL 12
   * (sharpened by the director), INVESTIGATE / SEARCH 4, HUNT anything.
   *
   * INCLUSIVE, and deliberately so: §3's table is headed "Reacts to arrivals
   * **≥**", unlike §5's HUNT trigger, which is "**above** 50". Callers compare
   * with `level < currentAttention()`; see `triggersHunt` for the other rule.
   *
   * Both numbers come from the director rather than from §3 directly, because
   * both are crew-scaled: §3's thresholds are a filter for six people's noise,
   * and applied unchanged to a solo player they filter nothing — every arrival
   * over the line is unambiguous and points at the only body on the station.
   * `ATTN_SEARCH` = 4 is the sharp end of that: with a crew it makes a sweep
   * lethal for a moment, but solo it latches, because every re-fix comes from
   * the one person it is sweeping for and nothing else can ever pull it away.
   * At CREW_FULL both are exactly §3's values again.
   */
  private currentAttention(): number {
    const hunt = this.director.huntTrigger;
    let threshold: number;
    switch (this._state) {
      case 'INVESTIGATE':
      case 'SEARCH':
        threshold = this.director.searchThreshold;
        break;
      case 'HUNT':
      case 'ATTACK':
        threshold = ATTN_HUNT;
        break;
      // DORMANT is the round-start grace (§10), not a lull in the round: while
      // it is asleep only something already loud enough to HUNT gets it up. That
      // is what makes the grace a grace and not a coin flip — and it is still
      // not an invulnerability window, because a full-speed crash (51), a pry
      // bar (60), an extinguisher (65) or a decoy (70) all clear the trigger,
      // and `checkContact` ignores the threshold entirely.
      case 'DORMANT':
        threshold = hunt;
        break;
      default:
        threshold = this.director.patrolThreshold;
        break;
    }
    // Two overrides, both §5 behaviours rather than new numbers: while RETREATing
    // — and for a few seconds after an anti-camp eviction — only something as
    // loud as a hunt trigger can turn it around. Without them a retreat is undone
    // by the first rail pull and the anti-camp valve does nothing.
    if (this._state === 'RETREAT') threshold = Math.max(threshold, hunt);
    if (this.nowMs < this.attentionLockUntilMs) threshold = Math.max(threshold, hunt);
    return threshold;
  }
}

// ===========================================================================
// helpers
// ===========================================================================

/**
 * The §5 HUNT boundary, in one place for every alien implementation.
 *
 * §5 is precise and it is not the same rule as §3's: HUNT is "triggered by an
 * arrival **above** 50 within 10m (above **35** at director stage 4)" —
 * strictly above — whereas §3's attention table reacts to arrivals "**≥**" its
 * threshold. Both boundaries are deliberate and they are one point apart, so
 * they are written down rather than inlined as a `>=` somebody will 'fix'.
 */
export function triggersHunt(level: number, trigger: number): boolean {
  return level > trigger;
}

/** Which end of segment (a,b) faces segment (na,nb): t = 0 for `a`, 1 for `b`. */
function endpointToward(a: Vec3, b: Vec3, na: Vec3, nb: Vec3): number {
  const fromA = Math.min(distance(a, na), distance(a, nb));
  const fromB = Math.min(distance(b, na), distance(b, nb));
  return fromA <= fromB ? 0 : 1;
}

/** Pick a key with probability proportional to its weight. */
function weightedPick<T>(weights: Map<T, number>, rng: () => number): T | null {
  let total = 0;
  for (const w of weights.values()) total += Math.max(0, w);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const [key, w] of weights) {
    roll -= Math.max(0, w);
    if (roll <= 0) return key;
  }
  // Floating-point tail: return the last key.
  let last: T | null = null;
  for (const key of weights.keys()) last = key;
  return last;
}

/**
 * Shortest-arc rotation taking the default forward axis (0, 0, -1) — three.js's
 * convention, which the client capsule inherits — onto `dir`.
 */
export function quatFromForward(dir: Vec3): Quat {
  const len = length(dir);
  if (len < 1e-9) return quat();
  const f = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
  const from = { x: 0, y: 0, z: -1 };
  const d = dot(from, f);
  if (d > 0.999999) return quat(0, 0, 0, 1);
  if (d < -0.999999) return quat(0, 1, 0, 0); // 180° about +Y
  const axis = cross(from, f);
  const w = 1 + d;
  const norm = Math.sqrt(axis.x * axis.x + axis.y * axis.y + axis.z * axis.z + w * w);
  return quat(axis.x / norm, axis.y / norm, axis.z / norm, w / norm);
}

/**
 * §10: "The alien spawns randomly too, at least three hops from the majority of
 * players." Returns null only for an empty graph.
 *
 * Modules where a majority of players are at least `minHops` away are preferred;
 * failing that it returns whichever module maximises the mean hop distance, so
 * a small station still gets a sane answer.
 */
export function chooseAlienSpawn(
  graph: ModuleGraph,
  playerModules: readonly ModuleId[],
  rng: () => number = Math.random,
  minHops: number = ALIEN_SPAWN_MIN_HOPS,
  exclude: readonly ModuleId[] = [],
): ModuleId | null {
  const banned = new Set(exclude);
  const ids = graph.ids().filter((id) => !banned.has(id));
  if (ids.length === 0) return null;
  if (playerModules.length === 0) {
    return ids[Math.floor(rng() * ids.length) % ids.length];
  }

  const scored = ids.map((id) => {
    let far = 0;
    let sum = 0;
    for (const pm of playerModules) {
      const hops = graph.hopDistance(pm, id, { passable: PASSABLE_ALIEN });
      const h = hops < 0 ? Number.MAX_SAFE_INTEGER : hops;
      if (h >= minHops) far++;
      sum += Math.min(h, 64);
    }
    return { id, far, mean: sum / playerModules.length };
  });

  const majority = Math.floor(playerModules.length / 2) + 1;
  const good = scored.filter((s) => s.far >= majority);
  const pool = good.length > 0 ? good : scored;
  let bestMean = -1;
  for (const s of pool) if (s.mean > bestMean) bestMean = s.mean;
  const best = good.length > 0 ? pool : pool.filter((s) => s.mean >= bestMean - 0.001);
  return best[Math.floor(rng() * best.length) % best.length].id;
}
