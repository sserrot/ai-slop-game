/**
 * Comfort options — DESIGN.md §4: "Motion sickness comfort options ship in M0,
 * not as a later pass: roll-lock (fixed horizon), snap-turn, FOV slider, and a
 * vignette that tightens with angular velocity." §13 lists motion sickness as a
 * risk that costs you players.
 *
 * `ComfortOptions` is the shared/networked shape (@shared/types). This module
 * extends it with the four dials a mouse-and-keyboard build also needs, and adds
 * change notification so a settings menu can bind straight to it.
 */

import type { ComfortOptions } from '@shared/types';
import {
  FLASHLIGHT_SCALE_DEFAULT,
  FLASHLIGHT_SCALE_MAX,
  FLASHLIGHT_SCALE_MIN,
  clamp,
} from '@shared/constants';
import { halfLifeDecay } from '../core/ticker';
import {
  DEFAULT_FOV_DEGREES,
  MOUSE_SENSITIVITY,
  VIGNETTE_ATTACK_HALFLIFE,
  VIGNETTE_MAX_ANGULAR_SPEED,
  VIGNETTE_PULSE_HALFLIFE_S,
  VIGNETTE_RELEASE_HALFLIFE,
} from './tuning';

/** The shared four, plus the desktop-input dials. */
export interface PlayerComfortOptions extends ComfortOptions {
  /** Radians of rotation per pixel of raw mouse movement. */
  mouseSensitivity: number;
  /** Flip vertical look. */
  invertY: boolean;
  /**
   * Quantise MOUSE yaw into snap steps as well as the arrow keys. Off by
   * default — stepping a mouse feels broken to players who are not sensitive to
   * smooth turning, and the arrow keys already give the sensitive ones a
   * snap-only option.
   */
  snapTurnAppliesToMouse: boolean;
  /** rad/s of angular velocity at which the vignette reaches full strength. */
  vignetteMaxAngularSpeed: number;
}

export const DEFAULT_COMFORT: Readonly<PlayerComfortOptions> = Object.freeze({
  // §4 — a fixed horizon is the single biggest comfort win, and since the
  // walking pivot it is also the TRUTH in most of the station: a module with a
  // floor is locked to the horizon whatever this says (see
  // `PlayerCamera.setFloorLock`). The option still governs the `zero` modules,
  // where a fixed horizon is a comfort lie the player may want anyway.
  rollLock: false,
  /** 0 = smooth turning. */
  snapTurnDegrees: 0,
  fovDegrees: DEFAULT_FOV_DEGREES,
  /** 0 = off, 1 = full. On by default at a modest strength. */
  vignetteStrength: 0.6,
  /**
   * §4 — 1 is the authored 4.5 cm bob, 0 turns it off outright. On by default
   * because it is most of what makes walking read as walking, and one click
   * from off because a bob one player reads as atmosphere another reads as
   * nausea. It NEVER changes emitted noise (see `Player.emitFootstep`): an
   * accessibility dial that altered what the alien hears would be a competitive
   * one, and would break the mental model pillar 3 protects for exactly the
   * player who most needs it intact.
   */
  headBob: 1,
  // The torch is the renderer's, not the controller's — this field only rides
  // along so one saved `ComfortOptions` blob covers every dial the panel shows.
  flashlightIntensity: FLASHLIGHT_SCALE_DEFAULT,
  mouseSensitivity: MOUSE_SENSITIVITY,
  invertY: false,
  snapTurnAppliesToMouse: false,
  vignetteMaxAngularSpeed: VIGNETTE_MAX_ANGULAR_SPEED,
});

export type ComfortListener = (options: Readonly<PlayerComfortOptions>) => void;

/** Live comfort settings. Mutate through `set()` so listeners (camera FOV, the
 *  render layer's vignette pass) hear about it. */
export class PlayerComfort {
  private readonly _options: PlayerComfortOptions;
  private readonly listeners = new Set<ComfortListener>();

  constructor(initial: Partial<PlayerComfortOptions> = {}) {
    this._options = { ...DEFAULT_COMFORT, ...initial };
    this.sanitise();
  }

  get options(): Readonly<PlayerComfortOptions> {
    return this._options;
  }

  get rollLock(): boolean {
    return this._options.rollLock;
  }

  get snapTurnDegrees(): number {
    return this._options.snapTurnDegrees;
  }

  /** Snap step in radians; 0 when snap turning is off. */
  get snapTurnRadians(): number {
    return (this._options.snapTurnDegrees * Math.PI) / 180;
  }

  get fovDegrees(): number {
    return this._options.fovDegrees;
  }

  get vignetteStrength(): number {
    return this._options.vignetteStrength;
  }

  /** 0 = no head bob, 1 = the authored `BOB_AMPLITUDE_M`. */
  get headBob(): number {
    return this._options.headBob;
  }

  get mouseSensitivity(): number {
    return this._options.mouseSensitivity;
  }

  get invertY(): boolean {
    return this._options.invertY;
  }

  set(patch: Partial<PlayerComfortOptions>): void {
    Object.assign(this._options, patch);
    this.sanitise();
    for (const fn of this.listeners) fn(this._options);
  }

  /** Convenience for a checkbox. */
  toggleRollLock(): boolean {
    this.set({ rollLock: !this._options.rollLock });
    return this._options.rollLock;
  }

  onChange(fn: ComfortListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The networked subset, for a lobby that shares comfort presets. */
  toShared(): ComfortOptions {
    const o = this._options;
    return {
      rollLock: o.rollLock,
      snapTurnDegrees: o.snapTurnDegrees,
      fovDegrees: o.fovDegrees,
      vignetteStrength: o.vignetteStrength,
      flashlightIntensity: o.flashlightIntensity,
      headBob: o.headBob,
    };
  }

  private sanitise(): void {
    const o = this._options;
    o.fovDegrees = clamp(o.fovDegrees, 50, 110);
    o.vignetteStrength = clamp(o.vignetteStrength, 0, 1);
    o.snapTurnDegrees = clamp(o.snapTurnDegrees, 0, 90);
    o.headBob = clamp(o.headBob, 0, 1);
    o.flashlightIntensity = clamp(
      o.flashlightIntensity,
      FLASHLIGHT_SCALE_MIN,
      FLASHLIGHT_SCALE_MAX,
    );
    o.mouseSensitivity = clamp(o.mouseSensitivity, 0.0002, 0.02);
    o.vignetteMaxAngularSpeed = Math.max(0.2, o.vignetteMaxAngularSpeed);
  }
}

/**
 * The §4 vignette: it tightens with angular velocity. Fast attack, slow release,
 * so a flick darkens instantly and opens back up without strobing.
 *
 * Output is 0–1 already scaled by `vignetteStrength` — hand it straight to the
 * post pass (§9).
 */
export class VignetteMeter {
  private _value = 0;
  private _pulse = 0;

  get value(): number {
    return this._value;
  }

  reset(): void {
    this._value = 0;
    this._pulse = 0;
  }

  /**
   * A one-off punch on top of the angular-velocity term — the §4 `liftoff`.
   *
   * The floor failing under you is a set-piece and has to read as one, but it
   * may NOT be sold with a camera the player does not control: that is nausea,
   * and reducing nausea is half the point of the walking pivot. So the tell is
   * the effect the comfort menu already owns and already scales, which means a
   * player who has turned the vignette off simply never receives it.
   */
  pulse(amount: number): void {
    this._pulse = Math.max(this._pulse, Math.max(0, amount));
  }

  update(dt: number, angularSpeed: number, comfort: PlayerComfort): number {
    const o = comfort.options;
    if (this._pulse > 0) {
      this._pulse *= halfLifeDecay(dt, VIGNETTE_PULSE_HALFLIFE_S);
      if (this._pulse < 1e-3) this._pulse = 0;
    }
    const drive = clamp(angularSpeed / o.vignetteMaxAngularSpeed + this._pulse, 0, 1);
    const target = drive * o.vignetteStrength;
    const halfLife = target > this._value ? VIGNETTE_ATTACK_HALFLIFE : VIGNETTE_RELEASE_HALFLIFE;
    const k = halfLifeDecay(dt, halfLife);
    this._value = target + (this._value - target) * k;
    if (this._value < 1e-4) this._value = 0;
    return this._value;
  }
}
