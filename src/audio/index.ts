/**
 * src/audio — the Web Audio implementation (DESIGN.md §8).
 *
 * "The most underrated half of this project. Budget real time for it."
 *
 * The shape of it:
 *
 *   AudioEngine      context, buses, panner pool, module reverb, voice pool
 *   NoiseAudio       resolved §3 noise -> spatialised, occluded, port-panned sound
 *   StationAmbience  the hum the station makes while it is still alive
 *   TrackerAudio     §6 wrist tracker: beeps that accelerate, and cost you 20 loudness
 *   BreathingAudio   §6 heart rate -> breathing, the counter to the freeze meta
 *   AlienAudio       §5 "it makes loud noise while hunting" — a continuous,
 *                    graph-resolved vocalisation, plus the world duck and sub-bass
 *   LocomotionAudio  §4 the transitions that emit NO NoiseEvent: launch, settle,
 *                    liftoff. Silent to the alien, never silent to you
 *   GravityAudio     §4 the 2.5 s announced spin-down, and what a module without
 *                    a floor sounds like afterwards
 *   HideAudio        §4 inside a hide spot: §8's occlusion filter turned on the
 *                    whole world, and your own breathing brought forward
 *   VoiceMesh        §7 WebRTC proximity voice with mandatory mic calibration
 *
 * `createAudioSystem()` wires all of it to the event bus and the noise runtime
 * in one call; every piece is separately constructible if you want fewer.
 */

export * from './levels';
export * from './buffers';
export * from './reverb';
export * from './pannerPool';
export * from './buses';
export * from './synth';
export * from './engine';
export * from './noiseAudio';
export * from './ambience';
export * from './tracker';
export * from './breathing';
export * from './alienAudio';
export * from './locomotion';
export * from './gravity';
export * from './hide';
export * from './calibration';
export * from './voice';

import type { EventBus, Unsubscribe } from '../core/eventBus';
import { bus as defaultBus, type GameEvents } from '../core/eventBus';
import type { NoiseEmitter } from '../noise/emitter';
import type { NoiseRuntime } from '../noise/runtime';
import { StationAmbience, type AmbienceOptions } from './ambience';
import { AlienAudio } from './alienAudio';
import { BreathingAudio } from './breathing';
import { AudioEngine, type AudioEngineOptions } from './engine';
import { GravityAudio, type GravityAudioOptions } from './gravity';
import { HideAudio, type HideAudioOptions } from './hide';
import { LocomotionAudio, type LocomotionAudioOptions } from './locomotion';
import { NoiseAudio, type NoiseAudioOptions } from './noiseAudio';
import { TrackerAudio } from './tracker';
import { VoiceMesh, type VoiceMeshOptions } from './voice';

export interface AudioSystemOptions {
  /** Resolves everything against the station graph. Strongly recommended. */
  runtime?: NoiseRuntime | null;
  /** Lets the tracker beep and your breathing become real, hearable noise. */
  emitter?: NoiseEmitter | null;
  bus?: EventBus<GameEvents>;
  engine?: AudioEngine;
  engineOptions?: AudioEngineOptions;
  noiseOptions?: NoiseAudioOptions;
  ambience?: AmbienceOptions;
  locomotion?: LocomotionAudioOptions;
  gravity?: Omit<GravityAudioOptions, 'runtime' | 'ambience'>;
  hide?: Omit<HideAudioOptions, 'bus' | 'localPlayerId'>;
  /** Voice options, or false to skip building the mesh entirely. */
  voice?: VoiceMeshOptions | false;
  /** Resume the context on the first gesture. Default true. */
  autoUnlock?: boolean;
  /** Start the station hum immediately. Default true. */
  startAmbience?: boolean;
  /** Minimum gap between self-voice noise events for the §6 ring, in ms. */
  voiceRingThrottleMs?: number;
}

export interface AudioSystem {
  readonly engine: AudioEngine;
  readonly noise: NoiseAudio;
  readonly ambience: StationAmbience;
  readonly tracker: TrackerAudio;
  readonly breathing: BreathingAudio;
  readonly alien: AlienAudio;
  /** §4's silent transitions — `launch`, `settle`, `liftoff` — and the jump. */
  readonly locomotion: LocomotionAudio;
  /** §4's announced 2.5 s spin-down, and the ambient character of a `zero` module. */
  readonly gravity: GravityAudio;
  /** §4's hide spots: §8's occlusion filter applied to the whole world. */
  readonly hide: HideAudio;
  readonly voice: VoiceMesh | null;
  /** Subscribe everything to the bus. Returns a single teardown. */
  attach(): Unsubscribe;
  /** Call from the fixed update (`ticker.onFixed`). */
  update(dt: number): void;
  dispose(): void;
}

/**
 * Build and wire the whole audio subsystem.
 *
 *   const audio = createAudioSystem({ runtime, emitter });
 *   const detach = audio.attach();
 *   ticker.onFixed((dt) => audio.update(dt));
 *   // …and from the camera, every frame:
 *   audio.engine.setListener(camera.position, forward, up);
 */
export function createAudioSystem(opts: AudioSystemOptions = {}): AudioSystem {
  const bus = opts.bus ?? defaultBus;
  const runtime = opts.runtime ?? null;
  const emitter = opts.emitter ?? null;
  const engine = opts.engine ?? new AudioEngine(opts.engineOptions ?? {});

  const noise = new NoiseAudio(engine, { bus, ...(opts.noiseOptions ?? {}) });
  const ambience = new StationAmbience(engine, opts.ambience ?? {});

  const listenerPos = (): { pos: { x: number; y: number; z: number }; module: string } | null => {
    if (!runtime) return null;
    const pose = runtime.listener;
    if (!pose.module) return null;
    return { pos: pose.pos, module: pose.module };
  };

  const tracker = new TrackerAudio(engine, {
    bus,
    // Read lazily: the runtime learns the session id in the network wiring
    // pass, which runs after the audio system is built.
    localPlayerId: () => runtime?.localPlayerId ?? null,
    onBeep: () => {
      // §6: the beep is a real 20-loudness noise. Muted, dead, or between
      // rounds, this never fires — and it runs on the emitted cadence, which is
      // floored at one event per §3 coalescing window, not on the audible one.
      const here = listenerPos();
      if (here && emitter) emitter.trackerBeep(here.pos, here.module);
    },
  });

  const breathing = new BreathingAudio(engine, {
    bus,
    onBreath: (intensity) => {
      const here = listenerPos();
      if (here && emitter) emitter.breathing(here.pos, here.module, intensity);
    },
  });

  const alien = new AlienAudio(engine, { bus, runtime, noiseAudio: noise });

  const locomotion = new LocomotionAudio(engine, opts.locomotion ?? {});
  const gravity = new GravityAudio(engine, { runtime, ambience, ...(opts.gravity ?? {}) });
  const hide = new HideAudio(engine, {
    bus,
    localPlayerId: () => runtime?.localPlayerId ?? null,
    ...(opts.hide ?? {}),
  });

  let lastVoiceRing = 0;
  const voiceThrottle = opts.voiceRingThrottleMs ?? 400;
  const voice =
    opts.voice === false
      ? null
      : new VoiceMesh(engine, {
          runtime,
          ...(opts.voice ?? {}),
          onLevel: (level01, loudness) => {
            (opts.voice === false ? undefined : opts.voice?.onLevel)?.(level01, loudness);
            if (!emitter || level01 <= 0) return;
            const now = performance.now();
            if (now - lastVoiceRing < voiceThrottle) return;
            lastVoiceRing = now;
            const here = listenerPos();
            // Local only: the server makes the authoritative voice NoiseEvent
            // from the `voiceLevel` message (§7). This one is just so the §6
            // ring shows you how far your own shout carried.
            if (here) emitter.voice(here.pos, here.module, level01);
          },
        });

  let teardown: Unsubscribe[] = [];

  return {
    engine,
    noise,
    ambience,
    tracker,
    breathing,
    alien,
    locomotion,
    gravity,
    hide,
    voice,

    attach(): Unsubscribe {
      teardown.forEach((off) => off());
      teardown = [
        noise.attach(),
        tracker.attach(),
        breathing.attach(),
        alien.attach(),
        // Follows the local player's own `HIDDEN` state, so nothing in main.ts
        // has to remember to tell the mix you got into a locker.
        hide.attach(),
      ];
      if (opts.autoUnlock !== false) teardown.push(engine.attachUnlock());
      if (opts.startAmbience !== false) ambience.start();
      breathing.start();
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        teardown.forEach((off) => off());
        teardown = [];
      };
    },

    update(dt: number): void {
      engine.update();
      tracker.update(dt);
      breathing.update(dt);
      alien.update(dt);
      // Keeps a running gravity warning panned at the arrival port and
      // attenuated correctly while you sprint away from it (§8).
      gravity.update(dt);
      voice?.update(dt);
    },

    dispose(): void {
      teardown.forEach((off) => off());
      teardown = [];
      voice?.stop();
      hide.dispose();
      gravity.dispose();
      alien.dispose();
      tracker.dispose();
      ambience.stop(0.2);
      noise.detach();
      engine.dispose();
    },
  };
}
