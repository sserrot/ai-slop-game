/**
 * Puzzle 5 · AIRLOCK KEYSWITCH — 2 players, same module, commitment (§11).
 *
 * Two keyswitches four metres apart, turned within one second of each other.
 * Trivial on the ground; in zero-G both players must anchor to rails and count
 * down over voice. Loud on activation (45) no matter how careful you are.
 *
 * Two booleans with timestamps — and that is genuinely the whole implementation.
 *
 * There is no quiet path here BY DESIGN: §11 says "loud on activation no matter
 * how careful you are — place it late". The loud-fast / quiet-slow choice this
 * puzzle offers is *when*, not *how*: you can burn 45 while the alien is two
 * modules away, or wait for it to wander and burn 45 with it next door.
 */

import type { EscapeSystemId, ModuleId, PlayerId } from '@shared/types';
import { KEYSWITCH_WINDOW_S } from '@shared/constants';
import {
  anchorOf,
  PUZZLE_GATES,
  touch,
  type PuzzleCommand,
  type PuzzleEffects,
  type PuzzleRuntime,
  type PuzzleSetup,
  type PuzzleStateBase,
  type PuzzleTickContext,
} from './types';

/** The two switches are this far apart — one pair of hands cannot reach both. */
export const KEYSWITCH_SEPARATION_M = 4;

export interface KeyswitchRecord {
  id: 'a' | 'b';
  turnedAtMs: number | null;
  by: PlayerId | null;
}

export interface KeyswitchState extends PuzzleStateBase {
  id: 'airlock-keyswitch';
  switches: KeyswitchRecord[];
  /** Seconds. Both keys must turn inside this window. */
  windowS: number;
  separationM: number;
  /** Failed attempts. The panel counts them; nothing else does. */
  misses: number;
}

export class AirlockKeyswitchPuzzle implements PuzzleRuntime<KeyswitchState> {
  readonly id = 'airlock-keyswitch' as const;
  readonly gates: EscapeSystemId[] = PUZZLE_GATES['airlock-keyswitch'].slice();
  readonly minPlayers = 2;
  readonly state: KeyswitchState;

  constructor(setup: PuzzleSetup) {
    this.state = {
      id: 'airlock-keyswitch',
      module: setup.placement.module,
      solved: false,
      revision: 0,
      anchors: setup.placement.anchors ?? {},
      switches: [
        { id: 'a', turnedAtMs: null, by: null },
        { id: 'b', turnedAtMs: null, by: null },
      ],
      windowS: KEYSWITCH_WINDOW_S,
      separationM: KEYSWITCH_SEPARATION_M,
      misses: 0,
    };
  }

  get solved(): boolean {
    return this.state.solved;
  }

  modules(): ModuleId[] {
    return [this.state.module];
  }

  interact(cmd: PuzzleCommand, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;
    if (cmd.action !== 'turn') return;
    if (cmd.module !== null && cmd.module !== s.module) return;

    const which = readSwitch(cmd);
    if (!which) return;
    const self = s.switches.find((k) => k.id === which);
    const other = s.switches.find((k) => k.id !== which);
    if (!self || !other) return;

    // 45 the moment the key turns, whatever happens next.
    out.noise('keyswitch', s.module, anchorOf(s, `key-${which}`), cmd.playerId);

    self.turnedAtMs = cmd.nowMs;
    self.by = cmd.playerId;
    touch(s, out);

    const windowMs = s.windowS * 1000;
    const fresh = other.turnedAtMs !== null && cmd.nowMs - other.turnedAtMs <= windowMs;
    if (!fresh) {
      out.toast(cmd.playerId, 'Key turned. Your partner has one second.');
      return;
    }
    if (other.by === cmd.playerId) {
      // Four metres apart in zero-G: one person cannot be at both. If the
      // netcode ever says otherwise, the netcode is wrong, not the airlock.
      s.misses++;
      out.toast(cmd.playerId, 'Both keys, one pair of hands. It needs two of you.');
      return;
    }

    s.solved = true;
    out.solve();
    out.toast(null, 'Airlock control online.');
  }

  tick(_dt: number, ctx: PuzzleTickContext, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;
    const windowMs = s.windowS * 1000;
    let expired = false;
    for (const k of s.switches) {
      if (k.turnedAtMs !== null && ctx.nowMs - k.turnedAtMs > windowMs) {
        k.turnedAtMs = null;
        k.by = null;
        expired = true;
      }
    }
    if (expired) {
      s.misses++;
      touch(s, out);
    }
  }

  publicState(): unknown {
    return { ...this.state, switches: this.state.switches.map((k) => ({ ...k })) };
  }

  reset(): void {
    const s = this.state;
    for (const k of s.switches) {
      k.turnedAtMs = null;
      k.by = null;
    }
    s.misses = 0;
    s.solved = false;
    s.revision++;
  }
}

function readSwitch(cmd: PuzzleCommand): 'a' | 'b' | null {
  const raw = typeof cmd.value === 'string' ? cmd.value : cmd.element;
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (t === 'a' || t.endsWith('-a') || t.endsWith('a')) return 'a';
  if (t === 'b' || t.endsWith('-b') || t.endsWith('b')) return 'b';
  return null;
}
