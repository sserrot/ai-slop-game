/**
 * src/puzzles/logic — the isomorphic puzzle core (DESIGN.md §11).
 *
 * THIS BARREL IS THE SERVER'S ONLY DOOR INTO src/. `server/sim/puzzles.ts`
 * imports exactly this path and nothing else under `src/`. Every file behind it
 * imports only `@shared/*` and its own siblings: no three.js, no DOM, no Vite.
 *
 * Puzzle STATE is server-authoritative (§7). The client imports the same code
 * for its types and its panel drawing, and never runs `interact`/`tick` locally
 * — there is no prediction anywhere in this project (§7 r1 reversal) and puzzles
 * are the last place that would be worth starting.
 */

export * from './types';
export * from './props';
export * from './rng';
export * from './jammed';
export * from './lockers';
export * from './escape';
export * from './registry';

export * from './breakerSequence';
export * from './coolantValve';
export * from './cargoStow';
export * from './fuseHunt';
export * from './airlockKeyswitch';
export * from './undockSequence';
