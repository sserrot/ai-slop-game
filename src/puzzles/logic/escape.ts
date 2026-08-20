/**
 * The escape condition (DESIGN.md §11): "four systems online, then the undock
 * sequence, then the capsule."
 *
 * Five puzzles gate a system each and `SYSTEMS_TO_ESCAPE` is 4, so exactly one
 * may be skipped. That is not slack — it is what lets cargo stow be "the
 * designated cut" (§11/§13) without a cut round becoming unwinnable, and it lets
 * a crew that has lost the module with the coolant gauge still get home.
 *
 *   systems ──(4 online)──▶ armed ──(3 levers, 5 s)──▶ capsule ──(launch)──▶ away
 *
 * BRINGING A SYSTEM ONLINE MUST NOTIFY THE ESCALATION DIRECTOR. §5: the stage
 * advances per system brought online — "diegetic, and it rewards progress with
 * pressure". `DirectorHook` below is the whole of that interface; the round host
 * wires it to the director's own `notifySystemsOnline`.
 */

import type { EscapeSystemId, ModuleId, PlayerId } from '@shared/types';
import { SYSTEMS_TO_ESCAPE, WIN_MIN_SURVIVORS } from '@shared/constants';
import { SYSTEM_LABELS } from './types';

/**
 * THE INTERFACE THE ALIEN/DIRECTOR AGENT MUST SATISFY.
 *
 * Called exactly once per system, on the tick it comes online, before any
 * puzzle broadcast — so the stage bump and the panel lighting up land together.
 */
export interface DirectorHook {
  /**
   * @param systemsOnline how many are online INCLUDING this one (0–5)
   * @param system        the system that just came up
   */
  systemOnline(systemsOnline: number, system: EscapeSystemId): void;
}

export type EscapePhase =
  /** Fewer than SYSTEMS_TO_ESCAPE systems online. */
  | 'systems'
  /** Four systems online; the undock levers will now move. */
  | 'armed'
  /** Levers held; the countdown is running. Cosmetic — the puzzle owns it. */
  | 'undocking'
  /** Undocked. The capsule is live; board it. */
  | 'capsule'
  /** The capsule has left. Round over. */
  | 'away';

export interface EscapeSnapshot {
  phase: EscapePhase;
  systemsOnline: EscapeSystemId[];
  systemsRequired: number;
  undocked: boolean;
  boarded: PlayerId[];
  escapeModule: ModuleId | null;
  launchedAtMs: number | null;
  /** Escaping with three of six is a win (§10). */
  winThreshold: number;
}

export interface EscapeOptions {
  escapeModule?: ModuleId;
  required?: number;
  director?: DirectorHook;
  onPhase?: (phase: EscapePhase, previous: EscapePhase) => void;
  onSystem?: (system: EscapeSystemId, count: number) => void;
}

export class EscapeMachine {
  private readonly online = new Set<EscapeSystemId>();
  private readonly boardedSet = new Set<PlayerId>();
  private phaseValue: EscapePhase = 'systems';
  private undockedFlag = false;
  private launchedAt: number | null = null;

  readonly required: number;
  readonly escapeModule: ModuleId | null;
  private readonly director: DirectorHook | undefined;
  private readonly onPhase: EscapeOptions['onPhase'];
  private readonly onSystem: EscapeOptions['onSystem'];

  constructor(opts: EscapeOptions = {}) {
    this.required = opts.required ?? SYSTEMS_TO_ESCAPE;
    this.escapeModule = opts.escapeModule ?? null;
    this.director = opts.director;
    this.onPhase = opts.onPhase;
    this.onSystem = opts.onSystem;
  }

  get phase(): EscapePhase {
    return this.phaseValue;
  }
  get systemsOnline(): number {
    return this.online.size;
  }
  get systems(): EscapeSystemId[] {
    return [...this.online];
  }
  get undocked(): boolean {
    return this.undockedFlag;
  }
  get boarded(): PlayerId[] {
    return [...this.boardedSet];
  }
  /** True once the levers are live — the undock puzzle reads this to arm itself. */
  get armed(): boolean {
    return this.online.size >= this.required;
  }
  has(system: EscapeSystemId): boolean {
    return this.online.has(system);
  }

  /**
   * A puzzle solved. Returns true if this was a new system — i.e. if the
   * director was notified and the stage should advance.
   */
  bringOnline(system: EscapeSystemId): boolean {
    if (!system || this.online.has(system)) return false;
    this.online.add(system);
    const count = this.online.size;
    // §5: the director escalates per system. Notify BEFORE the phase change so
    // the stage is already current when the crew hears the levers arm.
    this.director?.systemOnline(count, system);
    this.onSystem?.(system, count);
    if (this.armed && this.phaseValue === 'systems') this.setPhase('armed');
    return true;
  }

  /** The undock puzzle reports its countdown started/stopped (cosmetic phase). */
  setUndocking(running: boolean): void {
    if (running && this.phaseValue === 'armed') this.setPhase('undocking');
    else if (!running && this.phaseValue === 'undocking') this.setPhase('armed');
  }

  /** The undock sequence completed. The capsule is live. */
  markUndocked(): void {
    if (this.undockedFlag) return;
    this.undockedFlag = true;
    this.setPhase('capsule');
  }

  /** A player climbed into the capsule. `module` is where they actually are. */
  board(playerId: PlayerId, module: ModuleId | null): boolean {
    if (!this.undockedFlag) return false;
    if (this.escapeModule && module !== null && module !== this.escapeModule) return false;
    if (this.boardedSet.has(playerId)) return false;
    this.boardedSet.add(playerId);
    return true;
  }

  /** They climbed back out, or died in the doorway. */
  unboard(playerId: PlayerId): boolean {
    return this.boardedSet.delete(playerId);
  }

  /**
   * Pull the release. Returns the escapee list, or null if the capsule cannot
   * go yet. Anyone can launch — waiting for the last person is the crew's call
   * to make, and making it is the best moment in the round.
   */
  launch(nowMs: number): PlayerId[] | null {
    if (!this.undockedFlag || this.boardedSet.size === 0) return null;
    if (this.launchedAt !== null) return null;
    this.launchedAt = nowMs;
    this.setPhase('away');
    return [...this.boardedSet];
  }

  get launched(): boolean {
    return this.launchedAt !== null;
  }

  /** §10 — escaping with three of six is a win. */
  isWin(escapedCount: number = this.boardedSet.size): boolean {
    return escapedCount >= WIN_MIN_SURVIVORS;
  }

  /** Progress line for the panels: 'MAIN BUS · COOLANT LOOP · —'. */
  statusLine(): string {
    const labels = [...this.online].map((s) => SYSTEM_LABELS[s] ?? s.toUpperCase());
    while (labels.length < this.required) labels.push('—');
    return labels.join(' · ');
  }

  snapshot(): EscapeSnapshot {
    return {
      phase: this.phaseValue,
      systemsOnline: [...this.online],
      systemsRequired: this.required,
      undocked: this.undockedFlag,
      boarded: [...this.boardedSet],
      escapeModule: this.escapeModule,
      launchedAtMs: this.launchedAt,
      winThreshold: WIN_MIN_SURVIVORS,
    };
  }

  reset(): void {
    this.online.clear();
    this.boardedSet.clear();
    this.undockedFlag = false;
    this.launchedAt = null;
    this.phaseValue = 'systems';
  }

  private setPhase(next: EscapePhase): void {
    if (next === this.phaseValue) return;
    const previous = this.phaseValue;
    this.phaseValue = next;
    this.onPhase?.(next, previous);
  }
}
