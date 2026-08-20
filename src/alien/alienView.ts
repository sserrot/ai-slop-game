/**
 * The alien's client-side body (DESIGN.md §5 / §9).
 *
 * **Through M4–M7 the alien is a capsule.** "A scary audio source with a sphere
 * for a body is genuinely enough — horror lives in audio and lighting."
 * Animation and the long, thin, pale rail-puller are M8 work, and if M8 never
 * happens the game still works. So: one capsule, one material, no skeleton.
 *
 * This is a pure view. It never simulates anything — the AI is
 * server-authoritative (§7) — it just interpolates the transform the server
 * sends and tints itself by state. Interpolate the alien and remote players
 * with the ticker's `alpha`; never the local player (§7).
 *
 *     const view = new AlienView();
 *     scene.add(view.object3D);
 *     room.state.alien.onChange(() => view.applySnapshot(readAlien(room.state)));
 *     ticker.onRender((alpha) => view.update(alpha));
 */

import * as THREE from 'three';
import type { AlienSnapshot, AlienState, ModuleId, Quat, Vec3 } from '@shared/types';
import { bus } from '../core/eventBus';
import type { Unsubscribe } from '../core/eventBus';

/**
 * m — capsule radius. Mirrors `ALIEN_RADIUS` in `server/sim/alien.ts`, which is
 * the contact range's half. Neither is a §14 constant; if you tune one, tune
 * both — the server decides who dies, this only decides what you see.
 */
export const ALIEN_VIEW_RADIUS = 0.45;

/** m — cylinder length between the caps. Long and thin (§9). */
export const ALIEN_VIEW_LENGTH = 1.6;

/** Above this many metres between two snapshots we assume a teleport and snap
 *  rather than sliding the capsule across the station. */
const TELEPORT_SNAP_M = 12;

export interface AlienViewOptions {
  radius?: number;
  length?: number;
  /** Base colour. Pale by design (§9). */
  color?: THREE.ColorRepresentation;
  emissive?: THREE.ColorRepresentation;
  /** Re-emit `alien:state` / `alien:moved` on the bus as snapshots arrive.
   *  Leave false when the net layer already emits them. */
  emitBusEvents?: boolean;
  /** Hide the capsule when its module is outside the two-hop cull set (§2). */
  cullByModule?: boolean;
}

interface Pose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

export class AlienView {
  /** Add this to the scene. */
  readonly object3D: THREE.Group;
  readonly mesh: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;

  private readonly prev: Pose;
  private readonly curr: Pose;
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();

  private _state: AlienState = 'DORMANT';
  private _module: ModuleId = '';
  private _hasPose = false;
  private readonly emitBusEvents: boolean;
  private readonly cullByModule: boolean;
  private visibleModules: Set<ModuleId> | null = null;
  private busUnsubs: Unsubscribe[] = [];
  private pulse = 0;

  constructor(opts: AlienViewOptions = {}) {
    const radius = opts.radius ?? ALIEN_VIEW_RADIUS;
    const length = opts.length ?? ALIEN_VIEW_LENGTH;

    const geometry = new THREE.CapsuleGeometry(radius, length, 6, 12);
    // The capsule's long axis is +Y; the sim's orientation maps forward onto
    // -Z (three.js convention), so lay the body down along its travel axis.
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshStandardMaterial({
      color: opts.color ?? 0xd8d2c6,
      emissive: opts.emissive ?? 0x1a0f12,
      emissiveIntensity: 1,
      roughness: 0.55,
      metalness: 0.05,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = false; // one shadow map in the budget, and it is the flashlight (§9)
    this.mesh.receiveShadow = false;

    this.object3D = new THREE.Group();
    this.object3D.name = 'alien';
    this.object3D.add(this.mesh);
    this.object3D.visible = false; // nothing to show until the first snapshot

    this.prev = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.curr = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
    this.emitBusEvents = opts.emitBusEvents ?? false;
    this.cullByModule = opts.cullByModule ?? false;
  }

  // -- reads ----------------------------------------------------------------

  get state(): AlienState {
    return this._state;
  }

  get module(): ModuleId {
    return this._module;
  }

  /** True while the server says it is hunting — what the audio hook keys off. */
  get hunting(): boolean {
    return this._state === 'HUNT' || this._state === 'ATTACK';
  }

  /** Interpolated world position, valid after `update()`. */
  get position(): THREE.Vector3 {
    return this.object3D.position;
  }

  /** Plain `{x,y,z}` copy, for anything in `shared/` (which never sees three). */
  positionVec3(): Vec3 {
    const p = this.object3D.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  distanceTo(pos: Vec3): number {
    return this.object3D.position.distanceTo(this.scratchPos.set(pos.x, pos.y, pos.z));
  }

  // -- network → view -------------------------------------------------------

  /** Feed one server snapshot (§7 `alien: { pos, quat, state }` + module). */
  applySnapshot(snapshot: AlienSnapshot): void {
    this.setTransform(snapshot.pos, snapshot.quat);
    this.setState(snapshot.state);
    this.setModule(snapshot.module);
  }

  /** Push a new authoritative transform; the previous one becomes the lerp
   *  start. Call once per received state update, not per frame. */
  setTransform(pos: Vec3, quat?: Quat): void {
    if (!this._hasPose) {
      this.curr.pos.set(pos.x, pos.y, pos.z);
      if (quat) this.curr.quat.set(quat.x, quat.y, quat.z, quat.w);
      this.prev.pos.copy(this.curr.pos);
      this.prev.quat.copy(this.curr.quat);
      this._hasPose = true;
      this.object3D.position.copy(this.curr.pos);
      this.object3D.quaternion.copy(this.curr.quat);
      this.object3D.visible = this.shouldBeVisible();
      return;
    }
    this.prev.pos.copy(this.curr.pos);
    this.prev.quat.copy(this.curr.quat);
    this.curr.pos.set(pos.x, pos.y, pos.z);
    if (quat) this.curr.quat.set(quat.x, quat.y, quat.z, quat.w);
    if (this.prev.pos.distanceTo(this.curr.pos) > TELEPORT_SNAP_M) {
      this.prev.pos.copy(this.curr.pos);
      this.prev.quat.copy(this.curr.quat);
    }
  }

  setState(state: AlienState): void {
    if (state === this._state) return;
    const from = this._state;
    this._state = state;
    this.applyStateLook();
    if (this.emitBusEvents) bus.emit('alien:state', { from, to: state });
  }

  setModule(module: ModuleId): void {
    if (module === this._module) return;
    this._module = module;
    if (this.emitBusEvents) {
      bus.emit('alien:moved', { pos: this.positionVec3(), module });
    }
    this.object3D.visible = this.shouldBeVisible();
  }

  /**
   * Restrict rendering to the §2 two-hop cull set. Pass null to always draw.
   * Only does anything when constructed with `cullByModule`.
   */
  setVisibleModules(modules: readonly ModuleId[] | null): void {
    this.visibleModules = modules ? new Set(modules) : null;
    this.object3D.visible = this.shouldBeVisible();
  }

  // -- per-frame ------------------------------------------------------------

  /**
   * Interpolate toward the latest snapshot. `alpha` comes from the ticker
   * (§7 — interpolate remote players and the alien).
   */
  update(alpha: number, frameDt = 0): void {
    if (!this._hasPose) return;
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    this.object3D.position.lerpVectors(this.prev.pos, this.curr.pos, a);
    this.scratchQuat.copy(this.prev.quat).slerp(this.curr.quat, a);
    this.object3D.quaternion.copy(this.scratchQuat);

    // A slow emissive breath while it hunts, so the capsule reads as alive even
    // before there is a model. Cheap: one uniform per frame.
    if (this.hunting && frameDt > 0) {
      this.pulse = (this.pulse + frameDt * 4.5) % (Math.PI * 2);
      this.mesh.material.emissiveIntensity = 1.6 + Math.sin(this.pulse) * 0.5;
    }
  }

  // -- bus wiring -----------------------------------------------------------

  /**
   * Optional convenience: drive the view straight off the event bus when the
   * net layer publishes `alien:moved` / `alien:state` instead of handing you
   * snapshots. Returns an unsubscribe function.
   */
  attachToBus(): Unsubscribe {
    this.detachFromBus();
    this.busUnsubs.push(
      bus.on('alien:moved', ({ pos, module }) => {
        this.setTransform(pos);
        this.setModule(module);
      }),
    );
    this.busUnsubs.push(
      bus.on('alien:state', ({ to }) => {
        this.setState(to);
      }),
    );
    this.busUnsubs.push(
      bus.on('cull:changed', ({ visible }) => {
        if (this.cullByModule) this.setVisibleModules(visible);
      }),
    );
    return () => this.detachFromBus();
  }

  detachFromBus(): void {
    for (const off of this.busUnsubs) off();
    this.busUnsubs = [];
  }

  dispose(): void {
    this.detachFromBus();
    this.object3D.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  // -- internals ------------------------------------------------------------

  private shouldBeVisible(): boolean {
    if (!this._hasPose) return false;
    // Culling is geometry, not behaviour: a DORMANT alien three modules away is
    // still behind two bulkheads, and drawing it anyway is a wall-hack for the
    // first fifteen seconds of every round (§2's two-hop set is the whole rule).
    if (!this.cullByModule || !this.visibleModules) return true;
    return this.visibleModules.has(this._module);
  }

  private applyStateLook(): void {
    const mat = this.mesh.material;
    switch (this._state) {
      case 'HUNT':
      case 'ATTACK':
        mat.emissive.setHex(0x5a0d12);
        mat.emissiveIntensity = 1.8;
        break;
      case 'SEARCH':
      case 'INVESTIGATE':
        mat.emissive.setHex(0x2a1418);
        mat.emissiveIntensity = 1.2;
        break;
      case 'RETREAT':
        mat.emissive.setHex(0x151a22);
        mat.emissiveIntensity = 0.9;
        break;
      default:
        mat.emissive.setHex(0x1a0f12);
        mat.emissiveIntensity = 1;
        break;
    }
    this.object3D.visible = this.shouldBeVisible();
  }
}
