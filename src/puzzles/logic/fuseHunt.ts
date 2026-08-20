/**
 * Puzzle 4 · FUSE HUNT — any number of players, pure traversal (§11).
 *
 * Three blown fuses, three replacements in randomised lockers. "Zero logic — its
 * job is to force travel while the alien is awake, and it's what spaces out the
 * pacing between the thinky ones."
 *
 * The loud-fast / quiet-slow rule still applies, and here it lands twice:
 *   - Getting there. Rail-pull at 4 or push off at 8 and gamble on the catch
 *     (26) versus the crash (51). That axis belongs to §4 and needs no code here.
 *   - Getting in. Some lockers are jammed: pry them (60, 3 s) or hand-pump them
 *     (6, 25 s) — §11's own canonical example, shared with the breaker card.
 */

import type { EscapeSystemId, ModuleId, PlayerId, Vec3 } from '@shared/types';
import { FUSE_COUNT } from '@shared/constants';
import { createJam, jamHold, jamRelease, jamTick, type JamState } from './jammed';
import {
  anchorOf,
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

export interface FuseSocket {
  id: string;
  filled: boolean;
  /** Which fuse went in here. */
  fuse: string | null;
}

export interface FuseRecord {
  id: string;
  /** Where its locker is. Broadcast — hunting for it is travel, not guesswork. */
  module: ModuleId;
  locker: string;
  pos: Vec3;
  jam: JamState;
  carriedBy: PlayerId | null;
  installed: boolean;
}

export interface FuseHuntState extends PuzzleStateBase {
  id: 'fuse-hunt';
  sockets: FuseSocket[];
  fuses: FuseRecord[];
  required: number;
  filledCount: number;
}

export function fuseId(index: number): string {
  return `fuse-${index + 1}`;
}
export function fuseSocketId(index: number): string {
  return `socket-${index + 1}`;
}

export class FuseHuntPuzzle implements PuzzleRuntime<FuseHuntState> {
  readonly id = 'fuse-hunt' as const;
  readonly gates: EscapeSystemId[] = PUZZLE_GATES['fuse-hunt'].slice();
  readonly minPlayers = 1;
  readonly state: FuseHuntState;

  constructor(setup: PuzzleSetup) {
    const { placement } = setup;
    const lockers = placement.lockers ?? [];
    const sockets: FuseSocket[] = [];
    const fuses: FuseRecord[] = [];

    for (let i = 0; i < FUSE_COUNT; i++) {
      sockets.push({ id: fuseSocketId(i), filled: false, fuse: null });
      const locker: LockerRef | undefined = lockers[i];
      fuses.push({
        id: fuseId(i),
        module: locker ? locker.module : placement.module,
        locker: locker ? locker.propId : `${placement.module}:spare-${i + 1}`,
        pos: locker ? locker.pos : (placement.anchors?.['panel'] ?? { x: 0, y: 0, z: 0 }),
        jam: createJam(locker ? locker.jammed === true : false),
        carriedBy: null,
        installed: false,
      });
    }

    this.state = {
      id: 'fuse-hunt',
      module: placement.module,
      solved: false,
      revision: 0,
      anchors: placement.anchors ?? {},
      sockets,
      fuses,
      required: FUSE_COUNT,
      filledCount: 0,
    };
  }

  get solved(): boolean {
    return this.state.solved;
  }

  modules(): ModuleId[] {
    const out = [this.state.module];
    for (const f of this.state.fuses) if (!out.includes(f.module)) out.push(f.module);
    return out;
  }

  private fuseFrom(cmd: PuzzleCommand): FuseRecord | undefined {
    const key = typeof cmd.value === 'string' ? cmd.value : cmd.element;
    if (!key) {
      // No id given: act on the one this player is carrying, if any.
      return this.state.fuses.find((f) => f.carriedBy === cmd.playerId);
    }
    return this.state.fuses.find((f) => f.id === key || f.locker === key);
  }

  interact(cmd: PuzzleCommand, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;
    const fuse = this.fuseFrom(cmd);

    switch (cmd.action) {
      case 'pry':
      case 'pump': {
        if (!fuse || !fuse.jam.jammed) return;
        if (cmd.module !== null && cmd.module !== fuse.module) return;
        if (jamHold(fuse.jam, cmd.action, cmd.playerId, cmd.nowMs)) touch(s, out);
        return;
      }

      case 'release':
      case 'release-locker': {
        if (!fuse) return;
        if (jamRelease(fuse.jam, cmd.playerId)) touch(s, out);
        return;
      }

      case 'take': {
        if (!fuse || fuse.installed) return;
        if (cmd.module !== null && cmd.module !== fuse.module) return;
        if (fuse.jam.jammed) {
          out.toast(cmd.playerId, 'Locker is jammed. Pry it (60) or pump it (25 s).');
          return;
        }
        if (fuse.carriedBy !== null && fuse.carriedBy !== cmd.playerId) return;
        fuse.carriedBy = cmd.playerId;
        touch(s, out);
        out.toast(cmd.playerId, `Took ${fuse.id}. Sockets are in ${s.module}.`);
        return;
      }

      case 'drop': {
        if (!fuse || fuse.carriedBy !== cmd.playerId) return;
        fuse.carriedBy = null;
        // It stays where the carrier was standing, module-wise.
        if (cmd.module) fuse.module = cmd.module;
        touch(s, out);
        return;
      }

      case 'install': {
        if (!fuse || fuse.installed) return;
        if (fuse.carriedBy !== cmd.playerId) {
          out.toast(cmd.playerId, 'You are not carrying that fuse.');
          return;
        }
        if (cmd.module !== null && cmd.module !== s.module) {
          out.toast(cmd.playerId, 'The sockets are in another module.');
          return;
        }
        const socket = s.sockets.find((k) => !k.filled);
        if (!socket) return;
        socket.filled = true;
        socket.fuse = fuse.id;
        fuse.installed = true;
        fuse.carriedBy = null;
        fuse.module = s.module;
        s.filledCount = s.sockets.filter((k) => k.filled).length;
        // Seating a fuse is a quiet click — the hand-pump tier (6).
        out.noise('hand-pump', s.module, anchorOf(s, 'panel'), cmd.playerId);
        touch(s, out);
        if (s.filledCount >= s.required) {
          s.solved = true;
          out.solve();
          out.toast(null, 'Comms array online.');
        } else {
          out.toast(cmd.playerId, `${s.filledCount}/${s.required} fuses seated.`);
        }
        return;
      }

      default:
        return;
    }
  }

  tick(dt: number, ctx: PuzzleTickContext, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;
    for (const fuse of s.fuses) {
      if (!fuse.jam.jammed) continue;
      // Read the holder BEFORE the tick: `jamTick` nulls it the moment the door
      // comes open, and `PuzzleEffects.toast(null, …)` means the whole crew —
      // so this told everybody in the station that somebody had just opened a
      // locker. Unreachable until jamming was enabled by default.
      const opener = fuse.jam.holder;
      if (jamTick(fuse.jam, dt, ctx.nowMs, fuse.module, fuse.pos, out)) {
        out.toast(opener, 'Locker open.');
      }
    }
  }

  publicState(): unknown {
    const s = this.state;
    return {
      ...s,
      sockets: s.sockets.map((k) => ({ ...k })),
      fuses: s.fuses.map((f) => ({ ...f, jam: { ...f.jam }, pos: { ...f.pos } })),
    };
  }

  reset(): void {
    const s = this.state;
    for (const k of s.sockets) {
      k.filled = false;
      k.fuse = null;
    }
    for (const f of s.fuses) {
      f.carriedBy = null;
      f.installed = false;
    }
    s.filledCount = 0;
    s.solved = false;
    s.revision++;
  }
}
