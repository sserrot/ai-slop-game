/**
 * The audio engine (DESIGN.md §8).
 *
 * One sound is: a synthesized source -> a GainNode driven by the §3 arrival
 * level -> a BiquadFilterNode driven by occlusion -> a pooled HRTF panner
 * placed at `resolution.panPosition` -> a bus. Plus a send into the listener's
 * module reverb.
 *
 * THE IMPORTANT PART, and the thing §8 calls its single most important line:
 * for any cross-module sound the panner goes AT THE CONNECTING PORT the sound
 * arrived through — not along the source's true bearing through the bulkhead.
 * `resolve()` in `@shared/graph/noise` hands us exactly that as `panPosition`,
 * and this engine never second-guesses it. Get this wrong and the mental model
 * pillar 3 exists to protect breaks in the first minute of play.
 */

import type { Gait, ModuleKind, NoiseKind, Vec3 } from '@shared/types';
import { cross, normalize, sub, v3 } from '@shared/graph/math';

import type { Unsubscribe } from '../core/eventBus';
import { AudioBuses, type BusName, type BusOptions } from './buses';
import {
  RAMP_TAU,
  levelToGain,
  occlusionCutoffHz,
  ramp,
  setNow,
  type LevelMapping,
} from './levels';
import { PannerPool, setPannerPosition, type PannerLease } from './pannerPool';
import { ReverbRack } from './reverb';
import { synthesize, type SynthHandle, type SynthSource } from './synth';

export interface AudioEngineOptions {
  /** Bring your own context (tests, or a shared one). */
  context?: AudioContext;
  /** HRTF panner budget. §8: browsers degrade past a few dozen. */
  pannerCapacity?: number;
  buses?: BusOptions;
  /** Loudness→gain mapping overrides. See `levels.ts`. */
  levels?: LevelMapping;
  /** Global cap on simultaneous voices, panned or not. */
  maxVoices?: number;
}

export interface PlaySpec {
  kind: NoiseKind;
  /** §3 ARRIVAL level at the listener. Not source loudness. */
  level: number;
  /** World position to pan at. For cross-module sound this MUST be the port
   *  (`ListenerResolution.panPosition`). Null plays non-spatially. */
  position?: Vec3 | null;
  /** Any closed or sealed hatch on the path → 400 Hz lowpass (§8). */
  occluded?: boolean;
  bus?: BusName;
  /** m/s, for 'catch', 'impact' and a hard 'landing'. */
  speed?: number;
  /** 0–1, for 'breathing', 'tracker-beep' urgency and hide-spot haste. */
  intensity?: number;
  /** Which gait a 'footstep' or a soft 'landing' was made in (§4). */
  gait?: Gait;
  /**
   * Play THIS instead of the sound `kind` maps to.
   *
   * For the three §4 transitions that emit no NoiseEvent at all — `launch`,
   * `settle`, `liftoff` — there is no row of the §3 table to name, and there
   * must not be: "zero loudness means emit no event". `kind` still classifies
   * the voice for throttling and stealing; this decides what it sounds like.
   */
  source?: SynthSource;
  /** Run as a continuous source; caller must `stop()` it. */
  sustain?: boolean;
  /** Multiplier on the reverb send. 0 leaves the sound bone dry. */
  reverb?: number;
  /** Bypass the level mapping entirely (self noise uses this). */
  gain?: number;
  /** Deterministic variation. */
  seed?: number;
  /** Delay in seconds before the sound starts. */
  delay?: number;
}

export interface PlayingSound {
  readonly kind: NoiseKind;
  readonly bus: BusName;
  readonly level: number;
  readonly ended: boolean;
  /** Re-drive gain, position and occlusion from a fresh propagation result.
   *  Everything ramps — §8 forbids stepping. */
  update(patch: { level?: number; position?: Vec3 | null; occluded?: boolean }): void;
  stop(fadeSeconds?: number): void;
}

const DEFAULT_MAX_VOICES = 48;
const DEFAULT_REVERB_SEND = 0.55;
/** Reverb send while the listener is boxed into a hide spot (§4). */
const ENCLOSED_REVERB_SEND = 0.18;

type TimerHandle = ReturnType<typeof setTimeout>;

class Voice implements PlayingSound {
  readonly kind: NoiseKind;
  readonly bus: BusName;

  private readonly engine: AudioEngine;
  private readonly ctx: AudioContext;
  private readonly gainNode: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly send: GainNode | null;
  private readonly handle: SynthHandle;
  private readonly destination: AudioNode;
  private readonly sustained: boolean;

  private lease: PannerLease | null = null;
  private stereo: StereoPannerNode | null = null;
  private position: Vec3 | null;
  private timer: TimerHandle | null = null;
  /** True while the filter feeds the bus directly, with nothing in between. */
  private direct = false;

  private _level: number;
  private _occluded: boolean;
  private _ended = false;
  /** ctx time this voice's tail is done, or Infinity while sustained. */
  endTime: number;

  constructor(engine: AudioEngine, spec: PlaySpec) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.kind = spec.kind;
    this.bus = spec.bus ?? 'world';
    this.sustained = spec.sustain ?? false;
    this._level = spec.level;
    this._occluded = spec.occluded ?? false;
    this.position = spec.position ?? null;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const when = now + Math.max(spec.delay ?? 0, 0);

    this.gainNode = ctx.createGain();
    setNow(this.gainNode.gain, spec.gain ?? engine.gainForLevel(spec.level), now);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.7;
    setNow(this.filter.frequency, occlusionCutoffHz(this._occluded), now);

    this.gainNode.connect(this.filter);
    this.destination = engine.buses.bus(this.bus);

    // Spatial voices go through a pooled panner; everything else straight to
    // its bus. Self noise, the tracker and UI are deliberately non-spatial —
    // they are in your helmet, not in the room.
    if (this.position && this.bus === 'world') {
      this.attachSpatial();
    } else {
      this.filter.connect(this.destination);
      this.direct = true;
    }

    // Reverb: the listener's own module colours everything it hears (§8).
    const sendAmount = (spec.reverb ?? 1) * DEFAULT_REVERB_SEND;
    if (sendAmount > 0 && this.bus !== 'tracker') {
      this.send = ctx.createGain();
      setNow(this.send.gain, sendAmount, now);
      this.filter.connect(this.send);
      this.send.connect(engine.reverb.input);
    } else {
      this.send = null;
    }

    const synthOptions = {
      ...(spec.speed !== undefined ? { speed: spec.speed } : {}),
      ...(spec.intensity !== undefined ? { intensity: spec.intensity } : {}),
      ...(spec.gait !== undefined ? { gait: spec.gait } : {}),
      ...(spec.seed !== undefined ? { seed: spec.seed } : {}),
      sustain: this.sustained,
    };
    this.handle = spec.source
      ? spec.source(ctx, this.gainNode, when, synthOptions)
      : synthesize(ctx, this.gainNode, spec.kind, when, synthOptions);

    if (this.sustained || !Number.isFinite(this.handle.duration)) {
      this.endTime = Number.POSITIVE_INFINITY;
    } else {
      this.endTime = when + this.handle.duration + 0.05;
      const ms = (this.endTime - now) * 1000;
      this.timer = setTimeout(() => this.dispose(), Math.max(ms, 20));
    }
  }

  /** Drop the straight-to-bus path before inserting a panner into the chain,
   *  or the sound plays twice — once panned and once dry. */
  private clearDirect(): void {
    if (!this.direct) return;
    try {
      this.filter.disconnect(this.destination);
    } catch {
      /* not connected */
    }
    this.direct = false;
  }

  private attachSpatial(): void {
    this.clearDirect();
    const lease = this.engine.leasePanner(this._level);
    if (lease) {
      this.lease = lease;
      this.filter.connect(lease.node);
      lease.node.connect(this.destination);
      this.applyPosition(this.ctx.currentTime, true);
      return;
    }
    // Pool exhausted and nothing quieter to demote: fall back to cheap stereo.
    // Direction survives, the head model does not. Better than dropping it.
    this.attachStereo();
  }

  private attachStereo(): void {
    if (this.stereo) return;
    this.clearDirect();
    this.stereo = this.ctx.createStereoPanner();
    this.filter.connect(this.stereo);
    this.stereo.connect(this.destination);
    this.applyPosition(this.ctx.currentTime, true);
  }

  /** Give up the HRTF panner without stopping: used for voice stealing. */
  demote(): void {
    if (!this.lease) return;
    try {
      this.filter.disconnect(this.lease.node);
    } catch {
      /* not connected */
    }
    this.lease.release();
    this.lease = null;
    if (!this._ended) this.attachStereo();
  }

  private applyPosition(when: number, immediate = false): void {
    if (!this.position) return;
    if (this.lease) {
      setPannerPosition(
        this.lease.node,
        this.position.x,
        this.position.y,
        this.position.z,
        when,
        immediate ? 0.001 : 0.03,
      );
    } else if (this.stereo) {
      const pan = this.engine.stereoPanFor(this.position);
      if (immediate) setNow(this.stereo.pan, pan, when);
      else ramp(this.stereo.pan, pan, when, 0.05);
    }
  }

  update(patch: { level?: number; position?: Vec3 | null; occluded?: boolean }): void {
    if (this._ended) return;
    const now = this.ctx.currentTime;
    if (patch.level !== undefined && patch.level !== this._level) {
      this._level = patch.level;
      ramp(this.gainNode.gain, this.engine.gainForLevel(patch.level), now);
    }
    if (patch.occluded !== undefined && patch.occluded !== this._occluded) {
      this._occluded = patch.occluded;
      // §8: ramp the filter. A stepped cutoff clicks on every hatch cycle.
      ramp(this.filter.frequency, occlusionCutoffHz(patch.occluded), now, RAMP_TAU);
    }
    if (patch.position !== undefined) {
      this.position = patch.position;
      if (this.position && !this.lease && !this.stereo && this.bus === 'world') this.attachSpatial();
      this.applyPosition(now);
    }
  }

  stop(fadeSeconds = 0.08): void {
    if (this._ended) return;
    const now = this.ctx.currentTime;
    ramp(this.gainNode.gain, 0, now, Math.max(fadeSeconds / 3, 0.005));
    this.handle.stop(now, fadeSeconds);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dispose(), (fadeSeconds + 0.1) * 1000);
    this.endTime = now + fadeSeconds + 0.1;
  }

  get level(): number {
    return this._level;
  }

  get ended(): boolean {
    return this._ended;
  }

  /** Only the engine's voice-stealing policy cares. */
  get hasPanner(): boolean {
    return this.lease !== null;
  }

  dispose(): void {
    if (this._ended) return;
    this._ended = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.lease?.release();
    this.lease = null;
    for (const node of [this.gainNode, this.filter, this.send, this.stereo]) {
      if (!node) continue;
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.stereo = null;
    this.engine.retire(this);
  }
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly buses: AudioBuses;
  readonly panners: PannerPool;
  readonly reverb: ReverbRack;

  private readonly levelMap: LevelMapping;
  private readonly maxVoices: number;
  private readonly voices = new Set<Voice>();
  /** Voices past their end time, collected by `update()` before disposal so the
   *  set is not mutated while it is being walked. Reused every tick. */
  private readonly expiredScratch: Voice[] = [];

  private listenerPos: Vec3 = v3();
  private listenerForward: Vec3 = v3(0, 0, -1);
  private listenerUp: Vec3 = v3(0, 1, 0);
  private listenerRight: Vec3 = v3(1, 0, 0);
  private unlockTeardown: Unsubscribe | null = null;

  constructor(opts: AudioEngineOptions = {}) {
    this.ctx = opts.context ?? new AudioContext({ latencyHint: 'interactive' });
    this.buses = new AudioBuses(this.ctx, opts.buses ?? {});
    this.panners = new PannerPool(this.ctx, opts.pannerCapacity ?? 24);
    this.reverb = new ReverbRack(this.ctx, this.buses.world);
    this.levelMap = opts.levels ?? {};
    this.maxVoices = opts.maxVoices ?? DEFAULT_MAX_VOICES;
  }

  get time(): number {
    return this.ctx.currentTime;
  }

  get state(): AudioContextState {
    return this.ctx.state;
  }

  get voiceCount(): number {
    return this.voices.size;
  }

  /** Browsers start the context suspended. Call from a real user gesture. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn('[audio] resume failed:', err);
      }
    }
  }

  /**
   * Resume on the first pointer or key event. The menu is up before a round
   * starts (§6), so in practice the context is running long before it matters.
   */
  attachUnlock(target: EventTarget = window): Unsubscribe {
    this.unlockTeardown?.();
    const unlock = (): void => {
      void this.resume();
    };
    const events = ['pointerdown', 'keydown', 'touchend'];
    for (const name of events) target.addEventListener(name, unlock, { once: false, passive: true });
    const teardown = (): void => {
      for (const name of events) target.removeEventListener(name, unlock);
    };
    this.unlockTeardown = teardown;
    return teardown;
  }

  // -----------------------------------------------------------------------
  // Listener
  // -----------------------------------------------------------------------

  /** Drive from the camera every frame. `forward`/`up` are world-space. */
  setListener(pos: Vec3, forward?: Vec3, up?: Vec3): void {
    this.listenerPos = pos;
    if (forward) this.listenerForward = forward;
    if (up) this.listenerUp = up;
    this.listenerRight = normalize(cross(this.listenerForward, this.listenerUp));

    const listener = this.ctx.listener as AudioListener & {
      positionX?: AudioParam;
      positionY?: AudioParam;
      positionZ?: AudioParam;
      forwardX?: AudioParam;
      forwardY?: AudioParam;
      forwardZ?: AudioParam;
      upX?: AudioParam;
      upY?: AudioParam;
      upZ?: AudioParam;
    };
    const now = this.ctx.currentTime;
    if (listener.positionX && listener.forwardX && listener.upX) {
      const tau = 0.015;
      listener.positionX.setTargetAtTime(pos.x, now, tau);
      listener.positionY?.setTargetAtTime(pos.y, now, tau);
      listener.positionZ?.setTargetAtTime(pos.z, now, tau);
      listener.forwardX.setTargetAtTime(this.listenerForward.x, now, tau);
      listener.forwardY?.setTargetAtTime(this.listenerForward.y, now, tau);
      listener.forwardZ?.setTargetAtTime(this.listenerForward.z, now, tau);
      listener.upX.setTargetAtTime(this.listenerUp.x, now, tau);
      listener.upY?.setTargetAtTime(this.listenerUp.y, now, tau);
      listener.upZ?.setTargetAtTime(this.listenerUp.z, now, tau);
      return;
    }
    const legacy = this.ctx.listener as unknown as {
      setPosition?: (x: number, y: number, z: number) => void;
      setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
    };
    legacy.setPosition?.(pos.x, pos.y, pos.z);
    legacy.setOrientation?.(
      this.listenerForward.x,
      this.listenerForward.y,
      this.listenerForward.z,
      this.listenerUp.x,
      this.listenerUp.y,
      this.listenerUp.z,
    );
  }

  /** Which acoustic space the listener is standing in (§2 kind + volume). */
  setListenerModule(kind: ModuleKind, volume?: number): void {
    this.reverb.setModule(kind, volume);
  }

  /** Current listener position, for systems that do their own distance maths. */
  get listenerPosition(): Vec3 {
    return this.listenerPos;
  }

  /** -1..1 pan for the fallback path when the HRTF pool is exhausted. */
  stereoPanFor(position: Vec3): number {
    const delta = sub(position, this.listenerPos);
    const lenSq = delta.x * delta.x + delta.y * delta.y + delta.z * delta.z;
    if (lenSq < 1e-6) return 0;
    const dir = normalize(delta);
    const pan = dir.x * this.listenerRight.x + dir.y * this.listenerRight.y + dir.z * this.listenerRight.z;
    return Math.max(-1, Math.min(1, pan));
  }

  // -----------------------------------------------------------------------
  // Playback
  // -----------------------------------------------------------------------

  gainForLevel(level: number): number {
    return levelToGain(level, this.levelMap);
  }

  /**
   * Play one sound. Returns null when it would be inaudible, so callers never
   * have to special-case the floor.
   */
  play(spec: PlaySpec): PlayingSound | null {
    if (spec.gain === undefined && this.gainForLevel(spec.level) <= 0) return null;
    if (this.voices.size >= this.maxVoices) {
      const victim = this.quietest();
      if (!victim || victim.level >= spec.level) return null;
      victim.stop(0.03);
    }
    const voice = new Voice(this, spec);
    this.voices.add(voice);
    return voice;
  }

  /** §8: the alien hunting ducks the world and swells the sub-bass bed. */
  setHunt(active: boolean): void {
    this.buses.setHunt(active);
  }

  /**
   * §4: the listener is inside a hide spot.
   *
   * The world goes behind §8's occlusion lowpass and your own body comes
   * forward — and the room's reverb comes almost all the way off, because the
   * space you are in stopped being the module and became a metal box the size
   * of you. `ReverbRack` renders the listener's own space (§8), so leaving the
   * module's tail on while you sit in a locker is the one thing that would give
   * the whole effect away.
   */
  setEnclosed(active: boolean): void {
    if (active === this.buses.isEnclosed) return;
    this.buses.setEnclosed(active);
    this.reverb.setSendLevel(active ? ENCLOSED_REVERB_SEND : 1);
  }

  get enclosed(): boolean {
    return this.buses.isEnclosed;
  }

  setMasterVolume(value: number): void {
    this.buses.setMasterVolume(value);
  }

  /**
   * Called by voices. Hands out a panner, stealing from a quieter spatial voice
   * when the pool is full — a rail pull three modules away gives up its head
   * model before a hatch cycle next door does.
   */
  leasePanner(level: number): PannerLease | null {
    const lease = this.panners.acquire(this.buses.world);
    if (lease) return lease;
    const victim = this.quietestPanned();
    if (victim && victim.level < level) {
      victim.demote();
      return this.panners.acquire(this.buses.world);
    }
    return null;
  }

  retire(voice: Voice): void {
    this.voices.delete(voice);
  }

  /**
   * Housekeeping. Timers do the real work, but a backgrounded tab throttles
   * them, so sweep once a frame too.
   */
  update(): void {
    if (this.voices.size === 0) return;
    const now = this.ctx.currentTime;
    // Collect first, dispose second — `dispose()` calls `retire()`, which
    // deletes from the set we are walking. `[...this.voices]` did the same job
    // by minting an array on every tick a sound was playing; this one is ours.
    const expired = this.expiredScratch;
    expired.length = 0;
    for (const voice of this.voices) {
      if (voice.endTime < now) expired.push(voice);
    }
    for (let i = 0; i < expired.length; i++) expired[i].dispose();
    expired.length = 0;
  }

  /** Stop everything — round end, or the results screen. */
  stopAll(fadeSeconds = 0.12): void {
    for (const voice of [...this.voices]) voice.stop(fadeSeconds);
  }

  dispose(): void {
    this.unlockTeardown?.();
    this.unlockTeardown = null;
    for (const voice of [...this.voices]) voice.dispose();
    this.voices.clear();
    this.reverb.dispose();
    this.panners.dispose();
    this.buses.dispose();
    void this.ctx.close().catch(() => undefined);
  }

  private quietest(): Voice | null {
    let best: Voice | null = null;
    for (const voice of this.voices) {
      if (!best || voice.level < best.level) best = voice;
    }
    return best;
  }

  private quietestPanned(): Voice | null {
    let best: Voice | null = null;
    for (const voice of this.voices) {
      if (!voice.hasPanner) continue;
      if (!best || voice.level < best.level) best = voice;
    }
    return best;
  }
}

