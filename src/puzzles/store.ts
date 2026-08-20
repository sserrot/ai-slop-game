/**
 * Client mirror of the server's puzzle state (DESIGN.md §7, §11).
 *
 * Puzzle state is server-authoritative. There is no prediction here and there
 * should never be one: §7's r1 reversal deleted rollback machinery from the
 * whole project, and a locally-guessed breaker panel would be exactly the kind
 * of disagreement that machinery exists to paper over.
 *
 * The store is the single place a `puzzle` message lands. Panels read from it,
 * the HUD reads from it, and it re-publishes onto the shared event bus so
 * nothing has to know it exists.
 */

import type { PuzzleId, PuzzleMessage, PuzzleSnapshot } from '@shared/types';
import { SYSTEMS_TO_ESCAPE } from '@shared/constants';
import { bus as sharedBus, type EventBus, type GameEvents, type Unsubscribe } from '../core/eventBus';
import { PUZZLE_GATES } from './logic/index';
import type { PuzzleStateFor } from './types';

export type PuzzleStoreListener = (id: PuzzleId, snapshot: PuzzleSnapshot) => void;

export interface PuzzleStoreOptions {
  /** Republish onto this bus. `null` keeps the store silent. Default: shared. */
  bus?: EventBus<GameEvents> | null;
}

export class PuzzleStore {
  private readonly snapshots = new Map<PuzzleId, PuzzleSnapshot>();
  private readonly listeners = new Set<PuzzleStoreListener>();
  private readonly bus: EventBus<GameEvents> | null;
  private systems = 0;

  constructor(opts: PuzzleStoreOptions = {}) {
    this.bus = opts.bus === undefined ? sharedBus : opts.bus;
  }

  /** Apply one `puzzle` message or snapshot. Returns true if anything changed. */
  apply(msg: PuzzleMessage | PuzzleSnapshot): boolean {
    const previous = this.snapshots.get(msg.id);
    const wasSolved = previous?.solved ?? false;
    const snapshot: PuzzleSnapshot = { id: msg.id, state: msg.state, solved: msg.solved };
    this.snapshots.set(msg.id, snapshot);

    for (const fn of this.listeners) {
      try {
        fn(msg.id, snapshot);
      } catch (err) {
        console.error('[puzzles] store listener threw:', err);
      }
    }

    if (this.bus) this.bus.emit('puzzle:changed', { id: msg.id, solved: msg.solved });

    if (!wasSolved && msg.solved) {
      const next = this.countSystems();
      if (next !== this.systems) {
        this.systems = next;
        if (this.bus) this.bus.emit('system:online', { systemsOnline: next });
      }
      return true;
    }
    return previous?.state !== msg.state || wasSolved !== msg.solved;
  }

  /** Apply a whole state mirror (room join, or a resync). */
  applyAll(snapshots: readonly PuzzleSnapshot[]): void {
    for (const s of snapshots) this.apply(s);
  }

  get(id: PuzzleId): PuzzleSnapshot | undefined {
    return this.snapshots.get(id);
  }

  /** Typed state accessor. Null until the first snapshot arrives. */
  state<K extends PuzzleId>(id: K): PuzzleStateFor<K> | null {
    const s = this.snapshots.get(id);
    return s ? (s.state as PuzzleStateFor<K>) : null;
  }

  solved(id: PuzzleId): boolean {
    return this.snapshots.get(id)?.solved ?? false;
  }

  all(): PuzzleSnapshot[] {
    return [...this.snapshots.values()];
  }

  /**
   * Escape systems online, counted from the puzzles the client has seen solved.
   * The server's own count is authoritative — this is for panels and the HUD,
   * which need a number before the next `stage` message arrives.
   */
  countSystems(): number {
    const online = new Set<string>();
    for (const [id, snap] of this.snapshots) {
      if (!snap.solved) continue;
      for (const gate of PUZZLE_GATES[id] ?? []) online.add(gate);
    }
    return online.size;
  }

  get systemsOnline(): number {
    return this.systems;
  }

  /** Four systems, then the undock sequence, then the capsule (§11). */
  get escapeArmed(): boolean {
    return this.countSystems() >= SYSTEMS_TO_ESCAPE;
  }

  subscribe(fn: PuzzleStoreListener): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  reset(): void {
    this.snapshots.clear();
    this.systems = 0;
  }
}

/** The one every client subsystem shares. */
export const puzzleStore = new PuzzleStore();
