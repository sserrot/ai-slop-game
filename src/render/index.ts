/**
 * src/render — DESIGN.md §9.
 *
 * ```ts
 * import { Renderer } from './render';
 *
 * const scene = new THREE.Scene();
 * const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
 * const renderer = new Renderer(scene, camera);      // mounts into #app
 *
 * // once the station is loaded / whenever the cull set changes:
 * renderer.setModules(visibleIds.map((id) => ({
 *   id, centre: graph.centre(id)!, lighting: graph.require(id).lighting,
 * })));
 * renderer.setPlayerModule(myModule);
 *
 * // every rendered frame:
 * renderer.update(frameDt, { angularVelocity, motion, alienState });
 * ```
 */

export { Renderer, REALTIME_LIGHT_BUDGET } from './renderer';
export { Flashlight } from './flashlight';
export type { FlashlightOptions } from './flashlight';
export { LightingRig, MODULE_LIGHT_BUDGET, DEFAULT_FOG_VISIBILITY_M, fogDensityForVisibility } from './lighting';
export type { LightingRigOptions } from './lighting';
export {
  PostChain,
  BloomPass,
  GradeShader,
  MSAA_MAX_PIXELS,
  BLOOM_STRENGTH_DEFAULT,
  BLOOM_RADIUS_DEFAULT,
  BLOOM_THRESHOLD_DEFAULT,
  BLOOM_VEIL_DEFAULT,
} from './postFx';
export type { PostChainOptions } from './postFx';
export { applyShadowPolicy, castsShadowByDefault } from './shadowPolicy';
export type { ShadowPolicyOptions, ShadowPolicyStats } from './shadowPolicy';
export {
  FrameGuard,
  QUALITY_PROFILES,
  QUALITY_ORDER,
  qualityIndex,
  qualityFromIndex,
  pixelRatioFor,
} from './quality';
export type { FrameGuardOptions, FrameGuardState, QualitySuggestion } from './quality';
export {
  createEmissiveStripMaterial,
  createHandrailMaterial,
  createHullMaterial,
  createPanelMaterial,
  createCanvasPanelMaterial,
} from './materials';
export type {
  ModuleLightingInput,
  QualityChange,
  QualityChangeReason,
  QualityLevel,
  QualityProfile,
  RenderFrameInput,
  RenderStats,
  RendererOptions,
  VecLike,
} from './types';
export { clamp01, damp, dampAsym, decayFactor, flicker01, lerp } from './util';
