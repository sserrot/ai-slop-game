/**
 * src/render/flashlight.ts — the one shadow-casting light in the game (DESIGN.md §9).
 *
 * A SpotLight pinned to the camera with a 1024² shadow map. It is silent, so it
 * costs the player nothing against the alien (§3 has no entry for it) — but it is
 * the only thing holding the dark off, and it should feel like it.
 *
 * The beam LAGS the head slightly and carries a small hand-held bob. That lag is
 * the whole trick: a light rigidly parented to the camera reads as a screen
 * effect, while a light that arrives a moment after you turn reads as a torch in
 * a glove.
 *
 * BRIGHTNESS IS A TUNING CONSTANT, NOT A LOCAL CHOICE. Every default here comes
 * from `@shared/constants` (§14), including the sub-quadratic `FLASHLIGHT_DECAY`
 * that stops the beam blowing out a bulkhead you have floated up against. The
 * comment block next to those constants carries the measurements.
 */

import * as THREE from 'three';
import {
  FLASHLIGHT_ANGLE_DEG,
  FLASHLIGHT_COLOR,
  FLASHLIGHT_DECAY,
  FLASHLIGHT_INTENSITY,
  FLASHLIGHT_PENUMBRA,
  FLASHLIGHT_RANGE_M,
  FLASHLIGHT_SCALE_MAX,
  FLASHLIGHT_SCALE_MIN,
  SHADOW_MAP_SIZE,
  clamp,
} from '@shared/constants';
import { clamp01, decayFactor } from './util';

export interface FlashlightOptions {
  color?: THREE.ColorRepresentation;
  /** Candela at `decay`. Default `FLASHLIGHT_INTENSITY`. */
  intensity?: number;
  /** Range in metres. Default `FLASHLIGHT_RANGE_M`. Also sets the shadow throw. */
  distance?: number;
  /** Distance falloff exponent. Default `FLASHLIGHT_DECAY` (deliberately < 2). */
  decay?: number;
  /** Cone half-angle in degrees. Default `FLASHLIGHT_ANGLE_DEG`. */
  angleDegrees?: number;
  /** 0–1 soft edge. Default `FLASHLIGHT_PENUMBRA`. */
  penumbra?: number;
  /** Shadow map edge in texels. Default `SHADOW_MAP_SIZE` (1024). */
  shadowMapSize?: number;
  /** Body offset in camera space (right, up, forward). Default slightly right and down. */
  offset?: { x: number; y: number; z: number };
  /** Seconds for the beam to halve its angular error behind the head. Default 0.055. */
  swayHalfLife?: number;
  /** Bob amplitude in radians at full motion. Default 0.016. */
  swayAmplitude?: number;
  /** Start switched on. Default true. */
  on?: boolean;
  /** Player brightness trim, 0.4–1.8. Default 1. */
  intensityScale?: number;
}

const FORWARD = new THREE.Vector3(0, 0, -1);

export class Flashlight {
  readonly light: THREE.SpotLight;

  private readonly scene: THREE.Scene;
  private camera: THREE.Camera;
  private readonly offset: THREE.Vector3;
  private readonly swayHalfLife: number;
  private readonly swayAmplitude: number;
  private readonly baseIntensity: number;
  private scale: number;

  private readonly camPos = new THREE.Vector3();
  private readonly camQuat = new THREE.Quaternion();
  private readonly swayQuat = new THREE.Quaternion();
  private readonly bobQuat = new THREE.Quaternion();
  private readonly bobEuler = new THREE.Euler();
  private readonly dir = new THREE.Vector3();
  private readonly worldOffset = new THREE.Vector3();

  private time = 0;
  private motion = 0;
  private enabled: boolean;
  private shadowsEnabled = true;
  private initialised = false;

  constructor(scene: THREE.Scene, camera: THREE.Camera, opts: FlashlightOptions = {}) {
    this.scene = scene;
    this.camera = camera;
    this.offset = new THREE.Vector3(
      opts.offset?.x ?? 0.14,
      opts.offset?.y ?? -0.1,
      opts.offset?.z ?? 0.02,
    );
    this.swayHalfLife = opts.swayHalfLife ?? 0.055;
    this.swayAmplitude = opts.swayAmplitude ?? 0.016;
    this.baseIntensity = opts.intensity ?? FLASHLIGHT_INTENSITY;
    this.scale = clamp(opts.intensityScale ?? 1, FLASHLIGHT_SCALE_MIN, FLASHLIGHT_SCALE_MAX);
    this.enabled = opts.on ?? true;

    const distance = opts.distance ?? FLASHLIGHT_RANGE_M;

    this.light = new THREE.SpotLight(
      opts.color ?? FLASHLIGHT_COLOR,
      0, // set by applyIntensity() below, so the on/off/scale rule lives in one place
      distance,
      THREE.MathUtils.degToRad(opts.angleDegrees ?? FLASHLIGHT_ANGLE_DEG),
      opts.penumbra ?? FLASHLIGHT_PENUMBRA,
      opts.decay ?? FLASHLIGHT_DECAY,
    );
    this.light.name = 'flashlight';
    this.light.visible = this.enabled;
    this.light.castShadow = true;
    this.applyIntensity();

    const size = opts.shadowMapSize ?? SHADOW_MAP_SIZE;
    this.light.shadow.mapSize.set(size, size);
    this.light.shadow.camera.near = 0.15;
    // Cosmetic: `SpotLightShadow.updateMatrices` overwrites this with
    // `light.distance` on every frame the light is enabled, so the beam range
    // IS the shadow range. Kept in sync here so the value is never misleading
    // to anything that reads it before the first render.
    this.light.shadow.camera.far = distance;
    this.light.shadow.bias = -0.0006;
    this.light.shadow.normalBias = 0.02;
    this.light.shadow.focus = 1;

    scene.add(this.light);
    scene.add(this.light.target);
  }

  /** Swap the camera the torch is carried by (spectator cameras, §10). */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
    this.initialised = false;
  }

  get on(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.light.visible = on;
    this.applyIntensity();
  }

  /** Returns the new state, so the caller can drive a UI hint. */
  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /** 0–1 movement intensity, from the player controller's speed. Drives bob. */
  setMotion(intensity01: number): void {
    this.motion = clamp01(intensity01);
  }

  /**
   * Player brightness trim (a settings slider, §4's comfort screen is the
   * natural home). Clamped to `FLASHLIGHT_SCALE_MIN…MAX` so nobody can turn the
   * torch into a floodlight again, or into nothing at all and then report the
   * game as broken. Survives toggling the light off and on.
   */
  setIntensityScale(scale: number): void {
    this.scale = clamp(scale, FLASHLIGHT_SCALE_MIN, FLASHLIGHT_SCALE_MAX);
    this.applyIntensity();
  }

  get intensityScale(): number {
    return this.scale;
  }

  /** Candela the light is actually running at, or 0 while switched off. */
  get intensity(): number {
    return this.light.intensity;
  }

  setShadowsEnabled(enabled: boolean): void {
    this.shadowsEnabled = enabled;
    this.light.castShadow = enabled;
  }

  /** Quality guard: resize the shadow map, freeing the old one. */
  setShadowMapSize(size: number): void {
    const s = Math.max(64, Math.round(size));
    if (this.light.shadow.mapSize.width === s && this.light.shadow.mapSize.height === s) return;
    this.light.shadow.mapSize.set(s, s);
    const map = this.light.shadow.map;
    if (map) {
      map.dispose();
      this.light.shadow.map = null;
    }
    this.light.shadow.needsUpdate = true;
  }

  get shadowsOn(): boolean {
    return this.shadowsEnabled;
  }

  /** Beam range in metres — and, because three insists, the shadow throw too. */
  get range(): number {
    return this.light.distance;
  }

  setRange(metres: number): void {
    const d = Math.max(1, metres);
    this.light.distance = d;
    this.light.shadow.camera.far = d;
  }

  /** Follow the camera, with lag and bob. Call once per rendered frame. */
  update(dt: number): void {
    if (!this.enabled) return;

    this.camera.updateMatrixWorld();
    this.camera.getWorldPosition(this.camPos);
    this.camera.getWorldQuaternion(this.camQuat);

    if (!this.initialised) {
      this.swayQuat.copy(this.camQuat);
      this.initialised = true;
    } else {
      // slerp by the fraction of the error we consume this frame
      const k = 1 - decayFactor(dt, this.swayHalfLife);
      this.swayQuat.slerp(this.camQuat, k <= 0 ? 0 : k >= 1 ? 1 : k);
    }

    this.time += dt;
    const amp = this.swayAmplitude * (0.3 + 0.7 * this.motion);
    this.bobEuler.set(
      Math.sin(this.time * 1.37 + 1.1) * amp * 0.7,
      Math.sin(this.time * 2.11) * amp,
      0,
      'YXZ',
    );
    this.bobQuat.setFromEuler(this.bobEuler);

    // The body rides the head exactly; only the beam lags.
    this.worldOffset.copy(this.offset).applyQuaternion(this.camQuat);
    this.light.position.copy(this.camPos).add(this.worldOffset);

    this.dir.copy(FORWARD).applyQuaternion(this.swayQuat).applyQuaternion(this.bobQuat);
    this.light.target.position.copy(this.light.position).addScaledVector(this.dir, 10);
    this.light.target.updateMatrixWorld();
  }

  dispose(): void {
    this.scene.remove(this.light);
    this.scene.remove(this.light.target);
    this.light.dispose();
  }

  private applyIntensity(): void {
    this.light.intensity = this.enabled ? this.baseIntensity * this.scale : 0;
  }
}
