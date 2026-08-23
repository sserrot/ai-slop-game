/**
 * src/alien/alienGltf.ts — the authored alien body (ISS-CHR-02).
 *
 * `public/models/alien.glb` is the M8 asset: a rigged, animated body built by
 * `art/alien.py` (rebuild with `blender --background --python art/alien.py`).
 * This class mounts it WITHOUT replacing any of the machinery the game already
 * trusts: it wraps a procedural `AlienView` and delegates every piece of the
 * contract — the interpolated server transform, module culling, the gravity
 * blend, speed measurement — to it. The wrapper adds exactly one thing: once
 * the GLB arrives, the six instanced primitive parts are hidden and the
 * skinned mesh rides the same interpolated group, driven by clips.
 *
 * Why wrap instead of replace: the procedural body is also the FALLBACK. GLTF
 * loading is async and can fail (bad deploy, stripped public/); a horror game
 * where the monster silently fails to render is not degraded, it is broken.
 * Until `ready`, and forever if loading throws, the capsule-era body keeps
 * drawing — same transform, same cull set, zero seams.
 *
 * CLIP MAPPING (server state -> authored clip, DESIGN.md §5):
 *     gravity 'zero'         -> pull        (rail haul; the game's transform
 *                                            orients the body onto the rail —
 *                                            the clip is authored body-frame)
 *     DORMANT                -> idle_listen (ears sweep; teaches "no eyes")
 *     ATTACK                 -> lunge       (one-shot, clamped)
 *     HUNT / RETREAT         -> hunt        (the bound)
 *     everything else        -> prowl       (the stalk)
 *
 * CADENCE LOCK: `public/models/alien.meta.json` records each gait's authored
 * distance-per-cycle, measured at build time. timeScale = speed * duration /
 * stride, so a planted foot moves rearward through the body at exactly the
 * body's ground speed — the same ground-truth rule `alienView.ts` applies to
 * its procedural gait via ALIEN_STRIDE_M, honoured here per-clip. Speed comes
 * from the inner view's own transform-derived measurement, so the legs can
 * never disagree with the metres actually covered (§5: the server owns the
 * speeds and may retune them).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

import type {
  AlienSnapshot,
  AlienState,
  GravityMode,
  ModuleId,
  Quat,
  Vec3,
} from '@shared/types';
import { ALIEN_DECK_DROP_M, ALIEN_STRIDE_M, AlienView } from './alienView';
import type { AlienBody, AlienViewOptions } from './alienView';
import type { Unsubscribe } from '../core/eventBus';
import { assertInert, triangleCount } from '../station/artKit';
import {
  GLB_URL,
  META_URL,
  cadenceFactor,
  clipTimeScale,
} from './cadence';
import type { AlienMeta } from './cadence';

/** Cross-fade between clips. Snapping between gaits reads as a glitch, and §5
 *  turned "no visual glitches on state changes" into a rule. */
const FADE_S = 0.25;

/** Soft ceiling for the authored body. Not artKit's POLY_BUDGETS.alien band —
 *  that prices ISS-CHR-01's six primitive parts — but the same idea: an art
 *  rebuild must not silently ship a heavyweight monster. */
const GLTF_TRIANGLE_BUDGET = 4000;

/** Visual scale on the authored body. The asset stays canonical (2.4 m, the
 *  procedural body's own length) and the game scales it — so the sidecar's
 *  measured strides scale with it (see `chooseClip`), and the art build never
 *  needs to know. Server collision is untouched: the creature LOOKS 15%
 *  bigger; its contact radius is still ALIEN_RADIUS. */
const GLTF_BODY_SCALE = 1.15;

export class AlienGltfView implements AlienBody {
  /** The procedural body underneath — fallback renderer and single owner of
   *  the transform/cull/gravity contract. */
  readonly inner: AlienView;

  /** Resolves once the GLB swap has happened — or immediately on load failure,
   *  in which case the procedural body simply keeps drawing. `main.ts` awaits
   *  this before the pre-warm so (a) the skinned program compiles behind the
   *  menu instead of hitching on the monster's first sighting, and (b) the
   *  swap cannot race the pre-warm's visibility save/restore, which is how the
   *  game once drew two overlapping aliens. */
  readonly whenReady: Promise<void>;

  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private meta: AlienMeta | null = null;
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private gltfGroup: THREE.Group | null = null;
  private gltfTriangles = 0;
  private gltfDrawCalls = 0;
  /** speed -> timeScale factor for the active clip, refreshed on clip change. */
  private cadence = 0;
  private disposed = false;

  constructor(opts: AlienViewOptions = {}) {
    this.inner = new AlienView(opts);
    this.whenReady = this.load(opts.castShadow ?? false);
  }

  /** True once the skinned body has replaced the procedural one. */
  get ready(): boolean {
    return this.gltfGroup !== null;
  }

  // -- contract delegation --------------------------------------------------

  get object3D(): THREE.Group {
    return this.inner.object3D;
  }

  get state(): AlienState {
    return this.inner.state;
  }

  get module(): ModuleId {
    return this.inner.module;
  }

  get gravity(): GravityMode {
    return this.inner.gravity;
  }

  get speed(): number {
    return this.inner.speed;
  }

  get hunting(): boolean {
    return this.inner.hunting;
  }

  get position(): THREE.Vector3 {
    return this.inner.position;
  }

  get drawCalls(): number {
    return this.ready ? this.gltfDrawCalls : this.inner.drawCalls;
  }

  get triangles(): number {
    return this.ready ? this.gltfTriangles : this.inner.triangles;
  }

  positionVec3(): Vec3 {
    return this.inner.positionVec3();
  }

  distanceTo(pos: Vec3): number {
    return this.inner.distanceTo(pos);
  }

  attachToBus(): Unsubscribe {
    return this.inner.attachToBus();
  }

  detachFromBus(): void {
    this.inner.detachFromBus();
  }

  applySnapshot(snapshot: AlienSnapshot): void {
    this.inner.applySnapshot(snapshot);
  }

  setTransform(pos: Vec3, quat?: Quat): void {
    this.inner.setTransform(pos, quat);
  }

  setState(state: AlienState): void {
    this.inner.setState(state);
  }

  setModule(module: ModuleId): void {
    this.inner.setModule(module);
  }

  setGravity(mode: GravityMode): void {
    this.inner.setGravity(mode);
  }

  setVisibleModules(modules: readonly ModuleId[] | null): void {
    this.inner.setVisibleModules(modules);
  }

  update(alpha: number, frameDt = 0): void {
    this.inner.update(alpha, frameDt);
    if (!this.mixer || !this.gltfGroup || frameDt <= 0) return;
    // Culled: the inner view has hidden the whole group, so skip posing a
    // 36-bone rig nobody can see — in a six-player round the alien is
    // invisible to most players for most frames, and the mixer was the
    // largest recurring cost in this file. The gait resumes from its last
    // pose on the frame it re-enters the cull set.
    if (!this.inner.object3D.visible) return;
    this.chooseClip();
    if (this.current) this.current.timeScale = clipTimeScale(this.cadence, this.inner.speed);
    this.mixer.update(frameDt);
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
    if (this.gltfGroup) {
      this.gltfGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) m.dispose();
        }
      });
      this.gltfGroup.removeFromParent();
      this.gltfGroup = null;
    }
    this.inner.dispose();
  }

  // -- loading --------------------------------------------------------------

  private async load(castShadow: boolean): Promise<void> {
    let gltf: GLTF;
    try {
      [gltf, this.meta] = await Promise.all([
        new GLTFLoader().loadAsync(GLB_URL),
        fetch(META_URL)
          .then((r) => (r.ok ? (r.json() as Promise<AlienMeta>) : null))
          .catch(() => null),
      ]);
    } catch (err) {
      // The procedural body is still drawing; say so and stop.
      console.warn('[alien] GLB load failed — procedural body stays:', err);
      return;
    }
    if (this.disposed) return;
    if (!this.meta) {
      console.warn(
        `[alien] ${META_URL} missing — cadence falls back to ALIEN_STRIDE_M`,
      );
    }

    const group = new THREE.Group();
    group.name = 'alien-gltf';
    // The GLB is authored with its feet on the deck at y=0 and the spine at
    // the 0.45 m ride height; the server transform (and therefore
    // `inner.object3D`) is the BODY CENTRE at DECK + ALIEN_DECK_DROP_M. One
    // constant offset centres the authored spine on the transform in both
    // gravities.
    group.position.y = -ALIEN_DECK_DROP_M;
    // Scaled about the GLB's own origin, which is at the FEET — so the feet
    // stay on the deck and the body grows upward and outward.
    gltf.scene.scale.setScalar(GLTF_BODY_SCALE);
    group.add(gltf.scene);

    let tris = 0;
    let draws = 0;
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      draws += 1;
      tris += triangleCount(mesh.geometry);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      // Skinned bounds go stale as the mixer poses the skeleton; culling is
      // already handled per-module by the inner view.
      mesh.frustumCulled = false;
    });
    this.gltfTriangles = Math.round(tris);
    this.gltfDrawCalls = draws;
    if (this.gltfTriangles > GLTF_TRIANGLE_BUDGET) {
      console.warn(
        `[alien] GLB is ${this.gltfTriangles} triangles ` +
          `(budget ${GLTF_TRIANGLE_BUDGET}) — did an art rebuild balloon it?`,
      );
    }
    // §5/§9: the body carries no emissive on purpose — a glow would be visible
    // with the torch off, through fog, at any range. Same check the procedural
    // parts pass.
    assertInert(gltf.scene, 'alien-gltf');

    this.mixer = new THREE.AnimationMixer(gltf.scene);
    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip);
      if (clip.name === 'lunge') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(clip.name, action);
    }

    // Hand the body off. `setExternalBody` flushes the six instanced parts to
    // ZERO INSTANCES — not merely invisible — so nothing can resurrect them,
    // not even a blanket `visible = true` sweep. Cull/visibility still toggles
    // the PARENT, so the inner view's rules keep applying to the skin.
    this.inner.setExternalBody(true);
    this.inner.object3D.add(group);
    this.gltfGroup = group;

    this.chooseClip(true);
    console.log(
      `[alien] gltf body ready: ${this.gltfDrawCalls} draw calls, ` +
        `${this.gltfTriangles} triangles, clips [${[...this.actions.keys()].join(', ')}]`,
    );
  }

  // -- clips ----------------------------------------------------------------

  private wantedClip(): string {
    const state = this.inner.state;
    if (state === 'ATTACK') return 'lunge';
    if (this.inner.gravity === 'zero') return 'pull';
    if (state === 'DORMANT') return 'idle_listen';
    if (state === 'HUNT' || state === 'RETREAT') return 'hunt';
    return 'prowl';
  }

  private chooseClip(hard = false): void {
    const want = this.wantedClip();
    if (want === this.currentName) return;
    const next = this.actions.get(want);
    if (!next) return;
    if (this.current && !hard) this.current.fadeOut(FADE_S);
    next.reset();
    if (hard) next.play();
    else next.fadeIn(FADE_S).play();
    this.current = next;
    this.currentName = want;
    // Cadence constants only change with the clip; fold them here so the
    // per-frame path is one multiply and a clamp. Without a sidecar entry
    // (one-shots like lunge, or a missing meta file) fall back to the
    // procedural body's own stride constant rather than dropping the lock.
    // The visual scale stretches every stride by the same factor, so the
    // seconds-per-metre factor shrinks by it — feet stay ground-true.
    this.cadence =
      (cadenceFactor(this.meta, want) ??
        next.getClip().duration / ALIEN_STRIDE_M) / GLTF_BODY_SCALE;
  }

}
