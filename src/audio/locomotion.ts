/**
 * Walking, landing, and the two ways of leaving a floor (DESIGN.md §4, §8).
 *
 * THE DIVISION OF LABOUR, and it is the whole design of this file:
 *
 *   `transitionNoise(kind, speed, gait) > 0`  the transition made a NoiseEvent.
 *       The ordinary §3 path already carries it — server → `NoiseRuntime` →
 *       `noise:heard` / `noise:self` → `NoiseAudio` → `synth.ts`. This file
 *       stays out of the way, because playing it twice would be both louder
 *       than §14 says and out of sync with what the alien heard.
 *
 *   `transitionNoise(...) === 0`              the transition was SILENT.
 *       "Zero loudness means emit no event at all, not an event carrying zero"
 *       — so nothing at all reaches the audio layer through §3, and yet a
 *       `liftoff` is the floor disappearing out from under a standing body. It
 *       is the single most alarming thing that can happen to you in this game
 *       and it would arrive in total silence. That is what this file is for.
 *
 * Everything here therefore plays on the BODY bus, unpanned, at full volume:
 * these are things that happened to YOU, not sounds in the room, and §8 is
 * explicit that your own noise is never spatialised or attenuated. None of it
 * emits a NoiseEvent, so none of it is anything the alien can hear — which is
 * exactly right, because §14 already decided that these transitions are silent.
 *
 * The one exception to "stay out of the way" is `launch`: at ≥ `LAUNCH_MIN` it
 * pays `PUSH_OFF` (8) and you hear that shove through §3, but the air of a room
 * leaving you is true at every speed including the silent walk-in, so the whoosh
 * plays either way and layers under the shove rather than replacing it.
 */

import {
  LOUDNESS,
  PUSH_MAX,
  TERMINAL_VELOCITY_M_S,
  gaitProfile,
  transitionNoise,
} from '@shared/constants';
import type { Gait, LocomotionTransition, LocomotionTransitionKind } from '@shared/types';

import type { AudioEngine, PlayingSound } from './engine';
import { selfGain } from './levels';
import { footstep, jumpEffort, landing, launchWhoosh, liftoffRelease, settleFall } from './synth';

export interface LocomotionAudioOptions {
  /**
   * Play footsteps and landings from `footstep()` / `land()` as well.
   *
   * OFF by default, and the default is the correct one with a server: the
   * player controller emits a real `footstep` / `landing` NoiseEvent and the §3
   * path plays it locally on the same body bus, so turning this on would double
   * every step. Turn it on only for an offline harness with no noise runtime.
   */
  echoNoisyEvents?: boolean;
  /** Body-bus gain for the silent transitions. */
  gain?: number;
}

/** Loudness the silent transitions are MIXED at. Not a §3 level — they emit no
 *  NoiseEvent — but `selfGain` is the curve the rest of your body already uses. */
const SILENT_TRANSITION_LEVEL = 14;

export class LocomotionAudio {
  private readonly engine: AudioEngine;
  private readonly echo: boolean;
  private readonly gain: number;
  private seed = 7919;

  constructor(engine: AudioEngine, opts: LocomotionAudioOptions = {}) {
    this.engine = engine;
    this.echo = opts.echoNoisyEvents ?? false;
    this.gain = opts.gain ?? selfGain(SILENT_TRANSITION_LEVEL);
  }

  /**
   * One of §4's four transitions.
   *
   * Hand it whatever `@shared/graph/gravity` built — `landingTransition()`,
   * `makeTransition()` — and it decides for itself whether §3 already has this
   * one covered. Returns the sound it started, or null when it deliberately
   * left the transition to the noise path.
   */
  transition(t: LocomotionTransition): PlayingSound | null {
    switch (t.kind) {
      case 'launch':
        // Always: the shove is §3's (8, at ≥ LAUNCH_MIN), the room letting go
        // of you is ours, and below LAUNCH_MIN ours is the only sound there is.
        return this.launch(t.speed, t.gait);
      case 'settle':
        return this.settle();
      case 'liftoff':
        return this.liftoff();
      case 'landing':
        // §3 owns this one outright: `landingNoise` is never zero, so a real
        // NoiseEvent is already on its way to the body bus with the right gait.
        return this.echo ? this.land(t.speed, t.gait) : null;
      default:
        return null;
    }
  }

  /** True when this transition emits no NoiseEvent and is ours alone (§4). */
  static isSilent(kind: LocomotionTransitionKind, speed: number, gait: Gait): boolean {
    return transitionNoise(kind, speed, gait) === 0;
  }

  /** You walked or ran out of a floor. Momentum is conserved; so is the shove. */
  launch(speed: number, _gait: Gait = 'walk'): PlayingSound | null {
    const heat = Math.min(Math.max(speed, 0), PUSH_MAX) / PUSH_MAX;
    return this.engine.play({
      // Classified as the row it pays when it is loud enough to pay one (§4);
      // `source` is what makes it sound like leaving a room rather than a grunt.
      kind: 'push-off',
      level: LOUDNESS.PUSH_OFF,
      position: null,
      bus: 'body',
      reverb: 0.3,
      gain: this.gain * (0.7 + 0.5 * heat),
      speed,
      source: (ctx, dest, when, opts) => launchWhoosh(ctx, dest, when, speed, opts.seed ?? this.next()),
      seed: this.next(),
    });
  }

  /** You floated into a module that has a floor, and started falling. */
  settle(): PlayingSound | null {
    return this.engine.play({
      kind: 'gravity-shift',
      level: SILENT_TRANSITION_LEVEL,
      position: null,
      bus: 'body',
      reverb: 0.25,
      gain: this.gain,
      source: (ctx, dest, when, opts) => settleFall(ctx, dest, when, opts.seed ?? this.next()),
      seed: this.next(),
    });
  }

  /**
   * The floor failed underneath you (`LIFTOFF_IMPULSE_M_S`, 0.6 m/s).
   *
   * The klaxon and the 35-loudness bang are the module's; this is your body
   * leaving the deck, and it is small on purpose — §4 gives you about a second
   * with the deck still in reach and this is the sound of that second starting.
   */
  liftoff(): PlayingSound | null {
    return this.engine.play({
      kind: 'gravity-shift',
      level: SILENT_TRANSITION_LEVEL,
      position: null,
      bus: 'body',
      reverb: 0.3,
      gain: this.gain * 0.9,
      source: (ctx, dest, when, opts) => liftoffRelease(ctx, dest, when, opts.seed ?? this.next()),
      seed: this.next(),
    });
  }

  /** Effort on the way up. §3 has no row for a jump: only the landing is charged. */
  jump(): PlayingSound | null {
    return this.engine.play({
      kind: 'breathing',
      level: SILENT_TRANSITION_LEVEL,
      position: null,
      bus: 'body',
      reverb: 0.2,
      gain: this.gain * 0.75,
      source: (ctx, dest, when, opts) => jumpEffort(ctx, dest, when, opts.seed ?? this.next()),
      seed: this.next(),
    });
  }

  /**
   * One footstep, for a session with no noise runtime behind it.
   *
   * With a server this is redundant and must not be called — see
   * `echoNoisyEvents`. The loudness is read from §14 rather than passed in, so
   * even the offline path cannot disagree with the table.
   */
  footstep(gait: Gait): PlayingSound | null {
    const profile = gaitProfile(gait);
    return this.engine.play({
      kind: 'footstep',
      level: profile.footstep,
      position: null,
      bus: 'body',
      reverb: 0.35,
      gain: selfGain(profile.footstep),
      gait: profile.gait,
      source: (ctx, dest, when, opts) => footstep(ctx, dest, when, profile.gait, opts.seed ?? this.next()),
      seed: this.next(),
    });
  }

  /** A landing, same caveat as `footstep()`. Soft/hard is re-derived from §14. */
  land(speed: number, gait: Gait): PlayingSound | null {
    const profile = gaitProfile(gait);
    const soft = speed <= profile.landingSoftMaxMps;
    const v = Math.min(Math.max(speed, 0), TERMINAL_VELOCITY_M_S);
    return this.engine.play({
      kind: 'landing',
      level: profile.footstep,
      position: null,
      bus: 'body',
      reverb: 0.35,
      gain: selfGain(profile.footstep),
      gait: profile.gait,
      ...(soft ? {} : { speed: v }),
      source: (ctx, dest, when, opts) =>
        landing(ctx, dest, when, soft ? undefined : v, profile.gait, opts.seed ?? this.next()),
      seed: this.next(),
    });
  }

  private next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed % 9973;
  }
}
