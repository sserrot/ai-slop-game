/**
 * The station itself (DESIGN.md §8, §2 lighting, §5's optional escalation lever).
 *
 * A continuous hum on the WORLD bus, which means it ducks under a HUNT along
 * with everything else — the station going quiet as the thing arrives is worth
 * more than any stinger.
 *
 * §5 offers an optional lever: "raise the ambient station hum by +2 to the
 * audibility floor per stage… add it only if playtests demand it." It is
 * implemented here and DISABLED by default (`stageBoost: 0`), because the doc
 * says to add it only on evidence.
 */

import type { GravityMode, LightingLevel, ModuleKind } from '@shared/types';

import type { AudioEngine } from './engine';
import { stationHum, type HumHandle } from './synth';

export interface AmbienceOptions {
  /** Hum level under nominal lighting, 0–1. */
  nominal?: number;
  emergency?: number;
  dark?: number;
  /** §5's optional lever: extra hum level per director stage. 0 = off. */
  stageBoost?: number;
  /** How much of the gravity plant is still audible in a `zero` module, 0–1. */
  zeroGPlant?: number;
}

const DEFAULTS = { nominal: 0.5, emergency: 0.34, dark: 0.12, stageBoost: 0, zeroGPlant: 0.12 };

export class StationAmbience {
  private readonly engine: AudioEngine;
  private readonly opts: Required<AmbienceOptions>;
  private hum: HumHandle | null = null;
  private lighting: LightingLevel = 'emergency';
  private stage = 0;
  private volumeScale = 1;
  private gravity: GravityMode = 'nominal';

  constructor(engine: AudioEngine, opts: AmbienceOptions = {}) {
    this.engine = engine;
    this.opts = {
      nominal: opts.nominal ?? DEFAULTS.nominal,
      emergency: opts.emergency ?? DEFAULTS.emergency,
      dark: opts.dark ?? DEFAULTS.dark,
      stageBoost: opts.stageBoost ?? DEFAULTS.stageBoost,
      zeroGPlant: opts.zeroGPlant ?? DEFAULTS.zeroGPlant,
    };
  }

  start(): void {
    if (this.hum) return;
    const ctx = this.engine.ctx;
    this.hum = stationHum(ctx, this.engine.buses.world, ctx.currentTime, { level: this.level() });
    this.hum.setColour(this.colour());
    this.hum.setPlant(this.plant(), 0.01);
  }

  stop(fadeSeconds = 1.2): void {
    this.hum?.stop(this.engine.ctx.currentTime, fadeSeconds);
    this.hum = null;
  }

  get running(): boolean {
    return this.hum !== null;
  }

  /** Emergency lighting is duller and quieter; a dark module is nearly silent
   *  and much more frightening for it (§2). */
  setLighting(level: LightingLevel): void {
    if (level === this.lighting) return;
    this.lighting = level;
    this.apply();
  }

  /** Bigger modules hum louder; the kind sets the reverb, not the hum. */
  setModule(_kind: ModuleKind, volume?: number): void {
    const scale = volume === undefined || volume <= 0 ? 1 : Math.min(Math.max(volume / 50, 0.75), 1.35);
    if (Math.abs(scale - this.volumeScale) < 0.02) return;
    this.volumeScale = scale;
    this.apply();
  }

  /** §5's optional lever. No effect while `stageBoost` is 0. */
  setStage(stage: number): void {
    if (stage === this.stage) return;
    this.stage = stage;
    if (this.opts.stageBoost !== 0) this.apply();
  }

  /**
   * The listener's module lost (or regained) its floor (§4).
   *
   * A `zero` module is not a quiet module — it is a THINNER one. The gravity
   * plant and its pump stop; the air handling does not, because you still have
   * to breathe. Crossing a hatch into a failed module should be audible before
   * you have taken a step, and this is what makes it so.
   *
   * The transition is slow (a second and a half) because the shift itself
   * already had a 2.5 s warning and a 35-loudness bang on top of it; the room
   * settling into its new character afterwards is the aftermath, not the event.
   */
  setGravity(mode: GravityMode): void {
    if (mode === this.gravity) return;
    this.gravity = mode;
    this.hum?.setPlant(this.plant(), 1.5);
  }

  get gravityMode(): GravityMode {
    return this.gravity;
  }

  private apply(): void {
    if (!this.hum) return;
    this.hum.setLevel(this.level());
    this.hum.setColour(this.colour());
    this.hum.setPlant(this.plant());
  }

  private plant(): number {
    return this.gravity === 'zero' ? this.opts.zeroGPlant : 1;
  }

  private level(): number {
    const base =
      this.lighting === 'nominal'
        ? this.opts.nominal
        : this.lighting === 'emergency'
          ? this.opts.emergency
          : this.opts.dark;
    return Math.min(1, (base + this.opts.stageBoost * this.stage) * this.volumeScale);
  }

  private colour(): number {
    return this.lighting === 'nominal' ? 0.85 : this.lighting === 'emergency' ? 0.45 : 0.2;
  }
}
