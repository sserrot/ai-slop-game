/**
 * Typed pub/sub (DESIGN.md §1 `src/core/` — "game loop, fixed-timestep ticker,
 * event bus").
 *
 * Subsystems talk through this instead of importing each other: the noise
 * system emits, audio and UI listen, and nobody has to know who else is awake.
 * Handlers are invoked synchronously in registration order; a throwing handler
 * is reported and skipped so one bad listener cannot take down a frame.
 */

/** Call it to stop listening. Idempotent. */
export type Unsubscribe = () => void;

export type Handler<T> = (payload: T) => void;

export class EventBus<M extends object> {
  private readonly handlers = new Map<keyof M, Set<Handler<never>>>();
  private readonly onceHandlers = new WeakSet<Handler<never>>();

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof M>(type: K, handler: Handler<M[K]>): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.off(type, handler);
    };
  }

  /** Subscribe for exactly one emission. */
  once<K extends keyof M>(type: K, handler: Handler<M[K]>): Unsubscribe {
    this.onceHandlers.add(handler as Handler<never>);
    return this.on(type, handler);
  }

  off<K extends keyof M>(type: K, handler: Handler<M[K]>): void {
    const set = this.handlers.get(type);
    if (!set) return;
    set.delete(handler as Handler<never>);
    if (set.size === 0) this.handlers.delete(type);
  }

  /** Publish. Safe to subscribe or unsubscribe from inside a handler. */
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return;
    // Snapshot: handlers may add or remove listeners while we iterate.
    for (const handler of [...set]) {
      if (this.onceHandlers.has(handler)) {
        set.delete(handler);
        this.onceHandlers.delete(handler);
      }
      try {
        (handler as Handler<M[K]>)(payload);
      } catch (err) {
        console.error(`[eventBus] handler for '${String(type)}' threw:`, err);
      }
    }
    if (set.size === 0) this.handlers.delete(type);
  }

  listenerCount<K extends keyof M>(type: K): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  /** Drop listeners for one event, or all of them when called with no argument. */
  clear<K extends keyof M>(type?: K): void {
    if (type === undefined) this.handlers.clear();
    else this.handlers.delete(type);
  }
}

// ---------------------------------------------------------------------------
// The application-wide bus
// ---------------------------------------------------------------------------

import type {
  AlienState,
  DeathMessage,
  DirectorStage,
  GravityCause,
  GravityMode,
  GravityShiftEvent,
  ListenerResolution,
  ModuleId,
  NoiseEvent,
  PlayerId,
  PlayerState,
  PortId,
  PuzzleId,
  RailKey,
  RoundResult,
  Vec3,
} from '@shared/types';

/**
 * Cross-subsystem events. Add to this interface rather than inventing a second
 * bus — the whole point is one place to look for "who reacts to what".
 */
export interface GameEvents {
  // -- noise (§3) ---------------------------------------------------------
  /** A sound was made, locally or remotely. Audio and the noise ring listen. */
  'noise:emitted': { event: NoiseEvent };
  /** What the local player actually hears, already resolved through the graph.
   *  `resolution.throughPort` is where audio must pan it (§8). */
  'noise:heard': { event: NoiseEvent; resolution: ListenerResolution };
  /** The local player made a sound: expand the noise ring by how far it carried (§6). */
  'noise:self': { event: NoiseEvent; carriedMetres: number };

  // -- player (§4) --------------------------------------------------------
  'player:state': { id: PlayerId; state: PlayerState; gripId: RailKey | null };
  'player:module': { id: PlayerId; from: ModuleId | null; to: ModuleId };
  'player:charge': { charge: number };
  'player:heartRate': { bpm: number; intensity: number };
  'player:joined': { id: PlayerId };
  'player:left': { id: PlayerId };
  'player:died': DeathMessage;
  'player:revived': { id: PlayerId; by: PlayerId };

  // -- alien (§5) ---------------------------------------------------------
  'alien:state': { from: AlienState; to: AlienState };
  'alien:moved': { pos: Vec3; module: ModuleId };
  /** Distance used by the wrist tracker's pulse rate (§6). */
  'alien:proximity': { metres: number; hops: number };

  // -- station (§2) -------------------------------------------------------
  'hatch:changed': { module: ModuleId; port: PortId; open: boolean; sealed: boolean };
  'module:entered': { module: ModuleId };
  'cull:changed': { visible: readonly ModuleId[] };

  // -- gravity (§4's per-module condition, §5's escalation beat) -----------
  /**
   * A module is ABOUT to change regime — `inMs` ahead of the fact, and 2.5 s
   * of it by default (`GRAVITY_WARNING_S`). This is the fairness guarantee: the
   * floor never simply vanishes under anybody, so anything that reacts to a
   * failure should react to THIS, not to the one below.
   */
  'gravity:warning': GravityShiftEvent;
  /**
   * The change landed. `origin` is the MODULE CENTRE, because nobody caused it
   * and nobody is blamed for it; `loudness` is `LOUDNESS.GRAVITY_SHIFT` (35).
   * Structurally `StationGravity`'s own `GravityShift`.
   */
  'gravity:changed': {
    module: ModuleId;
    from: GravityMode;
    to: GravityMode;
    cause: GravityCause;
    origin: Vec3;
    loudness: number;
    t: number;
  };

  // -- director & puzzles (§5, §11) --------------------------------------
  'director:stage': { stage: DirectorStage; systemsOnline: number };
  'puzzle:changed': { id: PuzzleId; solved: boolean };
  'system:online': { systemsOnline: number };

  // -- round (§10) --------------------------------------------------------
  'round:started': { seed: number };
  'round:ended': RoundResult;

  // -- net (§7) -----------------------------------------------------------
  'net:connected': { sessionId: string };
  'net:disconnected': { code: number };
  'net:tick': { tick: number };

  // -- ui -----------------------------------------------------------------
  'ui:toast': { text: string; ms?: number };
  'ui:trackerMute': { muted: boolean };
}

/** The shared instance. Import this; construct your own only for tests. */
export const bus = new EventBus<GameEvents>();
