/**
 * server/sim/puzzles.ts — the authoritative puzzle host (DESIGN.md §11).
 *
 * Implements the `PuzzleSim` contract in `./contracts.ts`, so `StationRoom`
 * drives it exactly as it drives `FallbackPuzzles`: `interact()` on a client
 * message, `update(dt)` every tick, `puzzles` for the state mirror.
 *
 * WHAT LIVES WHERE
 *   - The six puzzle state machines and the escape condition live in
 *     `src/puzzles/logic/`, which imports nothing but `@shared/*` and is
 *     deliberately renderer-free so this file can run it under Node.
 *   - This file is the HOST: it places the hardware from the authored layout,
 *     routes `interact` messages, turns puzzle noise requests into §3 noise
 *     events through `ctx.emitNoise`, and owns the escape state machine.
 *
 * WHY THE CROSS-DIRECTORY IMPORT
 *   The alternative was two copies of six state machines, one per side of the
 *   wire, and a §11 doc that quietly stops describing either of them. Puzzle
 *   state is server-authoritative (§7) but the CLIENT still needs the state
 *   types and the same field names to draw its panels (§6), and `shared/` was
 *   not mine to extend. One import line beats a duplicated simulation.
 */

import type {
  EscapeSystemId,
  InteractMessage,
  ModuleId,
  PlayerId,
  PropRef,
  Puzzle,
  PuzzleId,
  PuzzleSnapshot,
  StationLayout,
  StationModule,
  Vec3,
} from '@shared/types';
import { SYSTEMS_TO_ESCAPE } from '@shared/constants';
import { localToWorld } from '@shared/graph/math';
import {
  BreakerSequencePuzzle,
  CoolantValvePuzzle,
  EscapeMachine,
  FuseHuntPuzzle,
  LockerPool,
  PuzzleRegistry,
  UndockSequencePuzzle,
  collectLockers,
  keyswitchSide,
  makeRng,
  PUZZLE_PROP_KINDS,
  parsePuzzleTarget,
  puzzlePropRole,
  undockLeverId,
  type EscapePhase,
  type LockerRef,
  type PuzzleCommand,
  type PuzzleOutcome,
  type PuzzlePlacement,
  type PuzzleRuntime,
} from '../../src/puzzles/logic/index';
import type { PuzzleInteractResult, PuzzleSim, SimContext } from './contracts';

/**
 * ms between re-broadcasts of a puzzle whose state is only drifting (a turning
 * valve, a running hold). Matches the panels' own 10 Hz redraw (§6).
 */
const PUZZLE_BROADCAST_MS = 100;

// ---------------------------------------------------------------------------
// Layout → placement
// ---------------------------------------------------------------------------

/**
 * Prop archetypes the station layout authors, and what they drive.
 *
 * Re-exported from `src/puzzles/logic/props.ts`, which also knows how to read
 * the role out of an authored prop id — `levels/station.json` tags every panel
 * `panel` (the archetype the renderer needs) and encodes the role in the id.
 * Match through `puzzlePropRole()`, never on `prop.kind` alone.
 */
export { PUZZLE_PROP_KINDS };

interface PropHit {
  module: ModuleId;
  prop: PropRef;
  pos: Vec3;
}

function findProps(layout: StationLayout, role: string): PropHit[] {
  const out: PropHit[] = [];
  for (const module of layout.modules) {
    for (const prop of module.props) {
      if (puzzlePropRole(prop) !== role) continue;
      out.push({ module: module.id, prop, pos: localToWorld(prop.localPos, module.transform) });
    }
  }
  return out;
}

function moduleCentre(module: StationModule): Vec3 {
  return { ...module.transform.pos };
}

/** A probability, however badly a caller (or a config file) spelled it. */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Fraction of the hidden lockers (the breaker card, the three spare fuses) that
 * come out JAMMED — pry them (60, 3 s) or hand-pump them (6, 25 s).
 *
 * This is §11's own worked example of the hard design rule — "every puzzle has
 * a loud-fast path and a quiet-slow path" — and at 0 it was not in the game at
 * all. Four hidden lockers at 0.35 each means ~82 % of rounds contain at least
 * one jam and ~1.4 on average: the choice shows up most rounds without turning
 * every supply run into a 25-second hold.
 *
 * Even a fully-jammed round stays winnable without ever prying: the breaker
 * panel keeps its 20 s manual override (§11·1), and `SYSTEMS_TO_ESCAPE` is 4 of
 * 5 gating puzzles, so the fuse hunt is the one that may be skipped.
 */
export const DEFAULT_JAMMED_LOCKER_CHANCE = 0.35;

export interface PuzzleSimOptions {
  /**
   * Fraction of the lockers holding a card or a fuse that come out JAMMED —
   * pry them (60, 3 s) or hand-pump them (6, 25 s), §11's own example of the
   * loud-fast / quiet-slow rule.
   *
   * Defaults to `DEFAULT_JAMMED_LOCKER_CHANCE`. Set it to 0 to take the
   * mechanic out (a client that cannot send `pry` / `pump` — see
   * `PUZZLE_ACTIONS` in `src/puzzles/interactor.ts` — can still only loot a
   * jam through the breaker override).
   */
  jammedLockerChance?: number;
  /** Systems needed before the undock levers arm. Defaults to §14's 4. */
  systemsToEscape?: number;
  /** Called the moment the undock sequence completes — the room should tell the
   *  director (`director.undockLive()`, §5 stage 4 "undock live"). */
  onUndocked?: () => void;
  /** Escape phase transitions, for round bookkeeping and toasts. */
  onEscapePhase?: (phase: EscapePhase, previous: EscapePhase) => void;
}

/**
 * Build the placement list from the authored layout (§2 "authoring is then a
 * JSON file"). Every puzzle falls back to a sensible module if its props are
 * missing, so a half-authored station still produces a playable round.
 */
export function planPlacements(
  layout: StationLayout,
  rng: () => number,
  opts: { jammedLockerChance?: number } = {},
): PuzzlePlacement[] {
  const modules = layout.modules;
  const byId = new Map<ModuleId, StationModule>(modules.map((m) => [m.id, m]));
  const used = new Set<ModuleId>();

  const fallbackModule = (): ModuleId => {
    for (const m of modules) {
      if (used.has(m.id)) continue;
      if (m.id === layout.escapeModule || m.id === layout.finaleModule) continue;
      return m.id;
    }
    return modules[0]?.id ?? 'm0';
  };

  const anchorFor = (hit: PropHit | undefined, fallback: ModuleId): { module: ModuleId; pos: Vec3 } => {
    if (hit) return { module: hit.module, pos: hit.pos };
    const m = byId.get(fallback);
    return { module: fallback, pos: m ? moduleCentre(m) : { x: 0, y: 0, z: 0 } };
  };

  const breakerHit = findProps(layout, PUZZLE_PROP_KINDS.BREAKER)[0];
  const gaugeHit = findProps(layout, PUZZLE_PROP_KINDS.GAUGE)[0];
  const valveHit = findProps(layout, PUZZLE_PROP_KINDS.VALVE)[0];
  const rackHit = findProps(layout, PUZZLE_PROP_KINDS.CARGO_RACK)[0];
  const fuseHit = findProps(layout, PUZZLE_PROP_KINDS.FUSEBOX)[0];
  const keyHits = findProps(layout, PUZZLE_PROP_KINDS.KEYSWITCH);
  const undockHits = findProps(layout, PUZZLE_PROP_KINDS.UNDOCK);

  // --- breaker sequence ------------------------------------------------------
  const breaker = anchorFor(breakerHit, fallbackModule());
  used.add(breaker.module);

  // --- coolant valve: a gauge here, a wheel THERE (§11 puzzle 2) --------------
  const gauge = anchorFor(gaugeHit, fallbackModule());
  used.add(gauge.module);
  const valve = anchorFor(valveHit, fallbackModule());
  used.add(valve.module);

  // --- cargo stow ------------------------------------------------------------
  const rack = anchorFor(rackHit, fallbackModule());
  used.add(rack.module);

  // --- fuse hunt -------------------------------------------------------------
  const fusebox = anchorFor(fuseHit, fallbackModule());
  used.add(fusebox.module);

  // --- airlock keyswitch: two switches four metres apart ----------------------
  const keyA = keyHits[0];
  const keyB = keyHits[1];
  const keyModule = keyA ? keyA.module : layout.escapeModule || fallbackModule();
  const keyModuleObj = byId.get(keyModule);
  const keyCentre = keyModuleObj ? moduleCentre(keyModuleObj) : { x: 0, y: 0, z: 0 };
  used.add(keyModule);

  // --- undock: three levers, three modules, the finale first ------------------
  const leverHits = undockHits.slice();
  leverHits.sort((a, b) => {
    const af = a.module === layout.finaleModule ? 0 : 1;
    const bf = b.module === layout.finaleModule ? 0 : 1;
    return af - bf;
  });
  const leverAnchors: Record<string, Vec3> = {};
  const leverModules: ModuleId[] = [];
  for (let i = 0; i < 3; i++) {
    const hit = leverHits[i];
    const module = hit ? hit.module : i === 0 ? layout.finaleModule || fallbackModule() : fallbackModule();
    const m = byId.get(module);
    leverAnchors[undockLeverId(i)] = hit ? hit.pos : m ? moduleCentre(m) : { x: 0, y: 0, z: 0 };
    leverModules.push(module);
    used.add(module);
  }

  // --- lockers: one card, three fuses, all in ANOTHER module ------------------
  const pool = new LockerPool(collectLockers(modules), rng);
  const jammedChance = clamp01(opts.jammedLockerChance ?? DEFAULT_JAMMED_LOCKER_CHANCE);
  const cardLocker = pool.take(1, {
    excludeModules: [breaker.module],
    jammedChance,
  });
  const fuseLockers = pool.take(3, {
    excludeModules: [fusebox.module],
    jammedChance,
  });

  return [
    {
      id: 'breaker-sequence',
      module: breaker.module,
      anchors: { panel: breaker.pos, lever: breaker.pos, card: cardLocker[0]?.pos ?? breaker.pos },
      lockers: cardLocker,
    },
    {
      id: 'coolant-valve',
      module: gauge.module,
      partnerModules: [valve.module],
      anchors: { panel: gauge.pos, gauge: gauge.pos, wheel: valve.pos },
    },
    {
      id: 'cargo-stow',
      module: rack.module,
      anchors: { panel: rack.pos, rack: rack.pos },
    },
    {
      id: 'fuse-hunt',
      module: fusebox.module,
      anchors: { panel: fusebox.pos },
      lockers: fuseLockers,
    },
    {
      id: 'airlock-keyswitch',
      module: keyModule,
      anchors: {
        panel: keyA ? keyA.pos : keyCentre,
        'key-a': keyA ? keyA.pos : keyCentre,
        'key-b': keyB ? keyB.pos : keyCentre,
      },
    },
    {
      id: 'undock-sequence',
      module: leverModules[0],
      partnerModules: [leverModules[1], leverModules[2]],
      anchors: { panel: leverAnchors[undockLeverId(0)], ...leverAnchors },
    },
  ];
}

// ---------------------------------------------------------------------------
// The sim
// ---------------------------------------------------------------------------

/** Where an `interact` aimed at a prop should land. */
interface PropTarget {
  id: PuzzleId;
  element: string | null;
}

export class StationPuzzles implements PuzzleSim {
  private readonly layout: StationLayout;
  private readonly rngSeed: () => number;
  private readonly options: PuzzleSimOptions;

  private registry: PuzzleRegistry;
  private escapeMachine: EscapeMachine;
  private placements: PuzzlePlacement[];
  /** `${module}:${propId}` → puzzle element, so looking at a panel is enough. */
  private readonly propTargets = new Map<string, PropTarget>();
  /** Last tick each puzzle's drifting state was pushed to clients. */
  private readonly lastBroadcast = new Map<PuzzleId, number>();

  constructor(
    layout: StationLayout,
    rng: () => number = Math.random,
    options: PuzzleSimOptions = {},
  ) {
    this.layout = layout;
    this.rngSeed = rng;
    this.options = options;
    this.placements = [];
    this.registry = new PuzzleRegistry([], rng);
    this.escapeMachine = new EscapeMachine();
    this.build();
  }

  // -- PuzzleSim ------------------------------------------------------------

  get puzzles(): readonly Puzzle[] {
    return this.registry.puzzles();
  }

  get(id: PuzzleId): Puzzle | undefined {
    const p = this.registry.get(id);
    if (!p) return undefined;
    return {
      id: p.id,
      module: p.state.module,
      state: p.publicState(),
      solved: p.solved,
      gates: p.gates.slice(),
    };
  }

  /**
   * Which module an `interact.targetId` physically lives in, or null when the
   * room must not judge (see below). The room refuses anything aimed at a
   * panel the player is not standing at — §6's entire case for in-world panels
   * is that you must "physically be at the panel, one hand on a rail, back
   * exposed, which is the entire reason puzzles exist".
   *
   * PRECISION IS THE POINT. Answering "the puzzle's primary module" for every
   * target would be worse than answering nothing: four of the six puzzles have
   * hardware in more than one module (§11), so a coolant wheel turned from the
   * valve module, a fuse taken from its locker or a lever held in the third
   * module would all be refused with "not at that panel" while the player is
   * standing exactly where the doc says they should be. So:
   *
   *   - a prop key (`${module}:${propId}`) names ONE object → its module;
   *   - a single-module puzzle → that module, whatever the element;
   *   - a multi-module puzzle → the element decides, and when the element does
   *     not pin it down (bare `fuse-hunt`, bare `undock-sequence`) this returns
   *     null and the puzzle's own `cmd.module` check does the refusing.
   */
  moduleFor(targetId: string): ModuleId | null {
    if (!targetId) return null;

    // The raycaster hits props, so this is the path most messages take, and it
    // is exact: the key is the module the prop was authored into.
    if (this.propTargets.has(targetId)) {
      const cut = targetId.indexOf(':');
      const module = cut > 0 ? targetId.slice(0, cut) : '';
      return this.hasModule(module) ? module : null;
    }

    const parsed = parsePuzzleTarget(targetId);
    if (!parsed) return null;
    const runtime = this.registry.get(parsed.id);
    if (!runtime) return null;

    // Puzzles that live in exactly one room need no element analysis at all.
    const spans = runtime.modules();
    if (spans.length === 1) return spans[0] ?? null;

    return this.elementModule(runtime, parsed.element);
  }

  /**
   * Where one element of a multi-module puzzle physically is. Reads LIVE state,
   * not the placement: a fuse that has been carried out of its locker is where
   * its carrier left it, and refusing to install it at the socket panel because
   * the placement still says "locker module" would be the same bug in reverse.
   */
  private elementModule(runtime: PuzzleRuntime, element: string | null): ModuleId | null {
    if (runtime instanceof BreakerSequencePuzzle) {
      // The panel, the six breakers and the 20 s override are all at the panel;
      // the laminated card is "in a locker in another module" (§11).
      if (element === 'card') return runtime.state.card.module;
      if (element === null || element === 'panel' || element === 'lever') {
        return runtime.state.module;
      }
      return null;
    }

    if (runtime instanceof CoolantValvePuzzle) {
      // §11's thesis puzzle: "Module A has a pressure gauge and no valve.
      // Module B has the valve wheel and no gauge."
      if (element === 'wheel' || element === 'valve') return runtime.state.valveModule;
      if (element === 'gauge' || element === 'panel') return runtime.state.gaugeModule;
      return null;
    }

    if (runtime instanceof FuseHuntPuzzle) {
      const fuse = element ? runtime.state.fuses.find((f) => f.id === element) : undefined;
      if (fuse) return fuse.carriedBy ? null : fuse.module;
      if (element === 'panel' || element?.startsWith('socket')) return runtime.state.module;
      // Bare 'fuse-hunt' covers take / drop / install, which happen in three
      // different places; the puzzle already refuses each one properly.
      return null;
    }

    if (runtime instanceof UndockSequencePuzzle) {
      const lever = element ? runtime.state.levers.find((l) => l.id === element) : undefined;
      return lever ? lever.module : null;
    }

    return null;
  }

  /**
   * True while this locker prop is jammed shut (§11's pry-or-pump pair).
   *
   * The room's `ItemRegistry` hands out medkits, decoys and the pry bar from the
   * same `locker` props these puzzles hide the card and the fuses in, so a
   * jammed door that still surrendered a medkit would read as a bug. One door,
   * one state.
   */
  lockerJammed(targetId: string): boolean {
    const target = this.propTargets.get(targetId);
    if (!target) return false;
    const runtime = this.registry.get(target.id);
    if (!runtime) return false;

    if (runtime instanceof BreakerSequencePuzzle && target.element === 'card') {
      return runtime.state.card.jam?.jammed === true;
    }
    if (runtime instanceof FuseHuntPuzzle && target.element) {
      const fuse = runtime.state.fuses.find((f) => f.id === target.element);
      return fuse ? fuse.jam.jammed : false;
    }
    return false;
  }

  private hasModule(id: ModuleId): boolean {
    return this.layout.modules.some((m) => m.id === id);
  }

  /** Client `interact` → puzzle. Returns null when it was not for a puzzle. */
  interact(playerId: PlayerId, msg: InteractMessage, ctx: SimContext): PuzzleInteractResult | null {
    const target = this.resolveTarget(msg.targetId);

    // The capsule is not a puzzle, but it is the last step of §11's escape
    // condition, so it is handled here rather than scattered into the room.
    if (!target) return this.escapeInteract(playerId, msg, ctx);

    const player = ctx.players.find((p) => p.id === playerId);
    const cmd: PuzzleCommand = {
      playerId,
      action: msg.action,
      // `value` wins where a puzzle reads both — every puzzle checks it first.
      element: target.element,
      value: msg.value,
      module: player ? player.module : null,
      nowMs: ctx.now,
      tick: ctx.tick,
    };

    const outcome = this.registry.interact(target.id, cmd);
    if (!outcome) {
      const puzzle = this.get(target.id);
      if (!puzzle) return null;
      return { puzzle, changed: false, systemsUnlocked: [] };
    }
    return this.applyOutcome(outcome, ctx);
  }

  /** Fixed step. Drives every timed hold in §11. */
  update(dt: number, ctx: SimContext): PuzzleInteractResult[] {
    // Arm the finale the moment the fourth system lands (§11).
    const undock = this.registry.undock();
    if (undock && undock.state.armed !== this.escapeMachine.armed) {
      undock.arm(this.escapeMachine.armed);
      if (this.escapeMachine.armed) {
        for (const p of ctx.players) {
          if (p.alive) ctx.toast(p.id, 'Undock levers armed. Three of you, five seconds.');
        }
      }
    }

    // Cosmetic phase: the countdown is running somewhere in the station.
    if (undock && !undock.state.undocked) {
      this.escapeMachine.setUndocking(undock.state.progress > 0);
    }

    const outcomes = this.registry.tick(dt, { nowMs: ctx.now, tick: ctx.tick, rng: ctx.rng });
    if (outcomes.length === 0) return [];
    const results: PuzzleInteractResult[] = [];
    for (const outcome of outcomes) {
      // A turning valve or a running hold changes state every single tick, and
      // re-broadcasting six puzzles at 20 Hz to six players buys nothing: the
      // panels redraw at PANEL_UPDATE_HZ (§6). Anything with a consequence —
      // a noise, a toast, a solve — always goes out immediately.
      const quiet =
        outcome.changed &&
        !outcome.solvedNow &&
        outcome.noises.length === 0 &&
        outcome.toasts.length === 0;
      if (quiet) {
        const last = this.lastBroadcast.get(outcome.id) ?? -Infinity;
        if (ctx.now - last < PUZZLE_BROADCAST_MS) continue;
      }
      this.lastBroadcast.set(outcome.id, ctx.now);
      results.push(this.applyOutcome(outcome, ctx));
    }
    return results;
  }

  reset(): void {
    this.lastBroadcast.clear();
    this.build();
  }

  // -- extras the room may want ---------------------------------------------

  /** The escape state machine: systems → undock → capsule (§11). */
  get escape(): EscapeMachine {
    return this.escapeMachine;
  }

  /** §7 `puzzles: { id, state, solved }[]`. */
  snapshots(): PuzzleSnapshot[] {
    return this.registry.snapshots();
  }

  /** Systems online so far. Mirrors the director's own count. */
  get systemsOnline(): number {
    return this.escapeMachine.systemsOnline;
  }

  /** Everything the escape needs, for the room's state mirror. */
  escapeSnapshot() {
    return this.escapeMachine.snapshot();
  }

  /** Call when a player dies or disconnects, so the capsule manifest is honest. */
  playerRemoved(playerId: PlayerId): void {
    this.escapeMachine.unboard(playerId);
  }

  /** Where each puzzle ended up this round — handy for spawn and debug tooling. */
  get placement(): readonly PuzzlePlacement[] {
    return this.placements;
  }

  /** Lockers holding something, so decoy placement (§5) can avoid them. */
  occupiedLockers(): LockerRef[] {
    const out: LockerRef[] = [];
    for (const p of this.placements) if (p.lockers) out.push(...p.lockers);
    return out;
  }

  // -- internals ------------------------------------------------------------

  private build(): void {
    const rng = this.rngSeed;
    this.placements = planPlacements(this.layout, rng, {
      jammedLockerChance: this.options.jammedLockerChance,
    });
    this.registry = new PuzzleRegistry(this.placements, rng);
    this.escapeMachine = new EscapeMachine({
      escapeModule: this.layout.escapeModule,
      required: this.options.systemsToEscape ?? SYSTEMS_TO_ESCAPE,
      onPhase: this.options.onEscapePhase,
    });
    this.buildPropTargets();
  }

  /**
   * `${module}:${propId}` → puzzle element. The interaction raycaster (§4) hits
   * a prop, not an abstraction, so this is the path most messages take.
   */
  private buildPropTargets(): void {
    this.propTargets.clear();
    const K = PUZZLE_PROP_KINDS;
    const undock = this.registry.get('undock-sequence');
    const undockLevers =
      undock instanceof UndockSequencePuzzle ? undock.state.levers : [];

    for (const module of this.layout.modules) {
      for (const prop of module.props) {
        const key = `${module.id}:${prop.id}`;
        switch (puzzlePropRole(prop)) {
          case K.BREAKER:
            this.propTargets.set(key, { id: 'breaker-sequence', element: null });
            break;
          case K.GAUGE:
            this.propTargets.set(key, { id: 'coolant-valve', element: 'gauge' });
            break;
          case K.VALVE:
            this.propTargets.set(key, { id: 'coolant-valve', element: 'wheel' });
            break;
          case K.CARGO_RACK:
            this.propTargets.set(key, { id: 'cargo-stow', element: 'rack' });
            break;
          case K.FUSEBOX:
            this.propTargets.set(key, { id: 'fuse-hunt', element: 'panel' });
            break;
          case K.KEYSWITCH: {
            this.propTargets.set(key, {
              id: 'airlock-keyswitch',
              element: keyswitchSide(prop.id),
            });
            break;
          }
          case K.UNDOCK: {
            const lever = undockLevers.find((l) => l.module === module.id);
            this.propTargets.set(key, {
              id: 'undock-sequence',
              element: lever ? lever.id : undockLeverId(0),
            });
            break;
          }
          default:
            break;
        }
      }
    }

    // Lockers holding something route to whatever is inside them.
    for (const placement of this.placements) {
      if (!placement.lockers) continue;
      placement.lockers.forEach((locker, i) => {
        const key = `${locker.module}:${locker.propId}`;
        if (placement.id === 'breaker-sequence') {
          this.propTargets.set(key, { id: 'breaker-sequence', element: 'card' });
        } else if (placement.id === 'fuse-hunt') {
          this.propTargets.set(key, { id: 'fuse-hunt', element: `fuse-${i + 1}` });
        }
      });
    }
  }

  private resolveTarget(targetId: string): PropTarget | null {
    if (!targetId) return null;
    const prop = this.propTargets.get(targetId);
    if (prop) return prop;
    const parsed = parsePuzzleTarget(targetId);
    if (parsed) return { id: parsed.id, element: parsed.element };
    return null;
  }

  /**
   * Turn one puzzle outcome into the room's result shape: emit the §3 noise,
   * push the toasts, and bring gated systems online.
   */
  private applyOutcome(outcome: PuzzleOutcome, ctx: SimContext): PuzzleInteractResult {
    for (const n of outcome.noises) {
      // Loudness is re-derived from §14 inside `emitNoise` — a puzzle cannot
      // decide it was quiet, any more than a client can (§7).
      ctx.emitNoise(n.kind, n.pos, n.module, n.actor ? { actor: n.actor } : undefined);
    }
    for (const t of outcome.toasts) {
      if (t.to) ctx.toast(t.to, t.text);
      else for (const p of ctx.players) if (p.alive) ctx.toast(p.id, t.text);
    }

    const puzzle = this.get(outcome.id) ?? {
      id: outcome.id,
      module: this.layout.modules[0]?.id ?? '',
      state: null,
      solved: false,
      gates: [],
    };

    const systemsUnlocked: EscapeSystemId[] = [];
    if (outcome.solvedNow) {
      for (const system of puzzle.gates) {
        if (this.escapeMachine.bringOnline(system)) systemsUnlocked.push(system);
      }
      if (outcome.id === 'undock-sequence') {
        this.escapeMachine.markUndocked();
        this.options.onUndocked?.();
      }
    }

    const message = outcome.toasts.length > 0 ? outcome.toasts[0].text : undefined;
    return { puzzle, changed: outcome.changed, systemsUnlocked, message };
  }

  /** `escape:board` / `escape:launch` — the last step of §11's condition. */
  private escapeInteract(
    playerId: PlayerId,
    msg: InteractMessage,
    ctx: SimContext,
  ): PuzzleInteractResult | null {
    const head = msg.targetId.split(/[:/]/)[0];
    if (head !== 'escape' && head !== 'capsule') return null;

    const player = ctx.players.find((p) => p.id === playerId);
    const undockPuzzle = this.get('undock-sequence');
    if (!undockPuzzle) return null;

    switch (msg.action) {
      case 'board': {
        if (!this.escapeMachine.undocked) {
          ctx.toast(playerId, 'The capsule is still docked.');
          return { puzzle: undockPuzzle, changed: false, systemsUnlocked: [] };
        }
        const ok = this.escapeMachine.board(playerId, player ? player.module : null);
        ctx.toast(playerId, ok ? 'Aboard the capsule.' : 'You are not at the capsule.');
        return { puzzle: undockPuzzle, changed: ok, systemsUnlocked: [] };
      }
      case 'unboard': {
        const ok = this.escapeMachine.unboard(playerId);
        return { puzzle: undockPuzzle, changed: ok, systemsUnlocked: [] };
      }
      case 'launch': {
        const escaped = this.escapeMachine.launch(ctx.now);
        if (!escaped) {
          ctx.toast(playerId, 'Nobody is aboard.');
          return { puzzle: undockPuzzle, changed: false, systemsUnlocked: [] };
        }
        for (const p of ctx.players) if (p.alive) ctx.toast(p.id, 'Capsule away.');
        return {
          puzzle: undockPuzzle,
          changed: true,
          systemsUnlocked: [],
          message: `capsule away with ${escaped.length}`,
        };
      }
      default:
        return null;
    }
  }
}

/** Matches `FallbackPuzzles`' construction, so swapping it in is one line. */
export function createPuzzleSim(
  layout: StationLayout,
  seedOrRng: number | (() => number) = Math.random,
  options: PuzzleSimOptions = {},
): StationPuzzles {
  const rng = typeof seedOrRng === 'number' ? makeRng(seedOrRng) : seedOrRng;
  return new StationPuzzles(layout, rng, options);
}

export type { EscapePhase, PuzzlePlacement };
export { EscapeMachine };
