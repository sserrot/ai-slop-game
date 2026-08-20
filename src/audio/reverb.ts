/**
 * Per-module-kind reverb (DESIGN.md §8: "`ConvolverNode` per module kind with a
 * short IR — a lab and a node tube shouldn't sound alike").
 *
 * The reverb you hear is the space *you* are in, not the space the sound came
 * from, so there is one active convolver at a time: the listener's module. Two
 * slots exist so a module change crossfades instead of cutting — you traverse a
 * hatch every few seconds and a hard switch is very audible.
 *
 * Module `volume` (m³, §2) scales the wet amount, which is the "volume drives
 * reverb selection" line in §2 made concrete.
 */

import type { ModuleKind } from '@shared/types';
import { impulseResponse } from './buffers';
import { ramp, setNow } from './levels';

export interface ReverbProfile {
  seconds: number;
  decay: number;
  brightness: number;
  predelayMs: number;
  reflections: number;
  spread: number;
  /** Baseline wet gain for this kind. */
  wet: number;
  /** m³ the wet amount is calibrated for; bigger modules get more of it. */
  referenceVolume: number;
}

/**
 * Five kit pieces, five spaces. A 5 m straight is a tight metal tube with a
 * flutter; a node is the boomy junction; the cupola is small, glassy and
 * bright; the airlock is hard and clanging; the lab is the only room that
 * sounds like a room.
 */
export const MODULE_REVERBS: Readonly<Record<ModuleKind, ReverbProfile>> = Object.freeze({
  straight: {
    seconds: 0.6,
    decay: 3.0,
    brightness: 0.55,
    predelayMs: 3,
    reflections: 7,
    spread: 0.35,
    wet: 0.3,
    referenceVolume: 40,
  },
  node: {
    seconds: 0.9,
    decay: 2.4,
    brightness: 0.45,
    predelayMs: 6,
    reflections: 9,
    spread: 0.7,
    wet: 0.36,
    referenceVolume: 55,
  },
  cupola: {
    seconds: 0.45,
    decay: 3.6,
    brightness: 0.85,
    predelayMs: 2,
    reflections: 5,
    spread: 0.5,
    wet: 0.24,
    referenceVolume: 25,
  },
  airlock: {
    seconds: 1.1,
    decay: 2.0,
    brightness: 0.7,
    predelayMs: 5,
    reflections: 8,
    spread: 0.45,
    wet: 0.42,
    referenceVolume: 30,
  },
  lab: {
    seconds: 1.4,
    decay: 1.8,
    brightness: 0.4,
    predelayMs: 11,
    reflections: 11,
    spread: 0.85,
    wet: 0.34,
    referenceVolume: 90,
  },
});

const CROSSFADE_TAU = 0.15;

interface Slot {
  convolver: ConvolverNode;
  gain: GainNode;
  kind: ModuleKind | null;
}

export class ReverbRack {
  private readonly ctx: AudioContext;
  /** Send bus: connect any voice here to put it in the room. */
  readonly input: GainNode;
  private readonly slots: [Slot, Slot];
  private active = 0;
  private currentKind: ModuleKind | null = null;
  private currentWet = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.input.gain.value = 1;

    this.slots = [this.makeSlot(destination), this.makeSlot(destination)];
    this.setModule('straight', MODULE_REVERBS.straight.referenceVolume);
  }

  private makeSlot(destination: AudioNode): Slot {
    const convolver = this.ctx.createConvolver();
    convolver.normalize = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    this.input.connect(convolver);
    convolver.connect(gain);
    gain.connect(destination);
    return { convolver, gain, kind: null };
  }

  /** Switch the listener's acoustic space. Crossfades; safe to call every frame. */
  setModule(kind: ModuleKind, volume?: number): void {
    const profile = MODULE_REVERBS[kind] ?? MODULE_REVERBS.straight;
    const wet = wetFor(profile, volume);
    const now = this.ctx.currentTime;

    if (kind === this.currentKind) {
      if (Math.abs(wet - this.currentWet) > 0.01) {
        this.currentWet = wet;
        ramp(this.slots[this.active].gain.gain, wet, now, CROSSFADE_TAU);
      }
      return;
    }

    const next = this.active === 0 ? 1 : 0;
    const slot = this.slots[next];
    if (slot.kind !== kind) {
      slot.convolver.buffer = impulseResponse(
        this.ctx,
        {
          seconds: profile.seconds,
          decay: profile.decay,
          brightness: profile.brightness,
          predelayMs: profile.predelayMs,
          reflections: profile.reflections,
          spread: profile.spread,
        },
        `module:${kind}`,
      );
      slot.kind = kind;
    }

    ramp(slot.gain.gain, wet, now, CROSSFADE_TAU);
    ramp(this.slots[this.active].gain.gain, 0, now, CROSSFADE_TAU);
    this.active = next;
    this.currentKind = kind;
    this.currentWet = wet;
  }

  /** Global wet trim, e.g. muted during the results screen. */
  setSendLevel(value: number): void {
    ramp(this.input.gain, value, this.ctx.currentTime, 0.05);
  }

  get kind(): ModuleKind | null {
    return this.currentKind;
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    for (const slot of this.slots) {
      setNow(slot.gain.gain, 0, now);
      try {
        slot.gain.disconnect();
        slot.convolver.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    try {
      this.input.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

function wetFor(profile: ReverbProfile, volume?: number): number {
  if (volume === undefined || volume <= 0) return profile.wet;
  const scale = Math.min(Math.max(volume / profile.referenceVolume, 0.6), 1.6);
  return profile.wet * scale;
}
