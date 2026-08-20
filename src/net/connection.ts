/**
 * The Colyseus client (DESIGN.md §7).
 *
 * Responsibilities, and nothing else:
 *   - connect / join / reconnect, and hand back the `welcome` (the station
 *     layout and the ICE config live in it);
 *   - typed send and receive wrappers for every message in the protocol;
 *   - mirror room state into plain snapshots, and INTERPOLATE remote players
 *     and the alien (§7 — no prediction for anyone, including yourself);
 *   - re-publish what happened on the shared `bus` so the rest of the client
 *     never has to know Colyseus exists.
 *
 * You are authoritative for your own transform. Call `sendTransform()` every
 * fixed tick and ignore what the server echoes back for yourself — the only
 * thing it will ever say about your position is a `correction`, and that only
 * when you moved faster than a full push-off (§7 speed sanity check).
 */

import { Client, Room } from 'colyseus.js';
import {
  ATTENUATION_PER_M,
  FLOOR,
  MAX_DIRECTOR_STAGE,
  TICK_MS,
  VOICE_LEVEL_HZ,
  clamp,
} from '@shared/constants';
import { GAITS } from '@shared/types';
import type {
  AlienSnapshot,
  AlienState,
  DirectorSnapshot,
  DirectorStage,
  Gait,
  GravityMode,
  HatchSnapshot,
  HideSpotId,
  ModuleGravitySnapshot,
  ModuleId,
  NoiseEvent,
  NoiseKind,
  PlayerId,
  PlayerSnapshot,
  PlayerState,
  PortId,
  PuzzleId,
  PuzzleSnapshot,
  Quat,
  RailKey,
  StationLayout,
  StationState,
  TransformMessage,
  Vec3,
} from '@shared/types';
import { distance } from '@shared/graph/math';
import { propagationBuffer, type PropagationBuffer } from '@shared/graph/noise';
import {
  ModuleGraph,
  PASSABLE_ALIEN,
  parsePortKey,
  portKey,
  syncHatchAttenuation,
} from '@shared/graph/moduleGraph';
import { resolveFor } from '@shared/graph/noise';
import { bus, type Unsubscribe } from '../core/eventBus';
import {
  INTERP_DELAY_MS,
  InterpolatedBody,
  transformBuffer,
  type InterpolatedTransform,
} from './interpolation';
import type {
  ClientMessages,
  IceServerConfig,
  ItemKind,
  RoundPhase,
  ServerMessages,
  WelcomeMessage,
} from './protocol';

// ---------------------------------------------------------------------------
// The decoded room state, structurally
// ---------------------------------------------------------------------------
//
// The server's `@colyseus/schema` classes are Node-side code; the browser gets
// the same shape back through schema reflection. Describing it structurally
// keeps the client bundle free of anything under `server/`.

interface MapLike<T> {
  get(key: string): T | undefined;
  forEach(cb: (value: T, key: string) => void): void;
  readonly size: number;
}

interface ListLike<T> {
  readonly length: number;
  [index: number]: T;
}

interface DecodedPlayer {
  id: string;
  name: string;
  pos: Vec3;
  quat: Quat;
  state: string;
  gripId: string;
  module: string;
  alive: boolean;
  charge: number;
  heartRate: number;
  escaped: boolean;
  spectating: string;
  /** §4's risk dial, and authoritative: the server prices every footstep and
   *  landing from THIS, not from the gait on a noise packet. */
  gait: string;
  /** `${module}:${spot}`, or `''` for "not in one" — schema has no null. */
  hideSpot: string;
  items: ListLike<string>;
}

/** One row of §7's per-module gravity map (`ModuleGravitySchema`). */
interface DecodedGravity {
  module: string;
  gravity: string;
  /** `''` when nothing is pending — the schema cannot carry a null. */
  pending: string;
  pendingMs: number;
}

interface DecodedAlien {
  pos: Vec3;
  quat: Quat;
  state: string;
  module: string;
}

interface DecodedHatch {
  portId: string;
  open: boolean;
  sealed: boolean;
}

interface DecodedPuzzle {
  id: string;
  module: string;
  stateJson: string;
  solved: boolean;
  gates: ListLike<string>;
}

interface DecodedDirector {
  stage: number;
  systemsOnline: number;
  msToNextFreeStage: number;
}

export interface DecodedState {
  players: MapLike<DecodedPlayer>;
  alien: DecodedAlien;
  /**
   * Per-module gravity (§4), keyed by `ModuleId`.
   *
   * This is CONTINUOUS state, unlike the `gravity` message: the message is the
   * 2.5 s announcement and the drama, this is the truth a client that joined
   * late or dropped a packet needs so it does not walk somebody off a floor
   * that is still there.
   */
  gravity: MapLike<DecodedGravity>;
  hatches: MapLike<DecodedHatch>;
  puzzles: MapLike<DecodedPuzzle>;
  director: DecodedDirector;
  tick: number;
  phase: string;
  layoutId: string;
  decoysRemaining: number;
  sealCharges: number;
  startedAtMs: number;
}

// ---------------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------------

/** A player as the server last reported them. */
export interface PlayerView extends PlayerSnapshot {
  name: string;
  escaped: boolean;
  /** Module a dead player is watching through the cameras (§10). */
  spectating: ModuleId;
  items: ItemKind[];
}

/** A remote player, transform interpolated for this frame (§7). */
export interface RemoteBodyView {
  id: PlayerId;
  pos: Vec3;
  quat: Quat;
  module: ModuleId;
  state: PlayerState;
  gripId: RailKey | null;
  alive: boolean;
  escaped: boolean;
  heartRate: number;
  name: string;
  /** True when we have run out of buffered samples and are holding the last. */
  stale: boolean;
}

export interface NetClientOptions {
  /** `ws://host:port`. Defaults to `VITE_SERVER_URL`, else the page host on
   *  port 2567, else `ws://127.0.0.1:2567`. A `localhost` page host is dialled
   *  as `127.0.0.1` — see `serverHost` for the 300 ms that buys. */
  endpoint?: string;
  /** Room name. Must match the server's `gameServer.define()`. */
  roomName?: string;
  /** Display name, cosmetic. */
  name?: string;
  /** Render remote bodies this far in the past. Two ticks by default. */
  interpolationDelayMs?: number;
  /** Re-publish incoming events on the shared `bus`. Default true. */
  emitBusEvents?: boolean;
  /**
   * Resolve every incoming noise against the local listener and emit
   * `noise:heard` / `noise:self` (§3 + §8). Default true — it makes audio work
   * out of the box. Turn it OFF if `src/noise/` resolves the events itself, or
   * every sound will be handled twice.
   */
  resolveNoise?: boolean;
  /** Try to rejoin once when the connection drops unexpectedly. Default true. */
  autoReconnect?: boolean;
}

type MessageHandler<T> = (payload: T) => void;

const DEFAULT_ROOM = 'station';

/** Hoisted `{ passable }` for the per-tick alien hop query — a fresh options
 *  literal 20 times a second for a constant. */
const ALIEN_HOPS = Object.freeze({ passable: PASSABLE_ALIEN });

/** Port `server/index.ts` listens on by default (see its `PORT` env var). */
const DEFAULT_SERVER_PORT = 2567;

/**
 * Loopback host to dial instead of `localhost`.
 *
 * On Windows (and any dual-stack box) `localhost` resolves to BOTH `::1` and
 * `127.0.0.1`, and Chrome tries `::1` first. `server/index.ts` binds `0.0.0.0`
 * — IPv4 only — so the v6 attempt has to time out before Happy Eyeballs falls
 * back. Measured on the dev box: `ws://localhost` opens in 309 ms,
 * `ws://127.0.0.1` in 15 ms, and that 300 ms lands squarely in the middle of
 * boot, before the `welcome` message that the whole station build waits on.
 *
 * Only the loopback name is rewritten. A real hostname, an IP, or an explicit
 * `VITE_SERVER_URL` is passed through untouched, so nothing about deployment or
 * LAN play changes.
 */
const LOOPBACK_HOST = '127.0.0.1';

function serverHost(hostname: string): string {
  return hostname.toLowerCase() === 'localhost' ? LOOPBACK_HOST : hostname;
}

function defaultEndpoint(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const configured = env?.VITE_SERVER_URL;
    if (configured) return configured;
  } catch {
    /* not running under Vite */
  }
  if (typeof location !== 'undefined' && location.hostname) {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${serverHost(location.hostname)}:${DEFAULT_SERVER_PORT}`;
  }
  return `ws://${LOOPBACK_HOST}:${DEFAULT_SERVER_PORT}`;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

// ---------------------------------------------------------------------------
// NetClient
// ---------------------------------------------------------------------------

export class NetClient {
  private readonly opts: Required<Omit<NetClientOptions, 'name' | 'endpoint'>> &
    Pick<NetClientOptions, 'name'> & { endpoint: string };

  private client: Client | null = null;
  private _room: Room<DecodedState> | null = null;
  private _welcome: WelcomeMessage | null = null;
  private _graph: ModuleGraph | null = null;
  private _peers = new Set<PlayerId>();
  private _inventory: ItemKind[] = [];
  private _decoys = 0;
  private _seals = 0;
  private _connected = false;
  private reconnectToken = '';
  private reconnecting = false;

  private readonly bodies = new Map<PlayerId, InterpolatedBody<DecodedPlayer>>();
  private readonly alienBody = new InterpolatedBody<{ state: AlienState; module: ModuleId }>();

  /**
   * Reusable render-rate views (§7).
   *
   * `remoteBodies()` and `alien()` are called once per RENDERED frame, but the
   * data behind them only changes at the 20 Hz tick. Handing back fresh objects
   * meant four allocations per body per frame — twenty a frame in a six-player
   * round — for values the renderer copies straight into a `Vector3`. The views
   * are owned by this client, keyed by session id, and refilled in place. They
   * are documented as such at both call sites: read them, never keep them.
   */
  private readonly bodyViews = new Map<PlayerId, RemoteBodyView>();
  private readonly bodyViewList: RemoteBodyView[] = [];
  private readonly bodySamples = new Map<PlayerId, InterpolatedTransform>();
  private readonly alienSample: InterpolatedTransform = transformBuffer();
  private readonly alienView: AlienSnapshot & { stale: boolean } = {
    pos: this.alienSample.pos,
    quat: this.alienSample.quat,
    state: 'PATROL' as AlienState,
    module: '',
    stale: false,
  };

  /** Reused by `gravity()` — see the note there. */
  private readonly gravityViews: ModuleGravitySnapshot[] = [];
  /** This client's propagation buffer for the §3 graph walk on inbound noise.
   *  The walk never escapes `handleNoise`; the resolution it produces does, and
   *  that one is built fresh. */
  private readonly propagationBuf: PropagationBuffer = propagationBuffer();
  /** Backing store for `gravityViews`, grown once and refilled. */
  private readonly gravityPool: ModuleGravitySnapshot[] = [];
  /** Ids seen in the current `update()` pass, reused between ticks. */
  private readonly seenIds = new Set<PlayerId>();
  /** Ids to drop after an `update()` pass — collected, then deleted, so the map
   *  is not mutated while it is being iterated. */
  private readonly staleIds: PlayerId[] = [];
  /** Alien interpolation metadata, refilled per tick rather than re-minted. */
  private readonly alienMeta: { state: AlienState; module: ModuleId } = {
    state: 'DORMANT',
    module: '',
  };

  private lastTick = -1;
  private lastAlienState: AlienState | null = null;
  private lastModules = new Map<PlayerId, ModuleId>();
  private lastHatches = new Map<string, { open: boolean; sealed: boolean }>();

  private lastTransformSentAt = 0;
  private lastVoiceSentAt = 0;

  /** Extra listeners layered on top of `room.onMessage`, so several subsystems
   *  can listen to the same message without fighting over the single handler. */
  private readonly listeners = new Map<string, Set<MessageHandler<never>>>();

  constructor(options: NetClientOptions = {}) {
    this.opts = {
      endpoint: options.endpoint ?? defaultEndpoint(),
      roomName: options.roomName ?? DEFAULT_ROOM,
      name: options.name,
      interpolationDelayMs: options.interpolationDelayMs ?? INTERP_DELAY_MS,
      emitBusEvents: options.emitBusEvents ?? true,
      resolveNoise: options.resolveNoise ?? true,
      autoReconnect: options.autoReconnect ?? true,
    };
  }

  // -- connection -----------------------------------------------------------

  get connected(): boolean {
    return this._connected;
  }

  get sessionId(): PlayerId {
    return this._room?.sessionId ?? '';
  }

  get room(): Room<DecodedState> | null {
    return this._room;
  }

  get state(): DecodedState | null {
    return this._room?.state ?? null;
  }

  get welcome(): WelcomeMessage | null {
    return this._welcome;
  }

  /** The station, as the SERVER built it. Build your graphs from this (§2). */
  get layout(): StationLayout | null {
    return this._welcome?.layout ?? null;
  }

  /** A `ModuleGraph` over that layout, kept in step with hatch changes. Handy
   *  for anything that needs propagation before `src/station/` is up. */
  get graph(): ModuleGraph | null {
    return this._graph;
  }

  /** ICE servers for the voice mesh — feed straight to `RTCPeerConnection` (§7). */
  get iceServers(): IceServerConfig[] {
    return this._welcome?.iceServers ?? [];
  }

  /** Everyone else in the room, for the voice mesh. */
  get peers(): PlayerId[] {
    return [...this._peers];
  }

  get inventory(): ItemKind[] {
    return [...this._inventory];
  }

  get decoysRemaining(): number {
    return this._decoys;
  }

  get sealCharges(): number {
    return this._seals;
  }

  get phase(): RoundPhase {
    return (this.state?.phase as RoundPhase) ?? 'LOBBY';
  }

  get tick(): number {
    return this.state?.tick ?? 0;
  }

  /**
   * Join the room. Resolves with the `welcome` message — the station layout,
   * the ICE config and your spawn.
   */
  async connect(): Promise<WelcomeMessage> {
    if (this._room) return this._welcome ?? (await this.awaitWelcome());
    this.client = new Client(this.opts.endpoint);
    const room = await this.client.joinOrCreate<DecodedState>(this.opts.roomName, {
      name: this.opts.name,
    });
    this.attach(room);
    // The server re-sends `welcome` on `ready`, which closes the race between
    // joining and having handlers registered.
    this.send('ready', { name: this.opts.name });
    return this.awaitWelcome();
  }

  /** Leave for good. */
  async disconnect(): Promise<void> {
    this.opts.autoReconnect = false;
    const room = this._room;
    this._room = null;
    this._connected = false;
    if (room) {
      try {
        await room.leave(true);
      } catch {
        /* already gone */
      }
    }
    this.reset();
  }

  private attach(room: Room<DecodedState>): void {
    this._room = room;
    this._connected = true;
    this.reconnectToken = room.reconnectionToken;

    room.onMessage('*', (type: string | number, payload: unknown) => {
      this.handleMessage(String(type), payload);
    });

    room.onError((code, message) => {
      console.error(`[net] room error ${code}: ${message ?? ''}`);
    });

    room.onLeave((code) => {
      this._connected = false;
      if (this.opts.emitBusEvents) bus.emit('net:disconnected', { code });
      // 1000 / 4000 are consented closes.
      const expected = code === 1000 || code === 4000;
      if (!expected && this.opts.autoReconnect && !this.reconnecting) {
        void this.tryReconnect();
      }
    });

    if (this.opts.emitBusEvents) bus.emit('net:connected', { sessionId: room.sessionId });
  }

  private async tryReconnect(): Promise<void> {
    if (!this.client || !this.reconnectToken) return;
    this.reconnecting = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const room = await this.client.reconnect<DecodedState>(this.reconnectToken);
      this.attach(room);
      this.send('ready', { name: this.opts.name });
      console.log('[net] reconnected');
    } catch (err) {
      // Colyseus rejects with plain objects as often as with Errors.
      const why = err instanceof Error ? err.message : JSON.stringify(err);
      console.warn('[net] reconnect failed:', why);
    } finally {
      this.reconnecting = false;
    }
  }

  private awaitWelcome(timeoutMs = 8000): Promise<WelcomeMessage> {
    if (this._welcome) return Promise.resolve(this._welcome);
    return new Promise<WelcomeMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('net: no welcome message from the server'));
      }, timeoutMs);
      const off = this.on('welcome', (msg) => {
        clearTimeout(timer);
        off();
        resolve(msg);
      });
    });
  }

  // -- typed send -----------------------------------------------------------

  /** Raw typed send. The convenience wrappers below are usually what you want. */
  send<K extends keyof ClientMessages & string>(type: K, payload: ClientMessages[K]): void {
    this._room?.send(type, payload);
  }

  /**
   * §7: you own your movement. Call this every fixed tick; it is throttled to
   * the server tick rate, so calling it per frame is harmless.
   */
  sendTransform(msg: TransformMessage, force = false): void {
    const now = nowMs();
    if (!force && now - this.lastTransformSentAt < TICK_MS - 5) return;
    this.lastTransformSentAt = now;
    this.send('transform', msg);
  }

  /**
   * "I made this sound." The server re-derives the loudness from §14, so do not
   * bother sending one — just say what you did, where, and how fast you were
   * going for `catch` / `impact`.
   */
  sendNoise(
    kind: NoiseKind,
    pos: Vec3,
    module: ModuleId,
    speed?: number,
    gait?: Gait,
    hidden?: boolean,
  ): void {
    // `gait` and `hidden` are the two extra facts a `footstep` or `landing`
    // needs (§14 `footstepLoudness` / `landingNoise`). Note the server does not
    // TRUST either — it prices them off the gait on your last transform and its
    // own record of who is in a locker — but the contract carries them and a
    // client that omits them is asserting nothing at all, which is worse.
    this.send('noise', {
      kind,
      pos,
      module,
      ...(speed === undefined ? {} : { speed }),
      ...(gait === undefined ? {} : { gait }),
      ...(hidden ? { hidden: true } : {}),
    });
  }

  /**
   * Climb into, or out of, a hide spot (§4).
   *
   * The ONLY way into `PlayerState.HIDDEN`: a client that simply sets the state
   * on a transform is quietly corrected back to the regime default. `haste`
   * (0–1) is the loud-fast / quiet-slow dial — 0 is 2.5 s at loudness 8, 1 is
   * 0.5 s at 30 — and the server runs the timer, so a last-second dive cannot
   * buy back a careful entry.
   */
  sendHide(module: ModuleId, spot: HideSpotId, action: 'enter' | 'exit', haste: number): void {
    this.send('hide', { module, spot, action, haste: clamp(haste, 0, 1) });
  }

  sendInteract(targetId: string, action: string, value?: number | string | boolean): void {
    this.send('interact', value === undefined ? { targetId, action } : { targetId, action, value });
  }

  /** Calibrated 0–1 mic level, post-AGC (§7). Throttled to VOICE_LEVEL_HZ. */
  sendVoiceLevel(level: number): void {
    const now = nowMs();
    if (now - this.lastVoiceSentAt < 1000 / VOICE_LEVEL_HZ - 5) return;
    this.lastVoiceSentAt = now;
    this.send('voiceLevel', { level: clamp(level, 0, 1) });
  }

  sendHatch(module: ModuleId, port: PortId, action: 'open' | 'close' | 'seal'): void {
    this.send('hatch', { module, port, action });
  }

  /** WebRTC signalling, relayed by the room (§7 voice mesh). */
  sendSignal(to: PlayerId, data: unknown): void {
    this.send('signal', { to, data });
  }

  sendReady(name?: string): void {
    this.send('ready', name === undefined ? {} : { name });
  }

  /** Ask the server to start (or restart) the round (§10 spawns). */
  startRound(): void {
    this.sendInteract('round', 'start');
  }

  restartRound(): void {
    this.sendInteract('round', 'restart');
  }

  // -- typed receive --------------------------------------------------------

  /**
   * Subscribe to a server message. Several subsystems may listen to the same
   * message; returns an unsubscribe.
   */
  on<K extends keyof ServerMessages & string>(
    type: K,
    handler: MessageHandler<ServerMessages[K]>,
  ): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as MessageHandler<never>);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      set?.delete(handler as MessageHandler<never>);
    };
  }

  private emitLocal(type: string, payload: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as MessageHandler<unknown>)(payload);
      } catch (err) {
        console.error(`[net] handler for '${type}' threw:`, err);
      }
    }
  }

  private handleMessage(type: string, payload: unknown): void {
    switch (type) {
      case 'welcome': {
        const msg = payload as WelcomeMessage;
        this._welcome = msg;
        this._decoys = msg.decoysRemaining;
        this._seals = msg.sealCharges;
        this._peers = new Set(msg.peers);
        this.buildGraph(msg.layout);
        break;
      }
      case 'peerJoin':
        this._peers.add((payload as ServerMessages['peerJoin']).id);
        if (this.opts.emitBusEvents) {
          bus.emit('player:joined', { id: (payload as ServerMessages['peerJoin']).id });
        }
        break;
      case 'peerLeave':
        this._peers.delete((payload as ServerMessages['peerLeave']).id);
        if (this.opts.emitBusEvents) {
          bus.emit('player:left', { id: (payload as ServerMessages['peerLeave']).id });
        }
        break;
      case 'inventory': {
        const msg = payload as ServerMessages['inventory'];
        this._inventory = [...msg.items];
        this._decoys = msg.decoysRemaining;
        this._seals = msg.sealCharges;
        break;
      }
      case 'noise':
        this.handleNoise(payload as ServerMessages['noise']);
        break;
      case 'death':
        if (this.opts.emitBusEvents) bus.emit('player:died', payload as ServerMessages['death']);
        break;
      case 'stage': {
        const msg = payload as ServerMessages['stage'];
        if (this.opts.emitBusEvents) {
          bus.emit('director:stage', { stage: msg.stage, systemsOnline: msg.systemsOnline });
          bus.emit('system:online', { systemsOnline: msg.systemsOnline });
        }
        break;
      }
      case 'puzzle': {
        const msg = payload as ServerMessages['puzzle'];
        if (this.opts.emitBusEvents) {
          bus.emit('puzzle:changed', { id: msg.id, solved: msg.solved });
        }
        break;
      }
      case 'roundStart': {
        const msg = payload as ServerMessages['roundStart'];
        if (this.opts.emitBusEvents) bus.emit('round:started', { seed: msg.seed });
        break;
      }
      case 'roundEnd': {
        const msg = payload as ServerMessages['roundEnd'];
        if (this.opts.emitBusEvents) bus.emit('round:ended', msg.result);
        break;
      }
      case 'revived': {
        const msg = payload as ServerMessages['revived'];
        if (this.opts.emitBusEvents) bus.emit('player:revived', { id: msg.id, by: msg.by });
        break;
      }
      case 'toast': {
        const msg = payload as ServerMessages['toast'];
        if (this.opts.emitBusEvents) bus.emit('ui:toast', { text: msg.text });
        break;
      }
      default:
        break;
    }
    this.emitLocal(type, payload);
  }

  /**
   * The server sends the event; every client resolves it locally with the same
   * shared code (§3), which is what lets audio pan it at the hatch it came
   * through (§8).
   */
  private handleNoise(msg: ServerMessages['noise']): void {
    const event: NoiseEvent = {
      kind: msg.kind,
      origin: msg.pos,
      module: msg.module,
      // The server sends SOURCE loudness; attenuation is per listener.
      loudness: msg.level,
      t: msg.t,
    };
    if (msg.actor !== undefined) event.actor = msg.actor;

    if (this.opts.emitBusEvents) bus.emit('noise:emitted', { event });
    if (!this.opts.resolveNoise || !this.opts.emitBusEvents) return;

    // The raw schema player, not `localPlayer()`: materialising a whole
    // `PlayerView` (four objects and an items array) to read three fields, once
    // per noise message, is the sort of thing a six-player round does fifteen
    // times a second.
    const me = this.state?.players.get(this.sessionId);
    if (!me || !this._graph) return;
    const ear = me.alive ? me.module : (this.localSpectating() ?? me.module);
    // The propagation buffer is this client's own and nothing keeps the walk —
    // `resolveFor` returns a freshly built resolution, which is what goes out
    // on the bus.
    const resolution = resolveFor(event, this._graph, me.pos, ear, undefined, this.propagationBuf);
    if (resolution.audible) bus.emit('noise:heard', { event, resolution });

    if (event.actor === this.sessionId) {
      // The noise ring is scaled to how far the sound actually carried (§6):
      // the distance at which it decays to the audibility floor.
      const carried = Math.max(0, (event.loudness - FLOOR) / ATTENUATION_PER_M);
      bus.emit('noise:self', { event, carriedMetres: carried });
    }
  }

  // -- state mirroring ------------------------------------------------------

  /**
   * Pump. Call once per fixed tick (or per frame — it no-ops between server
   * patches). Pushes interpolation samples and publishes state diffs on the bus.
   */
  update(at: number = nowMs()): void {
    const state = this.state;
    if (!state) return;
    if (state.tick === this.lastTick) return;
    this.lastTick = state.tick;

    if (this.opts.emitBusEvents) bus.emit('net:tick', { tick: state.tick });

    this._decoys = state.decoysRemaining;
    this._seals = state.sealCharges;

    // players
    const seen = this.seenIds;
    seen.clear();
    state.players.forEach((player) => {
      seen.add(player.id);
      if (player.id !== this.sessionId) {
        let body = this.bodies.get(player.id);
        if (!body) {
          body = new InterpolatedBody<DecodedPlayer>();
          this.bodies.set(player.id, body);
        }
        body.update(at, player.pos, player.quat, player);
      }
      const was = this.lastModules.get(player.id) ?? null;
      if (was !== player.module) {
        this.lastModules.set(player.id, player.module);
        if (this.opts.emitBusEvents) {
          bus.emit('player:module', { id: player.id, from: was, to: player.module });
        }
      }
    });
    // `[...map.keys()]` twice a tick, purely to iterate a map we are about to
    // delete from. Collect into a buffer we own instead.
    const stale = this.staleIds;
    stale.length = 0;
    for (const id of this.bodies.keys()) if (!seen.has(id)) stale.push(id);
    for (let i = 0; i < stale.length; i++) {
      const id = stale[i]!;
      this.bodies.delete(id);
      // The reusable view and its sample buffer go with the body they describe.
      this.bodyViews.delete(id);
      this.bodySamples.delete(id);
    }
    stale.length = 0;
    for (const id of this.lastModules.keys()) if (!seen.has(id)) stale.push(id);
    for (let i = 0; i < stale.length; i++) this.lastModules.delete(stale[i]!);
    stale.length = 0;

    // alien (§7: synced to everyone, tracker pulse computed client-side)
    const alienState = state.alien.state as AlienState;
    const alienMeta = this.alienMeta;
    alienMeta.state = alienState;
    alienMeta.module = state.alien.module;
    this.alienBody.update(at, state.alien.pos, state.alien.quat, alienMeta);
    if (this.opts.emitBusEvents) {
      if (this.lastAlienState !== alienState) {
        const from = this.lastAlienState ?? 'DORMANT';
        this.lastAlienState = alienState;
        bus.emit('alien:state', { from, to: alienState });
      }
      bus.emit('alien:moved', { pos: state.alien.pos, module: state.alien.module });

      const me = this.state?.players.get(this.sessionId);
      if (me) {
        const metres = distance(me.pos, state.alien.pos);
        const hops = this._graph
          ? this._graph.hopDistance(me.module, state.alien.module, ALIEN_HOPS)
          : -1;
        bus.emit('alien:proximity', { metres, hops });
      }
    }

    this.syncHatches(state);
  }

  /** Apply hatch changes to the local graph and announce them (§2, §8). */
  private syncHatches(state: DecodedState): void {
    let changed = false;
    state.hatches.forEach((hatch) => {
      const previous = this.lastHatches.get(hatch.portId);
      if (previous && previous.open === hatch.open && previous.sealed === hatch.sealed) return;
      // Mutate the cache entry rather than replacing it — but only AFTER
      // `previous` has been read, since the two are the same object.
      const changedFrom = previous !== undefined;
      if (previous) {
        previous.open = hatch.open;
        previous.sealed = hatch.sealed;
      } else {
        this.lastHatches.set(hatch.portId, { open: hatch.open, sealed: hatch.sealed });
      }
      const { module, port } = parsePortKey(hatch.portId);
      const p = this._graph?.port(module, port);
      if (p) {
        p.hatch.open = hatch.open;
        p.hatch.sealed = hatch.sealed;
        syncHatchAttenuation(p);
        changed = true;
      }
      if (changedFrom && this.opts.emitBusEvents) {
        bus.emit('hatch:changed', {
          module,
          port,
          open: hatch.open,
          sealed: hatch.sealed,
        });
      }
    });
    // The graph caches hatch state on its edges — refresh after ANY change.
    if (changed) this._graph?.refreshHatches();
  }

  private buildGraph(layout: StationLayout): void {
    try {
      this._graph = new ModuleGraph(layout.modules);
      const problems = this._graph.validate();
      for (const problem of problems) console.warn(`[net] layout: ${problem}`);
    } catch (err) {
      console.error('[net] could not build the module graph:', err);
      this._graph = null;
    }
  }

  // -- reading --------------------------------------------------------------

  players(): PlayerView[] {
    const out: PlayerView[] = [];
    this.state?.players.forEach((p) => out.push(toPlayerView(p)));
    return out;
  }

  /**
   * How many crew are still in the round — alive, or already out of the airlock
   * (§10). Counted straight off the room state.
   *
   * `players().filter(p => p.alive || p.escaped).length` is the same number and
   * was the per-tick idiom; it built an array, a `PlayerView` per player, and a
   * `pos`/`quat`/`items` triple inside each, then threw all of it away. This is
   * the same answer for no allocation at all.
   */
  crewAlive(): number {
    let alive = 0;
    this.state?.players.forEach((p) => {
      if (p.alive || p.escaped) alive++;
    });
    return alive;
  }

  /** Number of players in the room, however they are doing. */
  crewCount(): number {
    return this.state?.players.size ?? 0;
  }

  /**
   * The server's own heart rate for the local player (§6's second trace), or
   * null if the room has not seen us yet. One field, so it does not go through
   * `localPlayer()` and its five objects.
   */
  localHeartRate(): number | null {
    const me = this.state?.players.get(this.sessionId);
    return me ? me.heartRate : null;
  }

  player(id: PlayerId): PlayerView | null {
    const p = this.state?.players.get(id);
    return p ? toPlayerView(p) : null;
  }

  localPlayer(): PlayerView | null {
    return this.player(this.sessionId);
  }

  private localSpectating(): ModuleId | null {
    const raw = this.state?.players.get(this.sessionId);
    return raw && raw.spectating ? raw.spectating : null;
  }

  /**
   * Every player except you, transforms interpolated for `at` (§7).
   * Your own body is yours: draw it from the controller, never from here.
   *
   * REUSED between calls, views and vectors alike — the array, each
   * `RemoteBodyView` in it and the `pos`/`quat` on those views all belong to
   * this client. Read what you need inside the loop (the renderer copies into a
   * `Vector3`, the voice mesh clones the position); never hold one across a
   * frame. `players()` still returns fresh snapshots if you need to keep one.
   */
  remoteBodies(at: number = nowMs()): RemoteBodyView[] {
    const renderTime = at - this.opts.interpolationDelayMs;
    const out = this.bodyViewList;
    out.length = 0;
    for (const [id, body] of this.bodies) {
      const meta = body.meta;
      if (!meta) continue;
      let buffer = this.bodySamples.get(id);
      if (!buffer) {
        buffer = transformBuffer();
        this.bodySamples.set(id, buffer);
      }
      const sample = body.sampleInto(renderTime, buffer);
      if (!sample) continue;
      let view = this.bodyViews.get(id);
      if (!view) {
        view = {
          id,
          pos: sample.pos,
          quat: sample.quat,
          module: '',
          state: 'FLOATING' as PlayerState,
          gripId: null,
          alive: true,
          escaped: false,
          heartRate: 0,
          name: '',
          stale: false,
        };
        this.bodyViews.set(id, view);
      }
      view.module = meta.module;
      view.state = meta.state as PlayerState;
      view.gripId = meta.gripId === '' ? null : meta.gripId;
      view.alive = meta.alive;
      view.escaped = meta.escaped;
      view.heartRate = meta.heartRate;
      view.name = meta.name;
      view.stale = sample.extrapolated;
      out.push(view);
    }
    return out;
  }

  /** The alien, interpolated (§7 — anti-cheat is deliberately skipped).
   *  Reused between calls, exactly like `remoteBodies()`. */
  alien(at: number = nowMs()): (AlienSnapshot & { stale: boolean }) | null {
    const meta = this.alienBody.meta;
    const sample: InterpolatedTransform | null = this.alienBody.sampleInto(
      at - this.opts.interpolationDelayMs,
      this.alienSample,
    );
    if (!meta || !sample) return null;
    this.alienView.state = meta.state;
    this.alienView.module = meta.module;
    this.alienView.stale = sample.extrapolated;
    return this.alienView;
  }

  /**
   * §7's per-module gravity array (§4).
   *
   * REUSED between calls, like `remoteBodies()`: this is read once per fixed
   * tick and handed straight to `Station.applyGravitySnapshots`, which diffs it
   * and only touches the modules that actually changed. Read it, never keep it.
   */
  gravity(): ModuleGravitySnapshot[] {
    const out = this.gravityViews;
    const pool = this.gravityPool;
    out.length = 0;
    this.state?.gravity.forEach((g) => {
      // The records are pooled too, not just the array: this is called on every
      // fixed tick (twice, in the current wiring) and minted nine object
      // literals each time for values the caller diffs and drops.
      let view = pool[out.length];
      if (!view) {
        view = { module: '', gravity: 'nominal', pending: null, pendingMs: 0 };
        pool.push(view);
      }
      const pending = g.pending === '' ? null : (g.pending as GravityMode);
      view.module = g.module;
      view.gravity = g.gravity as GravityMode;
      view.pending = pending;
      view.pendingMs = pending === null ? 0 : g.pendingMs;
      out.push(view);
    });
    return out;
  }

  hatches(): HatchSnapshot[] {
    const out: HatchSnapshot[] = [];
    this.state?.hatches.forEach((h) =>
      out.push({ portId: h.portId, open: h.open, sealed: h.sealed }),
    );
    return out;
  }

  hatch(module: ModuleId, port: PortId): HatchSnapshot | null {
    const h = this.state?.hatches.get(portKey(module, port));
    return h ? { portId: h.portId, open: h.open, sealed: h.sealed } : null;
  }

  puzzles(): PuzzleSnapshot[] {
    const out: PuzzleSnapshot[] = [];
    this.state?.puzzles.forEach((p) => out.push(toPuzzleSnapshot(p)));
    return out;
  }

  puzzle(id: PuzzleId): PuzzleSnapshot | null {
    const p = this.state?.puzzles.get(id);
    return p ? toPuzzleSnapshot(p) : null;
  }

  director(): DirectorSnapshot {
    const d = this.state?.director;
    const stage = clamp(Math.round(d?.stage ?? 0), 0, MAX_DIRECTOR_STAGE) as DirectorStage;
    return {
      stage,
      systemsOnline: d?.systemsOnline ?? 0,
      msToNextFreeStage: d?.msToNextFreeStage ?? 0,
    };
  }

  /** Plain-object mirror of the whole room, matching `StationState`. */
  snapshot(): StationState | null {
    const state = this.state;
    if (!state) return null;
    const alien = this.alienBody.meta;
    return {
      players: this.players(),
      alien: {
        pos: state.alien.pos,
        quat: state.alien.quat,
        state: (alien?.state ?? state.alien.state) as AlienState,
        module: state.alien.module,
      },
      gravity: this.gravity(),
      hatches: this.hatches(),
      puzzles: this.puzzles(),
      director: this.director(),
      tick: state.tick,
    };
  }

  private reset(): void {
    this.bodies.clear();
    this.bodyViews.clear();
    this.bodySamples.clear();
    this.bodyViewList.length = 0;
    this.alienBody.clear();
    this.lastModules.clear();
    this.lastHatches.clear();
    this._peers.clear();
    this.lastTick = -1;
    this.lastAlienState = null;
  }
}

function toPlayerView(p: DecodedPlayer): PlayerView {
  const items: ItemKind[] = [];
  for (let i = 0; i < p.items.length; i++) items.push(p.items[i] as ItemKind);
  return {
    id: p.id,
    name: p.name,
    pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
    quat: { x: p.quat.x, y: p.quat.y, z: p.quat.z, w: p.quat.w },
    state: p.state as PlayerState,
    gripId: p.gripId === '' ? null : p.gripId,
    module: p.module,
    alive: p.alive,
    charge: p.charge,
    heartRate: p.heartRate,
    // An older or hand-rolled server that never sets these leaves a walking,
    // un-hidden player, which is the pivot's own default (§2, §4).
    gait: isGait(p.gait) ? p.gait : 'walk',
    hideSpot: p.hideSpot ? p.hideSpot : null,
    escaped: p.escaped,
    spectating: p.spectating,
    items,
  };
}

function isGait(value: string): value is Gait {
  return (GAITS as readonly string[]).includes(value);
}

function toPuzzleSnapshot(p: DecodedPuzzle): PuzzleSnapshot {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(p.stateJson);
  } catch {
    parsed = {};
  }
  return { id: p.id as PuzzleId, state: parsed, solved: p.solved };
}

/** The shared instance most of the client should use. */
export const net = new NetClient();
