/**
 * Puzzle 1 · BREAKER SEQUENCE — 1 player, teaches the whole game (§11).
 *
 * Six breakers thrown in the right order. Each throw is a CLACK (35); a wrong
 * order resets the panel with a buzz (50). The sequence is on a laminated card
 * stowed in a locker in ANOTHER module, somewhere different each round. Brute
 * force is 720 permutations and roughly a death sentence.
 *
 * There is also a manual override under the panel: hold a lever 20 seconds at
 * loudness 6, anchored and unable to look around.
 *
 * That is the loud-fast / quiet-slow rule with no tutorial text: 6 clacks at 35
 * (plus a 50 every time you guess wrong) versus 20 seconds of near-silence with
 * your back turned.
 */

import type { EscapeSystemId, ModuleId, PlayerId, Vec3 } from '@shared/types';
import { BREAKER_COUNT, BREAKER_OVERRIDE_TIME_S } from '@shared/constants';
import { permutation, pick } from './rng';
import { createJam, jamHold, jamRelease, jamTick, type JamState } from './jammed';
import {
  anchorOf,
  CONTINUOUS_NOISE_INTERVAL_S,
  HOLD_GRACE_MS,
  PUZZLE_GATES,
  touch,
  type LockerRef,
  type PuzzleCommand,
  type PuzzleEffects,
  type PuzzleRuntime,
  type PuzzleSetup,
  type PuzzleStateBase,
  type PuzzleTickContext,
} from './types';

/**
 * Seconds the panel sulks after a wrong order. Long enough that a mashed
 * brute-force attempt costs real time on top of the 50-loudness buzz; short
 * enough that a genuine slip is not a punishment.
 *
 * Local pacing constant — §14 does not define it.
 */
export const BREAKER_FAULT_LOCKOUT_S = 1.5;

export interface BreakerOverrideView {
  holder: PlayerId | null;
  seconds: number;
  required: number;
  progress01: number;
}

export interface BreakerCardView {
  module: ModuleId | null;
  locker: string | null;
  /** The card's locker may be jammed — pry it (60/3s) or pump it (6/25s). */
  jam: JamState | null;
  read: boolean;
}

export interface BreakerState extends PuzzleStateBase {
  id: 'breaker-sequence';
  count: number;
  /** Visual state of the six breakers. */
  switches: boolean[];
  /** How many of the sequence are correctly thrown. */
  progress: number;
  /** Wrong order — the panel is buzzing and ignoring input until this passes. */
  faultUntilMs: number;
  /** Total wrong orders this round. Purely for the panel's shame counter. */
  faults: number;
  card: BreakerCardView;
  override: BreakerOverrideView;
  /**
   * The correct order. SECRET: `publicState()` blanks it until the card has
   * been read. §7 skips anti-cheat on the alien deliberately; the card is a
   * different case — revealing it in the state would delete the puzzle for
   * anyone with a devtools console open, including by accident.
   */
  sequence: number[];
}

interface BreakerInternals {
  overrideHoldUntilMs: number;
  overrideNoiseAccum: number;
}

export class BreakerSequencePuzzle implements PuzzleRuntime<BreakerState> {
  readonly id = 'breaker-sequence' as const;
  readonly gates: EscapeSystemId[] = PUZZLE_GATES['breaker-sequence'].slice();
  readonly minPlayers = 1;
  readonly state: BreakerState;

  private readonly internals: BreakerInternals = {
    overrideHoldUntilMs: 0,
    overrideNoiseAccum: 0,
  };
  private readonly cardLocker: LockerRef | null;

  constructor(setup: PuzzleSetup) {
    const { placement, rng } = setup;
    const lockers = placement.lockers ?? [];
    // "a locker in another module" — the host filters these; we just take one.
    this.cardLocker = pick(rng, lockers) ?? null;

    this.state = {
      id: 'breaker-sequence',
      module: placement.module,
      solved: false,
      revision: 0,
      anchors: placement.anchors ?? {},
      count: BREAKER_COUNT,
      switches: new Array<boolean>(BREAKER_COUNT).fill(false),
      progress: 0,
      faultUntilMs: 0,
      faults: 0,
      card: {
        module: this.cardLocker ? this.cardLocker.module : null,
        locker: this.cardLocker ? this.cardLocker.propId : null,
        jam: this.cardLocker && this.cardLocker.jammed ? createJam(true) : null,
        read: false,
      },
      override: {
        holder: null,
        seconds: 0,
        required: BREAKER_OVERRIDE_TIME_S,
        progress01: 0,
      },
      sequence: permutation(rng, BREAKER_COUNT),
    };
  }

  get solved(): boolean {
    return this.state.solved;
  }

  modules(): ModuleId[] {
    const out = [this.state.module];
    if (this.state.card.module && this.state.card.module !== this.state.module) {
      out.push(this.state.card.module);
    }
    return out;
  }

  /** Where the card's locker is in the world, for its pry/pump noise. */
  private cardPos(): Vec3 {
    if (this.cardLocker) return this.cardLocker.pos;
    return anchorOf(this.state, 'card');
  }

  interact(cmd: PuzzleCommand, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;

    switch (cmd.action) {
      case 'throw':
        this.throwBreaker(cmd, out);
        return;

      case 'hold':
      case 'override-hold':
        this.holdOverride(cmd, out);
        return;

      case 'release':
      case 'override-release':
        this.releaseOverride(cmd, out);
        return;

      // --- the card locker, in some other module entirely -------------------
      case 'pry':
      case 'pump': {
        if (!s.card.jam) return;
        if (cmd.module !== null && cmd.module !== s.card.module) return;
        if (jamHold(s.card.jam, cmd.action, cmd.playerId, cmd.nowMs)) touch(s, out);
        return;
      }
      case 'release-locker': {
        if (!s.card.jam) return;
        if (jamRelease(s.card.jam, cmd.playerId)) touch(s, out);
        return;
      }
      case 'read-card': {
        if (cmd.module !== null && s.card.module !== null && cmd.module !== s.card.module) {
          out.toast(cmd.playerId, 'The card is not here.');
          return;
        }
        if (s.card.jam && s.card.jam.jammed) {
          out.toast(cmd.playerId, 'Locker is jammed. Pry it (loud) or pump it (slow).');
          return;
        }
        if (!s.card.read) {
          s.card.read = true;
          touch(s, out);
          out.toast(cmd.playerId, 'Laminated card: breaker order copied to the panel.');
        }
        return;
      }
      default:
        return;
    }
  }

  private throwBreaker(cmd: PuzzleCommand, out: PuzzleEffects): void {
    const s = this.state;
    if (cmd.module !== null && cmd.module !== s.module) return;
    if (cmd.nowMs < s.faultUntilMs) return; // still buzzing

    const index = readIndex(cmd, s.count);
    if (index === null) return;

    const panel = anchorOf(s, 'panel');
    // The CLACK happens whether or not it was the right breaker.
    out.noise('breaker', s.module, panel, cmd.playerId);

    const expected = s.sequence[s.progress];
    if (index === expected && !s.switches[index]) {
      s.switches[index] = true;
      s.progress++;
      touch(s, out);
      if (s.progress >= s.count) {
        s.solved = true;
        out.solve();
        out.toast(null, 'Main bus online.');
      }
      return;
    }

    // Wrong order — the panel resets with a buzz (50).
    s.switches.fill(false);
    s.progress = 0;
    s.faults++;
    s.faultUntilMs = cmd.nowMs + BREAKER_FAULT_LOCKOUT_S * 1000;
    out.noise('breaker-reset', s.module, panel, cmd.playerId);
    touch(s, out);
    out.toast(cmd.playerId, 'Wrong order. The panel buzzes — loudly.');
  }

  private holdOverride(cmd: PuzzleCommand, out: PuzzleEffects): void {
    const s = this.state;
    if (cmd.module !== null && cmd.module !== s.module) return;
    const lapsed = cmd.nowMs > this.internals.overrideHoldUntilMs;
    if (s.override.holder !== null && s.override.holder !== cmd.playerId && !lapsed) return;

    if (s.override.holder !== cmd.playerId || lapsed) {
      s.override.holder = cmd.playerId;
      s.override.seconds = 0;
      s.override.progress01 = 0;
      this.internals.overrideNoiseAccum = CONTINUOUS_NOISE_INTERVAL_S;
      touch(s, out);
      out.toast(cmd.playerId, 'Manual override: hold 20 s. You cannot look around.');
    }
    this.internals.overrideHoldUntilMs = cmd.nowMs + HOLD_GRACE_MS;
  }

  private releaseOverride(cmd: PuzzleCommand, out: PuzzleEffects): void {
    const s = this.state;
    if (s.override.holder !== cmd.playerId) return;
    s.override.holder = null;
    s.override.seconds = 0;
    s.override.progress01 = 0;
    this.internals.overrideHoldUntilMs = 0;
    this.internals.overrideNoiseAccum = 0;
    touch(s, out);
  }

  tick(dt: number, ctx: PuzzleTickContext, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;

    // The card's locker, if it was jammed.
    if (s.card.jam && s.card.jam.jammed && s.card.module) {
      // Read the holder BEFORE the tick: `jamTick` nulls it the moment the door
      // comes open, and `PuzzleEffects.toast(null, …)` means the whole crew —
      // so this told everybody in the station that somebody had just opened a
      // locker. Unreachable until jamming was enabled by default.
      const opener = s.card.jam.holder;
      if (jamTick(s.card.jam, dt, ctx.nowMs, s.card.module, this.cardPos(), out)) {
        out.toast(opener, 'Locker open.');
      }
    }

    // The manual override lever.
    const o = s.override;
    if (o.holder === null) return;
    if (ctx.nowMs > this.internals.overrideHoldUntilMs) {
      o.holder = null;
      o.seconds = 0;
      o.progress01 = 0;
      this.internals.overrideNoiseAccum = 0;
      touch(s, out);
      return;
    }

    o.seconds += dt;
    o.progress01 = Math.min(1, o.seconds / o.required);
    this.internals.overrideNoiseAccum += dt;
    if (this.internals.overrideNoiseAccum >= CONTINUOUS_NOISE_INTERVAL_S) {
      this.internals.overrideNoiseAccum -= CONTINUOUS_NOISE_INTERVAL_S;
      out.noise('hand-pump', s.module, anchorOf(s, 'lever'), o.holder);
    }
    touch(s, out);

    if (o.seconds >= o.required) {
      // The override throws every breaker for you, in order, silently.
      s.switches.fill(true);
      s.progress = s.count;
      s.solved = true;
      o.holder = null;
      o.progress01 = 1;
      out.solve();
      out.toast(null, 'Main bus online — manual override.');
    }
  }

  publicState(): unknown {
    const s = this.state;
    return {
      ...s,
      // Redacted until somebody physically reads the card.
      sequence: s.card.read ? s.sequence.slice() : null,
      switches: s.switches.slice(),
    };
  }

  reset(): void {
    const s = this.state;
    s.switches.fill(false);
    s.progress = 0;
    s.faults = 0;
    s.faultUntilMs = 0;
    s.solved = false;
    s.override.holder = null;
    s.override.seconds = 0;
    s.override.progress01 = 0;
    s.card.read = false;
    if (s.card.jam) s.card.jam = createJam(true);
    this.internals.overrideHoldUntilMs = 0;
    this.internals.overrideNoiseAccum = 0;
    s.revision++;
  }
}

/** Breaker index from `value` (number or numeric string) or `element` ('b3'). */
function readIndex(cmd: PuzzleCommand, count: number): number | null {
  let raw: number = Number.NaN;
  if (typeof cmd.value === 'number') raw = cmd.value;
  else if (typeof cmd.value === 'string') raw = Number.parseInt(cmd.value, 10);
  else if (cmd.element) raw = Number.parseInt(cmd.element.replace(/[^0-9-]/g, ''), 10);
  if (!Number.isFinite(raw)) return null;
  const i = Math.trunc(raw);
  if (i < 0 || i >= count) return null;
  return i;
}
