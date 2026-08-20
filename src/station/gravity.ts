/**
 * Per-module gravity at runtime (DESIGN.md §4 "Gravity failure — a set-piece,
 * never a surprise").
 *
 * `ModuleGraph` owns the STATE: it mutates `StationModule.gravity` in place, the
 * way `Port.hatch` already is, so every consumer that reads the layout live sees
 * the change with nothing to invalidate. This class is the station's side of it:
 * it drives the graph's timers, keeps the render in step, and turns each landed
 * change into the one thing §4 insists a failure must be — an event on the map.
 *
 * Three things happen when a module loses its floor, in this order:
 *
 *   1. `GRAVITY_WARNING_S` (2.5 s) of announced warning. That is the fairness
 *      guarantee, and it is why nothing here calls `setGravity` on the player's
 *      behalf: `schedule()` is the door everything a player is meant to survive
 *      goes through, and `set()` exists for level load and puzzle scripting.
 *   2. A `gravity-shift` noise at `LOUDNESS.GRAVITY_SHIFT` (35, ~2 modules)
 *      emitted at the MODULE CENTRE. Not at any player: nobody caused it, so
 *      nobody is blamed for it — but the alien hears it and moves, so a failure
 *      is weather that walks toward you.
 *   3. The deck edge in that module goes from running-light green to unpowered
 *      amber. That is a material write on a per-module material, nothing more:
 *      the DECK ITSELF NEVER MOVES. A gravity failure is a plant winding down,
 *      not a floor evaporating, so no geometry is rebuilt and a module whose
 *      gravity is later restored has its floor exactly where it left it.
 *
 * The noise is *reported*, not emitted: this file has no access to the §3 bus,
 * and the server is authoritative for noise (§7). `onShift` hands the caller a
 * ready-made `NoiseEvent` origin and the shared loudness so `main.ts` can wire
 * it to whichever emitter is in scope.
 */

import { GRAVITY_WARNING_S, LOUDNESS } from '@shared/constants';
import type {
  GravityCause,
  GravityMode,
  GravityShiftEvent,
  ModuleGravitySnapshot,
  ModuleId,
  Vec3,
} from '@shared/types';
import type { ModuleGraph } from '@shared/graph/moduleGraph';
import type { ModuleView } from './loader';
import type { StationMaterials } from './materials';

/** What a landed gravity change looks like to the rest of the game. */
export interface GravityShift {
  module: ModuleId;
  from: GravityMode;
  to: GravityMode;
  cause: GravityCause;
  /** Module centre, world space — where the `gravity-shift` noise comes from. */
  origin: Vec3;
  /** `LOUDNESS.GRAVITY_SHIFT` (35). 0 for the initial sync at load. */
  loudness: number;
  /** Server tick the graph stamped the change with (§7). */
  t: number;
}

export class StationGravity {
  /** Fires once per landed change. Wire to `bus.emit('gravity:changed', …)`. */
  onShift: ((shift: GravityShift) => void) | null = null;
  /** Fires when a change is ANNOUNCED — 2.5 s before it lands (§4). */
  onWarning: ((event: GravityShiftEvent) => void) | null = null;

  /**
   * Somebody else owns the countdown; `tick()` must not advance it.
   *
   * Set this whenever a SERVER is authoritative for gravity (§7), which on this
   * client means "whenever we are connected". Running the announced timer on
   * both sides looks like a latency win and is a race: the local countdown lands
   * a frame or two before the server's snapshot catches up, the next snapshot
   * still says `nominal` with a pending change, and the module is put back —
   * MEASURED as a `liftoff` → `settle` → `liftoff` flap on a single director
   * failure, with the 35-loudness bang and the deck-edge repaint fired three
   * times. One clock. The server's, when there is one; ours when there is not,
   * which is what keeps the offline sandbox and `scheduleGravity()` working.
   */
  externalTimers = false;

  constructor(
    private readonly graph: ModuleGraph,
    private readonly views: ReadonlyMap<ModuleId, ModuleView>,
    private readonly materials: StationMaterials,
  ) {
    this.syncAll();
  }

  mode(id: ModuleId): GravityMode {
    return this.graph.gravityOf(id);
  }

  authored(id: ModuleId): GravityMode {
    return this.graph.authoredGravity(id);
  }

  hasFloor(id: ModuleId): boolean {
    return this.graph.hasFloor(id);
  }

  /** Modules currently without a floor. */
  zeroG(): ModuleId[] {
    return this.graph.modulesWithGravity('zero');
  }

  pending(id: ModuleId): { to: GravityMode; cause: GravityCause; ms: number } | null {
    return this.graph.pendingGravity(id);
  }

  /**
   * Announce a change `delayMs` ahead (default `GRAVITY_WARNING_S`).
   *
   * THE ROUTE FOR ANYTHING A PLAYER IS MEANT TO SURVIVE. Re-announcing does not
   * extend a running timer, so a director that keeps asking cannot keep a room
   * in limbo. Returns the event to broadcast, or null if there is nothing to do.
   */
  schedule(
    id: ModuleId,
    mode: GravityMode,
    cause: GravityCause,
    tick = 0,
    delayMs = GRAVITY_WARNING_S * 1000,
  ): GravityShiftEvent | null {
    // A re-announcement reports the RUNNING timer rather than restarting it, so
    // warning on it again would play the plant winding down twice.
    const alreadyPending = this.graph.pendingGravity(id) !== null;
    const event = this.graph.scheduleGravity(id, mode, cause, tick, delayMs);
    if (event) {
      if (event.inMs <= 0) this.land(id, event.from, event.to, cause, event.t);
      else if (!alreadyPending) this.onWarning?.(event);
    }
    return event;
  }

  /**
   * Set gravity immediately, cancelling any pending change.
   *
   * For level load, puzzle scripting and applying a server snapshot — NOT for
   * dropping the floor under somebody. §4: "Route gravity changes through the
   * announced path; the immediate setter exists for level load and puzzle
   * scripting, not for anything the player is meant to survive."
   */
  set(id: ModuleId, mode: GravityMode, cause: GravityCause = 'puzzle', tick = 0): boolean {
    const before = this.graph.gravityOf(id);
    if (!this.graph.setGravity(id, mode)) return false;
    if (before !== mode) this.land(id, before, mode, cause, tick);
    else this.sync(id);
    return true;
  }

  cancel(id: ModuleId): boolean {
    return this.graph.cancelPendingGravity(id);
  }

  /**
   * Advance announced changes. Call once a frame with `dt` in SECONDS.
   *
   * A no-op while `externalTimers` is set — see the field.
   */
  tick(dt: number, serverTick = 0): GravityShiftEvent[] {
    if (dt <= 0 || this.externalTimers) return [];
    const landed = this.graph.tickGravity(dt * 1000, serverTick);
    for (const event of landed) {
      this.land(event.module, event.from, event.to, event.cause, event.t);
    }
    return landed;
  }

  /** The §7 `gravity:` view of the station. */
  snapshot(): ModuleGravitySnapshot[] {
    return this.graph.gravitySnapshot();
  }

  /** Apply the server's `gravity:` array wholesale (join, or a resync). */
  applySnapshot(
    snapshots: readonly ModuleGravitySnapshot[],
    cause: GravityCause = 'director',
  ): ModuleId[] {
    const changed = this.graph.applyGravitySnapshot(snapshots, cause);
    for (const id of changed) this.sync(id);
    return changed;
  }

  /** Back to what the level authored — the end of a round, or a full repair. */
  reset(): ModuleId[] {
    const changed = this.graph.resetGravity();
    for (const id of changed) this.sync(id);
    return changed;
  }

  /** Push every module's current mode into its view. */
  syncAll(): void {
    for (const id of this.views.keys()) this.sync(id);
  }

  // -- internals ------------------------------------------------------------

  private land(
    id: ModuleId,
    from: GravityMode,
    to: GravityMode,
    cause: GravityCause,
    t: number,
  ): void {
    this.sync(id);
    const centre = this.graph.centre(id);
    if (!centre) return;
    this.onShift?.({
      module: id,
      from,
      to,
      cause,
      // §4: at the module centre, not at any player.
      origin: { x: centre.x, y: centre.y, z: centre.z },
      loudness: LOUDNESS.GRAVITY_SHIFT,
      t,
    });
  }

  private sync(id: ModuleId): void {
    const view = this.views.get(id);
    if (!view) return;
    const mode = this.graph.gravityOf(id);
    view.gravity = mode;
    if (view.edgeMaterial) this.materials.applyGravity(view.edgeMaterial, mode);
  }
}
