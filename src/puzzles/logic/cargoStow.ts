/**
 * Puzzle 3 · CARGO STOW — 1–2 players, dexterity, zero logic (§11).
 *
 * Five numbered bags float loose; each goes in its matching rack slot. They are
 * rigid bodies — push one too hard and it bounces off a bulkhead at loudness 30,
 * then keeps bouncing, and now you have five problems. Moving them gently is the
 * whole puzzle, and gentle is slow. Loud-fast / quiet-slow with no lever to pull.
 *
 * THE PHYSICS IS CLIENT-AUTHORITATIVE (§1 r1 reversal): the nearest player owns
 * a bag, simulates it in Rapier, and the server relays. So this file is only the
 * BOOKKEEPING — which bags are stowed, and therefore whether ballast trim is
 * online. The simulation itself lives in `src/puzzles/cargoPhysics.ts` and never
 * runs in Node.
 *
 * Consequently the server trusts `stow` reports the way it trusts movement (§7):
 * clients own their own bags outright. It does check that the reporting player
 * is actually in the module, which is the same sanity check movement gets.
 */

import type { EscapeSystemId, ModuleId, PlayerId } from '@shared/types';
import { CARGO_BAG_COUNT } from '@shared/constants';
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

export interface CargoBagRecord {
  id: string;
  /** Slot this bag belongs in. Bags are numbered; so are slots. */
  slot: string;
  stowed: boolean;
  /** Who reported it stowed. Flavour for the panel, and a debugging breadcrumb. */
  by: PlayerId | null;
}

export interface CargoState extends PuzzleStateBase {
  id: 'cargo-stow';
  bags: CargoBagRecord[];
  stowedCount: number;
  required: number;
}

/** Canonical bag / slot ids. The station agent's rack props should match. */
export function cargoBagId(index: number): string {
  return `bag-${index + 1}`;
}
export function cargoSlotId(index: number): string {
  return `slot-${index + 1}`;
}

export class CargoStowPuzzle implements PuzzleRuntime<CargoState> {
  readonly id = 'cargo-stow' as const;
  readonly gates: EscapeSystemId[] = PUZZLE_GATES['cargo-stow'].slice();
  readonly minPlayers = 1;
  readonly state: CargoState;

  constructor(setup: PuzzleSetup) {
    const bags: CargoBagRecord[] = [];
    for (let i = 0; i < CARGO_BAG_COUNT; i++) {
      bags.push({ id: cargoBagId(i), slot: cargoSlotId(i), stowed: false, by: null });
    }
    this.state = {
      id: 'cargo-stow',
      module: setup.placement.module,
      solved: false,
      revision: 0,
      anchors: setup.placement.anchors ?? {},
      bags,
      stowedCount: 0,
      required: CARGO_BAG_COUNT,
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
    if (cmd.module !== null && cmd.module !== s.module) return;

    const bagId = typeof cmd.value === 'string' ? cmd.value : cmd.element;
    const bag = bagId ? s.bags.find((b) => b.id === bagId) : undefined;

    switch (cmd.action) {
      case 'stow': {
        if (!bag || bag.stowed) return;
        bag.stowed = true;
        bag.by = cmd.playerId;
        s.stowedCount = s.bags.filter((b) => b.stowed).length;
        touch(s, out);
        if (s.stowedCount >= s.required) {
          s.solved = true;
          out.solve();
          out.toast(null, 'Ballast trim online.');
        } else {
          out.toast(cmd.playerId, `${s.stowedCount}/${s.required} stowed.`);
        }
        return;
      }

      case 'unstow': {
        // Only useful if the rack is knocked open again; harmless either way.
        if (!bag || !bag.stowed) return;
        bag.stowed = false;
        bag.by = null;
        s.stowedCount = s.bags.filter((b) => b.stowed).length;
        touch(s, out);
        return;
      }

      case 'bounce': {
        // Fallback path. The owning client normally reports a bounce through the
        // ordinary `noise` intent channel with the bag's real world position,
        // which is better — this only fires if an integrator routes it here.
        out.noise('cargo-bounce', s.module, anchorOf(s, 'rack'), cmd.playerId);
        return;
      }

      default:
        return;
    }
  }

  tick(_dt: number, _ctx: PuzzleTickContext, _out: PuzzleEffects): void {
    // Nothing to advance: the bags are simulated on their owners' machines.
  }

  publicState(): unknown {
    return { ...this.state, bags: this.state.bags.map((b) => ({ ...b })) };
  }

  reset(): void {
    const s = this.state;
    for (const b of s.bags) {
      b.stowed = false;
      b.by = null;
    }
    s.stowedCount = 0;
    s.solved = false;
    s.revision++;
  }
}
