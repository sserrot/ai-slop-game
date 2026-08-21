/**
 * src/alien/skin.ts — the road out of procedural geometry (BACKLOG B-08, §9 M8).
 *
 * `alienView.ts` builds the creature out of cylinders and poses it with IK, and
 * that is the right answer right up until somebody actually sculpts it. This is
 * the seam where a sculpted one arrives: a glTF binary with a skeleton and
 * baked clips, loaded through `GLTFLoader` — which ships inside the `three`
 * package, so **there is no new dependency here and there never needs to be**.
 * "Do I need another library for better models" has a one-word answer, and the
 * word is no. What you need is Blender.
 *
 * Nothing in the game requires this file. No asset exists yet;
 * `AlienView.adoptSkin()` is opt-in and everything degrades to the procedural
 * body if the load fails, the file is missing, or the GLB does not satisfy the
 * contract below. That is deliberate: DESIGN.md §5 says the alien is a capsule
 * until the game is proven fun and means it, and an art pipeline that can break
 * the build is an art pipeline that will.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AUTHORING CONTRACT
 *
 * Export one `.glb` from Blender containing:
 *
 *   1. **One skinned mesh.** Triangles only. `POLY_BUDGETS.alien` still applies
 *      — 600 to 1500 — and it is not a suggestion: this creature is drawn
 *      through fog by a 5 candela torch and the budget goes on ANIMATION, per
 *      the asset bible. Decimate hard.
 *   2. **No materials worth keeping.** Whatever you export is discarded and
 *      replaced with `FleshMaterial`, so that the sculpt inherits the
 *      subsurface, rim and skin detail rather than arriving with a baked look
 *      that fights the station's lighting. Author your normal detail INTO the
 *      mesh or accept the procedural bump; do not ship a texture set expecting
 *      it to survive.
 *   3. **No emissive, no eyes.** The two rules that are not negotiable, for the
 *      reasons in `alienView.ts`'s header. `assertInert` runs on the loaded
 *      scene exactly as it runs on the procedural one.
 *   4. **Clips named for states**, from {@link SKIN_CLIPS}: `iss/dormant`,
 *      `iss/patrol`, `iss/investigate`, `iss/search`, `iss/hunt`, `iss/attack`,
 *      `iss/retreat` and `iss/rail-pull`. Missing clips fall back to
 *      `iss/patrol`; a missing `iss/patrol` is a hard failure.
 *   5. **Root motion baked OUT.** Animate in place. The server owns the
 *      transform (§7) and a clip that translates the root will fight it.
 *   6. **A declared stride per locomotion clip** — see {@link SKIN_STRIDE_KEY}.
 *      This is the one thing an animator has to write down and it is the one
 *      thing that decides whether the sculpt skates. Read on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY STRIDE, AND WHY IT IS NOT OPTIONAL
 *
 * The procedural body cannot skate, because `alienView.ts` derives its stance
 * travel from the same measured speed that drives its cadence — the feet cover
 * exactly the metres the body covers, arithmetically, at any speed.
 *
 * A baked clip has no such property. It plays at whatever rate you tell it to,
 * and if that rate does not match the ground speed the creature moonwalks. The
 * fix is the same equation: play the clip at
 *
 *     timeScale = speed / (strideMetres / clipDuration)
 *
 * so one loop of the clip always covers exactly the distance the body covered
 * during it. `strideMetres` is how far the feet carry the body through ONE
 * cycle of the clip, measured in Blender, and it is the animator's job to
 * measure it. Get it wrong by 10% and the creature slides 10%, forever, at
 * every speed — which is the specific defect that makes cheap game monsters
 * look cheap.
 */

import * as THREE from 'three';
import type { AlienState, GravityMode } from '@shared/types';
import { assertInert } from '../station/artKit';
import { FleshMaterial } from './flesh';
import { POLY_BUDGETS, triangleCount } from '../station/artKit';

/** Clip names the loader looks for, per §5 state, plus the vacuum locomotion. */
export const SKIN_CLIPS: Readonly<Record<AlienState | 'RAIL', string>> = Object.freeze({
  DORMANT: 'iss/dormant',
  PATROL: 'iss/patrol',
  INVESTIGATE: 'iss/investigate',
  SEARCH: 'iss/search',
  HUNT: 'iss/hunt',
  ATTACK: 'iss/attack',
  RETREAT: 'iss/retreat',
  RAIL: 'iss/rail-pull',
});

/**
 * Key on a clip's glTF `extras` holding its stride in metres — how far one loop
 * carries the body. In Blender: a Custom Property on the Action, exported with
 * "Custom Properties" ticked.
 *
 * Absent, the clip is treated as non-locomotive and plays at 1×, which is right
 * for `iss/dormant` and wrong for everything that moves.
 */
export const SKIN_STRIDE_KEY = 'issStrideM';

/** s — crossfade between clips. Long enough to read as the animal changing its
 *  mind, short enough that the player is not acting on stale information; the
 *  same reasoning, and roughly the same number, as `POSTURE_RATE`. */
const CROSSFADE_S = 0.3;

export class AlienSkinError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(`the alien GLB does not satisfy the contract:\n  - ${failures.join('\n  - ')}`);
    this.name = 'AlienSkinError';
    this.failures = failures;
  }
}

export interface AlienSkinOptions {
  /** Cast into §9's one shadow map. Match whatever the view is doing. */
  castShadow?: boolean;
  /** Replace the GLB's materials with the flesh shader. Default true, and see
   *  contract rule 2 before turning it off. */
  flesh?: boolean;
  /** Stride overrides by clip name, for a GLB whose actions carry no
   *  `issStrideM` extra. Prefer fixing the export. */
  strideM?: Readonly<Record<string, number>>;
}

/**
 * A loaded, skinned alien: the mesh, its skeleton, and a mixer driven by the
 * same `AlienState` the procedural body reads.
 */
export class AlienSkin {
  readonly object3D: THREE.Object3D;
  readonly triangles: number;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly strides = new Map<string, number>();
  private readonly flesh: FleshMaterial | null;
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private _state: AlienState = 'DORMANT';
  private _gravity: GravityMode = 'nominal';
  private _speed = 0;

  constructor(
    root: THREE.Object3D,
    clips: readonly THREE.AnimationClip[],
    opts: AlienSkinOptions = {},
  ) {
    this.object3D = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.flesh = opts.flesh === false ? null : new FleshMaterial();

    let tris = 0;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      tris += triangleCount(mesh.geometry);
      mesh.castShadow = opts.castShadow ?? false;
      mesh.receiveShadow = false;
      if (this.flesh) {
        // The exported material is dropped rather than tweaked. A sculpt that
        // arrives with its own PBR set would light differently from the rest of
        // the creature's history and, worse, differently from the station.
        disposeMaterial(mesh.material);
        mesh.material = this.flesh.material;
      }
    });
    this.triangles = tris;

    for (const clip of clips) {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      this.actions.set(clip.name, action);
      const stride = readStride(clip, opts.strideM);
      if (stride !== null) this.strides.set(clip.name, stride);
    }
  }

  get state(): AlienState {
    return this._state;
  }

  /** Clip names the GLB actually shipped. Worth logging at boot. */
  get clipNames(): readonly string[] {
    return [...this.actions.keys()];
  }

  setState(state: AlienState): void {
    this._state = state;
    this.selectClip();
  }

  setGravity(mode: GravityMode): void {
    this._gravity = mode;
    this.selectClip();
  }

  /** m/s off the interpolated transform. Drives `timeScale`; see the header. */
  setSpeed(speed: number): void {
    this._speed = speed;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.flesh?.update(dt);
    const stride = this.strides.get(this.currentName);
    if (this.current && stride !== undefined && stride > 1e-4) {
      const clipMetresPerSecond = stride / Math.max(1e-4, this.current.getClip().duration);
      // Clamped below at a crawl rather than at zero: a locomotion clip frozen
      // solid reads as a hitch, and §5 wants a stationary SEARCH to still be
      // doing something. Above, at 3× so a director speed change cannot turn
      // the animal into a blur.
      this.current.timeScale = Math.min(3, Math.max(0.08, this._speed / clipMetresPerSecond));
    } else if (this.current) {
      this.current.timeScale = 1;
    }
    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object3D);
    this.object3D.removeFromParent();
    this.object3D.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh === true) mesh.geometry.dispose();
    });
    this.flesh?.dispose();
  }

  private selectClip(): void {
    // Vacuum overrides the state clip: §5's one genuinely nice property is that
    // the same creature hauls along the same rails you do, and that is a
    // different animation regardless of what it is feeling.
    const wanted =
      this._gravity === 'zero' && this.actions.has(SKIN_CLIPS.RAIL)
        ? SKIN_CLIPS.RAIL
        : SKIN_CLIPS[this._state];
    const name = this.actions.has(wanted) ? wanted : SKIN_CLIPS.PATROL;
    if (name === this.currentName) return;
    const next = this.actions.get(name);
    if (!next) return;
    next.reset().setEffectiveWeight(1).play();
    if (this.current) this.current.crossFadeTo(next, CROSSFADE_S, false);
    this.current = next;
    this.currentName = name;
  }
}

function disposeMaterial(m: THREE.Material | THREE.Material[] | undefined): void {
  if (!m) return;
  for (const one of Array.isArray(m) ? m : [m]) one.dispose();
}

function readStride(
  clip: THREE.AnimationClip,
  overrides: Readonly<Record<string, number>> | undefined,
): number | null {
  const override = overrides?.[clip.name];
  if (typeof override === 'number') return override;
  // GLTFLoader hangs glTF `extras` off `userData` on everything it creates.
  const extras = (clip as unknown as { userData?: Record<string, unknown> }).userData;
  const v = extras?.[SKIN_STRIDE_KEY];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Load a GLB and check it against the contract.
 *
 * `GLTFLoader` is imported DYNAMICALLY, the way `main.ts` treats rapier: it is
 * a few tens of kilobytes that every player downloads and nobody uses until the
 * art pass lands, and there is no reason for it to sit in the first-paint
 * bundle before then.
 *
 * Throws {@link AlienSkinError} listing every problem at once rather than the
 * first — an animator fixing an export one exception at a time is an animator
 * doing eight round trips through Blender.
 */
export async function loadAlienSkin(
  url: string,
  opts: AlienSkinOptions = {},
): Promise<AlienSkin> {
  // `three/addons/*` and `three/examples/jsm/*` resolve to the SAME file, and
  // the codebase uses the former everywhere else. That is not cosmetic: vite's
  // dependency optimiser keys on the specifier STRING, so two spellings of one
  // module become two pre-bundled entries and, transitively, two copies of
  // three's core. See `optimizeDeps` in vite.config.ts.
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;

  const failures: string[] = [];
  let skinned = 0;
  let tris = 0;
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if ((mesh as unknown as THREE.Mesh).isMesh !== true) return;
    if (mesh.isSkinnedMesh) skinned++;
    tris += triangleCount((mesh as unknown as THREE.Mesh).geometry);
  });

  if (skinned === 0) {
    failures.push(
      'no skinned mesh — export the mesh WITH its armature, or there is nothing for the ' +
        'clips to drive',
    );
  }
  const band = POLY_BUDGETS.alien;
  if (tris > band.max) {
    failures.push(
      `${tris} triangles is over the ${band.max} ceiling (POLY_BUDGETS.alien). This creature ` +
        'is seen through fog by a 5 candela torch; decimate hard and spend it on animation',
    );
  }
  const names = new Set(gltf.animations.map((c) => c.name));
  if (!names.has(SKIN_CLIPS.PATROL)) {
    failures.push(
      `no "${SKIN_CLIPS.PATROL}" clip — it is the fallback every other state degrades to, ` +
        `so it is the one clip that cannot be missing. Found: ${[...names].join(', ') || 'none'}`,
    );
  }
  if (failures.length > 0) throw new AlienSkinError(failures);

  const skin = new AlienSkin(root, gltf.animations, opts);
  // The same promise the procedural body makes, checked the same way. A sculpt
  // that arrives with a glowing anything devalues every amber dot in the game.
  assertInert(root, 'the alien skin (ISS-CHR-01)');
  skin.setState('DORMANT');
  return skin;
}

/**
 * Load a skin if one is there, and shrug if not.
 *
 * The form every caller in the game should use. A missing or broken GLB must
 * cost the player a less interesting monster and nothing else — never a black
 * screen, and never a round that will not start.
 */
export async function tryLoadAlienSkin(
  url: string | null | undefined,
  opts: AlienSkinOptions = {},
): Promise<AlienSkin | null> {
  if (!url) return null;
  try {
    return await loadAlienSkin(url, opts);
  } catch (err) {
    console.warn(
      `[alien] no sculpted skin at ${url}; falling back to the procedural body.`,
      err instanceof AlienSkinError ? `\n${err.message}` : err,
    );
    return null;
  }
}
