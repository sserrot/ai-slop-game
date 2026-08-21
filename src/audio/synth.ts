/**
 * Every sound in ISS, synthesized (DESIGN.md §8, §9).
 *
 * There are no audio assets in this repository. Each entry below is oscillators,
 * filtered noise and envelopes — which is also why they are *legible*: a clean
 * catch and a crash are built from the same materials with different brightness
 * and decay, so a player learns to tell them apart in one round (§4).
 *
 * Everything is normalised to roughly the same peak amplitude. How loud a sound
 * actually plays is decided by `levels.ts` from the §3 arrival level, never by
 * an accident of oscillator amplitude here.
 */

import {
  GRAVITY_WARNING_S,
  PUSH_MAX,
  TERMINAL_VELOCITY_M_S,
  TRACKER_BEEP_ATTACK_FAR_S,
  TRACKER_BEEP_ATTACK_NEAR_S,
  TRACKER_BEEP_DECAY_FAR_S,
  TRACKER_BEEP_DECAY_NEAR_S,
  TRACKER_BEEP_PEAK_FAR,
  TRACKER_BEEP_PEAK_NEAR,
  TRACKER_SOLID_PEAK,
  TRACKER_SOLID_ROOT_HZ,
  TRACKER_SOLID_TREMOLO_DEPTH,
  TRACKER_SOLID_TREMOLO_HZ,
  TRACKER_TONE_FAR_HZ,
  TRACKER_TONE_LOWPASS_FAR_HZ,
  TRACKER_TONE_LOWPASS_NEAR_HZ,
  TRACKER_TONE_NEAR_HZ,
  clamp,
  gaitProfile,
} from '@shared/constants';
import type { Gait, NoiseKind } from '@shared/types';
import { mulberry32, noiseBuffer, type NoiseColour } from './buffers';

/** A scheduled sound. `duration` is when its nodes may be torn down. */
export interface SynthHandle {
  /** Seconds from the start time until the tail has fully decayed. */
  duration: number;
  /** Stop a sustained source. Harmless on a one-shot. */
  stop(when?: number, fadeSeconds?: number): void;
}

export interface SynthOptions {
  /** m/s — 'catch', 'impact' and a hard 'landing' scale with it (§14). */
  speed?: number;
  /** 0–1 — 'breathing', 'voice' and the hide verbs' haste scale with it (§14). */
  intensity?: number;
  /**
   * Which gait a 'footstep' or a soft 'landing' was made in (§4).
   *
   * The three are meant to be told apart BY EAR — footstep loudness is the
   * player's primary noise dial and they have to hear their own risk — so this
   * is not a volume parameter. Each gait is a different sound: a crouch has no
   * heel transient at all, a walk has a defined tick, a sprint rings the deck.
   */
  gait?: Gait;
  /** Deterministic variation between repeats of the same sound. */
  seed?: number;
  /** Sustained rather than one-shot, where the kind supports it. */
  sustain?: boolean;
}

/**
 * A sound that is NOT a row of the §3 table.
 *
 * `launch`, `settle` and `liftoff` (§4's four transitions) emit no NoiseEvent at
 * all — "zero loudness means emit no event" — but they are still things that
 * happen to your body, and a set-piece with no sound reads as a bug. Those play
 * through `AudioEngine.play({ source })` instead of through a NoiseKind.
 */
export type SynthSource = (
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  opts: SynthOptions,
) => SynthHandle;

const SILENCE = 1e-4;

// ===========================================================================
// Primitives
// ===========================================================================

function expRamp(param: AudioParam, value: number, at: number): void {
  param.exponentialRampToValueAtTime(Math.max(value, SILENCE), at);
}

/** Straight-line blend. Not a tuning value — the endpoints are, in §14. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Blend on a log scale. For anything the ear judges as a ratio — pitch, filter
 * cutoff, tempo — this is the one that sounds like an even sweep; a linear blend
 * of Hz crams most of the perceived movement into the bottom of the range.
 */
function geomLerp(a: number, b: number, t: number): number {
  return a * Math.pow(b / a, t);
}

interface EnvSpec {
  attack?: number;
  hold?: number;
  decay: number;
  peak: number;
}

/** Percussive amplitude envelope. Exponential, because linear decays tick. */
function envelope(ctx: AudioContext, when: number, spec: EnvSpec): { gain: GainNode; end: number } {
  const attack = spec.attack ?? 0.002;
  const hold = spec.hold ?? 0;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(SILENCE, when);
  expRamp(gain.gain, spec.peak, when + attack);
  if (hold > 0) gain.gain.setValueAtTime(Math.max(spec.peak, SILENCE), when + attack + hold);
  expRamp(gain.gain, SILENCE, when + attack + hold + spec.decay);
  gain.gain.setValueAtTime(0, when + attack + hold + spec.decay + 0.001);
  return { gain, end: when + attack + hold + spec.decay + 0.002 };
}

interface NoiseSpec extends EnvSpec {
  colour?: NoiseColour;
  type?: BiquadFilterType;
  freq?: number;
  freqTo?: number;
  q?: number;
  seed?: number;
}

/** A filtered burst of noise. The workhorse of every impact in the game. */
function noiseBurst(ctx: AudioContext, dest: AudioNode, when: number, spec: NoiseSpec): number {
  const buffer = noiseBuffer(ctx, spec.colour ?? 'white', 2, spec.seed ?? 1337);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  // Start at a random-ish offset so repeats do not phase-lock into a tone.
  const offset = ((spec.seed ?? 1337) % 977) / 1000;

  const filter = ctx.createBiquadFilter();
  filter.type = spec.type ?? 'bandpass';
  filter.frequency.setValueAtTime(Math.max(spec.freq ?? 1000, 20), when);
  if (spec.freqTo !== undefined) {
    expRamp(filter.frequency, Math.max(spec.freqTo, 20), when + (spec.attack ?? 0.002) + spec.decay);
  }
  filter.Q.value = spec.q ?? 1;

  const { gain, end } = envelope(ctx, when, spec);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  src.start(when, offset);
  src.stop(end);
  return end;
}

interface ToneSpec extends EnvSpec {
  type?: OscillatorType;
  freq: number;
  freqTo?: number;
  detune?: number;
}

/** A single enveloped oscillator. */
function tone(ctx: AudioContext, dest: AudioNode, when: number, spec: ToneSpec): number {
  const osc = ctx.createOscillator();
  osc.type = spec.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(spec.freq, 1), when);
  if (spec.detune) osc.detune.value = spec.detune;
  const { gain, end } = envelope(ctx, when, spec);
  if (spec.freqTo !== undefined) expRamp(osc.frequency, Math.max(spec.freqTo, 1), end);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(when);
  osc.stop(end);
  return end;
}

/**
 * Inharmonic partials with per-partial decay: the sound of struck metal, which
 * is most of a space station. Higher partials die first, as they do in life.
 */
function metalRing(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  partials: readonly number[],
  spec: { decay: number; peak: number; attack?: number },
): number {
  let end = when;
  partials.forEach((freq, i) => {
    const decay = spec.decay * Math.pow(0.62, i);
    const peak = spec.peak * Math.pow(0.68, i);
    const at = tone(ctx, dest, when, {
      type: 'sine',
      freq,
      decay,
      peak,
      attack: spec.attack ?? 0.001,
    });
    if (at > end) end = at;
  });
  return end;
}

/** A sustained, looping noise source with a live gain and filter. */
interface SustainedNoise {
  gain: GainNode;
  filter: BiquadFilterNode;
  source: AudioBufferSourceNode;
  stop(when: number, fade: number): void;
}

function sustainedNoise(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  spec: { colour?: NoiseColour; type?: BiquadFilterType; freq: number; q?: number; peak: number; attack?: number; seed?: number },
): SustainedNoise {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, spec.colour ?? 'white', 2, spec.seed ?? 4242);
  src.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = spec.type ?? 'bandpass';
  filter.frequency.value = spec.freq;
  filter.Q.value = spec.q ?? 1;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(SILENCE, when);
  expRamp(gain.gain, spec.peak, when + (spec.attack ?? 0.05));

  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  src.start(when);

  return {
    gain,
    filter,
    source: src,
    stop(at: number, fade: number): void {
      const t = Math.max(at, ctx.currentTime);
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, SILENCE), t);
      expRamp(gain.gain, SILENCE, t + fade);
      try {
        src.stop(t + fade + 0.02);
      } catch {
        /* already stopped */
      }
    },
  };
}

function oneShot(duration: number): SynthHandle {
  return { duration, stop: () => undefined };
}

/**
 * Per-instance variation.
 *
 * A footstep fires every 0.48–0.74 s for the whole round; played identically it
 * stops being a footstep and becomes a machine-gun loop, which is the single
 * fastest way to make a procedural walk cycle sound synthetic. Every repeated
 * sound below pulls its pitch, decay and level through this, seeded from the
 * caller's seed so the same event is still the same sound on every machine.
 */
function varier(seed: number): (amount: number) => number {
  const rng = mulberry32(seed >>> 0);
  return (amount: number) => 1 + (rng() * 2 - 1) * amount;
}

// ===========================================================================
// The §3 table, one function per row
// ===========================================================================

/** 4 — a glove sliding a handrail. Two module-metres of sound. */
export function railPull(ctx: AudioContext, dest: AudioNode, when: number, seed = 11): SynthHandle {
  const end = noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'bandpass',
    freq: 2400,
    freqTo: 900,
    q: 2.5,
    attack: 0.006,
    decay: 0.09,
    peak: 0.32,
    seed,
  });
  tone(ctx, dest, when, { type: 'triangle', freq: 240, decay: 0.05, peak: 0.08 });
  return oneShot(end - when);
}

/** 8 — the shove that starts a crossing. */
export function pushOff(ctx: AudioContext, dest: AudioNode, when: number, seed = 23): SynthHandle {
  const end = noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'lowpass',
    freq: 700,
    freqTo: 260,
    attack: 0.004,
    decay: 0.16,
    peak: 0.42,
    seed,
  });
  tone(ctx, dest, when, { type: 'sine', freq: 96, freqTo: 62, decay: 0.14, peak: 0.3 });
  return oneShot(end - when);
}

/**
 * 8 + 3v — an ARRESTED catch. Bright, short, controlled: the sound of doing it
 * right. Compare `impact` below; §4 hangs the entire risk ladder on a player
 * being able to hear the difference.
 */
export function railCatch(ctx: AudioContext, dest: AudioNode, when: number, speed = 0, seed = 31): SynthHandle {
  const h = clamp(speed / PUSH_MAX, 0, 1);
  const end = metalRing(ctx, dest, when, [560 + 120 * h, 1290, 2380], {
    decay: 0.09 + 0.1 * h,
    peak: 0.3 + 0.28 * h,
  });
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'bandpass',
    freq: 1400 + 1700 * h,
    q: 1.6,
    attack: 0.002,
    decay: 0.05 + 0.05 * h,
    peak: 0.26 + 0.3 * h,
    seed,
  });
  // The glove itself.
  noiseBurst(ctx, dest, when + 0.004, {
    colour: 'pink',
    type: 'lowpass',
    freq: 900,
    attack: 0.003,
    decay: 0.07,
    peak: 0.18,
    seed: seed + 1,
  });
  return oneShot(end - when + 0.05);
}

/** 15 + 6v — you did not catch it. Low, long, and it keeps ringing. */
export function impact(ctx: AudioContext, dest: AudioNode, when: number, speed = 0, seed = 47): SynthHandle {
  const h = clamp(speed / PUSH_MAX, 0, 1);
  const end = metalRing(ctx, dest, when, [128, 331, 742, 1180], {
    decay: 0.55 + 0.65 * h,
    peak: 0.34 + 0.3 * h,
    attack: 0.001,
  });
  tone(ctx, dest, when, { type: 'sine', freq: 74, freqTo: 41, decay: 0.3 + 0.25 * h, peak: 0.5 });
  noiseBurst(ctx, dest, when, {
    colour: 'brown',
    type: 'lowpass',
    freq: 900,
    freqTo: 220,
    attack: 0.001,
    decay: 0.28 + 0.2 * h,
    peak: 0.42,
    seed,
  });
  if (h > 0.35) {
    // A real crack on top, only when it was fast enough to hurt.
    noiseBurst(ctx, dest, when, {
      colour: 'white',
      type: 'highpass',
      freq: 2600,
      attack: 0.001,
      decay: 0.05 + 0.06 * h,
      peak: 0.2 * h,
      seed: seed + 3,
    });
  }
  return oneShot(end - when + 0.1);
}

/** 25 — a shoulder into a bulkhead while your hands are full. */
export function bodyCollision(ctx: AudioContext, dest: AudioNode, when: number, seed = 53): SynthHandle {
  const end = noiseBurst(ctx, dest, when, {
    colour: 'brown',
    type: 'lowpass',
    freq: 420,
    freqTo: 160,
    attack: 0.002,
    decay: 0.26,
    peak: 0.5,
    seed,
  });
  tone(ctx, dest, when, { type: 'sine', freq: 88, freqTo: 54, decay: 0.22, peak: 0.42 });
  noiseBurst(ctx, dest, when + 0.02, {
    colour: 'pink',
    type: 'bandpass',
    freq: 1600,
    q: 0.9,
    attack: 0.01,
    decay: 0.2,
    peak: 0.12,
    seed: seed + 1,
  });
  return oneShot(end - when);
}

/** 30 — a cargo bag off a wall, and now you have five problems (§11). */
export function cargoBounce(ctx: AudioContext, dest: AudioNode, when: number, seed = 59): SynthHandle {
  const end = noiseBurst(ctx, dest, when, {
    colour: 'brown',
    type: 'lowpass',
    freq: 300,
    attack: 0.002,
    decay: 0.2,
    peak: 0.5,
  });
  tone(ctx, dest, when, { type: 'sine', freq: 118, freqTo: 72, decay: 0.18, peak: 0.4 });
  noiseBurst(ctx, dest, when + 0.03, {
    colour: 'velvet',
    type: 'bandpass',
    freq: 2400,
    q: 2,
    attack: 0.005,
    decay: 0.32,
    peak: 0.16,
    seed,
  });
  return oneShot(end - when + 0.3);
}

/** 15 — a knuckle on a handrail. The §10 knock-code primitive. */
export function knock(ctx: AudioContext, dest: AudioNode, when: number, seed = 61): SynthHandle {
  const end = metalRing(ctx, dest, when, [523, 1470, 2830, 4100], { decay: 0.19, peak: 0.5 });
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'highpass',
    freq: 2200,
    attack: 0.0008,
    decay: 0.02,
    peak: 0.3,
    seed,
  });
  return oneShot(end - when + 0.05);
}

/**
 * 20 — the wrist tracker, in-world and hearable by the thing hunting you (§6).
 *
 * Playtest 2 called r1's version "very high pitched and very annoying" and could
 * not tell what it meant. r1 was a 2100–2600 Hz square wave with a 2 ms attack:
 * a smoke alarm sitting in the band the ear is most sensitive to, whose only
 * variable was a 500 Hz drift nobody can hear as information.
 *
 * This is the device rebuilt a second time (audition-deck v3) as a SONAR
 * PEBBLE: a water-drop ping whose transient is a fast pitch-fall onto the root
 * rather than an amplitude edge, through one closing lowpass. v2's instrument
 * fixed "piercing" but the triangle fundamental still read as an electronic
 * chirp by minute fifteen; a falling sine has no waveform edge at all, and the
 * register drops a fourth on top. Everything that moves, moves with `urgency`
 * and moves the SAME way (§14):
 *
 *   far  (0)  145/290 Hz, dull (620 Hz lowpass), soft, quiet, long   — a drip
 *   near (1)  320/640 Hz, open (2.1 kHz lowpass), tight, loud, short — a ping
 *
 * so the two ends are a different NOTE and a different TIMBRE, not merely a
 * different tempo. A damp noise tick fades in only past mid-urgency so the
 * contact-range ping still cuts through a chase without the far tick ever
 * carrying an edge.
 */
export function trackerBeep(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  urgency = 0,
): SynthHandle {
  const u = clamp(urgency, 0, 1);
  const root = geomLerp(TRACKER_TONE_FAR_HZ, TRACKER_TONE_NEAR_HZ, u);
  const attack = lerp(TRACKER_BEEP_ATTACK_FAR_S, TRACKER_BEEP_ATTACK_NEAR_S, u);
  const decay = lerp(TRACKER_BEEP_DECAY_FAR_S, TRACKER_BEEP_DECAY_NEAR_S, u);
  const peak = lerp(TRACKER_BEEP_PEAK_FAR, TRACKER_BEEP_PEAK_NEAR, u);
  const cutoff = geomLerp(TRACKER_TONE_LOWPASS_FAR_HZ, TRACKER_TONE_LOWPASS_NEAR_HZ, u);

  // One lowpass across the whole ping, closing as it decays: the top goes
  // first, exactly as it does on any real resonant body.
  const shaper = ctx.createBiquadFilter();
  shaper.type = 'lowpass';
  shaper.Q.value = 1.1;
  shaper.frequency.setValueAtTime(cutoff, when);
  expRamp(shaper.frequency, cutoff * 0.4, when + attack + decay);
  shaper.connect(dest);

  // The drop: starts a fourth high and lands on the root within the attack.
  // The pitch-fall IS the transient — there is no click to flinch at.
  const end = tone(ctx, shaper, when, {
    type: 'sine',
    freq: root * 1.33,
    freqTo: root,
    attack,
    decay,
    peak,
  });
  // Body — an octave below, ringing a third longer. It is what makes the idle
  // tick read as *low* instead of merely *quiet*.
  const bodyEnd = tone(ctx, shaper, when, {
    type: 'sine',
    freq: root * 0.5,
    attack,
    decay: decay * 1.35,
    peak: peak * 0.5,
  });
  // Near-contact only: a damp tick so the ping stays audible through a chase.
  // Gated past mid-urgency — the far tick must never carry an edge.
  if (u > 0.3) {
    noiseBurst(ctx, shaper, when, {
      colour: 'pink',
      type: 'bandpass',
      freq: 1000 + 800 * u,
      q: 2.5,
      attack: 0.001,
      decay: 0.015,
      peak: peak * 0.28 * u,
    });
  }
  return oneShot(Math.max(end, bodyEnd) - when);
}

/**
 * The tracker's solid state when the alien is adjacent (§6).
 *
 * Audition-deck v2: not a held note any more — a dark 220 Hz THROB with a fast,
 * deep amplitude flutter and a sub octave under it. "Adjacent" should feel like
 * your own body reacting (a racing heartbeat), not like the device screaming; a
 * continuous 880 Hz chord was the definition of alarm fatigue. The flutter rate
 * sits far above the beep cadence so the state is still unmistakably distinct
 * from fast beeping, the register DROP from the near ping is itself the third
 * legibility cue, and the whole upper spectrum stays free for the alien —
 * which, at contact range, is the sound that actually matters.
 */
export function trackerTone(ctx: AudioContext, dest: AudioNode, when: number): SynthHandle {
  const root = TRACKER_SOLID_ROOT_HZ;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(SILENCE, when);
  expRamp(gain.gain, TRACKER_SOLID_PEAK, when + 0.08);
  gain.connect(dest);

  const shaper = ctx.createBiquadFilter();
  shaper.type = 'lowpass';
  shaper.frequency.value = 900;
  shaper.Q.value = 0.8;
  shaper.connect(gain);

  // Tremolo stage: a fixed offset plus an LFO, so `stop()` can fade `gain`
  // without fighting the modulation.
  const depth = clamp(TRACKER_SOLID_TREMOLO_DEPTH, 0, 1) * 0.5;
  const trem = ctx.createGain();
  trem.gain.value = 1 - depth;
  trem.connect(shaper);
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = TRACKER_SOLID_TREMOLO_HZ;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = depth;
  lfo.connect(lfoDepth);
  lfoDepth.connect(trem.gain);

  const partials: Array<[OscillatorType, number, number]> = [
    ['triangle', root, 0.55],
    ['sine', root * 0.5, 0.42],
    ['sine', root * 2, 0.06],
  ];
  const oscs = partials.map(([type, freq, level]) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const trim = ctx.createGain();
    trim.gain.value = level;
    osc.connect(trim);
    trim.connect(trem);
    osc.start(when);
    return osc;
  });
  lfo.start(when);

  return {
    duration: Number.POSITIVE_INFINITY,
    stop(at = ctx.currentTime, fade = 0.06): void {
      const t = Math.max(at, ctx.currentTime);
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(gain.gain.value, SILENCE), t);
      expRamp(gain.gain, SILENCE, t + fade);
      try {
        for (const osc of oscs) osc.stop(t + fade + 0.02);
        lfo.stop(t + fade + 0.02);
      } catch {
        /* already stopped */
      }
    },
  };
}

/** 35 — a breaker thrown. CLACK (§11 puzzle 1). */
export function breaker(ctx: AudioContext, dest: AudioNode, when: number, seed = 71): SynthHandle {
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'highpass',
    freq: 3000,
    attack: 0.0005,
    decay: 0.018,
    peak: 0.55,
    seed,
  });
  const end = metalRing(ctx, dest, when + 0.002, [820, 1640, 2950], { decay: 0.07, peak: 0.34 });
  tone(ctx, dest, when, { type: 'triangle', freq: 150, freqTo: 96, decay: 0.09, peak: 0.3 });
  return oneShot(end - when + 0.03);
}

/**
 * 50 — the wrong order (§11). Audition-deck v2: the refusal, not a buzzer.
 *
 * r1 was a 27 Hz-gated sawtooth — deliberately annoying, and by playtest it
 * read as a smoke alarm rather than as information. This is the same event as
 * hardware would do it: the contactor drops with a heavy CLUNK, three
 * descending dead thuds ("no. no. no.") as the sequence dumps, and a capacitor
 * bleed-down whine that is felt more than heard. Falling pitch reads as
 * REFUSAL to every player instantly, and at loudness 50 it still carries two
 * modules — loud and unmistakable without being painful.
 */
export function breakerReset(ctx: AudioContext, dest: AudioNode, when: number, seed = 73): SynthHandle {
  // The contactor.
  let end = metalRing(ctx, dest, when, [138, 296, 615], { decay: 0.3, peak: 0.5 });
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'highpass',
    freq: 2600,
    attack: 0.0008,
    decay: 0.02,
    peak: 0.26,
    seed,
  });

  // Three descending dead thuds — the sequence dumping.
  const thuds: ReadonlyArray<[number, number, number]> = [
    [0.12, 158, 112],
    [0.28, 128, 90],
    [0.46, 102, 68],
  ];
  thuds.forEach(([dt, freq, freqTo], i) => {
    const at = tone(ctx, dest, when + dt, {
      type: 'sine',
      freq,
      freqTo,
      attack: 0.004,
      decay: 0.12,
      peak: 0.34 - i * 0.04,
    });
    noiseBurst(ctx, dest, when + dt, {
      colour: 'brown',
      type: 'lowpass',
      freq: 420,
      freqTo: 150,
      attack: 0.003,
      decay: 0.1,
      peak: 0.22,
      seed: seed + i + 1,
    });
    if (at > end) end = at;
  });

  // Capacitor bleed-down. Barely there — the felt half of the refusal.
  const bleed = tone(ctx, dest, when + 0.05, {
    type: 'sine',
    freq: 1150,
    freqTo: 240,
    attack: 0.02,
    decay: 0.42,
    peak: 0.045,
  });
  if (bleed > end) end = bleed;
  return oneShot(end - when);
}

/** 8 — the coolant valve turned patiently (§11 puzzle 2). */
export function valveSlow(ctx: AudioContext, dest: AudioNode, when: number, seed = 79): SynthHandle {
  const duration = 0.8;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 'white', 2, seed);
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(1250, when);
  filter.frequency.linearRampToValueAtTime(1600, when + duration);
  filter.Q.value = 14;

  const wobble = ctx.createOscillator();
  wobble.type = 'sine';
  wobble.frequency.value = 5.5;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = 220;
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(filter.frequency);

  const { gain, end } = envelope(ctx, when, { attack: 0.08, hold: duration - 0.25, decay: 0.17, peak: 0.22 });
  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  src.start(when);
  wobble.start(when);
  src.stop(end);
  wobble.stop(end);
  return oneShot(end - when);
}

/** 40 — the same valve spun. Fast, and four times as far (§11 puzzle 2). */
export function valveFast(ctx: AudioContext, dest: AudioNode, when: number, seed = 83): SynthHandle {
  const duration = 0.7;
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'bandpass',
    freq: 500,
    freqTo: 2600,
    q: 1.2,
    attack: 0.02,
    hold: duration * 0.5,
    decay: 0.2,
    peak: 0.34,
    seed,
  });
  // The ratchet.
  const clicks = 11;
  for (let i = 0; i < clicks; i++) {
    const at = when + (i / clicks) * duration;
    noiseBurst(ctx, dest, at, {
      colour: 'white',
      type: 'highpass',
      freq: 3200,
      attack: 0.0005,
      decay: 0.012,
      peak: 0.22,
      seed: seed + i,
    });
  }
  const end = metalRing(ctx, dest, when + duration, [640, 1320], { decay: 0.18, peak: 0.24 });
  return oneShot(end - when);
}

/** 45 — a hatch cycling. Latch, motor, latch. You hear it three modules away,
 *  and so does the alien; the alien pays this too when it opens one (§5). */
export function hatchCycle(ctx: AudioContext, dest: AudioNode, when: number, seed = 89): SynthHandle {
  const motorStart = when + 0.12;
  const motorLength = 1.15;

  metalRing(ctx, dest, when, [190, 410, 860], { decay: 0.16, peak: 0.45 });
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'highpass',
    freq: 2000,
    attack: 0.001,
    decay: 0.04,
    peak: 0.3,
    seed,
  });

  const motor = ctx.createOscillator();
  motor.type = 'sawtooth';
  motor.frequency.setValueAtTime(58, motorStart);
  motor.frequency.linearRampToValueAtTime(71, motorStart + motorLength * 0.7);
  motor.frequency.linearRampToValueAtTime(54, motorStart + motorLength);

  const motorFilter = ctx.createBiquadFilter();
  motorFilter.type = 'lowpass';
  motorFilter.frequency.value = 780;
  motorFilter.Q.value = 3;

  const { gain: motorGain, end: motorEnd } = envelope(ctx, motorStart, {
    attack: 0.06,
    hold: motorLength - 0.2,
    decay: 0.14,
    peak: 0.3,
  });
  motor.connect(motorFilter);
  motorFilter.connect(motorGain);
  motorGain.connect(dest);
  motor.start(motorStart);
  motor.stop(motorEnd);

  noiseBurst(ctx, dest, motorStart, {
    colour: 'pink',
    type: 'bandpass',
    freq: 1400,
    q: 0.8,
    attack: 0.08,
    hold: motorLength - 0.2,
    decay: 0.12,
    peak: 0.12,
    seed: seed + 5,
  });

  const closeAt = motorStart + motorLength;
  const end = metalRing(ctx, dest, closeAt, [150, 330, 690], { decay: 0.35, peak: 0.5 });
  return oneShot(end - when + 0.1);
}

/** 45 — the airlock keyswitch. Unavoidable, whatever you do (§11 puzzle 5). */
export function keyswitch(ctx: AudioContext, dest: AudioNode, when: number, seed = 97): SynthHandle {
  metalRing(ctx, dest, when, [740, 1580], { decay: 0.06, peak: 0.34 });
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'highpass',
    freq: 2800,
    attack: 0.0006,
    decay: 0.02,
    peak: 0.4,
    seed,
  });
  tone(ctx, dest, when + 0.03, { type: 'triangle', freq: 128, freqTo: 84, decay: 0.16, peak: 0.4 });
  // Relay chatter behind it.
  const buzzEnd = noiseBurst(ctx, dest, when + 0.05, {
    colour: 'white',
    type: 'bandpass',
    freq: 1200,
    q: 6,
    attack: 0.01,
    hold: 0.12,
    decay: 0.14,
    peak: 0.18,
    seed: seed + 2,
  });
  return oneShot(buzzEnd - when);
}

/** 60 — the loud-fast path. Metal complaining, then giving (§11). */
export function pryBar(ctx: AudioContext, dest: AudioNode, when: number, seed = 101): SynthHandle {
  const groan = 0.95;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 'white', 2, seed);
  src.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(320, when);
  filter.frequency.exponentialRampToValueAtTime(1500, when + groan);
  filter.Q.value = 11;

  const wobble = ctx.createOscillator();
  wobble.type = 'triangle';
  wobble.frequency.value = 8.5;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = 120;
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(filter.frequency);

  const { gain, end } = envelope(ctx, when, { attack: 0.12, hold: groan - 0.25, decay: 0.16, peak: 0.42 });
  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  src.start(when);
  wobble.start(when);
  src.stop(end);
  wobble.stop(end);

  // …and it lets go.
  const snapAt = when + groan;
  const snapEnd = metalRing(ctx, dest, snapAt, [420, 980, 2100, 3300], { decay: 0.3, peak: 0.55 });
  noiseBurst(ctx, dest, snapAt, {
    colour: 'white',
    type: 'highpass',
    freq: 1800,
    attack: 0.001,
    decay: 0.09,
    peak: 0.42,
    seed: seed + 1,
  });
  return oneShot(Math.max(end, snapEnd) - when);
}

/** 6 — the quiet-slow path. 25 seconds of this, anchored, unable to look (§11). */
export function handPump(ctx: AudioContext, dest: AudioNode, when: number, seed = 103): SynthHandle {
  const end = noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'bandpass',
    freq: 900,
    freqTo: 620,
    q: 3.5,
    attack: 0.05,
    hold: 0.16,
    decay: 0.2,
    peak: 0.22,
    seed,
  });
  tone(ctx, dest, when + 0.24, { type: 'sine', freq: 132, freqTo: 88, decay: 0.14, peak: 0.16 });
  return oneShot(end - when + 0.2);
}

/** 60 — an undock release lever, held for five seconds. The finale (§11). */
export function undockLever(ctx: AudioContext, dest: AudioNode, when: number, seed = 107): SynthHandle {
  metalRing(ctx, dest, when, [96, 214, 480], { decay: 0.4, peak: 0.5 });
  const hiss = noiseBurst(ctx, dest, when + 0.05, {
    colour: 'white',
    type: 'bandpass',
    freq: 1500,
    freqTo: 900,
    q: 0.7,
    attack: 0.03,
    hold: 0.45,
    decay: 0.25,
    peak: 0.3,
    seed,
  });
  const end = metalRing(ctx, dest, when + 0.72, [130, 290, 610], { decay: 0.45, peak: 0.45 });
  return oneShot(Math.max(hiss, end) - when);
}

/** 65 — the fire extinguisher. A panic button with a price (§4). */
export function extinguisher(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  opts: { sustain?: boolean; seed?: number } = {},
): SynthHandle {
  const seed = opts.seed ?? 109;
  if (opts.sustain) {
    const hiss = sustainedNoise(ctx, dest, when, {
      colour: 'white',
      type: 'bandpass',
      freq: 2600,
      q: 0.6,
      peak: 0.55,
      attack: 0.03,
      seed,
    });
    const body = sustainedNoise(ctx, dest, when, {
      colour: 'pink',
      type: 'highpass',
      freq: 700,
      peak: 0.3,
      attack: 0.04,
      seed: seed + 1,
    });
    return {
      duration: Number.POSITIVE_INFINITY,
      stop(at = ctx.currentTime, fade = 0.12): void {
        hiss.stop(at, fade);
        body.stop(at, fade);
      },
    };
  }
  const end = noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'bandpass',
    freq: 2800,
    freqTo: 1800,
    q: 0.6,
    attack: 0.02,
    hold: 0.4,
    decay: 0.3,
    peak: 0.55,
    seed,
  });
  noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'highpass',
    freq: 600,
    attack: 0.03,
    hold: 0.35,
    decay: 0.3,
    peak: 0.28,
    seed: seed + 1,
  });
  return oneShot(end - when);
}

/** 70 — a decoy. The loudest thing in the game, and you only have two (§5). */
export function decoy(ctx: AudioContext, dest: AudioNode, when: number, seed = 113): SynthHandle {
  tone(ctx, dest, when, { type: 'sine', freq: 96, freqTo: 38, decay: 0.55, peak: 0.6 });
  metalRing(ctx, dest, when, [210, 495, 1120, 2340], { decay: 0.7, peak: 0.5 });
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'highpass',
    freq: 1500,
    attack: 0.001,
    decay: 0.12,
    peak: 0.5,
    seed,
  });
  // Clatter: it bounces, and keeps bouncing.
  let end = when + 0.8;
  for (let i = 1; i <= 4; i++) {
    const at = when + 0.18 * i + i * i * 0.02;
    const e = metalRing(ctx, dest, at, [380 + i * 90, 1180 + i * 140], {
      decay: 0.22 / i,
      peak: 0.3 / i,
    });
    if (e > end) end = e;
  }
  return oneShot(end - when);
}

/**
 * 5 — a spectator's headset leaking into the room (§10).
 *
 * Audition-deck v2: the fiction is leaked SPEECH, and r1's narrow 1900 Hz
 * chirp read as feedback squeal. A formant wobbling at syllable rate says
 * "voice" instead, with a tiny transistor tick on top — someone talking in a
 * tin can, too far away to make out.
 */
export function headset(ctx: AudioContext, dest: AudioNode, when: number, seed = 127): SynthHandle {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 'pink', 2, seed);
  src.loop = true;

  const formant = ctx.createBiquadFilter();
  formant.type = 'bandpass';
  formant.frequency.value = 950;
  formant.Q.value = 3.2;

  // Syllable-rate wobble — the murmur.
  const wobble = ctx.createOscillator();
  wobble.type = 'sine';
  wobble.frequency.value = 6.2;
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.value = 260;
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(formant.frequency);

  const { gain, end } = envelope(ctx, when, { attack: 0.025, hold: 0.14, decay: 0.16, peak: 0.14 });
  src.connect(formant);
  formant.connect(gain);
  gain.connect(dest);
  src.start(when);
  wobble.start(when);
  src.stop(end);
  wobble.stop(end);

  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'bandpass',
    freq: 2400,
    q: 8,
    attack: 0.004,
    decay: 0.02,
    peak: 0.04,
    seed: seed + 1,
  });
  return oneShot(end - when);
}

/**
 * 6–14 — one breath. The direct counter to the freeze meta (§6): standing still
 * next to the alien stops being free, because you are still breathing.
 */
export function breath(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  opts: { intensity?: number; exhale?: boolean; seed?: number } = {},
): SynthHandle {
  const i = clamp(opts.intensity ?? 0, 0, 1);
  const exhale = opts.exhale ?? false;
  const duration = (exhale ? 0.5 : 0.42) * (1 - 0.3 * i);
  const peak = 0.18 + 0.4 * i;
  const end = noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'bandpass',
    freq: exhale ? 620 + 260 * i : 420 + 200 * i,
    freqTo: exhale ? 300 : 1000 + 400 * i,
    q: exhale ? 1.1 : 1.6,
    attack: exhale ? 0.05 : 0.12,
    hold: duration * 0.25,
    decay: duration * 0.7,
    peak,
    seed: opts.seed ?? 131,
  });
  if (i > 0.45) {
    // A catch in the throat once the heart rate is really up.
    tone(ctx, dest, when + duration * 0.15, {
      type: 'triangle',
      freq: exhale ? 150 : 210,
      freqTo: exhale ? 110 : 260,
      decay: duration * 0.5,
      peak: 0.06 * i,
    });
  }
  return oneShot(end - when);
}

// ---------------------------------------------------------------------------
// The alien's voice box (audition-deck rebuild).
//
// It looks like an alligator, so it sounds like one. Every alien sound below
// shares one core — a PULSE-TRAIN LARYNX: a glottal buzz at 25–45 Hz (slow
// enough that the ear can almost count the pulses, which is exactly what a real
// gator growl is) pushed through parallel throat-formant filters, with sparse
// "wet" velvet-noise crackle for saliva and loose flesh. One larynx, many
// calls, so every sound is recognisably the same animal.
// ---------------------------------------------------------------------------

interface LarynxHandle {
  out: GainNode;
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  formants: BiquadFilterNode[];
  stop(at: number, fade?: number): void;
}

interface LarynxOptions {
  /** Glottal pulse rate — the croak. Hz. */
  f0?: number;
  peak?: number;
  attack?: number;
  /** AM roughness depth 0–1 and rate — the bellow flutter. */
  rough?: number;
  roughHz?: number;
  /** Slow drift so it never settles into a drone. Hz. */
  wanderHz?: number;
  /** [centre Hz, Q, gain] per throat formant. */
  formants?: ReadonlyArray<readonly [number, number, number]>;
}

function gatorLarynx(ctx: AudioContext, dest: AudioNode, when: number, opts: LarynxOptions = {}): LarynxHandle {
  const f0 = opts.f0 ?? 34;
  const out = ctx.createGain();
  out.gain.setValueAtTime(SILENCE, when);
  expRamp(out.gain, opts.peak ?? 0.4, when + (opts.attack ?? 0.3));
  out.connect(dest);

  // Glottal source: two saws a hair apart — a pulse train with movement in it.
  const a = ctx.createOscillator();
  a.type = 'sawtooth';
  a.frequency.value = f0;
  const b = ctx.createOscillator();
  b.type = 'sawtooth';
  b.frequency.value = f0 * 1.012;
  const pre = ctx.createGain();
  pre.gain.value = 0.5;
  a.connect(pre);
  b.connect(pre);

  // Roughness: irregular AM around 20 Hz — the gator-bellow flutter.
  const rough = ctx.createOscillator();
  rough.type = 'sine';
  rough.frequency.value = opts.roughHz ?? 21;
  const roughDepth = ctx.createGain();
  roughDepth.gain.value = (opts.rough ?? 0.35) * 0.5;
  rough.connect(roughDepth);
  roughDepth.connect(pre.gain);

  // The throat: parallel formants.
  const spec = opts.formants ?? [[150, 4, 1.0], [410, 5, 0.55], [900, 7, 0.18]];
  const formants = spec.map(([freq, q, g]) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const trim = ctx.createGain();
    trim.gain.value = g;
    pre.connect(bp);
    bp.connect(trim);
    trim.connect(out);
    return bp;
  });

  // The chest: fundamental straight through a lowpass, so there is body
  // underneath the formants.
  const chest = ctx.createBiquadFilter();
  chest.type = 'lowpass';
  chest.frequency.value = 120;
  chest.Q.value = 0.7;
  const chestTrim = ctx.createGain();
  chestTrim.gain.value = 0.8;
  pre.connect(chest);
  chest.connect(chestTrim);
  chestTrim.connect(out);

  // Wander on pitch and first formant so it never drones.
  const wander = ctx.createOscillator();
  wander.type = 'sine';
  wander.frequency.value = opts.wanderHz ?? 0.19;
  const wanderPitch = ctx.createGain();
  wanderPitch.gain.value = f0 * 0.09;
  const wanderFormant = ctx.createGain();
  wanderFormant.gain.value = 55;
  wander.connect(wanderPitch);
  wander.connect(wanderFormant);
  wanderPitch.connect(a.frequency);
  wanderPitch.connect(b.frequency);
  wanderFormant.connect(formants[0].frequency);

  a.start(when);
  b.start(when);
  rough.start(when);
  wander.start(when);

  return {
    out,
    oscA: a,
    oscB: b,
    formants,
    stop(at: number, fade = 0.4): void {
      const t = Math.max(at, ctx.currentTime);
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(out.gain.value, SILENCE), t);
      expRamp(out.gain, SILENCE, t + fade);
      try {
        for (const osc of [a, b, rough, wander]) osc.stop(t + fade + 0.05);
      } catch {
        /* already stopped */
      }
    },
  };
}

/** Saliva and loose flesh in the breath — sparse impulses through a dark band.
 *  The single cheapest "this thing is ALIVE" layer. */
function wetCrackle(ctx: AudioContext, dest: AudioNode, when: number, dur: number, peak: number, seed: number): number {
  return noiseBurst(ctx, dest, when, {
    colour: 'velvet',
    type: 'bandpass',
    freq: 1050,
    freqTo: 520,
    q: 1.6,
    attack: dur * 0.2,
    hold: dur * 0.3,
    decay: dur * 0.5,
    peak,
    seed,
  });
}

/** One gator breath cycle: thin rising intake, wide wet falling exhale with the
 *  chest under it. ~1.8 s at intensity 0, tighter as intensity rises. */
function gatorBreathCycle(ctx: AudioContext, dest: AudioNode, when: number, intensity: number, seed: number): number {
  const i = clamp(intensity, 0, 1);
  noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'bandpass',
    freq: 420,
    freqTo: 980 + 300 * i,
    q: 2.2,
    attack: 0.3 - 0.12 * i,
    hold: 0.15,
    decay: 0.3,
    peak: 0.09 + 0.07 * i,
    seed,
  });
  const exAt = when + 0.85 - 0.25 * i;
  const end = noiseBurst(ctx, dest, exAt, {
    colour: 'pink',
    type: 'bandpass',
    freq: 760,
    freqTo: 230,
    q: 1.0,
    attack: 0.1,
    hold: 0.35 + 0.15 * i,
    decay: 0.65,
    peak: 0.17 + 0.13 * i,
    seed: seed + 1,
  });
  wetCrackle(ctx, dest, exAt + 0.05, 0.8, 0.05 + 0.06 * i, seed + 2);
  tone(ctx, dest, exAt, {
    type: 'sine',
    freq: 46,
    freqTo: 34,
    attack: 0.12,
    hold: 0.3,
    decay: 0.6,
    peak: 0.09 + 0.08 * i,
  });
  return end;
}

/**
 * 55 — the alien while hunting. §5: "It makes loud noise while hunting.
 * Non-negotiable: a silent charge is unfair and reads as a bug."
 *
 * One-shot: the INVESTIGATE/SEARCH call — an intake hiss, a guttural croak
 * falling through the throat (46 → 30 Hz pulse rate with closing formants: a
 * large body relaxing after a call), and two wet chuffs to stamp it as breath
 * rather than circuitry.
 *
 * Sustained is what HUNT uses: the larynx growl wandering, wet crackle riding
 * it, a 27 Hz sub you feel before you hear, and scheduled animal events —
 * breaths, snorts, jaw-clacks — because a loop heard for 30+ seconds needs
 * EVENTS, not just texture; the snorts are what the imagination builds the
 * animal out of. All the loud energy stays under 1 kHz, so it masks nothing
 * that matters. Stop it when the state leaves HUNT.
 */
export function alienVocal(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  opts: { sustain?: boolean; seed?: number } = {},
): SynthHandle {
  const seed = opts.seed ?? 137;
  const sustain = opts.sustain ?? false;

  if (!sustain) {
    // Intake.
    noiseBurst(ctx, dest, when, {
      colour: 'pink',
      type: 'bandpass',
      freq: 600,
      freqTo: 1400,
      q: 1.8,
      attack: 0.16,
      decay: 0.14,
      peak: 0.14,
      seed,
    });
    // The croak: falling f0, closing throat.
    const at = when + 0.3;
    const larynx = gatorLarynx(ctx, dest, at, {
      f0: 46,
      peak: 0.5,
      attack: 0.06,
      rough: 0.45,
      roughHz: 24,
      formants: [[165, 4, 1.0], [430, 5, 0.6], [980, 7, 0.22]],
    });
    expRamp(larynx.oscA.frequency, 30, at + 1.15);
    expRamp(larynx.oscB.frequency, 30.4, at + 1.15);
    expRamp(larynx.formants[0].frequency, 115, at + 1.15);
    expRamp(larynx.formants[1].frequency, 300, at + 1.15);
    larynx.stop(at + 0.95, 0.35);
    wetCrackle(ctx, dest, at + 0.15, 0.9, 0.08, seed + 3);
    // Two chuffs to close.
    for (let i = 0; i < 2; i++) {
      const chuffAt = at + 1.25 + i * 0.17;
      noiseBurst(ctx, dest, chuffAt, {
        colour: 'brown',
        type: 'lowpass',
        freq: 300,
        freqTo: 130,
        attack: 0.004,
        decay: 0.09,
        peak: 0.26,
        seed: seed + 5 + i,
      });
      noiseBurst(ctx, dest, chuffAt, {
        colour: 'pink',
        type: 'bandpass',
        freq: 620,
        q: 3.5,
        attack: 0.003,
        decay: 0.06,
        peak: 0.14,
        seed: seed + 8 + i,
      });
    }
    return oneShot(at + 1.7 - when);
  }

  // Sustained HUNT loop.
  const larynx = gatorLarynx(ctx, dest, when, {
    f0: 33,
    peak: 0.42,
    attack: 0.4,
    rough: 0.4,
    roughHz: 19,
    wanderHz: 0.16,
  });

  // Constant wet layer, breathing on its own slow LFO.
  const wet = sustainedNoise(ctx, dest, when, {
    colour: 'velvet',
    type: 'bandpass',
    freq: 900,
    q: 1.8,
    peak: 0.07,
    attack: 0.5,
    seed: seed + 4,
  });
  const wetLfo = ctx.createOscillator();
  wetLfo.type = 'sine';
  wetLfo.frequency.value = 0.5;
  const wetDepth = ctx.createGain();
  wetDepth.gain.value = 0.045;
  wetLfo.connect(wetDepth);
  wetDepth.connect(wet.gain.gain);
  wetLfo.start(when);

  // Sub presence — felt at distance before it is heard.
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 27;
  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(SILENCE, when);
  expRamp(subGain.gain, 0.11, when + 1.2);
  const subLfo = ctx.createOscillator();
  subLfo.type = 'sine';
  subLfo.frequency.value = 0.13;
  const subLfoDepth = ctx.createGain();
  subLfoDepth.gain.value = 0.05;
  subLfo.connect(subLfoDepth);
  subLfoDepth.connect(subGain.gain);
  sub.connect(subGain);
  subGain.connect(dest);
  sub.start(when);
  subLfo.start(when);

  // Scheduled animal events. A JS timer, not audio-graph scheduling, because
  // the loop is open-ended; everything it schedules connects to `dest`, so the
  // events move and attenuate with the loop's panner like the rest of it.
  const rng = mulberry32(seed >>> 0);
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const t = ctx.currentTime + 0.05;
    const roll = rng();
    const evSeed = (seed + Math.floor(rng() * 9999)) >>> 0;
    if (roll < 0.4) {
      gatorBreathCycle(ctx, dest, t, 0.7, evSeed);
    } else if (roll < 0.7) {
      // Snort.
      noiseBurst(ctx, dest, t, {
        colour: 'pink',
        type: 'bandpass',
        freq: 850,
        freqTo: 340,
        q: 2.8,
        attack: 0.008,
        decay: 0.16,
        peak: 0.24,
        seed: evSeed,
      });
      tone(ctx, dest, t, { type: 'sine', freq: 70, freqTo: 44, decay: 0.14, peak: 0.14 });
    } else {
      // Jaw clack — teeth meeting.
      for (let i = 0; i < 2; i++) {
        noiseBurst(ctx, dest, t + i * 0.09, {
          colour: 'brown',
          type: 'lowpass',
          freq: 340,
          freqTo: 140,
          attack: 0.002,
          decay: 0.06,
          peak: 0.2,
          seed: evSeed + i,
        });
        metalRing(ctx, dest, t + i * 0.09, [720], { decay: 0.05, peak: 0.07 });
      }
    }
  }, 2600);

  return {
    duration: Number.POSITIVE_INFINITY,
    stop(at = ctx.currentTime, fade = 0.6): void {
      stopped = true;
      clearInterval(timer);
      const t = Math.max(at, ctx.currentTime);
      larynx.stop(t, fade);
      wet.stop(t, fade);
      subGain.gain.cancelScheduledValues(t);
      subGain.gain.setValueAtTime(Math.max(subGain.gain.value, SILENCE), t);
      expRamp(subGain.gain, SILENCE, t + fade);
      try {
        sub.stop(t + fade + 0.05);
        subLfo.stop(t + fade + 0.05);
        wetLfo.stop(t + fade + 0.05);
      } catch {
        /* already stopped */
      }
    },
  };
}

/**
 * The bellow — HUNT onset / lost-prey rage. Real gators bellow at ~20 Hz pulse
 * rates, hard enough that the water over their backs dances; this is that,
 * scaled to a corridor. Swells over half a second, rises a third, sinks past
 * where it started, with an infrasonic shove and room rumble underneath.
 * Not yet wired to a NoiseKind — available for the director.
 */
export function alienBellow(ctx: AudioContext, dest: AudioNode, when: number, seed = 227): SynthHandle {
  const larynx = gatorLarynx(ctx, dest, when, {
    f0: 30,
    peak: 0.55,
    attack: 0.55,
    rough: 0.55,
    roughHz: 18,
    formants: [[130, 4, 1.0], [340, 5, 0.5], [780, 7, 0.14]],
  });
  larynx.oscA.frequency.setValueAtTime(30, when);
  expRamp(larynx.oscA.frequency, 38, when + 1.1);
  expRamp(larynx.oscA.frequency, 24, when + 2.6);
  larynx.oscB.frequency.setValueAtTime(30.4, when);
  expRamp(larynx.oscB.frequency, 38.5, when + 1.1);
  expRamp(larynx.oscB.frequency, 24.3, when + 2.6);
  larynx.stop(when + 2.2, 0.8);
  tone(ctx, dest, when, { type: 'sine', freq: 24, attack: 0.5, hold: 1.2, decay: 1.0, peak: 0.16 });
  noiseBurst(ctx, dest, when + 0.3, {
    colour: 'brown',
    type: 'lowpass',
    freq: 200,
    freqTo: 90,
    attack: 0.5,
    hold: 0.8,
    decay: 1.0,
    peak: 0.14,
    seed,
  });
  wetCrackle(ctx, dest, when + 0.4, 1.8, 0.06, seed + 1);
  return oneShot(3.1);
}

/**
 * The hiss — open-mouth warning for SEARCH near a hide spot. Broadband but
 * dark-edged, swelling, with the growl idling beneath, closed by a sharp huff.
 * Not yet wired to a NoiseKind — available for the director.
 */
export function alienHiss(ctx: AudioContext, dest: AudioNode, when: number, seed = 229): SynthHandle {
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'bandpass',
    freq: 1300,
    freqTo: 2500,
    q: 0.7,
    attack: 0.4,
    hold: 0.55,
    decay: 0.5,
    peak: 0.3,
    seed,
  });
  noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'highpass',
    freq: 500,
    attack: 0.45,
    hold: 0.5,
    decay: 0.5,
    peak: 0.12,
    seed: seed + 1,
  });
  const larynx = gatorLarynx(ctx, dest, when + 0.1, { f0: 40, peak: 0.14, attack: 0.4, rough: 0.3 });
  larynx.stop(when + 1.2, 0.35);
  const end = noiseBurst(ctx, dest, when + 1.42, {
    colour: 'brown',
    type: 'lowpass',
    freq: 420,
    freqTo: 150,
    attack: 0.006,
    decay: 0.14,
    peak: 0.3,
    seed: seed + 2,
  });
  return oneShot(end - when);
}

/**
 * The chuff — three irregular territorial huffs. The INVESTIGATE voice: close,
 * curious, horrible. Not yet wired to a NoiseKind — available for the director.
 */
export function alienChuff(ctx: AudioContext, dest: AudioNode, when: number, seed = 233): SynthHandle {
  const vary = varier(seed);
  const gaps = [0, 0.16 * vary(0.2), 0.38 * vary(0.15)];
  let end = when;
  for (let i = 0; i < 3; i++) {
    const at = when + gaps[i];
    const e = noiseBurst(ctx, dest, at, {
      colour: 'brown',
      type: 'lowpass',
      freq: 320,
      freqTo: 120,
      attack: 0.005,
      decay: 0.1,
      peak: 0.3 - i * 0.04,
      seed: seed + i,
    });
    noiseBurst(ctx, dest, at, {
      colour: 'pink',
      type: 'bandpass',
      freq: 640 * vary(0.08),
      q: 3.2,
      attack: 0.004,
      decay: 0.07,
      peak: 0.16,
      seed: seed + 4 + i,
    });
    tone(ctx, dest, at, { type: 'sine', freq: 82, freqTo: 50, decay: 0.09, peak: 0.16 });
    if (e > end) end = e;
  }
  return oneShot(end - when);
}

/**
 * Sustained breathing — it is next to your locker, and it is breathing. Wet
 * exhale, chest rumble, ~3.2 s cycle. The PATROL-adjacent voice, and the
 * counterweight to hiding feeling safe. Not yet wired — available for the
 * hide/proximity treatment.
 */
export function alienBreathing(ctx: AudioContext, dest: AudioNode, when: number, seed = 239): SynthHandle {
  const rng = mulberry32(seed >>> 0);
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(dest);
  gatorBreathCycle(ctx, out, when + 0.1, 0.5, seed);
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    gatorBreathCycle(ctx, out, ctx.currentTime + 0.05, 0.45 + rng() * 0.3, (seed + Math.floor(rng() * 99999)) >>> 0);
  }, 3200);
  return {
    duration: Number.POSITIVE_INFINITY,
    stop(at = ctx.currentTime, fade = 0.8): void {
      stopped = true;
      clearInterval(timer);
      const t = Math.max(at, ctx.currentTime);
      out.gain.setValueAtTime(1, t);
      expRamp(out.gain, SILENCE, t + fade);
    },
  };
}

/**
 * The station itself: fans, pumps, structure. Not in the §3 table because it is
 * not an event — it is the bed everything else sits on, and the thing that
 * makes silence when it drops out.
 */
export interface HumHandle extends SynthHandle {
  /** 0–1. Drop it toward 0 for a dark module (§2 lighting). */
  setLevel(value: number, tau?: number): void;
  /** 0–1 brightness: emergency power is duller and rougher. */
  setColour(value: number, tau?: number): void;
  /**
   * 0–1 — how much of the GRAVITY PLANT is still running (§4).
   *
   * The mains low end and the pump cycling are the floor's machinery; the air
   * handling is not. Take the plant away and the module keeps breathing but
   * stops holding you down, and the room audibly changes character without
   * going silent. This is the ambient half of a gravity failure, and it is why
   * a zero-G module sounds thinner from the doorway.
   */
  setPlant(value: number, tau?: number): void;
}

export function stationHum(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  opts: { level?: number; seed?: number } = {},
): HumHandle {
  const seed = opts.seed ?? 149;
  const level = clamp(opts.level ?? 0.5, 0, 1);

  const out = ctx.createGain();
  out.gain.setValueAtTime(SILENCE, when);
  expRamp(out.gain, Math.max(level, SILENCE), when + 1.2);
  out.connect(dest);

  // Mains-ish low end: two sines a few Hz apart beat slowly against each other.
  const lowA = ctx.createOscillator();
  lowA.type = 'sine';
  lowA.frequency.value = 49;
  const lowB = ctx.createOscillator();
  lowB.type = 'sine';
  lowB.frequency.value = 58.3;
  const lowTrim = ctx.createGain();
  lowTrim.gain.value = 0.5;
  lowA.connect(lowTrim);
  lowB.connect(lowTrim);
  lowTrim.connect(out);

  // Air handling.
  const air = ctx.createBufferSource();
  air.buffer = noiseBuffer(ctx, 'pink', 2, seed);
  air.loop = true;
  const airFilter = ctx.createBiquadFilter();
  airFilter.type = 'lowpass';
  airFilter.frequency.value = 620;
  airFilter.Q.value = 0.6;
  const airTrim = ctx.createGain();
  airTrim.gain.value = 0.5;
  air.connect(airFilter);
  airFilter.connect(airTrim);
  airTrim.connect(out);

  // A pump somewhere, cycling.
  const pump = ctx.createOscillator();
  pump.type = 'triangle';
  pump.frequency.value = 118;
  const pumpTrim = ctx.createGain();
  pumpTrim.gain.value = 0.03;
  const pumpLfo = ctx.createOscillator();
  pumpLfo.type = 'sine';
  pumpLfo.frequency.value = 0.09;
  const pumpDepth = ctx.createGain();
  pumpDepth.gain.value = 0.028;
  pumpLfo.connect(pumpDepth);
  pumpDepth.connect(pumpTrim.gain);
  pump.connect(pumpTrim);
  pumpTrim.connect(out);

  lowA.start(when);
  lowB.start(when);
  air.start(when);
  pump.start(when);
  pumpLfo.start(when);

  let colour = 0.5;
  let plant = 1;
  const applyLow = (tau: number): void => {
    // The low end is the plant's; `colour` shades it, `plant` decides whether it
    // is there at all. Floored rather than zeroed: even a dead module still has
    // structure ringing at the frequency everything else in the station runs at.
    const base = 0.35 + 0.35 * (1 - colour);
    lowTrim.gain.setTargetAtTime(base * (0.18 + 0.82 * plant), ctx.currentTime, tau);
  };

  return {
    duration: Number.POSITIVE_INFINITY,
    setLevel(value: number, tau = 0.6): void {
      out.gain.setTargetAtTime(clamp(value, 0, 1), ctx.currentTime, tau);
    },
    setColour(value: number, tau = 0.6): void {
      colour = clamp(value, 0, 1);
      airFilter.frequency.setTargetAtTime(260 + 900 * colour, ctx.currentTime, tau);
      applyLow(tau);
    },
    setPlant(value: number, tau = 0.9): void {
      plant = clamp(value, 0, 1);
      applyLow(tau);
      // The pump is the floor's, outright: no gravity, nothing to circulate for.
      pumpTrim.gain.setTargetAtTime(0.03 * plant, ctx.currentTime, tau);
      // Air handling picks up what the plant stops masking, so the room does not
      // simply get quieter — it gets THINNER, which is the tell.
      airTrim.gain.setTargetAtTime(0.5 + 0.22 * (1 - plant), ctx.currentTime, tau);
    },
    stop(at = ctx.currentTime, fade = 1.0): void {
      const t = Math.max(at, ctx.currentTime);
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(out.gain.value, SILENCE), t);
      expRamp(out.gain, SILENCE, t + fade);
      try {
        lowA.stop(t + fade + 0.05);
        lowB.stop(t + fade + 0.05);
        air.stop(t + fade + 0.05);
        pump.stop(t + fade + 0.05);
        pumpLfo.stop(t + fade + 0.05);
      } catch {
        /* already stopped */
      }
    },
  };
}

/**
 * The dread layer (audition-deck addition) — sits UNDER `stationHum`.
 *
 * The hum is honest machinery and safe-sounding by design. This is the other
 * half of a horror bed: a beating 36/37.9 Hz sub, a barely-tonal minor-second
 * pad, void hiss, and far-off scheduled events — hull groans, stress pings,
 * distant thumps, skitters — every 6–15 s, panned at random. The station keeps
 * making noises that might be the alien and never quite are.
 *
 * Everything is quiet and low ON PURPOSE: the §3 noise game is untouched, and
 * a real footstep still cuts straight through. Like the hum it is not a
 * NoiseEvent — the alien does not hear the set dressing.
 */
export interface DreadHandle extends SynthHandle {
  /** 0–1 master level for the layer. */
  setLevel(value: number, tau?: number): void;
}

export function dreadLayer(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  opts: { level?: number; seed?: number } = {},
): DreadHandle {
  const seed = opts.seed ?? 421;
  const level = clamp(opts.level ?? 1, 0, 1);

  const out = ctx.createGain();
  out.gain.setValueAtTime(SILENCE, when);
  expRamp(out.gain, Math.max(level, SILENCE), when + 2.5);
  out.connect(dest);

  // Beating sub — two sines 1.7 Hz apart. The slow pulse you stop noticing
  // until it stops.
  const subA = ctx.createOscillator();
  subA.type = 'sine';
  subA.frequency.value = 36.2;
  const subB = ctx.createOscillator();
  subB.type = 'sine';
  subB.frequency.value = 37.9;
  const subTrim = ctx.createGain();
  subTrim.gain.value = 0.12;
  subA.connect(subTrim);
  subB.connect(subTrim);
  subTrim.connect(out);

  // Pad: a detuned minor-second cluster through a dark, wandering lowpass —
  // tonal enough to feel wrong, too dark to hum along to.
  const padLp = ctx.createBiquadFilter();
  padLp.type = 'lowpass';
  padLp.frequency.value = 240;
  padLp.Q.value = 0.9;
  const padTrim = ctx.createGain();
  padTrim.gain.value = 0.045;
  padLp.connect(padTrim);
  padTrim.connect(out);
  const pads = [110, 110.9, 116.5].map((freq) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.connect(padLp);
    osc.start(when);
    return osc;
  });
  const padWander = ctx.createOscillator();
  padWander.type = 'sine';
  padWander.frequency.value = 0.05;
  const padWanderDepth = ctx.createGain();
  padWanderDepth.gain.value = 70;
  padWander.connect(padWanderDepth);
  padWanderDepth.connect(padLp.frequency);
  padWander.start(when);

  // Void hiss, fading in and out over ~20 s.
  const hiss = sustainedNoise(ctx, out, when, {
    colour: 'white',
    type: 'highpass',
    freq: 5200,
    peak: 0.012,
    attack: 2.0,
    seed,
  });
  const hissLfo = ctx.createOscillator();
  hissLfo.type = 'sine';
  hissLfo.frequency.value = 0.045;
  const hissDepth = ctx.createGain();
  hissDepth.gain.value = 0.007;
  hissLfo.connect(hissDepth);
  hissDepth.connect(hiss.gain.gain);
  hissLfo.start(when);

  subA.start(when);
  subB.start(when);

  // Far-off events. A JS timer because the layer is open-ended; each event
  // gets its own random pan so the station talks from everywhere.
  const rng = mulberry32(seed >>> 0);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const scheduleEvent = (): void => {
    if (stopped) return;
    const t = ctx.currentTime + 0.05;
    const panner = ctx.createStereoPanner();
    panner.pan.value = (rng() * 2 - 1) * 0.8;
    panner.connect(out);
    const roll = rng();
    const evSeed = Math.floor(rng() * 99999);
    if (roll < 0.35) {
      // Hull groan.
      const dur = 1.8 + rng() * 1.4;
      noiseBurst(ctx, panner, t, {
        colour: 'white',
        type: 'bandpass',
        freq: 300 + rng() * 120,
        freqTo: 130,
        q: 14,
        attack: dur * 0.4,
        hold: dur * 0.2,
        decay: dur * 0.4,
        peak: 0.1,
        seed: evSeed,
      });
      tone(ctx, panner, t + dur * 0.3, { type: 'sine', freq: 55, freqTo: 40, attack: 0.3, decay: dur * 0.5, peak: 0.05 });
    } else if (roll < 0.6) {
      // Stress ping.
      const freq = 600 + rng() * 900;
      metalRing(ctx, panner, t, [freq, freq * 2.3], { decay: 1.1, peak: 0.06 });
    } else if (roll < 0.85) {
      // Distant thump.
      tone(ctx, panner, t, { type: 'sine', freq: 70, freqTo: 42, attack: 0.005, decay: 0.35, peak: 0.14 });
      noiseBurst(ctx, panner, t, {
        colour: 'brown',
        type: 'lowpass',
        freq: 260,
        freqTo: 110,
        attack: 0.004,
        decay: 0.3,
        peak: 0.1,
        seed: evSeed,
      });
    } else {
      // Skitter.
      for (let i = 0; i < 5; i++) {
        noiseBurst(ctx, panner, t + i * 0.055 + rng() * 0.02, {
          colour: 'velvet',
          type: 'bandpass',
          freq: 1900,
          q: 3,
          attack: 0.001,
          decay: 0.025,
          peak: 0.035,
          seed: evSeed + i,
        });
      }
    }
    timer = setTimeout(scheduleEvent, (6 + rng() * 9) * 1000);
  };
  timer = setTimeout(scheduleEvent, 2500);

  return {
    duration: Number.POSITIVE_INFINITY,
    setLevel(value: number, tau = 0.8): void {
      out.gain.setTargetAtTime(clamp(value, 0, 1), ctx.currentTime, tau);
    },
    stop(at = ctx.currentTime, fade = 1.2): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      const t = Math.max(at, ctx.currentTime);
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(out.gain.value, SILENCE), t);
      expRamp(out.gain, SILENCE, t + fade);
      hiss.stop(t, fade);
      try {
        for (const osc of [subA, subB, padWander, hissLfo, ...pads]) osc.stop(t + fade + 0.05);
      } catch {
        /* already stopped */
      }
    },
  };
}

// ===========================================================================
// §4 — walking, landing, and the four transitions
// ===========================================================================

/**
 * One footstep, per gait. §2's risk dial, made audible.
 *
 * "Crouch, walk and sprint must be clearly distinguishable BY EAR" — so these
 * are not one sound at three volumes. The distinction is carried by STRUCTURE,
 * because level is mostly spoken for: `levels.ts` maps the §3 arrival level
 * (4 / 12 / 30) onto gain, which is already ~19 dB between a crouch and a
 * sprint at the same distance. The three peaks below therefore span barely 2:1
 * rather than 6:1 — enough that your OWN steps still feel heavier as you speed
 * up (`selfGain` deliberately compresses the range so that you always hear
 * yourself, §8), and not so much that it multiplies with the level mapping and
 * puts a crouched step across the room below what a speaker can reproduce.
 *
 *   crouch  a dull sole roll. No heel transient at all, nothing above 2 kHz,
 *           and it is over in 90 ms — the sound of a foot being PLACED.
 *   walk    heel then toe: a defined low thock, a short broadband tick, a
 *           faint deck ring, and a scuff 75 ms behind it. Two events, so the
 *           ear reads a stride rather than a knock.
 *   sprint  the whole deck answers. A heavy thump an octave down, a hard crack
 *           on top, three metal partials ringing for 160 ms, and boot rattle.
 *           Unmistakable through a bulkhead, which is the point: §3 says
 *           running is ALWAYS heard, at every stage, and it should sound it.
 */
interface FootstepShape {
  thumpHz: number;
  thumpTo: number;
  thumpPeak: number;
  thumpDecay: number;
  bodyHz: number;
  bodyTo: number;
  bodyPeak: number;
  bodyDecay: number;
  /** Heel transient. Zero for a crouch — that absence IS the crouch. */
  tickHz: number;
  tickPeak: number;
  /** Deck plating ringing under the boot. Empty for a crouch. */
  ring: readonly number[];
  ringPeak: number;
  ringDecay: number;
  scuffDelay: number;
  scuffHz: number;
  scuffPeak: number;
  scuffDecay: number;
}

const FOOTSTEP_SHAPES: Readonly<Record<Gait, FootstepShape>> = Object.freeze({
  crouch: {
    thumpHz: 78,
    thumpTo: 56,
    thumpPeak: 0.36,
    thumpDecay: 0.075,
    bodyHz: 240,
    bodyTo: 128,
    bodyPeak: 0.42,
    bodyDecay: 0.09,
    tickHz: 0,
    tickPeak: 0,
    ring: [],
    ringPeak: 0,
    ringDecay: 0,
    scuffDelay: 0.045,
    scuffHz: 1500,
    scuffPeak: 0.17,
    scuffDecay: 0.1,
  },
  walk: {
    thumpHz: 118,
    thumpTo: 72,
    thumpPeak: 0.41,
    thumpDecay: 0.12,
    bodyHz: 430,
    bodyTo: 185,
    bodyPeak: 0.41,
    bodyDecay: 0.13,
    tickHz: 2600,
    tickPeak: 0.19,
    ring: [560, 1290],
    ringPeak: 0.09,
    ringDecay: 0.085,
    scuffDelay: 0.075,
    scuffHz: 2100,
    scuffPeak: 0.13,
    scuffDecay: 0.075,
  },
  sprint: {
    thumpHz: 96,
    thumpTo: 54,
    thumpPeak: 0.49,
    thumpDecay: 0.2,
    bodyHz: 620,
    bodyTo: 215,
    bodyPeak: 0.44,
    bodyDecay: 0.2,
    tickHz: 3000,
    tickPeak: 0.26,
    ring: [430, 980, 2100],
    ringPeak: 0.15,
    ringDecay: 0.16,
    scuffDelay: 0.055,
    scuffHz: 2600,
    scuffPeak: 0.17,
    scuffDecay: 0.1,
  },
});

/** 4 / 12 / 30 — one stride's worth of noise (§3, §4). Distance-based, so this
 *  fires once per `STRIDE_*_M` of ground covered and never on a timer. */
export function footstep(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  gait: Gait = 'walk',
  seed = 151,
  scale = 1,
): SynthHandle {
  const s = FOOTSTEP_SHAPES[gait] ?? FOOTSTEP_SHAPES.walk;
  const vary = varier(seed);
  // Pitch moves most, level next, timing least: a boot lands on the same deck
  // every time, but never on quite the same square inch of it.
  const pitch = vary(0.07);
  const loud = vary(0.1) * scale;
  const time = vary(0.12);

  let end = tone(ctx, dest, when, {
    type: 'sine',
    freq: s.thumpHz * pitch,
    freqTo: s.thumpTo * pitch,
    decay: s.thumpDecay * time,
    peak: s.thumpPeak * loud,
    attack: 0.0015,
  });

  const bodyEnd = noiseBurst(ctx, dest, when, {
    colour: 'brown',
    type: 'lowpass',
    freq: s.bodyHz * pitch,
    freqTo: s.bodyTo * pitch,
    attack: 0.0015,
    decay: s.bodyDecay * time,
    peak: s.bodyPeak * loud,
    seed,
  });
  if (bodyEnd > end) end = bodyEnd;

  if (s.tickPeak > 0) {
    noiseBurst(ctx, dest, when, {
      colour: 'white',
      type: 'highpass',
      freq: s.tickHz * vary(0.05),
      attack: 0.0006,
      decay: 0.014 * time,
      peak: s.tickPeak * loud,
      seed: seed + 1,
    });
  }

  if (s.ring.length > 0) {
    const ringEnd = metalRing(
      ctx,
      dest,
      when + 0.002,
      s.ring.map((f) => f * pitch),
      { decay: s.ringDecay * time, peak: s.ringPeak * loud, attack: 0.001 },
    );
    if (ringEnd > end) end = ringEnd;
  }

  // The other half of the stride: the sole leaving the deck.
  const scuffEnd = noiseBurst(ctx, dest, when + s.scuffDelay * time, {
    colour: 'pink',
    type: 'bandpass',
    freq: s.scuffHz * vary(0.09),
    freqTo: s.scuffHz * 0.55,
    q: 1.1,
    attack: 0.008,
    decay: s.scuffDecay * time,
    peak: s.scuffPeak * loud,
    seed: seed + 2,
  });
  if (scuffEnd > end) end = scuffEnd;

  return oneShot(end - when);
}

/**
 * Reaching the deck (§4's `landing` transition).
 *
 * Two branches, and they are the two branches §14's `landingNoise()` already
 * has, so what you hear and what the alien hears cannot disagree:
 *
 *   soft (≤ the gait's `landingSoftMaxMps`)  → that gait's footstep, planted:
 *          the same sound with the knee taking it. A jump landed in a crouch is
 *          FOUR, and it has to sound like four or the 29-point saving §4 hangs
 *          the whole jump design on is invisible to the player making it.
 *   hard   → `impact()` at the speed the fall actually reported, plus the boot
 *          layer on top so it still reads as a body hitting a floor rather than
 *          a crash into a bulkhead. "A hard landing should sound like the
 *          impactNoise it emits", and this IS that sound, sharing one function.
 */
export function landing(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  speed: number | undefined,
  gait: Gait | undefined,
  seed = 157,
): SynthHandle {
  const profile = gaitProfile(gait ?? 'walk');
  const soft = speed === undefined || speed <= profile.landingSoftMaxMps;

  if (soft) {
    // Planted, not stepped: a touch more weight and a longer tail than the same
    // gait's ordinary stride, plus the fabric of a knee absorbing it.
    const end = footstep(ctx, dest, when, profile.gait, seed, 1.3);
    noiseBurst(ctx, dest, when + 0.02, {
      colour: 'pink',
      type: 'bandpass',
      freq: 900,
      freqTo: 420,
      q: 1.4,
      attack: 0.02,
      decay: 0.16,
      peak: 0.1,
      seed: seed + 3,
    });
    return oneShot(end.duration + 0.16);
  }

  const v = clamp(speed, 0, TERMINAL_VELOCITY_M_S);
  const crash = impact(ctx, dest, when, v, seed);
  // Boots on top of the structure — the difference between "somebody fell" and
  // "something hit the wall". Kept under the crash it is layered on: a landing
  // and an uncontrolled impact are the SAME loudness on the §3 table at the
  // same speed, so the landing must not end up the hotter of the two.
  footstep(ctx, dest, when, profile.gait, seed + 5, 0.55 + 0.35 * (v / TERMINAL_VELOCITY_M_S));
  return oneShot(crash.duration + 0.05);
}

/**
 * `launch` — you walked or ran out of a floor and into zero-G (§4).
 *
 * Momentum is conserved and there is no boost, so this is not a thruster: it is
 * the air of a room leaving you and the deck no longer answering your feet. At
 * ≥ `LAUNCH_MIN` the server also gets a real `push-off` (8) and you hear that
 * shove through the ordinary noise path; this layer is the part that is true at
 * every speed, including the silent walk-in.
 */
export function launchWhoosh(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  speed = 0,
  seed = 163,
): SynthHandle {
  const h = clamp(speed / PUSH_MAX, 0, 1);
  const end = noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'bandpass',
    freq: 300,
    freqTo: 1600 + 900 * h,
    q: 0.7,
    attack: 0.05,
    hold: 0.09,
    decay: 0.34 + 0.2 * h,
    peak: 0.16 + 0.24 * h,
    seed,
  });
  // The room's floor tone letting go underneath you.
  tone(ctx, dest, when, {
    type: 'sine',
    freq: 118,
    freqTo: 196,
    decay: 0.42,
    peak: 0.1 + 0.12 * h,
    attack: 0.03,
  });
  return oneShot(end - when);
}

/**
 * `settle` — you floated into a module that has a floor, and started falling.
 *
 * The drop itself is silent (§4 gives it loudness 0); what you get is the
 * stomach. A descending swell with nothing percussive in it, so the LANDING is
 * the only transient in the sequence and stays the thing you brace for.
 */
export function settleFall(ctx: AudioContext, dest: AudioNode, when: number, seed = 167): SynthHandle {
  const end = noiseBurst(ctx, dest, when, {
    colour: 'brown',
    type: 'lowpass',
    freq: 520,
    freqTo: 150,
    attack: 0.09,
    hold: 0.1,
    decay: 0.42,
    peak: 0.28,
    seed,
  });
  tone(ctx, dest, when, { type: 'sine', freq: 152, freqTo: 62, decay: 0.55, peak: 0.22, attack: 0.05 });
  return oneShot(end - when + 0.1);
}

/**
 * `liftoff` — the floor failed underneath you (§4, 0.6 m/s of residual leg).
 *
 * Deliberately small. §4 sizes `LIFTOFF_IMPULSE_M_S` so a standing body
 * visibly leaves the deck and the deck stays in reach for about a second, and
 * the sound has the same job: enough that you know you are off it, not so much
 * that it reads as a launch. The klaxon already told you; this is your body.
 */
export function liftoffRelease(ctx: AudioContext, dest: AudioNode, when: number, seed = 173): SynthHandle {
  const end = noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'bandpass',
    freq: 700,
    freqTo: 1500,
    q: 1.2,
    attack: 0.06,
    hold: 0.06,
    decay: 0.3,
    peak: 0.16,
    seed,
  });
  // Boot soles unweighting: the last contact you have with the deck.
  noiseBurst(ctx, dest, when, {
    colour: 'brown',
    type: 'lowpass',
    freq: 260,
    freqTo: 120,
    attack: 0.01,
    decay: 0.14,
    peak: 0.14,
    seed: seed + 1,
  });
  tone(ctx, dest, when + 0.03, { type: 'sine', freq: 74, freqTo: 132, decay: 0.4, peak: 0.09, attack: 0.05 });
  return oneShot(end - when + 0.12);
}

/** Effort on the way up. A jump is silent to the alien (§3 has no row for it) —
 *  only the landing is charged — so this never leaves the body bus. */
export function jumpEffort(ctx: AudioContext, dest: AudioNode, when: number, seed = 179): SynthHandle {
  const end = noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'bandpass',
    freq: 520,
    freqTo: 820,
    q: 1.3,
    attack: 0.012,
    decay: 0.19,
    peak: 0.2,
    seed,
  });
  noiseBurst(ctx, dest, when, {
    colour: 'brown',
    type: 'lowpass',
    freq: 300,
    freqTo: 150,
    attack: 0.002,
    decay: 0.09,
    peak: 0.22,
    seed: seed + 1,
  });
  return oneShot(end - when);
}

// ===========================================================================
// §4 — gravity failure, the set-piece
// ===========================================================================

/**
 * 35 — a gravity plant giving up (§4, emitted AT THE MODULE CENTRE).
 *
 * Three things in one second and a half, in the order the hardware would do
 * them: the contactor drops out with a CLUNK, the plant's whine falls away
 * through two octaves, and the deck plating unloads with a long rush. It is a
 * breaker-toggle-loud event on the §3 table, so the alien is coming — but it is
 * emitted at the module centre with no actor, so nobody is blamed for it.
 */
export function gravityShift(ctx: AudioContext, dest: AudioNode, when: number, seed = 181): SynthHandle {
  // The contactor.
  let end = metalRing(ctx, dest, when, [138, 296, 615, 1180], { decay: 0.36, peak: 0.5 });
  noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'highpass',
    freq: 2400,
    attack: 0.0008,
    decay: 0.035,
    peak: 0.34,
    seed,
  });

  // The plant winding down: a real machine losing its field, not a slide
  // whistle — three partials through one closing lowpass.
  const spin = ctx.createBiquadFilter();
  spin.type = 'lowpass';
  spin.Q.value = 1.1;
  spin.frequency.setValueAtTime(2600, when);
  expRamp(spin.frequency, 300, when + 1.15);
  spin.connect(dest);
  const spinEnd = tone(ctx, spin, when, {
    type: 'sawtooth',
    freq: 460,
    freqTo: 68,
    attack: 0.01,
    hold: 0.06,
    decay: 1.0,
    peak: 0.3,
  });
  tone(ctx, spin, when, {
    type: 'triangle',
    freq: 232,
    freqTo: 34,
    attack: 0.01,
    hold: 0.06,
    decay: 1.05,
    peak: 0.22,
  });
  if (spinEnd > end) end = spinEnd;

  // Deck plating unloading, and the air moving with it.
  const rush = noiseBurst(ctx, dest, when + 0.05, {
    colour: 'brown',
    type: 'lowpass',
    freq: 900,
    freqTo: 180,
    attack: 0.12,
    hold: 0.2,
    decay: 0.75,
    peak: 0.34,
    seed: seed + 2,
  });
  if (rush > end) end = rush;

  // Loose hardware finding out there is no down any more.
  for (let i = 0; i < 3; i++) {
    const at = when + 0.42 + i * 0.19;
    const e = metalRing(ctx, dest, at, [420 + i * 130, 1080 + i * 210], {
      decay: 0.16,
      peak: 0.12 - i * 0.03,
    });
    if (e > end) end = e;
  }

  return oneShot(end - when + 0.1);
}

/**
 * The 2.5 seconds BEFORE it (`GRAVITY_WARNING_S`).
 *
 * §4: "The plant winds down audibly first. The floor never simply vanishes
 * under anyone." That fairness guarantee is an AUDIO guarantee — it does not
 * exist unless you can hear it — so this is the most load-bearing sound in the
 * file. It is not a NoiseEvent: the alien does not hear the warning, only the
 * failure. Two layers, both climbing in urgency: a fixed rhythm so you can
 * count the seconds you have left, and the plant's tone sagging under it so
 * you can hear it losing the argument.
 *
 * Audition-deck v2: the rhythm is no longer a 622/466 Hz triangle klaxon — the
 * single most smoke-detector sound in the game, parked exactly in the band the
 * ear flinches at. The countdown only needs RHYTHM, so each beat is now a low
 * pressure WHOOMP (a sine dropping 84 → 48 Hz over a brown-noise push) with a
 * quiet relay tick riding it for count definition. Same three beats in 2.5 s;
 * the dread moved two octaves down and turned into pressure.
 */
export function gravityWarning(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  seconds = GRAVITY_WARNING_S,
  seed = 191,
): SynthHandle {
  const span = Math.max(0.4, seconds);

  const out = ctx.createGain();
  out.gain.setValueAtTime(1, when);
  out.connect(dest);

  // The plant sagging. Not a sweep to zero — it is still fighting until the
  // contactor drops, which is the moment `gravityShift` takes over. Darker
  // than r1: the beats own the urgency now, the sag only has to lose.
  const shaper = ctx.createBiquadFilter();
  shaper.type = 'lowpass';
  shaper.Q.value = 1.6;
  shaper.frequency.setValueAtTime(1000, when);
  expRamp(shaper.frequency, 360, when + span);
  shaper.connect(out);

  const sag = ctx.createOscillator();
  sag.type = 'sawtooth';
  sag.frequency.setValueAtTime(148, when);
  expRamp(sag.frequency, 92, when + span);
  const sagGain = ctx.createGain();
  sagGain.gain.setValueAtTime(SILENCE, when);
  expRamp(sagGain.gain, 0.16, when + 0.2);
  expRamp(sagGain.gain, 0.26, when + span * 0.85);
  expRamp(sagGain.gain, SILENCE, when + span);
  sag.connect(sagGain);
  sagGain.connect(shaper);
  sag.start(when);
  sag.stop(when + span + 0.05);

  // A wobble that widens as it goes — the sound of something about to stop.
  const wobble = ctx.createOscillator();
  wobble.type = 'sine';
  wobble.frequency.setValueAtTime(2.6, when);
  wobble.frequency.linearRampToValueAtTime(8, when + span);
  const wobbleDepth = ctx.createGain();
  wobbleDepth.gain.setValueAtTime(3, when);
  wobbleDepth.gain.linearRampToValueAtTime(16, when + span);
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(sag.frequency);
  wobble.start(when);
  wobble.stop(when + span + 0.05);

  // The beats. A fixed 0.8 s apart, so it is a COUNTDOWN and not a texture:
  // 2.5 s is three of these, and by the third you should have a hand on a rail
  // (§4 sizes the warning at 6 m of sprint for exactly that reason).
  const period = 0.8;
  const beats = Math.max(1, Math.floor(span / period));
  for (let i = 0; i < beats; i++) {
    const at = when + i * period;
    const urgency = beats > 1 ? i / (beats - 1) : 1;
    // The whoomp.
    tone(ctx, dest, at, {
      type: 'sine',
      freq: 84 + 12 * urgency,
      freqTo: 48,
      attack: 0.03,
      hold: 0.02,
      decay: 0.3,
      peak: 0.36 + 0.16 * urgency,
    });
    noiseBurst(ctx, dest, at, {
      colour: 'brown',
      type: 'lowpass',
      freq: 520,
      freqTo: 130,
      attack: 0.025,
      decay: 0.3,
      peak: 0.2 + 0.12 * urgency,
      seed: seed + i,
    });
    // Relay tick for count definition — quiet, woody, not a beep.
    metalRing(ctx, dest, at + 0.01, [880, 1760], { decay: 0.035, peak: 0.05 + 0.05 * urgency });
  }

  return {
    duration: span + 0.15,
    stop(at = ctx.currentTime, fade = 0.12): void {
      const t = Math.max(at, ctx.currentTime);
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(out.gain.value, SILENCE), t);
      expRamp(out.gain, SILENCE, t + fade);
      try {
        sag.stop(t + fade + 0.02);
        wobble.stop(t + fade + 0.02);
      } catch {
        /* already stopped */
      }
    },
  };
}

// ===========================================================================
// §4 — hiding
// ===========================================================================

/**
 * 8 → 30 — getting into a hide spot, priced by haste (§4, `hideNoise`).
 *
 * The whole verb in one parameter. At haste 0 it is 2.5 seconds of careful
 * fabric and a latch you barely hear, under every PATROL threshold at every
 * crew size. At haste 1 it is half a second of somebody throwing themselves
 * into a locker and pulling the door shut behind them, and it is ALWAYS heard.
 * Same loud-fast / quiet-slow rule as everything else in the document, and the
 * sound has to make the trade obvious the first time you make it.
 */
export function hideEnter(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  haste = 0,
  seed = 193,
): SynthHandle {
  const h = clamp(haste, 0, 1);
  const vary = varier(seed);

  // Fabric: long and soft when careful, a hard rustle when diving.
  let end = noiseBurst(ctx, dest, when, {
    colour: 'pink',
    type: 'bandpass',
    freq: lerp(760, 1180, h) * vary(0.06),
    freqTo: lerp(340, 620, h),
    q: 1.2,
    attack: lerp(0.09, 0.006, h),
    hold: lerp(0.42, 0.05, h),
    decay: lerp(0.5, 0.14, h),
    peak: lerp(0.16, 0.44, h),
    seed,
  });

  // The shell: eased closed, or slammed.
  const doorAt = when + lerp(0.85, 0.16, h);
  const doorEnd = metalRing(ctx, dest, doorAt, [318, 742, 1560], {
    decay: lerp(0.1, 0.42, h),
    peak: lerp(0.12, 0.5, h),
    attack: lerp(0.01, 0.001, h),
  });
  if (doorEnd > end) end = doorEnd;
  if (h > 0.4) {
    // Your own body hitting the back of the box.
    tone(ctx, dest, doorAt, {
      type: 'sine',
      freq: 96 * vary(0.05),
      freqTo: 58,
      decay: 0.2,
      peak: 0.34 * h,
    });
    noiseBurst(ctx, dest, doorAt, {
      colour: 'brown',
      type: 'lowpass',
      freq: 380,
      freqTo: 150,
      attack: 0.002,
      decay: 0.22,
      peak: 0.4 * h,
      seed: seed + 1,
    });
  }

  // The latch. The last thing you hear before the world goes quiet.
  const latchEnd = noiseBurst(ctx, dest, doorAt + 0.05, {
    colour: 'white',
    type: 'highpass',
    freq: 2900,
    attack: 0.0006,
    decay: 0.02,
    peak: lerp(0.1, 0.34, h),
    seed: seed + 2,
  });
  if (latchEnd > end) end = latchEnd;

  return oneShot(end - when + 0.05);
}

/** 8 → 30 — and back out again. Latch first, then you. §4's breach window is
 *  two seconds, so at haste 1 this is the sound of taking it. */
export function hideExit(
  ctx: AudioContext,
  dest: AudioNode,
  when: number,
  haste = 0,
  seed = 197,
): SynthHandle {
  const h = clamp(haste, 0, 1);
  const vary = varier(seed);

  let end = noiseBurst(ctx, dest, when, {
    colour: 'white',
    type: 'highpass',
    freq: 3100 * vary(0.04),
    attack: 0.0006,
    decay: 0.022,
    peak: lerp(0.12, 0.36, h),
    seed,
  });
  const swing = metalRing(ctx, dest, when + 0.03, [364, 810, 1720], {
    decay: lerp(0.12, 0.34, h),
    peak: lerp(0.12, 0.44, h),
  });
  if (swing > end) end = swing;

  const scramble = noiseBurst(ctx, dest, when + lerp(0.18, 0.05, h), {
    colour: 'pink',
    type: 'bandpass',
    freq: lerp(820, 1320, h),
    freqTo: lerp(420, 700, h),
    q: 1.1,
    attack: lerp(0.05, 0.005, h),
    hold: lerp(0.24, 0.05, h),
    decay: lerp(0.34, 0.16, h),
    peak: lerp(0.16, 0.42, h),
    seed: seed + 1,
  });
  if (scramble > end) end = scramble;

  return oneShot(end - when + 0.05);
}

/**
 * 55 — the alien opening your box (§4, `HIDE_BREACH_TIME_S` = 2.0).
 *
 * As loud as a HUNT, because §5's non-negotiable rule is that it never does
 * anything decisive in silence. Those two seconds are a window to bail out, so
 * this has to be legible as a PROCESS with a clock on it — three blows, each
 * one further into the metal — rather than one undifferentiated roar you can
 * only sit inside.
 *
 * Audition-deck v2: the blows are untouched (they ARE the clock), but r1's
 * high-Q metal shriek — the smoke-detector cousin — becomes the animal: an
 * enraged bellow rising under the first blow, a hiss drawn in before the last.
 * You hear WHAT is coming through the door, not just that metal is losing.
 */
export function hideBreach(ctx: AudioContext, dest: AudioNode, when: number, seed = 199): SynthHandle {
  // The bellow bed, rising in pulse rate as it works.
  const larynx = gatorLarynx(ctx, dest, when, { f0: 38, peak: 0.4, attack: 0.15, rough: 0.5, roughHz: 22 });
  expRamp(larynx.oscA.frequency, 52, when + 1.5);
  expRamp(larynx.oscB.frequency, 52.6, when + 1.5);
  larynx.stop(when + 1.7, 0.4);
  tone(ctx, dest, when, { type: 'sine', freq: 30, attack: 0.2, hold: 1.2, decay: 0.5, peak: 0.14 });
  wetCrackle(ctx, dest, when + 0.2, 1.6, 0.07, seed + 20);

  // Three blows. The clock you are deciding against.
  let end = when + 2.1;
  for (let i = 0; i < 3; i++) {
    const at = when + 0.22 + i * 0.62;
    const weight = 0.36 + 0.14 * i;
    const e = metalRing(ctx, dest, at, [176, 388, 830, 1640], { decay: 0.3 + 0.08 * i, peak: weight });
    noiseBurst(ctx, dest, at, {
      colour: 'brown',
      type: 'lowpass',
      freq: 700,
      freqTo: 220,
      attack: 0.001,
      decay: 0.22,
      peak: weight,
      seed: seed + i,
    });
    noiseBurst(ctx, dest, at, {
      colour: 'white',
      type: 'highpass',
      freq: 2800,
      attack: 0.0008,
      decay: 0.05,
      peak: 0.24,
      seed: seed + 10 + i,
    });
    if (e > end) end = e;
  }

  // The intake before the last blow.
  noiseBurst(ctx, dest, when + 1.05, {
    colour: 'white',
    type: 'bandpass',
    freq: 1600,
    freqTo: 2400,
    q: 0.9,
    attack: 0.2,
    hold: 0.2,
    decay: 0.25,
    peak: 0.2,
    seed: seed + 30,
  });

  return oneShot(end - when + 0.15);
}

/**
 * The inside of a hide spot: a small metal box with you in it.
 *
 * Sustained, on the body bus, and almost inaudible on purpose — the loud half
 * of the treatment is `AudioBuses.setEnclosed()`, which muffles the world and
 * lifts your own breathing. This is the other half: the shell itself, close to
 * your ear, ticking as it settles. It is what makes the muffle read as "I am
 * inside something" instead of "the mix broke".
 */
export function hideShell(ctx: AudioContext, dest: AudioNode, when: number, seed = 211): SynthHandle {
  const out = ctx.createGain();
  out.gain.setValueAtTime(SILENCE, when);
  expRamp(out.gain, 1, when + 0.25);
  out.connect(dest);

  // Box resonance: the air in a locker has a note, and it is a low one.
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.value = 88;
  const bodyTrim = ctx.createGain();
  bodyTrim.gain.value = 0.05;
  body.connect(bodyTrim);
  bodyTrim.connect(out);

  // Air, very close, through a narrow band — the sound of breathing into a
  // surface twenty centimetres from your face.
  const air = sustainedNoise(ctx, out, when, {
    colour: 'pink',
    type: 'bandpass',
    freq: 340,
    q: 1.6,
    peak: 0.07,
    attack: 0.4,
    seed,
  });

  // The shell settling, slowly and irregularly.
  const drift = ctx.createOscillator();
  drift.type = 'sine';
  drift.frequency.value = 0.13;
  const driftDepth = ctx.createGain();
  driftDepth.gain.value = 0.025;
  drift.connect(driftDepth);
  driftDepth.connect(air.gain.gain);

  body.start(when);
  drift.start(when);

  return {
    duration: Number.POSITIVE_INFINITY,
    stop(at = ctx.currentTime, fade = 0.2): void {
      const t = Math.max(at, ctx.currentTime);
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(Math.max(out.gain.value, SILENCE), t);
      expRamp(out.gain, SILENCE, t + fade);
      air.stop(t, fade);
      try {
        body.stop(t + fade + 0.05);
        drift.stop(t + fade + 0.05);
      } catch {
        /* already stopped */
      }
    },
  };
}

// ===========================================================================
// Dispatch
// ===========================================================================

/**
 * Synthesize any NoiseKind. Exhaustive over the union — adding a kind to
 * `@shared/types` without a sound fails the build here, which is the point.
 *
 * 'voice' and 'headset' produce nothing when the voice mesh is live: the real
 * audio arrives over WebRTC (§7) and doubling it with a synthetic stand-in
 * would be worse than either. Pass `allowVoicePlaceholder` to hear a stand-in
 * in a solo session.
 */
export function synthesize(
  ctx: AudioContext,
  dest: AudioNode,
  kind: NoiseKind,
  when: number,
  opts: SynthOptions = {},
): SynthHandle {
  const seed = opts.seed ?? 1;
  switch (kind) {
    case 'rail-pull':
      return railPull(ctx, dest, when, seed);
    case 'push-off':
      return pushOff(ctx, dest, when, seed);
    case 'catch':
      return railCatch(ctx, dest, when, opts.speed ?? 0, seed);
    case 'impact':
      return impact(ctx, dest, when, opts.speed ?? 0, seed);
    case 'body-collision':
      return bodyCollision(ctx, dest, when, seed);
    case 'footstep':
      return footstep(ctx, dest, when, opts.gait ?? 'walk', seed);
    case 'landing':
      // `speed` present means the fall beat the gait's silent-landing tolerance
      // and §14 charged it `impactNoise`; absent means it was soft. See
      // `landing()` — it re-derives the branch from `landingSoftMaxMps` itself.
      return landing(ctx, dest, when, opts.speed, opts.gait, seed);
    case 'hide-enter':
      return hideEnter(ctx, dest, when, opts.intensity ?? 0, seed);
    case 'hide-exit':
      return hideExit(ctx, dest, when, opts.intensity ?? 0, seed);
    case 'hide-breach':
      return hideBreach(ctx, dest, when, seed);
    case 'gravity-shift':
      return gravityShift(ctx, dest, when, seed);
    case 'extinguisher':
      return extinguisher(ctx, dest, when, { sustain: opts.sustain ?? false, seed });
    case 'breathing':
      return breath(ctx, dest, when, { intensity: opts.intensity ?? 0, exhale: (seed & 1) === 1, seed });
    case 'voice':
      // Handled by the WebRTC mesh; a synthetic voice would be worse than none.
      return oneShot(0);
    case 'headset':
      return headset(ctx, dest, when, seed);
    case 'knock':
      return knock(ctx, dest, when, seed);
    case 'tracker-beep':
      return trackerBeep(ctx, dest, when, opts.intensity ?? 0);
    case 'cargo-bounce':
      return cargoBounce(ctx, dest, when, seed);
    case 'hatch-cycle':
      return hatchCycle(ctx, dest, when, seed);
    case 'pry-bar':
      return pryBar(ctx, dest, when, seed);
    case 'decoy':
      return decoy(ctx, dest, when, seed);
    case 'breaker':
      return breaker(ctx, dest, when, seed);
    case 'breaker-reset':
      return breakerReset(ctx, dest, when, seed);
    case 'hand-pump':
      return handPump(ctx, dest, when, seed);
    case 'valve-slow':
      return valveSlow(ctx, dest, when, seed);
    case 'valve-fast':
      return valveFast(ctx, dest, when, seed);
    case 'keyswitch':
      return keyswitch(ctx, dest, when, seed);
    case 'undock-lever':
      return undockLever(ctx, dest, when, seed);
    case 'alien':
      return alienVocal(ctx, dest, when, { sustain: opts.sustain ?? false, seed });
    default: {
      const never: never = kind;
      throw new Error(`synthesize: unhandled NoiseKind ${String(never)}`);
    }
  }
}

/** Kinds that can run as a continuous source rather than a one-shot. */
export const SUSTAINABLE_KINDS: ReadonlySet<NoiseKind> = new Set<NoiseKind>(['alien', 'extinguisher']);
