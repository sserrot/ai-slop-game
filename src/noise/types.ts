/**
 * Client-side noise runtime — shared vocabulary (DESIGN.md §3).
 *
 * The propagation maths itself lives in `@shared/graph/noise`. Nothing in this
 * directory re-implements it; we own the *client runtime* around it: who is
 * listening, what reached them, and the stream audio (§8) and the UI (§6) read.
 */

import type {
  ListenerResolution,
  ModuleId,
  NoiseEvent,
  NoiseIntentMessage,
  NoiseKind,
  NoiseMessage,
  PlayerId,
  Vec3,
} from '@shared/types';

/** Where the local listener is. Every resolution is measured from here. */
export interface ListenerPose {
  pos: Vec3;
  module: ModuleId;
}

/**
 * One noise, already resolved against the local listener.
 *
 * ALWAYS branch on `resolution.audible` before touching `resolution.level` —
 * an unreachable sound reports level 0 and distance `Number.MAX_VALUE` rather
 * than a non-finite value, because those poison Web Audio AudioParams.
 */
export interface HeardNoise {
  /** The event as it was emitted (world-space origin, source loudness). */
  readonly event: NoiseEvent;
  /** What arrived here: level, occlusion, and — critically for §8 — the port
   *  the sound came through and the world position to pan it at. */
  readonly resolution: ListenerResolution;
  /** True when the local player made this sound. Self noise is played back on
   *  the body bus at full volume (§8) and never spatialised. */
  readonly self: boolean;
  /** How far the sound stayed above FLOOR along its loudest path, in metres.
   *  This is what the §6 noise ring scales to. */
  readonly carriedMetres: number;
  /** How many modules it reached above the floor (including its own). */
  readonly modulesReached: number;
  /** Client clock (ms) the runtime processed it. */
  readonly at: number;
}

/**
 * The one thing the noise runtime needs from `src/net`. The integrator supplies
 * an object that forwards the intent over the Colyseus room; the server
 * re-derives loudness with `noiseLoudness()` rather than trusting us (§7).
 */
export interface NoiseNetwork {
  sendNoise(intent: NoiseIntentMessage): void;
}

/**
 * The other direction: the server's `noise` broadcasts (§7). The integrator
 * hands the runtime anything with this one method — a Colyseus
 * `room.onMessage('noise', …)` wrapper is two lines.
 */
export interface NoiseSource {
  onNoise(handler: (msg: NoiseMessage) => void): () => void;
}

/** Extra knobs when emitting a noise locally. */
export interface EmitOptions {
  /** Speed in m/s — required for 'catch' and 'impact' (§14). */
  speed?: number;
  /** 0–1 — required for 'breathing' and 'voice' (§14). */
  intensity?: number;
  /** Override the derived source loudness. Use sparingly; the table is §3. */
  loudness?: number;
  /** Skip the network send (the server derives this kind itself). */
  localOnly?: boolean;
  /** Attribute the sound to somebody other than the local player. */
  actor?: PlayerId;
}

/** Kinds the client never forwards as a raw noise intent: the server derives
 *  them from `voiceLevel` (§7) and the heart-rate model (§6) instead. */
export const SERVER_DERIVED_KINDS: ReadonlySet<NoiseKind> = new Set<NoiseKind>([
  'voice',
  'breathing',
]);
