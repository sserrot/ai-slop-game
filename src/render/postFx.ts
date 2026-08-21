/**
 * src/render/postFx.ts — the EffectComposer chain (DESIGN.md §9).
 *
 *   RenderPass  →  BloomPass (7 small quads)  →  GradePass (→ screen)
 *
 * Nine `renderer.render()` calls a frame at `high`, against fifteen before, and
 * — the part that actually mattered — none of them writes a full-resolution
 * quad into a multisampled target. Interleaved A/B at the reported player's
 * 1920×1200 with the old chain spliced back in, three reps, GPU p50 ms:
 *
 *   old 0.786 / 0.838 / 0.991      new 0.524 / 0.681 / 0.555
 *
 * a third off the GPU frame, and bloom's own share of it fell from 0.88 ms to
 * 0.06 ms (`high` with bloom 0.523 / 0.584, without 0.503 / 0.488). The CPU
 * side barely moved — `post.render` is 1.3–1.6 ms either way, because almost
 * all of it is `RenderPass` submitting the scene, not the effect quads. That is
 * worth saying plainly: the post chain was never 73% of the CPU frame in the
 * sense of being removable. The quads were free; the multisample write was not.
 *
 * §9 budgets "bloom on emissives, vignette, film grain, light chromatic
 * aberration" and then says **keep it cheap**. The previous chain was not
 * cheap: it issued FIFTEEN `renderer.render()` calls a frame, thirteen of them
 * inside `UnrealBloomPass`, and the last of those thirteen wrote a
 * FULL-RESOLUTION additive quad back into the multisampled HDR target.
 *
 * Measured on the reported hardware (RTX 3080, 1920×1200 backing store, GPU
 * timer queries, interleaved A/B, GPU p50 ms):
 *
 *   MSAA 4, bloom on   1.585 / 1.252      MSAA 0, bloom on   0.384 / 0.356
 *   MSAA 4, bloom off  0.648 / 0.433      MSAA 0, bloom off  0.258 / 0.261
 *
 * Read that table the right way round: the thirteen blur quads cost 0.11 ms.
 * Bloom's *blend back into a 4× multisampled RGBA16F target* cost 0.88 ms — 8×
 * the entire blur chain — because it rasterises 2.3 Mpx at four samples and
 * forces a second `blitFramebuffer` resolve. The mip chain was never the
 * problem; writing through MSAA was.
 *
 * So the bloom no longer touches the scene target at all:
 *
 *   • `BloomPass` has `needsSwap = false` and renders only into its own small
 *     targets: a soft-knee bright pass at `bloomScale` of the composer, a 4-tap
 *     box downsample to a quarter of that, a separable 7-linear-tap gaussian
 *     (H then V) at that size for the halo, and the same three steps again 4×
 *     smaller for the wide veil. Seven quads, 0.69 Mpx of fill against the old
 *     chain's ~5 Mpx, and five render targets against eleven.
 *   • `GradePass` samples both results and adds them in LINEAR space before
 *     tone mapping — exactly where the old additive blend put it, two texture
 *     fetches instead of a full-screen pass and an MSAA round trip.
 *
 * `RenderPass` still draws into a half-float target, so the frame stays linear
 * HDR and the emissive strips sit above 1.0 where the bloom threshold can find
 * them. Half-float is not negotiable — this game is almost entirely dark
 * gradients and an 8-bit linear buffer bands visibly before the dither can help.
 *
 * `GradePass` is ONE quad carrying everything else: the bloom composite, ACES
 * tone mapping and the sRGB encode (which used to be a separate `OutputPass`),
 * light chromatic aberration, the vignette (whose strength is an input from the
 * player controller's angular velocity, §4), film grain and dither, plus the
 * HUNT desaturation (§5) and the red-alert tint.
 *
 * MSAA IS PIXEL-GATED (see {@link MSAA_MAX_PIXELS}). A multisampled half-float
 * target is the one thing in this renderer with a capacity cliff rather than a
 * slope: measured at quality `high`, 4× MSAA, GPU p50 per frame —
 *
 *   1920×1200 (2.3 Mpx)  1.2 ms      2880×1800 (5.2 Mpx)  106 ms
 *   2560×1600 (4.1 Mpx)  1.5 ms      3648×2280 (8.3 Mpx)  320 ms
 *
 * Same sweep with MSAA off is flat (1.3–1.8 ms at 8.3 Mpx). That is a memory
 * limit, not shading, and no amount of "sustained slowness" logic recovers from
 * a 320 ms frame gracefully — so the samples are refused above the budget
 * instead of being dropped after the fact.
 *
 * GRADE MUST STAY LAST. three only compiles the tone-mapping function into a
 * material that renders to the default framebuffer, so a pass appended after
 * this one would silently drop the tone map. The shader guards the call with
 * `#ifdef TONE_MAPPING` so that mistake degrades to a flat image instead of a
 * shader-compile failure, but it is still a mistake.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import type { QualityProfile } from './types';

/**
 * Drawing-buffer pixels above which the composer refuses MSAA entirely.
 *
 * Deliberately set just ABOVE `high`'s `maxRenderPixels` (3.3 Mpx), so the two
 * limits agree: anything the pixel budget can honour keeps its antialiasing,
 * and MSAA is dropped exactly when the budget has already been blown — which
 * only happens when the CSS window itself is bigger than the budget and the
 * profile's `minPixelRatio` refuses to render below 1:1.
 *
 * The number below that is 4.1 Mpx, where a 4× multisampled RGBA16F target was
 * still costing 1.5 ms; at 5.2 Mpx it stopped fitting and the same frame cost
 * 106 ms. The cliff's exact position depends on what else holds VRAM — it was
 * measured with another 3D application holding 8.5 GB of 10 — but the ordering
 * (MSAA dominates everything else once the target is large) does not.
 *
 * LOWERED 3.4 Mpx -> 2.3 Mpx. A player reported the game running at 10 fps, and
 * the renderer's own guard logged `quality high -> medium (auto, 10 fps)` and
 * then `medium -> low (auto, 14 fps)`. 10 fps is a 100 ms frame, which is the
 * 106 ms signature above and nothing else in this renderer — CPU on the same
 * build measures 1.4 ms/frame, and cutting the frame to a THIRD of its pixels
 * changed GPU cost by 16%, so it was never fill rate.
 *
 * The old gate assumed the cliff sits somewhere near 5 Mpx. It does not: it
 * moves with whatever else holds VRAM, and on a machine with a browser and a
 * game and everything else running it can sit under the gate — which is exactly
 * what a `maxRenderPixels` of 3.3 Mpx then walks straight off. 2.3 Mpx is the
 * highest size MEASURED on the flat part of the curve (1.2 ms), so it is the
 * only value here justified by data rather than by extrapolation.
 *
 * The trade is real and small: above 2.3 Mpx you get no MSAA. In a scene that is
 * fog, darkness and a torch beam, losing edge antialiasing costs far less than a
 * 100 ms frame — and the alternative is a cliff whose position we cannot predict
 * on someone else's machine.
 */
export const MSAA_MAX_PIXELS = 2_300_000;

/** Blur target size relative to the bright pass. One 4× box downsample. */
const BLOOM_BLUR_DIVISOR = 4;
/** …and again, for the wide veil. See {@link BloomPass} on why it exists. */
const BLOOM_VEIL_DIVISOR = 4;

/**
 * Separable gaussian, 13 taps folded into 7 linear samples (σ ≈ 3 texels).
 * Offsets are in DESTINATION texels so the horizontal and vertical halves cover
 * the same distance on screen even when the horizontal pass also downsamples.
 */
const BLUR_OFFSETS = [0, 1.411764705882353, 3.2941176470588234, 5.176470588235294];
const BLUR_WEIGHTS = [
  0.1964825501511404, 0.2969069646728344, 0.09447039785044732, 0.010381362401148057,
];

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

/**
 * Soft-knee bright pass. A hard threshold pops emissive strips in and out as the
 * camera moves and the tone curve slides them across it; the knee is the
 * standard fix and costs three ALU ops.
 */
const BRIGHT_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D( tDiffuse, vUv ).rgb;
    float lum = max( c.r, max( c.g, c.b ) );
    float soft = clamp( lum - uThreshold + uKnee, 0.0, 2.0 * uKnee );
    soft = soft * soft / ( 4.0 * uKnee + 1e-5 );
    float contribution = max( soft, lum - uThreshold ) / max( lum, 1e-5 );
    gl_FragColor = vec4( c * contribution, 1.0 );
  }
`;

/**
 * Exact 4× box downsample in four bilinear taps.
 *
 * A destination texel covers a 4×4 source block. Sampling at ±0.25 destination
 * texels lands each tap dead on the corner shared by one 2×2 quadrant of that
 * block, so bilinear filtering averages those four texels for free and the four
 * taps tile the block with no gaps and no double-counting. Thin bright strips
 * keep their energy, which a single centre tap would throw away.
 */
const DOWNSAMPLE_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;      // 1 / destination size
  varying vec2 vUv;

  void main() {
    vec2 o = uTexel * 0.25;
    vec3 sum = texture2D( tDiffuse, vUv + vec2( -o.x, -o.y ) ).rgb;
    sum += texture2D( tDiffuse, vUv + vec2(  o.x, -o.y ) ).rgb;
    sum += texture2D( tDiffuse, vUv + vec2( -o.x,  o.y ) ).rgb;
    sum += texture2D( tDiffuse, vUv + vec2(  o.x,  o.y ) ).rgb;
    gl_FragColor = vec4( sum * 0.25, 1.0 );
  }
`;

const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uStep;       // one destination texel along the blur axis
  varying vec2 vUv;

  void main() {
    vec3 sum = texture2D( tDiffuse, vUv ).rgb * ${BLUR_WEIGHTS[0]};
    sum += texture2D( tDiffuse, vUv + uStep * ${BLUR_OFFSETS[1]} ).rgb * ${BLUR_WEIGHTS[1]};
    sum += texture2D( tDiffuse, vUv - uStep * ${BLUR_OFFSETS[1]} ).rgb * ${BLUR_WEIGHTS[1]};
    sum += texture2D( tDiffuse, vUv + uStep * ${BLUR_OFFSETS[2]} ).rgb * ${BLUR_WEIGHTS[2]};
    sum += texture2D( tDiffuse, vUv - uStep * ${BLUR_OFFSETS[2]} ).rgb * ${BLUR_WEIGHTS[2]};
    sum += texture2D( tDiffuse, vUv + uStep * ${BLUR_OFFSETS[3]} ).rgb * ${BLUR_WEIGHTS[3]};
    sum += texture2D( tDiffuse, vUv - uStep * ${BLUR_OFFSETS[3]} ).rgb * ${BLUR_WEIGHTS[3]};
    gl_FragColor = vec4( sum, 1.0 );
  }
`;

function bloomTarget(width: number, height: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = 'BloomPass.rt';
  return rt;
}

/**
 * Threshold → downsample → separable blur, twice, into two textures the grade
 * pass reads.
 *
 * Seven quads, all small, and `needsSwap = false` so the composer never copies
 * anything on its behalf. It deliberately does NOT write its result anywhere
 * the scene lives: that write was 0.88 ms of the old chain (see the file
 * header), and the grade pass has to touch every pixel anyway.
 *
 * WHY THERE ARE TWO LEVELS. `UnrealBloomPass` summed five mips at equal weight
 * (`lerpBloomFactor` collapses to 0.6 for every mip at the shipped radius of
 * 0.5), and the coarsest of those was a screen-wide wash. Measured on a frozen
 * frame at 1920×1200 — mean frame luminance, 0–255:
 *
 *   no bloom  21.0      UnrealBloom  50.6      one tight level only  23.1
 *
 * and the light it added 160 px from the source was +97 with UnrealBloom
 * against +7.5 with a single blur. That difference is not a halo, it is
 * VEILING GLARE, and dropping it silently would have been a real change to how
 * the game looks — it lifts every black in the frame. So the wide level is
 * still here; it is just three quads at a thirty-second of the composer
 * resolution (60×37 at 1920×1200) instead of ten quads and a full-resolution
 * blend through MSAA. {@link veil} is how much of it reaches the frame, so the
 * glare is now a dial rather than an accident of the mip weights.
 *
 * With both levels and the calibrated defaults the same frozen frame reads 28.3
 * against the old 45.6 — closer, and honestly short. See
 * {@link BLOOM_STRENGTH_DEFAULT} for the grid search that picked the numbers.
 */
export class BloomPass extends Pass {
  /** Multiplier applied by the grade pass, not by this pass. */
  strength: number;
  /** Blur spread, 1 = the natural σ ≈ 3 texels of the tap set. */
  radius: number;
  /** Luminance above which a pixel blooms, with a soft knee below it. */
  threshold: number;
  /** How much of the wide level reaches the frame — the veiling glare dial. */
  veil: number;

  private readonly quad: FullScreenQuad;
  private readonly bright: THREE.ShaderMaterial;
  private readonly downsample: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;

  private brightTarget: THREE.WebGLRenderTarget | null = null;
  private blurA: THREE.WebGLRenderTarget | null = null;
  private blurB: THREE.WebGLRenderTarget | null = null;
  private veilA: THREE.WebGLRenderTarget | null = null;
  private veilB: THREE.WebGLRenderTarget | null = null;
  private readonly black: THREE.DataTexture;

  private width = 1;
  private height = 1;
  private scale: number;

  /** `renderer.render()` calls this pass issues when it runs. */
  static readonly QUADS = 7;

  constructor(
    width: number,
    height: number,
    scale: number,
    strength: number,
    radius: number,
    threshold: number,
    veil: number,
  ) {
    super();
    this.needsSwap = false;
    this.strength = strength;
    this.radius = radius;
    this.threshold = threshold;
    this.veil = veil;
    this.scale = scale;

    this.bright = new THREE.ShaderMaterial({
      name: 'ISSBloomBright',
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: threshold },
        uKnee: { value: 0.35 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BRIGHT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.downsample = new THREE.ShaderMaterial({
      name: 'ISSBloomDownsample',
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: DOWNSAMPLE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      name: 'ISSBloomBlur',
      uniforms: { tDiffuse: { value: null }, uStep: { value: new THREE.Vector2(0, 0) } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.bright);

    // What the grade pass samples while the pass is disabled: one black texel,
    // so the composite branch needs no shader recompile to turn bloom off.
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;

    this.setSize(width, height);
  }

  /** The tight halo, for the grade pass. Black while the pass is disabled. */
  get texture(): THREE.Texture {
    return this.enabled && this.blurA ? this.blurA.texture : this.black;
  }

  /** The wide veiling glare, for the grade pass. */
  get veilTexture(): THREE.Texture {
    return this.enabled && this.veilA ? this.veilA.texture : this.black;
  }

  /** Resolution of the blur targets relative to the composer. */
  get resolutionScale(): number {
    return this.scale;
  }

  setResolutionScale(scale: number): void {
    const s = Math.min(1, Math.max(0.05, scale));
    if (s === this.scale) return;
    this.scale = s;
    this.setSize(this.width, this.height);
  }

  /**
   * Size and scale together, so a quality step that changes both does not
   * allocate the five targets twice on its way to the answer.
   */
  configure(width: number, height: number, scale: number): void {
    this.scale = Math.min(1, Math.max(0.05, scale));
    this.setSize(width, height);
  }

  /**
   * Turning bloom off FREES its targets rather than leaving them allocated —
   * `low` exists to give a struggling machine its memory back, and a quality
   * step that only flips a boolean is the "nominally flipping a flag" failure
   * this profile set is supposed to avoid.
   */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (on) this.allocate();
    else this.release();
  }

  override setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    if (this.enabled) this.allocate();
  }

  private release(): void {
    this.brightTarget?.dispose();
    this.blurA?.dispose();
    this.blurB?.dispose();
    this.veilA?.dispose();
    this.veilB?.dispose();
    this.brightTarget = null;
    this.blurA = null;
    this.blurB = null;
    this.veilA = null;
    this.veilB = null;
  }

  private allocate(): void {
    const bw = Math.max(1, Math.round(this.width * this.scale));
    const bh = Math.max(1, Math.round(this.height * this.scale));
    const dw = Math.max(1, Math.round(bw / BLOOM_BLUR_DIVISOR));
    const dh = Math.max(1, Math.round(bh / BLOOM_BLUR_DIVISOR));
    const vw = Math.max(1, Math.round(dw / BLOOM_VEIL_DIVISOR));
    const vh = Math.max(1, Math.round(dh / BLOOM_VEIL_DIVISOR));

    if (this.brightTarget) this.brightTarget.setSize(bw, bh);
    else this.brightTarget = bloomTarget(bw, bh);
    if (this.blurA) this.blurA.setSize(dw, dh);
    else this.blurA = bloomTarget(dw, dh);
    if (this.blurB) this.blurB.setSize(dw, dh);
    else this.blurB = bloomTarget(dw, dh);
    if (this.veilA) this.veilA.setSize(vw, vh);
    else this.veilA = bloomTarget(vw, vh);
    if (this.veilB) this.veilB.setSize(vw, vh);
    else this.veilB = bloomTarget(vw, vh);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    if (!this.brightTarget || !this.blurA || !this.blurB || !this.veilA || !this.veilB) return;

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    // Every quad below writes every texel of its target, so a clear — automatic
    // or explicit — is pure bandwidth. None of these targets carries depth.
    renderer.autoClear = false;

    // 1 · bright pass, at `scale` of the composer. One tap: when `scale` is a
    // half, the destination texel centre lands exactly on the corner of a 2×2
    // source block and bilinear filtering averages it for nothing.
    this.bright.uniforms.tDiffuse.value = readBuffer.texture;
    this.bright.uniforms.uThreshold.value = this.threshold;
    this.quad.material = this.bright;
    renderer.setRenderTarget(this.brightTarget);
    this.quad.render(renderer);

    // 2 · exact 4× box downsample into the blur resolution, then a separable
    // gaussian, H then V, ping-ponging between two equal targets.
    //
    // NOTE none of these targets is multisampled, which is the point: three
    // resolves `_currentRenderTarget` at the end of EVERY `render()` call, so a
    // bloom that ended by writing into the scene's MSAA buffer paid for a
    // second full-resolution `blitFramebuffer` every frame.
    this.box(renderer, this.brightTarget, this.blurA);
    this.gaussian(renderer, this.blurA, this.blurB, this.blurA);

    // 3 · the same again, 4× smaller: the wide veiling glare that
    // UnrealBloomPass's coarsest mips used to supply. 60×37 at 1920×1200.
    this.box(renderer, this.blurA, this.veilA);
    this.gaussian(renderer, this.veilA, this.veilB, this.veilA);

    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);
  }

  /** One exact 4× box downsample, `from` → `to`. */
  private box(
    renderer: THREE.WebGLRenderer,
    from: THREE.WebGLRenderTarget,
    to: THREE.WebGLRenderTarget,
  ): void {
    this.downsample.uniforms.tDiffuse.value = from.texture;
    (this.downsample.uniforms.uTexel.value as THREE.Vector2).set(1 / to.width, 1 / to.height);
    this.quad.material = this.downsample;
    renderer.setRenderTarget(to);
    this.quad.render(renderer);
  }

  /** Separable gaussian: `src` → `scratch` horizontally, → `dest` vertically. */
  private gaussian(
    renderer: THREE.WebGLRenderer,
    src: THREE.WebGLRenderTarget,
    scratch: THREE.WebGLRenderTarget,
    dest: THREE.WebGLRenderTarget,
  ): void {
    const step = this.blur.uniforms.uStep.value as THREE.Vector2;
    this.quad.material = this.blur;

    this.blur.uniforms.tDiffuse.value = src.texture;
    step.set(this.radius / dest.width, 0);
    renderer.setRenderTarget(scratch);
    this.quad.render(renderer);

    this.blur.uniforms.tDiffuse.value = scratch.texture;
    step.set(0, this.radius / dest.height);
    renderer.setRenderTarget(dest);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.release();
    this.quad.dispose();
    this.bright.dispose();
    this.downsample.dispose();
    this.blur.dispose();
    this.black.dispose();
  }
}

/**
 * Bloom composite + tone map + sRGB encode + display-space grade, in one pass.
 *
 * Input is LINEAR HDR straight off the render pass, and `tBloom` is the blurred
 * bright pass in the same space, so the add happens before the tone curve —
 * where `UnrealBloomPass`'s additive blend used to put it. `toneMapping()` and
 * `linearToOutputTexel()` are injected by three's shader prefix from the
 * renderer's own `toneMapping` / `outputColorSpace`, which is what `OutputPass`
 * used to do — so the low-quality direct path (`renderer.render()` with no
 * composer) still produces the same image, just without the effects.
 */
export const GradeShader = {
  name: 'ISSGradeShader',

  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Tight halo from {@link BloomPass}; black when bloom is off. */
    tBloom: { value: null as THREE.Texture | null },
    /** Wide veiling glare from {@link BloomPass}, same space. */
    tBloomVeil: { value: null as THREE.Texture | null },
    /** Bloom amount. 0 skips both fetches entirely. */
    uBloomStrength: { value: 0 },
    /** How much of the wide level is mixed in, relative to the tight one. */
    uBloomVeil: { value: 0 },
    uTime: { value: 0 },
    /** width / height, for a round vignette on any aspect. */
    uAspect: { value: 16 / 9 },
    /** 1 / (half the corner radius), so the vignette distance is 1 at the corners. */
    uVigScale: { value: 1 },
    /** 0–1 darkening at the frame edge. */
    uVignette: { value: 0.42 },
    /** Where the darkening starts: 0 = screen centre, 1 = corner. */
    uVignetteRadius: { value: 0.6 },
    /** Film grain amplitude in display units. */
    uGrain: { value: 0.04 },
    /** Ordered-ish dither, kills banding in the dark gradients this game lives in. */
    uDither: { value: 1.4 / 255 },
    /** Radial chromatic aberration, UV units at the corner. */
    uAberration: { value: 0.012 },
    /** 0–1 desaturation — the HUNT response. */
    uDesaturate: { value: 0 },
    /** Multiplicative tint (red alert). */
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uTintAmount: { value: 0 },
    /** Gentle display-space grade so black stays black without crushing detail. */
    uContrast: { value: 1.04 },
    uLift: { value: 0.006 },
  },

  vertexShader: FULLSCREEN_VERTEX,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform sampler2D tBloomVeil;
    uniform float uBloomStrength;
    uniform float uBloomVeil;
    uniform float uTime;
    uniform float uAspect;
    uniform float uVigScale;
    uniform float uVignette;
    uniform float uVignetteRadius;
    uniform float uGrain;
    uniform float uDither;
    uniform float uAberration;
    uniform float uDesaturate;
    uniform vec3  uTint;
    uniform float uTintAmount;
    uniform float uContrast;
    uniform float uLift;

    varying vec2 vUv;

    // Cheap hash — one fract/sin free, no texture, no state.
    float hash12( vec2 p ) {
      vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
      p3 += dot( p3, p3.yzx + 33.33 );
      return fract( ( p3.x + p3.y ) * p3.z );
    }

    // Linear HDR -> display. This is exactly what OutputPass did; three injects
    // toneMapping() and linearToOutputTexel() from the renderer's settings.
    vec3 display( vec3 linearColor ) {
      #ifdef TONE_MAPPING
        linearColor = toneMapping( linearColor );
      #endif
      return linearToOutputTexel( vec4( linearColor, 1.0 ) ).rgb;
    }

    void main() {
      vec2 centred = vUv - 0.5;
      float r2 = dot( centred, centred );

      // Bloom is added in LINEAR space, before the tone curve — two fetches,
      // one at a sixty-fourth of the frame's pixels and one at a thousandth.
      // It is deliberately NOT split by the aberration: a few pixels of radial
      // offset on a 30-pixel-wide blur is not a visible difference, and it
      // saves four dependent texture reads.
      vec3 bloom = vec3( 0.0 );
      if ( uBloomStrength > 0.0 ) {
        bloom = texture2D( tBloom, vUv ).rgb;
        if ( uBloomVeil > 0.0 ) bloom += texture2D( tBloomVeil, vUv ).rgb * uBloomVeil;
        bloom *= uBloomStrength;
      }

      vec3 color;
      if ( uAberration > 0.0 ) {
        // Radial split, negligible in the middle, a few pixels at the corners.
        // Each tap is graded to display space before its channel is taken, so
        // the split lands where it used to when OutputPass ran first.
        vec2 offset = centred * r2 * uAberration * 4.0;
        color.r = display( texture2D( tDiffuse, vUv + offset ).rgb + bloom ).r;
        color.g = display( texture2D( tDiffuse, vUv ).rgb + bloom ).g;
        color.b = display( texture2D( tDiffuse, vUv - offset ).rgb + bloom ).b;
      } else {
        color = display( texture2D( tDiffuse, vUv ).rgb + bloom );
      }

      if ( uDesaturate > 0.0 ) {
        float grey = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
        color = mix( color, vec3( grey ), uDesaturate );
      }

      if ( uTintAmount > 0.0 ) {
        color = mix( color, color * uTint, uTintAmount );
      }

      color = ( color - 0.5 ) * uContrast + 0.5;
      color += uLift * ( 1.0 - color );
      color = max( color, vec3( 0.0 ) );

      // Vignette: comfort input (§4) and the HUNT tightening (§5) both land here.
      float d = length( vec2( centred.x * uAspect, centred.y ) ) * uVigScale;
      float vig = smoothstep( uVignetteRadius, 1.0, d );
      color *= 1.0 - uVignette * vig;

      float n = hash12( gl_FragCoord.xy + vec2( uTime * 137.13, uTime * 71.77 ) );
      color += ( n - 0.5 ) * ( uGrain + uDither );

      gl_FragColor = vec4( clamp( color, 0.0, 1.0 ), 1.0 );
    }
  `,
};

export interface PostChainOptions {
  bloomStrength?: number;
  bloomRadius?: number;
  bloomThreshold?: number;
  /** Weight of the wide veiling-glare level, relative to the tight halo. */
  bloomVeil?: number;
  msaaSamples?: number;
  /** Bloom bright-pass scale, 0–1. Normally set by the quality profile. */
  bloomScale?: number;
}

/**
 * Bloom defaults, CALIBRATED against the chain this file replaced. Not taste.
 *
 * Both chains were run live in the same frozen 1920×1200 frames — the old
 * `UnrealBloomPass` spliced back into the composer with its shipped arguments
 * (0.62 / 0.5 / 0.9, half-resolution) — and the light each added over a
 * bloom-disabled reference was measured in 10 px annuli around the brightest
 * emissive in three modules. The grid searched strength × veil × radius for the
 * lowest RMS error against the old profile; `2.4 / 0.8 / 2.4` won in all three
 * (RMS 37.9 / 19.7 / 11.7 against 83.3 / 41.9 / 46.7 for an uncalibrated
 * 1.0 / 0.55).
 *
 * A caveat worth keeping: the match is close but not exact, and it is honest
 * about which way it misses. Mean frame luminance in the brightest module,
 * 0–255: no bloom 16.9, old chain 45.5, this chain 28.3. The old chain summed
 * five equally-weighted blur levels and one of them was screen-wide, so it put
 * roughly a third more light into a dark frame than two levels can. What is
 * left is deliberate and adjustable — see {@link PostChain.setBloomVeil}.
 *
 * The bright pass also changed its mind about what "bright" means:
 * `UnrealBloomPass` thresholds on Rec.601 weighted luma, so a saturated red
 * strip authored at 2.4× linear scored 0.76 and never bloomed AT ALL, while a
 * cyan one at the same authored intensity scored 1.54 and did. This one
 * thresholds on `max(r, g, b)`, so §9's "bloom on emissives" now means all of
 * them. Measured side effect on a module with no emissives in frame: +0.5 of
 * 255 mean luminance. Measured side effect on the red-lit modules: they glow.
 */
export const BLOOM_STRENGTH_DEFAULT = 2.4;
export const BLOOM_RADIUS_DEFAULT = 2.4;
export const BLOOM_THRESHOLD_DEFAULT = 0.9;
export const BLOOM_VEIL_DEFAULT = 0.8;

/** Owns the composer and every pass. The renderer drives it; nothing else should. */
export class PostChain {
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly bloom: BloomPass;
  /** Bloom composite, tone map, sRGB encode, aberration, vignette, grain. Last. */
  readonly grade: ShaderPass;

  readonly renderer: THREE.WebGLRenderer;
  private width: number;
  private height: number;
  private pixelRatio: number;
  private samples: number;
  /** Samples actually allocated, after {@link MSAA_MAX_PIXELS} gating. */
  private activeSamples = 0;
  private bloomStrength: number;
  private time = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number,
    pixelRatio: number,
    opts: PostChainOptions = {},
  ) {
    this.renderer = renderer;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = Math.max(0.1, pixelRatio);
    this.samples = Math.max(0, Math.round(opts.msaaSamples ?? 4));
    this.bloomStrength = Math.max(0, opts.bloomStrength ?? BLOOM_STRENGTH_DEFAULT);

    this.composer = new EffectComposer(renderer, this.createRenderTarget());
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new BloomPass(
      Math.round(this.width * this.pixelRatio),
      Math.round(this.height * this.pixelRatio),
      Math.min(1, Math.max(0.05, opts.bloomScale ?? 0.5)),
      this.bloomStrength,
      opts.bloomRadius ?? BLOOM_RADIUS_DEFAULT,
      opts.bloomThreshold ?? BLOOM_THRESHOLD_DEFAULT,
      opts.bloomVeil ?? BLOOM_VEIL_DEFAULT,
    );
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.syncBloomUniforms();
    this.applyAspect();
  }

  /** Swap the rendered camera (spectator cameras, §10). */
  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
  }

  setScene(scene: THREE.Scene): void {
    this.renderPass.scene = scene;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = Math.max(0.1, pixelRatio);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);
    // The MSAA gate is a function of the drawing-buffer size, so a resize can
    // legitimately change it. Recreate only when the answer actually moved.
    if (this.effectiveSamples() !== this.activeSamples) this.recreateRenderTarget();
    this.bloom.setSize(
      Math.round(this.width * this.pixelRatio),
      Math.round(this.height * this.pixelRatio),
    );
    this.syncBloomUniforms();
    this.applyAspect();
  }

  /**
   * Apply a quality preset AND a size in one shot.
   *
   * One entry point rather than `applyProfile()` followed by `setSize()`,
   * because an auto-quality step changes both the sample count and the pixel
   * ratio, and doing them separately reallocated the composer's half-float
   * targets twice. Every reallocation is a visible hitch; the guard's whole job
   * is to reduce hitches.
   */
  configure(profile: QualityProfile, width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = Math.max(0.1, pixelRatio);
    this.samples = Math.max(0, Math.round(profile.msaaSamples));

    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);
    if (this.effectiveSamples() !== this.activeSamples) this.recreateRenderTarget();

    this.bloom.configure(
      Math.round(this.width * this.pixelRatio),
      Math.round(this.height * this.pixelRatio),
      profile.bloomScale,
    );
    // A disabled pass is skipped by the composer AND gives its targets back.
    this.bloom.setEnabled(profile.bloom);

    this.setGrain(profile.grain);
    this.setAberration(profile.aberration);
    this.syncBloomUniforms();
    this.applyAspect();
  }

  /** Apply a quality preset at the current size. Prefer {@link configure}. */
  applyProfile(profile: QualityProfile): void {
    this.configure(profile, this.width, this.height, this.pixelRatio);
  }

  /**
   * `renderer.render()` calls this chain issues per frame — the honest count,
   * not the number of `Pass` objects. Fifteen before this file was rewritten.
   */
  get passCount(): number {
    let n = 0;
    for (const pass of this.composer.passes) {
      if (pass.enabled === false) continue;
      n += pass === this.bloom ? BloomPass.QUADS : 1;
    }
    return n;
  }

  /** MSAA samples requested by the profile. */
  get requestedSamples(): number {
    return this.samples;
  }

  /** MSAA samples actually allocated, after the {@link MSAA_MAX_PIXELS} gate. */
  get msaaSamples(): number {
    return this.activeSamples;
  }

  setMsaaSamples(samples: number): void {
    const s = Math.max(0, Math.round(samples));
    if (s === this.samples) return;
    this.samples = s;
    if (this.effectiveSamples() !== this.activeSamples) this.recreateRenderTarget();
  }

  /** Bloom bright-pass scale, 0.05–1, relative to the composer resolution. */
  setBloomScale(scale: number): void {
    this.bloom.setResolutionScale(scale);
    this.syncBloomUniforms();
  }

  get bloomResolutionScale(): number {
    return this.bloom.resolutionScale;
  }

  setBloom(strength: number, radius?: number, threshold?: number): void {
    this.bloomStrength = Math.max(0, strength);
    this.bloom.strength = this.bloomStrength;
    if (radius !== undefined) this.bloom.radius = Math.max(0, radius);
    if (threshold !== undefined) this.bloom.threshold = Math.max(0, threshold);
    this.syncBloomUniforms();
  }

  /**
   * Weight of the wide veiling-glare level (0 = a clean halo and nothing else).
   *
   * This is the knob that decides how much the bloom lifts the blacks. The old
   * chain had no such knob: five equally-weighted mips meant the widest one
   * always went in, and in a bright module it more than doubled the mean
   * luminance of the frame.
   */
  setBloomVeil(amount: number): void {
    this.bloom.veil = Math.max(0, amount);
    this.syncBloomUniforms();
  }

  get bloomVeil(): number {
    return this.bloom.veil;
  }

  setVignette(strength: number, radius: number): void {
    this.grade.uniforms.uVignette.value = Math.max(0, Math.min(1, strength));
    this.grade.uniforms.uVignetteRadius.value = Math.max(0.05, Math.min(1, radius));
  }

  setGrain(amount: number): void {
    this.grade.uniforms.uGrain.value = Math.max(0, amount);
  }

  setDither(amount: number): void {
    this.grade.uniforms.uDither.value = Math.max(0, amount);
  }

  setAberration(amount: number): void {
    this.grade.uniforms.uAberration.value = Math.max(0, amount);
  }

  setDesaturate(amount: number): void {
    this.grade.uniforms.uDesaturate.value = Math.max(0, Math.min(1, amount));
  }

  /** Multiplicative tint plus a 0–1 blend — the red-alert wash. */
  setTint(r: number, g: number, b: number, amount: number): void {
    const tint = this.grade.uniforms.uTint.value as THREE.Vector3;
    tint.set(r, g, b);
    this.grade.uniforms.uTintAmount.value = Math.max(0, Math.min(1, amount));
  }

  setGrade(contrast: number, lift: number): void {
    this.grade.uniforms.uContrast.value = contrast;
    this.grade.uniforms.uLift.value = lift;
  }

  /** Advance the grain clock. */
  advance(dt: number): void {
    this.time = (this.time + dt) % 1000;
    this.grade.uniforms.uTime.value = this.time;
  }

  render(deltaSeconds: number): void {
    this.composer.render(deltaSeconds);
  }

  dispose(): void {
    this.composer.dispose();
    // EffectComposer.dispose() frees its own two targets and nothing else.
    this.renderPass.dispose();
    this.bloom.dispose();
    this.grade.dispose();
  }

  /** Point the grade pass at the current bloom textures and weights. */
  private syncBloomUniforms(): void {
    this.grade.uniforms.tBloom.value = this.bloom.texture;
    this.grade.uniforms.tBloomVeil.value = this.bloom.veilTexture;
    this.grade.uniforms.uBloomStrength.value = this.bloom.enabled ? this.bloomStrength : 0;
    this.grade.uniforms.uBloomVeil.value = this.bloom.veil;
  }

  private effectiveSamples(): number {
    if (this.samples <= 0) return 0;
    const pixels = this.width * this.pixelRatio * this.height * this.pixelRatio;
    return pixels > MSAA_MAX_PIXELS ? 0 : this.samples;
  }

  private recreateRenderTarget(): void {
    // reset() disposes the old buffers for us.
    this.composer.reset(this.createRenderTarget());
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width, this.height);
  }

  private createRenderTarget(): THREE.WebGLRenderTarget {
    this.activeSamples = this.effectiveSamples();
    const rt = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(this.width * this.pixelRatio)),
      Math.max(1, Math.round(this.height * this.pixelRatio)),
      { type: THREE.HalfFloatType, samples: this.activeSamples },
    );
    rt.texture.name = 'PostChain.rt';
    return rt;
  }

  private applyAspect(): void {
    const aspect = this.width / Math.max(1, this.height);
    this.grade.uniforms.uAspect.value = aspect;
    // Corner distance of length(centred * (aspect,1)) — normalise so d == 1 there.
    const corner = Math.sqrt(0.25 * aspect * aspect + 0.25);
    this.grade.uniforms.uVigScale.value = corner > 0 ? 1 / corner : 1;
  }
}
