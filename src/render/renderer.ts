/**
 * src/render/renderer.ts — DESIGN.md §9, "Rendering budget". Target 60 fps on a
 * mid-range laptop.
 *
 * The renderer owns: the WebGLRenderer, colour management and tone mapping, the
 * light budget (one shadow-casting flashlight + three shadowless module lights +
 * ambient), the exponential fog, the post chain, and the frame-rate guard.
 *
 * It owns NOTHING about the game. It never imports player/, alien/, station/ or
 * net/, and it subscribes to no event bus. Everything it reacts to arrives
 * through setters or the optional `RenderFrameInput` on `update()`:
 *
 *   renderer.setModules(cullSet.map(...))     // station
 *   renderer.setPlayerModule(moduleId)        // station / player
 *   renderer.setAngularVelocity(radPerSec)    // player controller (comfort, §4)
 *   renderer.setAlienState('HUNT')            // alien FSM (§5)
 *   renderer.setDirectorStage(stage)          // escalation director (§5)
 *   renderer.update(frameDt)                  // renders the frame
 */

import * as THREE from 'three';
import type { AlienState, ComfortOptions, DirectorStage, LightingLevel, ModuleId } from '@shared/types';
import { FLASHLIGHT_SCALE_DEFAULT, MAX_REALTIME_LIGHTS, clamp } from '@shared/constants';
import { Flashlight } from './flashlight';
import type { FlashlightOptions } from './flashlight';
import { DEFAULT_FOG_VISIBILITY_M, LightingRig } from './lighting';
import { PostChain } from './postFx';
import { FrameGuard, QUALITY_PROFILES, pixelRatioFor, qualityFromIndex, qualityIndex } from './quality';
import { applyShadowPolicy } from './shadowPolicy';
import type { ShadowPolicyOptions, ShadowPolicyStats } from './shadowPolicy';
import type {
  ModuleLightingInput,
  PrewarmStats,
  QualityChange,
  QualityChangeReason,
  QualityLevel,
  QualityProfile,
  RenderFrameInput,
  RenderStats,
  RendererOptions,
} from './types';
import { clamp01, damp, dampAsym } from './util';

/** Red-alert wash, multiplied into the frame. */
const ALERT_TINT = { r: 1.0, g: 0.58, b: 0.52 };

const DEFAULT_COMFORT: ComfortOptions = {
  rollLock: true,
  snapTurnDegrees: 0,
  fovDegrees: 75,
  vignetteStrength: 1,
  flashlightIntensity: FLASHLIGHT_SCALE_DEFAULT,
  // §4's authored 4.5 cm bob. The renderer never reads it — the camera does —
  // but `ComfortOptions` is one object and this is its fallback shape.
  headBob: 1,
};

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly lighting: LightingRig;
  readonly flashlight: Flashlight;
  readonly post: PostChain;
  readonly frameGuard: FrameGuard;

  private camera: THREE.PerspectiveCamera;
  private readonly container: HTMLElement;
  private readonly ownsCanvas: boolean;

  private profile: QualityProfile;
  private qualityCeiling: QualityLevel;
  private postActive: boolean;

  private readonly comfort: ComfortOptions = { ...DEFAULT_COMFORT };
  private readonly options: Required<
    Pick<
      RendererOptions,
      | 'vignetteFullRadPerSec'
      | 'baseVignetteStrength'
      | 'baseVignetteRadius'
      | 'comfortVignetteInLowQuality'
    >
  > & { autoRedAlertStage: number | null };

  private angularVelocity = 0;
  private angularSmoothed = 0;
  private huntTarget = 0;
  private huntSmoothed = 0;
  private motion = 0;
  private stage: DirectorStage = 0;
  private redAlertManual = false;

  private width = 1;
  private height = 1;
  private lastFrameTime = 0;
  private readonly cameraWorldPos = new THREE.Vector3();
  private readonly clearColor = new THREE.Color();

  private resizeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.resize();
  private disposed = false;

  private shadowPolicy: ShadowPolicyOptions | null = {};
  private lastShadowStats: ShadowPolicyStats | null = null;

  /** Told whenever the effective quality level moves. See {@link onQualityChange}. */
  private qualityListener: ((change: QualityChange) => void) | null = null;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, options: RendererOptions = {}) {
    this.scene = scene;
    this.camera = camera;

    this.options = {
      vignetteFullRadPerSec: options.vignetteFullRadPerSec ?? 2.6,
      baseVignetteStrength: options.baseVignetteStrength ?? 0.42,
      baseVignetteRadius: options.baseVignetteRadius ?? 0.6,
      comfortVignetteInLowQuality: options.comfortVignetteInLowQuality ?? true,
      autoRedAlertStage: options.autoRedAlertStage === undefined ? 4 : options.autoRedAlertStage,
    };

    this.container =
      options.container ??
      (typeof document !== 'undefined'
        ? (document.getElementById('app') as HTMLElement | null) ?? document.body
        : (null as unknown as HTMLElement));

    this.qualityCeiling = options.quality ?? 'high';
    this.profile = QUALITY_PROFILES[this.qualityCeiling];
    this.qualityListener = options.onQualityChange ?? null;

    const canvas = options.canvas;
    this.ownsCanvas = canvas === undefined;
    this.three = new THREE.WebGLRenderer({
      canvas,
      // MSAA lives on the composer's render target (see QualityProfile.msaaSamples);
      // the default framebuffer is only used by the low-quality direct path.
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
    });
    if (this.ownsCanvas && this.container) {
      this.container.appendChild(this.three.domElement);
    }

    // Colour management for a very dark game: linear working space, ACES filmic,
    // a touch of exposure. Black stays black; the grade pass lifts the very
    // bottom by ~0.6% so near-black detail survives a cheap laptop panel.
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = options.exposure ?? 1.15;
    this.three.shadowMap.enabled = true;
    // three r185 deprecated PCFSoftShadowMap and silently downgrades it, which
    // logs a warning on every boot. One shadow map at 1024² (§9) is soft enough.
    this.three.shadowMap.type = THREE.PCFShadowMap;
    this.three.shadowMap.autoUpdate = true;
    this.three.autoClear = true;
    // The composer issues several render() calls per frame; auto-reset would leave
    // `info.render` describing only the last full-screen quad. We reset per frame.
    this.three.info.autoReset = false;

    this.measure();
    this.three.setPixelRatio(this.pixelRatio());
    this.three.setSize(this.width, this.height, false);

    this.lighting = new LightingRig(scene, {
      fogVisibilityMetres: options.fogVisibilityMetres ?? DEFAULT_FOG_VISIBILITY_M,
    });
    this.clearColor.copy(this.lighting.clearColor);
    this.three.setClearColor(this.clearColor, 1);

    const flashlightOpts: FlashlightOptions = {
      shadowMapSize: this.profile.shadowMapSize,
      on: options.flashlightOn ?? true,
    };
    this.flashlight = new Flashlight(scene, camera, flashlightOpts);

    this.post = new PostChain(this.three, scene, camera, this.width, this.height, this.pixelRatio(), {
      msaaSamples: this.profile.msaaSamples,
      bloomScale: this.profile.bloomScale,
    });
    this.post.configure(this.profile, this.width, this.height, this.pixelRatio());
    this.postActive = this.wantsPost();

    this.frameGuard = new FrameGuard();
    // Defaults ON: a machine that cannot hold 60 fps should drop quality rather
    // than stutter at `high` forever. Pass `autoQuality: false` to pin quality
    // — which is what a benchmark wants, and nothing else does.
    this.frameGuard.enabled = options.autoQuality ?? true;

    this.camera.aspect = this.width / this.height;
    this.camera.fov = this.comfort.fovDegrees;
    this.camera.updateProjectionMatrix();

    if ((options.autoResize ?? true) && typeof window !== 'undefined') {
      window.addEventListener('resize', this.onWindowResize);
      if (typeof ResizeObserver !== 'undefined' && this.container) {
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.container);
      }
    }
  }

  // ---------------------------------------------------------------- frame ---

  /**
   * Advance every render-side animation and draw the frame.
   *
   * `dt` is the real frame delta in seconds (the ticker's render callback gives
   * it to you). Call this once per rendered frame — it is the only call that
   * draws. Remote-player interpolation belongs to the caller, not here.
   */
  update(dt: number, input?: RenderFrameInput): void {
    if (this.disposed) return;

    if (input) {
      if (input.angularVelocity !== undefined) this.setAngularVelocity(input.angularVelocity);
      if (input.motion !== undefined) this.setMotion(input.motion);
      if (input.alienState !== undefined) this.setAlienState(input.alienState);
      if (input.huntIntensity !== undefined) this.setHuntIntensity(input.huntIntensity);
    }

    // Measure the real frame time ourselves: the caller may legitimately pass a
    // fixed dt, and the guard must never be fooled by that.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const frameSeconds = this.lastFrameTime > 0 ? (now - this.lastFrameTime) / 1000 : dt;
    this.lastFrameTime = now;

    const suggestion = this.frameGuard.sample(frameSeconds);
    if (suggestion !== 0) this.stepQuality(suggestion);

    const step = Math.max(0, Math.min(dt, 0.25));

    // Comfort vignette (§4): angular velocity in, tightening tunnel out.
    this.angularSmoothed = damp(this.angularSmoothed, this.angularVelocity, 0.12, step);
    // HUNT response (§5): snaps on, bleeds off.
    this.huntSmoothed = dampAsym(this.huntSmoothed, this.huntTarget, 0.25, 0.9, step);

    // Do this before anything reads the camera's world transform: three only
    // refreshes it inside render(), which would leave the lights a frame behind.
    this.camera.updateMatrixWorld();

    this.flashlight.setMotion(this.motion);
    this.flashlight.update(step);

    this.camera.getWorldPosition(this.cameraWorldPos);
    this.lighting.setHunt(this.huntSmoothed);
    this.lighting.update(step, this.cameraWorldPos);

    if (!this.clearColor.equals(this.lighting.clearColor)) {
      this.clearColor.copy(this.lighting.clearColor);
      this.three.setClearColor(this.clearColor, 1);
    }

    this.three.info.reset();
    if (this.postActive) {
      this.updatePostUniforms();
      this.post.advance(step);
      this.post.render(step);
    } else {
      this.three.render(this.scene, this.camera);
    }
  }

  private updatePostUniforms(): void {
    const motion01 =
      clamp01(this.angularSmoothed / this.options.vignetteFullRadPerSec) * clamp01(this.comfort.vignetteStrength);
    const hunt = this.huntSmoothed;

    const strength = clamp(this.options.baseVignetteStrength + 0.4 * motion01 + 0.16 * hunt, 0, 1);
    const radius = Math.max(0.18, this.options.baseVignetteRadius - 0.3 * motion01 - 0.16 * hunt);
    this.post.setVignette(strength, radius);

    // Subtle desaturation while it is hunting — the colour drains, nothing more.
    this.post.setDesaturate(0.5 * hunt);
    this.post.setAberration(this.profile.aberration * (1 + 1.2 * hunt));

    const alert = this.lighting.alert;
    this.post.setTint(ALERT_TINT.r, ALERT_TINT.g, ALERT_TINT.b, 0.35 * alert);
  }

  // ---------------------------------------------------------------- inputs ---

  /** Camera angular velocity in rad/s (§4 comfort vignette). */
  setAngularVelocity(radiansPerSecond: number): void {
    this.angularVelocity = Math.abs(radiansPerSecond);
  }

  /** 0–1 movement intensity; drives the flashlight bob only. */
  setMotion(intensity01: number): void {
    this.motion = clamp01(intensity01);
  }

  /** Alien FSM state (§5). HUNT and ATTACK raise the hunt response. */
  setAlienState(state: AlienState): void {
    this.huntTarget = state === 'HUNT' || state === 'ATTACK' ? 1 : 0;
  }

  /** Explicit 0–1 hunt response, if you would rather blend it yourself. */
  setHuntIntensity(intensity01: number): void {
    this.huntTarget = clamp01(intensity01);
  }

  /**
   * Comfort options (§4). `fovDegrees`, `vignetteStrength` and
   * `flashlightIntensity` concern the renderer.
   *
   * The torch trim is applied HERE rather than left to the caller: this is the
   * one funnel every comfort change already goes through (the settings panel
   * fires it once at construction with the persisted set, and again on every
   * edit), so wiring it here is what makes a saved brightness actually survive
   * a reload instead of depending on a second call nobody remembers to make.
   */
  setComfort(options: Partial<ComfortOptions>): void {
    Object.assign(this.comfort, options);
    if (options.fovDegrees !== undefined) {
      this.camera.fov = clamp(options.fovDegrees, 50, 110);
      this.camera.updateProjectionMatrix();
    }
    if (options.flashlightIntensity !== undefined) {
      this.setFlashlightIntensity(options.flashlightIntensity);
    }
    const wanted = this.wantsPost();
    if (wanted !== this.postActive) this.postActive = wanted;
  }

  getComfort(): ComfortOptions {
    return { ...this.comfort };
  }

  /**
   * Candidate modules to light — normally the two-hop cull set (§2).
   *
   * Also the beat on which the shadow-caster policy is re-applied: the cull set
   * only changes when a player swims through a hatch, and it is the one moment
   * the renderer is told that the contents of the scene may have moved. See
   * {@link refreshShadowPolicy}.
   */
  setModules(modules: readonly ModuleLightingInput[]): void {
    this.lighting.setModules(modules);
    if (this.shadowPolicy) this.refreshShadowPolicy();
  }

  /**
   * Re-run the §9 shadow-caster policy over the scene (see `./shadowPolicy`).
   * Keeps light strips, unlit screens and anything flagged `userData.noShadow`
   * out of the one 1024² shadow map, and undoes a blanket
   * `traverse(o => o.castShadow = true)` that ran somewhere else. Cheap: one
   * traverse of a scene that is ~150 meshes, on module transitions only.
   */
  refreshShadowPolicy(): ShadowPolicyStats {
    this.lastShadowStats = applyShadowPolicy(this.scene, this.shadowPolicy ?? {});
    return this.lastShadowStats;
  }

  /**
   * Replace the shadow-caster policy, or pass `null` to stop enforcing one (the
   * flags then belong entirely to whoever set them last).
   */
  setShadowPolicy(options: ShadowPolicyOptions | null): void {
    this.shadowPolicy = options;
    if (options) this.refreshShadowPolicy();
  }

  /** What the last policy pass decided. Handy for a debug overlay. */
  get shadowStats(): ShadowPolicyStats | null {
    return this.lastShadowStats;
  }

  /** One module's lighting level changed (a breaker, a lost system). */
  setModuleLighting(id: ModuleId, lighting: LightingLevel): void {
    this.lighting.setModuleLighting(id, lighting);
  }

  /** The module the local player is in; it always gets a light. */
  setPlayerModule(id: ModuleId | null): void {
    this.lighting.setPlayerModule(id);
  }

  /** Escalation stage (§5). At `autoRedAlertStage` (default 4) red alert raises itself. */
  setDirectorStage(stage: DirectorStage): void {
    this.stage = stage;
    const auto = this.options.autoRedAlertStage;
    const wanted = this.redAlertManual || (auto !== null && stage >= auto);
    this.lighting.setRedAlert(wanted);
  }

  getDirectorStage(): DirectorStage {
    return this.stage;
  }

  /** Force red alert on or off, independent of the stage. */
  setRedAlert(on: boolean): void {
    this.redAlertManual = on;
    const auto = this.options.autoRedAlertStage;
    this.lighting.setRedAlert(on || (auto !== null && this.stage >= auto));
  }

  setExposure(exposure: number): void {
    this.three.toneMappingExposure = Math.max(0.05, exposure);
  }

  /** Display-space contrast/lift, for taste passes. Defaults 1.04 / 0.006. */
  setGrade(contrast: number, lift: number): void {
    this.post.setGrade(contrast, lift);
  }

  setFlashlight(on: boolean): void {
    this.flashlight.setEnabled(on);
  }

  /** Returns the new state. It is silent — there is no NoiseEvent for it (§3). */
  toggleFlashlight(): boolean {
    return this.flashlight.toggle();
  }

  /**
   * Player brightness trim on the torch, as a multiplier on §14's
   * `FLASHLIGHT_INTENSITY`. Clamped to `FLASHLIGHT_SCALE_MIN…MAX` inside the
   * light, so a settings slider can hand this straight through. This is the
   * hook a "flashlight brightness" row in the comfort panel (§4) wants.
   */
  setFlashlightIntensity(scale: number): void {
    this.flashlight.setIntensityScale(scale);
  }

  get flashlightIntensity(): number {
    return this.flashlight.intensityScale;
  }

  /**
   * Ambient fill (§9 "cheap ambient"). One knob, on the rig that also dims it
   * while the alien hunts — if the scene needs lifting, lift it here rather
   * than adding a second AmbientLight somewhere else, which is invisible to the
   * hunt response and to the quality profiles alike.
   */
  setAmbientIntensity(intensity: number): void {
    this.lighting.setAmbientIntensity(intensity);
  }

  /** Metres at which the world is invisible; §2 wants hop three gone. */
  setFogVisibility(metres: number, residual?: number): void {
    this.lighting.setFogVisibility(metres, residual);
  }

  /**
   * Swap the rendered camera (spectator module cameras, §10). The flashlight
   * follows it, so hand it a camera that should be carrying a torch.
   */
  setCamera(camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
    this.flashlight.setCamera(camera);
    this.post.setCamera(camera);
    camera.aspect = this.width / Math.max(1, this.height);
    camera.fov = this.comfort.fovDegrees;
    camera.updateProjectionMatrix();
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /**
   * Pay every first-draw cost up front, while the menu is still up.
   *
   * Measured before this existed: floating through the nine modules for the
   * first time produced hitches of 77.5 / 13.1 / 10.9 / 7.6 ms, and a second
   * pass over the identical route ran at 0.61 ms mean / 7.2 ms max. Nothing was
   * slow — everything was simply being created the first time it was seen.
   * Three separate lazy costs stack up on that first pass:
   *
   *  1. shader programs link on first draw (~20 ms each, 27 of them),
   *  2. textures upload on first draw,
   *  3. geometry buffers upload on first draw (`info.memory.geometries` climbs
   *     from 31 to 81 as you tour the station).
   *
   * `compileAsync` covers 1 and 2. It does NOT upload vertex data, so we also
   * need one real draw — with culling defeated, or the renderer skips exactly
   * the geometry we are trying to warm. Post-processing shaders only exist once
   * the composer has run, so the warm frame goes through the full `update()`
   * path rather than a bare `render()`.
   */
  async prewarm(): Promise<PrewarmStats> {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const before = this.resourceCounts();

    // Everything visible and frustum-culling off, so one draw touches all of it.
    const visibility: Array<[THREE.Object3D, boolean]> = [];
    const culling: Array<[THREE.Object3D, boolean]> = [];
    this.scene.traverse((object) => {
      visibility.push([object, object.visible]);
      object.visible = true;
      const drawable = object as Partial<THREE.Mesh>;
      if (drawable.isMesh || (object as Partial<THREE.Points>).isPoints) {
        culling.push([object, object.frustumCulled]);
        object.frustumCulled = false;
      }
    });

    try {
      await this.three.compileAsync(this.scene, this.camera);
      // One full-pipeline frame: uploads geometry buffers and links the post
      // chain's programs. dt is nominal — nothing here is time-dependent.
      this.update(1 / 60);
    } finally {
      for (const [object, was] of visibility) object.visible = was;
      for (const [object, was] of culling) object.frustumCulled = was;
    }

    const after = this.resourceCounts();
    return {
      milliseconds:
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt,
      programs: after.programs,
      geometries: after.geometries,
      textures: after.textures,
      programsCompiled: after.programs - before.programs,
      geometriesUploaded: after.geometries - before.geometries,
      texturesUploaded: after.textures - before.textures,
    };
  }

  private resourceCounts(): { programs: number; geometries: number; textures: number } {
    const info = this.three.info;
    return {
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  // --------------------------------------------------------------- quality ---

  get quality(): QualityLevel {
    return this.profile.level;
  }

  /** Player-chosen level. Also becomes the ceiling the auto guard may return to. */
  setQuality(level: QualityLevel): void {
    this.qualityCeiling = level;
    this.applyQuality(level, 'manual');
    // A hand-picked level is the player overruling everything the guard has
    // learned, including which upgrades it has already given up on.
    this.frameGuard.forgetBackoff();
    this.frameGuard.reset();
  }

  /**
   * Subscribe to quality changes — pass `null` to stop.
   *
   * This is the hook a "Graphics: high / medium / low (auto)" row in the
   * comfort panel (§4) wants. Without it an automatic drop is invisible: the
   * player sees the game get uglier, cannot tell why, and has no way back short
   * of a reload.
   */
  onQualityChange(listener: ((change: QualityChange) => void) | null): void {
    this.qualityListener = listener;
  }

  /** Player-chosen ceiling — the highest level the guard may climb back to. */
  get qualityCeilingLevel(): QualityLevel {
    return this.qualityCeiling;
  }

  /** Automatic frame-rate guard: drops quality when frames get long (§9). */
  setAutoQuality(enabled: boolean): void {
    this.frameGuard.enabled = enabled;
    this.frameGuard.reset();
  }

  get autoQuality(): boolean {
    return this.frameGuard.enabled;
  }

  get stats(): RenderStats {
    const ratio = this.three.getPixelRatio();
    return {
      fps: this.frameGuard.fps,
      frameMs: this.frameGuard.frameMs,
      drawCalls: this.three.info.render.calls,
      triangles: this.three.info.render.triangles,
      quality: this.profile.level,
      post: this.postActive,
      postPasses: this.postActive ? this.post.passCount : 0,
      lights: this.lighting.lights.length + (this.flashlight.on ? 1 : 0),
      shadowMapSize: this.flashlight.shadowsOn ? this.flashlight.light.shadow.mapSize.width : 0,
      renderPixels: Math.round(this.width * ratio) * Math.round(this.height * ratio),
      pixelRatio: ratio,
      msaaSamples: this.postActive ? this.post.msaaSamples : 0,
    };
  }

  private stepQuality(direction: number): void {
    const ceiling = qualityIndex(this.qualityCeiling);
    const next = Math.min(ceiling, Math.max(0, qualityIndex(this.profile.level) + direction));
    const level = qualityFromIndex(next);
    if (level !== this.profile.level) this.applyQuality(level, 'auto');
  }

  private applyQuality(level: QualityLevel, reason: QualityChangeReason): void {
    const previous = this.profile.level;
    const profile = QUALITY_PROFILES[level];
    this.profile = profile;

    // The shadow filter no longer changes with quality (r185 deprecated the
    // soft variant), so the shader-define traverse that used to go with it is
    // gone too — one less one-frame hitch on an auto-quality step.

    const ratio = this.pixelRatio();
    this.flashlight.setShadowMapSize(profile.shadowMapSize);
    this.three.setPixelRatio(ratio);
    this.three.setSize(this.width, this.height, false);
    // ONE call, not applyProfile() + setSize(): those reallocated the composer's
    // half-float targets twice on a step that changes both samples and ratio,
    // and every reallocation is a frame the player feels.
    this.post.configure(profile, this.width, this.height, ratio);
    this.postActive = this.wantsPost();

    if (previous !== level && this.qualityListener) {
      this.qualityListener({
        level,
        previous,
        reason,
        ceiling: this.qualityCeiling,
        fps: this.frameGuard.fps,
      });
    }
  }

  /**
   * Post is on unless quality is `low` — and even then we keep a minimal chain
   * when the player is relying on the comfort vignette (§4 ships comfort options
   * in M0; losing them because the machine is slow is the wrong trade).
   */
  private wantsPost(): boolean {
    if (this.profile.post) return true;
    return this.options.comfortVignetteInLowQuality && this.comfort.vignetteStrength > 0;
  }

  // ---------------------------------------------------------------- resize ---

  /** Resize to explicit dimensions, or re-measure the container. */
  resize(width?: number, height?: number): void {
    if (this.disposed) return;
    const wasWidth = this.width;
    const wasHeight = this.height;
    if (width !== undefined && height !== undefined) {
      this.width = Math.max(1, Math.round(width));
      this.height = Math.max(1, Math.round(height));
    } else {
      this.measure();
    }
    // A ResizeObserver fires for changes that are not changes. Reallocating
    // half-float targets for a no-op is a hitch bought with nothing — but the
    // ratio has to be re-checked even when the CSS size is identical, because
    // dragging the window to a monitor with a different scale factor changes
    // `devicePixelRatio` and nothing else.
    const ratio = this.pixelRatio();
    if (this.width === wasWidth && this.height === wasHeight && ratio === this.three.getPixelRatio()) {
      return;
    }

    this.three.setPixelRatio(ratio);
    this.three.setSize(this.width, this.height, false);
    this.post.setSize(this.width, this.height, ratio);

    this.camera.aspect = this.width / Math.max(1, this.height);
    this.camera.updateProjectionMatrix();

    // The reallocation above IS a long frame. Judging quality on it would drop
    // a level every time the player dragged a window edge.
    this.frameGuard.reset();
  }

  private measure(): void {
    const el = this.container;
    let w = 0;
    let h = 0;
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      w = el.clientWidth;
      h = el.clientHeight;
    } else if (typeof window !== 'undefined') {
      w = window.innerWidth;
      h = window.innerHeight;
    }
    this.width = Math.max(1, Math.round(w || 1280));
    this.height = Math.max(1, Math.round(h || 720));
  }

  /**
   * The pixel ratio to render at — a PIXEL BUDGET, not just a ratio ceiling.
   *
   * `Math.min(devicePixelRatio, maxPixelRatio)` was the whole rule, and it is
   * not a budget: at `high`'s ceiling of 2 a 4K window asks for 33 Mpx, and at
   * the reported player's devicePixelRatio of 1.5 a maximised window on a
   * 1440p-at-150% display is already 3.4 Mpx. Measured on an RTX 3080, quality
   * `high`, GPU p50 per frame: 2.3 Mpx → 1.2 ms, 4.1 Mpx → 1.5 ms,
   * **5.2 Mpx → 106 ms**, 8.3 Mpx → 320 ms. The cost of a frame has to be
   * bounded by the window, not by an assumption about the monitor.
   */
  private pixelRatio(): number {
    const device = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return pixelRatioFor(this.profile, this.width, this.height, device);
  }

  // --------------------------------------------------------------- teardown ---

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onWindowResize);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.post.dispose();
    this.flashlight.dispose();
    this.lighting.dispose();
    this.three.dispose();

    if (this.ownsCanvas && this.three.domElement.parentElement) {
      this.three.domElement.parentElement.removeChild(this.three.domElement);
    }
  }
}

/** §9's hard budget, re-exported so callers can assert against it. */
export const REALTIME_LIGHT_BUDGET = MAX_REALTIME_LIGHTS;
