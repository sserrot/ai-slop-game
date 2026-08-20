/**
 * The alien's hunting audio hook (DESIGN.md §5 + §8).
 *
 * §5 is blunt about it: **"It makes loud noise while hunting. Non-negotiable: a
 * silent charge is unfair and reads as a bug."** The server already emits the
 * roar as a NoiseEvent every 0.75s, which travels the graph like any other
 * sound and reaches the audio system through the normal `noise:heard` path.
 * This file is the *other* half — the continuous bed that follows the body:
 * §8's "duck the world bus and swell a sub-bass bed on HUNT".
 *
 * The audio subsystem (`src/audio/`) owns the real bus graph, so this module
 * only defines the seam:
 *
 *   - `AlienAudioSink` — what a hunt bed has to be able to do. Implement it in
 *     `src/audio/` against the real buses and hand it in.
 *   - `AlienHuntEmitter` — the state machine that starts, positions, swells and
 *     stops that bed from the alien's networked state.
 *   - `createProceduralHuntSink()` — a working stand-in that synthesises the bed
 *     from an oscillator and filtered noise, so the hook is testable and the
 *     game is scary before a single sample exists.
 */

import { FILTER_RAMP_S } from '@shared/constants';
import type { AlienState, Vec3 } from '@shared/types';

/** Where the hunt bed is heard from, in metres. */
export const HUNT_BED_NEAR_M = 3;
export const HUNT_BED_FAR_M = 45;

/**
 * The contract between the alien view and the audio subsystem. Everything is
 * idempotent: `start()` on a running bed and `stop()` on a stopped one are
 * no-ops, because they are driven from a state machine that fires on edges.
 */
export interface AlienAudioSink {
  /** Begin (or resume) the hunt bed. Ramp, never step (§8). */
  start(): void;
  /** Fade the bed out. */
  stop(): void;
  /** World-space position of the alien, for the panner. */
  setPosition(pos: Vec3): void;
  /** 0–1 — how present the bed should be. Proximity drives it. */
  setIntensity(intensity01: number): void;
  dispose?(): void;
}

export interface AlienHuntEmitterOptions {
  sink?: AlienAudioSink | null;
  /** Which states count as hunting. Defaults to HUNT and ATTACK. */
  huntStates?: readonly AlienState[];
  /** Metres at which intensity saturates at 1. */
  nearMetres?: number;
  /** Metres beyond which intensity is 0. */
  farMetres?: number;
  /** Where the listener is. Without it the bed plays at full intensity. */
  listener?: () => Vec3 | null;
}

/**
 * Drives an `AlienAudioSink` from the alien's networked state and position.
 * Call `update()` once per frame with whatever the view currently shows.
 */
export class AlienHuntEmitter {
  private sink: AlienAudioSink | null;
  private readonly huntStates: Set<AlienState>;
  private readonly nearMetres: number;
  private readonly farMetres: number;
  private readonly listener: (() => Vec3 | null) | null;
  private running = false;
  private lastIntensity = -1;

  constructor(opts: AlienHuntEmitterOptions = {}) {
    this.sink = opts.sink ?? null;
    this.huntStates = new Set<AlienState>(opts.huntStates ?? ['HUNT', 'ATTACK']);
    this.nearMetres = opts.nearMetres ?? HUNT_BED_NEAR_M;
    this.farMetres = opts.farMetres ?? HUNT_BED_FAR_M;
    this.listener = opts.listener ?? null;
  }

  get active(): boolean {
    return this.running;
  }

  /** Swap in the real audio-subsystem sink once it exists. */
  setSink(sink: AlienAudioSink | null): void {
    if (this.sink === sink) return;
    if (this.running) this.sink?.stop();
    this.sink = sink;
    this.lastIntensity = -1;
    if (this.running) this.sink?.start();
  }

  /** One frame. `state` and `pos` come straight from the view. */
  update(state: AlienState, pos: Vec3): void {
    const shouldRun = this.huntStates.has(state);
    if (shouldRun !== this.running) {
      this.running = shouldRun;
      if (shouldRun) this.sink?.start();
      else this.sink?.stop();
    }
    if (!this.running || !this.sink) return;

    this.sink.setPosition(pos);
    const intensity = this.intensityFor(pos);
    // Only push a change worth ramping; AudioParam churn at 60 Hz is waste.
    if (Math.abs(intensity - this.lastIntensity) > 0.01) {
      this.lastIntensity = intensity;
      this.sink.setIntensity(intensity);
    }
  }

  /** Force the bed off — round end, disconnect, or the alien going DORMANT. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.sink?.stop();
  }

  dispose(): void {
    this.stop();
    this.sink?.dispose?.();
    this.sink = null;
  }

  private intensityFor(pos: Vec3): number {
    if (!this.listener) return 1;
    const l = this.listener();
    if (!l) return 1;
    const dx = pos.x - l.x;
    const dy = pos.y - l.y;
    const dz = pos.z - l.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d <= this.nearMetres) return 1;
    if (d >= this.farMetres) return 0;
    return 1 - (d - this.nearMetres) / (this.farMetres - this.nearMetres);
  }
}

// ===========================================================================
// A working stand-in
// ===========================================================================

export interface ProceduralHuntSinkOptions {
  /** Where to connect. Defaults to `ctx.destination`; pass the world bus. */
  destination?: AudioNode;
  /** Peak gain of the bed. */
  gain?: number;
  /** Fundamental of the sub bed, Hz. */
  subHz?: number;
}

/**
 * Synthesises the §8 sub-bass swell: a detuned sub oscillator plus filtered
 * noise through a shared panner. No assets, no network, ~60 lines — enough to
 * make a capsule frightening while the art is still M8 work.
 *
 * Nodes are built once and left running with the gain at zero; starting and
 * stopping oscillators repeatedly is not allowed by Web Audio and re-creating
 * the graph clicks.
 */
export function createProceduralHuntSink(
  ctx: AudioContext,
  opts: ProceduralHuntSinkOptions = {},
): AlienAudioSink {
  const destination = opts.destination ?? ctx.destination;
  const peak = opts.gain ?? 0.7;
  const subHz = opts.subHz ?? 38;

  const master = ctx.createGain();
  master.gain.value = 0;

  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 4;
  panner.maxDistance = 80;
  panner.rolloffFactor = 1;

  // Sub bed.
  const sub = ctx.createOscillator();
  sub.type = 'sawtooth';
  sub.frequency.value = subHz;
  const subFilter = ctx.createBiquadFilter();
  subFilter.type = 'lowpass';
  subFilter.frequency.value = 120;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.8;

  // Breath / growl: brown-ish noise through a slowly swept bandpass.
  const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = 180;
  noiseFilter.Q.value = 1.2;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.35;

  // A slow LFO on the growl's centre frequency — the "breathing" of the thing.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.45;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 60;

  sub.connect(subFilter).connect(subGain).connect(master);
  noise.connect(noiseFilter).connect(noiseGain).connect(master);
  lfo.connect(lfoDepth).connect(noiseFilter.frequency);
  master.connect(panner).connect(destination);

  sub.start();
  noise.start();
  lfo.start();

  let intensity = 1;
  let running = false;
  let disposed = false;

  const applyGain = (): void => {
    if (disposed) return;
    const target = running ? peak * intensity : 0;
    // §8: ramp filter and gain changes, never step them.
    master.gain.setTargetAtTime(target, ctx.currentTime, FILTER_RAMP_S);
  };

  return {
    start(): void {
      if (disposed || running) return;
      running = true;
      applyGain();
    },
    stop(): void {
      if (disposed || !running) return;
      running = false;
      applyGain();
    },
    setPosition(pos: Vec3): void {
      if (disposed) return;
      const t = ctx.currentTime;
      if (panner.positionX) {
        panner.positionX.setTargetAtTime(pos.x, t, FILTER_RAMP_S);
        panner.positionY.setTargetAtTime(pos.y, t, FILTER_RAMP_S);
        panner.positionZ.setTargetAtTime(pos.z, t, FILTER_RAMP_S);
      } else {
        // Older WebKit: the deprecated setter is the only way in.
        (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(
          pos.x,
          pos.y,
          pos.z,
        );
      }
    },
    setIntensity(value: number): void {
      if (disposed) return;
      intensity = value < 0 ? 0 : value > 1 ? 1 : value;
      // Closer means lower and angrier.
      sub.frequency.setTargetAtTime(subHz - intensity * 6, ctx.currentTime, FILTER_RAMP_S);
      applyGain();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        sub.stop();
        noise.stop();
        lfo.stop();
      } catch {
        /* already stopped */
      }
      master.disconnect();
      panner.disconnect();
    },
  };
}
