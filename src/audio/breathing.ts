/**
 * Your own breathing (DESIGN.md §6 — "Heart rate — core, not optional").
 *
 * Heart rate climbs with alien proximity and drives a breathing loop that emits
 * 6–14 loudness. It is the direct counter to the freeze meta: holding still
 * next to the alien stops being free. This module makes the sound; `onBreath`
 * lets whoever owns the player emit the matching NoiseEvent, so what you hear
 * and what the alien hears are the same breath.
 *
 * Respiration is derived from bpm at roughly 4 heartbeats per breath, which
 * lands a resting 65 bpm on a ~3.7 s cycle and a panicked 150 bpm on ~1.6 s.
 */

import { BREATHING_MAX, BREATHING_MIN, breathingNoise, clamp } from '@shared/constants';

import type { EventBus, Unsubscribe } from '../core/eventBus';
import { bus as defaultBus, type GameEvents } from '../core/eventBus';
import type { AudioEngine } from './engine';

export interface BreathingAudioOptions {
  bus?: EventBus<GameEvents>;
  /** Called on each exhale with the 0–1 intensity: emit the NoiseEvent here. */
  onBreath?: (intensity: number) => void;
  /** Body-bus gain for the breath itself. */
  gain?: number;
  /** Heartbeats per breath. */
  beatsPerBreath?: number;
  /** bpm mapped to intensity 0 and 1 when no explicit intensity is supplied. */
  restingBpm?: number;
  maxBpm?: number;
}

export class BreathingAudio {
  private readonly engine: AudioEngine;
  private readonly bus: EventBus<GameEvents>;
  private readonly onBreath: ((intensity: number) => void) | undefined;
  private readonly gain: number;
  private readonly beatsPerBreath: number;
  private readonly restingBpm: number;
  private readonly maxBpm: number;

  private subscriptions: Unsubscribe[] = [];
  private bpm = 70;
  private intensity = 0;
  private timer = 0;
  private inhaling = true;
  private alive = true;
  private running = false;
  private seed = 5;

  constructor(engine: AudioEngine, opts: BreathingAudioOptions = {}) {
    this.engine = engine;
    this.bus = opts.bus ?? defaultBus;
    this.onBreath = opts.onBreath;
    this.gain = opts.gain ?? 0.75;
    this.beatsPerBreath = opts.beatsPerBreath ?? 4;
    this.restingBpm = opts.restingBpm ?? 65;
    this.maxBpm = opts.maxBpm ?? 165;
  }

  attach(): Unsubscribe {
    this.detach();
    this.subscriptions.push(
      this.bus.on('player:heartRate', ({ bpm, intensity }) => {
        this.bpm = bpm;
        this.intensity = clamp(intensity, 0, 1);
      }),
      this.bus.on('player:died', () => this.setAlive(false)),
      this.bus.on('player:revived', () => this.setAlive(true)),
      this.bus.on('round:started', () => {
        this.setAlive(true);
        this.timer = 0;
      }),
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

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  setAlive(alive: boolean): void {
    this.alive = alive;
  }

  /** Explicit heart rate, if you are not going through the bus. */
  setHeartRate(bpm: number): void {
    this.bpm = bpm;
    this.intensity = clamp((bpm - this.restingBpm) / (this.maxBpm - this.restingBpm), 0, 1);
  }

  /** Loudness this breath would emit right now: 6–14 (§6). */
  get loudness(): number {
    return breathingNoise(this.intensity);
  }

  /** Seconds per full breath cycle at the current heart rate. */
  get cycleSeconds(): number {
    const bpm = Math.max(this.bpm, 30);
    return clamp((60 / bpm) * this.beatsPerBreath, 1.1, 6);
  }

  /** Drive from the fixed update. */
  update(dt: number): void {
    if (!this.running || !this.alive) return;
    this.timer += dt;
    const half = this.cycleSeconds * (this.inhaling ? 0.45 : 0.55);
    if (this.timer < half) return;
    this.timer = 0;
    const exhale = !this.inhaling;
    this.inhaling = !this.inhaling;
    this.breathe(exhale);
  }

  /** Play one half-breath. Always audible: it is happening inside your helmet. */
  breathe(exhale: boolean): void {
    this.seed = (this.seed * 1103515245 + 12345) >>> 0;
    this.engine.play({
      kind: 'breathing',
      level: BREATHING_MAX,
      position: null,
      bus: 'body',
      gain: this.gain * (0.55 + 0.45 * this.intensity) * (exhale ? 1 : 0.85),
      intensity: this.intensity,
      reverb: 0.15,
      // `synthesize` reads the low bit of the seed as inhale/exhale.
      seed: ((this.seed % 9973) & ~1) | (exhale ? 1 : 0),
    });
    if (exhale) this.onBreath?.(this.intensity);
  }

  /** Loudness range this system can emit, for a HUD readout (§6). */
  static get range(): { min: number; max: number } {
    return { min: BREATHING_MIN, max: BREATHING_MAX };
  }
}
