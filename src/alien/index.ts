/**
 * src/alien — the client-side alien (DESIGN.md §5).
 *
 * The AI itself is server-authoritative and lives in `server/sim/alien.ts`.
 * Nothing here decides anything: it draws the body the server tells it to draw,
 * animates it into the gait the server's state implies, and swells the hunt bed
 * when the server says HUNT.
 *
 * The body is `AlienView` (ISS-CHR-01) — 972 triangles in eight instanced draw
 * calls, with a walk cycle for `nominal` modules and a rail-pull for `zero`
 * ones. Read that file before touching this one: the gait is the state readout
 * the player's life depends on, and it is the only readout, because the asset
 * carries no emissive at all.
 *
 * Four files, and it is worth knowing which does what before you go looking:
 *
 *   • `alienView.ts` — the body, the posture table, and the secondary motion
 *     (sprung tail and head, hold-and-snap scan, breath) that is most of the
 *     difference between an articulated prop and something you do not want to
 *     be in a room with.
 *   • `ik.ts` — analytic two-bone IK. All four limbs are solved to authored
 *     CONTACTS rather than posed by hand, which is what makes it impossible for
 *     the feet to slide at any speed.
 *   • `flesh.ts` — the one material in the game that is not a palette row.
 *     Subsurface wrap, a grazing rim, procedural skin detail. Nothing glows.
 *
 * The two extra draw calls over r3's six are the TAIL, which used to be baked
 * into the abdomen and now hangs off its own sprung joint, and the SHIN, which
 * used to be baked into the thigh and now has a knee the IK can solve. Neither
 * added a triangle: 972 before, 972 after.
 *
 *     const alien = new AlienProxy({
 *       materials: station.materials,
 *       gravityOf: (m) => station.moduleGravity(m),
 *       listener: () => camera.position,
 *       cullByModule: true,
 *     });
 *     scene.add(alien.object3D);
 *     // when the room state changes:
 *     alien.applySnapshot({ pos, quat, state, module });
 *     // every frame:
 *     ticker.onRender((alpha, dt) => alien.update(alpha, dt));
 */

import type { AlienSnapshot, GravityMode, ModuleId, Vec3 } from '@shared/types';
import { AlienView } from './alienView';
import type { AlienViewOptions } from './alienView';
import { AlienHuntEmitter } from './alienAudio';
import type { AlienAudioSink } from './alienAudio';
import { bus } from '../core/eventBus';

export * from './alienView';
export * from './alienAudio';
export * from './flesh';
export { solveTwoBone, twoBoneOut, twoBoneTip, BONE_REST } from './ik';
export type { TwoBoneOut } from './ik';

export interface AlienProxyOptions extends AlienViewOptions {
  /** Hunt-bed sink from `src/audio/`. Optional — the view works without audio. */
  sink?: AlienAudioSink | null;
  /** Listener position, for hunt-bed intensity and the proximity event. */
  listener?: () => Vec3 | null;
  /** Emit `alien:proximity` for the wrist tracker (§6). Off by default so it
   *  cannot double up with the net layer; turn it on if nobody else does it. */
  emitProximity?: boolean;
  /** Hops between the listener's module and the alien's, for `alien:proximity`.
   *  Supply it from the station's ModuleGraph; -1 when unknown. */
  hops?: (from: ModuleId, to: ModuleId) => number;
  /** Module the local player is in, for the hop count. */
  listenerModule?: () => ModuleId | null;
  /** Seconds between `alien:proximity` emissions. The tracker only needs a
   *  pulse rate, not a stream. */
  proximityIntervalS?: number;
}

/**
 * View + hunt audio in one object, which is all the client needs to know about
 * the alien.
 */
export class AlienProxy {
  readonly view: AlienView;
  readonly audio: AlienHuntEmitter;

  private readonly listener: (() => Vec3 | null) | null;
  private readonly listenerModule: (() => ModuleId | null) | null;
  private readonly hops: ((from: ModuleId, to: ModuleId) => number) | null;
  private readonly emitProximity: boolean;
  private readonly proximityIntervalS: number;
  private proximityTimer = 0;

  constructor(opts: AlienProxyOptions = {}) {
    this.view = new AlienView(opts);
    this.audio = new AlienHuntEmitter({
      sink: opts.sink ?? null,
      listener: opts.listener,
    });
    this.listener = opts.listener ?? null;
    this.listenerModule = opts.listenerModule ?? null;
    this.hops = opts.hops ?? null;
    this.emitProximity = opts.emitProximity ?? false;
    this.proximityIntervalS = opts.proximityIntervalS ?? 0.25;
  }

  /** The thing to `scene.add()`. */
  get object3D() {
    return this.view.object3D;
  }

  /** Eight, and constant. Worth knowing when you are counting §9's budget. */
  get drawCalls(): number {
    return this.view.drawCalls;
  }

  /** Triangles the body costs while visible. */
  get triangles(): number {
    return this.view.triangles;
  }

  /** Which locomotion it is using right now. */
  get gravity(): GravityMode {
    return this.view.gravity;
  }

  /** Feed the networked alien record (§7). */
  applySnapshot(snapshot: AlienSnapshot): void {
    this.view.applySnapshot(snapshot);
  }

  /**
   * Tell it which floor it is on (§4). Only needed when `gravityOf` was not
   * supplied — with it, `applySnapshot` resolves this on every module change,
   * including a §5 director floor drop, which mutates `StationModule.gravity`
   * in place and therefore needs no extra wiring at all.
   */
  setGravity(mode: GravityMode): void {
    this.view.setGravity(mode);
  }

  /** Swap in the real audio sink once `src/audio/` is up. */
  setSink(sink: AlienAudioSink | null): void {
    this.audio.setSink(sink);
  }

  /** Restrict drawing to the two-hop cull set (§2). */
  setVisibleModules(modules: readonly ModuleId[] | null): void {
    this.view.setVisibleModules(modules);
  }

  /** One frame: interpolate, animate, then drive the hunt bed from what is on
   *  screen. `frameDt` must be real seconds — the gait is derived from it. */
  update(alpha: number, frameDt = 0): void {
    this.view.update(alpha, frameDt);
    const pos = this.view.positionVec3();
    this.audio.update(this.view.state, pos);
    if (!this.emitProximity) return;

    this.proximityTimer -= frameDt;
    if (this.proximityTimer > 0) return;
    this.proximityTimer = this.proximityIntervalS;
    const l = this.listener?.() ?? null;
    if (!l) return;
    const dx = pos.x - l.x;
    const dy = pos.y - l.y;
    const dz = pos.z - l.z;
    const metres = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const from = this.listenerModule?.() ?? null;
    const hops = from && this.hops ? this.hops(from, this.view.module) : -1;
    bus.emit('alien:proximity', { metres, hops });
  }

  dispose(): void {
    this.audio.dispose();
    this.view.dispose();
  }
}
