/**
 * Puzzle 6 · UNDOCK SEQUENCE — 3 players, 3 modules, THE FINALE (§11).
 *
 * Three release levers held for five seconds simultaneously. The whole team,
 * split up, counting down over voice, at loudness 60. The alien is coming and
 * everyone knows it.
 *
 * THREE players and not six, so a half-dead crew can still get out (§10). That
 * number is load-bearing: it is the difference between "we lost two people, so
 * we lost" and "we lost two people, so we run".
 *
 * There is no quiet path and there is not supposed to be one. This is the moment
 * the game stops offering you a choice — which only works because every other
 * puzzle did.
 */

import type { EscapeSystemId, ModuleId, PlayerId, Vec3 } from '@shared/types';
import { SYSTEMS_TO_ESCAPE, UNDOCK_HOLD_S, UNDOCK_LEVER_COUNT } from '@shared/constants';
import {
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

export interface UndockLever {
  id: string;
  module: ModuleId;
  pos: Vec3;
  holder: PlayerId | null;
  /** Heartbeat deadline; the grip lapses when `nowMs` passes it. */
  holdUntilMs: number;
  engaged: boolean;
}

export interface UndockState extends PuzzleStateBase {
  id: 'undock-sequence';
  /** False until the escape machine reports four systems online. */
  armed: boolean;
  systemsRequired: number;
  levers: UndockLever[];
  /** Seconds all three have been held at once. Any release zeroes it. */
  progress: number;
  required: number;
  engagedCount: number;
  /** True once the sequence completes — the station lets go of the capsule. */
  undocked: boolean;
}

export function undockLeverId(index: number): string {
  return `lever-${index + 1}`;
}

export class UndockSequencePuzzle implements PuzzleRuntime<UndockState> {
  readonly id = 'undock-sequence' as const;
  readonly gates: EscapeSystemId[] = PUZZLE_GATES['undock-sequence'].slice();
  readonly minPlayers = UNDOCK_LEVER_COUNT;
  readonly state: UndockState;

  private noiseAccum = 0;

  constructor(setup: PuzzleSetup) {
    const { placement } = setup;
    const partners = placement.partnerModules ?? [];
    const anchors = placement.anchors ?? {};
    const levers: UndockLever[] = [];
    for (let i = 0; i < UNDOCK_LEVER_COUNT; i++) {
      const id = undockLeverId(i);
      const module = i === 0 ? placement.module : (partners[i - 1] ?? placement.module);
      levers.push({
        id,
        module,
        pos: anchors[id] ?? anchors['panel'] ?? { x: 0, y: 0, z: 0 },
        holder: null,
        holdUntilMs: 0,
        engaged: false,
      });
    }

    this.state = {
      id: 'undock-sequence',
      module: placement.module,
      solved: false,
      revision: 0,
      anchors,
      armed: false,
      systemsRequired: SYSTEMS_TO_ESCAPE,
      levers,
      progress: 0,
      required: UNDOCK_HOLD_S,
      engagedCount: 0,
      undocked: false,
    };
  }

  get solved(): boolean {
    return this.state.solved;
  }

  modules(): ModuleId[] {
    const out: ModuleId[] = [];
    for (const l of this.state.levers) if (!out.includes(l.module)) out.push(l.module);
    if (!out.includes(this.state.module)) out.unshift(this.state.module);
    return out;
  }

  /** The escape machine calls this when the fourth system comes online. */
  arm(armed: boolean, out?: PuzzleEffects): void {
    if (this.state.armed === armed) return;
    this.state.armed = armed;
    this.state.revision++;
    if (out) {
      out.touch();
      if (armed) out.toast(null, 'Undock levers armed. Three of you, five seconds.');
    }
  }

  private leverFrom(cmd: PuzzleCommand): UndockLever | undefined {
    const key = typeof cmd.value === 'string' ? cmd.value : cmd.element;
    if (key) {
      const byId = this.state.levers.find((l) => l.id === key);
      if (byId) return byId;
      const n = Number.parseInt(key.replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(n) && n >= 1 && n <= this.state.levers.length) {
        return this.state.levers[n - 1];
      }
    }
    if (typeof cmd.value === 'number') {
      const i = Math.trunc(cmd.value);
      if (i >= 0 && i < this.state.levers.length) return this.state.levers[i];
    }
    // No id given: the lever in the module the player is standing in.
    if (cmd.module) return this.state.levers.find((l) => l.module === cmd.module);
    return undefined;
  }

  interact(cmd: PuzzleCommand, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;
    const lever = this.leverFrom(cmd);
    if (!lever) return;

    switch (cmd.action) {
      case 'hold': {
        if (cmd.module !== null && cmd.module !== lever.module) return;
        if (!s.armed) {
          out.toast(
            cmd.playerId,
            `The lever will not budge. ${s.systemsRequired} systems must be online.`,
          );
          return;
        }
        const lapsed = cmd.nowMs > lever.holdUntilMs;
        if (lever.holder !== null && lever.holder !== cmd.playerId && !lapsed) return;
        // Three levers, three pairs of hands: nobody holds two.
        const alreadyElsewhere = s.levers.some(
          (l) => l !== lever && l.holder === cmd.playerId && cmd.nowMs <= l.holdUntilMs,
        );
        if (alreadyElsewhere) return;

        if (!lever.engaged || lapsed) {
          lever.engaged = true;
          lever.holder = cmd.playerId;
          // Each lever screams the moment it is pulled.
          out.noise('undock-lever', lever.module, lever.pos, cmd.playerId);
          touch(s, out);
        }
        lever.holdUntilMs = cmd.nowMs + HOLD_GRACE_MS;
        return;
      }

      case 'release': {
        if (lever.holder !== cmd.playerId) return;
        this.dropLever(lever, out);
        return;
      }

      default:
        return;
    }
  }

  private dropLever(lever: UndockLever, out: PuzzleEffects): void {
    if (!lever.engaged && lever.holder === null) return;
    lever.engaged = false;
    lever.holder = null;
    lever.holdUntilMs = 0;
    touch(this.state, out);
  }

  tick(dt: number, ctx: PuzzleTickContext, out: PuzzleEffects): void {
    const s = this.state;
    if (s.solved) return;

    // Lapsed grips.
    for (const lever of s.levers) {
      if (lever.engaged && ctx.nowMs > lever.holdUntilMs) this.dropLever(lever, out);
    }

    const holders = new Set<PlayerId>();
    let engaged = 0;
    for (const lever of s.levers) {
      if (lever.engaged && lever.holder !== null) {
        engaged++;
        holders.add(lever.holder);
      }
    }
    if (engaged !== s.engagedCount) {
      s.engagedCount = engaged;
      touch(s, out);
    }

    const all = engaged === s.levers.length && holders.size === s.levers.length;
    if (!all) {
      if (s.progress !== 0) {
        s.progress = 0;
        this.noiseAccum = 0;
        touch(s, out);
      }
      return;
    }

    s.progress += dt;
    touch(s, out);

    // It keeps screaming for the whole five seconds. That is the point.
    this.noiseAccum += dt;
    if (this.noiseAccum >= CONTINUOUS_NOISE_INTERVAL_S) {
      this.noiseAccum -= CONTINUOUS_NOISE_INTERVAL_S;
      for (const lever of s.levers) {
        out.noise('undock-lever', lever.module, lever.pos, lever.holder ?? undefined);
      }
    }

    if (s.progress >= s.required) {
      s.progress = s.required;
      s.undocked = true;
      s.solved = true;
      for (const lever of s.levers) {
        lever.engaged = false;
        lever.holder = null;
        lever.holdUntilMs = 0;
      }
      out.solve();
      out.toast(null, 'UNDOCKED. Get to the capsule.');
    }
  }

  publicState(): unknown {
    return {
      ...this.state,
      levers: this.state.levers.map((l) => ({ ...l, pos: { ...l.pos } })),
    };
  }

  reset(): void {
    const s = this.state;
    for (const l of s.levers) {
      l.engaged = false;
      l.holder = null;
      l.holdUntilMs = 0;
    }
    s.progress = 0;
    s.engagedCount = 0;
    s.undocked = false;
    s.solved = false;
    s.armed = false;
    this.noiseAccum = 0;
    s.revision++;
  }
}
