/**
 * Which puzzle a station prop belongs to (DESIGN.md §11, §2).
 *
 * Two layout authors ended up with two vocabularies for the same hardware:
 *
 *   - `server/station/layout.ts` (the built-in procedural kit) tags each panel
 *     with a role-specific archetype: `panel-breaker`, `panel-valve`, …
 *   - `levels/station.json` (the authored 9-module station) tags every panel
 *     `panel` — the archetype the RENDERER needs, because that is what decides
 *     the geometry — and puts the role in the prop id: `node-beta-panel-breaker`.
 *
 * Both are reasonable and neither is wrong, so this file is the one place that
 * knows about both. `server/sim/puzzles.ts` (placement + interaction routing)
 * and `src/puzzles/panels.ts` (the CanvasTexture faces) resolve through it, so
 * the same station drives the same puzzles on both sides.
 *
 * Isomorphic: imports nothing but `@shared/types`.
 */

import type { PropRef } from '@shared/types';

/** Canonical puzzle-hardware archetypes. */
export const PUZZLE_PROP_KINDS = Object.freeze({
  BREAKER: 'panel-breaker',
  GAUGE: 'panel-gauge',
  VALVE: 'panel-valve',
  CARGO_RACK: 'cargo-rack',
  FUSEBOX: 'panel-fusebox',
  KEYSWITCH: 'panel-keyswitch',
  UNDOCK: 'panel-undock',
} as const);

export type PuzzlePropRole = (typeof PUZZLE_PROP_KINDS)[keyof typeof PUZZLE_PROP_KINDS];

const CANONICAL = new Set<string>(Object.values(PUZZLE_PROP_KINDS));

/**
 * Id patterns, in priority order. Anchored on the role word so a module id can
 * never accidentally claim a role (`node-beta-panel-breaker` → breaker, but a
 * module called `breaker-bay` holding a plain `rack` stays a rack).
 *
 * `cargo-slot-N` resolves to CARGO_RACK on purpose — see below.
 */
const ID_PATTERNS: ReadonlyArray<readonly [RegExp, PuzzlePropRole]> = [
  [/panel-breaker\b/i, PUZZLE_PROP_KINDS.BREAKER],
  [/panel-gauge\b/i, PUZZLE_PROP_KINDS.GAUGE],
  [/panel-valve\b/i, PUZZLE_PROP_KINDS.VALVE],
  [/panel-fuse(box)?(-\d+)?\b/i, PUZZLE_PROP_KINDS.FUSEBOX],
  [/panel-keyswitch/i, PUZZLE_PROP_KINDS.KEYSWITCH],
  [/panel-undock(-\d+)?\b/i, PUZZLE_PROP_KINDS.UNDOCK],
  [/cargo-(rack|slot)(-\d+)?\b/i, PUZZLE_PROP_KINDS.CARGO_RACK],
];

/** `cargo-slot-3` → 2, zero-based. Null for anything that is not a slot. */
const SLOT_INDEX = /cargo-slot-(\d+)\b/i;

/**
 * The puzzle role of one prop, or null if it is scenery.
 *
 * The archetype wins when it is already canonical; otherwise the id decides,
 * and only for props that are actually panels, racks or rack slots — a locker
 * called `escape-panel-undock-locker` is still a locker.
 *
 * THE `slot` CASE, which is why puzzle 3 was unsolvable. Both layout authors
 * describe the same hardware and neither of them says `cargo-rack`:
 *
 *   - `server/station/layout.ts` authors one panel tagged `cargo-rack`;
 *   - `levels/station.json` — the station the game actually loads — authors
 *     FIVE `slot` props, `tube-spine-cargo-slot-1` … `-5`, which are the five
 *     numbered rack slots §11 puzzle 3 is played into, and no rack at all.
 *
 * So `findProps(layout, CARGO_RACK)` found nothing on the real station, the
 * server's placement fell through to `fallbackModule()`, and cargo-stow was
 * placed in whichever module happened to be free — not the one holding the
 * rack. Every `stow` report then arrived from a player standing in a different
 * module from the one the puzzle believed it was in, and `CargoStowPuzzle`
 * correctly refused all of them ("puzzles refuse remote hands"). The objective
 * was permanently unsolvable, and nothing was broken except this table.
 *
 * A rack authored as five slot markers is still a rack. This file is already
 * the one place that knows about both vocabularies (see the header); it now
 * knows about the third.
 */
export function puzzlePropRole(prop: PropRef): PuzzlePropRole | null {
  if (CANONICAL.has(prop.kind)) return prop.kind as PuzzlePropRole;
  if (prop.kind !== 'panel' && prop.kind !== 'rack' && prop.kind !== 'slot') return null;
  for (const [pattern, role] of ID_PATTERNS) {
    if (pattern.test(prop.id)) return role;
  }
  return null;
}

/**
 * Zero-based index of an authored rack slot, or null if the prop is the rack
 * itself (or not cargo hardware at all).
 *
 * Slots are numbered from 1 in the level and bags are numbered from 1 by
 * `cargoSlotId()`, so this is the one place the two numbering schemes meet.
 */
export function cargoSlotIndex(propId: string): number | null {
  const hit = SLOT_INDEX.exec(propId);
  if (!hit) return null;
  const n = Number.parseInt(hit[1], 10);
  return Number.isFinite(n) && n >= 1 ? n - 1 : null;
}

/** True when the prop plays this exact puzzle role. */
export function isPuzzleProp(prop: PropRef, role: string): boolean {
  return puzzlePropRole(prop) === role;
}

/** `key-a` / `key-b` for §11·5, from a keyswitch prop's id. */
export function keyswitchSide(propId: string): 'key-a' | 'key-b' {
  return /b$/i.test(propId) ? 'key-b' : 'key-a';
}
