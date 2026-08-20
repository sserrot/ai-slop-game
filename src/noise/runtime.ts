/**
 * The client-side noise runtime (DESIGN.md §3, feeding §6 and §8).
 *
 * One job: take every noise that happens — from the network or from a local
 * system — run the SHARED propagation against the station graph, and publish
 * what the local listener actually hears.
 *
 *   net / local system  ->  NoiseRuntime.ingest()
 *                              |
 *                              +-- bus 'noise:emitted'  (everything, for debug/UI)
 *                              +-- bus 'noise:heard'    (audible remote sound)
 *                              +-- bus 'noise:self'     (your own mistake, §6 ring)
 *                              +-- onHeard() subscribers (audio, §8)
 *
 * The graph walk is expensive relative to the per-listener part, so we call
 * `propagate()` once per event and `resolve()` once — there is exactly one
 * local listener on a client. `resolveAt()` exists for the systems that need a
 * continuous answer (proximity voice, the alien's hunting vocalisation).
 */

import {
  ATTENUATION_PER_M,
  FLOOR,
  clamp,
  noiseLoudness,
} from '@shared/constants';
import type {
  ListenerResolution,
  ModuleId,
  NoiseEvent,
  NoiseKind,
  NoiseMessage,
  PlayerId,
  Vec3,
} from '@shared/types';
import { cloneV3, distance, v3 } from '@shared/graph/math';
import type { ModuleGraph } from '@shared/graph/moduleGraph';
import {
  propagate,
  propagationBuffer,
  type Propagation,
  type PropagationBuffer,
  type PropagationOptions,
} from '@shared/graph/noise';

/** Frozen `{}` for the no-cap case — `propagate(event, graph, {})` minted one
 *  options object per noise event for a default. */
const NO_PROPAGATION_OPTIONS: PropagationOptions = Object.freeze({});

import type { EventBus, Unsubscribe } from '../core/eventBus';
import { bus as defaultBus, type GameEvents } from '../core/eventBus';
import { carryReport } from './carry';
import type { HeardNoise, ListenerPose, NoiseSource } from './types';

export interface NoiseRuntimeOptions {
  /** Event bus to publish on. Defaults to the shared `bus`. */
  bus?: EventBus<GameEvents>;
  /** Station graph. Can be supplied later with `setGraph()`. */
  graph?: ModuleGraph;
  /** Session id of the local player, so self noise can be recognised. */
  localPlayerId?: PlayerId;
  /** Clock in ms. Defaults to `performance.now`. */
  now?: () => number;
  /** How long `recent()` remembers. Default 5000 ms. */
  historyMs?: number;
  /** Hard cap on remembered events. Default 96. */
  historyLimit?: number;
  /** Optional hop cull on propagation. Leave unset — §3 stops at the floor,
   *  which is the honest bound; a hop cap is a performance escape hatch. */
  maxHops?: number;
  /**
   * Window in which a server echo of our own noise is swallowed, in ms. We play
   * self noise the instant it happens (§8: you must feel the mistake as you make
   * it), so the round trip must not play it a second time. Default 900 ms.
   */
  selfEchoWindowMs?: number;
  /**
   * Call `graph.refreshHatches()` when a 'hatch:changed' event goes past. The
   * foundation calls a stale hatch cache the most likely runtime bug in the
   * project; this is the belt to the station's braces. Default true.
   */
  autoRefreshHatches?: boolean;
}

type HeardHandler = (heard: HeardNoise) => void;

const DEFAULT_HISTORY_MS = 5000;
const DEFAULT_HISTORY_LIMIT = 96;
const DEFAULT_SELF_ECHO_MS = 900;

const defaultNow: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

export class NoiseRuntime {
  private readonly bus: EventBus<GameEvents>;
  private readonly now: () => number;
  private readonly historyMs: number;
  private readonly historyLimit: number;
  private readonly selfEchoWindowMs: number;
  private readonly autoRefreshHatches: boolean;
  private readonly maxHops: number | undefined;

  private moduleGraph: ModuleGraph | null = null;
  private localId: PlayerId | null = null;
  private pose: ListenerPose = { pos: v3(), module: '' };

  private readonly handlers = new Set<HeardHandler>();
  private history: HeardNoise[] = [];
  /** kind -> client-clock ms we last emitted it ourselves. Echo suppression. */
  private readonly selfEmitted = new Map<NoiseKind, number>();
  /** Bus subscriptions, owned by attach()/detach(). */
  private subscriptions: Unsubscribe[] = [];
  /** Network subscriptions, owned by connect(). Survives attach(). */
  private sourceSubscriptions: Unsubscribe[] = [];
  /**
   * This runtime's own propagation buffer (§3's graph walk, reused).
   *
   * There is exactly one local listener, and `ingest()` finishes with the
   * propagation before it returns — `resolve()` and `carryReport()` both read
   * it synchronously and neither keeps it. What escapes is the
   * `ListenerResolution`, which `resolve()` builds fresh every call.
   *
   * `propagate()` is the single most expensive allocation in the client:
   * measured at 7.4 KB per event before this, times ten to fifteen events a
   * second in a six-player round.
   */
  private readonly propagationBuf: PropagationBuffer = propagationBuffer();
  /** Snapshot of `handlers` for a safe iteration. Refilled, never rebuilt. */
  private readonly handlerScratch: HeardHandler[] = [];
  /** Depth of `ingest`'s handler dispatch, so a re-entrant emit does not
   *  overwrite the snapshot the outer dispatch is walking. */
  private dispatching = 0;
  /** `{ maxHops }`, rebuilt only when `maxHops` changes (it never does). */
  private readonly hopOptions: { maxHops?: number } = {};
  /** The event `resolveAt()` fills for a continuous source. Never escapes. */
  private readonly continuousEvent: NoiseEvent = {
    kind: 'voice',
    origin: v3(),
    module: '',
    loudness: 0,
    t: 0,
  };

  constructor(opts: NoiseRuntimeOptions = {}) {
    this.bus = opts.bus ?? defaultBus;
    this.now = opts.now ?? defaultNow;
    this.historyMs = opts.historyMs ?? DEFAULT_HISTORY_MS;
    this.historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.selfEchoWindowMs = opts.selfEchoWindowMs ?? DEFAULT_SELF_ECHO_MS;
    this.autoRefreshHatches = opts.autoRefreshHatches ?? true;
    this.maxHops = opts.maxHops;
    if (opts.graph) this.moduleGraph = opts.graph;
    if (opts.localPlayerId) this.localId = opts.localPlayerId;
  }

  // -----------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------

  /** Subscribe to the bus events the runtime reacts to. Returns a teardown. */
  attach(): Unsubscribe {
    this.detach();
    if (this.autoRefreshHatches) {
      this.subscriptions.push(
        this.bus.on('hatch:changed', () => {
          // Propagation and pathfinding read a cached hatch state on the edges.
          this.moduleGraph?.refreshHatches();
        }),
      );
    }
    this.subscriptions.push(
      this.bus.on('player:module', ({ id, to }) => {
        if (this.localId !== null && id === this.localId) this.pose.module = to;
      }),
    );
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.detach();
    };
  }

  /**
   * Subscribe to the server's `noise` broadcasts. Anything with an `onNoise`
   * method will do — see `NoiseSource`. Returns a teardown.
   */
  connect(source: NoiseSource): Unsubscribe {
    const off = source.onNoise((msg) => {
      this.ingestMessage(msg);
    });
    this.sourceSubscriptions.push(off);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      off();
      const i = this.sourceSubscriptions.indexOf(off);
      if (i >= 0) this.sourceSubscriptions.splice(i, 1);
    };
  }

  /** Drop the bus subscriptions. Network sources survive — use `dispose()`. */
  detach(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
  }

  /** Drop everything: bus subscriptions, network sources and history. */
  dispose(): void {
    this.detach();
    for (const off of this.sourceSubscriptions) off();
    this.sourceSubscriptions = [];
    this.handlers.clear();
    this.reset();
  }

  setGraph(graph: ModuleGraph | null): void {
    this.moduleGraph = graph;
  }

  get graph(): ModuleGraph | null {
    return this.moduleGraph;
  }

  setLocalPlayer(id: PlayerId | null): void {
    this.localId = id;
  }

  get localPlayerId(): PlayerId | null {
    return this.localId;
  }

  /** Where the ears are. Call it every frame from the player controller.
   *  Writes into the pose it already owns rather than replacing it — the
   *  runtime is the only writer and `listener` is documented read-only. */
  setListener(pos: Vec3, module: ModuleId): void {
    const p = this.pose.pos;
    p.x = pos.x;
    p.y = pos.y;
    p.z = pos.z;
    this.pose.module = module;
  }

  get listener(): Readonly<ListenerPose> {
    return this.pose;
  }

  // -----------------------------------------------------------------------
  // Ingest
  // -----------------------------------------------------------------------

  /**
   * Run one event through the graph and publish the result.
   *
   * Returns the resolved noise, or null when it was swallowed: inaudible
   * remote sound, or the server echoing back something we already played.
   */
  ingest(event: NoiseEvent, opts: { self?: boolean; force?: boolean } = {}): HeardNoise | null {
    const at = this.now();
    const isSelf =
      opts.self ?? (this.localId !== null && event.actor !== undefined && event.actor === this.localId);

    if (isSelf && !opts.force && this.isEcho(event.kind, at)) return null;

    // The shared buffer, not `propagate()`: nothing below keeps the propagation
    // — `resolve()` mints its own result and `carryReport()` reads and returns
    // two numbers — and both happen before any handler runs, so a handler that
    // emits a noise of its own cannot pull the rug out.
    const propagation = this.propagateShared(event);
    const resolution = isSelf
      ? selfResolution(event)
      : propagation.resolve(this.pose.pos, this.pose.module);
    const carry = carryReport(propagation);

    const heard: HeardNoise = {
      event,
      resolution,
      self: isSelf,
      carriedMetres: carry.metres,
      modulesReached: carry.modules,
      at,
    };

    this.remember(heard, at);
    this.bus.emit('noise:emitted', { event });

    if (isSelf) {
      // §8: your own noise is always audible to you, at full volume, on the
      // body bus. It deliberately does not go out as 'noise:heard' — that would
      // spatialise it through the graph and play it twice.
      this.bus.emit('noise:self', { event, carriedMetres: carry.metres });
    } else if (resolution.audible) {
      this.bus.emit('noise:heard', { event, resolution });
    }

    if (isSelf || resolution.audible) {
      // Snapshot into a buffer we already own — handlers may subscribe or
      // unsubscribe from inside the loop, which is what the copy is for; it
      // never needed to be a fresh array. A handler that emits a noise of its
      // own re-enters here, and that one gets a fresh array so it cannot
      // rewrite the list the outer loop is walking.
      const reentrant = this.dispatching > 0;
      const snapshot = reentrant ? ([] as HeardHandler[]) : this.handlerScratch;
      snapshot.length = 0;
      for (const handler of this.handlers) snapshot.push(handler);
      this.dispatching++;
      try {
        for (let i = 0; i < snapshot.length; i++) {
          try {
            snapshot[i](heard);
          } catch (err) {
            console.error('[noise] heard handler threw:', err);
          }
        }
      } finally {
        this.dispatching--;
        snapshot.length = 0;
      }
    }

    return isSelf || resolution.audible ? heard : null;
  }

  /** Ingest a server broadcast (§7 ephemeral `noise` message). */
  ingestMessage(msg: NoiseMessage): HeardNoise | null {
    const event: NoiseEvent = {
      kind: msg.kind,
      origin: cloneV3(msg.pos),
      module: msg.module,
      loudness: msg.level,
      t: msg.t,
      ...(msg.actor !== undefined ? { actor: msg.actor } : {}),
    };
    return this.ingest(event);
  }

  /**
   * Emit a noise the local player just made. Plays instantly and locally; the
   * caller (see `NoiseEmitter`) forwards the intent to the server separately.
   */
  emitSelf(event: NoiseEvent): HeardNoise | null {
    this.selfEmitted.set(event.kind, this.now());
    return this.ingest(event, { self: true, force: true });
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Propagate without publishing anything. The result is freshly allocated and
   *  yours to keep — see `propagateShared` for the hot path. */
  propagate(event: NoiseEvent): Propagation {
    if (this.moduleGraph) {
      return propagate(event, this.moduleGraph, this.propagationOptions());
    }
    return degeneratePropagation(event);
  }

  /**
   * `propagate()` into this runtime's own buffer. Valid until the next call —
   * read it, never keep it. Everything internal uses this; the public
   * `propagate()` above still hands back a fresh one.
   */
  private propagateShared(event: NoiseEvent): Propagation {
    if (this.moduleGraph) {
      return propagate(event, this.moduleGraph, this.propagationOptions(), this.propagationBuf);
    }
    return degeneratePropagation(event);
  }

  /** `{ maxHops }` or `{}` — hoisted so the hot path does not mint an options
   *  object per event. Never mutated. */
  private propagationOptions(): PropagationOptions {
    if (this.maxHops === undefined) return NO_PROPAGATION_OPTIONS;
    if (this.hopOptions.maxHops !== this.maxHops) this.hopOptions.maxHops = this.maxHops;
    return this.hopOptions;
  }

  /**
   * Continuous version, for sources that move: proximity voice (§7) and the
   * alien's hunting vocalisation (§5). `loudness` is the SOURCE loudness; pass
   * `noiseLoudness(kind, …)` unless you have a calibrated value.
   */
  resolveAt(origin: Vec3, module: ModuleId, loudness: number, kind: NoiseKind = 'voice'): ListenerResolution {
    // Continuous sources ask this several times a second, per peer (§7 voice)
    // and per gravity warning (§8). The event never leaves this call — only the
    // resolution does, and `resolve()` builds that fresh — so it is a buffer.
    const event = this.continuousEvent;
    event.kind = kind;
    event.origin.x = origin.x;
    event.origin.y = origin.y;
    event.origin.z = origin.z;
    event.module = module;
    event.loudness = loudness;
    event.t = 0;
    return this.propagateShared(event).resolve(this.pose.pos, this.pose.module);
  }

  /** Source loudness for a kind, straight from §14 — never invent one. */
  loudnessOf(kind: NoiseKind, opts: { speed?: number; intensity?: number } = {}): number {
    return noiseLoudness(kind, opts);
  }

  /** Noises resolved within the last `withinMs` (default: the history window). */
  recent(withinMs: number = this.historyMs): readonly HeardNoise[] {
    const cutoff = this.now() - withinMs;
    return this.history.filter((h) => h.at >= cutoff);
  }

  /** Subscribe to every noise the local listener hears (including self). */
  onHeard(handler: HeardHandler): Unsubscribe {
    this.handlers.add(handler);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.handlers.delete(handler);
    };
  }

  /** Round reset. */
  reset(): void {
    this.history = [];
    this.selfEmitted.clear();
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private isEcho(kind: NoiseKind, at: number): boolean {
    const last = this.selfEmitted.get(kind);
    if (last === undefined) return false;
    return at - last <= this.selfEchoWindowMs;
  }

  private remember(heard: HeardNoise, at: number): void {
    const history = this.history;
    history.push(heard);
    const cutoff = at - this.historyMs;
    let start = 0;
    while (start < history.length && history[start].at < cutoff) start++;
    if (history.length - start > this.historyLimit) {
      start = history.length - this.historyLimit;
    }
    // Compact in place. `slice()` twice per event built two arrays for what is
    // almost always a one-element trim.
    if (start > 0) {
      const kept = history.length - start;
      for (let i = 0; i < kept; i++) history[i] = history[i + start];
      history.length = kept;
    }
  }
}

/** Zero-distance, unoccluded, always audible — what you hear of yourself. */
function selfResolution(event: NoiseEvent): ListenerResolution {
  return {
    level: event.loudness,
    audible: true,
    throughPort: null,
    panPosition: cloneV3(event.origin),
    distance: 0,
    hops: 0,
    hatchDb: 0,
    worstHatchDb: 0,
    occluded: false,
  };
}

/**
 * Fallback for the pre-M2 world (and for unit-testing a single room): no
 * station graph, so everything is treated as same-module free field with the
 * §3 linear falloff. Keeps M0/M1 playable before `station/` lands.
 */
function degeneratePropagation(event: NoiseEvent): Propagation {
  const arrival = {
    module: event.module,
    level: event.loudness,
    hops: 0,
    distance: 0,
    hatchDb: 0,
    worstHatchDb: 0,
    throughPort: null,
    entryPoint: cloneV3(event.origin),
    via: null,
  };
  const arrivals = new Map([[event.module, arrival]]);
  const levels = new Map([[event.module, event.loudness]]);

  return {
    event,
    levels,
    arrivals,
    reaches: (module: ModuleId) => module === event.module,
    resolve: (listenerPos: Vec3, listenerModule: ModuleId): ListenerResolution => {
      const sameModule = listenerModule === event.module || listenerModule === '' || event.module === '';
      const d = distance(event.origin, listenerPos);
      const level = sameModule ? event.loudness - ATTENUATION_PER_M * d : 0;
      return {
        level: clamp(level, 0, 100),
        audible: sameModule && level >= FLOOR,
        throughPort: null,
        panPosition: cloneV3(event.origin),
        distance: sameModule ? d : Number.MAX_VALUE,
        hops: sameModule ? 0 : -1,
        hatchDb: 0,
        worstHatchDb: 0,
        occluded: false,
      };
    },
  };
}
