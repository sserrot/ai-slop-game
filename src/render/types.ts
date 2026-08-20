/**
 * src/render/types.ts — the render subsystem's public vocabulary (DESIGN.md §9).
 *
 * The renderer is deliberately decoupled: it never imports from player/, alien/,
 * station/ or net/. Everything it needs to know about the rest of the game arrives
 * through these narrow structures, passed in by the integrator.
 */

import type { AlienState, LightingLevel, ModuleId, Vec3 } from '@shared/types';

/** Frame-rate guard setting. `low` drops post-processing and shadow resolution. */
export type QualityLevel = 'low' | 'medium' | 'high';

/**
 * One module's lighting description, as the station subsystem already knows it.
 * `centre` is the module's WORLD-space centre (`ModuleGraph.centre(id)`).
 *
 * The renderer takes the list the culling system produced (player module plus two
 * hops) and lights the nearest few of them; see {@link LightingRig}.
 */
export interface ModuleLightingInput {
  id: ModuleId;
  centre: Vec3;
  lighting: LightingLevel;
}

/** Who moved the quality level. */
export type QualityChangeReason = 'auto' | 'manual';

/**
 * Reported whenever the effective quality level moves.
 *
 * The frame guard can drop quality by itself, and until this existed there was
 * NO way for the player to find out: `grep -n "quality" src/ui/*.ts` returned
 * nothing. A guard that silently leaves someone on `low` for the rest of the
 * session — no bloom, DPR 1, a 512² shadow map — and never tells them is a
 * worse bug than the slow frame that triggered it.
 */
export interface QualityChange {
  level: QualityLevel;
  previous: QualityLevel;
  reason: QualityChangeReason;
  /** Player-chosen ceiling; the auto guard never rises above it. */
  ceiling: QualityLevel;
  /** Smoothed fps at the moment of the change. */
  fps: number;
}

/** A resolved quality preset. See `QUALITY_PROFILES` in `./quality`. */
export interface QualityProfile {
  readonly level: QualityLevel;
  /** Run the EffectComposer chain at all. */
  readonly post: boolean;
  /** UnrealBloomPass enabled. */
  readonly bloom: boolean;
  /** Bloom internal render-target scale (1 = composer resolution). */
  readonly bloomScale: number;
  /** Film grain amplitude in display units (0 = off). */
  readonly grain: number;
  /** Chromatic aberration amount in UV units at the frame corner (0 = off). */
  readonly aberration: number;
  /** Flashlight shadow map edge length in texels. Applied by resizing the map
   *  and disposing the old one, not by leaving a bigger one allocated. */
  readonly shadowMapSize: number;
  /** Upper bound applied to `devicePixelRatio`. */
  readonly maxPixelRatio: number;
  /**
   * Lower bound on the pixel ratio, so `maxRenderPixels` can never blur the
   * picture below the size the page is actually laid out at. Only `low` sets
   * this under 1, and it says so.
   */
  readonly minPixelRatio: number;
  /**
   * Hard cap on drawing-buffer pixels (width × height × ratio²).
   *
   * A pixel-ratio ceiling alone is not a budget: `maxPixelRatio: 2` on a 4K
   * window is 33 Mpx. The renderer solves for the largest ratio that fits this
   * number, so the cost of a frame is bounded by the WINDOW rather than by an
   * assumption about how big the player's monitor is.
   */
  readonly maxRenderPixels: number;
  /**
   * MSAA samples requested on the composer's render target (0 = none).
   *
   * Requested, not guaranteed: `PostChain` refuses them above
   * `MSAA_MAX_PIXELS`, because a multisampled half-float target is the one
   * thing here with a capacity cliff rather than a slope (1.5 ms at 4.1 Mpx,
   * 106 ms at 5.2 Mpx).
   */
  readonly msaaSamples: number;
}

/** Cheap per-frame telemetry, for a debug overlay or the frame-rate guard UI. */
export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  quality: QualityLevel;
  post: boolean;
  /** `renderer.render()` calls the post chain issues per frame, 0 when direct.
   *  The honest answer to "did dropping quality actually drop post?" */
  postPasses: number;
  lights: number;
  /** Flashlight shadow map edge in texels — 0 when the shadow is off. */
  shadowMapSize: number;
  /** Drawing-buffer size actually being rendered, in pixels. */
  renderPixels: number;
  /** Pixel ratio in force, after the profile ceiling and the pixel budget. */
  pixelRatio: number;
  /** MSAA samples actually allocated, after the pixel gate. 0 when post is off. */
  msaaSamples: number;
}

/**
 * What `Renderer.prewarm()` actually paid for, so the cost is reportable
 * instead of guessed at. The `*Compiled` / `*Uploaded` counts are the work
 * that would otherwise have hitched the first minute of play.
 */
export interface PrewarmStats {
  /** Wall time the whole pre-warm took. */
  milliseconds: number;
  programs: number;
  geometries: number;
  textures: number;
  programsCompiled: number;
  geometriesUploaded: number;
  texturesUploaded: number;
}

/**
 * Optional per-frame inputs. Anything omitted keeps its previous value, so a
 * caller may either pass this object every frame or use the equivalent setters.
 */
export interface RenderFrameInput {
  /** Camera angular velocity in rad/s — drives the comfort vignette (§4). */
  angularVelocity?: number;
  /** 0–1 movement intensity — drives flashlight bob. */
  motion?: number;
  /** Alien FSM state; HUNT/ATTACK raise the hunt response (§5). */
  alienState?: AlienState;
  /** Explicit 0–1 hunt response override, if you would rather not pass a state. */
  huntIntensity?: number;
}

/** Construction options. Every field has a tuned default. */
export interface RendererOptions {
  /** Element the canvas is appended to. Defaults to `#app`, then `document.body`. */
  container?: HTMLElement | null;
  /** Use this canvas instead of creating one. */
  canvas?: HTMLCanvasElement;
  /** Starting quality ceiling. Default `'high'`. */
  quality?: QualityLevel;
  /** Enable the automatic frame-rate guard immediately. Default `false`. */
  autoQuality?: boolean;
  /** `toneMappingExposure`. Default 1.15. */
  exposure?: number;
  /** Watch the container for size changes. Default `true`. */
  autoResize?: boolean;
  /**
   * Distance in metres at which the world is effectively invisible. The
   * exponential fog is solved for this (§2: hop three must not be detectable).
   * Default `(CULL_HOPS + 1) * 5` = 15 m.
   */
  fogVisibilityMetres?: number;
  /** Angular velocity (rad/s) at which the comfort vignette is fully closed. Default 2.6. */
  vignetteFullRadPerSec?: number;
  /** Baseline artistic vignette strength, before comfort/hunt. Default 0.42. */
  baseVignetteStrength?: number;
  /** Baseline vignette start radius (0 = centre, 1 = corner). Default 0.60. */
  baseVignetteRadius?: number;
  /**
   * Keep a minimal composer chain (vignette only) even at `low` quality, so the
   * motion-comfort vignette never disappears on a weak machine. Default `true`.
   */
  comfortVignetteInLowQuality?: boolean;
  /** Director stage that automatically raises red alert. Default 4; `null` disables. */
  autoRedAlertStage?: number | null;
  /**
   * Called whenever the effective quality level moves, by the guard or by hand.
   * Wire this to the comfort panel (§4) so an automatic drop is visible and
   * reversible instead of permanent and invisible.
   */
  onQualityChange?: (change: QualityChange) => void;
  /** Flashlight starts on. Default `true`. */
  flashlightOn?: boolean;
}

/** Structural three-free vector, so callers can pass plain objects or Vector3s. */
export type VecLike = Vec3;
