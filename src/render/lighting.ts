/**
 * src/render/lighting.ts — emergency lighting, red alert and the fog (DESIGN.md §9).
 *
 * The budget is hard: MAX 4 real-time lights, exactly one of which casts a shadow
 * (the flashlight, owned by `./flashlight`). This rig therefore owns at most
 * `MAX_REALTIME_LIGHTS - 1` shadowless point lights and hands them to whichever
 * modules are nearest the camera, plus one cheap AmbientLight.
 *
 * Nothing here imports the station subsystem: the caller passes the modules it
 * already computed for the two-hop cull, as `ModuleLightingInput[]`.
 */

import * as THREE from 'three';
import type { LightingLevel, ModuleId } from '@shared/types';
import { AMBIENT_INTENSITY, CULL_HOPS, MAX_REALTIME_LIGHTS, clamp } from '@shared/constants';
import type { ModuleLightingInput } from './types';
import { clamp01, damp, flicker01, lerp } from './util';

/** Punctual lights this rig may own. The flashlight takes the remaining slot. */
export const MODULE_LIGHT_BUDGET = Math.max(0, MAX_REALTIME_LIGHTS - 1);

interface LevelPreset {
  /** sRGB hex. */
  readonly color: number;
  /** three candela-ish intensity at `decay = 2`. */
  readonly intensity: number;
  /** Cutoff distance in metres. */
  readonly distance: number;
  /** 0–1 flicker depth. */
  readonly flicker: number;
}

const PRESETS: Readonly<Record<LightingLevel, LevelPreset>> = Object.freeze({
  nominal: Object.freeze({ color: 0xbfd6dd, intensity: 9.0, distance: 14, flicker: 0.02 }),
  emergency: Object.freeze({ color: 0xff5a28, intensity: 2.6, distance: 10, flicker: 0.14 }),
  dark: Object.freeze({ color: 0x1a2630, intensity: 0.0, distance: 6, flicker: 0.0 }),
});

/** Red alert overrides colour and pulses; §5's director raises it. */
const ALERT_PRESET: LevelPreset = Object.freeze({
  color: 0xff1d12,
  intensity: 3.6,
  distance: 12,
  flicker: 0.05,
});

const FOG_COLOR_BASE = 0x05070b;
const FOG_COLOR_ALERT = 0x140406;
const AMBIENT_COLOR_BASE = 0x1b2836;
const AMBIENT_COLOR_ALERT = 0x2a0d10;

/**
 * Solve exponential fog for "effectively invisible at `metres`".
 *
 * `FogExp2` keeps `exp(-(density * z)^2)` of the surface colour, so
 * `density = sqrt(-ln(residual)) / metres`. §2 wants hop three invisible, which
 * is what makes the portal cull undetectable.
 */
export function fogDensityForVisibility(metres: number, residual = 0.05): number {
  const d = Math.max(0.5, metres);
  const r = clamp(residual, 1e-4, 0.9);
  return Math.sqrt(-Math.log(r)) / d;
}

/** Default: three hops of 5 m tube (§2 culls at two hops, §14 CULL_HOPS = 2). */
export const DEFAULT_FOG_VISIBILITY_M = (CULL_HOPS + 1) * 5;

export interface LightingRigOptions {
  /** Point lights to allocate. Clamped to the §9 budget. Default 3. */
  moduleLightCount?: number;
  /** Metres at which the world is invisible. Default 15. */
  fogVisibilityMetres?: number;
  /** Ambient fill intensity. Default 0.30 — enough to keep black from crushing. */
  ambientIntensity?: number;
  /** Global multiplier on module light intensity. Default 1. */
  masterIntensity?: number;
}

interface LightSlot {
  readonly light: THREE.PointLight;
  moduleId: ModuleId | null;
  level: LightingLevel;
  intensity: number;
  phase: number;
}

interface ModuleRecord {
  id: ModuleId;
  centre: THREE.Vector3;
  lighting: LightingLevel;
}

/**
 * Emergency lighting rig. Call {@link setModules} whenever the visible set
 * changes, {@link setPlayerModule} on `player:module`, and {@link update} once a
 * frame with the camera's world position.
 */
export class LightingRig {
  readonly ambient: THREE.AmbientLight;
  readonly fog: THREE.FogExp2;
  readonly lights: readonly THREE.PointLight[];

  private readonly scene: THREE.Scene;
  private readonly slots: LightSlot[] = [];
  private readonly modules: ModuleRecord[] = [];
  private readonly scratch: ModuleRecord[] = [];

  private playerModule: ModuleId | null = null;
  private masterIntensity: number;
  private ambientBase: number;

  private alertTarget = 0;
  private alertLevel = 0;
  private huntTarget = 0;
  private huntLevel = 0;

  private time = 0;
  private sinceAssign = 1;

  private readonly ambientColorBase = new THREE.Color(AMBIENT_COLOR_BASE);
  private readonly ambientColorAlert = new THREE.Color(AMBIENT_COLOR_ALERT);
  private readonly fogColorBase = new THREE.Color(FOG_COLOR_BASE);
  private readonly fogColorAlert = new THREE.Color(FOG_COLOR_ALERT);
  private readonly tmpColor = new THREE.Color();
  private readonly alertColor = new THREE.Color(ALERT_PRESET.color);

  constructor(scene: THREE.Scene, opts: LightingRigOptions = {}) {
    this.scene = scene;
    this.masterIntensity = opts.masterIntensity ?? 1;
    this.ambientBase = opts.ambientIntensity ?? AMBIENT_INTENSITY;

    const count = Math.round(clamp(opts.moduleLightCount ?? MODULE_LIGHT_BUDGET, 0, MODULE_LIGHT_BUDGET));

    const lights: THREE.PointLight[] = [];
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(PRESETS.emergency.color, 0, PRESETS.emergency.distance, 2);
      light.castShadow = false; // §9: exactly one shadow map, and it is the flashlight
      light.name = `module-light-${i}`;
      light.visible = false;
      scene.add(light);
      lights.push(light);
      this.slots.push({ light, moduleId: null, level: 'dark', intensity: 0, phase: i * 2.7 });
    }
    this.lights = lights;

    this.ambient = new THREE.AmbientLight(this.ambientColorBase.getHex(), this.ambientBase);
    this.ambient.name = 'station-ambient';
    scene.add(this.ambient);

    this.fog = new THREE.FogExp2(
      this.fogColorBase.getHex(),
      fogDensityForVisibility(opts.fogVisibilityMetres ?? DEFAULT_FOG_VISIBILITY_M),
    );
    scene.fog = this.fog;
  }

  /** The colour the renderer should clear to, so the void matches the fog. */
  get clearColor(): THREE.Color {
    return this.fog.color;
  }

  /** 0–1 red-alert blend, for the post chain's tint. */
  get alert(): number {
    return this.alertLevel;
  }

  /**
   * Candidate modules to light — normally the two-hop cull set. Records are
   * copied, so the caller may reuse its array.
   */
  setModules(modules: readonly ModuleLightingInput[]): void {
    this.modules.length = 0;
    for (const m of modules) {
      this.modules.push({
        id: m.id,
        centre: new THREE.Vector3(m.centre.x, m.centre.y, m.centre.z),
        lighting: m.lighting,
      });
    }
    this.sinceAssign = 1; // force a reassignment on the next update
  }

  /** Update one module's lighting level in place (breaker thrown, power lost). */
  setModuleLighting(id: ModuleId, lighting: LightingLevel): void {
    for (const m of this.modules) {
      if (m.id === id) {
        m.lighting = lighting;
        this.sinceAssign = 1;
        return;
      }
    }
  }

  /** The module the local player is in; it always gets the first light. */
  setPlayerModule(id: ModuleId | null): void {
    if (this.playerModule === id) return;
    this.playerModule = id;
    this.sinceAssign = 1;
  }

  /** Red alert, raised by the escalation director (§5). Blends over ~0.4 s. */
  setRedAlert(on: boolean): void {
    this.alertTarget = on ? 1 : 0;
  }

  get redAlert(): boolean {
    return this.alertTarget > 0.5;
  }

  /** 0–1 HUNT response — the station dims a little while it is coming (§5). */
  setHunt(intensity01: number): void {
    this.huntTarget = clamp01(intensity01);
  }

  setAmbientIntensity(intensity: number): void {
    this.ambientBase = Math.max(0, intensity);
  }

  setMasterIntensity(scale: number): void {
    this.masterIntensity = Math.max(0, scale);
  }

  setFogVisibility(metres: number, residual = 0.05): void {
    this.fog.density = fogDensityForVisibility(metres, residual);
  }

  setFogDensity(density: number): void {
    this.fog.density = Math.max(0, density);
  }

  /** Advance flicker, alert pulse and light assignment. */
  update(dt: number, cameraPos: THREE.Vector3): void {
    this.time += dt;
    this.alertLevel = damp(this.alertLevel, this.alertTarget, 0.35, dt);
    this.huntLevel = damp(this.huntLevel, this.huntTarget, 0.5, dt);

    this.sinceAssign += dt;
    if (this.sinceAssign >= 0.125) {
      this.sinceAssign = 0;
      this.assign(cameraPos);
    }

    const alert = this.alertLevel;
    const pulse = alert > 0.001 ? 0.7 + 0.3 * Math.sin(this.time * 3.9) : 1;

    for (const slot of this.slots) {
      const preset = PRESETS[slot.level];
      let target = preset.intensity;
      let distance = preset.distance;
      let flickerDepth = preset.flicker;

      if (slot.moduleId === null || preset.intensity <= 0) {
        target = 0;
      } else if (alert > 0.001) {
        target = lerp(target, ALERT_PRESET.intensity * pulse, alert);
        distance = lerp(distance, ALERT_PRESET.distance, alert);
        flickerDepth = lerp(flickerDepth, ALERT_PRESET.flicker, alert);
      }

      if (target > 0 && flickerDepth > 0) {
        const f = flicker01(this.time * 6.3 + slot.phase);
        target *= 1 - flickerDepth * f;
      }

      // Progress makes the station brighter; the alien coming makes it feel dimmer.
      target *= this.masterIntensity * (1 - 0.25 * this.huntLevel);

      slot.intensity = damp(slot.intensity, target, 0.18, dt);
      slot.light.intensity = slot.intensity;
      slot.light.distance = distance;
      slot.light.visible = slot.intensity > 0.002;

      if (alert > 0.001 && slot.moduleId !== null) {
        this.tmpColor.set(PRESETS[slot.level].color).lerp(this.alertColor, alert);
        slot.light.color.copy(this.tmpColor);
      } else if (slot.moduleId !== null) {
        slot.light.color.set(PRESETS[slot.level].color);
      }
    }

    this.ambient.intensity = this.ambientBase * (1 - 0.35 * this.huntLevel) * (1 + 0.25 * alert);
    this.tmpColor.copy(this.ambientColorBase).lerp(this.ambientColorAlert, alert);
    this.ambient.color.copy(this.tmpColor);

    this.tmpColor.copy(this.fogColorBase).lerp(this.fogColorAlert, alert);
    this.fog.color.copy(this.tmpColor);
  }

  dispose(): void {
    for (const slot of this.slots) {
      this.scene.remove(slot.light);
      slot.light.dispose();
    }
    this.slots.length = 0;
    this.scene.remove(this.ambient);
    if (this.scene.fog === this.fog) this.scene.fog = null;
  }

  /**
   * Hand the point lights to the nearest lit modules, player's module first.
   * Slots already holding a wanted module keep it, so lights do not shuffle
   * between modules every time the ordering wobbles.
   */
  private assign(cameraPos: THREE.Vector3): void {
    if (this.slots.length === 0) return;

    const wanted = this.scratch;
    wanted.length = 0;
    for (const m of this.modules) {
      if (PRESETS[m.lighting].intensity <= 0) continue; // a dark module stays dark
      wanted.push(m);
    }
    const player = this.playerModule;
    wanted.sort((a, b) => {
      if (a.id === player) return -1;
      if (b.id === player) return 1;
      return a.centre.distanceToSquared(cameraPos) - b.centre.distanceToSquared(cameraPos);
    });
    if (wanted.length > this.slots.length) wanted.length = this.slots.length;

    const taken = new Array<boolean>(wanted.length).fill(false);

    // Pass 1 — keep what is already correct.
    for (const slot of this.slots) {
      let keep = -1;
      for (let i = 0; i < wanted.length; i++) {
        if (!taken[i] && wanted[i].id === slot.moduleId) {
          keep = i;
          break;
        }
      }
      if (keep >= 0) {
        taken[keep] = true;
        slot.level = wanted[keep].lighting;
        slot.light.position.copy(wanted[keep].centre);
      } else {
        slot.moduleId = null;
      }
    }

    // Pass 2 — fill the freed slots, fading in from zero so nothing pops.
    for (let i = 0; i < wanted.length; i++) {
      if (taken[i]) continue;
      const slot = this.slots.find((s) => s.moduleId === null);
      if (!slot) break;
      taken[i] = true;
      slot.moduleId = wanted[i].id;
      slot.level = wanted[i].lighting;
      slot.light.position.copy(wanted[i].centre);
      slot.light.color.set(PRESETS[slot.level].color);
      slot.intensity = 0;
      slot.light.intensity = 0;
    }

    // Anything still unassigned goes dark.
    for (const slot of this.slots) {
      if (slot.moduleId === null) slot.level = 'dark';
    }
  }
}
