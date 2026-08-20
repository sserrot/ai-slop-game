/**
 * Noise → sound (DESIGN.md §3 → §8).
 *
 * Subscribes to the resolved noise stream and plays it. All of the interesting
 * decisions were already made by `@shared/graph/noise`: this file's whole job
 * is to honour them without editorialising.
 *
 *   resolution.panPosition  -> where the PannerNode goes.   THE PORT, cross-module.
 *   resolution.level        -> gain, via the §3 loudness ladder in levels.ts.
 *   resolution.occluded     -> 400 Hz lowpass (§8), ramped, never stepped.
 *
 * Self noise takes a different route on purpose: the body bus, full volume, no
 * spatialisation. §8: "Every noise the player emits must be audible to them at
 * full volume. They have to feel the mistake as they make it."
 */

import {
  breathingNoise,
  catchNoise,
  clamp,
  footstepLoudness,
  hideNoise,
  impactNoise,
  voiceNoise,
} from '@shared/constants';
import { GAITS, type Gait, type ListenerResolution, type NoiseEvent, type NoiseKind } from '@shared/types';

import type { EventBus, Unsubscribe } from '../core/eventBus';
import { bus as defaultBus, type GameEvents } from '../core/eventBus';
import type { AudioEngine, PlayingSound } from './engine';
import { selfGain } from './levels';

export interface NoiseAudioOptions {
  bus?: EventBus<GameEvents>;
  /** Kinds this layer must not synthesize at all. 'voice' is skipped by
   *  default: the real audio arrives over the WebRTC mesh (§7). */
  skip?: Iterable<NoiseKind>;
  /**
   * Kinds skipped only for SELF playback, because a dedicated module already
   * makes that sound on its own bus and playing it twice is both louder and
   * out of sync: the tracker beep (tracker bus, §6), your breathing (body bus,
   * driven by heart rate) and your own voice (never monitor a live mic).
   */
  selfSkip?: Iterable<NoiseKind>;
  /**
   * Minimum gap between two sounds of the same kind from the same actor, in ms.
   * A burst of six identical events in one tick is a network artefact, not six
   * separate noises, and stacking them is both loud and wrong.
   */
  throttleMs?: number;
  /** Reverb send multiplier for world sounds. */
  reverb?: number;
}

const DEFAULT_THROTTLE_MS = 35;

export class NoiseAudio {
  private readonly engine: AudioEngine;
  private readonly bus: EventBus<GameEvents>;
  private readonly skip: Set<NoiseKind>;
  private readonly selfSkip: Set<NoiseKind>;
  private readonly throttleMs: number;
  private readonly reverb: number;
  private readonly lastPlayed = new Map<string, number>();
  private subscriptions: Unsubscribe[] = [];
  private seed = 1;

  constructor(engine: AudioEngine, opts: NoiseAudioOptions = {}) {
    this.engine = engine;
    this.bus = opts.bus ?? defaultBus;
    this.skip = new Set<NoiseKind>(opts.skip ?? ['voice']);
    this.selfSkip = new Set<NoiseKind>(opts.selfSkip ?? ['tracker-beep', 'breathing', 'voice']);
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.reverb = opts.reverb ?? 1;
  }

  attach(): Unsubscribe {
    this.detach();
    this.subscriptions.push(
      this.bus.on('noise:heard', ({ event, resolution }) => this.heard(event, resolution)),
      this.bus.on('noise:self', ({ event }) => this.self(event)),
    );
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.detach();
    };
  }

  detach(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
  }

  /** Stop synthesizing a kind — e.g. while `AlienAudio` owns the hunt loop. */
  setSkipped(kind: NoiseKind, skipped: boolean): void {
    if (skipped) this.skip.add(kind);
    else this.skip.delete(kind);
  }

  /** A sound somebody else made, already resolved against the local listener. */
  heard(event: NoiseEvent, resolution: ListenerResolution): PlayingSound | null {
    if (!resolution.audible) return null;
    if (this.skip.has(event.kind)) return null;
    if (this.throttled(event)) return null;

    return this.engine.play({
      kind: event.kind,
      level: resolution.level,
      // §8's single most important line: cross-module sound comes out of the
      // hatch it came through, not through the bulkhead. `panPosition` is the
      // port for any cross-module path and the true origin otherwise.
      position: resolution.panPosition,
      occluded: resolution.occluded,
      bus: 'world',
      reverb: this.reverb,
      speed: speedFromLoudness(event),
      gait: gaitFromLoudness(event),
      intensity: intensityFromLoudness(event),
      seed: this.nextSeed(),
    });
  }

  /** A sound YOU made. Body bus, full volume, dry, unpanned. */
  self(event: NoiseEvent): PlayingSound | null {
    if (this.skip.has(event.kind) || this.selfSkip.has(event.kind)) return null;
    return this.engine.play({
      kind: event.kind,
      level: event.loudness,
      position: null,
      occluded: false,
      bus: 'body',
      // A little of the room, so your own grips still sound like they happened
      // in a metal tube — but much less than a world sound.
      reverb: 0.35,
      gain: selfGain(event.loudness),
      speed: speedFromLoudness(event),
      gait: gaitFromLoudness(event),
      intensity: intensityFromLoudness(event),
      seed: this.nextSeed(),
    });
  }

  private throttled(event: NoiseEvent): boolean {
    const key = `${event.kind}:${event.actor ?? '-'}`;
    const now = performance.now();
    const last = this.lastPlayed.get(key);
    if (last !== undefined && now - last < this.throttleMs) return true;
    this.lastPlayed.set(key, now);
    return false;
  }

  private nextSeed(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed % 9973;
  }
}

/**
 * Invert one of §14's loudness formulas.
 *
 * Every one of them is affine — `catchNoise(v) = 8 + 3v`, `voiceNoise(l) =
 * 10 + 45l`, and so on — so two evaluations recover the intercept and the slope
 * exactly, and the inverse follows. §14's rule is "Import them; never re-type
 * them": writing `(loudness - 8) / 3` here would silently desync the synth from
 * the event the moment someone retunes `catchNoise`, and the sound would be as
 * bright as a speed nobody travelled at. This reads the coefficients back out of
 * the imported function instead, so a retune propagates on its own.
 *
 * `sample` must be a point where the function is still linear: the intensity
 * mappings clamp their input to 0–1, so sample at 1, not beyond.
 */
function invertAffine(fn: (x: number) => number, y: number, sample = 1): number {
  const intercept = fn(0);
  const slope = (fn(sample) - intercept) / sample;
  if (slope === 0) return 0;
  return (y - intercept) / slope;
}

/**
 * Recover the speed a catch or an impact happened at from its loudness, so the
 * sound is as bright as the event was fast. The server sends loudness, not
 * speed, and inverting §14's formula is exact.
 */
function speedFromLoudness(event: NoiseEvent): number | undefined {
  if (event.kind === 'catch') return Math.max(0, invertAffine(catchNoise, event.loudness));
  if (event.kind === 'impact') return Math.max(0, invertAffine(impactNoise, event.loudness));
  // A landing is `landingNoise`, which is PIECEWISE: soft for the gait → that
  // gait's own footstep; otherwise `impactNoise`. So a loudness that is exactly
  // one of the three footstep values came from the soft branch and carries no
  // speed at all, and everything else is an impact we can invert exactly.
  if (event.kind === 'landing' && gaitWithFootstep(event.loudness) === undefined) {
    return Math.max(0, invertAffine(impactNoise, event.loudness));
  }
  return undefined;
}

/**
 * Which gait a footstep or a soft landing was made in.
 *
 * `NoiseEvent` carries loudness, not gait — §3 is the contract and it says
 * nothing about how you were moving, only how loud it was. But the three
 * footstep values ARE the three gaits (4 / 12 / 30, §14) and the mapping is
 * injective, so reading the gait back out of the loudness is exact rather than
 * a guess. That matters: it is what lets a footstep two modules away sound like
 * somebody sprinting instead of like a quiet noise turned up.
 */
function gaitFromLoudness(event: NoiseEvent): Gait | undefined {
  if (event.kind === 'footstep') return nearestGait(event.loudness);
  if (event.kind === 'landing') return gaitWithFootstep(event.loudness);
  return undefined;
}

/** Exact match against a gait's own footstep — the soft-landing branch. */
function gaitWithFootstep(loudness: number): Gait | undefined {
  return GAITS.find((gait) => Math.abs(footstepLoudness(gait) - loudness) < 1e-6);
}

/** Nearest gait by footstep loudness. A muffled step (§4, −8 dB in a hide spot)
 *  still lands closest to the gait that made it. */
function nearestGait(loudness: number): Gait {
  let best: Gait = 'walk';
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const gait of GAITS) {
    const delta = Math.abs(footstepLoudness(gait) - loudness);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = gait;
    }
  }
  return best;
}

/** Same trick for the breathing loop (6–14), voice (10–55) and the hide verbs
 *  (8–30, where the 0–1 it recovers is the HASTE you got in with). */
function intensityFromLoudness(event: NoiseEvent): number | undefined {
  if (event.kind === 'breathing') return clamp(invertAffine(breathingNoise, event.loudness), 0, 1);
  if (event.kind === 'voice') return clamp(invertAffine(voiceNoise, event.loudness), 0, 1);
  if (event.kind === 'hide-enter' || event.kind === 'hide-exit') {
    return clamp(invertAffine(hideNoise, event.loudness), 0, 1);
  }
  return undefined;
}
