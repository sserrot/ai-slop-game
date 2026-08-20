/**
 * First-person camera rig for a body with NO up vector (DESIGN.md §4).
 *
 * This is the piece three's `PointerLockControls` cannot do for us: its Euler is
 * 'YXZ' around a world up, which is exactly the assumption zero-G deletes. Here
 * the body carries a free quaternion and mouse deltas are applied in LOCAL
 * space — yaw about the body's own Y, pitch about its own X — so you can tumble
 * end over end and keep flying. `PointerLockControls` still owns the pointer
 * lock lifecycle (see input.ts); only the rotation maths moved here.
 *
 * Roll-lock (§4 comfort) switches to a yaw/pitch pair rebuilt every frame around
 * world +Y, which is the "fixed horizon" the option promises. Toggling either
 * way is seamless: the yaw/pitch pair is re-derived from the current forward.
 *
 * THE WALKING PIVOT ADDS A SECOND, NON-OPTIONAL LOCK. In a module with a floor
 * there is no ambiguity about which way is up — `STATION_DOWN` is a single
 * global (§4) — so `setFloorLock(true)` forces the same fixed-horizon path
 * regardless of the comfort setting. Standing on a deck with a tumbling horizon
 * is not a stylistic choice, it is a bug, and it is the single largest comfort
 * win the pivot buys (§13 motion sickness). The option still governs `zero`
 * modules, where a fixed horizon is a lie the player may want anyway.
 */

import * as THREE from 'three';
import { clamp } from '@shared/constants';
import type { PlayerComfort } from './comfort';
import { PITCH_LIMIT, ROLL_SPEED } from './tuning';

const LOCAL_X = new THREE.Vector3(1, 0, 0);
const LOCAL_Y = new THREE.Vector3(0, 1, 0);
const LOCAL_Z = new THREE.Vector3(0, 0, 1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const _q = new THREE.Quaternion();
const _prev = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _fwd = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _origin = new THREE.Vector3(0, 0, 0);
const _coneFwd = new THREE.Vector3();

/** Fold an angle into (-pi, pi]. */
function wrapPi(a: number): number {
  const twoPi = Math.PI * 2;
  let x = (a + Math.PI) % twoPi;
  if (x < 0) x += twoPi;
  return x - Math.PI;
}

/**
 * Owns the body orientation and pushes it (plus position and FOV) onto a
 * `THREE.PerspectiveCamera`.
 */
export class PlayerCamera {
  /** Body orientation. The camera copies this verbatim — eyes are the body. */
  readonly orientation = new THREE.Quaternion();

  /** Yaw/pitch used while roll-lock is on. Radians. */
  private yaw = 0;
  private pitch = 0;
  private rollLocked: boolean;
  /** True while the body is standing on a deck: the horizon is fixed whatever
   *  the comfort option says. See the header. */
  private floorLocked = false;

  /** Mouse yaw waiting for the next snap step, when snap turn quantises it. */
  private pendingSnapYaw = 0;

  private _angularSpeed = 0;
  private lastFov = -1;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly comfort: PlayerComfort,
  ) {
    this.rollLocked = comfort.rollLock;
    this.orientation.copy(camera.quaternion);
    this.syncYawPitchFromQuaternion();
  }

  /** rad/s over the last update — the §4 vignette driver. */
  get angularSpeed(): number {
    return this._angularSpeed;
  }

  /** True when the horizon is currently fixed, for either reason. */
  get horizonFixed(): boolean {
    return this.rollLocked;
  }

  /**
   * Standing on a floor (§4 `gravity: 'nominal'`), so the horizon is fixed
   * whatever the comfort menu says. Re-derives the yaw/pitch pair on a change,
   * so crossing a hatch into gravity levels the view instead of jumping it.
   */
  setFloorLock(locked: boolean): void {
    if (this.floorLocked === locked) return;
    this.floorLocked = locked;
    this.applyLockMode();
  }

  /** The lock actually in force: the comfort option OR a floor under your feet. */
  private get effectiveRollLock(): boolean {
    return this.floorLocked || this.comfort.rollLock;
  }

  /** Adopt the current lock mode, re-deriving so the view never jumps. */
  private applyLockMode(): void {
    const want = this.effectiveRollLock;
    if (want === this.rollLocked) return;
    this.rollLocked = want;
    this.syncYawPitchFromQuaternion();
    this.pendingSnapYaw = 0;
  }

  /** Unit forward (-Z) in world space. */
  forward(target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    return target.set(0, 0, -1).applyQuaternion(this.orientation);
  }

  /** Unit right (+X) in world space. */
  right(target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    return target.set(1, 0, 0).applyQuaternion(this.orientation);
  }

  /** Unit up (+Y) in world space — the BODY's up, which is rarely the world's. */
  up(target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    return target.set(0, 1, 0).applyQuaternion(this.orientation);
  }

  /** Point the body somewhere, e.g. at spawn. `dir` need not be normalised. */
  lookAlong(dir: THREE.Vector3): void {
    _fwd.copy(dir);
    if (_fwd.lengthSq() < 1e-12) return;
    _fwd.normalize();
    // Matrix4.lookAt(eye, target, up) points -Z from eye toward target, which
    // is exactly the camera convention: look FROM the origin ALONG _fwd.
    const up = Math.abs(_fwd.dot(WORLD_UP)) > 0.99 ? LOCAL_X : WORLD_UP;
    _mat.lookAt(_origin, _fwd, up);
    this.orientation.setFromRotationMatrix(_mat);
    this.syncYawPitchFromQuaternion();
  }

  setOrientation(q: THREE.Quaternion): void {
    this.orientation.copy(q).normalize();
    this.syncYawPitchFromQuaternion();
  }

  /**
   * One look update.
   *
   * @param dt       seconds
   * @param dx       raw mouse movement X, pixels
   * @param dy       raw mouse movement Y, pixels
   * @param rollAxis -1..1 from the roll keys; ignored under roll-lock
   * @param snapSteps net snap-turn steps requested this frame (+right)
   */
  update(dt: number, dx: number, dy: number, rollAxis: number, snapSteps: number): void {
    _prev.copy(this.orientation);

    const o = this.comfort.options;
    // Mode may have changed under us, from either source — re-derive so the
    // view does not jump.
    this.applyLockMode();

    const sens = o.mouseSensitivity;
    let yawDelta = -dx * sens;
    const pitchDelta = (o.invertY ? dy : -dy) * sens;

    // Snap turn (§4). Arrow-key steps always apply; mouse yaw is only quantised
    // when the player asks for it, because stepping a mouse feels broken.
    const step = this.comfort.snapTurnRadians;
    let snapYaw = 0;
    if (step > 0) {
      snapYaw = -snapSteps * step;
      if (o.snapTurnAppliesToMouse) {
        this.pendingSnapYaw += yawDelta;
        yawDelta = 0;
        while (Math.abs(this.pendingSnapYaw) >= step) {
          const sign = this.pendingSnapYaw > 0 ? 1 : -1;
          snapYaw += sign * step;
          this.pendingSnapYaw -= sign * step;
        }
      }
    } else {
      this.pendingSnapYaw = 0;
    }

    if (this.rollLocked) {
      this.yaw += yawDelta + snapYaw;
      this.pitch = clamp(this.pitch + pitchDelta, -PITCH_LIMIT, PITCH_LIMIT);
      _euler.set(this.pitch, this.yaw, 0, 'YXZ');
      this.orientation.setFromEuler(_euler);
    } else {
      // Local-space application: yaw about the body's own up, pitch about its
      // own right. No world up anywhere — this is the zero-G part.
      const totalYaw = yawDelta + snapYaw;
      if (totalYaw !== 0) {
        this.orientation.multiply(_q.setFromAxisAngle(LOCAL_Y, totalYaw));
      }
      if (pitchDelta !== 0) {
        this.orientation.multiply(_q.setFromAxisAngle(LOCAL_X, pitchDelta));
      }
      if (rollAxis !== 0) {
        this.orientation.multiply(_q.setFromAxisAngle(LOCAL_Z, -rollAxis * ROLL_SPEED * dt));
      }
      this.orientation.normalize();
    }

    // Angular velocity for the vignette. A snap turn is DISCOUNTED: snapping
    // exists to spare the players smooth rotation makes sick, so darkening the
    // screen every time they use it would punish the comfort option.
    const swept = Math.max(0, _prev.angleTo(this.orientation) - Math.abs(snapYaw));
    this._angularSpeed = dt > 0 ? swept / dt : 0;
  }

  /**
   * Copy position, orientation and FOV onto the camera. Call once per frame,
   * after the controller has moved the body.
   *
   * `offset` is the head bob plus the view lag (§4 comfort, `./tuning`): the
   * camera is allowed to trail the body vertically so a step-up, a ground snap,
   * a crouch or a `settle` does not teleport the view. It is EYE CANDY AND
   * COMFORT ONLY. Nothing else in the game reads it — noise origins, the
   * collider and the §7 transform are all the body — which is what keeps a
   * comfort dial from changing what the alien hears.
   */
  apply(position: THREE.Vector3, offset?: THREE.Vector3): void {
    this.camera.position.copy(position);
    if (offset) this.camera.position.add(offset);
    this.camera.quaternion.copy(this.orientation);
    const fov = this.comfort.fovDegrees;
    if (fov !== this.lastFov) {
      this.lastFov = fov;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Fold the view into a cone about `dir` — the §4 hide spot.
   *
   * You are in a locker. You can look along the crack, not over your shoulder.
   * Yaw and pitch are clamped separately (a body folded into an equipment bay
   * can turn its head further than it can nod) and both are measured against the
   * spot's authored `lookDir`, so the constraint travels with the geometry.
   *
   * This is a VIEW constraint and nothing more. It is not a vision cone, and it
   * is not consulted by anything that hunts — §4 is explicit that no sight logic
   * exists anywhere in this codebase, hiding least of all.
   */
  constrainToCone(dir: THREE.Vector3, maxYaw: number, maxPitch: number): void {
    _coneFwd.copy(dir);
    if (_coneFwd.lengthSq() < 1e-12) return;
    _coneFwd.normalize();

    // The yaw/pitch pair is only kept current while the horizon is fixed, and a
    // stowage net in a `zero` module is a hide spot reached in the free-rotation
    // mode. Re-derive from the live quaternion first, so the clamp below is
    // measured against where the player is actually looking.
    this.syncYawPitchFromQuaternion();

    // Work in the fixed-horizon frame: the centre's yaw/pitch, then a clamped
    // offset from it. Doing it as a single angle-to-axis rotation would let the
    // view roll, which inside a locker looks like the locker is spinning.
    const centrePitch = Math.asin(clamp(_coneFwd.y, -1, 1));
    const centreYaw = Math.atan2(-_coneFwd.x, -_coneFwd.z);

    let dYaw = wrapPi(this.yaw - centreYaw);
    dYaw = clamp(dYaw, -maxYaw, maxYaw);
    this.yaw = centreYaw + dYaw;
    this.pitch = clamp(this.pitch, centrePitch - maxPitch, centrePitch + maxPitch);
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);

    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.orientation.setFromEuler(_euler);
  }

  /** Re-derive the roll-lock yaw/pitch pair from the free quaternion. */
  private syncYawPitchFromQuaternion(): void {
    this.forward(_fwd);
    this.pitch = clamp(Math.asin(clamp(_fwd.y, -1, 1)), -PITCH_LIMIT, PITCH_LIMIT);
    this.yaw = Math.atan2(-_fwd.x, -_fwd.z);
    if (this.rollLocked) {
      _euler.set(this.pitch, this.yaw, 0, 'YXZ');
      this.orientation.setFromEuler(_euler);
    }
  }
}
