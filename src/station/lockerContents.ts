/**
 * What is in the lockers (DESIGN.md §5 decoys, §11 puzzles 1 and 4).
 *
 * "The sequence is on a laminated card stowed in a locker in another module,
 * somewhere different each round." — §11 · 1
 * "Three blown fuses, three replacements in randomised lockers." — §11 · 4
 * "Throwable… Two per round, found in lockers, no respawn." — §5
 *
 * Pure: no three.js, no DOM. The server is authoritative over item spawns (§7),
 * so it can call this with the round seed and broadcast the result; the client
 * calls it with the same seed and gets the same answer.
 */

import { DECOYS_PER_ROUND, FUSE_COUNT } from '@shared/constants';
import type { ModuleId, StationLayout } from '@shared/types';
import { rngFor, shuffled } from './random';

export type StationItemKind = 'breaker-card' | 'fuse' | 'decoy';

export interface StationItem {
  id: string;
  kind: StationItemKind;
}

export interface LockerRef {
  /** PropRef id — the same id `StationLockers` keys its meshes by. */
  id: string;
  module: ModuleId;
}

/** Every locker in the layout, in authored order. */
export function lockerRefs(layout: StationLayout): LockerRef[] {
  const out: LockerRef[] = [];
  for (const m of layout.modules) {
    for (const p of m.props) {
      if (p.kind === 'locker') out.push({ id: p.id, module: m.id });
    }
  }
  return out;
}

/** The module holding the panel whose id contains `role` (e.g. 'breaker'). */
export function findPanelModule(layout: StationLayout, role: string): ModuleId | null {
  for (const m of layout.modules) {
    for (const p of m.props) {
      if (p.kind === 'panel' && p.id.includes(role)) return m.id;
    }
  }
  return null;
}

export interface LockerPlanOptions {
  decoys?: number;
  fuses?: number;
  /** Modules whose lockers may not hold the breaker card. Defaults to the
   *  module holding the breaker panel — §11 says the card lives elsewhere. */
  cardExcludes?: readonly ModuleId[];
}

/**
 * Distribute the round's loose items across lockers, one item per locker where
 * possible so searching is traversal rather than a lucky first pick.
 */
export function planLockerContents(
  layout: StationLayout,
  seed: number,
  opts: LockerPlanOptions = {},
): Map<string, StationItem[]> {
  const rng = rngFor('lockers', seed, layout.id);
  const lockers = lockerRefs(layout);
  const plan = new Map<string, StationItem[]>();
  if (lockers.length === 0) return plan;

  const breakerModule = findPanelModule(layout, 'breaker');
  const excluded = new Set<ModuleId>(opts.cardExcludes ?? (breakerModule ? [breakerModule] : []));

  const pool = shuffled(rng, lockers);
  const used = new Set<string>();

  const take = (predicate?: (l: LockerRef) => boolean): LockerRef | null => {
    for (const l of pool) {
      if (used.has(l.id)) continue;
      if (predicate && !predicate(l)) continue;
      used.add(l.id);
      return l;
    }
    // Every locker already holds something: allow a second item rather than
    // dropping the item on the floor.
    for (const l of pool) {
      if (predicate && !predicate(l)) continue;
      return l;
    }
    return null;
  };

  const add = (locker: LockerRef | null, item: StationItem): void => {
    if (!locker) return;
    const list = plan.get(locker.id) ?? [];
    list.push(item);
    plan.set(locker.id, list);
  };

  add(take((l) => !excluded.has(l.module)), { id: 'breaker-card', kind: 'breaker-card' });
  const fuses = opts.fuses ?? FUSE_COUNT;
  for (let i = 0; i < fuses; i++) {
    add(take(), { id: `fuse-${i + 1}`, kind: 'fuse' });
  }
  const decoys = opts.decoys ?? DECOYS_PER_ROUND;
  for (let i = 0; i < decoys; i++) {
    add(take(), { id: `decoy-${i + 1}`, kind: 'decoy' });
  }
  return plan;
}
