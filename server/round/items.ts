/**
 * Round resources: what is in the lockers, and the two scarce team-wide
 * counters (DESIGN.md §5, §10, §11).
 *
 * - **Decoys**: DECOYS_PER_ROUND, "found in lockers, no respawn" (§5). Spending
 *   one has to hurt, so the server holds the count and the client cannot invent
 *   another.
 * - **Seal charges**: SEAL_CHARGES per round (§5). Without that scarcity "the
 *   optimal play is to seal the station into halves and win by carpentry".
 * - **Medkits**: revival v1 is "carry a medkit to the body" (§10). Three of
 *   them at six players — enough that an early death is recoverable, few enough
 *   that it costs a trip.
 * - **Fuses** and the **breaker sequence card** are puzzle inputs (§11) and get
 *   stowed in randomised lockers each round, which is exactly what the fuse
 *   hunt is for.
 */

import { DECOYS_PER_ROUND, FUSE_COUNT, SEAL_CHARGES } from '@shared/constants';
import type { ModuleId, StationLayout } from '@shared/types';
import type { ItemKind } from '../net/protocol';

/** Medkits per round (§10 revival). Not a §14 constant — tune in playtest. */
export const MEDKITS_PER_ROUND = 3;

export interface Locker {
  /** `${moduleId}:${propId}` — what the client sends as `interact.targetId`. */
  key: string;
  module: ModuleId;
  propId: string;
  /** Remaining contents, popped one per `loot()`. */
  contents: ItemKind[];
}

/** Max items one player can carry at once. Two hands, and one of them is
 *  usually on a rail (§4). */
export const CARRY_LIMIT = 2;

export interface ItemRegistryOptions {
  /**
   * Stock the puzzle inputs (fuses, the breaker sequence card) as well.
   *
   * OFF by default: the real `server/sim/puzzles.ts` owns its own lockers and
   * hands out fuses through its own `take` / `install` verbs, and two systems
   * both claiming to hold the fuses means a player loots one that does nothing.
   * The fallback puzzle host does consume them, so it turns this on.
   */
  puzzleItems?: boolean;
}

export class ItemRegistry {
  private readonly _lockers = new Map<string, Locker>();
  private readonly puzzleItems: boolean;
  private _decoysRemaining = 0;
  private _sealCharges = 0;

  constructor(
    private readonly layout: StationLayout,
    private readonly rng: () => number = Math.random,
    opts: ItemRegistryOptions = {},
  ) {
    this.puzzleItems = opts.puzzleItems ?? false;
    this.reset();
  }

  /** Re-stock the station. Called at round start and on restart. */
  reset(): void {
    this._lockers.clear();
    this._decoysRemaining = DECOYS_PER_ROUND;
    this._sealCharges = SEAL_CHARGES;

    const lockers: Locker[] = [];
    for (const module of this.layout.modules) {
      for (const prop of module.props) {
        if (prop.kind !== 'locker') continue;
        const locker: Locker = {
          key: `${module.id}:${prop.id}`,
          module: module.id,
          propId: prop.id,
          contents: [],
        };
        lockers.push(locker);
        this._lockers.set(locker.key, locker);
      }
    }
    if (lockers.length === 0) return;

    const stock: ItemKind[] = [
      ...Array.from({ length: DECOYS_PER_ROUND }, () => 'decoy' as ItemKind),
      ...Array.from({ length: MEDKITS_PER_ROUND }, () => 'medkit' as ItemKind),
      'pry-bar',
      'extinguisher',
    ];
    if (this.puzzleItems) {
      stock.push(...Array.from({ length: FUSE_COUNT }, () => 'fuse' as ItemKind));
      stock.push('sequence-card');
    }

    // Shuffle both sides: which locker holds what, and in what order.
    const order = this.shuffle(lockers);
    this.shuffle(stock).forEach((item, i) => {
      order[i % order.length].contents.push(item);
    });
  }

  get lockers(): readonly Locker[] {
    return [...this._lockers.values()];
  }

  locker(key: string): Locker | undefined {
    return this._lockers.get(key);
  }

  /** Take the next item out of a locker, or null if it is empty / unknown. */
  loot(key: string): ItemKind | null {
    const locker = this._lockers.get(key);
    if (!locker || locker.contents.length === 0) return null;
    return locker.contents.shift() ?? null;
  }

  get decoysRemaining(): number {
    return this._decoysRemaining;
  }

  get sealCharges(): number {
    return this._sealCharges;
  }

  /** Spend a decoy. False when there are none left — no respawn (§5). */
  consumeDecoy(): boolean {
    if (this._decoysRemaining <= 0) return false;
    this._decoysRemaining--;
    return true;
  }

  /** Spend a seal charge (§5). */
  consumeSealCharge(): boolean {
    if (this._sealCharges <= 0) return false;
    this._sealCharges--;
    return true;
  }

  private shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const a = items[i];
      items[i] = items[j];
      items[j] = a;
    }
    return items;
  }
}
