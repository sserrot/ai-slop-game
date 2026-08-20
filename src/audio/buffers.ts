/**
 * Procedural audio buffers (DESIGN.md §8, §9 "grey-box everything").
 *
 * There are no audio assets in this repository and there must never need to be.
 * Everything audible in ISS is built here or in `synth.ts` from noise buffers
 * and oscillators — including the reverb impulse responses, which are
 * synthesized rather than shipped as IR files.
 *
 * Buffers are cached per AudioContext: a white-noise buffer is ~350 KB and
 * every hiss, thump and scrape in the game shares four of them.
 */

export type NoiseColour = 'white' | 'pink' | 'brown' | 'velvet';

interface Cache {
  noise: Map<string, AudioBuffer>;
  ir: Map<string, AudioBuffer>;
}

const caches = new WeakMap<BaseAudioContext, Cache>();

function cacheFor(ctx: BaseAudioContext): Cache {
  let cache = caches.get(ctx);
  if (!cache) {
    cache = { noise: new Map(), ir: new Map() };
    caches.set(ctx, cache);
  }
  return cache;
}

/** Deterministic RNG so a given sound is the same shape every time it plays. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A looping noise buffer of the requested colour.
 *
 * - white: flat, for hiss and transients
 * - pink: -3 dB/octave, the natural bed for air handling and breath
 * - brown: -6 dB/octave, rumble and thuds
 * - velvet: sparse impulses, for rattles and clatter
 */
export function noiseBuffer(
  ctx: BaseAudioContext,
  colour: NoiseColour = 'white',
  seconds = 2,
  seed = 1337,
): AudioBuffer {
  const cache = cacheFor(ctx);
  const key = `${colour}:${seconds}:${seed}`;
  const hit = cache.noise.get(key);
  if (hit) return hit;

  const rate = ctx.sampleRate;
  const frames = Math.max(1, Math.floor(seconds * rate));
  const buffer = ctx.createBuffer(1, frames, rate);
  const data = buffer.getChannelData(0);
  const rng = mulberry32(seed);

  switch (colour) {
    case 'white': {
      for (let i = 0; i < frames; i++) data[i] = rng() * 2 - 1;
      break;
    }
    case 'pink': {
      // Paul Kellet's economical pink filter.
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < frames; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
        data[i] = out * 0.11;
      }
      break;
    }
    case 'brown': {
      let last = 0;
      for (let i = 0; i < frames; i++) {
        const w = rng() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = last * 3.5;
      }
      break;
    }
    case 'velvet': {
      data.fill(0);
      const density = Math.floor(rate / 900);
      for (let i = 0; i < frames; i += density) {
        const at = i + Math.floor(rng() * density);
        if (at < frames) data[at] = rng() < 0.5 ? -1 : 1;
      }
      break;
    }
  }

  cache.noise.set(key, buffer);
  return buffer;
}

export interface ImpulseOptions {
  /** Total IR length in seconds. Keep these SHORT — §8 asks for short IRs. */
  seconds: number;
  /** Decay exponent: higher decays faster and tighter. */
  decay: number;
  /** Lowpass character of the tail, in Hz-ish terms (0–1 brightness). */
  brightness: number;
  /** Silence before the first reflection, in ms. Bigger rooms, bigger gap. */
  predelayMs?: number;
  /** Discrete early reflections before the diffuse tail. */
  reflections?: number;
  /** Stereo decorrelation, 0–1. */
  spread?: number;
  seed?: number;
}

/**
 * Synthesize a stereo impulse response: predelay, a handful of discrete early
 * reflections (this is what makes a 5 m tube sound like a tube), then an
 * exponentially decaying diffuse tail with a one-pole lowpass rolling off the
 * top as it dies — which is how real rooms behave and why a lab and a node tube
 * do not sound alike (§8).
 */
export function impulseResponse(ctx: BaseAudioContext, opts: ImpulseOptions, key?: string): AudioBuffer {
  const cache = cacheFor(ctx);
  const cacheKey =
    key ??
    `${opts.seconds}:${opts.decay}:${opts.brightness}:${opts.predelayMs ?? 0}:${opts.reflections ?? 0}:${opts.spread ?? 0}:${opts.seed ?? 7}`;
  const hit = cache.ir.get(cacheKey);
  if (hit) return hit;

  const rate = ctx.sampleRate;
  const frames = Math.max(8, Math.floor(opts.seconds * rate));
  const buffer = ctx.createBuffer(2, frames, rate);
  const predelay = Math.floor(((opts.predelayMs ?? 4) / 1000) * rate);
  const reflections = opts.reflections ?? 6;
  const spread = opts.spread ?? 0.6;
  const rng = mulberry32(opts.seed ?? 7);
  // One-pole coefficient: brightness 1 keeps the tail open, 0 closes it fast.
  const lpBase = 0.25 + 0.7 * Math.min(Math.max(opts.brightness, 0), 1);

  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    const channelSeedJitter = channel === 0 ? 1 : 1 + spread * 0.35;
    let lp = 0;

    for (let i = 0; i < frames; i++) {
      if (i < predelay) {
        data[i] = 0;
        continue;
      }
      const t = (i - predelay) / (frames - predelay);
      const envelope = Math.pow(1 - t, opts.decay * channelSeedJitter);
      const w = rng() * 2 - 1;
      // The tail gets duller as it decays.
      const coeff = lpBase * (0.35 + 0.65 * (1 - t));
      lp = lp + coeff * (w - lp);
      data[i] = lp * envelope;
    }

    // Early reflections: discrete, louder than the tail, slightly different per
    // channel. Without these a convolver just sounds like a smear.
    for (let r = 0; r < reflections; r++) {
      const at = predelay + Math.floor((0.004 + rng() * 0.06) * rate * (1 + r * 0.5));
      if (at >= frames) break;
      const amp = (0.9 - r * 0.11) * (channel === 0 ? 1 : 0.82 + spread * 0.2);
      data[at] += (rng() < 0.5 ? -1 : 1) * Math.max(amp, 0.05);
    }
  }

  normalise(buffer, 0.9);
  cache.ir.set(cacheKey, buffer);
  return buffer;
}

/** Scale a buffer so its loudest sample sits at `peak`. */
export function normalise(buffer: AudioBuffer, peak = 1): void {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > max) max = v;
    }
  }
  if (max <= 0) return;
  const scale = peak / max;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
}
