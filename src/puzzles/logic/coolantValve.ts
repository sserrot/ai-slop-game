/**
 * Puzzle 2 · COOLANT VALVE — 2 players, 2 modules, THE THESIS PUZZLE (§11).
 *
 * Module A has a pressure gauge and no valve. Module B has the valve wheel and
 * no gauge. One turns, the other reads the needle and talks them into the green
 * band. Turning slowly is quiet (8); spinning the wheel is loud (40), so the
 * reader has to stay patient while their partner sits alone in the dark.
 *
 * "One synced float, a target range, a needle. Thirty lines, and it is the
 * entire design in one interaction."
 *
 * The one piece of machinery beyond the float is the NEEDLE LAG. The gauge does
 * not read the valve, it reads a damped follower of the valve. That single
 * half-life is what makes the loud path genuinely worse rather than merely
 * louder: spin at 0.35/s and the needle trails ~0.12 behind — wider than the
 * whole green band — so "STOP" arrives too late and you sail through. Creep at
 * 0.05/s and the needle is glued to the wheel. Skill, again, buys silence.
 *
 * Known hole, deliberately unpatched (§11): two players with knock codes can
 * signal up/down through the bulkhead and solve this in near-silence. Leave it.
 */

import type { EscapeSystemId, ModuleId, PlayerId } from '@shared/types';
import { clamp } from '@shared/constants';
import { randRange } from './rng';
import {
  anchorOf,
  CONTINUOUS_NOISE_INTERVAL_S,
  HOLD_GRACE_MS,
  PUZZLE_GATES,
  touch,
  type PuzzleCommand,
  type PuzzleEffects,
  type PuzzleRuntime,
  type PuzzleSetup,
  type PuzzleStateBase,
  type PuzzleTickContext,
} from './types';

// --- Local tuning. None of these are §14 constants; the §14 pieces this puzzle
//     uses are LOUDNESS.VALVE_SLOW (8) and LOUDNESS.VALVE_FAST (40), reached
//     through the 'valve-slow' / 'valve-fast' NoiseKinds. -----------------------

/** Valve units per second, careful hand. Full sweep in 20 s. */
export const VALVE_RATE_SLOW = 0.05;
/** Valve units per second, spinning it. Full sweep in under 3 s. */
export const VALVE_RATE_FAST = 0.35;
/** |value| at or above this on a `turn` command means "spinning it". */
export const VALVE_FAST_THRESHOLD = 0.5;
/** Seconds for the needle to cover half the gap to the valve. The lag IS the puzzle. */
export const NEEDLE_HALFLIFE_S = 0.35;
/** Half-width of the green band, in valve units. 10 % of the sweep, total. */
export const VALVE_BAND_HALF = 0.05;
/** Seconds the needle must sit in the band before the loop locks itself in. */
export const VALVE_HOLD_S = 2.0;
/** Target is rolled inside this range so it is never against an end stop. */
export const VALVE_TARGET_MIN = 0.2;
export const VALVE_TARGET_MAX = 0.8;
/** Lock-to-lock turns of the physical wheel, for the valve panel's animation. */
export const VALVE_WHEEL_TURNS = 4;

export interface CoolantState extends PuzzleStateBase {
  id: 'coolant-valve';
  /** Module with the gauge — the primary module. */
  gaugeModule: ModuleId;
  /** Module with the wheel. Adjacent to the gauge module where the layout allows. */
  valveModule: ModuleId;

  /** THE synced float, 0–1. */
  value: number;
  /** What the gauge actually shows: a damped follower of `value`. */
  needle: number;
  /** Centre of the green band, on the needle's scale. Rolled per round. */
  target: number;
  bandHalf: number;

  inBand: boolean;
  holdSeconds: number;
  holdRequired: number;

  /** -1, 0 or +1 — which way the wheel is being turned right now. */
  turnDir: -1 | 0 | 1;
  /** True while it is being spun rather than eased. */
  turnFast: boolean;
  turner: PlayerId | null;
}

export class CoolantValvePuzzle implements PuzzleRuntime<CoolantState> {
  readonly id = 'coolant-valve' as const;
  readonly gates: EscapeSystemId[] = PUZZLE_GATES['coolant-valve'].slice();
  readonly minPlayers = 2;
  readonly state: CoolantState;

  private turningUntilMs = 0;
  private noiseAccum = 0;
  private readonly initialValue: number;

  constructor(setup: PuzzleSetup) {
    const { placement, rng } = setup;
    const partner = placement.partnerModules ?? [];
    const valveModule = partner[0] ?? placement.module;
    // Start the valve away from the target so there is always work to do.
    const target = randRange(rng, VALVE_TARGET_MIN, VALVE_TARGET_MAX);
    const start = target > 0.5 ? randRange(rng, 0, 0.15) : randRange(rng, 0.85, 1);
    this.initialValue = start;

    this.state = {
      id: 'coolant-valve',
      module: placement.module,
      solved: false,
      revision: 0,
      anchors: placement.anchors ?? {},
      gaugeModule: placement.module,
      valveModule,
      value: start,
      needle: start,
      target,
      bandHalf: VALVE_BAND_HALF,
      inBand: false,
      holdSeconds: 0,
      holdRequired: VALVE_HOLD_S,
      turnDir: 0,
      turnFast: false,
      turner: null,
    };
  }

  get solved(): boolean {
    return this.state.solved;
  }

  modules(): ModuleId[] {
    const s = this.state;
    return s.valveModule === s.gaugeModule ? [s.gaugeModule] : [s.gaugeModule, s.valveModule];
  }

  interact(cmd: PuzzleCommand, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;

    switch (cmd.action) {
      case 'turn': {
        // The wheel is in the valve module and nowhere else.
        if (cmd.module !== null && cmd.module !== s.valveModule) return;
        const input = readTurn(cmd);
        if (input === null) return;
        if (s.turner !== null && s.turner !== cmd.playerId && cmd.nowMs <= this.turningUntilMs) {
          return; // one pair of hands on the wheel
        }
        const startedTurning = s.turnDir === 0;
        if (startedTurning || s.turnDir !== input.dir || s.turnFast !== input.fast) {
          // Make the first sound of a spin land immediately, not a second late.
          this.noiseAccum = CONTINUOUS_NOISE_INTERVAL_S;
          touch(s, out);
        }
        s.turner = cmd.playerId;
        s.turnDir = input.dir;
        s.turnFast = input.fast;
        this.turningUntilMs = cmd.nowMs + HOLD_GRACE_MS;
        return;
      }

      case 'stop':
      case 'release': {
        if (s.turner !== null && s.turner !== cmd.playerId) return;
        if (s.turnDir !== 0) touch(s, out);
        s.turnDir = 0;
        s.turnFast = false;
        s.turner = null;
        this.turningUntilMs = 0;
        this.noiseAccum = 0;
        return;
      }

      case 'lock': {
        // The reader slamming the seal the instant the needle crosses into the
        // green. Optional — the loop also locks itself after `holdRequired`
        // seconds — but it is the reader's hands-on job, and it is faster.
        if (cmd.module !== null && cmd.module !== s.gaugeModule) return;
        if (!s.inBand) {
          out.toast(cmd.playerId, 'Pressure is out of band. Talk them in.');
          return;
        }
        this.lockIn(out);
        return;
      }

      default:
        return;
    }
  }

  tick(dt: number, ctx: PuzzleTickContext, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;

    // --- the wheel -----------------------------------------------------------
    if (s.turnDir !== 0 && ctx.nowMs > this.turningUntilMs) {
      // Heartbeat lapsed: they let go, or their connection did.
      s.turnDir = 0;
      s.turnFast = false;
      s.turner = null;
      this.noiseAccum = 0;
      touch(s, out);
    }

    if (s.turnDir !== 0) {
      const rate = s.turnFast ? VALVE_RATE_FAST : VALVE_RATE_SLOW;
      const before = s.value;
      s.value = clamp(s.value + s.turnDir * rate * dt, 0, 1);
      if (s.value !== before) touch(s, out);

      this.noiseAccum += dt;
      if (this.noiseAccum >= CONTINUOUS_NOISE_INTERVAL_S) {
        // One event per second is enough: the alien's coalescer evaluates a
        // rolling 1.0 s window and acts on the loudest event in it (§3), so
        // spamming the graph at 20 Hz would change nothing but the CPU bill.
        this.noiseAccum -= CONTINUOUS_NOISE_INTERVAL_S;
        out.noise(
          s.turnFast ? 'valve-fast' : 'valve-slow',
          s.valveModule,
          anchorOf(s, 'wheel'),
          s.turner ?? undefined,
        );
      }
    }

    // --- the needle ----------------------------------------------------------
    // Damped follower, specified as a half-life. Never a bare exponent (§4).
    const follow = 1 - Math.pow(0.5, dt / NEEDLE_HALFLIFE_S);
    const gap = s.value - s.needle;
    if (Math.abs(gap) > 1e-5) {
      s.needle += gap * follow;
      touch(s, out);
    } else if (s.needle !== s.value) {
      s.needle = s.value;
      touch(s, out);
    }

    // --- the band ------------------------------------------------------------
    const inBand = Math.abs(s.needle - s.target) <= s.bandHalf;
    if (inBand !== s.inBand) {
      s.inBand = inBand;
      s.holdSeconds = 0;
      touch(s, out);
      if (inBand) out.toast(null, 'Pressure in the green.');
    }
    if (inBand) {
      s.holdSeconds += dt;
      if (s.holdSeconds >= s.holdRequired) this.lockIn(out);
    }
  }

  private lockIn(out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;
    s.solved = true;
    s.holdSeconds = s.holdRequired;
    s.turnDir = 0;
    s.turnFast = false;
    s.turner = null;
    this.turningUntilMs = 0;
    out.solve();
    out.toast(null, 'Coolant loop online.');
  }

  publicState(): unknown {
    // Nothing here is secret: the gauge player can see the band, the valve
    // player can see the wheel, and neither can see the other's panel because
    // they are in different modules. That separation is physical, not data.
    return { ...this.state };
  }

  reset(): void {
    const s = this.state;
    s.solved = false;
    s.value = this.initialValue;
    s.needle = this.initialValue;
    s.inBand = false;
    s.holdSeconds = 0;
    s.turnDir = 0;
    s.turnFast = false;
    s.turner = null;
    this.turningUntilMs = 0;
    this.noiseAccum = 0;
    s.revision++;
  }
}

/** Read direction and speed from a `turn` command. */
function readTurn(cmd: PuzzleCommand): { dir: -1 | 1; fast: boolean } | null {
  const v = cmd.value;
  if (typeof v === 'number') {
    if (v === 0 || !Number.isFinite(v)) return null;
    return { dir: v > 0 ? 1 : -1, fast: Math.abs(v) >= VALVE_FAST_THRESHOLD };
  }
  if (typeof v === 'string') {
    const t = v.toLowerCase();
    const dir: -1 | 1 | 0 = t.includes('up') || t.includes('open') || t.includes('+')
      ? 1
      : t.includes('down') || t.includes('close') || t.includes('-')
        ? -1
        : 0;
    if (dir === 0) return null;
    return { dir, fast: t.includes('fast') || t.includes('spin') };
  }
  return null;
}
