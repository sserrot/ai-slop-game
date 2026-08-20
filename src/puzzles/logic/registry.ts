/**
 * The puzzle registry (DESIGN.md §1 "puzzles/ — puzzle registry + individual
 * puzzle logic").
 *
 * Owns the six live puzzles, routes interactions to them, ticks them, and folds
 * their effects together. It knows nothing about Colyseus, three.js or the noise
 * graph: it hands the host a list of noise requests and lets the host decide
 * what a NoiseEvent is. That is why the same object runs on the server (as the
 * authority) and can run headless in a test harness.
 */

import type {
  ModuleId,
  NoiseKind,
  PlayerId,
  Puzzle,
  PuzzleId,
  PuzzleSnapshot,
  Vec3,
} from '@shared/types';
import { PUZZLE_IDS } from '@shared/types';
import { AirlockKeyswitchPuzzle } from './airlockKeyswitch';
import { BreakerSequencePuzzle } from './breakerSequence';
import { CargoStowPuzzle } from './cargoStow';
import { CoolantValvePuzzle } from './coolantValve';
import { FuseHuntPuzzle } from './fuseHunt';
import { UndockSequencePuzzle } from './undockSequence';
import {
  PuzzleEffects,
  type PuzzleCommand,
  type PuzzlePlacement,
  type PuzzleRuntime,
  type PuzzleTickContext,
} from './types';

/** What one routed call produced. The host drains this. */
export interface PuzzleOutcome {
  id: PuzzleId;
  changed: boolean;
  solvedNow: boolean;
  noises: Array<{ kind: NoiseKind; module: ModuleId; pos: Vec3; actor?: PlayerId }>;
  toasts: Array<{ to: PlayerId | null; text: string }>;
}

const EMPTY_OUTCOMES: readonly PuzzleOutcome[] = Object.freeze([]);

function makePuzzle(placement: PuzzlePlacement, rng: () => number): PuzzleRuntime {
  const setup = { placement, rng };
  switch (placement.id) {
    case 'breaker-sequence':
      return new BreakerSequencePuzzle(setup);
    case 'coolant-valve':
      return new CoolantValvePuzzle(setup);
    case 'cargo-stow':
      return new CargoStowPuzzle(setup);
    case 'fuse-hunt':
      return new FuseHuntPuzzle(setup);
    case 'airlock-keyswitch':
      return new AirlockKeyswitchPuzzle(setup);
    case 'undock-sequence':
      return new UndockSequencePuzzle(setup);
    default: {
      const never: never = placement.id;
      throw new Error(`makePuzzle: unknown PuzzleId ${String(never)}`);
    }
  }
}

/**
 * `targetId` → puzzle + element. Accepts `'coolant-valve'`,
 * `'coolant-valve:wheel'` and `'coolant-valve/wheel'`; PuzzleIds contain no
 * separator of their own, so the split is unambiguous.
 */
export function parsePuzzleTarget(
  targetId: string,
): { id: PuzzleId; element: string | null } | null {
  if (!targetId) return null;
  const cut = targetId.search(/[:/]/);
  const head = cut < 0 ? targetId : targetId.slice(0, cut);
  const element = cut < 0 ? null : targetId.slice(cut + 1) || null;
  if (!(PUZZLE_IDS as readonly string[]).includes(head)) return null;
  return { id: head as PuzzleId, element };
}

export class PuzzleRegistry {
  private readonly byId = new Map<PuzzleId, PuzzleRuntime>();
  private readonly effects = new PuzzleEffects();

  constructor(placements: readonly PuzzlePlacement[], rng: () => number) {
    for (const placement of placements) {
      if (this.byId.has(placement.id)) continue;
      this.byId.set(placement.id, makePuzzle(placement, rng));
    }
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: PuzzleId): PuzzleRuntime | undefined {
    return this.byId.get(id);
  }

  /** Typed accessor for the two puzzles the host talks to directly. */
  undock(): UndockSequencePuzzle | undefined {
    const p = this.byId.get('undock-sequence');
    return p instanceof UndockSequencePuzzle ? p : undefined;
  }

  all(): PuzzleRuntime[] {
    return [...this.byId.values()];
  }

  ids(): PuzzleId[] {
    return [...this.byId.keys()];
  }

  /** Every puzzle with hardware in this module — drives panel activation (§6). */
  inModule(module: ModuleId): PuzzleRuntime[] {
    return this.all().filter((p) => p.modules().includes(module));
  }

  /** Route one interaction. Returns null if nothing handled it. */
  interact(id: PuzzleId, cmd: PuzzleCommand): PuzzleOutcome | null {
    const puzzle = this.byId.get(id);
    if (!puzzle) return null;
    const out = this.effects;
    out.reset();
    puzzle.interact(cmd, out);
    if (out.empty) return null;
    return drain(id, out);
  }

  /** Advance every puzzle. `dt` in seconds. */
  tick(dt: number, ctx: PuzzleTickContext): readonly PuzzleOutcome[] {
    let results: PuzzleOutcome[] | null = null;
    for (const [id, puzzle] of this.byId) {
      const out = this.effects;
      out.reset();
      puzzle.tick(dt, ctx, out);
      if (out.empty) continue;
      (results ??= []).push(drain(id, out));
    }
    return results ?? EMPTY_OUTCOMES;
  }

  /** §7 `puzzles: { id, state, solved }[]`. */
  snapshots(): PuzzleSnapshot[] {
    return this.all().map((p) => ({ id: p.id, state: p.publicState(), solved: p.solved }));
  }

  /** §11 `Puzzle` records, for anything that wants the gates. */
  puzzles(): Puzzle[] {
    return this.all().map((p) => ({
      id: p.id,
      module: p.state.module,
      state: p.publicState(),
      solved: p.solved,
      gates: p.gates.slice(),
    }));
  }

  snapshot(id: PuzzleId): PuzzleSnapshot | null {
    const p = this.byId.get(id);
    if (!p) return null;
    return { id: p.id, state: p.publicState(), solved: p.solved };
  }

  solvedIds(): PuzzleId[] {
    return this.all()
      .filter((p) => p.solved)
      .map((p) => p.id);
  }

  reset(): void {
    for (const p of this.byId.values()) p.reset();
  }
}

/** Copy the shared effects buffer out before it is reused. */
function drain(id: PuzzleId, out: PuzzleEffects): PuzzleOutcome {
  return {
    id,
    changed: out.changed,
    solvedNow: out.solvedNow,
    noises: out.noises.map((n) => ({ ...n })),
    toasts: out.toasts.map((t) => ({ ...t })),
  };
}
