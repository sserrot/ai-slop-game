/**
 * The wrist tracker's voice (DESIGN.md §6).
 *
 * A beep every 3 s when the alien is far, accelerating as it closes, a solid
 * tone when it is adjacent. The tracker sits on its own bus so it survives the
 * HUNT duck — it is the one instrument you need while being chased.
 *
 * The trap §6 is careful to point out: the beep is a real in-world noise at
 * loudness 20, so an unmuted tracker gets more expensive the more danger you
 * are in. That is why `onBeep` exists: whoever owns the tracker calls
 * `emitter.trackerBeep(pos, module)` from it, and the alien hears it too.
 * Muted, nothing is emitted and nothing is heard — silent but blind.
 *
 * Two clocks, not one. What you HEAR runs at `trackerPulseInterval()` (below);
 * what the world hears runs at `trackerEmitInterval()`, which is floored at one
 * event per §3 coalescing window. See `../ui/trackerCadence` for why — the short
 * version is that the alien acts on the loudest event per window, so a second
 * beep inside the same window is a websocket message, a graph walk and a
 * broadcast that cannot change anything it does.
 *
 * Playtest 2 moved the audible clock onto a geometric curve and left the emitted
 * one exactly where it was, so the device got legible without getting louder in
 * the world. The cadence, band and pitch mappings all live in this file and the
 * HUD imports them from here, so the trace you watch and the pulse you hear can
 * never drift apart — the last time they had separate copies they disagreed by
 * 3.3x, and this round's complaint was that the player could not read the thing
 * at all.
 *
 * Both clocks are gated on being alive in a live round. A corpse does not carry
 * a beeping tracker, and the server drops noise from the dead anyway (§10) —
 * the client should not be shouting messages into that drop.
 */

import {
  TRACKER_BEEP_INTERVAL_FAR_S,
  TRACKER_BEEP_INTERVAL_NEAR_S,
  TRACKER_CADENCE_LOG_BLEND,
  TRACKER_URGENCY_CLOSING,
  TRACKER_URGENCY_NEAR,
  clamp,
} from '@shared/constants';
import type { PlayerId } from '@shared/types';

import type { EventBus, Unsubscribe } from '../core/eventBus';
import { bus as defaultBus, type GameEvents } from '../core/eventBus';
import {
  isTrackerSolid,
  trackerBeepInterval,
  trackerEmitInterval,
  trackerUrgency,
} from '../ui/trackerCadence';
import type { AudioEngine } from './engine';
import { trackerTone, type SynthHandle } from './synth';

/**
 * Which of the tracker's four states a distance falls in (§6, §14).
 *
 * The device never shows a distance and never will. It does have to show which
 * state it is in, because that is what lets the eye and the ear agree — the HUD
 * lane colour, the rate pips and the chirp's pitch all key off this, so a player
 * learns "amber and rising = it is closing" by seeing and hearing it at once.
 */
export type TrackerBand = 'idle' | 'closing' | 'near' | 'contact';

export function trackerBand(metres: number): TrackerBand {
  if (isTrackerSolid(metres)) return 'contact';
  const u = trackerUrgency(metres);
  if (u >= TRACKER_URGENCY_NEAR) return 'near';
  if (u >= TRACKER_URGENCY_CLOSING) return 'closing';
  return 'idle';
}

/**
 * Seconds between AUDIBLE pulses at `metres` — the legibility-shaped curve.
 *
 * `trackerBeepInterval` in `../ui/trackerCadence` interpolates the interval
 * linearly between §6's two endpoints, which puts nearly all of the acceleration
 * inside the last few metres: across the outer half of the range the rate only
 * moved 0.33 → 0.63 Hz, and playtest 2 reported exactly the symptom that
 * predicts — a beep the player could not decode and had to guess at. Blending
 * toward a geometric curve (TRACKER_CADENCE_LOG_BLEND, §14) makes every equal
 * step of distance multiply the rate by the same factor, so "it is speeding up"
 * is legible anywhere in the range instead of only at knife range.
 *
 * This is the clock for what you HEAR and SEE. What the WORLD hears is still
 * `trackerEmitInterval`, still built on the linear curve and still floored at
 * one event per §3 coalescing window — the in-world cost of an unmuted tracker
 * is byte-for-byte what it was, which is the point: this fixes the sound, not
 * the noise.
 */
export function trackerPulseInterval(metres: number): number {
  const linear = trackerBeepInterval(metres);
  const blend = clamp(TRACKER_CADENCE_LOG_BLEND, 0, 1);
  if (blend <= 0) return linear;
  const geometric =
    TRACKER_BEEP_INTERVAL_FAR_S *
    Math.pow(TRACKER_BEEP_INTERVAL_NEAR_S / TRACKER_BEEP_INTERVAL_FAR_S, trackerUrgency(metres));
  return linear + (geometric - linear) * blend;
}

/** Audible pulses per second at `metres`. The number the player is decoding. */
export function trackerPulseHz(metres: number): number {
  return 1 / trackerPulseInterval(metres);
}

export interface TrackerAudioOptions {
  bus?: EventBus<GameEvents>;
  /** Fired on every EMITTED beep — make the loudness-20 NoiseEvent here (§6).
   *  This is the emitted cadence, not the audible one: see the file header. */
  onBeep?: (urgency: number) => void;
  /** Beep gain on the tracker bus. */
  gain?: number;
  /**
   * How to recognise the local player in `player:died` / `player:revived`,
   * which the server broadcasts for everybody. Returning `null` means "not
   * known yet", and the tracker then ignores those events rather than muting
   * itself because a teammate died.
   */
  localPlayerId?: PlayerId | (() => PlayerId | null) | null;
}

export class TrackerAudio {
  private readonly engine: AudioEngine;
  private readonly bus: EventBus<GameEvents>;
  private readonly onBeep: ((urgency: number) => void) | undefined;
  private readonly gain: number;
  private readonly resolveLocalId: () => PlayerId | null;

  private subscriptions: Unsubscribe[] = [];
  private metres = Number.POSITIVE_INFINITY;
  private muted = false;
  private alive = true;
  private roundLive = true;
  private busLocalId: PlayerId | null = null;
  private beepTimer = 0;
  private emitTimer = 0;
  private solid: SynthHandle | null = null;

  constructor(engine: AudioEngine, opts: TrackerAudioOptions = {}) {
    this.engine = engine;
    this.bus = opts.bus ?? defaultBus;
    this.onBeep = opts.onBeep;
    this.gain = opts.gain ?? 0.85;
    const supplied = opts.localPlayerId;
    this.resolveLocalId =
      typeof supplied === 'function' ? supplied : () => supplied ?? this.busLocalId;
  }

  attach(): Unsubscribe {
    this.detach();
    this.subscriptions.push(
      this.bus.on('alien:proximity', ({ metres }) => this.setProximity(metres)),
      this.bus.on('ui:trackerMute', ({ muted }) => this.setMuted(muted)),
      // Lifecycle. `player:died` is broadcast for every player, so it has to be
      // filtered — muting your own tracker because a teammate died would delete
      // the one instrument §6 says you need while being chased.
      this.bus.on('net:connected', ({ sessionId }) => {
        this.busLocalId = sessionId;
      }),
      this.bus.on('player:died', ({ playerId }) => {
        if (this.isLocal(playerId)) this.setAlive(false);
      }),
      this.bus.on('player:revived', ({ id }) => {
        if (this.isLocal(id)) this.setAlive(true);
      }),
      this.bus.on('round:started', () => {
        this.setAlive(true);
        this.setRoundLive(true);
      }),
      this.bus.on('round:ended', () => this.setRoundLive(false)),
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

  setProximity(metres: number): void {
    this.metres = metres;
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    if (muted) this.stopSolid();
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** §10: the dead do not carry a beeping tracker. */
  setAlive(alive: boolean): void {
    if (alive === this.alive) return;
    this.alive = alive;
    if (!alive) this.stopSolid();
  }

  /** False between `round:ended` and the next `round:started`. */
  setRoundLive(live: boolean): void {
    if (live === this.roundLive) return;
    this.roundLive = live;
    if (!live) this.stopSolid();
    else this.beepTimer = 0;
  }

  /** The device is powered, unmuted, and its owner is alive in a live round. */
  get isRunning(): boolean {
    return !this.muted && this.alive && this.roundLive && Number.isFinite(this.metres);
  }

  /** Seconds between audible chirps at the current range (§6, §14). */
  get interval(): number {
    return trackerPulseInterval(this.metres);
  }

  /** Which of the four states the device is in. Drives the HUD, not the sound. */
  get band(): TrackerBand {
    return trackerBand(this.metres);
  }

  /** Seconds between emitted loudness-20 NoiseEvents at the current range. */
  get emitInterval(): number {
    return trackerEmitInterval(this.metres);
  }

  /** 0 far, 1 adjacent. Drives beep pitch. */
  get urgency(): number {
    return trackerUrgency(this.metres);
  }

  /** Drive from the fixed update. */
  update(dt: number): void {
    if (!this.isRunning) {
      this.stopSolid();
      return;
    }

    const solid = isTrackerSolid(this.metres);

    // ---- what you hear ---------------------------------------------------
    if (solid) {
      // A solid tone is one continuous sound, not a chirp per tick.
      this.startSolid();
      this.beepTimer = 0;
    } else {
      this.stopSolid();
      this.beepTimer += dt;
      if (this.beepTimer >= this.interval) {
        // CARRY THE REMAINDER, never zero it. This clock is driven from the
        // 20 Hz fixed step (TICK_MS), so its resolution is 50 ms, while the
        // interval it is chasing is continuous — 156 ms at the inner edge of
        // the closing band. Zeroing rounds every gap UP to the next tick, which
        // pins the chirp to 5 Hz where `trackerPulseInterval` asks for 6.4 and
        // leaves the sound running 22% slow against the HUD trace, whose own
        // pulse clock (WristTracker.advancePulse) already carries its remainder
        // on a 30 Hz sample grid. Measured before this line: 5.00 Hz heard vs
        // 6.42 Hz seen at 4.5 m. Both halves read the same
        // `trackerPulseInterval`; this is what makes them keep the same time.
        //
        // Clamped to one interval of catch-up so a long stall (an alt-tab, a
        // GC pause, a `dt` clamp) cannot queue a burst of chirps on resume.
        this.beepTimer = Math.min(this.beepTimer - this.interval, this.interval);
        this.playBeep();
      }
    }

    // ---- what the world hears --------------------------------------------
    // Decoupled on purpose. Inside TRACKER_SOLID_RANGE_M there is no chirp to
    // hang an event on anyway, and outside it the audible cadence outruns the
    // §3 coalescing window long before the alien could use the extra events.
    this.emitTimer += dt;
    if (this.emitTimer >= this.emitInterval) {
      this.emitTimer = 0;
      this.onBeep?.(this.urgency);
    }
  }

  /**
   * Play one chirp now, out of cadence, and emit the matching NoiseEvent.
   * For the cadenced path use `update()` — this is the manual override.
   */
  beep(): void {
    this.playBeep();
    this.emitTimer = 0;
    this.onBeep?.(this.urgency);
  }

  /** The sound only. The emitted noise runs on its own clock. */
  private playBeep(): void {
    this.engine.play({
      kind: 'tracker-beep',
      level: 100,
      position: null,
      bus: 'tracker',
      gain: this.gain,
      intensity: this.urgency,
      reverb: 0,
    });
  }

  private isLocal(id: PlayerId): boolean {
    const local = this.resolveLocalId();
    return local !== null && local === id;
  }

  private startSolid(): void {
    if (this.solid) return;
    const ctx = this.engine.ctx;
    this.solid = trackerTone(ctx, this.engine.buses.tracker, ctx.currentTime);
  }

  private stopSolid(): void {
    if (!this.solid) return;
    this.solid.stop(this.engine.ctx.currentTime, 0.08);
    this.solid = null;
  }

  dispose(): void {
    this.detach();
    this.stopSolid();
  }
}

/** Re-exported so callers do not have to know the cadence lives in `src/ui`. */
export {
  TRACKER_EMIT_INTERVAL_MIN_S,
  isTrackerSolid,
  trackerBeepInterval,
  trackerEmitInterval,
  trackerUrgency,
} from '../ui/trackerCadence';
