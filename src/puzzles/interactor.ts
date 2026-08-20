/**
 * Client → server puzzle interactions (DESIGN.md §7 `interact { targetId,
 * action, value }`).
 *
 * The client never decides anything: it says "I threw breaker 3" and the server
 * decides whether that was the right breaker, how loud it was, and who heard it.
 *
 * HOLDS ARE HEARTBEATS. Four of the six puzzles have a "keep holding this"
 * state — the manual override, the valve wheel, the pry bar / hand pump, and
 * the three undock levers — and a single "I let go" packet that goes missing
 * would leave a player welded to a lever from the server's point of view. So a
 * hold is re-sent at `heartbeatHz` and expires server-side 250 ms after the last
 * one. Call `update(dt)` from the fixed tick and it takes care of itself.
 */

import type { InteractMessage } from '@shared/types';
import { VALVE_FAST_THRESHOLD } from './logic/index';

export type InteractSender = (msg: InteractMessage) => void;

export interface PuzzleInteractorOptions {
  /** Hand this the net layer's `room.send('interact', msg)`. */
  send: InteractSender;
  /** Hold re-send rate. Default 10 Hz — well inside the server's 250 ms grace. */
  heartbeatHz?: number;
}

/**
 * THE ACTION VOCABULARY. Every string the server's `interact` router
 * understands, in one table, so the interaction raycaster (§4) and the panel
 * regions below cannot drift apart from `server/sim/puzzles.ts`.
 *
 * `targetId` is either a PuzzleId (optionally `puzzle:element`) or the world key
 * of a prop, `${moduleId}:${propId}` — the raycaster hits props, so that is the
 * path most of these take in practice.
 */
export const PUZZLE_ACTIONS = Object.freeze({
  'breaker-sequence': ['throw', 'hold', 'release', 'read-card', 'pry', 'pump', 'release-locker'],
  'coolant-valve': ['turn', 'stop', 'lock'],
  'cargo-stow': ['stow', 'unstow', 'bounce'],
  'fuse-hunt': ['take', 'drop', 'install', 'pry', 'pump', 'release'],
  'airlock-keyswitch': ['turn'],
  'undock-sequence': ['hold', 'release'],
  escape: ['board', 'unboard', 'launch'],
} as const);

/** Slow turn magnitude — anything under VALVE_FAST_THRESHOLD reads as careful. */
const TURN_SLOW = 0.2;
const TURN_FAST = 1;

export class PuzzleInteractor {
  private readonly sendFn: InteractSender;
  private readonly period: number;
  /** key → the message to repeat while the control is held. */
  private readonly holds = new Map<string, InteractMessage>();
  private accum = 0;

  constructor(opts: PuzzleInteractorOptions) {
    this.sendFn = opts.send;
    this.period = 1 / Math.max(1, opts.heartbeatHz ?? 10);
  }

  /** Call once per fixed tick. Re-sends every held control. */
  update(dt: number): void {
    if (this.holds.size === 0) {
      this.accum = 0;
      return;
    }
    this.accum += dt;
    if (this.accum < this.period) return;
    this.accum = 0;
    for (const msg of this.holds.values()) this.sendFn(msg);
  }

  /** Anything currently held down. */
  get holding(): string[] {
    return [...this.holds.keys()];
  }

  // -- primitives -----------------------------------------------------------

  send(targetId: string, action: string, value?: number | string | boolean): void {
    this.sendFn(value === undefined ? { targetId, action } : { targetId, action, value });
  }

  /** Start repeating `msg` until `endHold(key)`. Sends once immediately. */
  beginHold(key: string, msg: InteractMessage): void {
    this.holds.set(key, msg);
    this.accum = 0;
    this.sendFn(msg);
  }

  /** Stop repeating, and tell the server now rather than 250 ms from now. */
  endHold(key: string, release?: InteractMessage): void {
    const had = this.holds.delete(key);
    if (had && release) this.sendFn(release);
  }

  /** Drop every hold — call on death, disconnect, or opening a menu. */
  releaseAll(): void {
    for (const [key, msg] of [...this.holds]) {
      this.holds.delete(key);
      // A jammed locker releases with 'release-locker'; a bare 'release' is the
      // breaker override's verb and would leave the jam to lapse on the 250 ms
      // heartbeat instead of dropping now.
      const action = msg.action === 'pry' || msg.action === 'pump' ? 'release-locker' : 'release';
      this.sendFn({ targetId: msg.targetId, action, value: msg.value });
    }
  }

  // -- 1 · breaker sequence -------------------------------------------------

  throwBreaker(index: number): void {
    this.send('breaker-sequence', 'throw', index);
  }

  /** The 20 s manual override: quiet (6), anchored, unable to look around. */
  holdOverride(): void {
    this.beginHold('override', { targetId: 'breaker-sequence', action: 'hold' });
  }

  releaseOverride(): void {
    this.endHold('override', { targetId: 'breaker-sequence', action: 'release' });
  }

  /** Read the laminated card — target the locker prop you are looking at. */
  readCard(targetId = 'breaker-sequence:card'): void {
    this.send(targetId, 'read-card');
  }

  // -- 2 · coolant valve ----------------------------------------------------

  /**
   * Turn the wheel. `+1` opens, `-1` closes; `fast` spins it (40) instead of
   * easing it (8). Held until `stopValve()`.
   */
  turnValve(direction: 1 | -1, fast = false): void {
    const magnitude = fast ? TURN_FAST : TURN_SLOW;
    this.beginHold('valve', {
      targetId: 'coolant-valve:wheel',
      action: 'turn',
      value: direction * magnitude,
    });
  }

  stopValve(): void {
    this.endHold('valve', { targetId: 'coolant-valve:wheel', action: 'stop' });
  }

  /** The reader slamming the seal while the needle is in the green. */
  lockValve(): void {
    this.send('coolant-valve:gauge', 'lock');
  }

  // -- 3 · cargo stow -------------------------------------------------------

  /** The owning client reports a bag settled in its slot (§1 client authority). */
  stowBag(bagId: string): void {
    this.send('cargo-stow', 'stow', bagId);
  }

  // -- 4 · fuse hunt --------------------------------------------------------

  takeFuse(fuseId: string): void {
    this.send('fuse-hunt', 'take', fuseId);
  }

  dropFuse(fuseId: string): void {
    this.send('fuse-hunt', 'drop', fuseId);
  }

  installFuse(fuseId?: string): void {
    this.send('fuse-hunt', 'install', fuseId);
  }

  // -- jammed lockers: pry (60, 3 s) or hand-pump (6, 25 s) ------------------

  pry(targetId: string, value?: string): void {
    this.beginHold(`jam:${targetId}`, { targetId, action: 'pry', value });
  }

  pump(targetId: string, value?: string): void {
    this.beginHold(`jam:${targetId}`, { targetId, action: 'pump', value });
  }

  /**
   * Let go of a jammed locker. The verb is `release-locker`, never a bare
   * `release`: on `breaker-sequence` the bare verb is the 20 s manual
   * override's release (see `src/puzzles/logic/breakerSequence.ts`, cases
   * 'release' vs 'release-locker') and never reaches the card locker, so the
   * jam would only ever clear via the 250 ms heartbeat lapse. `fuse-hunt`
   * accepts both.
   */
  releaseJam(targetId: string, value?: string): void {
    this.endHold(`jam:${targetId}`, { targetId, action: 'release-locker', value });
  }

  // -- 5 · airlock keyswitch ------------------------------------------------

  /** Loudness 45 the instant it turns, however careful you were (§11). */
  turnKey(which: 'a' | 'b'): void {
    this.send('airlock-keyswitch', 'turn', which);
  }

  // -- 6 · undock sequence --------------------------------------------------

  holdLever(leverId?: string): void {
    this.beginHold('lever', { targetId: 'undock-sequence', action: 'hold', value: leverId });
  }

  releaseLever(leverId?: string): void {
    this.endHold('lever', { targetId: 'undock-sequence', action: 'release', value: leverId });
  }

  // -- the capsule ----------------------------------------------------------

  board(): void {
    this.send('escape', 'board');
  }
  unboard(): void {
    this.send('escape', 'unboard');
  }
  launch(): void {
    this.send('escape', 'launch');
  }

  // -- panel regions --------------------------------------------------------

  /**
   * ONE CALL FOR THE INTERACTION RAYCASTER. Raycast the panel, take
   * `panel.regionAt(uv)`, and hand the region id straight to this. Returns
   * false if the id is not a puzzle control.
   *
   * Momentary controls fire on press; held controls start on press and need the
   * matching `releaseRegion()`.
   */
  pressRegion(regionId: string): boolean {
    const breaker = /^breaker-(\d+)$/.exec(regionId);
    if (breaker) {
      this.throwBreaker(Number.parseInt(breaker[1], 10));
      return true;
    }
    switch (regionId) {
      case 'override':
        this.holdOverride();
        return true;
      case 'valve-open-slow':
        this.turnValve(1, false);
        return true;
      case 'valve-open-fast':
        this.turnValve(1, true);
        return true;
      case 'valve-close-slow':
        this.turnValve(-1, false);
        return true;
      case 'valve-close-fast':
        this.turnValve(-1, true);
        return true;
      case 'valve-lock':
        this.lockValve();
        return true;
      case 'key-a':
        this.turnKey('a');
        return true;
      case 'key-b':
        this.turnKey('b');
        return true;
      case 'lever':
        this.holdLever();
        return true;
      case 'install':
        this.installFuse();
        return true;
      case 'board':
        this.board();
        return true;
      case 'launch':
        this.launch();
        return true;
      default:
        return false;
    }
  }

  /** The other half of `pressRegion` for held controls. */
  releaseRegion(regionId: string): boolean {
    switch (regionId) {
      case 'override':
        this.releaseOverride();
        return true;
      case 'valve-open-slow':
      case 'valve-open-fast':
      case 'valve-close-slow':
      case 'valve-close-fast':
        this.stopValve();
        return true;
      case 'lever':
        this.releaseLever();
        return true;
      default:
        return false;
    }
  }
}

/** True if a `turn` magnitude counts as spinning the wheel (loudness 40). */
export function isFastTurn(magnitude: number): boolean {
  return Math.abs(magnitude) >= VALVE_FAST_THRESHOLD;
}

/** World key of a prop, matching what the server's prop router expects. */
export function propTarget(module: string, propId: string): string {
  return `${module}:${propId}`;
}

/** Convenience for the net layer: a no-op sender for single-player testing. */
export function nullSender(_msg: InteractMessage): void {
  /* nothing to send to */
}
