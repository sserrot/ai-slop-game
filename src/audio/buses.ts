/**
 * The bus graph (DESIGN.md §8: "Separate buses: world / your own body /
 * tracker / voice. Duck the world bus and swell a sub-bass bed on HUNT").
 *
 *   spatial voices ─┐
 *                   ├─> world ──┐
 *   reverb return ──┘           │
 *   breathing, your grips ────> body ──┤
 *   wrist tracker ────────────> tracker ┼─> limiter ─> master ─> destination
 *   peer voice streams ───────> voice ──┤
 *   HUNT sub-bass bed ──────────────────┘   (never ducked: it IS the duck)
 *
 * Ducking the world while the alien hunts is what makes the hunt legible: the
 * station goes quiet under it and the sub-bass arrives in your chest. Body,
 * tracker and voice are deliberately NOT ducked — the information you need to
 * survive the next five seconds is on those three buses.
 */

import { OCCLUSION_LOWPASS_HZ, OPEN_LOWPASS_HZ } from '@shared/constants';

import { RAMP_TAU, ramp, setNow } from './levels';

export type BusName = 'world' | 'body' | 'tracker' | 'voice';

export interface BusOptions {
  masterVolume?: number;
  world?: number;
  body?: number;
  tracker?: number;
  voice?: number;
  /** World bus multiplier while the alien is hunting. */
  huntDuck?: number;
  /** Peak gain of the sub-bass bed at full hunt. */
  huntBed?: number;
  /** World bus multiplier while the listener is inside a hide spot (§4). */
  enclosedDuck?: number;
  /** Body bus multiplier while hidden — your own breathing gets louder. */
  enclosedBodyLift?: number;
  /** Proximity voice multiplier while hidden: it is outside the shell too. */
  enclosedVoiceDuck?: number;
}

const DEFAULTS = {
  masterVolume: 0.9,
  world: 1,
  body: 0.95,
  tracker: 0.8,
  voice: 1,
  huntDuck: 0.45,
  huntBed: 0.32,
  /**
   * §4 sizes the shell at −8 dB of MUFFLE ON WHAT YOU EMIT. This is the other
   * direction — what reaches you through it — and it is deliberately a little
   * deeper (0.55 ≈ −5 dB on top of a 400 Hz lowpass), because the trade hiding
   * makes is exactly that you can no longer hear the room you are hiding from.
   */
  enclosedDuck: 0.55,
  /**
   * And louder inside your own head. Not a mixing flourish: the one sound you
   * cannot stop making is the one that gives you away (§4), so it had better be
   * the one you are most aware of while you sit there deciding whether to run.
   */
  enclosedBodyLift: 1.45,
  enclosedVoiceDuck: 0.7,
};

const DUCK_TAU = 0.25;
const BED_TAU = 0.6;
/** Shutting a locker door is a fast event, but never an instantaneous one. */
const ENCLOSE_TAU = 0.09;

export class AudioBuses {
  private readonly ctx: AudioContext;

  readonly world: GainNode;
  readonly body: GainNode;
  readonly tracker: GainNode;
  readonly voice: GainNode;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;

  /**
   * §8's occlusion filter, applied to a whole bus rather than to one voice.
   *
   * Being inside a locker is the same physics as hearing through a closed
   * hatch, so it is the same machinery and the same constant: a lowpass at
   * `OCCLUSION_LOWPASS_HZ`, ramped and never stepped. Wide open otherwise.
   */
  private readonly worldFilter: BiquadFilterNode;

  private readonly levels: Record<BusName, number>;
  private readonly huntDuck: number;
  private readonly huntBed: number;
  private readonly enclosedDuck: number;
  private readonly enclosedBodyLift: number;
  private readonly enclosedVoiceDuck: number;

  private bedGain: GainNode | null = null;
  private bedNodes: OscillatorNode[] = [];
  private hunting = false;
  private enclosed = false;

  constructor(ctx: AudioContext, opts: BusOptions = {}) {
    this.ctx = ctx;
    this.huntDuck = opts.huntDuck ?? DEFAULTS.huntDuck;
    this.huntBed = opts.huntBed ?? DEFAULTS.huntBed;
    this.enclosedDuck = opts.enclosedDuck ?? DEFAULTS.enclosedDuck;
    this.enclosedBodyLift = opts.enclosedBodyLift ?? DEFAULTS.enclosedBodyLift;
    this.enclosedVoiceDuck = opts.enclosedVoiceDuck ?? DEFAULTS.enclosedVoiceDuck;
    this.levels = {
      world: opts.world ?? DEFAULTS.world,
      body: opts.body ?? DEFAULTS.body,
      tracker: opts.tracker ?? DEFAULTS.tracker,
      voice: opts.voice ?? DEFAULTS.voice,
    };

    // A gentle limiter, not a compressor pumping the mix: six players plus an
    // alien plus a hatch cycle can stack, and clipping in a horror game reads as
    // a bug. Threshold is high and the ratio steep so it only catches peaks.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.master = ctx.createGain();
    this.master.gain.value = opts.masterVolume ?? DEFAULTS.masterVolume;

    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    // The world bus is the only one with an insert: everything spatial — the
    // panner pool, the reverb return, the station hum — arrives through it, so
    // one filter here muffles the whole room at once.
    this.worldFilter = ctx.createBiquadFilter();
    this.worldFilter.type = 'lowpass';
    this.worldFilter.Q.value = 0.7;
    this.worldFilter.frequency.value = OPEN_LOWPASS_HZ;
    this.worldFilter.connect(this.limiter);

    this.world = this.makeBus(this.levels.world, this.worldFilter);
    this.body = this.makeBus(this.levels.body);
    this.tracker = this.makeBus(this.levels.tracker);
    this.voice = this.makeBus(this.levels.voice);
  }

  private makeBus(level: number, insert?: AudioNode): GainNode {
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    gain.connect(insert ?? this.limiter);
    return gain;
  }

  /** Target gain for one bus, folding in every duck that is currently on. */
  private targetFor(name: BusName): number {
    const level = this.levels[name];
    switch (name) {
      case 'world':
        return level * (this.hunting ? this.huntDuck : 1) * (this.enclosed ? this.enclosedDuck : 1);
      case 'body':
        return level * (this.enclosed ? this.enclosedBodyLift : 1);
      case 'voice':
        return level * (this.enclosed ? this.enclosedVoiceDuck : 1);
      default:
        return level;
    }
  }

  bus(name: BusName): GainNode {
    switch (name) {
      case 'body':
        return this.body;
      case 'tracker':
        return this.tracker;
      case 'voice':
        return this.voice;
      case 'world':
      default:
        return this.world;
    }
  }

  /** Player-facing volume slider for one bus. */
  setBusVolume(name: BusName, value: number): void {
    this.levels[name] = value;
    ramp(this.bus(name).gain, this.targetFor(name), this.ctx.currentTime, 0.05);
  }

  busVolume(name: BusName): number {
    return this.levels[name];
  }

  setMasterVolume(value: number): void {
    ramp(this.master.gain, value, this.ctx.currentTime, 0.05);
  }

  /**
   * §8's HUNT treatment: the station ducks and a sub-bass bed swells under it.
   * Idempotent — call it from the alien state handler on every transition.
   */
  setHunt(active: boolean): void {
    if (active === this.hunting) return;
    this.hunting = active;
    const now = this.ctx.currentTime;
    ramp(this.world.gain, this.targetFor('world'), now, DUCK_TAU);
    this.ensureBed();
    if (this.bedGain) ramp(this.bedGain.gain, active ? this.huntBed : 0, now, BED_TAU);
  }

  get isHunting(): boolean {
    return this.hunting;
  }

  /**
   * §4's hide spots, in the mix: the world goes behind a 400 Hz lowpass and
   * ducks, your own body comes forward, proximity voice goes with the world.
   *
   * The tracker is untouched on purpose. It is strapped to your wrist and it is
   * inside the locker with you — and it is the one instrument telling you when
   * the thing is leaning on the door, which is the decision the two-second
   * breach window exists to give you. Muffling it would be taking that away.
   *
   * Composes with `setHunt()` rather than fighting it: both ducks multiply, so
   * hiding while it hunts is the quietest the station ever gets.
   */
  setEnclosed(active: boolean): void {
    if (active === this.enclosed) return;
    this.enclosed = active;
    const now = this.ctx.currentTime;
    ramp(this.worldFilter.frequency, active ? OCCLUSION_LOWPASS_HZ : OPEN_LOWPASS_HZ, now, RAMP_TAU);
    ramp(this.world.gain, this.targetFor('world'), now, ENCLOSE_TAU);
    ramp(this.body.gain, this.targetFor('body'), now, ENCLOSE_TAU);
    ramp(this.voice.gain, this.targetFor('voice'), now, ENCLOSE_TAU);
  }

  get isEnclosed(): boolean {
    return this.enclosed;
  }

  /**
   * The bed: two very low sines a beat apart, lowpassed, with a slow tremolo.
   * It is felt more than heard, which is the point — it goes to the master
   * directly so the world duck cannot pull it down with everything else.
   *
   * THE TREMOLO IS ITS OWN STAGE, and it has to be. Driving `gain.gain`
   * directly from the LFO adds the modulation to the parameter rather than
   * multiplying it: the offset ramps to 0 when the hunt ends and the LFO keeps
   * swinging the actual value ±`depth` around it, so the bed never stops. Once
   * `ensureBed()` had run, the station carried a permanent 33 Hz drone for the
   * rest of the round — measured at RMS 0.6 with nothing else playing, which is
   * louder than most of the §3 table. Same fix, same reason, as `trackerTone`.
   */
  private ensureBed(): void {
    if (this.bedGain) return;
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 120;
    lowpass.Q.value = 0.7;

    const a = ctx.createOscillator();
    a.type = 'sine';
    a.frequency.value = 33;
    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.value = 40.5;
    const sub = ctx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.value = 66;

    const subTrim = ctx.createGain();
    subTrim.gain.value = 0.25;

    // Slow tremolo so the bed breathes instead of droning. Multiplicative, in
    // its own stage, so `gain` remains a clean on/off the hunt state owns.
    const depth = 0.35;
    const trem = ctx.createGain();
    trem.gain.value = 1 - depth;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.17;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = depth;
    lfo.connect(lfoDepth);
    lfoDepth.connect(trem.gain);

    a.connect(lowpass);
    b.connect(lowpass);
    sub.connect(subTrim);
    subTrim.connect(lowpass);
    lowpass.connect(trem);
    trem.connect(gain);
    gain.connect(this.master);

    const now = ctx.currentTime;
    a.start(now);
    b.start(now);
    sub.start(now);
    lfo.start(now);

    this.bedGain = gain;
    this.bedNodes = [a, b, sub, lfo];
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    if (this.bedGain) setNow(this.bedGain.gain, 0, now);
    for (const node of this.bedNodes) {
      try {
        node.stop(now);
        node.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.bedNodes = [];
    for (const node of [
      this.world,
      this.worldFilter,
      this.body,
      this.tracker,
      this.voice,
      this.limiter,
      this.master,
    ]) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }
}
