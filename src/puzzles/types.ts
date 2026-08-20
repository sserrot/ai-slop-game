/**
 * Client-side views of the six puzzle states (DESIGN.md §11).
 *
 * These are the exact shapes `publicState()` produces on the server, which is
 * why they are aliases of the logic types rather than a second declaration:
 * `Puzzle.state` is typed `unknown` on the wire (§11), and this is where that
 * `unknown` gets its name back. One definition, both sides, no drift.
 */

import type {
  BreakerState,
  CargoState,
  CoolantState,
  FuseHuntState,
  KeyswitchState,
  UndockState,
} from './logic/index';
import type { PuzzleId } from '@shared/types';

/** The breaker order is blanked until somebody reads the laminated card (§11). */
export type BreakerPanelState = Omit<BreakerState, 'sequence'> & { sequence: number[] | null };
export type CoolantPanelState = CoolantState;
export type CargoPanelState = CargoState;
export type FusePanelState = FuseHuntState;
export type KeyswitchPanelState = KeyswitchState;
export type UndockPanelState = UndockState;

/** Discriminated by `id`, so a `switch` on it narrows properly. */
export type AnyPuzzleState =
  | BreakerPanelState
  | CoolantPanelState
  | CargoPanelState
  | FusePanelState
  | KeyswitchPanelState
  | UndockPanelState;

/** Maps a PuzzleId to its state shape. */
export interface PuzzleStateByIdMap {
  'breaker-sequence': BreakerPanelState;
  'coolant-valve': CoolantPanelState;
  'cargo-stow': CargoPanelState;
  'fuse-hunt': FusePanelState;
  'airlock-keyswitch': KeyswitchPanelState;
  'undock-sequence': UndockPanelState;
}

export type PuzzleStateFor<K extends PuzzleId> = K extends keyof PuzzleStateByIdMap
  ? PuzzleStateByIdMap[K]
  : never;
