/**
 * Hiding — the genre verb DESIGN.md r1 and r2 left out (§4).
 *
 * "Every ancestor of this game is built on the moment where you are three feet
 * from the thing with a locker door between you, and the old document's only
 * answer to 'it's coming' was 'move faster'." The walking pivot is what makes
 * this buildable: a floor means a locker is something a body can climb INTO.
 *
 * BECAUSE THE ALIEN IS BLIND, HIDING IS NOT ABOUT BEING UNSEEN. There is no
 * sight logic in this file, none in `@shared/graph/hideSpots`, and none anywhere
 * in this codebase. Hiding is exactly two things, and this class implements the
 * player's half of both:
 *
 *   1. NOT BEING SWEPT THROUGH. The hide volume is geometry the alien routes
 *      around (`HideSpotGraph.sweepBlocked`), and the occupant sits at its
 *      centre so that test means something.
 *   2. STAYING QUIET. The shell takes `muffleDb` off everything the occupant
 *      emits — additively, exactly like a hatch offset. That is the entire
 *      implementation, and it is deliberately not enough to hide panicked
 *      breathing from something leaning on the door.
 *
 * GETTING IN COSTS NOISE AND HASTE SETS THE PRICE — §11's loud-fast /
 * quiet-slow rule applied to a movement verb. Haste comes from the GAIT you are
 * holding, so the risk dial the player already learned prices this too: crouch
 * in over `HIDE_ENTER_TIME_SLOW_S` at `HIDE_QUIET`, or sprint in over
 * `HIDE_ENTER_TIME_FAST_S` at `HIDE_LOUD`. §14 asserts the careful entry does
 * not fit inside the time a HUNT needs to cross a module, so hiding late cannot
 * be bought; hiding EARLY is the skilled play.
 *
 * The noise is emitted at the START of an entry, not at the end. A player who is
 * heard climbing in has to live with it, and a 2.5 s silent climb followed by a
 * bang would give the careful option a burst of loudness precisely when it had
 * finished being careful.
 */

import * as THREE from 'three';
import { clamp, hideEnterSeconds } from '@shared/constants';
import type { Gait, HideSpotKey } from '@shared/types';
import type { HideVolume } from '@shared/graph/hideSpots';
import { HIDE_HASTE_CROUCH, HIDE_HASTE_SPRINT, HIDE_HASTE_WALK } from './tuning';
import { UP } from './walk';

/**
 * `none` — walking around. `entering` / `exiting` — committed, no locomotion
 * input is read. `hidden` — in the box.
 */
export type HidePhase = 'none' | 'entering' | 'hidden' | 'exiting';

/** What `update()` reports happened this step. */
export type HideEvent = 'none' | 'entered' | 'exited';

const _mat = new THREE.Matrix4();
const _eye = new THREE.Vector3(0, 0, 0);
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _lerp = new THREE.Vector3();
const _slerp = new THREE.Quaternion();
/** A body wedged in a locker still lives under the one global down (§4), so the
 *  reference up for these orientations is STATION_UP and never a module's. */
const _fallbackUp = new THREE.Vector3(1, 0, 0);

/** The haste a gait implies. Crouch is free and slow, sprint is a loud dive. */
export function hasteForGait(gait: Gait): number {
  switch (gait) {
    case 'crouch':
      return HIDE_HASTE_CROUCH;
    case 'sprint':
      return HIDE_HASTE_SPRINT;
    default:
      return HIDE_HASTE_WALK;
  }
}

/** Smoothstep, so climbing in eases rather than ramps linearly. */
function ease(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * The player's occupancy of one hide spot: the timed climb in, the stay, and the
 * timed climb out.
 *
 * Owns the POSE during the transitions — the body slides from the entry point
 * into the box and the view turns to the spot's authored `lookDir` — so the
 * whole thing reads as getting into a locker rather than as a teleport.
 */
export class HideController {
  private _phase: HidePhase = 'none';
  private _volume: HideVolume | null = null;
  private _haste = 0;
  private _elapsed = 0;
  private _duration = 0;

  private readonly fromPos = new THREE.Vector3();
  private readonly toPos = new THREE.Vector3();
  private readonly fromQuat = new THREE.Quaternion();
  private readonly toQuat = new THREE.Quaternion();

  get phase(): HidePhase {
    return this._phase;
  }

  /** True whenever locomotion input must be ignored — committed or inside. */
  get busy(): boolean {
    return this._phase !== 'none';
  }

  /** True only while actually in the box (`PlayerState` is then `HIDDEN`). */
  get inside(): boolean {
    return this._phase === 'hidden';
  }

  get volume(): HideVolume | null {
    return this._volume;
  }

  get key(): HideSpotKey | null {
    return this._volume ? this._volume.key : null;
  }

  /** NEGATIVE dB the shell takes off everything the occupant emits. 0 when the
   *  player is not in a spot, so `muffledLoudness` becomes a no-op. */
  get muffleDb(): number {
    return this._volume && this._phase !== 'none' ? this._volume.muffleDb : 0;
  }

  /** 0–1 through the current climb; 1 while inside, 0 while out. */
  get progress(): number {
    if (this._phase === 'hidden') return 1;
    if (this._phase === 'none' || this._duration <= 0) return 0;
    return clamp(this._elapsed / this._duration, 0, 1);
  }

  get haste(): number {
    return this._haste;
  }

  /**
   * Start climbing in. `fromPos` / `fromQuat` are the body's pose right now, so
   * the climb starts from wherever the player actually was rather than snapping
   * them to the authored entry point first.
   */
  enter(
    volume: HideVolume,
    haste: number,
    fromPos: THREE.Vector3,
    fromQuat: THREE.Quaternion,
  ): boolean {
    if (this._phase !== 'none') return false;
    this._volume = volume;
    this._haste = clamp(haste, 0, 1);
    this._elapsed = 0;
    this._duration = hideEnterSeconds(this._haste);
    this._phase = 'entering';
    this.fromPos.copy(fromPos);
    this.fromQuat.copy(fromQuat);
    this.toPos.set(volume.centre.x, volume.centre.y, volume.centre.z);
    this.toQuat.copy(lookQuat(volume));
    return true;
  }

  /** Start climbing out. Same rule, same price: the gait you leave in is what
   *  it costs, so bailing out at a sprint is as loud as diving in. */
  exit(haste: number): boolean {
    if (this._phase !== 'hidden') return false;
    const volume = this._volume;
    if (!volume) return false;
    this._haste = clamp(haste, 0, 1);
    this._elapsed = 0;
    this._duration = hideEnterSeconds(this._haste);
    this._phase = 'exiting';
    this.fromPos.set(volume.centre.x, volume.centre.y, volume.centre.z);
    this.fromQuat.copy(this.toQuat);
    this.toPos.set(volume.entry.x, volume.entry.y, volume.entry.z);
    // Face back out the way you came, which is the reverse of the way in.
    this.toQuat.copy(outQuat(volume));
    return true;
  }

  /**
   * Abandon a climb that is still in progress and go back where it started.
   *
   * Deliberately free: the noise was already paid at the start of the entry, and
   * charging again for changing your mind halfway would make the careful option
   * a commitment rather than a choice.
   */
  cancel(): boolean {
    if (this._phase !== 'entering' && this._phase !== 'exiting') return false;
    // Reverse the same climb, at the same haste, from wherever it got to.
    const t = ease(this.progress);
    const wasEntering = this._phase === 'entering';
    _lerp.copy(this.fromPos).lerp(this.toPos, t);
    this.toPos.copy(this.fromPos);
    this.fromPos.copy(_lerp);
    _slerp.copy(this.fromQuat).slerp(this.toQuat, t);
    this.toQuat.copy(this.fromQuat);
    this.fromQuat.copy(_slerp);
    this._elapsed = 0;
    this._duration = Math.max(1e-3, this._duration * (1 - t));
    this._phase = wasEntering ? 'exiting' : 'entering';
    return true;
  }

  /**
   * Ejected without ceremony — a breach (§4), a death, a teleport, the station
   * losing the layout under us. No pose interpolation and no noise: the caller
   * owns both, because a breach is loud in a way the occupant did not choose.
   */
  clear(): void {
    this._phase = 'none';
    this._volume = null;
    this._elapsed = 0;
    this._duration = 0;
    this._haste = 0;
  }

  /** Advance the climb. Returns the phase change, if any, that just completed. */
  update(dt: number): HideEvent {
    if (this._phase !== 'entering' && this._phase !== 'exiting') return 'none';
    this._elapsed += dt;
    if (this._elapsed < this._duration) return 'none';
    if (this._phase === 'entering') {
      this._phase = 'hidden';
      return 'entered';
    }
    this._phase = 'none';
    this._volume = null;
    return 'exited';
  }

  /**
   * The body pose for this frame. Returns false when the controller has nothing
   * to say (phase `none`), in which case the caller keeps its own pose.
   */
  pose(outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
    const volume = this._volume;
    if (!volume) return false;
    if (this._phase === 'hidden') {
      outPos.set(volume.centre.x, volume.centre.y, volume.centre.z);
      outQuat.copy(this.toQuat);
      return true;
    }
    if (this._phase === 'none') return false;
    const t = ease(this.progress);
    outPos.copy(this.fromPos).lerp(this.toPos, t);
    outQuat.copy(this.fromQuat).slerp(this.toQuat, t);
    return true;
  }

  /** The direction the view is folded around while inside (world space). */
  lookDir(out: THREE.Vector3): THREE.Vector3 {
    const volume = this._volume;
    if (!volume) return out.set(0, 0, -1);
    return out.set(volume.lookDir.x, volume.lookDir.y, volume.lookDir.z);
  }
}

const _lookQuat = new THREE.Quaternion();
const _outQuat = new THREE.Quaternion();

/** Orientation facing a spot's authored `lookDir`. */
function lookQuat(volume: HideVolume): THREE.Quaternion {
  _dir.set(volume.lookDir.x, volume.lookDir.y, volume.lookDir.z);
  return orient(_dir, _lookQuat);
}

/** Orientation facing back out of the box, for the climb out. */
function outQuat(volume: HideVolume): THREE.Quaternion {
  _dir.set(
    volume.entry.x - volume.centre.x,
    volume.entry.y - volume.centre.y,
    volume.entry.z - volume.centre.z,
  );
  if (_dir.lengthSq() < 1e-9) _dir.set(volume.lookDir.x, volume.lookDir.y, volume.lookDir.z);
  return orient(_dir, _outQuat);
}

function orient(dir: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  if (dir.lengthSq() < 1e-12) return out.identity();
  _target.copy(dir).normalize();
  // Straight up or down would make the station up degenerate as a reference.
  const up = Math.abs(_target.dot(UP)) > 0.99 ? _fallbackUp : UP;
  _mat.lookAt(_eye, _target, up);
  return out.setFromRotationMatrix(_mat);
}
