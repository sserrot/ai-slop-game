/**
 * Puzzle logic — shared vocabulary (DESIGN.md §11).
 *
 * EVERYTHING IN `src/puzzles/logic/` IS ISOMORPHIC. These files import nothing
 * but `@shared/*`: no three.js, no DOM, no browser globals. The authoritative
 * server (`server/sim/puzzles.ts`) imports this directory directly, so keeping
 * it renderer-free is a hard constraint, not a style preference.
 *
 * Puzzle state is server-authoritative (§7). The client mirrors `publicState()`
 * through the `puzzle` message and renders panels from it; it never mutates.
 */

import type {
  EscapeSystemId,
  ModuleId,
  NoiseKind,
  PlayerId,
  PuzzleId,
  Vec3,
} from '@shared/types';

// ---------------------------------------------------------------------------
// Effects a puzzle can ask the host for
// ---------------------------------------------------------------------------

/**
 * "I made this sound." The host turns it into a NoiseEvent, deriving loudness
 * from `noiseLoudness(kind)` — puzzles never state their own loudness, so the
 * §3 table stays the single source of truth.
 */
export interface PuzzleNoiseRequest {
  kind: NoiseKind;
  module: ModuleId;
  /** WORLD-space origin of the sound. */
  pos: Vec3;
  actor?: PlayerId;
}

/** A short line for the acting player's HUD (`ui:toast`). Never load-bearing. */
export interface PuzzleToast {
  to: PlayerId | null;
  text: string;
}

/**
 * Collected side effects of one `interact()` or `tick()` call. The host drains
 * this after every call: emit the noises, broadcast if `changed`, and run the
 * escape/director wiring if `solvedNow`.
 */
export class PuzzleEffects {
  readonly noises: PuzzleNoiseRequest[] = [];
  readonly toasts: PuzzleToast[] = [];
  /** State changed in a way clients need to see. */
  changed = false;
  /** The puzzle transitioned from unsolved to solved during this call. */
  solvedNow = false;

  noise(kind: NoiseKind, module: ModuleId, pos: Vec3, actor?: PlayerId): void {
    this.noises.push({ kind, module, pos: { x: pos.x, y: pos.y, z: pos.z }, actor });
  }

  toast(to: PlayerId | null, text: string): void {
    this.toasts.push({ to, text });
  }

  touch(): void {
    this.changed = true;
  }

  solve(): void {
    this.solvedNow = true;
    this.changed = true;
  }

  get empty(): boolean {
    return !this.changed && this.noises.length === 0 && this.toasts.length === 0;
  }

  reset(): void {
    this.noises.length = 0;
    this.toasts.length = 0;
    this.changed = false;
    this.solvedNow = false;
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * One routed interaction. Built from an `InteractMessage` (§7) plus the things
 * only the server knows: who sent it and where they are.
 */
export interface PuzzleCommand {
  playerId: PlayerId;
  /** Verb, e.g. 'throw' | 'turn' | 'hold' | 'release'. */
  action: string;
  /** Sub-element of the puzzle, parsed from `targetId` after the ':'. */
  element: string | null;
  value?: number | string | boolean;
  /** Module the acting player is actually in — puzzles refuse remote hands. */
  module: ModuleId | null;
  nowMs: number;
  tick: number;
}

export interface PuzzleTickContext {
  nowMs: number;
  tick: number;
  rng: () => number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Fields every puzzle state carries. Serialised straight into `Puzzle.state`. */
export interface PuzzleStateBase {
  id: PuzzleId;
  /** Primary module. Multi-module puzzles name their extra modules themselves. */
  module: ModuleId;
  solved: boolean;
  /** Bumped on every meaningful change; lets clients skip redundant redraws. */
  revision: number;
  /** WORLD positions of this puzzle's physical bits, keyed by element name. */
  anchors: Record<string, Vec3>;
}

/** Where a puzzle's hardware lives. The host fills the defaults from the layout. */
export interface PuzzlePlacement {
  id: PuzzleId;
  module: ModuleId;
  /** WORLD positions keyed by element. 'panel' is the fallback for everything. */
  anchors?: Record<string, Vec3>;
  /**
   * Extra modules this puzzle spans:
   *  - coolant-valve: [valveModule]
   *  - undock-sequence: [leverModuleB, leverModuleC]
   */
  partnerModules?: ModuleId[];
  /** Lockers this puzzle hides things in (breaker card, fuse spares). */
  lockers?: LockerRef[];
}

/** A locker prop somewhere in the station — where cards, fuses and decoys live. */
export interface LockerRef {
  module: ModuleId;
  /** `PropRef.id` of the locker. */
  propId: string;
  pos: Vec3;
  /** Jammed lockers must be pried (60, 3s) or hand-pumped (6, 25s) open (§11). */
  jammed?: boolean;
}

export interface PuzzleSetup {
  placement: PuzzlePlacement;
  rng: () => number;
}

// ---------------------------------------------------------------------------
// The puzzle interface
// ---------------------------------------------------------------------------

/**
 * One live puzzle. Implementations own a mutable state object; the host reads
 * `publicState()` for the wire and never writes to `state` directly.
 */
export interface PuzzleRuntime<S extends PuzzleStateBase = PuzzleStateBase> {
  readonly id: PuzzleId;
  /** Escape systems this puzzle brings online when solved (§11 `gates`). */
  readonly gates: EscapeSystemId[];
  /** Players needed to solve it at all (§10 — puzzles must spread people out). */
  readonly minPlayers: number;
  readonly state: S;
  get solved(): boolean;
  /** Every module this puzzle has hardware in, primary first. */
  modules(): ModuleId[];
  interact(cmd: PuzzleCommand, out: PuzzleEffects): void;
  tick(dt: number, ctx: PuzzleTickContext, out: PuzzleEffects): void;
  /** Networked view. May redact secrets (the breaker sequence, until read). */
  publicState(): unknown;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Escape systems (§11 "four systems online, then the undock sequence")
// ---------------------------------------------------------------------------

/**
 * The five system-granting puzzles. `SYSTEMS_TO_ESCAPE` is 4, so exactly one
 * may be skipped — which is how cargo stow stays the designated cut (§11/§13)
 * without the round becoming unwinnable when it is cut.
 */
export const ESCAPE_SYSTEMS = Object.freeze({
  POWER: 'power' as EscapeSystemId,
  COOLING: 'cooling' as EscapeSystemId,
  BALLAST: 'ballast' as EscapeSystemId,
  COMMS: 'comms' as EscapeSystemId,
  AIRLOCK: 'airlock' as EscapeSystemId,
});

/** Human labels for the panel readouts and the results screen. */
export const SYSTEM_LABELS: Readonly<Record<string, string>> = Object.freeze({
  power: 'MAIN BUS',
  cooling: 'COOLANT LOOP',
  ballast: 'BALLAST TRIM',
  comms: 'COMMS ARRAY',
  airlock: 'AIRLOCK CTRL',
});

/** Which puzzle gates which system. */
export const PUZZLE_GATES: Readonly<Record<PuzzleId, EscapeSystemId[]>> = Object.freeze({
  'breaker-sequence': [ESCAPE_SYSTEMS.POWER],
  'coolant-valve': [ESCAPE_SYSTEMS.COOLING],
  'cargo-stow': [ESCAPE_SYSTEMS.BALLAST],
  'fuse-hunt': [ESCAPE_SYSTEMS.COMMS],
  'airlock-keyswitch': [ESCAPE_SYSTEMS.AIRLOCK],
  // The finale is the escape itself; it gates no system.
  'undock-sequence': [],
});

// ---------------------------------------------------------------------------
// Small helpers every puzzle wants
// ---------------------------------------------------------------------------

/** Anchor lookup with a sane fallback chain: key → 'panel' → module origin. */
export function anchorOf(state: PuzzleStateBase, key: string): Vec3 {
  const a = state.anchors[key];
  if (a) return a;
  const panel = state.anchors['panel'];
  if (panel) return panel;
  return { x: 0, y: 0, z: 0 };
}

/** Bump `revision` and mark the effects dirty in one call. */
export function touch(state: PuzzleStateBase, out: PuzzleEffects): void {
  state.revision++;
  out.touch();
}

/**
 * How long a hold heartbeat stays valid. Clients send one per fixed tick while
 * a lever/wheel is held (20 Hz); 250 ms survives four dropped packets and still
 * releases fast enough that letting go feels immediate.
 *
 * NOT a §14 constant — a netcode grace window, stated here once.
 */
export const HOLD_GRACE_MS = 250;

/** Seconds between repeat noises from a continuous source (pump, pry, valve). */
export const CONTINUOUS_NOISE_INTERVAL_S = 1.0;
