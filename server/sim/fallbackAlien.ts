/**
 * A working alien (DESIGN.md §5) — the fallback the room uses until
 * `server/sim/alien.ts` lands.
 *
 *   DORMANT → PATROL → INVESTIGATE → SEARCH → HUNT → ATTACK
 *                          ↑____________|        |
 *                          └── RETREAT ←─────────┘
 *
 * Perception is sound and contact only; there is no vision cone, ever. The room
 * feeds it arrivals that already passed the state's attention threshold (§3) and
 * coalesced decisions whose target point is already jittered by `errorRadius`
 * (§3's fairness mechanic).
 *
 * It navigates with A* over the module graph and moves in straight lines between
 * module centres and ports — §5 is explicit that "through M4–M7 the alien is a
 * capsule", and rail-following with IK is the real `sim/alien.ts`'s job. Speeds,
 * thresholds, SEARCH duration and the HUNT trigger all come from the §5
 * escalation table via `directorConfig(stage)`.
 */

import {
  ANTICAMP_RADIUS_M,
  DECK_Y_M,
  HATCH_OPEN_TIME,
  HIDE_BREACH_RANGE_M,
  HIDE_BREACH_TIME_S,
  HUNT_TRIGGER_RANGE_M,
  SPEED_HUNT,
  SPEED_SEARCH,
  anticampMs,
  crewScaledStage,
  roundGraceSeconds,
} from '@shared/constants';
import type { AlienState, HideSpotKey, ModuleId, PlayerId, Quat, Vec3 } from '@shared/types';
import { add, distance, normalize, scale, sub } from '@shared/graph/math';
import { PASSABLE_ALIEN } from '@shared/graph/moduleGraph';
import type { CoalescerDecision } from '@shared/graph/noise';
import { ALIEN_ACTOR_ID, triggersHunt } from './alien';
import { livingPlayerCount } from './contracts';
import type { AlienHearing, AlienSim, PlayerView, SimContext } from './contracts';

/** Metres: close enough to a waypoint to count as arrived. */
const WAYPOINT_EPS = 0.6;
/** Metres: close enough to a hatch to start cycling it. */
const HATCH_REACH = 1.2;
/** Metres: contact. "Perception is sound + contact only" (§5). */
const CONTACT_RANGE = 1.0;
/**
 * Metres: clearance the body keeps from a hide volume when routing around one.
 * Matches `HIDE_CLEARANCE_M` in `alien.ts` and the margin `layout.ts` warns
 * with — see the reasoning there. Small on purpose: the slab test already
 * squares off the sweep's corners, and a full body radius fences off a node.
 */
const BODY_RADIUS = 0.15;
/** Metres: how far below the module axis this alien walks when the module has a
 *  floor. One global down (§4), so it is a y offset and nothing more. */
const DECK_RIDE = DECK_Y_M + BODY_RADIUS;
/** ms a hide spot stays suspect after a noise came out of it (§4). */
const HIDE_SUSPECT_MS = 15_000;
/** Seconds between the noises it makes while hunting — a silent charge is
 *  unfair and reads as a bug (§5). */
const HUNT_NOISE_INTERVAL = 1.2;
/** Seconds it stays away after a kill or a decoy. */
const RETREAT_TIME = 12;

export class FallbackAlien implements AlienSim {
  private _pos: Vec3 = { x: 0, y: 0, z: 0 };
  private _quat: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private _state: AlienState = 'DORMANT';
  private _module: ModuleId = '';

  /** Remaining module chain, `[current, …, goal]`. */
  private path: ModuleId[] = [];
  private targetPoint: Vec3 | null = null;
  private targetModule: ModuleId | null = null;
  private chasing: PlayerId | null = null;
  /** s of §10 round-start grace left; set by `wake()`. */
  private graceRemainingS = 0;
  private woken = false;

  private searchTimer = 0;
  private retreatTimer = 0;
  private attackTimer = 0;
  private huntNoiseTimer = 0;
  private hatchTimer = 0;
  private hatchTarget: { module: ModuleId; port: string } | null = null;
  private repathTimer = 0;

  private anticampMsRemaining = anticampMs();
  private anticampAccrued = 0;

  /** §4: a hide spot it has HEARD somebody in. Never a sighting — the only way
   *  a box is ever resolved is a noise arriving from inside it. */
  private suspectHide: { key: HideSpotKey; module: ModuleId; atMs: number } | null = null;
  private breachRemaining = 0;
  private breachKey: HideSpotKey | null = null;

  get pos(): Vec3 {
    return this._pos;
  }
  get quat(): Quat {
    return this._quat;
  }
  get state(): AlienState {
    return this._state;
  }
  get module(): ModuleId {
    return this._module;
  }

  spawn(module: ModuleId, pos: Vec3, ctx: SimContext): void {
    this._module = module;
    this._pos = { ...pos };
    this._state = 'DORMANT';
    this.path = [];
    this.targetPoint = null;
    this.targetModule = null;
    this.chasing = null;
    this.searchTimer = 0;
    this.retreatTimer = 0;
    this.attackTimer = 0;
    this.hatchTimer = 0;
    this.hatchTarget = null;
    this.anticampMsRemaining = anticampMs(ctx.rng);
    this.anticampAccrued = 0;
    this.suspectHide = null;
    this.breachRemaining = 0;
    this.breachKey = null;
  }

  /**
   * The round has begun. Start the crew-scaled round-start grace (§10's reunion
   * phase), matching `Alien.wake()` so the two aliens behave the same way at the
   * same moment: DORMANT and motionless for `roundGraceSeconds(livingPlayers)`,
   * 75 s solo and 25 s at a full crew. Idempotent.
   */
  wake(ctx: SimContext): void {
    if (this._state !== 'DORMANT' || this.woken) return;
    this.woken = true;
    this.graceRemainingS = roundGraceSeconds(livingPlayerCount(ctx));
  }

  reset(): void {
    this._state = 'DORMANT';
    this.path = [];
    this.targetPoint = null;
    this.targetModule = null;
    this.chasing = null;
    this.woken = false;
    this.graceRemainingS = 0;
    this.suspectHide = null;
    this.breachRemaining = 0;
    this.breachKey = null;
  }

  // -------------------------------------------------------------------------

  update(dt: number, ctx: SimContext): void {
    if (this._module === '') return;
    const cfg = crewScaledStage(ctx.stage, livingPlayerCount(ctx));

    // §4: prying a hide spot open takes 2 s at loudness 55, and it does nothing
    // else while it does — those two seconds are the occupant's window to bail
    // out into a room with the thing in it.
    if (this.tickBreach(dt, ctx)) return;

    // Cycling a hatch: 3 seconds, and it announces itself at loudness 45 (§5).
    if (this.hatchTarget) {
      this.hatchTimer -= dt;
      if (this.hatchTimer <= 0) {
        ctx.setHatch(this.hatchTarget.module, this.hatchTarget.port, true, false);
        // Tagged as the alien's own so it never investigates the door it just
        // opened — a 45 at stage 4's trigger of 35 would have it hunting itself.
        ctx.emitNoise('hatch-cycle', this._pos, this._module, { actor: ALIEN_ACTOR_ID });
        this.hatchTarget = null;
      }
      return;
    }

    switch (this._state) {
      case 'DORMANT':
        // The round-start grace: motionless until it runs out (§10). A sim that
        // was never woken has graceRemainingS = 0 and patrols immediately, which
        // is this fallback's original behaviour.
        this.graceRemainingS -= dt;
        if (this.graceRemainingS > 0) return;
        this.enter('PATROL', ctx);
        break;
      case 'ATTACK':
        this.attackTimer -= dt;
        if (this.attackTimer <= 0) this.enterRetreat(ctx);
        return;
      case 'RETREAT':
        this.retreatTimer -= dt;
        if (this.retreatTimer <= 0) this.enter('PATROL', ctx);
        break;
      case 'SEARCH':
        this.searchTimer -= dt;
        if (this.searchTimer <= 0) this.enter('PATROL', ctx);
        break;
      default:
        break;
    }

    if (this._state === 'HUNT') this.updateHunt(dt, ctx);

    // Give up on a stale target and pick a new one.
    this.repathTimer -= dt;
    if (this.targetPoint === null || (this.repathTimer <= 0 && this._state === 'PATROL')) {
      this.repathTimer = 6;
      this.pickPatrolTarget(ctx);
    }

    // Through a helper on purpose: the switch above narrowed `this._state`, and
    // the calls in between are free to have changed it again.
    const speed = speedFor(this._state, cfg.patrolSpeed);

    this.step(dt, speed, ctx);
    this.startBreach(ctx);
    this.contactCheck(ctx);
    this.antiCamp(dt, ctx);
  }

  // -- perception -----------------------------------------------------------

  hear(input: AlienHearing, ctx: SimContext): void {
    if (this._state === 'ATTACK') return;
    // It never hears itself: §5 makes it loud so the PLAYERS can hear it, and
    // its own hatch cycle at 45 would otherwise out-trigger a real player at
    // stage 4. `NoiseRouter` already drops kind 'alien'; this catches the rest.
    if (input.event.actor === ALIEN_ACTOR_ID) return;

    const cfg = crewScaledStage(ctx.stage, livingPlayerCount(ctx));
    this.noteHideSuspect(input.event.origin, input.event.module, ctx);

    // §5: HUNT is triggered by an arrival ABOVE the stage's trigger within 10 m.
    if (triggersHunt(input.level, cfg.huntTrigger) && input.distance <= HUNT_TRIGGER_RANGE_M) {
      this.chasing = input.event.actor ?? null;
      this.setTarget(input.event.module, input.event.origin, ctx);
      this.enter('HUNT', ctx);
      return;
    }

    // §3: HUNT "reacts to anything", so every audible arrival re-fixes it while
    // it is already chasing. This is the ONLY thing that keeps a chase alive
    // between hunt-level noises — the room's coalesced `investigate()` refuses
    // to touch a HUNT, and re-fixing on a true position instead would be a
    // vision cone with extra steps (§5: sound and contact only).
    if (this._state === 'HUNT') {
      if (input.event.actor) this.chasing = input.event.actor;
      this.setTarget(input.event.module, input.event.origin, ctx);
      return;
    }

    // Leaving DORMANT on any audible arrival is what the round-start grace is
    // for: hold it. `Alien` (the shipping sim) pins its attention at the HUNT
    // trigger while the grace runs, and the hunt branch ABOVE fires first here
    // for exactly that reason — a crash, a pry bar, an extinguisher or a decoy
    // still starts the round early. A breath at 6, though, must not, and one
    // arrives within a tick of every round start, which is why the fallback's
    // grace was over before anybody could see it.
    if (this._state === 'DORMANT') {
      if (this.graceRemainingS > 0) return;
      this.enter('PATROL', ctx);
    }
  }

  investigate(decision: CoalescerDecision, point: Vec3, ctx: SimContext): void {
    if (this._state === 'HUNT' || this._state === 'ATTACK' || this._state === 'RETREAT') return;
    this.setTarget(decision.module, point, ctx);
    this.enter('INVESTIGATE', ctx);
  }

  // -- movement -------------------------------------------------------------

  private step(dt: number, speed: number, ctx: SimContext): void {
    const waypoint = this.nextWaypoint(ctx);
    if (!waypoint) return;

    // §4's pivot: a module with a floor is WALKED. The waypoint is authored on
    // the module axis (ports and centres are), so aim at it in the ground plane
    // and ride the deck instead of floating up to meet it.
    const onDeck = ctx.graph.hasFloor(this._module);
    const aim = onDeck ? { ...waypoint.point, y: this.deckHeight(ctx) } : waypoint.point;

    const delta = sub(aim, this._pos);
    const dist = Math.hypot(delta.x, delta.y, delta.z);
    if (dist > 1e-4) {
      this.face(delta);
      const stepLength = Math.min(speed * dt, dist);
      const desired = add(this._pos, scale(normalize(delta), stepLength));
      // §4: a hide volume is geometry the alien's body has to route around.
      this._pos = this.avoidHides(desired, stepLength, ctx);
    }

    // Arrival is judged in the ground plane on a deck, for the same reason the
    // aim is: standing under a hatch is standing at it.
    const reach = onDeck
      ? Math.hypot(waypoint.point.x - this._pos.x, waypoint.point.z - this._pos.z)
      : distance(waypoint.point, this._pos);
    if (reach > WAYPOINT_EPS) return;

    if (waypoint.kind === 'port') {
      // Arrived at a hatch. Open it if it is merely closed (§5), repath if sealed.
      const edge = ctx.graph.edgeBetween(this._module, waypoint.into);
      if (!edge) {
        this.path = [];
        this.targetPoint = null;
        return;
      }
      if (edge.sealed) {
        // It cannot open a sealed hatch. Find another way around, or give up.
        this.repath(ctx);
        return;
      }
      if (!edge.open) {
        if (reach <= HATCH_REACH) {
          this.hatchTarget = { module: edge.from, port: edge.fromPort.id };
          this.hatchTimer = HATCH_OPEN_TIME;
        }
        return;
      }
      this._module = waypoint.into;
      this.path.shift();
      return;
    }

    // Arrived at the destination.
    this.targetPoint = null;
    this.path = [];
    if (this._state === 'INVESTIGATE') {
      this.enter('SEARCH', ctx);
    } else if (this._state === 'SEARCH') {
      this.pickSearchPoint(ctx);
    } else if (this._state === 'HUNT') {
      // Lost them where the noise was. Sweep from here.
      this.enter('SEARCH', ctx);
    }
  }

  private nextWaypoint(
    ctx: SimContext,
  ): { point: Vec3; kind: 'port'; into: ModuleId } | { point: Vec3; kind: 'goal'; into: '' } | null {
    if (this.path.length > 1) {
      const next = this.path[1];
      const edge = ctx.graph.edgeBetween(this._module, next);
      if (edge) return { point: edge.worldPos, kind: 'port', into: next };
      this.repath(ctx);
      return null;
    }
    if (this.targetPoint) return { point: this.targetPoint, kind: 'goal', into: '' };
    return null;
  }

  private setTarget(module: ModuleId, point: Vec3, ctx: SimContext): void {
    this.targetModule = module;
    this.targetPoint = { ...point };
    const path = ctx.graph.findPath(this._module, module, { passable: PASSABLE_ALIEN });
    this.path = path ?? [this._module];
  }

  private repath(ctx: SimContext): void {
    if (!this.targetModule) {
      this.path = [];
      this.targetPoint = null;
      return;
    }
    const path = ctx.graph.findPath(this._module, this.targetModule, { passable: PASSABLE_ALIEN });
    if (path) {
      this.path = path;
    } else {
      // Sealed in. Patrol whatever it can still reach.
      this.path = [];
      this.targetPoint = null;
      this.targetModule = null;
      this.pickPatrolTarget(ctx);
    }
  }

  private face(dir: Vec3): void {
    const yaw = Math.atan2(dir.x, dir.z);
    this._quat = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  }

  // -- state entry ----------------------------------------------------------

  private enter(state: AlienState, ctx: SimContext): void {
    if (this._state === state) return;
    this._state = state;
    const cfg = crewScaledStage(ctx.stage, livingPlayerCount(ctx));
    if (state === 'SEARCH') {
      // Sweeps that module and its neighbours for ~15s (25s at stage 3+).
      this.searchTimer = cfg.searchDuration;
      this.pickSearchPoint(ctx);
    } else if (state === 'HUNT') {
      this.huntNoiseTimer = 0;
    } else if (state === 'PATROL') {
      this.chasing = null;
      this.pickPatrolTarget(ctx);
    }
  }

  private enterRetreat(ctx: SimContext): void {
    this._state = 'RETREAT';
    this.retreatTimer = RETREAT_TIME;
    this.chasing = null;
    const away = this.farthestModule(ctx, this._module);
    this.setTarget(away, ctx.graph.centre(away) ?? this._pos, ctx);
  }

  // -- behaviours -----------------------------------------------------------

  private updateHunt(dt: number, ctx: SimContext): void {
    // "It makes loud noise while hunting." Non-negotiable (§5).
    this.huntNoiseTimer -= dt;
    if (this.huntNoiseTimer <= 0) {
      this.huntNoiseTimer = HUNT_NOISE_INTERVAL;
      ctx.emitNoise('alien', this._pos, this._module, { actor: ALIEN_ACTOR_ID });
    }

    // CONTACT keeps the fix current — and contact means contact.
    //
    // This used to re-fix on the prey's TRUE position from HUNT_TRIGGER_RANGE_M
    // (10 m) with no sound involved, which is a vision cone by another name and
    // breaks §5's pillar outright ("perception is sound + contact only. No
    // vision cone, ever."). At CONTACT_RANGE it is what the comment always
    // claimed: while it can touch you, it knows where you are. Everything
    // further away has to be *heard* — see `hear()`, which re-fixes a HUNT on
    // any audible arrival (§3: HUNT reacts to anything).
    const prey = this.livingPlayers(ctx).find((p) => p.id === this.chasing);
    if (prey && distance(prey.pos, this._pos) <= CONTACT_RANGE) {
      this.setTarget(prey.module, prey.pos, ctx);
    }
  }

  private pickPatrolTarget(ctx: SimContext): void {
    const cfg = crewScaledStage(ctx.stage, livingPlayerCount(ctx));
    const ids = ctx.graph.ids().filter((id) => id !== this._module);
    if (ids.length === 0) return;

    // Crowd bias: weight target selection 2:1 toward the module holding the
    // largest cluster of players (§5, stage 2+).
    const weights = new Map<ModuleId, number>();
    for (const id of ids) weights.set(id, 1);
    if (cfg.crowdBias) {
      const counts = new Map<ModuleId, number>();
      for (const p of this.livingPlayers(ctx)) {
        counts.set(p.module, (counts.get(p.module) ?? 0) + 1);
      }
      let best: ModuleId | null = null;
      let bestCount = 0;
      for (const [module, count] of counts) {
        if (count > bestCount) {
          bestCount = count;
          best = module;
        }
      }
      if (best !== null && weights.has(best)) weights.set(best, 2);
    }

    const target = weightedPick(weights, ctx.rng) ?? ids[Math.floor(ctx.rng() * ids.length)];
    this.setTarget(target, ctx.graph.centre(target) ?? this._pos, ctx);
  }

  private pickSearchPoint(ctx: SimContext): void {
    // Sweep this module and its neighbours (§5).
    const options = [this._module, ...ctx.graph.neighbours(this._module)];
    const module = options[Math.floor(ctx.rng() * options.length)] ?? this._module;
    const centre = ctx.graph.centre(module) ?? this._pos;
    const jitter = {
      x: centre.x + (ctx.rng() - 0.5) * 3,
      y: centre.y + (ctx.rng() - 0.5) * 1.5,
      z: centre.z + (ctx.rng() - 0.5) * 3,
    };
    this.setTarget(module, jitter, ctx);
  }

  // -- hiding (§4) ----------------------------------------------------------

  /** World height its centre rides at while standing on this module's deck. */
  private deckHeight(ctx: SimContext): number {
    const module = ctx.graph.get(this._module);
    return (module ? module.transform.pos.y : this._pos.y) + DECK_RIDE;
  }

  /**
   * Take a step, or route around the hide volume in the way.
   *
   * Two candidate side-steps perpendicular to travel, then hold position — the
   * existing repath timer is the recovery for "boxed in". A locker is a metre
   * wide in a five-metre module; anything cleverer would be pathfinding around
   * furniture, which this game does not have.
   */
  private avoidHides(desired: Vec3, step: number, ctx: SimContext): Vec3 {
    if (ctx.hideSpots.size === 0) return desired;
    // Only an OCCUPIED volume blocks — see `Alien.stepBlocked` for why, and for
    // the measurement that settled it.
    const occupied = new Set<string>();
    for (const p of ctx.players) if (p.alive && !p.escaped && p.hideSpot) occupied.add(p.hideSpot);
    if (occupied.size === 0) return desired;
    const blocks = (to: Vec3) =>
      ctx.hideSpots.sweepBlocked(this._module, this._pos, to, BODY_RADIUS, (v: any) =>
        occupied.has(v.key),
      ) !== null;
    if (!blocks(desired)) return desired;

    const dx = desired.x - this._pos.x;
    const dz = desired.z - this._pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return this._pos;
    const px = -dz / len;
    const pz = dx / len;
    for (const forward of [0.5, 0]) {
      for (const reach of [1, 2, 4]) {
        for (const sign of [1, -1]) {
          const slide = Math.max(step, BODY_RADIUS) * reach;
          const candidate = {
            x: this._pos.x + (dx / len) * step * forward + px * sign * slide,
            y: desired.y,
            z: this._pos.z + (dz / len) * step * forward + pz * sign * slide,
          };
          if (!blocks(candidate)) return candidate;
        }
      }
    }
    return this._pos;
  }

  /**
   * Did an arrival come out of an OCCUPIED hide spot?
   *
   * The shell has already taken its −8 dB off the source loudness by the time
   * the room resolves the event, so a calm occupant never reaches the attention
   * threshold at all and a panicked one only does from inside
   * `HIDE_SAFE_RADIUS_M` (§4 derives that 3 m rather than choosing it). All this
   * does is notice — there is no sight test here or anywhere.
   */
  private noteHideSuspect(origin: Vec3, module: ModuleId, ctx: SimContext): void {
    if (ctx.hideSpots.size === 0) return;
    const volume = ctx.hideSpots.containing(origin, module, 0.35);
    if (!volume) return;
    if (!this.occupantsOf(volume.key, ctx).length) return;
    this.suspectHide = { key: volume.key, module, atMs: ctx.now };
  }

  private occupantsOf(key: HideSpotKey, ctx: SimContext): PlayerId[] {
    const out: PlayerId[] = [];
    for (const p of ctx.players) {
      if (p.alive && !p.escaped && p.hideSpot === key) out.push(p.id);
    }
    return out;
  }

  /** Start prying, once it is leaning on a box it has heard somebody in. */
  private startBreach(ctx: SimContext): void {
    if (this.breachKey) return;
    if (this._state === 'DORMANT' || this._state === 'ATTACK' || this._state === 'RETREAT') return;
    const suspect = this.suspectHide;
    if (!suspect) return;
    if (ctx.now - suspect.atMs > HIDE_SUSPECT_MS) {
      this.suspectHide = null;
      return;
    }
    const volume = ctx.hideSpots.volume(suspect.key);
    if (!volume || volume.module !== this._module) return;
    if (this.occupantsOf(suspect.key, ctx).length === 0) {
      this.suspectHide = null;
      return;
    }
    if (distance(this._pos, volume.centre) > HIDE_BREACH_RANGE_M + BODY_RADIUS) return;

    this.chasing = null;
    this.enter('HUNT', ctx);
    this.targetPoint = { ...volume.centre };
    this.targetModule = volume.module;
    ctx.emitNoise('hide-breach', volume.centre, volume.module, { actor: ALIEN_ACTOR_ID });
    this.breachKey = suspect.key;
    this.breachRemaining = HIDE_BREACH_TIME_S;
  }

  /** Returns true while the tick belongs to a breach in progress. */
  private tickBreach(dt: number, ctx: SimContext): boolean {
    const key = this.breachKey;
    if (!key) return false;
    const occupants = this.occupantsOf(key, ctx);
    if (occupants.length === 0) {
      // They took the window. It is already HUNTing and already standing on the
      // box, so it turns round and goes after them in the open.
      this.breachKey = null;
      this.breachRemaining = 0;
      this.suspectHide = null;
      return false;
    }
    this.breachRemaining -= dt;
    if (this.breachRemaining > 0) return true;
    this.breachKey = null;
    this.suspectHide = null;
    this._state = 'ATTACK';
    this.attackTimer = 1.0;
    for (const id of occupants) ctx.killPlayer(id, 'alien');
    return true;
  }

  private contactCheck(ctx: SimContext): void {
    if (this._state === 'RETREAT' || this._state === 'ATTACK') return;
    for (const p of this.livingPlayers(ctx)) {
      // §4: you cannot be touched through a locker door. The only way in is a
      // breach, and the only way to earn a breach is to make a noise.
      if (p.hideSpot !== null) continue;
      if (distance(p.pos, this._pos) > CONTACT_RANGE) continue;
      if (this._state !== 'HUNT') {
        // Contact is perception too — it grabs whatever it bumps into.
        this.chasing = p.id;
        this.enter('HUNT', ctx);
      }
      this._state = 'ATTACK';
      this.attackTimer = 1.0;
      ctx.killPlayer(p.id, 'alien');
      return;
    }
  }

  private antiCamp(dt: number, ctx: SimContext): void {
    const near = this.livingPlayers(ctx).some(
      (p) => distance(p.pos, this._pos) <= ANTICAMP_RADIUS_M,
    );
    if (!near) {
      this.anticampAccrued = 0;
      return;
    }
    this.anticampAccrued += dt * 1000;
    if (this.anticampAccrued < this.anticampMsRemaining) return;

    // Fuzzed 60–150s without a kill: force PATROL to a distant module (§5).
    this.anticampAccrued = 0;
    this.anticampMsRemaining = anticampMs(ctx.rng);
    if (this._state === 'HUNT' || this._state === 'ATTACK') return;
    const away = this.farthestModule(ctx, this._module);
    this._state = 'PATROL';
    this.chasing = null;
    this.setTarget(away, ctx.graph.centre(away) ?? this._pos, ctx);
  }

  private farthestModule(ctx: SimContext, from: ModuleId): ModuleId {
    const hops = ctx.graph.hopsFrom(from, { passable: PASSABLE_ALIEN });
    let best = from;
    let bestHops = -1;
    for (const [module, count] of hops) {
      if (count > bestHops) {
        bestHops = count;
        best = module;
      }
    }
    return best;
  }

  private livingPlayers(ctx: SimContext): readonly PlayerView[] {
    return ctx.players.filter((p) => p.alive && !p.escaped);
  }
}

/** §5 speeds: HUNT 3.0, SEARCH 1.2, everything else the stage's patrol speed. */
function speedFor(state: AlienState, patrolSpeed: number): number {
  if (state === 'HUNT' || state === 'ATTACK') return SPEED_HUNT;
  if (state === 'SEARCH') return SPEED_SEARCH;
  return patrolSpeed;
}

function weightedPick(weights: Map<ModuleId, number>, rng: () => number): ModuleId | null {
  let total = 0;
  for (const w of weights.values()) total += w;
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const [id, w] of weights) {
    roll -= w;
    if (roll <= 0) return id;
  }
  return null;
}
