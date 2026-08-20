/**
 * Lockers — where the game hides things (DESIGN.md §5, §11).
 *
 * Three separate systems reach into the same set of props: the breaker card
 * ("stowed in a locker in another module, somewhere different each round"), the
 * three spare fuses, and the two decoys per round. They must not collide, so
 * placement runs through one registry with one seeded roll.
 *
 * The alien/round agent is welcome to `collectLockers()` and `takeLockers()` for
 * the decoys; just share the same `LockerPool` so nothing lands twice.
 */

import type { ModuleId, StationModule } from '@shared/types';
import { localToWorld } from '@shared/graph/math';
import { shuffled } from './rng';
import type { LockerRef } from './types';

/** Prop kinds that count as a locker. Station agent: name them one of these. */
/**
 * Prop archetypes a player can actually open.
 *
 * 'stowage' was here and is NOT: in `levels/station.json` a stowage bag is an
 * instanced decorative prop with no interaction tag, so a fuse stashed in one
 * would be unreachable — and an unreachable fuse is an unwinnable round. The
 * room's `ItemRegistry` matches 'locker' alone; keep this set a superset of
 * what `src/station/lockers.ts` builds interactables for.
 */
export const LOCKER_PROP_KINDS: readonly string[] = Object.freeze([
  'locker',
  'crate',
  'cabinet',
]);

/**
 * Every locker in the station, in world space. Modules with no authored locker
 * prop still contribute one synthetic locker at the module origin — the puzzles
 * must not stop working because the art pass has not happened yet (§9
 * "grey-box everything in primitives until M8").
 */
export function collectLockers(modules: readonly StationModule[]): LockerRef[] {
  const out: LockerRef[] = [];
  for (const module of modules) {
    let found = 0;
    for (const prop of module.props) {
      if (!LOCKER_PROP_KINDS.includes(prop.kind)) continue;
      out.push({
        module: module.id,
        propId: prop.id,
        pos: localToWorld(prop.localPos, module.transform),
      });
      found++;
    }
    if (found === 0) {
      out.push({
        module: module.id,
        propId: `${module.id}:locker`,
        pos: { ...module.transform.pos },
      });
    }
  }
  return out;
}

export interface LockerPickOptions {
  /** Never pick a locker in one of these modules. */
  excludeModules?: readonly ModuleId[];
  /** Never pick these exact lockers (already spoken for). */
  exclude?: readonly LockerRef[];
  /** Prefer picks in modules nothing has been hidden in yet. Default true. */
  distinctModules?: boolean;
  /** Fraction of picked lockers that come out jammed (§11 pry-or-pump). */
  jammedChance?: number;
}

/**
 * A shuffled pool you draw from. One pool per round keeps the card, the fuses
 * and the decoys out of each other's lockers.
 */
export class LockerPool {
  private readonly remaining: LockerRef[];
  private readonly taken: LockerRef[] = [];
  private readonly rng: () => number;

  constructor(lockers: readonly LockerRef[], rng: () => number) {
    this.rng = rng;
    this.remaining = shuffled(rng, lockers);
  }

  get size(): number {
    return this.remaining.length;
  }

  /** Everything drawn so far, in draw order. */
  get drawn(): readonly LockerRef[] {
    return this.taken;
  }

  /**
   * Draw `count` lockers. Falls back gracefully: distinct modules if it can,
   * then any module, then repeats rather than returning short — a round with a
   * three-module station is a broken layout, not a crash.
   */
  take(count: number, opts: LockerPickOptions = {}): LockerRef[] {
    const excludeModules = new Set(opts.excludeModules ?? []);
    const excluded = new Set((opts.exclude ?? []).map(lockerKey));
    const distinct = opts.distinctModules !== false;
    const jammedChance = opts.jammedChance ?? 0;
    const usedModules = new Set<ModuleId>();
    const out: LockerRef[] = [];

    const passes: Array<(l: LockerRef) => boolean> = [
      (l) => !excludeModules.has(l.module) && !excluded.has(lockerKey(l)) && !usedModules.has(l.module),
      (l) => !excludeModules.has(l.module) && !excluded.has(lockerKey(l)),
      (l) => !excluded.has(lockerKey(l)),
      () => true,
    ];
    if (!distinct) passes.shift();

    while (out.length < count) {
      let picked: LockerRef | undefined;
      for (const ok of passes) {
        const i = this.remaining.findIndex(ok);
        if (i >= 0) {
          picked = this.remaining.splice(i, 1)[0];
          break;
        }
      }
      if (!picked) {
        // Nothing left at all — reuse the last draw rather than return short.
        picked = this.taken.length > 0 ? { ...this.taken[this.taken.length - 1] } : undefined;
      }
      if (!picked) break;
      picked = { ...picked, jammed: this.rng() < jammedChance };
      usedModules.add(picked.module);
      this.taken.push(picked);
      out.push(picked);
    }
    return out;
  }
}

export function lockerKey(l: LockerRef): string {
  return `${l.module}:${l.propId}`;
}
