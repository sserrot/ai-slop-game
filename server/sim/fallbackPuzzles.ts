/**
 * A working puzzle registry (DESIGN.md §11) — the fallback the room uses until
 * `server/sim/puzzles.ts` lands.
 *
 * All six puzzles, deliberately simple: "the difficulty is the alien, never the
 * logic." Every one of them obeys the hard rule — a loud-fast path and a
 * quiet-slow path — and every interaction pays its §3 loudness through
 * `ctx.emitNoise`, which is the only way the noise system stays relevant after
 * the map is learned.
 *
 * State that would spoil a puzzle (the breaker order) is kept private to this
 * module; only the public half travels in `Puzzle.state`.
 *
 * Interaction protocol: `interact { targetId, action, value }`.
 *   targetId — a puzzle id, or `${moduleId}:${propId}` of one of its panels.
 *   action   — see each puzzle below.
 */

import {
  BREAKER_COUNT,
  BREAKER_OVERRIDE_TIME_S,
  CARGO_BAG_COUNT,
  FUSE_COUNT,
  KEYSWITCH_WINDOW_S,
  SYSTEMS_TO_ESCAPE,
  UNDOCK_HOLD_S,
  UNDOCK_LEVER_COUNT,
  clamp,
} from '@shared/constants';
import type {
  EscapeSystemId,
  InteractMessage,
  ModuleId,
  PlayerId,
  Puzzle,
  PuzzleId,
  StationLayout,
  Vec3,
} from '@shared/types';
import { localToWorld } from '@shared/graph/math';
import type { PuzzleInteractResult, PuzzleSim, SimContext } from './contracts';

/** Which prop archetype belongs to which puzzle (see `station/layout.ts`). */
const PROP_TO_PUZZLE: Record<string, PuzzleId> = {
  'panel-breaker': 'breaker-sequence',
  'panel-gauge': 'coolant-valve',
  'panel-valve': 'coolant-valve',
  'cargo-rack': 'cargo-stow',
  'panel-fusebox': 'fuse-hunt',
  'panel-keyswitch': 'airlock-keyswitch',
  'panel-undock': 'undock-sequence',
};

/** §11 gates. Four of these are the escape systems (§14 SYSTEMS_TO_ESCAPE). */
const GATES: Record<PuzzleId, EscapeSystemId[]> = {
  'breaker-sequence': ['power'],
  'coolant-valve': ['coolant'],
  'cargo-stow': ['cargo'],
  'fuse-hunt': ['fuses'],
  'airlock-keyswitch': ['airlock'],
  'undock-sequence': ['undock'],
};

interface BreakerState {
  thrown: number[];
  overrideProgress: number;
}
interface ValveState {
  value: number;
  targetMin: number;
  targetMax: number;
  inBandFor: number;
}
interface CargoState {
  stowed: boolean[];
}
interface FuseState {
  installed: number;
  required: number;
}
interface KeyswitchState {
  turnedAt: [number, number];
}
interface UndockState {
  held: boolean[];
  progress: number;
  armed: boolean;
}

export class FallbackPuzzles implements PuzzleSim {
  private readonly _puzzles = new Map<PuzzleId, Puzzle>();
  /** `${module}:${prop}` → puzzle, so a panel can be interacted with directly. */
  private readonly propTargets = new Map<string, PuzzleId>();
  /** Which module each interactable target physically sits in (§6). */
  private readonly targetModule = new Map<string, ModuleId>();
  /** World position of each puzzle's panels, for noise origins. */
  private readonly panelPos = new Map<PuzzleId, Vec3>();
  /** The answer to the breaker sequence — never leaves the server (§11). */
  private breakerOrder: number[] = [];
  private overrideHeldBy: PlayerId | null = null;
  private overrideNoiseTimer = 0;

  constructor(
    private readonly layout: StationLayout,
    private readonly rng: () => number = Math.random,
  ) {
    this.build();
  }

  get puzzles(): readonly Puzzle[] {
    return [...this._puzzles.values()];
  }

  get(id: PuzzleId): Puzzle | undefined {
    return this._puzzles.get(id);
  }

  reset(): void {
    this.build();
  }

  // -------------------------------------------------------------------------

  private build(): void {
    this._puzzles.clear();
    this.propTargets.clear();
    this.targetModule.clear();
    this.panelPos.clear();
    this.overrideHeldBy = null;
    this.overrideNoiseTimer = 0;

    const moduleOf = new Map<PuzzleId, ModuleId>();
    for (const module of this.layout.modules) {
      for (const prop of module.props) {
        const puzzleId = PROP_TO_PUZZLE[prop.kind];
        if (!puzzleId) continue;
        this.propTargets.set(`${module.id}:${prop.id}`, puzzleId);
        this.targetModule.set(`${module.id}:${prop.id}`, module.id);
        if (!moduleOf.has(puzzleId)) moduleOf.set(puzzleId, module.id);
        if (!this.panelPos.has(puzzleId)) {
          this.panelPos.set(puzzleId, localToWorld(prop.localPos, module.transform));
        }
      }
    }

    const fallbackModule = this.layout.modules[0]?.id ?? this.layout.finaleModule;
    const make = (id: PuzzleId, state: unknown): void => {
      const module = moduleOf.get(id) ?? fallbackModule;
      this._puzzles.set(id, { id, module, state, solved: false, gates: [...GATES[id]] });
      this.targetModule.set(id, module);
      if (!this.panelPos.has(id)) {
        const centre = this.layout.modules.find((m) => m.id === module)?.transform.pos;
        this.panelPos.set(id, centre ? { ...centre } : { x: 0, y: 0, z: 0 });
      }
    };

    // 1 · Breaker sequence — six breakers in the right order, or a 20 s
    //     manual override at loudness 6 (§11).
    this.breakerOrder = shuffle(
      Array.from({ length: BREAKER_COUNT }, (_, i) => i),
      this.rng,
    );
    make('breaker-sequence', { thrown: [], overrideProgress: 0 } satisfies BreakerState);

    // 2 · Coolant valve — one turns, the other reads the needle (§11).
    const targetMin = 0.35 + this.rng() * 0.3;
    make('coolant-valve', {
      value: this.rng() * 0.25,
      targetMin,
      targetMax: targetMin + 0.12,
      inBandFor: 0,
    } satisfies ValveState);

    // 3 · Cargo stow — five bags, gently (§11, client-authoritative bodies).
    make('cargo-stow', {
      stowed: Array.from({ length: CARGO_BAG_COUNT }, () => false),
    } satisfies CargoState);

    // 4 · Fuse hunt — three fuses in randomised lockers (§11, `round/items.ts`).
    make('fuse-hunt', { installed: 0, required: FUSE_COUNT } satisfies FuseState);

    // 5 · Airlock keyswitch — two keys within one second (§11).
    make('airlock-keyswitch', { turnedAt: [0, 0] } satisfies KeyswitchState);

    // 6 · Undock sequence — three levers, five seconds, the finale (§11).
    make('undock-sequence', {
      held: Array.from({ length: UNDOCK_LEVER_COUNT }, () => false),
      progress: 0,
      armed: false,
    } satisfies UndockState);
  }

  // -------------------------------------------------------------------------

  interact(
    playerId: PlayerId,
    msg: InteractMessage,
    ctx: SimContext,
  ): PuzzleInteractResult | null {
    const id = this.resolve(msg.targetId);
    if (!id) return null;
    const puzzle = this._puzzles.get(id);
    if (!puzzle) return null;
    if (puzzle.solved) {
      return { puzzle, changed: false, systemsUnlocked: [], message: 'already done' };
    }

    switch (id) {
      case 'breaker-sequence':
        return this.breakers(puzzle, playerId, msg, ctx);
      case 'coolant-valve':
        return this.valve(puzzle, msg, ctx);
      case 'cargo-stow':
        return this.cargo(puzzle, msg, ctx);
      case 'fuse-hunt':
        return this.fuses(puzzle, msg, ctx);
      case 'airlock-keyswitch':
        return this.keyswitch(puzzle, msg, ctx);
      case 'undock-sequence':
        return this.undock(puzzle, msg, ctx);
      default:
        return null;
    }
  }

  update(dt: number, ctx: SimContext): PuzzleInteractResult[] {
    const out: PuzzleInteractResult[] = [];

    // Manual breaker override: anchored, unable to look around, 20 s at
    // loudness 6 — the quiet-slow path (§11).
    const breaker = this._puzzles.get('breaker-sequence');
    if (breaker && !breaker.solved && this.overrideHeldBy) {
      const state = breaker.state as BreakerState;
      state.overrideProgress += dt;
      this.overrideNoiseTimer -= dt;
      if (this.overrideNoiseTimer <= 0) {
        this.overrideNoiseTimer = 1.5;
        ctx.emitNoise('hand-pump', this.pos('breaker-sequence'), breaker.module, {
          actor: this.overrideHeldBy,
        });
      }
      if (state.overrideProgress >= BREAKER_OVERRIDE_TIME_S) {
        out.push(this.solve(breaker, 'power restored the slow way'));
        this.overrideHeldBy = null;
      } else {
        out.push({ puzzle: breaker, changed: true, systemsUnlocked: [] });
      }
    }

    // Coolant valve: the needle has to sit in the green band for two seconds.
    const valve = this._puzzles.get('coolant-valve');
    if (valve && !valve.solved) {
      const state = valve.state as ValveState;
      const inBand = state.value >= state.targetMin && state.value <= state.targetMax;
      state.inBandFor = inBand ? state.inBandFor + dt : 0;
      if (state.inBandFor >= 2) out.push(this.solve(valve, 'coolant loop stable'));
    }

    // Undock: three levers held simultaneously for five seconds (§11).
    const undock = this._puzzles.get('undock-sequence');
    if (undock && !undock.solved) {
      const state = undock.state as UndockState;
      state.armed = ctx.systemsOnline >= SYSTEMS_TO_ESCAPE;
      const all = state.held.every((h) => h);
      if (all && state.armed) {
        state.progress += dt;
        if (state.progress >= UNDOCK_HOLD_S) {
          out.push(this.solve(undock, 'undock sequence complete'));
        } else {
          out.push({ puzzle: undock, changed: true, systemsUnlocked: [] });
        }
      } else if (state.progress > 0) {
        state.progress = 0;
        out.push({ puzzle: undock, changed: true, systemsUnlocked: [] });
      }
    }

    return out;
  }

  // -- individual puzzles ---------------------------------------------------

  private breakers(
    puzzle: Puzzle,
    playerId: PlayerId,
    msg: InteractMessage,
    ctx: SimContext,
  ): PuzzleInteractResult {
    const state = puzzle.state as BreakerState;
    const pos = this.pos('breaker-sequence');

    if (msg.action === 'override-hold') {
      this.overrideHeldBy = playerId;
      return { puzzle, changed: true, systemsUnlocked: [], message: 'holding the override' };
    }
    if (msg.action === 'override-release') {
      if (this.overrideHeldBy === playerId) this.overrideHeldBy = null;
      state.overrideProgress = 0;
      return { puzzle, changed: true, systemsUnlocked: [] };
    }
    if (msg.action !== 'throw') return { puzzle, changed: false, systemsUnlocked: [] };

    const index = clamp(Number(msg.value ?? -1), -1, BREAKER_COUNT - 1);
    if (index < 0) return { puzzle, changed: false, systemsUnlocked: [] };

    // Each throw is a CLACK (35).
    ctx.emitNoise('breaker', pos, puzzle.module, { actor: playerId });

    const expected = this.breakerOrder[state.thrown.length];
    if (index !== expected) {
      // A wrong order resets the panel with a buzz (50).
      state.thrown = [];
      ctx.emitNoise('breaker-reset', pos, puzzle.module, { actor: playerId });
      return { puzzle, changed: true, systemsUnlocked: [], message: 'the panel buzzes and resets' };
    }

    state.thrown = [...state.thrown, index];
    if (state.thrown.length >= BREAKER_COUNT) return this.solve(puzzle, 'main bus online');
    return { puzzle, changed: true, systemsUnlocked: [] };
  }

  private valve(puzzle: Puzzle, msg: InteractMessage, ctx: SimContext): PuzzleInteractResult {
    const state = puzzle.state as ValveState;
    if (msg.action !== 'turn') return { puzzle, changed: false, systemsUnlocked: [] };

    const delta = clamp(Number(msg.value ?? 0), -0.5, 0.5);
    if (delta === 0) return { puzzle, changed: false, systemsUnlocked: [] };
    state.value = clamp(state.value + delta, 0, 1);

    // Turning slowly is quiet (8); spinning the wheel is loud (40) (§11).
    const kind = Math.abs(delta) <= 0.05 ? 'valve-slow' : 'valve-fast';
    ctx.emitNoise(kind, this.pos('coolant-valve'), puzzle.module);
    return { puzzle, changed: true, systemsUnlocked: [] };
  }

  private cargo(puzzle: Puzzle, msg: InteractMessage, ctx: SimContext): PuzzleInteractResult {
    const state = puzzle.state as CargoState;
    if (msg.action !== 'stow') return { puzzle, changed: false, systemsUnlocked: [] };
    const index = Math.round(Number(msg.value ?? -1));
    if (index < 0 || index >= state.stowed.length) {
      return { puzzle, changed: false, systemsUnlocked: [] };
    }
    if (state.stowed[index]) return { puzzle, changed: false, systemsUnlocked: [] };
    state.stowed[index] = true;
    if (state.stowed.every((s) => s)) return this.solve(puzzle, 'cargo secured');
    return { puzzle, changed: true, systemsUnlocked: [] };
  }

  private fuses(puzzle: Puzzle, msg: InteractMessage, ctx: SimContext): PuzzleInteractResult {
    const state = puzzle.state as FuseState;
    if (msg.action !== 'install-fuse') return { puzzle, changed: false, systemsUnlocked: [] };
    state.installed = Math.min(state.required, state.installed + 1);
    ctx.emitNoise('hand-pump', this.pos('fuse-hunt'), puzzle.module);
    if (state.installed >= state.required) return this.solve(puzzle, 'buses re-fused');
    return {
      puzzle,
      changed: true,
      systemsUnlocked: [],
      message: `${state.installed}/${state.required} fuses`,
    };
  }

  private keyswitch(puzzle: Puzzle, msg: InteractMessage, ctx: SimContext): PuzzleInteractResult {
    const state = puzzle.state as KeyswitchState;
    if (msg.action !== 'turn-key') return { puzzle, changed: false, systemsUnlocked: [] };
    const which = String(msg.value ?? 'a') === 'b' ? 1 : 0;
    const now = Date.now() / 1000;
    state.turnedAt[which] = now;

    // Loud on activation (45) no matter how careful you are (§11).
    ctx.emitNoise('keyswitch', this.pos('airlock-keyswitch'), puzzle.module);

    const other = state.turnedAt[which === 0 ? 1 : 0];
    if (other > 0 && Math.abs(now - other) <= KEYSWITCH_WINDOW_S) {
      return this.solve(puzzle, 'airlock armed');
    }
    return { puzzle, changed: true, systemsUnlocked: [], message: 'count it down again' };
  }

  private undock(puzzle: Puzzle, msg: InteractMessage, ctx: SimContext): PuzzleInteractResult {
    const state = puzzle.state as UndockState;
    const index = clamp(Math.round(Number(msg.value ?? 0)), 0, UNDOCK_LEVER_COUNT - 1);

    if (msg.action === 'hold') {
      if (!state.held[index]) {
        state.held[index] = true;
        ctx.emitNoise('undock-lever', this.pos('undock-sequence'), puzzle.module);
      }
      if (ctx.systemsOnline < SYSTEMS_TO_ESCAPE) {
        return {
          puzzle,
          changed: true,
          systemsUnlocked: [],
          message: `${ctx.systemsOnline}/${SYSTEMS_TO_ESCAPE} systems — the levers are dead`,
        };
      }
      return { puzzle, changed: true, systemsUnlocked: [] };
    }
    if (msg.action === 'release') {
      state.held[index] = false;
      state.progress = 0;
      return { puzzle, changed: true, systemsUnlocked: [] };
    }
    return { puzzle, changed: false, systemsUnlocked: [] };
  }

  // -- helpers --------------------------------------------------------------

  private solve(puzzle: Puzzle, message: string): PuzzleInteractResult {
    puzzle.solved = true;
    return { puzzle, changed: true, systemsUnlocked: [...puzzle.gates], message };
  }

  /** Where this target physically is, so the room can refuse remote solving. */
  moduleFor(targetId: string): ModuleId | null {
    return this.targetModule.get(targetId) ?? null;
  }

  private resolve(targetId: string): PuzzleId | null {
    if (this._puzzles.has(targetId as PuzzleId)) return targetId as PuzzleId;
    return this.propTargets.get(targetId) ?? null;
  }

  private pos(id: PuzzleId): Vec3 {
    return this.panelPos.get(id) ?? { x: 0, y: 0, z: 0 };
  }
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i];
    items[i] = items[j];
    items[j] = a;
  }
  return items;
}
