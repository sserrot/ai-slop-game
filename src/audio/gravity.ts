/**
 * Losing the floor, as a set-piece (DESIGN.md §4, §8).
 *
 * §4 is unusually specific about the order of events, and the order is the whole
 * fairness guarantee:
 *
 *   1. 2.5 seconds of warning (`GRAVITY_WARNING_S`). "The plant winds down
 *      audibly first. The floor never simply vanishes under anyone."
 *   2. A `gravity-shift` noise at 35, emitted AT THE MODULE CENTRE, not at any
 *      player — nobody caused it, so nobody is blamed for it.
 *   3. Everyone standing gets a `liftoff`.
 *
 * Step 1 is an AUDIO guarantee. It does not exist unless you can hear it, which
 * makes the warning the most load-bearing sound in this subsystem: 2.5 s is 6 m
 * at a sprint, more than a module length, and the only reason a director-
 * triggered failure reads as dramatic rather than cheap is that you were told.
 *
 * Step 2 arrives as an ordinary NoiseEvent from the server and needs nothing
 * from this file — §3 propagates it, `NoiseAudio` plays it, and §8 pans it at
 * the arrival port like everything else. Step 3 belongs to `LocomotionAudio`,
 * because it happens to a body rather than to a room.
 *
 * So this file owns exactly two things: the warning, and the fact that a module
 * without a floor SOUNDS different from one with a floor.
 *
 * THE WARNING IS NOT A NOISEEVENT. The alien does not hear the plant winding
 * down — it hears the failure, at 35, when it lands. That is deliberate: a
 * warning the alien reacted to would make the fair thing the dangerous thing.
 * But it is still resolved through the §3 graph before it is played, so it
 * attenuates with distance, muffles through a closed hatch, and pans at the
 * connecting port — a plant dying next door has to sound like it is next door.
 */

import { GRAVITY_WARNING_S, LOUDNESS } from '@shared/constants';
import type {
  GravityMode,
  GravityShiftEvent,
  ModuleGravitySnapshot,
  ModuleId,
  Vec3,
} from '@shared/types';

import type { NoiseRuntime } from '../noise/runtime';
import type { StationAmbience } from './ambience';
import type { AudioEngine, PlayingSound } from './engine';
import { gravityWarning } from './synth';

export interface GravityAudioOptions {
  /** Resolves the warning against the station graph (§3). Strongly recommended:
   *  without it the warning plays flat, at full level, from anywhere. */
  runtime?: NoiseRuntime | null;
  /** Retuned when the LISTENER's own module gains or loses its floor. */
  ambience?: StationAmbience | null;
  /** Seconds of warning. §14's `GRAVITY_WARNING_S`; override only for tests. */
  warningSeconds?: number;
}

interface Warning {
  module: ModuleId;
  centre: Vec3;
  sound: PlayingSound | null;
  remaining: number;
}

export class GravityAudio {
  private readonly engine: AudioEngine;
  private readonly runtime: NoiseRuntime | null;
  private readonly ambience: StationAmbience | null;
  private readonly warningSeconds: number;

  private readonly warnings = new Map<ModuleId, Warning>();
  /** Snapshot of `warnings` for `update()`, refilled rather than rebuilt. */
  private readonly warningScratch: Warning[] = [];
  private readonly modes = new Map<ModuleId, GravityMode>();
  private listenerModule: ModuleId | null = null;
  private seed = 4483;

  constructor(engine: AudioEngine, opts: GravityAudioOptions = {}) {
    this.engine = engine;
    this.runtime = opts.runtime ?? null;
    this.ambience = opts.ambience ?? null;
    this.warningSeconds = opts.warningSeconds ?? GRAVITY_WARNING_S;
  }

  // -----------------------------------------------------------------------
  // The 2.5 seconds before
  // -----------------------------------------------------------------------

  /**
   * The plant in `module` has started winding down.
   *
   * Call this the moment `scheduleGravity()` announces a shift — the announced
   * path is the only one anybody is meant to survive (§4), and this is the half
   * of it the player actually experiences. `centre` is the module centre, the
   * same point the 35-loudness failure will be emitted from.
   *
   * Re-announcing does not restart the sound, mirroring `scheduleGravity()`,
   * which does not extend a running timer.
   */
  warn(module: ModuleId, centre: Vec3, seconds = this.warningSeconds): PlayingSound | null {
    const existing = this.warnings.get(module);
    if (existing) return existing.sound;

    const span = Math.max(0.2, seconds);
    const warning: Warning = {
      module,
      centre: { ...centre },
      sound: null,
      remaining: span,
    };
    this.warnings.set(module, warning);

    const seed = this.next();
    const resolution = this.resolve(centre, module);
    // Inaudible from here — a plant three modules away behind two closed
    // hatches — is a legitimate outcome, not a failure. The timer still runs so
    // that `shift()` and `cancel()` stay symmetric.
    if (resolution === null) return null;

    warning.sound = this.engine.play({
      // Classified as the row the FAILURE will pay, so voice stealing treats a
      // dying plant with the weight the event deserves. It still emits nothing.
      kind: 'gravity-shift',
      level: resolution.level,
      position: resolution.position,
      occluded: resolution.occluded,
      bus: 'world',
      sustain: true,
      source: (ctx, dest, when) => gravityWarning(ctx, dest, when, span, seed),
      seed,
    });
    return warning.sound;
  }

  /** Drive from the fixed update: keeps a running warning panned and attenuated
   *  correctly as the listener moves, and retires it when its time is up. */
  update(dt: number): void {
    if (this.warnings.size === 0) return;
    // `stop()` deletes from `warnings`, so the pass collects first. The array is
    // ours and refilled, rather than `[...values()]` per tick while a §4
    // gravity warning is counting down.
    const live = this.warningScratch;
    live.length = 0;
    for (const warning of this.warnings.values()) live.push(warning);
    for (let wi = 0; wi < live.length; wi++) {
      const warning = live[wi];
      warning.remaining -= dt;
      if (warning.remaining <= 0) {
        this.stop(warning, 0.08);
        continue;
      }
      if (!warning.sound || warning.sound.ended) continue;
      const resolution = this.resolve(warning.centre, warning.module);
      if (resolution === null) {
        warning.sound.update({ level: 0 });
        continue;
      }
      warning.sound.update({
        level: resolution.level,
        position: resolution.position,
        occluded: resolution.occluded,
      });
    }
    live.length = 0;
  }

  /** The announced shift was cancelled before it landed (§11 can restore a
   *  module, and `cancelPendingGravity()` exists for exactly that). */
  cancel(module: ModuleId): void {
    const warning = this.warnings.get(module);
    if (warning) this.stop(warning, 0.25);
  }

  get warningModules(): ModuleId[] {
    return [...this.warnings.keys()];
  }

  // -----------------------------------------------------------------------
  // The shift itself
  // -----------------------------------------------------------------------

  /**
   * The shift landed.
   *
   * The bang is already on its way as a real NoiseEvent, so all that is left
   * here is to stop the warning and let the room take on its new character. If
   * it is the module you are standing in, the ambient bed changes under you —
   * the plant and its pump stop, the air handling does not — and that change is
   * what a `zero` module sounds like for as long as it stays one.
   */
  shift(event: Pick<GravityShiftEvent, 'module' | 'to'>): void {
    const warning = this.warnings.get(event.module);
    if (warning) this.stop(warning, 0.05);
    this.modes.set(event.module, event.to);
    this.applyAmbience();
  }

  /** Mirror a whole `StationState.gravity` array — room join, or a resync. */
  applySnapshot(snapshots: readonly ModuleGravitySnapshot[]): void {
    for (const snapshot of snapshots) this.modes.set(snapshot.module, snapshot.gravity);
    this.applyAmbience();
  }

  /** Where the ears are (§8). Drives which module's character you hear. */
  setListenerModule(module: ModuleId | null, gravity?: GravityMode): void {
    if (gravity !== undefined && module) this.modes.set(module, gravity);
    if (module === this.listenerModule && gravity === undefined) return;
    this.listenerModule = module;
    this.applyAmbience();
  }

  /** Gravity mode this layer believes a module is in. Unknown reads `nominal`,
   *  which is the pivot's default: a level that says nothing has floors. */
  modeOf(module: ModuleId): GravityMode {
    return this.modes.get(module) ?? 'nominal';
  }

  get listenerGravity(): GravityMode {
    return this.listenerModule ? this.modeOf(this.listenerModule) : 'nominal';
  }

  reset(): void {
    for (const warning of [...this.warnings.values()]) this.stop(warning, 0.05);
    this.modes.clear();
    this.applyAmbience();
  }

  dispose(): void {
    this.reset();
  }

  // -----------------------------------------------------------------------

  private applyAmbience(): void {
    this.ambience?.setGravity(this.listenerGravity);
  }

  private stop(warning: Warning, fade: number): void {
    warning.sound?.stop(fade);
    this.warnings.delete(warning.module);
  }

  /**
   * Run the warning through §3 exactly as if it were an event of the loudness
   * the failure will be. Without a runtime there is no graph to ask, so it
   * plays unpanned at source level — correct for an offline sandbox, wrong for
   * anything else, which is why `runtime` is worth passing.
   */
  private resolve(
    centre: Vec3,
    module: ModuleId,
  ): { level: number; position: Vec3 | null; occluded: boolean } | null {
    if (!this.runtime) {
      return { level: LOUDNESS.GRAVITY_SHIFT, position: null, occluded: false };
    }
    const resolution = this.runtime.resolveAt(centre, module, LOUDNESS.GRAVITY_SHIFT, 'gravity-shift');
    if (!resolution.audible) return null;
    // §8's single most important line: a sound from the next module comes out
    // of the port it arrived through, never through the bulkhead.
    return {
      level: resolution.level,
      position: resolution.panPosition,
      occluded: resolution.occluded,
    };
  }

  private next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed % 9973;
  }
}
