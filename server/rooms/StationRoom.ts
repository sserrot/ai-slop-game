/**
 * StationRoom — the authoritative session (DESIGN.md §7).
 *
 * Server owns: alien state, noise propagation, the escalation director, puzzle
 * state, hatches, deaths.
 * Clients own their own movement outright: they send a transform, the server
 * sanity-checks speed and teleports, and otherwise trusts it. There is NO
 * prediction and NO reconciliation here, deliberately — §7 reverses r1 on that
 * and warns that rollback machinery is a trap for this game.
 *
 * Anti-cheat is deliberately skipped (§7): the alien transform is in the shared
 * state and the tracker pulse is computed client-side. Every server-side read of
 * the alien for a client goes through `getAlienForClient()` so there is exactly
 * one place to change if this ever goes public.
 */

import { Room, type Client, type Delayed } from '@colyseus/core';
import {
  EYE_HEIGHT_STAND_M,
  GAIT_PROFILES,
  HIDE_MUFFLE_DB,
  MAX_LEGAL_SPEED_M_S,
  MAX_PLAYERS,
  PLAYER_RADIUS,
  SYSTEMS_TO_ESCAPE,
  TRACKER_FAR_RANGE_M,
  WIN_MIN_SURVIVORS,
  clamp,
  hideEnterSeconds,
} from '@shared/constants';
import type {
  AlienSnapshot,
  DeathCause,
  DirectorStage,
  EscapeSystemId,
  Gait,
  GravityCause,
  GravityMode,
  GravityShiftEvent,
  HatchMessage,
  HideMessage,
  HideSpotKey,
  InteractMessage,
  ModuleId,
  NoiseIntentMessage,
  NoiseKind,
  PlayerId,
  PlayerState,
  PuzzleId,
  RoundResult,
  TransformMessage,
  Vec3,
  VoiceLevelMessage,
} from '@shared/types';
import { GAITS, PLAYER_STATES } from '@shared/types';
import { distance } from '@shared/graph/math';
import { PASSABLE_ALIEN, portKey, syncHatchAttenuation } from '@shared/graph/moduleGraph';
import type { HideVolume } from '@shared/graph/hideSpots';
import { hideSpotKey } from '@shared/graph/hideSpots';
import { defaultStateFor, stateAllowedIn } from '@shared/graph/gravity';
import { config, iceServers } from '../config';
import {
  isInitiator,
  type ItemKind,
  type ReadyMessage,
  type RoundPhase,
  type ServerMessages,
  type SignalMessage,
} from '../net/protocol';
import { CARRY_LIMIT, ItemRegistry } from '../round/items';
import { makeRng, pickLateSpawn, solveSpawns } from '../round/spawns';
import { loadStation, spawnPointIn, type LoadedStation } from '../station/layout';
import type {
  AlienSim,
  DirectorSim,
  PlayerView,
  PuzzleInteractResult,
  PuzzleSim,
  SimContext,
} from '../sim/contracts';
import { livingPlayerCount } from '../sim/contracts';
import { ALIEN_RADIUS, Alien, type AlienPlayerView } from '../sim/alien';
import { EscalationDirector } from '../sim/director';
import { createPuzzleSim } from '../sim/puzzles';
import { AlienAdapter, DirectorAdapter, makeAlienWorld } from '../sim/adapters';
import { FallbackAlien } from '../sim/fallbackAlien';
import { FallbackDirector } from '../sim/fallbackDirector';
import { FallbackPuzzles } from '../sim/fallbackPuzzles';
import { NoiseRouter, type EmittedNoise } from '../sim/noiseRouter';
import { GravityDirector } from '../sim/gravityDirector';
import {
  DirectorSchema,
  HatchSchema,
  ModuleGravitySchema,
  PlayerSchema,
  PuzzleSchema,
  StationRoomState,
} from './state';

/**
 * §7 speed sanity check.
 *
 * `MAX_LEGAL_SPEED_M_S` (7.0) is §14's anti-teleport bound: it covers the
 * fastest legal body in either regime — a full push-off at PUSH_MAX 6, and a
 * terminal-velocity fall with full lateral air control at hypot(6, 2.4) = 6.46 —
 * with a tick of jitter on top. The 1.5x here is network headroom for the
 * extinguisher and for a laggy frame, not a second opinion about physics.
 */
const MAX_SPEED_M_S = MAX_LEGAL_SPEED_M_S * 1.5;
/** Metres of slack on top, so a laggy frame is not a violation. */
const TRANSFORM_SLACK_M = 0.75;
/** Seconds after a spawn during which any transform is accepted — the client
 *  has to be allowed to arrive at the position we gave it. */
const SPAWN_GRACE_S = 3;
/** Metres: how close you must be to a hatch to work it. */
const HATCH_REACH_M = 2.5;
/** Metres a reported noise may sit from the player who claims to have made it. */
const THROW_RANGE_M = 6;
/** Metres: how close a medkit has to get to a body (§10 revival v1). */
const REVIVE_RANGE_M = 2.0;
/** Metres: contact kill radius, a backstop in case the alien sim does not do
 *  it itself. `killPlayer` is idempotent, so both doing it is harmless. */
const CONTACT_KILL_M = PLAYER_RADIUS * 2 + 0.3;
/** ms between voice-derived noise events per player (§7 voiceLevel is 10 Hz;
 *  the alien does not need it that often and neither does the network). */
const VOICE_NOISE_INTERVAL_MS = 250;
/** Minimum calibrated mic level that counts as speech. */
const VOICE_GATE = 0.08;
/** ms between spectator headset noises, per speaker (§10, loudness 5). */
const HEADSET_INTERVAL_MS = 600;
const HEADSET_GATE = 0.15;
/** Metres: how close you must be to a hide spot's entry to climb into it (§4). */
const HIDE_REACH_M = 1.5;
/**
 * ms — the shortest gap between two footsteps the server will accept from one
 * player.
 *
 * Footsteps are DISTANCE-based, never a timer (§3), so the honest bound is the
 * fastest gait's cadence: `speed / stride`, which for a sprint is 2.4 / 1.15 =
 * 2.087 Hz, i.e. one step every 479 ms. A quarter is knocked off for jitter, for
 * a client switching gait mid-stride (the stride meter keeps its accumulated
 * distance, so the next step can land early) and for the 50 ms tick quantum.
 *
 * This is the direct descendant of the tracker-beep fix: a repeating source is
 * only a problem when it repeats faster than the design says it can, and §3's
 * coalescing window is 1000 ms. At this floor a sprinting player puts at most
 * three events in a window and a walking one two — see the measured rates in the
 * comment on `onFootstep`.
 */
const FOOTSTEP_MIN_INTERVAL_MS = Math.floor(
  (1000 / Math.max(...Object.values(GAIT_PROFILES).map((p) => p.cadenceHz))) * 0.75,
);
/** ms to wait after the first join before auto-starting, so a group that
 *  launches together is spawned in one roll (§10). */
const AUTO_START_DELAY_MS = 3000;
/** Actions that consume a carried item before they reach a puzzle. */
const ITEM_REQUIRED_BY_ACTION: Record<string, ItemKind> = {
  'install-fuse': 'fuse',
};

interface JoinOptions {
  name?: string;
}

/** The slice of §11's escape machine the room reads, if the puzzle sim has one. */
interface EscapeCapsule {
  escape?: { readonly launched: boolean; readonly boarded: PlayerId[] };
}

export class StationRoom extends Room<StationRoomState> {
  override maxClients = Math.min(config.maxPlayers, MAX_PLAYERS);

  private station!: LoadedStation;
  private router!: NoiseRouter;
  private items!: ItemRegistry;
  private rng: () => number = Math.random;

  private alien!: AlienSim;
  private director!: DirectorSim;
  private puzzles!: PuzzleSim;
  /** §4's gravity failures — which module, when, and when the floor comes back. */
  private gravity!: GravityDirector;

  private lastTransformAt = new Map<PlayerId, number>();
  private spawnGraceUntil = new Map<PlayerId, number>();
  private breathTimer = new Map<PlayerId, number>();
  private voiceNoiseAt = new Map<PlayerId, number>();
  private headsetAt = new Map<PlayerId, number>();
  private footstepAt = new Map<PlayerId, number>();
  /** Hide entries in flight: `Date.now()` at which the body is actually inside
   *  (§4 — a careful entry takes 2.5 s and cannot be bought back). */
  private hideEntryDue = new Map<PlayerId, { key: HideSpotKey; at: number }>();
  private ready = new Set<PlayerId>();

  private deadOrder: PlayerId[] = [];
  private escapedOrder: PlayerId[] = [];
  private autoStartTimer: Delayed | null = null;
  private roundStartedAtMs = 0;
  private ctxCache: { tick: number; ctx: SimContext } | null = null;

  // =========================================================================
  // lifecycle
  // =========================================================================

  override onCreate(_options: unknown): void {
    this.state = new StationRoomState();
    this.rng = makeRng(config.seed);

    this.station = loadStation(config.layoutPath, {
      deriveHideSpots: config.deriveHideSpots,
    });
    for (const problem of this.station.problems) {
      console.warn(`[station] ${problem}`);
    }
    const zeroG = this.station.graph.modulesWithGravity('zero');
    console.log(
      `[station] '${this.station.layout.id}' — ${this.station.graph.size} modules, ` +
        `${this.station.rails.size} rail segments, ${this.station.hides.size} hide spots, ` +
        `${zeroG.length} authored zero-G${zeroG.length > 0 ? ` (${zeroG.join(', ')})` : ''}, ` +
        `escape '${this.station.layout.escapeModule}', finale '${this.station.layout.finaleModule}'`,
    );

    this.router = new NoiseRouter(this.station.graph);
    // §4's gravity failures. The escape and finale modules are named here rather
    // than inside the director so the rule reads where the layout does: §11's
    // finale is three people holding levers in three rooms, and the capsule is
    // where a round ends. Neither is a place to take the floor away.
    this.gravity = new GravityDirector(this.station.graph, {
      neverDrop: [this.station.layout.escapeModule, this.station.layout.finaleModule],
      ...(config.gravityFirstFailureMs !== undefined
        ? { firstFailureDelayMs: config.gravityFirstFailureMs }
        : {}),
      ...(config.gravitySpacingMs !== undefined ? { spacingMs: config.gravitySpacingMs } : {}),
    });
    // Medkits (§10) and decoys (§5) are the room's to hand out; fuses and the
    // breaker card belong to whoever owns the puzzles.
    this.items = new ItemRegistry(this.station.layout, this.rng, {
      puzzleItems: config.useFallbackSims,
    });
    this.createSims();

    this.state.layoutId = this.station.layout.id;
    this.state.phase = 'LOBBY';
    this.seedGravity();
    this.seedHatches();
    this.seedPuzzles();
    this.syncResources();
    this.syncDirector();
    this.syncAlien();

    this.registerHandlers();

    this.patchRate = config.tickMs;
    this.setSimulationInterval((dtMs) => this.tick(dtMs), config.tickMs);
  }

  /**
   * INTEGRATION POINT — the only place that knows which sim implementations are
   * in play. Everything else in this room is written against `sim/contracts.ts`.
   *
   * By default it wires the real §5 alien, the real §5 director and the real
   * §11 puzzle host. `USE_FALLBACK_SIMS=1` swaps in the self-contained
   * fallbacks in `sim/fallback*.ts` — useful for bisecting a bug, or for
   * running the room when one of those files is mid-surgery.
   */
  private createSims(): void {
    if (config.useFallbackSims) {
      this.alien = new FallbackAlien();
      this.director = new FallbackDirector();
      this.puzzles = new FallbackPuzzles(this.station.layout, this.rng);
      console.log('[sim] using the fallback alien / director / puzzles');
      return;
    }

    const director = new EscalationDirector(
      config.stageTimeoutMs !== undefined ? { stageTimeoutMs: config.stageTimeoutMs } : {},
    );
    this.director = new DirectorAdapter(director);

    this.puzzles = createPuzzleSim(this.station.layout, this.rng, {
      // §5 stage 4 is "all systems / undock live".
      onUndocked: () => {
        director.undockLive();
        this.syncDirector();
        this.broadcastMsg('stage', {
          stage: this.director.stage,
          systemsOnline: this.director.systemsOnline,
        });
      },
    });

    const world = makeAlienWorld({
      graph: this.station.graph,
      rails: this.station.rails,
      hides: this.station.hides,
      players: () => this.alienPlayerViews(),
      // The alien's own noises go through the same §3 pipeline as everyone's,
      // and the loudness is re-derived from §14 either way.
      emitNoise: (event) =>
        this.emitNoise(event.kind, event.origin, event.module, { actor: event.actor }),
      onKill: (playerId) => this.killPlayer(playerId, 'alien'),
      onHatchChanged: (module, port, open, sealed) =>
        this.setHatch(module, port, open, sealed),
    });
    this.alien = new AlienAdapter(
      new Alien(world, director, {
        rng: this.rng,
        onStateChange: (from, to) => {
          if (config.debugNoise) console.log(`[alien] ${from} → ${to}`);
        },
      }),
    );
  }

  /** The alien's deliberately narrow view of the crew (sound and contact only). */
  private alienPlayerViews(): AlienPlayerView[] {
    const out: AlienPlayerView[] = [];
    this.state.players.forEach((p) => {
      out.push({
        id: p.id,
        pos: p.pos.toVec3(),
        module: p.module,
        // An escaped player is off the station: not a target, not a body.
        alive: p.alive && !p.escaped,
        // Physical only: the shell blocks contact and blocks the alien's body.
        // Nothing in the FSM paths toward a hidden player because of this.
        hideSpot: p.hideSpot === '' ? null : p.hideSpot,
        // Also physical: `pos` is the EYE (§4), and `Alien.contactDistance()`
        // needs the body under it. Not perception — see the field's comment.
        gait: p.gait as Gait,
      });
    });
    return out;
  }

  override onJoin(client: Client, options?: JoinOptions): void {
    const id = client.sessionId;
    const player = new PlayerSchema();
    player.id = id;
    player.name = (options?.name ?? '').slice(0, 24);
    player.module = this.station.layout.modules[0]?.id ?? '';
    player.alive = true;
    this.state.players.set(id, player);

    // Late joiner mid-round: give them a legal spawn straight away (§10).
    if (this.state.phase === 'RUNNING') {
      const occupied: ModuleId[] = [];
      this.state.players.forEach((p) => {
        if (p.id !== id && p.alive && !p.escaped) occupied.push(p.module);
      });
      const pick = pickLateSpawn(
        this.station.graph,
        this.station.layout,
        occupied,
        this.rng,
        this.alien.module || null,
      );
      if (pick.relaxed) console.warn(`[spawn] ${pick.relaxed}`);
      this.placePlayer(player, pick.module);
      console.log(`[spawn] late joiner ${id} → ${pick.module}`);
    }

    this.scheduleAutoStart();

    this.sendWelcome(client);
    this.sendInventory(client);

    // Voice mesh (§7): tell everyone who arrived, and who dials whom.
    for (const other of this.clients) {
      if (other.sessionId === id) continue;
      this.sendTo(other, 'peerJoin', { id, initiator: isInitiator(other.sessionId, id) });
    }

    console.log(`[room] ${id} joined (${this.state.players.size}/${this.maxClients})`);
  }

  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    const id = client.sessionId;
    if (!consented) {
      try {
        // Flaky home wifi is not a death sentence; 15 s to come back.
        const returning = await this.allowReconnection(client, 15);
        // Forgive the gap: they may have drifted while the socket was down.
        this.spawnGraceUntil.set(returning.sessionId, Date.now() + SPAWN_GRACE_S * 1000);
        this.lastTransformAt.delete(returning.sessionId);
        console.log(`[room] ${returning.sessionId} reconnected`);
        return;
      } catch {
        /* never came back — fall through and remove them */
      }
    }
    this.removePlayer(id);
  }

  override onDispose(): void {
    console.log('[room] disposed');
  }

  private removePlayer(id: PlayerId): void {
    const player = this.state.players.get(id);
    if (!player) return;
    if (this.state.phase === 'RUNNING' && player.alive && !player.escaped) {
      this.killPlayer(id, 'disconnect');
    }
    this.state.players.delete(id);
    this.lastTransformAt.delete(id);
    this.spawnGraceUntil.delete(id);
    this.breathTimer.delete(id);
    this.voiceNoiseAt.delete(id);
    this.headsetAt.delete(id);
    this.footstepAt.delete(id);
    this.hideEntryDue.delete(id);
    this.ready.delete(id);
    this.broadcastMsg('peerLeave', { id, initiator: false });
    console.log(`[room] ${id} left (${this.state.players.size} remain)`);
    this.checkRoundEnd();
  }

  // =========================================================================
  // messages
  // =========================================================================

  private registerHandlers(): void {
    this.onMessage<TransformMessage>('transform', (client, msg) => this.onTransform(client, msg));
    this.onMessage<NoiseIntentMessage>('noise', (client, msg) => this.onNoiseIntent(client, msg));
    this.onMessage<InteractMessage>('interact', (client, msg) => this.onInteract(client, msg));
    this.onMessage<VoiceLevelMessage>('voiceLevel', (client, msg) => this.onVoiceLevel(client, msg));
    this.onMessage<HatchMessage>('hatch', (client, msg) => this.onHatch(client, msg));
    this.onMessage<HideMessage>('hide', (client, msg) => this.onHide(client, msg));
    this.onMessage<SignalMessage>('signal', (client, msg) => this.onSignal(client, msg));
    this.onMessage<ReadyMessage>('ready', (client, msg) => this.onReady(client, msg));
  }

  /**
   * §7: "Clients own their own movement outright. Send your transform; the
   * server sanity-checks speed and teleports; done."
   */
  private onTransform(client: Client, msg: TransformMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (!msg || !msg.pos || !msg.quat) return;
    // A dead player is on the module cameras (§10) but their client is still
    // the natural owner of the corpse, which persists and drifts as a physics
    // object. Same speed check; it just cannot grip anything any more.
    if (player.escaped) return;

    const now = Date.now();
    const grace = this.spawnGraceUntil.get(player.id) ?? 0;
    const last = this.lastTransformAt.get(player.id);
    this.lastTransformAt.set(player.id, now);

    if (now > grace && last !== undefined) {
      const dt = clamp((now - last) / 1000, 0.02, 0.5);
      const moved = distance(msg.pos, player.pos.toVec3());
      const allowed = MAX_SPEED_M_S * dt + TRANSFORM_SLACK_M;
      if (moved > allowed) {
        this.sendTo(client, 'correction', {
          pos: player.pos.toVec3(),
          quat: player.quat.toQuat(),
          reason: 'speed',
        });
        return;
      }
    }

    let module = msg.module;
    if (!this.station.graph.has(module)) {
      module = this.station.graph.nearestModule(msg.pos) ?? player.module;
      this.sendTo(client, 'correction', {
        pos: msg.pos,
        quat: msg.quat,
        reason: 'unknown-module',
      });
    }

    // A body inside a hide spot is where the SERVER put it. The client owns
    // movement (§7) right up to the moment it stops moving: accept the look
    // direction so the occupant can still turn their head, and ignore the
    // position, or "climb in, then walk away invisible" is one edited packet.
    const hidden = this.hideVolumeOf(player);
    if (hidden) {
      player.quat.set(msg.quat);
      player.module = hidden.module;
      player.state = 'HIDDEN';
      player.gripId = '';
      player.gait = normaliseGait(msg.gait);
      return;
    }

    player.pos.set(msg.pos);
    player.quat.set(msg.quat);
    player.module = module;
    // Gait is authoritative state, not decoration: footstep and landing loudness
    // are functions of it (§14), so it is kept here and re-derived from here
    // rather than trusted per noise message.
    player.gait = normaliseGait(msg.gait);
    if (!player.alive) {
      player.state = defaultStateFor(this.station.graph.gravityOf(module));
      player.gripId = '';
      return;
    }

    const mode = this.station.graph.gravityOf(module);
    let state: PlayerState = (PLAYER_STATES as readonly string[]).includes(msg.state)
      ? (msg.state as PlayerState)
      : defaultStateFor(mode);
    // The locomotion regime is the server's, because the server owns gravity.
    // A client claiming GROUNDED in a module whose floor just failed is not
    // cheating, it is one tick behind the `gravity` broadcast — so correct it
    // quietly to the regime's own default rather than arguing about it.
    if (!stateAllowedIn(state, mode)) state = defaultStateFor(mode);
    // HIDDEN without a hide spot is not a state; the `hide` message is the only
    // way in, and it is server-authoritative.
    if (state === 'HIDDEN') state = defaultStateFor(mode);
    player.state = state;
    // A grip only means anything where there is no floor (§2: the player queries
    // the rail graph at scope `zero`).
    player.gripId =
      mode === 'zero' && msg.gripId && this.station.rails.node(msg.gripId) ? msg.gripId : '';
  }

  // -- hiding (§4) ----------------------------------------------------------

  /**
   * Climb into, or out of, a hide spot.
   *
   * §4's loud-fast / quiet-slow rule applied to a movement verb, and both halves
   * are server-side because both are noise:
   *
   * - `haste` 0 -> 2.5 s at loudness 8, under every PATROL threshold at every
   *   crew size. Genuinely quiet, and genuinely slow.
   * - `haste` 1 -> 0.5 s at loudness 30, above even a solo patrol's threshold.
   *   A last-second dive is ALWAYS heard.
   *
   * The noise is emitted the moment you start moving, and the body only becomes
   * hidden when the timer runs out — so the 2.5 s careful entry cannot be bought
   * back at the last second (§14 asserts it does not fit inside the 1.67 s a
   * HUNT needs to cross a module). Hiding EARLY is the skilled play.
   */
  private onHide(client: Client, msg: HideMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive || player.escaped) return;
    if (this.state.phase !== 'RUNNING') return;
    if (!msg || (msg.action !== 'enter' && msg.action !== 'exit')) return;
    const haste = clamp(Number(msg.haste ?? 0), 0, 1);

    if (msg.action === 'exit') {
      this.leaveHideSpot(player, haste);
      return;
    }

    if (player.hideSpot !== '' || this.hideEntryDue.has(player.id)) return;

    const key = hideSpotKey(msg.module, msg.spot);
    const volume = this.station.hides.volume(key);
    if (!volume) return;
    if (volume.module !== player.module) {
      this.toast(player.id, 'not in this module');
      return;
    }
    if (!this.station.hides.usableNow(volume)) {
      // A bay you stand up into is unusable once the floor has gone, and a
      // stowage net you float into is unusable once it is back. That is a good
      // moment, not a bug (§4).
      this.toast(player.id, 'you cannot get into that from here');
      return;
    }
    if (distance(volume.entry, player.pos.toVec3()) > HIDE_REACH_M) {
      this.toast(player.id, 'too far');
      return;
    }
    if (this.occupantCount(key) >= volume.capacity) {
      this.toast(player.id, 'occupied');
      return;
    }

    // You make the sound as you climb in, not when you finish.
    this.emitNoise('hide-enter', volume.entry, volume.module, {
      intensity: haste,
      actor: player.id,
    });
    this.hideEntryDue.set(player.id, {
      key,
      at: Date.now() + hideEnterSeconds(haste) * 1000,
    });
  }

  /** Commit the hide entries whose timers have run out. */
  private updateHideEntries(now: number): void {
    if (this.hideEntryDue.size === 0) return;
    for (const [id, entry] of [...this.hideEntryDue]) {
      const player = this.state.players.get(id);
      if (!player || !player.alive || player.escaped) {
        this.hideEntryDue.delete(id);
        continue;
      }
      if (now < entry.at) continue;
      this.hideEntryDue.delete(id);
      const volume = this.station.hides.volume(entry.key);
      if (!volume || this.occupantCount(entry.key) >= volume.capacity) continue;
      player.hideSpot = entry.key;
      player.state = 'HIDDEN';
      player.gripId = '';
      // The body is at the box centre from here on — that is the position the
      // alien's contact test and the noise system both use.
      player.pos.set(volume.centre);
      player.module = volume.module;
    }
  }

  /** Get out of a hide spot. Loud if you are in a hurry, which you will be. */
  private leaveHideSpot(player: PlayerSchema, haste: number): void {
    // Abort an entry still in flight — the noise was already paid for.
    this.hideEntryDue.delete(player.id);
    if (player.hideSpot === '') return;
    const volume = this.station.hides.volume(player.hideSpot);
    player.hideSpot = '';
    if (!volume) {
      player.state = defaultStateFor(this.station.graph.gravityOf(player.module));
      return;
    }
    player.pos.set(volume.entry);
    player.module = volume.module;
    player.state = defaultStateFor(this.station.graph.gravityOf(volume.module));
    // Bailing out of a breached locker is meant to be heard — §4's two seconds
    // are "a window to bail out, LOUDLY, into a room with the thing in it".
    this.emitNoise('hide-exit', volume.entry, volume.module, {
      intensity: haste,
      actor: player.id,
    });
    // No `correction` is sent, deliberately. The occupant asked to get out, so
    // it already knows which spot it was in and can place itself at that spot's
    // `entryPos` from the layout it was handed at join — and §7 gives movement
    // back to the client on the very next frame anyway. A correction here would
    // need a reason code the wire does not have ('speed' / 'unknown-module' /
    // 'not-alive' all misdescribe it), and inventing one means editing the
    // client's mirror of the protocol, which is a lot of coupling to buy a
    // packet nobody needs.
  }

  private occupantCount(key: HideSpotKey): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (p.alive && !p.escaped && p.hideSpot === key) n++;
    });
    return n;
  }

  /** The hide volume a player is inside, or undefined. */
  private hideVolumeOf(player: PlayerSchema): HideVolume | undefined {
    return player.hideSpot === '' ? undefined : this.station.hides.volume(player.hideSpot);
  }

  /**
   * "I made this sound." The kind and position are the client's to report; the
   * LOUDNESS is not — `NoiseRouter` re-derives it from §14.
   */
  private onNoiseIntent(client: Client, msg: NoiseIntentMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.state.phase !== 'RUNNING') return;
    if (!msg || typeof msg.kind !== 'string' || !msg.pos) return;
    // The alien's own noise is the server's to make (§5).
    if (msg.kind === 'alien') return;
    // Voice arrives through `voiceLevel`, which is calibrated (§7).
    if (msg.kind === 'voice') return;
    // The dead make no sound of their own; the headset channel is server-side,
    // driven by their `voiceLevel` (§10).
    if (!player.alive) return;

    // Sanity: a sound comes from where YOU are. Anti-cheat is skipped (§7), but
    // letting a client place a 70-loudness event anywhere on the station would
    // hand it a free remote control over the alien — the exact failure §3's
    // coalescing rules exist to prevent. A decoy is the one thing that
    // legitimately lands away from its thrower, and only within one module.
    const claimed = this.station.graph.has(msg.module) ? msg.module : player.module;
    const here = player.pos.toVec3();
    let module = claimed;
    let origin: Vec3 = msg.pos;
    if (msg.kind === 'decoy') {
      const hops = this.station.graph.hopDistance(player.module, claimed, {
        passable: PASSABLE_ALIEN,
      });
      if (hops < 0 || hops > 1) {
        module = player.module;
        origin = here;
      }
    } else if (claimed !== player.module || distance(msg.pos, here) > THROW_RANGE_M) {
      module = player.module;
      origin = here;
    }

    // A decoy is one of two per round, and it has to be in your hands (§5).
    if (msg.kind === 'decoy') {
      if (!this.takeItem(player, 'decoy')) {
        this.toast(player.id, 'no decoy');
        return;
      }
      this.items.consumeDecoy();
      this.syncResources();
      this.sendInventory(client);
    }

    const kind = msg.kind as NoiseKind;
    if ((kind === 'footstep' || kind === 'landing') && !this.allowStride(player, claimed)) return;

    // The gait is the SERVER's copy, from the last accepted transform — never
    // the one attached to this message. Loudness is a function of gait (crouch
    // 4 / walk 12 / sprint 30), so letting the noise packet name it would hand
    // the client the volume knob §7 deliberately keeps on this side.
    const gait = player.gait as Gait;
    // Likewise `hidden`: the client reports the fact of being in a locker by
    // being in one, and the server already knows, because it put them there.
    const shell = this.hideVolumeOf(player);

    this.emitNoise(kind, origin, module, {
      speed: typeof msg.speed === 'number' ? msg.speed : undefined,
      intensity: typeof msg.intensity === 'number' ? msg.intensity : undefined,
      gait,
      hidden: shell !== undefined,
      muffleDb: shell?.muffleDb ?? HIDE_MUFFLE_DB,
      actor: player.id,
    });
  }

  /**
   * Rate-limit the two locomotion noises (§3 "footsteps are events, not a loop").
   *
   * MEASURED RATES, from `GAIT_PROFILES` — cadence is `speed / strideM`, and it
   * is distance-based, so these are the steady-state maxima for a player who
   * never stops moving:
   *
   *     crouch  0.75 / 0.55 = 1.36 steps/s   at loudness 4    (733 ms apart)
   *     walk    1.40 / 0.75 = 1.87 steps/s   at loudness 12   (536 ms apart)
   *     sprint  2.40 / 1.15 = 2.09 steps/s   at loudness 30   (479 ms apart)
   *
   * Against §3's 1000 ms coalescing window that is at most two footsteps per
   * window walking and three sprinting — and every one of them is from the same
   * module, so the coalescer's diminishing-returns rule widens that module's
   * error radius by 3 m per consecutive window (to +12). A player who keeps
   * walking therefore gets HARDER to localise, not easier: the opposite of the
   * tracker-beep failure, where a repeating source at 20 pinned you exactly.
   *
   * The gate below only stops a client emitting faster than any gait can walk.
   * Without it, a modified client could put twenty 12-loudness events into one
   * window and own the alien's attention for free — the same remote control §3's
   * margin-based discard exists to prevent, arriving through a different door.
   */
  private allowStride(player: PlayerSchema, claimedModule: ModuleId): boolean {
    // You cannot take a step where there is no floor, and you cannot take one
    // inside a locker: `HIDDEN` reads no locomotion input at all (§4). Both are
    // facts the server already owns, so neither is the client's to assert.
    //
    // The floor is checked in the module the noise CLAIMS as well as the one the
    // last transform put the player in, and that second clause is §4's `settle`.
    // MEASURED without it: floating out of `airlock-eva` into `node-beta` at
    // deck height, the client crossed the hatch, `standUpOnSettle` planted the
    // feet and the landing resolved 15 ms later — while this server still had
    // `player.module = 'airlock-eva'` from a transform up to a 20 Hz tick old.
    // Client emitted `landing` 4; the alien heard NOTHING. Every ordinary
    // float-through-a-hatch arrival is that case, so the transition §4 prices at
    // `landingNoise` was free at the one moment it is most likely to be loud.
    // The claim buys no leverage: `origin` above is already clamped to the
    // server's own copy of the body, the loudness is still re-derived from the
    // server's `gait`, and a floating client asserting a footstep only ADDS
    // noise to its own position.
    const floorUnderPlayer = this.station.graph.hasFloor(player.module);
    const floorWhereClaimed = this.station.graph.hasFloor(claimedModule);
    if (!floorUnderPlayer && !floorWhereClaimed) return false;
    if (player.hideSpot !== '') return false;

    const now = Date.now();
    const last = this.footstepAt.get(player.id) ?? 0;
    if (now - last < FOOTSTEP_MIN_INTERVAL_MS) return false;
    // A landing and the first footstep after it share one gate: touching down
    // and taking a stride are one impact on the deck, not two.
    this.footstepAt.set(player.id, now);
    return true;
  }

  private onVoiceLevel(client: Client, msg: VoiceLevelMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.state.phase !== 'RUNNING') return;
    const level = clamp(Number(msg?.level ?? 0), 0, 1);
    const now = Date.now();

    if (!player.alive) {
      // Spectators speak over the headset channel at loudness 5 (§10). The
      // sound comes out of the LIVING crew's headsets, not from the corpse.
      if (level < HEADSET_GATE) return;
      if (now - (this.headsetAt.get(player.id) ?? 0) < HEADSET_INTERVAL_MS) return;
      this.headsetAt.set(player.id, now);
      this.state.players.forEach((other) => {
        if (!other.alive || other.escaped) return;
        this.emitNoise('headset', other.pos.toVec3(), other.module, { actor: player.id });
      });
      return;
    }

    if (player.escaped) return;
    if (level < VOICE_GATE) return;
    if (now - (this.voiceNoiseAt.get(player.id) ?? 0) < VOICE_NOISE_INTERVAL_MS) return;
    this.voiceNoiseAt.set(player.id, now);
    this.emitNoise('voice', player.pos.toVec3(), player.module, {
      intensity: level,
      actor: player.id,
    });
  }

  /** Cycle or seal a hatch (§5). Both sides of the pair move together. */
  private onHatch(client: Client, msg: HatchMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive || this.state.phase !== 'RUNNING') return;
    const port = this.station.graph.port(msg.module, msg.port);
    if (!port) return;

    const world = this.station.graph.portWorldPos(msg.module, msg.port);
    if (world && distance(world, player.pos.toVec3()) > HATCH_REACH_M) {
      this.toast(player.id, 'too far from the hatch');
      return;
    }
    if (port.hatch.sealed && msg.action !== 'seal') {
      this.toast(player.id, 'sealed');
      return;
    }

    if (msg.action === 'seal') {
      if (port.hatch.sealed) return;
      if (!this.items.consumeSealCharge()) {
        this.toast(player.id, 'no seal charges left');
        return;
      }
      this.syncResources();
      this.setHatch(msg.module, msg.port, false, true);
    } else {
      this.setHatch(msg.module, msg.port, msg.action === 'open', false);
    }

    // Hatch cycle, either party — 45, carries about three modules (§3).
    this.emitNoise('hatch-cycle', world ?? player.pos.toVec3(), msg.module, { actor: player.id });
  }

  /** WebRTC signalling relay for the voice mesh (§7). Opaque payload. */
  private onSignal(client: Client, msg: SignalMessage): void {
    if (!msg || typeof msg.to !== 'string') return;
    const target = this.clients.find((c) => c.sessionId === msg.to);
    if (!target) return;
    this.sendTo(target, 'signal', { from: client.sessionId, data: msg.data });
  }

  /**
   * The client announces it is loaded. Re-sending `welcome` here is deliberate:
   * the one sent from `onJoin` can land before the client has registered its
   * message handlers, and `welcome` carries the station layout, so losing it is
   * fatal. It is idempotent — the client keeps the last one.
   */
  private onReady(client: Client, msg: ReadyMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (msg?.name) player.name = msg.name.slice(0, 24);
    this.sendWelcome(client);
    this.sendInventory(client);
    this.ready.add(player.id);
  }

  /**
   * Auto-start a few seconds after the LAST join, not the first. A group that
   * launches together must get ONE roll of the §10 spawn solver: rolling
   * incrementally is what puts a late joiner in the alien's module.
   * Set `AUTO_START=0` to wait for `interact { targetId: 'round', action:
   * 'start' }` instead.
   */
  private scheduleAutoStart(): void {
    if (!config.autoStart || this.state.phase !== 'LOBBY') return;
    this.autoStartTimer?.clear();
    this.autoStartTimer = this.clock.setTimeout(() => {
      this.autoStartTimer = null;
      if (this.state.phase === 'LOBBY') this.startRound();
    }, AUTO_START_DELAY_MS);
  }

  // -- interactions ---------------------------------------------------------

  private onInteract(client: Client, msg: InteractMessage): void {
    const player = this.state.players.get(client.sessionId);
    if (!player || !msg || typeof msg.targetId !== 'string') return;

    // Round control is always available, even in LOBBY / ENDED.
    if (msg.targetId === 'round') {
      if (msg.action === 'start' && this.state.phase !== 'RUNNING') this.startRound();
      else if (msg.action === 'restart') this.startRound();
      return;
    }
    if (this.state.phase !== 'RUNNING') return;

    if (!player.alive) {
      // The dead get one verb: choose a camera (§10 spectating).
      if (msg.action === 'spectate') {
        const module = String(msg.value ?? '');
        if (this.station.graph.has(module)) player.spectating = module;
      }
      return;
    }

    switch (msg.action) {
      case 'loot':
        this.lootLocker(client, player, msg.targetId);
        return;
      case 'drop': {
        // 'drop' is ambiguous: it is also how a puzzle puts a fuse down. Only
        // claim it when the player really is carrying that item of ours.
        const item = String(msg.value ?? '') as ItemKind;
        if (item && this.hasItem(player, item)) {
          this.dropItem(client, player, item);
          return;
        }
        break;
      }
      case 'revive':
        this.revive(client, player, msg.targetId);
        return;
      case 'escape':
        this.escape(client, player);
        return;
      default:
        break;
    }

    // Everything else is a puzzle (§11). You have to be in the room with it:
    // §6's case for in-world panels is that your back is exposed while you work.
    //
    // Say WHERE it is rather than only that this is not it — the refusal is
    // otherwise indistinguishable from a bug, and telling a player which module
    // to walk to costs them a trip, which is the price the doc wants charged.
    const where = this.puzzles.moduleFor?.(msg.targetId);
    if (where && where !== player.module) {
      this.toast(player.id, `not at that panel — it is in ${where}`);
      return;
    }

    const required = ITEM_REQUIRED_BY_ACTION[msg.action];
    if (required && !this.hasItem(player, required)) {
      this.toast(player.id, `you need a ${required}`);
      return;
    }
    const ctx = this.context();
    const result = this.puzzles.interact(player.id, msg, ctx);
    if (!result) return;
    if (required && result.changed) {
      this.takeItem(player, required);
      this.sendInventory(client);
    }
    this.applyPuzzleResult(result);
    if (result.message) this.toast(player.id, result.message);
  }

  private lootLocker(client: Client, player: PlayerSchema, targetId: string): void {
    const locker = this.items.locker(targetId);
    if (!locker) return;
    const world = this.propWorldPos(locker.module, locker.propId);
    if (world && distance(world, player.pos.toVec3()) > HATCH_REACH_M) {
      this.toast(player.id, 'too far');
      return;
    }
    if (player.items.length >= CARRY_LIMIT) {
      this.toast(player.id, 'hands full');
      return;
    }
    // Rummaging is a hand-pump-quiet 6 either way — an empty locker still costs
    // you the sound of opening it, and so does one that refuses to open (§3
    // quiet tier).
    this.emitNoise('hand-pump', world ?? player.pos.toVec3(), locker.module, { actor: player.id });

    // §11: a jammed door is jammed for everything behind it, not just for the
    // fuse. Pry it (60, 3 s) or hand-pump it (6, 25 s).
    if (this.puzzles.lockerJammed?.(targetId)) {
      this.toast(player.id, 'jammed — pry it (loud) or pump it (slow)');
      return;
    }

    const item = this.items.loot(targetId);
    if (!item) {
      this.toast(player.id, 'empty');
      return;
    }
    player.items.push(item);
    this.sendInventory(client);
    this.toast(player.id, `picked up ${item}`);
  }

  private dropItem(client: Client, player: PlayerSchema, item: string): void {
    if (!this.takeItem(player, item as ItemKind)) return;
    this.sendInventory(client);
  }

  /** §10 revival, v1: carry a medkit to the body. Not the body to medical. */
  private revive(client: Client, player: PlayerSchema, targetId: PlayerId): void {
    const target = this.state.players.get(targetId);
    if (!target || target.alive) return;
    if (distance(target.pos.toVec3(), player.pos.toVec3()) > REVIVE_RANGE_M) {
      this.toast(player.id, 'get closer to the body');
      return;
    }
    if (!this.takeItem(player, 'medkit')) {
      this.toast(player.id, 'you need a medkit');
      return;
    }
    // They come back where their body is, not where the medic is standing.
    target.alive = true;
    target.spectating = '';
    target.heartRate = 120;
    this.deadOrder = this.deadOrder.filter((id) => id !== targetId);
    this.spawnGraceUntil.set(targetId, Date.now() + SPAWN_GRACE_S * 1000);
    this.lastTransformAt.delete(targetId);
    this.sendInventory(client);
    this.broadcastMsg('revived', { id: targetId, by: player.id });
    console.log(`[round] ${player.id} revived ${targetId}`);
  }

  /** §11 escape condition: four systems online, the undock sequence, the capsule. */
  private escape(client: Client, player: PlayerSchema): void {
    if (player.module !== this.station.layout.escapeModule) {
      this.toast(player.id, 'the capsule is not here');
      return;
    }
    if (this.director.systemsOnline < SYSTEMS_TO_ESCAPE) {
      this.toast(
        player.id,
        `${this.director.systemsOnline}/${SYSTEMS_TO_ESCAPE} systems online`,
      );
      return;
    }
    const undock = this.puzzles.get('undock-sequence');
    if (undock && !undock.solved) {
      this.toast(player.id, 'undock sequence not run');
      return;
    }
    this.markEscaped(player.id);
  }

  /** One player is off the station (§10 "crew recovered"). Idempotent. */
  private markEscaped(id: PlayerId): void {
    const player = this.state.players.get(id);
    if (!player || player.escaped) return;
    player.escaped = true;
    player.alive = true;
    this.escapedOrder.push(id);
    this.deadOrder = this.deadOrder.filter((dead) => dead !== id);
    this.broadcastMsg('escaped', { id, escaped: this.escapedOrder.length });
    console.log(`[round] ${id} escaped (${this.escapedOrder.length})`);
    this.checkRoundEnd();
  }

  // =========================================================================
  // simulation
  // =========================================================================

  private tick(dtMs: number): void {
    const now = Date.now();
    this.state.tick++;

    if (this.state.phase !== 'RUNNING') return;
    const dt = clamp(dtMs, 1, 250) / 1000;
    const ctx = this.context();

    // §4's gravity failures, before anything reads a module's regime this tick.
    this.updateGravity(dtMs, ctx);
    this.updateHideEntries(now);

    if (this.director.update(dtMs, ctx)) {
      this.syncDirector();
      this.broadcastMsg('stage', {
        stage: this.director.stage,
        systemsOnline: this.director.systemsOnline,
      });
      console.log(`[director] stage ${this.director.stage}`);
    } else {
      this.state.director.msToNextFreeStage = this.director.msToNextFreeStage;
    }

    for (const result of this.puzzles.update(dt, ctx)) this.applyPuzzleResult(result);

    this.alien.update(dt, ctx);
    this.syncAlien();

    // §3: act on the loudest event of the window, once per window. Skipped when
    // the alien sim runs its own coalescer (see `AlienSim.ownsCoalescing`).
    const decision = this.alien.ownsCoalescing ? null : this.router.flush(now);
    if (decision) {
      const point = this.router.investigationPointFor(decision, this.rng);
      this.alien.investigate(decision, point, ctx);
      if (config.debugNoise) {
        console.log(
          `[noise] window: ${decision.primary.event.kind} @${decision.primary.level.toFixed(1)} ` +
            `from ${decision.module}, ${decision.secondary.length} secondary, ` +
            `${decision.discarded} discarded, error ${decision.errorRadius.toFixed(1)}m`,
        );
      }
    }

    this.updateBodies(dt);
    this.contactBackstop();
    this.collectEscapees();
    this.checkRoundEnd();
  }

  /**
   * §11's finale, when the puzzle host owns it: the capsule launches with
   * whoever boarded it. `interact { targetId: 'capsule', action: 'escape' }`
   * (below) is the simpler one-player path; both end at `markEscaped`.
   */
  private collectEscapees(): void {
    const machine = (this.puzzles as Partial<EscapeCapsule>).escape;
    if (!machine || !machine.launched) return;
    for (const id of machine.boarded) this.markEscaped(id);
  }

  /** Heart rate and the breathing loop it drives (§6). */
  private updateBodies(dt: number): void {
    const alien = this.getAlienForClient(null);
    const hunting = alien.state === 'HUNT' || alien.state === 'ATTACK';

    this.state.players.forEach((player) => {
      if (!player.alive || player.escaped) return;

      const pos = player.pos.toVec3();
      const metres = distance(pos, alien.pos);
      const hops = this.station.graph.hopDistance(player.module, alien.module, {
        passable: PASSABLE_ALIEN,
      });
      let proximity = clamp(1 - metres / TRACKER_FAR_RANGE_M, 0, 1);
      if (hops < 0) proximity = 0;
      else if (hops > 0) proximity /= 1 + hops;
      if (hunting) proximity = clamp(proximity + 0.25, 0, 1);

      const target = 60 + 110 * proximity;
      const k = 1 - Math.pow(0.5, dt / 2);
      player.heartRate += (target - player.heartRate) * k;

      // "Holding still next to the alien stops being free" (§6). Breathing is
      // 6–14 loudness and speeds up with heart rate.
      const intensity = clamp((player.heartRate - 60) / 110, 0, 1);
      const interval = 5 - 3.5 * intensity;
      const due = (this.breathTimer.get(player.id) ?? 0) - dt;
      if (due <= 0) {
        this.breathTimer.set(player.id, interval);
        this.emitNoise('breathing', pos, player.module, { intensity, actor: player.id });
      } else {
        this.breathTimer.set(player.id, due);
      }
    });
  }

  /**
   * Contact kills, for an alien sim that does not do it itself (§5).
   *
   * ONLY for such a sim. A sim that owns its own coalescing owns its own
   * attention and its own contact rule too (`Alien.checkContact`: a touch from
   * PATROL enters HUNT and *grabs*, the kill lands on the next tick), and this
   * ran on the same room tick at a wider radius (1.0 m vs the sim's 0.80 m), so
   * it beat the sim to every kill and there was no beat between "it has you"
   * and "you are dead". §5's chase loop is a set of counters you are supposed to
   * be able to play; a kill nobody can see coming is not one of them. Leaving
   * kill timing with the sim is what makes a grab window implementable at all —
   * without this gate it would be dead code.
   */
  private contactBackstop(): void {
    if (this.alien.ownsCoalescing) return;
    const alien = this.getAlienForClient(null);
    if (alien.state !== 'HUNT' && alien.state !== 'ATTACK') return;
    this.state.players.forEach((player) => {
      if (!player.alive || player.escaped) return;
      if (distance(player.pos.toVec3(), alien.pos) <= CONTACT_KILL_M) {
        this.killPlayer(player.id, 'alien');
      }
    });
  }

  // =========================================================================
  // world mutations (the SimContext surface)
  // =========================================================================

  /**
   * Every sound in the game goes through here: authoritative loudness, one
   * graph walk, then the alien and the clients that can hear it.
   */
  private emitNoise(
    kind: NoiseKind,
    pos: Vec3,
    module: ModuleId,
    opts: {
      speed?: number;
      intensity?: number;
      gait?: Gait;
      hidden?: boolean;
      muffleDb?: number;
      actor?: PlayerId;
    } = {},
  ): void {
    const emitted = this.router.emit(kind, pos, module, this.state.tick, opts);
    this.dispatchNoise(emitted);
  }

  private dispatchNoise(emitted: EmittedNoise): void {
    const { event, propagation } = emitted;

    // Clients resolve the event locally for audio (§8) with the same shared
    // code the server just ran, so only send it to people it can reach.
    for (const client of this.clients) {
      const player = this.state.players.get(client.sessionId);
      if (!player) continue;
      const ear = player.alive ? player.module : player.spectating || player.module;
      if (!propagation.reaches(ear)) continue;
      this.sendTo(client, 'noise', {
        pos: event.origin,
        module: event.module,
        level: event.loudness,
        kind: event.kind,
        t: event.t,
        actor: event.actor,
      });
    }

    // The alien's ear. One graph walk, resolved at its position (§3).
    const alien = this.getAlienForClient(null);
    const resolution = this.router.resolveAt(emitted, alien.pos, alien.module);

    if (this.alien.ownsCoalescing) {
      // It runs its own window and its own attention thresholds; hand it
      // everything audible and let it decide.
      if (!resolution.audible) return;
      this.alien.hear(
        {
          event,
          level: resolution.level,
          distance: resolution.distance,
          hops: resolution.hops,
          resolution,
        },
        this.context(),
      );
      return;
    }

    // The living count crew-scales the §3 thresholds this gate applies (§14
    // crew scaling): those numbers filter six people's noise budget and filter
    // nothing at all when one person is making all of it. The shipping `Alien`
    // never reaches here — it coalesces itself and gates on the director's
    // scaled thresholds — so this is the fallback sim's half of the same fix.
    const level = this.router.offerToAlien(
      emitted,
      resolution,
      alien.state,
      this.director.stage,
      Date.now(),
      livingPlayerCount(this.context()),
    );
    if (level === null) return;
    this.alien.hear(
      { event, level, distance: resolution.distance, hops: resolution.hops, resolution },
      this.context(),
    );
  }

  private killPlayer(id: PlayerId, cause: DeathCause): void {
    const player = this.state.players.get(id);
    if (!player || !player.alive || player.escaped) return;
    player.alive = false;
    // A body does not stay tucked in a locker: the corpse persists and drifts
    // (§10), and leaving `hideSpot` set would keep the box "occupied" forever
    // and keep the alien's contact test skipping over a body somebody may still
    // want to walk a medkit to.
    this.hideEntryDue.delete(id);
    player.hideSpot = '';
    player.state = defaultStateFor(this.station.graph.gravityOf(player.module));
    player.gripId = '';
    player.heartRate = 0;
    player.spectating = player.module;
    if (!this.deadOrder.includes(id)) this.deadOrder.push(id);
    this.broadcastMsg('death', { playerId: id, cause });
    console.log(`[round] ${id} died (${cause})`);
    this.checkRoundEnd();
  }

  /** Open / close / seal one hatch and its partner, then refresh the graph. */
  private setHatch(module: ModuleId, port: string, open: boolean, sealed: boolean): void {
    const sides: Array<{ module: ModuleId; port: string }> = [{ module, port }];
    const here = this.station.graph.port(module, port);
    if (!here) return;
    if (here.link) sides.push({ module: here.link.module, port: here.link.port });

    for (const side of sides) {
      const p = this.station.graph.port(side.module, side.port);
      if (!p) continue;
      p.hatch.open = sealed ? false : open;
      p.hatch.sealed = sealed;
      // §2/§14: `attenuationDb` is a denormalised cache of open/sealed — open
      // -3, closed -25, sealed -40 — and writing a flat 0 says "this hatch does
      // not attenuate at all". `ModuleGraph.makeEdge` recomputes it, so the sim
      // never noticed; but this is the SAME Port object that ships to every
      // client inside `welcome.layout`, and the client reads the field (see
      // `src/station/station.ts`). Keep the cache honest.
      syncHatchAttenuation(p);
      const key = portKey(side.module, side.port);
      let snapshot = this.state.hatches.get(key);
      if (!snapshot) {
        snapshot = new HatchSchema();
        snapshot.portId = key;
        this.state.hatches.set(key, snapshot);
      }
      snapshot.open = p.hatch.open;
      snapshot.sealed = p.hatch.sealed;
    }

    // THE most likely runtime bug in the whole foundation: the graph caches
    // hatch state on its edges. Refresh after ANY change.
    this.station.graph.refreshHatches();
  }

  private systemOnline(system: EscapeSystemId): void {
    const before = this.director.systemsOnline;
    this.director.systemOnline(system);
    if (this.director.systemsOnline === before) return;
    this.syncDirector();
    this.broadcastMsg('stage', {
      stage: this.director.stage,
      systemsOnline: this.director.systemsOnline,
    });
    console.log(
      `[round] system '${system}' online (${this.director.systemsOnline}/${SYSTEMS_TO_ESCAPE})`,
    );
  }

  private toast(id: PlayerId, text: string): void {
    const client = this.clients.find((c) => c.sessionId === id);
    if (client) this.sendTo(client, 'toast', { text });
  }

  private applyPuzzleResult(result: PuzzleInteractResult): void {
    if (!result.changed) return;

    // §5's stage-4 trigger is "all systems / undock live", and the second half
    // is not implied by the first: SYSTEMS_TO_ESCAPE is 4 of the 5 gating
    // puzzles (§11), so a crew that skipped one can be running the finale at
    // stage 3. The real director also hears this through `onUndocked`; both
    // paths are idempotent, and this is the one the fallback director has.
    if (result.puzzle.id === 'undock-sequence' && result.puzzle.solved) {
      const before = this.director.stage;
      this.director.undockLive?.();
      if (this.director.stage !== before) {
        this.syncDirector();
        this.broadcastMsg('stage', {
          stage: this.director.stage,
          systemsOnline: this.director.systemsOnline,
        });
        console.log(`[director] stage ${this.director.stage} — undock live`);
      }
    }

    const snapshot = this.state.puzzles.get(result.puzzle.id);
    if (snapshot) {
      snapshot.stateJson = safeJson(result.puzzle.state);
      snapshot.solved = result.puzzle.solved;
    }
    this.broadcastMsg('puzzle', {
      id: result.puzzle.id as PuzzleId,
      state: result.puzzle.state,
      solved: result.puzzle.solved,
    });
    for (const system of result.systemsUnlocked) this.systemOnline(system);
  }

  // =========================================================================
  // round management
  // =========================================================================

  /** §10's constrained random roll, for everyone at once. */
  private startRound(): void {
    const ids: PlayerId[] = [];
    this.state.players.forEach((p) => ids.push(p.id));

    this.items.reset();
    this.puzzles.reset();
    this.director.reset();
    this.router.reset();
    this.alien.reset();
    // Every module back to the gravity the LEVEL authored — a round always
    // starts exactly as designed, which is why §14 pins stage 0's
    // `gravityFailures` at zero.
    this.gravity.reset();
    this.hideEntryDue.clear();
    this.footstepAt.clear();
    this.deadOrder = [];
    this.escapedOrder = [];
    this.seedGravity();
    this.seedHatches();
    this.seedPuzzles();
    this.syncResources();
    this.syncDirector();

    const plan = solveSpawns(this.station.graph, this.station.layout, ids, this.rng);
    for (const relaxed of plan.relaxed) console.warn(`[spawn] ${relaxed}`);

    this.state.players.forEach((player) => {
      player.alive = true;
      player.escaped = false;
      player.spectating = '';
      player.charge = 0;
      player.heartRate = 60;
      player.items.clear();
      player.gripId = '';
      player.hideSpot = '';
      player.gait = 'walk';
      this.placePlayer(player, plan.players.get(player.id) ?? this.station.layout.modules[0].id);
      player.state = defaultStateFor(this.station.graph.gravityOf(player.module));
    });

    // The alien's own frame: it rides at `DECK_RIDE_HEIGHT_M` in a walking
    // module, so start it there rather than have `walkDeck` ease it 10 cm on
    // the first tick of every round.
    const alienPos = spawnPointIn(this.station.graph, plan.alien, this.station.rails, ALIEN_RADIUS);
    this.alien.spawn(plan.alien, alienPos, this.context());
    // §5's FSM starts DORMANT, and `spawn()` leaves it there so an alien in a
    // LOBBY does not wander. The round is now live, so wake it: §10's reunion
    // phase is "a quiet, dread-heavy reunion phase", not a safe one, and the
    // fairness floor that makes the opening survivable is the three-hop spawn
    // separation above — never an undisclosed free head start. Without this the
    // alien's own DORMANT backstop is the only wake-up and the first seconds of
    // every round are provably safe.
    this.alien.wake?.(this.context());
    this.syncAlien();

    this.roundStartedAtMs = Date.now();
    this.state.startedAtMs = this.roundStartedAtMs;
    this.state.phase = 'RUNNING';

    for (const client of this.clients) {
      const player = this.state.players.get(client.sessionId);
      this.sendTo(client, 'roundStart', {
        seed: config.seed,
        tick: this.state.tick,
        startedAtMs: this.roundStartedAtMs,
        spawn: player ? { module: player.module, pos: player.pos.toVec3() } : null,
      });
      this.sendInventory(client);
    }

    console.log(
      `[round] started — ${ids.length} player(s), alien in '${plan.alien}', ` +
        `spawns: ${[...plan.players.entries()].map(([id, m]) => `${id}@${m}`).join(', ')}`,
    );
  }

  private placePlayer(player: PlayerSchema, module: ModuleId): void {
    // EYE height, not body-centre height: `TransformMessage.pos` is the camera
    // in both regimes (§4), so a spawn expressed in any other frame puts the
    // capsule through the plating. `EYE_HEIGHT_STAND_M` because everybody wakes
    // standing — `player.gait` is reset to 'walk' three lines above the caller.
    const pos = spawnPointIn(this.station.graph, module, this.station.rails, EYE_HEIGHT_STAND_M);
    player.module = module;
    player.pos.set(pos);
    this.spawnGraceUntil.set(player.id, Date.now() + SPAWN_GRACE_S * 1000);
    this.lastTransformAt.delete(player.id);
    this.footstepAt.delete(player.id);
    this.breathTimer.set(player.id, 2 + this.rng() * 2);
  }

  private checkRoundEnd(): void {
    if (this.state.phase !== 'RUNNING') return;
    if (this.state.players.size === 0) return;

    let living = 0;
    this.state.players.forEach((p) => {
      if (p.alive && !p.escaped) living++;
    });
    if (living > 0) return;

    const escaped = [...this.escapedOrder];
    const dead: PlayerId[] = [];
    this.state.players.forEach((p) => {
      if (!escaped.includes(p.id)) dead.push(p.id);
    });

    const result: RoundResult = {
      escaped,
      dead,
      // §10: escaping with three of six is a WIN.
      win: escaped.length >= WIN_MIN_SURVIVORS,
      durationMs: Date.now() - this.roundStartedAtMs,
      finalStage: this.director.stage,
    };
    this.state.phase = 'ENDED';
    this.broadcastMsg('roundEnd', { result });
    console.log(
      `[round] ended — crew recovered ${escaped.length}/${this.state.players.size}, ` +
        `${result.win ? 'WIN' : 'LOSS'}, stage ${result.finalStage}, ` +
        `${(result.durationMs / 1000).toFixed(0)}s`,
    );
  }

  // =========================================================================
  // state sync helpers
  // =========================================================================

  /**
   * §7's single alien accessor. Anti-cheat is deliberately skipped today, so
   * this returns everything to everybody — but it is the ONE place to change if
   * the game ever leaves the group chat. Filtering here (plus moving the alien
   * out of the shared schema into a per-client message) is the whole change.
   */
  getAlienForClient(_playerId: PlayerId | null): AlienSnapshot {
    return {
      pos: this.alien.pos,
      quat: this.alien.quat,
      state: this.alien.state,
      module: this.alien.module,
    };
  }

  private syncAlien(): void {
    const view = this.getAlienForClient(null);
    this.state.alien.pos.set(view.pos);
    this.state.alien.quat.set(view.quat);
    this.state.alien.state = view.state;
    this.state.alien.module = view.module;
  }

  private syncDirector(): void {
    const d: DirectorSchema = this.state.director;
    d.stage = this.director.stage;
    d.systemsOnline = this.director.systemsOnline;
    d.msToNextFreeStage = this.director.msToNextFreeStage;
  }

  private syncResources(): void {
    this.state.decoysRemaining = this.items.decoysRemaining;
    this.state.sealCharges = this.items.sealCharges;
  }

  // -- gravity (§4's per-module condition, §5's escalation beat) ------------

  /**
   * Mirror `ModuleGraph.gravitySnapshot()` into the room state.
   *
   * The map is CONTINUOUS state, not just the ephemeral `gravity` message, and
   * the difference matters: the message is the ANNOUNCEMENT, with its 2.5 s of
   * warning, and a client that joined late or dropped a packet still has to know
   * which rooms have a floor. Getting that wrong is a player walking into a wall
   * or stepping off one, so the truth is synced and the announcement is the
   * drama.
   *
   * Writes are diffed (`ModuleGravitySchema.apply` returns whether anything
   * changed) because this runs at 20 Hz over every module and Colyseus encodes
   * per-field deltas.
   */
  private syncGravity(): void {
    for (const snap of this.station.graph.gravitySnapshot()) {
      let row = this.state.gravity.get(snap.module);
      if (!row) {
        row = new ModuleGravitySchema();
        this.state.gravity.set(snap.module, row);
      }
      row.apply(snap);
    }
  }

  /** Build the map from scratch — room start and every round start. */
  private seedGravity(): void {
    this.state.gravity.clear();
    this.syncGravity();
  }

  /**
   * One tick of §4's gravity machine.
   *
   * `GravityDirector.update` advances every announced countdown and returns the
   * changes that LANDED. For each, the room does the two things only it can:
   * emit the `gravity-shift` NoiseEvent **at the module centre** — nobody caused
   * it, so nobody is blamed for it, but at 35 the alien hears it and moves, and
   * that is what makes a failure an event on the map rather than weather — and
   * tell every client, so the floor arriving or leaving is never a surprise the
   * renderer has to infer.
   *
   * Note the noise fires on the LANDING, not on the announcement. §4 orders the
   * beat "2.5 s of warning, then the noise at 35, then everyone standing gets a
   * `liftoff`", and the warning is a client-side wind-down driven by the
   * `gravity` message's `inMs`. Emitting at announce time instead would have the
   * alien converging on the room during the warning, which is a sharper beat and
   * a different design; if that is ever wanted, move the `emitNoise` call into
   * `announceGravity` and nothing else changes.
   */
  private updateGravity(dtMs: number, ctx: SimContext): void {
    const { announced, landed } = this.gravity.update(dtMs, ctx);
    for (const event of announced) this.announceGravity(event);
    for (const event of landed) {
      const centre = this.station.graph.centre(event.module);
      if (centre) {
        this.emitNoise('gravity-shift', centre, event.module);
      }
      this.broadcastMsg('gravity', event);
      console.log(
        `[gravity] '${event.module}' ${event.from} -> ${event.to} (${event.cause})` +
          ` — ${this.station.graph.zeroGCount()} module(s) floorless`,
      );
    }
    this.syncGravity();
  }

  /**
   * The one door into a gravity change (§4: "Route gravity changes through the
   * announced path; the immediate setter exists for level load and puzzle
   * scripting, not for anything the player is meant to survive").
   *
   * Runs the director's full eligibility gate — budget, escape and finale
   * modules, rails and a route out, no two floorless modules adjacent, no cut
   * vertex of the walking graph — so a puzzle cannot drop the floor somewhere
   * that traps somebody just by asking nicely.
   */
  private requestGravity(module: ModuleId, mode: GravityMode, cause: GravityCause): boolean {
    // Both paths push their announcement onto the director's own queue, which
    // `updateGravity` drains at the top of the next tick — so a puzzle-driven
    // change is broadcast by exactly the same code as a director-driven one and
    // there is no second place for the warning to be forgotten.
    const event =
      mode === 'zero'
        ? this.gravity.drop(module, this.context(), cause)
        : this.gravity.restore(module, this.state.tick, cause);
    return event !== null;
  }

  /** Tell everyone a change is coming, and how long they have. */
  private announceGravity(event: GravityShiftEvent): void {
    this.broadcastMsg('gravity', event);
    this.syncGravity();
    console.log(
      `[gravity] '${event.module}' ${event.from} -> ${event.to} in ${event.inMs}ms (${event.cause})`,
    );
  }

  private seedHatches(): void {
    this.state.hatches.clear();
    for (const module of this.station.layout.modules) {
      for (const port of module.ports) {
        if (!port.link) continue;
        port.hatch.open = true;
        port.hatch.sealed = false;
        // The layout may have been authored with any attenuation at all (or
        // none); every round starts every linked hatch open, so the cached dB
        // has to start at HATCH_OPEN. This layout object is what `welcome`
        // ships to clients.
        syncHatchAttenuation(port);
        const snapshot = new HatchSchema();
        snapshot.portId = portKey(module.id, port.id);
        snapshot.open = true;
        snapshot.sealed = false;
        this.state.hatches.set(snapshot.portId, snapshot);
      }
    }
    this.station.graph.refreshHatches();
  }

  private seedPuzzles(): void {
    this.state.puzzles.clear();
    for (const puzzle of this.puzzles.puzzles) {
      const snapshot = new PuzzleSchema();
      snapshot.id = puzzle.id;
      snapshot.module = puzzle.module;
      snapshot.stateJson = safeJson(puzzle.state);
      snapshot.solved = puzzle.solved;
      snapshot.gates.push(...puzzle.gates);
      this.state.puzzles.set(puzzle.id, snapshot);
    }
  }

  /** The join handshake: the station itself, the ICE config, your spawn. */
  private sendWelcome(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    const peers: PlayerId[] = [];
    this.state.players.forEach((p) => {
      if (p.id !== client.sessionId) peers.push(p.id);
    });
    this.sendTo(client, 'welcome', {
      sessionId: client.sessionId,
      tick: this.state.tick,
      phase: this.state.phase as RoundPhase,
      layout: this.station.layout,
      iceServers: iceServers(),
      spawn:
        player && this.state.phase === 'RUNNING'
          ? { module: player.module, pos: player.pos.toVec3() }
          : null,
      peers,
      decoysRemaining: this.items.decoysRemaining,
      sealCharges: this.items.sealCharges,
      serverTimeMs: Date.now(),
    });
  }

  private sendInventory(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    this.sendTo(client, 'inventory', {
      items: [...player.items] as ItemKind[],
      decoysRemaining: this.items.decoysRemaining,
      sealCharges: this.items.sealCharges,
    });
  }

  // =========================================================================
  // small helpers
  // =========================================================================

  private context(): SimContext {
    if (this.ctxCache && this.ctxCache.tick === this.state.tick) return this.ctxCache.ctx;
    const ctx: SimContext = {
      graph: this.station.graph,
      rails: this.station.rails,
      hideSpots: this.station.hides,
      layout: this.station.layout,
      tick: this.state.tick,
      now: Date.now(),
      stage: this.director.stage as DirectorStage,
      systemsOnline: this.director.systemsOnline,
      players: this.playerViews(),
      rng: this.rng,
      emitNoise: (kind, pos, module, opts) => this.emitNoise(kind, pos, module, opts ?? {}),
      killPlayer: (id, cause) => this.killPlayer(id, cause),
      setHatch: (module, port, open, sealed) => this.setHatch(module, port, open, sealed ?? false),
      systemOnline: (system) => this.systemOnline(system),
      toast: (id, text) => this.toast(id, text),
      setGravity: (module, mode, cause) => this.requestGravity(module, mode, cause ?? 'puzzle'),
    };
    this.ctxCache = { tick: this.state.tick, ctx };
    return ctx;
  }

  private playerViews(): PlayerView[] {
    const out: PlayerView[] = [];
    this.state.players.forEach((p) => {
      out.push({
        id: p.id,
        pos: p.pos.toVec3(),
        module: p.module,
        alive: p.alive,
        escaped: p.escaped,
        heartRate: p.heartRate,
        gait: p.gait as Gait,
        hideSpot: p.hideSpot === '' ? null : p.hideSpot,
      });
    });
    return out;
  }

  private hasItem(player: PlayerSchema, item: ItemKind): boolean {
    return player.items.indexOf(item) >= 0;
  }

  private takeItem(player: PlayerSchema, item: ItemKind): boolean {
    const index = player.items.indexOf(item);
    if (index < 0) return false;
    player.items.splice(index, 1);
    return true;
  }

  private propWorldPos(moduleId: ModuleId, propId: string): Vec3 | undefined {
    const module = this.station.graph.get(moduleId);
    const prop = module?.props.find((p) => p.id === propId);
    if (!module || !prop) return undefined;
    const t = module.transform;
    // Props are authored in module space; modules are axis-aligned in the
    // built-in layout, but do the full transform anyway.
    const q = t.quat;
    const v = prop.localPos;
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return {
      x: v.x + q.w * tx + (q.y * tz - q.z * ty) + t.pos.x,
      y: v.y + q.w * ty + (q.z * tx - q.x * tz) + t.pos.y,
      z: v.z + q.w * tz + (q.x * ty - q.y * tx) + t.pos.z,
    };
  }

  private sendTo<K extends keyof ServerMessages & string>(
    client: Client,
    type: K,
    payload: ServerMessages[K],
  ): void {
    client.send(type, payload);
  }

  private broadcastMsg<K extends keyof ServerMessages & string>(
    type: K,
    payload: ServerMessages[K],
  ): void {
    this.broadcast(type, payload);
  }
}

/**
 * Coerce whatever arrived on the wire into a `Gait`.
 *
 * Never throws and never rejects: an unknown gait becomes `walk`, exactly as
 * `gaitProfile()` does in §14, so one malformed packet costs a player one
 * mis-priced footstep rather than a disconnect.
 */
function normaliseGait(value: unknown): Gait {
  return (GAITS as readonly string[]).includes(value as string) ? (value as Gait) : 'walk';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}
