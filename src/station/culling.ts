/**
 * Two-hop portal culling (DESIGN.md §2).
 *
 * "Render the player's module plus everything **two hops** away through open
 * hatches. One hop was wrong: down a straight run of aligned 5m tubes you can
 * plainly see two modules ahead, and the second would pop into existence in
 * view. Two hops is still one trivial traversal; set the exponential fog so hop
 * three is invisible anyway."
 *
 * The set comes from `ModuleGraph.cullSet`, which walks OPEN hatches only — so
 * closing a door genuinely removes what is behind it from the frame, and the
 * culler has to be invalidated whenever a hatch moves. `Station.setHatch` does
 * that; if you mutate `Port.hatch` yourself, call `markDirty()`.
 */

import { CULL_HOPS } from '@shared/constants';
import type { ModuleId } from '@shared/types';
import type { ModuleGraph } from '@shared/graph/moduleGraph';

export class PortalCuller {
  private _visible = new Set<ModuleId>();
  private _list: ModuleId[] = [];
  private origin: ModuleId | null = null;
  private dirty = true;

  constructor(
    private readonly graph: ModuleGraph,
    readonly hops: number = CULL_HOPS,
  ) {}

  get visible(): ReadonlySet<ModuleId> {
    return this._visible;
  }

  get list(): readonly ModuleId[] {
    return this._list;
  }

  get playerModule(): ModuleId | null {
    return this.origin;
  }

  /** Force a recompute on the next `update` — call after any hatch change. */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Recompute the visible set for a player standing in `playerModule`.
   * Returns true when the set actually changed, so the caller only repacks
   * instance buffers on a real transition.
   *
   * `null` (module unknown — spawning, spectating, a free camera) shows
   * everything rather than nothing: an empty frame reads as a crash.
   */
  update(playerModule: ModuleId | null): boolean {
    if (!this.dirty && playerModule === this.origin) return false;
    this.origin = playerModule;
    this.dirty = false;

    const next =
      playerModule && this.graph.has(playerModule)
        ? this.graph.cullSet(playerModule, this.hops)
        : this.graph.ids();

    if (next.length === this._list.length && next.every((id) => this._visible.has(id))) {
      return false;
    }
    this._list = next;
    this._visible = new Set(next);
    return true;
  }
}
