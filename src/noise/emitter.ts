/**
 * Making noise (DESIGN.md §3 loudness table, §6 noise ring, §7 client authority).
 *
 * Every other subsystem calls this instead of building NoiseEvents by hand, so
 * that:
 *   1. loudness always comes from `noiseLoudness()` — §14, never invented;
 *   2. the local player hears their own mistake instantly, with no round trip
 *      (§8: "they have to feel the mistake as they make it");
 *   3. the intent goes to the server, which re-derives the loudness itself (§7 —
 *      clients own movement, not how loud they were).
 *
 *   emitter.railPull(pos, module);
 *   emitter.catchRail(pos, module, speed);     // 8 + 3v
 *   emitter.impact(pos, module, speed);        // 15 + 6v
 *   emitter.knock(pos, module);                // the §10 knock-code primitive
 */

import { noiseLoudness } from '@shared/constants';
import type {
  ModuleId,
  NoiseEvent,
  NoiseIntentMessage,
  NoiseKind,
  PlayerId,
  Vec3,
} from '@shared/types';
import { cloneV3 } from '@shared/graph/math';

import type { EventBus, Unsubscribe } from '../core/eventBus';
import { bus as defaultBus, type GameEvents } from '../core/eventBus';
import type { NoiseRuntime } from './runtime';
import { SERVER_DERIVED_KINDS, type EmitOptions, type HeardNoise, type NoiseNetwork } from './types';

export interface NoiseEmitterOptions {
  /** Where to send intents. Omit for a single-player / offline session. */
  network?: NoiseNetwork | null;
  /** Local player id, stamped on every event as `actor`. */
  actor?: PlayerId;
  /** Bus to read the server tick from. Defaults to the shared bus. */
  bus?: EventBus<GameEvents>;
  /** Kinds never forwarded to the server. Defaults to voice + breathing, which
   *  the server derives from `voiceLevel` and heart rate. */
  serverDerived?: ReadonlySet<NoiseKind>;
}

export class NoiseEmitter {
  private readonly runtime: NoiseRuntime;
  private readonly bus: EventBus<GameEvents>;
  private readonly serverDerived: ReadonlySet<NoiseKind>;
  private network: NoiseNetwork | null;
  private actor: PlayerId | undefined;
  private tick = 0;
  private tickSub: Unsubscribe | null = null;
  /** Argument object for `noiseLoudness`, refilled per call. It never escapes:
   *  `noiseLoudness` reads it and returns a number. */
  private readonly loudnessArgs: { speed?: number; intensity?: number } = {};

  constructor(runtime: NoiseRuntime, opts: NoiseEmitterOptions = {}) {
    this.runtime = runtime;
    this.bus = opts.bus ?? defaultBus;
    this.network = opts.network ?? null;
    this.actor = opts.actor ?? runtime.localPlayerId ?? undefined;
    this.serverDerived = opts.serverDerived ?? SERVER_DERIVED_KINDS;
  }

  /** Track the server tick so emitted events carry a plausible `t` (§3). */
  attach(): Unsubscribe {
    this.detach();
    this.tickSub = this.bus.on('net:tick', ({ tick }) => {
      this.tick = tick;
    });
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.detach();
    };
  }

  detach(): void {
    this.tickSub?.();
    this.tickSub = null;
  }

  setNetwork(network: NoiseNetwork | null): void {
    this.network = network;
  }

  setActor(actor: PlayerId | undefined): void {
    this.actor = actor;
  }

  // -----------------------------------------------------------------------
  // The one general entry point
  // -----------------------------------------------------------------------

  /**
   * Emit a noise at a world position. Returns the locally-resolved result so
   * the caller can, for example, size the §6 noise ring from `carriedMetres`.
   */
  emit(kind: NoiseKind, pos: Vec3, module: ModuleId, opts: EmitOptions = {}): HeardNoise | null {
    // The NoiseEvent itself has to be a real object — it goes on the bus, into
    // the runtime's history and out to the server. The three throwaway literals
    // the object spreads used to build on the way there did not.
    let loudness = opts.loudness;
    if (loudness === undefined) {
      const args = this.loudnessArgs;
      args.speed = opts.speed;
      args.intensity = opts.intensity;
      loudness = noiseLoudness(kind, args);
    }

    const actor = opts.actor ?? this.actor;
    const event: NoiseEvent = {
      kind,
      origin: cloneV3(pos),
      module,
      loudness,
      t: this.tick,
    };
    if (actor !== undefined) event.actor = actor;

    const heard = this.runtime.emitSelf(event);

    const forward = !opts.localOnly && !this.serverDerived.has(kind);
    if (forward && this.network) {
      // Built by hand rather than spread: an absent `speed` must stay ABSENT on
      // the wire, so this one is still a fresh object — just one instead of two
      // plus a spread.
      const msg: NoiseIntentMessage = { kind, pos: cloneV3(pos), module };
      if (opts.speed !== undefined) msg.speed = opts.speed;
      this.network.sendNoise(msg);
    }

    return heard;
  }

  // -----------------------------------------------------------------------
  // §3 table shorthands. One per row, so call sites read like the design doc.
  // -----------------------------------------------------------------------

  /** 4 — shifting your grip. Safe at distance, fatal in a SEARCH sweep (§3). */
  railPull(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('rail-pull', pos, module);
  }

  /** 8 — gentle push-off (§4). */
  pushOff(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('push-off', pos, module);
  }

  /** 8 + 3v — an arrested, clean catch. Skill buys silence (§4). */
  catchRail(pos: Vec3, module: ModuleId, speed: number): HeardNoise | null {
    return this.emit('catch', pos, module, { speed });
  }

  /** 15 + 6v — you hit the bulkhead instead (§4). */
  impact(pos: Vec3, module: ModuleId, speed: number): HeardNoise | null {
    return this.emit('impact', pos, module, { speed });
  }

  /** 25 — bumping a teammate or a prop while carrying something. */
  bodyCollision(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('body-collision', pos, module);
  }

  /** 65 — the panic button with a price (§4). */
  extinguisher(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('extinguisher', pos, module);
  }

  /** 15 — tap a handrail. Carries about two modules; invent your own code (§10). */
  knock(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('knock', pos, module);
  }

  /** 20 — the unmuted wrist tracker. Louder the closer the alien gets (§6). */
  trackerBeep(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('tracker-beep', pos, module);
  }

  /** 30 — a cargo bag off a bulkhead, and now you have five problems (§11). */
  cargoBounce(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('cargo-bounce', pos, module);
  }

  /** 45 — a hatch cycling. The alien pays this too, which is how you hear it (§5). */
  hatchCycle(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('hatch-cycle', pos, module);
  }

  /** 60 — pry bar: the loud-fast path (§11). */
  pryBar(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('pry-bar', pos, module);
  }

  /** 6 — hand pump: the quiet-slow path, locked in place for 25 s (§11). */
  handPump(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('hand-pump', pos, module);
  }

  /** 70 — a decoy on impact. Two per round, no respawn (§5). */
  decoy(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('decoy', pos, module);
  }

  /** 6–14 — one breath, scaled by heart rate (§6). Local only: the server
   *  derives breathing from the heart-rate model. */
  breathing(pos: Vec3, module: ModuleId, intensity01: number): HeardNoise | null {
    return this.emit('breathing', pos, module, { intensity: intensity01, localOnly: true });
  }

  /** 10–55 — proximity voice (§7). Local only: the mic level goes to the server
   *  as a `voiceLevel` message at 10 Hz and it makes the NoiseEvent. */
  voice(pos: Vec3, module: ModuleId, level01: number): HeardNoise | null {
    return this.emit('voice', pos, module, { intensity: level01, localOnly: true });
  }

  /** 5 — the spectator headset speaker leaking into the room (§10). */
  headset(pos: Vec3, module: ModuleId): HeardNoise | null {
    return this.emit('headset', pos, module);
  }
}
