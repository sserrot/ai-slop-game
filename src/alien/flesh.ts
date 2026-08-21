/**
 * src/alien/flesh.ts — the one material in the game that is not a data-table row.
 *
 * `src/station/materials.ts` is emphatic that a new look means changing a
 * COLOUR, not adding a program, and it is right about every surface in the
 * station. This is the exception, and the exception is argued rather than
 * assumed:
 *
 *   • `organic` is used by exactly ONE object. Grep it. Giving it its own
 *     program costs one extra `WebGLProgram` link at boot (~20 ms, measured in
 *     that file's own header) and cannot ripple into anything else.
 *   • The station is made of METAL and the alien is not. `MeshStandardMaterial`
 *     is a metal/dielectric BRDF; it has no idea that light goes INTO skin,
 *     scatters, and comes back out somewhere else. A pale, matte, 972-triangle
 *     body under a 5 candela torch reads as painted plastic, and it read as
 *     painted plastic for the whole of r3.
 *   • Everything below is a change to how the surface RESPONDS TO LIGHT. Not
 *     one line of it adds light. That distinction is the whole design:
 *
 * **NOTHING HERE GLOWS.** `emissive` stays at the palette's zero and
 * `assertInert` still passes unchanged. The rim term multiplies
 * `reflectedLight`, so with no lamp on the creature it contributes exactly
 * nothing and the alien is as invisible in the dark as it always was. That is
 * not a nicety — §9's rule 2 is that emissive means "you can touch this", and a
 * monster with a rim light you could see through fog with the torch off would
 * be the loudest false positive in the game AND would hand the player a free
 * proximity sensor the design never gave them.
 *
 * Four mechanisms, in the order they matter:
 *
 *   1. WRAP / SUBSURFACE. Light bleeds past the terminator and picks up a
 *      sub-dermal colour on the way. This is what separates flesh from paint at
 *      a glance and it is the reason the whole file exists.
 *   2. GRAZING RIM. Skin is wet. At glancing angles it kicks. Multiplicative on
 *      the light already there, per the promise above.
 *   3. DERIVATIVE BUMP. Skin detail from a procedural noise, perturbing the
 *      normal through screen-space derivatives — so it needs NO texture, NO UVs
 *      and no atlas, which matters because this body is merged from cylinders,
 *      spheres and boxes whose UVs do not agree with each other and never will.
 *   4. CRAWL. A slow vertex displacement along the normal. Millimetres. You
 *      will not see it; you will notice when it stops.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON PATCHING THREE'S SHADER CHUNKS
 *
 * (1) needs to be inside the light loop, and three does not expose a hook
 * there. So `RE_Direct_Physical` is patched by string replacement — on a COPY
 * of the chunk taken from `THREE.ShaderChunk`, never on the global, so no other
 * material in the scene is affected.
 *
 * That is a version-coupled thing to do and it is treated as one:
 * {@link fleshWrapChunk} checks that the text it expects is actually there, and
 * if a three upgrade has moved it, the material silently drops the wrap term
 * and keeps the other three. The creature gets slightly less interesting; it
 * does not turn black, and the build does not break. `FLESH_WRAP_AVAILABLE`
 * reports which happened, and `assertFleshCoherent()` fails loudly in dev so
 * you find out at the upgrade rather than in a playtest.
 */

import * as THREE from 'three';
import { PALETTE, build } from '../station/materials';

// ===========================================================================
// Tuning
// ===========================================================================

export interface FleshOptions {
  /**
   * 0..1 — how far past the terminator light bleeds. 0 is a plain dielectric.
   *
   * 0.45 is roughly 27° of wrap, which is a lot for a wall and modest for a
   * 90 mm-thick limb. Above ~0.6 the body stops having a lit side.
   */
  wrap?: number;
  /** The colour light picks up on its way through. Deep and desaturated: this
   *  is dermis, not a stage gel, and it must not shift the creature's PALETTE
   *  value enough to invalidate the hero-contrast checks in materials.ts. */
  subsurface?: THREE.ColorRepresentation;
  /** Multiplier on light already reflected, at grazing angles. Never additive. */
  rim?: number;
  /** Fresnel exponent. Higher is a tighter edge. */
  rimPower?: number;
  /** Normal perturbation strength for the skin detail. */
  bump?: number;
  /**
   * Detail frequency, cycles per metre.
   *
   * This started at 34 — 30 mm features, on the reasoning that 30 mm is the
   * finest thing you can resolve at torch range. That was the wrong number and
   * the render said so immediately: at 34 cycles per metre a 2.4 m body seen
   * from 5 m puts several noise periods inside every screen pixel, the
   * screen-space derivative the bump is built from becomes garbage, and the
   * creature comes out crusted in high-contrast mottle that reads as lichen and
   * destroys the silhouette. `materials.ts` rule 1 is SILHOUETTE FIRST and a
   * surface treatment that eats the outline has failed regardless of how good
   * the pores look in a close-up.
   *
   * 15 puts features at ~65 mm, which survives being seen from across a module.
   * {@link BUMP_FADE_START} handles the rest.
   */
  detailScale?: number;
  /** m — vertex crawl amplitude. Millimetres, deliberately. */
  crawl?: number;
  /** Crawl frequency (per metre) and rate (Hz). */
  crawlScale?: number;
  crawlHz?: number;
}

/**
 * Defaults, and the reasoning is the same one the palette uses: these are the
 * values at which the creature still reads as `PALETTE.organic` — pale, matte,
 * high-contrast against the hull — while no longer reading as a painted prop.
 * Push `wrap` or `rim` much past these and you are changing the material's
 * apparent value, which is a promise `assertPaletteCoherent()` made on your
 * behalf about the alien not being confusable with a crewmate's suit.
 */
export const FLESH_DEFAULTS: Required<FleshOptions> = Object.freeze({
  wrap: 0.45,
  subsurface: 0x5a1d17,
  rim: 0.85,
  rimPower: 3.0,
  bump: 0.055,
  detailScale: 15,
  crawl: 0.006,
  crawlScale: 3.2,
  crawlHz: 0.35,
});

/**
 * Where the detail bump starts and finishes fading, measured in noise periods
 * per pixel (`fwidth` of the sample coordinate).
 *
 * A derivative bump has no mip chain and therefore no defence of its own: once
 * a pixel spans more than about a quarter of a period the gradient it measures
 * is noise about noise, and it aliases into exactly the crust described on
 * {@link FleshOptions.detailScale}. Lowering the frequency alone does not fix
 * it — it only moves the distance at which it starts — so the fade is the
 * actual fix and the frequency is the tuning.
 *
 * Fully gone by 0.9, which on this creature is roughly 8 m: past that it is a
 * pale shape in fog and the pores were never going to survive the journey.
 */
const BUMP_FADE_START = 0.22;
const BUMP_FADE_END = 0.9;

// ===========================================================================
// GLSL
// ===========================================================================

/** Cheap 3-D value noise. Shared by the vertex crawl and the fragment bump, so
 *  the two agree about where the lumps are. */
const NOISE_GLSL = /* glsl */ `
float fleshHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float fleshNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(fleshHash(i), fleshHash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(fleshHash(i + vec3(0.0, 1.0, 0.0)), fleshHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(fleshHash(i + vec3(0.0, 0.0, 1.0)), fleshHash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(fleshHash(i + vec3(0.0, 1.0, 1.0)), fleshHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
`;

const VERTEX_PARS = /* glsl */ `
uniform float uFleshTime;
uniform float uFleshCrawl;
uniform float uFleshCrawlScale;
uniform float uFleshCrawlHz;
varying vec3 vFleshPos;
${NOISE_GLSL}
`;

const FRAGMENT_PARS = /* glsl */ `
uniform float uFleshWrap;
uniform vec3 uFleshSubsurface;
uniform float uFleshRim;
uniform float uFleshRimPower;
uniform float uFleshBump;
uniform float uFleshDetailScale;
varying vec3 vFleshPos;
${NOISE_GLSL}
`;

/**
 * The wrap term, injected into `RE_Direct_Physical`.
 *
 * `rawNL` below the horizon is exactly the light a Lambert surface throws away.
 * A slab of skin does not throw it away — it lets some in, bounces it around
 * and lets it back out a few millimetres further round the curve, reddened by
 * everything it passed through. This adds back the difference between the
 * wrapped and unwrapped cosines, tinted.
 *
 * DIFFUSE ONLY. Adding it to `irradiance` instead would have been one line
 * shorter and would have put a specular highlight on the unlit side of the
 * creature, which is not subsurface scattering, it is a bug that looks like
 * one.
 */
const WRAP_TARGET =
  '\treflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );';

const WRAP_PATCH = /* glsl */ `
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );
	{
		float fleshRawNL = dot( geometryNormal, directLight.direction );
		float fleshWrapped = saturate( ( fleshRawNL + uFleshWrap ) / ( 1.0 + uFleshWrap ) );
		float fleshBleed = max( fleshWrapped - saturate( fleshRawNL ), 0.0 );
		reflectedLight.directDiffuse +=
			fleshBleed * directLight.color * uFleshSubsurface *
			BRDF_Lambert( material.diffuseContribution );
	}`;

/**
 * A patched copy of `lights_physical_pars_fragment`, or null if three has moved
 * the text out from under us.
 *
 * Computed once at module load rather than per material: the chunk is a
 * constant, and doing it lazily would mean the dev-time coherence check could
 * not report on it before anything had been rendered.
 */
function fleshWrapChunk(): string | null {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (typeof chunk !== 'string' || !chunk.includes(WRAP_TARGET)) return null;
  return chunk.replace(WRAP_TARGET, WRAP_PATCH);
}

const WRAP_CHUNK = fleshWrapChunk();

/**
 * True when the wrap term compiled in. False means a three upgrade moved
 * `RE_Direct_Physical`'s diffuse accumulation and the creature is running with
 * rim, bump and crawl only — see this file's header.
 */
export const FLESH_WRAP_AVAILABLE = WRAP_CHUNK !== null;

/**
 * Skin detail, and the reason this asset needs no texture and no UV unwrap.
 *
 * The body is merged from `CylinderGeometry`, `SphereGeometry`, `BoxGeometry`
 * and `ConeGeometry`. Their UVs are each individually sane and collectively
 * meaningless — a normal map sampled through them would stretch across the
 * flanks and pinch at every cap. So the height field is sampled in OBJECT
 * space, and the normal is perturbed through screen-space derivatives
 * (Blinn's method, via `dFdx`/`dFdy` of the view position), which needs no
 * tangent frame at all.
 *
 * Two octaves: a pore/wrinkle scale and a lump scale one third of it.
 */
const BUMP_PATCH = /* glsl */ `
#include <normal_fragment_maps>
{
	vec3 fleshP = vFleshPos * uFleshDetailScale;
	// Antialiasing, and it is not optional — see BUMP_FADE_START. fwidth of
	// the sample coordinate is how many noise periods this pixel covers; once
	// that passes about a quarter the gradient below is measuring nothing.
	// (No backticks in here: this is inside a JS template literal.)
	float fleshFw = max(max(fwidth(fleshP.x), fwidth(fleshP.y)), fwidth(fleshP.z));
	float fleshFade = 1.0 - smoothstep(${BUMP_FADE_START}, ${BUMP_FADE_END}, fleshFw);
	if (fleshFade > 0.002) {
		float fleshH = fleshNoise(fleshP) * 0.62 + fleshNoise(fleshP * 0.31) * 0.38;
		vec3 fleshDx = dFdx(-vViewPosition);
		vec3 fleshDy = dFdy(-vViewPosition);
		float fleshHx = dFdx(fleshH);
		float fleshHy = dFdy(fleshH);
		vec3 fleshR1 = cross(fleshDy, normal);
		vec3 fleshR2 = cross(normal, fleshDx);
		float fleshDet = dot(fleshDx, fleshR1);
		vec3 fleshGrad = sign(fleshDet) * (fleshHx * fleshR1 + fleshHy * fleshR2);
		normal = normalize(abs(fleshDet) * normal - uFleshBump * fleshFade * fleshGrad);
	}
}`;

/**
 * The crawl, applied at `<project_vertex>` rather than `<begin_vertex>`.
 *
 * Deliberately after morphing and skinning, so a gaping jaw morph or a future
 * GLB skeleton does not get its displacement applied twice — and so that
 * `vFleshPos`, which the fragment bump samples, is the position the vertex
 * ACTUALLY ended up at. Sample it before skinning and the skin detail slides
 * over the surface every time the creature moves, which is the single most
 * obvious way to make a body look like it is wearing a texture rather than
 * being made of one.
 */
const CRAWL_PATCH = /* glsl */ `
{
	float fleshCrawl = fleshNoise(transformed * uFleshCrawlScale + uFleshTime * uFleshCrawlHz);
	transformed += objectNormal * (fleshCrawl - 0.5) * uFleshCrawl;
}
vFleshPos = transformed;
#include <project_vertex>`;

// ===========================================================================
// The material
// ===========================================================================

export class FleshMaterialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleshMaterialError';
  }
}

/**
 * `PALETTE.organic`, plus skin.
 *
 * The base numbers — colour, roughness, metalness, and the zero emissive — come
 * from the palette table and are NOT overridden here, so the creature's value
 * still sits where `assertPaletteCoherent()` proved it must: clear of the hull
 * by `HERO_MIN_CONTRAST`, and a `JND_LOW_LIGHT` away from a crewmate's suit.
 * This class changes the surface's response to light. It does not repaint it.
 */
export class FleshMaterial {
  readonly material: THREE.MeshStandardMaterial;
  private readonly uniforms: Record<string, THREE.IUniform> = {};
  private time = 0;

  constructor(opts: FleshOptions = {}) {
    const o = { ...FLESH_DEFAULTS, ...opts };
    const base = build(PALETTE.organic);
    if (!(base as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      throw new FleshMaterialError('PALETTE.organic is no longer a standard material');
    }
    const m = base as THREE.MeshStandardMaterial;
    m.name = 'organic-flesh';

    this.uniforms = {
      uFleshTime: { value: 0 },
      uFleshWrap: { value: o.wrap },
      uFleshSubsurface: { value: new THREE.Color(o.subsurface) },
      uFleshRim: { value: o.rim },
      uFleshRimPower: { value: o.rimPower },
      uFleshBump: { value: o.bump },
      uFleshDetailScale: { value: o.detailScale },
      uFleshCrawl: { value: o.crawl },
      uFleshCrawlScale: { value: o.crawlScale },
      uFleshCrawlHz: { value: o.crawlHz },
    };

    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = VERTEX_PARS + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', CRAWL_PATCH);

      let frag = FRAGMENT_PARS + shader.fragmentShader;
      if (WRAP_CHUNK) {
        frag = frag.replace('#include <lights_physical_pars_fragment>', WRAP_CHUNK);
      }
      frag = frag.replace('#include <normal_fragment_maps>', BUMP_PATCH);
      // The rim, at `lights_fragment_end`, where `reflectedLight` holds
      // everything the lamps actually delivered. MULTIPLICATIVE — see the
      // header. No light, no rim, and the creature stays invisible in the dark.
      frag = frag.replace(
        '#include <lights_fragment_end>',
        /* glsl */ `#include <lights_fragment_end>
{
	float fleshFres = pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), uFleshRimPower);
	reflectedLight.directDiffuse += reflectedLight.directDiffuse * fleshFres * uFleshRim;
	reflectedLight.indirectDiffuse += reflectedLight.indirectDiffuse * fleshFres * uFleshRim * 0.5;
}`,
      );
      shader.fragmentShader = frag;
    };

    // Its own program, declared. Without this three would hand it the cached
    // program belonging to every other opaque, front-sided, tone-mapped
    // standard material in the palette — thirty of them — and the creature
    // would render with whichever one happened to compile first.
    m.customProgramCacheKey = () => 'iss-flesh-v1';
    this.material = m;
  }

  /** Advance the crawl. Call once a frame with real seconds. */
  update(dt: number): void {
    if (dt <= 0) return;
    // Wrapped at a whole number of seconds so the clock cannot lose precision
    // over a long round; the noise is sampled at `time * crawlHz` and 3600 s of
    // float32 would start to quantise the drift.
    this.time = (this.time + dt) % 3600;
    (this.uniforms.uFleshTime as THREE.IUniform).value = this.time;
  }

  dispose(): void {
    this.material.dispose();
  }
}

// ===========================================================================
// Self-check
// ===========================================================================

/**
 * Prove the material still keeps the two promises that are not about taste.
 *
 * 1. IT DOES NOT GLOW. `assertInert` checks the mesh at construction; this
 *    checks the material itself, because a rim light is exactly the kind of
 *    thing somebody reasonable adds as an emissive at 2 a.m.
 * 2. THE WRAP ACTUALLY COMPILED. A silent fallback is the right runtime
 *    behaviour and the wrong development behaviour — you would ship a three
 *    upgrade that quietly removed the reason this file exists.
 */
export function assertFleshCoherent(): void {
  const failures: string[] = [];
  if (!FLESH_WRAP_AVAILABLE) {
    failures.push(
      `the wrap term did not compile: three r${THREE.REVISION}'s ` +
        `lights_physical_pars_fragment no longer contains the diffuse accumulation this ` +
        `file patches. Re-read RE_Direct_Physical and update WRAP_TARGET`,
    );
  }
  const spec = PALETTE.organic;
  if (spec.emissiveIntensity !== 0) {
    failures.push(
      `PALETTE.organic now has emissiveIntensity ${spec.emissiveIntensity} — the creature ` +
        `must carry no self-lit channel at all (§9 rule 2, and assertInert)`,
    );
  }
  const flesh = new FleshMaterial();
  if (flesh.material.emissiveIntensity !== 0 || flesh.material.emissive.getHex() !== 0x000000) {
    failures.push('the flesh material acquired an emissive; the rim must stay multiplicative');
  }
  if (flesh.material.transparent) {
    failures.push('the flesh material became transparent; it would drop out of the shadow map');
  }
  flesh.dispose();

  if (failures.length > 0) {
    throw new FleshMaterialError(
      `the alien's skin contradicts its own brief:\n  - ${failures.join('\n  - ')}`,
    );
  }
}
