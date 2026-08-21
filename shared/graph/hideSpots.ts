/**
 * Hide spots — lockers, equipment bays, crew bunks.
 *
 * DESIGN.md has no hiding mechanic. That is a real gap in a game that is
 * otherwise squarely in the genre, and the walking pivot is what makes it
 * buildable: a floor means these are things a body can climb INTO.
 *
 * THE ALIEN IS BLIND. There is no sight logic in this file, none in the type
 * (`HideSpot`), and none may be added anywhere. Hiding is exactly two things:
 *
 *   1. GEOMETRY. The alien will not physically sweep through your position:
 *      `sweepBlocked()` is what its in-module navigation and its contact test
 *      consult, and an occupied volume is not a place it goes.
 *   2. SILENCE. `muffleDb` takes the edge off everything you emit in there, and
 *      nothing more. Panicked breathing (§6, up to 14) still leaves the box and
 *      still clears `ATTN_SEARCH` at point-blank — `HIDE_SAFE_RADIUS_M` is how
 *      close it has to get, and `assertConstantsCoherent()` pins that distance
 *      to the muffle so neither can drift without the other.
 *
 * Getting in costs a noise on §11's loud-fast / quiet-slow rule: `HIDE_QUIET`
 * over `HIDE_ENTER_TIME_SLOW_S`, or `HIDE_LOUD` over `HIDE_ENTER_TIME_FAST_S`.
 * The careful entry does not fit inside the time a HUNT needs to cross a
 * module, which is asserted, and which is what makes hiding EARLY the skilled
 * play rather than a last-second escape hatch.
 */

import {
  HIDE_MUFFLE_DB,
  HIDE_SPOTS_MIN,
  HIDE_SPOT_CAPACITY_DEFAULT,
  muffledLoudness,
} from '@shared/constants';
import type {
  GravityMode,
  GravityScope,
  HideSpot,
  HideSpotId,
  HideSpotKey,
  ModuleId,
  Quat,
  Vec3,
} from '@shared/types';
import {
  cloneQuat,
  cloneV3,
  distance,
  localToWorld,
  localToWorldInto,
  multiplyQuat,
  normalize,
  sub,
  v3,
  worldToLocalInto,
} from '@shared/graph/math';
import { scopeAdmits } from '@shared/graph/gravity';
import type { ModuleGraph } from '@shared/graph/moduleGraph';

/** `${moduleId}:${spotId}` — station-wide unique hide spot id. Same shape as
 *  `railKey` and `portKey`, so the three are interchangeable on the wire. */
export function hideSpotKey(moduleId: ModuleId, spotId: HideSpotId): HideSpotKey {
  return `${moduleId}:${spotId}`;
}

export function parseHideSpotKey(key: HideSpotKey): { module: ModuleId; spot: HideSpotId } {
  const i = key.indexOf(':');
  if (i < 0) throw new Error(`parseHideSpotKey: malformed key '${key}'`);
  return { module: key.slice(0, i), spot: key.slice(i + 1) };
}

/** An authored `HideSpot` resolved into world space. */
export interface HideVolume {
  key: HideSpotKey;
  module: ModuleId;
  spot: HideSpot;
  /** Centre of the occupied box, world space. */
  centre: Vec3;
  /** Orientation of the box, world space (module quat ∘ the spot's own). */
  quat: Quat;
  /** Half-extents along the box's OWN axes, metres. */
  halfExtents: Vec3;
  /** Where you stand or float to get in, world space. */
  entry: Vec3;
  /** Direction the camera faces while inside, world space, unit length. */
  lookDir: Vec3;
  /** Bounding-sphere radius about `centre`, for broad-phase rejection. */
  radius: number;
  capacity: number;
  /** NEGATIVE dB the shell takes off the occupant's own noise. */
  muffleDb: number;
  usableIn: GravityScope;
}

/** Result of a sweep test: which volume was hit, and how far along the sweep. */
export interface HideSweepHit {
  volume: HideVolume;
  /** Parameter along the swept segment, 0 at the start, 1 at the end. */
  t: number;
}

const NO_VOLUMES: readonly HideVolume[] = Object.freeze([]);

export class HideSpotGraph {
  private readonly _byKey = new Map<HideSpotKey, HideVolume>();
  private readonly _byModule = new Map<ModuleId, HideVolume[]>();
  private readonly _all: HideVolume[] = [];
  /** Per-instance scratch for the local-space transforms. Never escapes a
   *  method, so one graph per room stays re-entrant. */
  private readonly _localA: Vec3 = v3();
  private readonly _localB: Vec3 = v3();

  constructor(private readonly graph: ModuleGraph) {
    this.rebuild();
  }

  /** Rebuild every volume from the module graph. Call if the layout changes. */
  rebuild(): void {
    this._byKey.clear();
    this._byModule.clear();
    this._all.length = 0;

    for (const module of this.graph.all()) {
      const list: HideVolume[] = [];
      for (const spot of module.hideSpots ?? []) {
        const key = hideSpotKey(module.id, spot.id);
        if (this._byKey.has(key)) {
          throw new Error(`HideSpotGraph: duplicate hide spot '${key}'`);
        }
        const centre = localToWorld(spot.localPos, module.transform);
        const entry = localToWorld(spot.entryPos, module.transform);
        const quat = spot.localQuat
          ? multiplyQuat(module.transform.quat, spot.localQuat)
          : cloneQuat(module.transform.quat);
        // Face the way the author said, or back out the way you came in.
        const look = spot.lookDir
          ? localToWorld(spot.lookDir, { pos: { x: 0, y: 0, z: 0 }, quat: module.transform.quat })
          : sub(entry, centre);
        const half = {
          x: Math.abs(spot.halfExtents.x),
          y: Math.abs(spot.halfExtents.y),
          z: Math.abs(spot.halfExtents.z),
        };
        const volume: HideVolume = {
          key,
          module: module.id,
          spot,
          centre,
          quat,
          halfExtents: half,
          entry,
          lookDir: normalize(look),
          radius: Math.sqrt(half.x * half.x + half.y * half.y + half.z * half.z),
          capacity: Math.max(1, Math.floor(spot.capacity ?? HIDE_SPOT_CAPACITY_DEFAULT)),
          // Clamp to ≤ 0: a "muffle" that amplified would be a very funny bug
          // to find at three in the morning.
          muffleDb: Math.min(0, spot.muffleDb ?? HIDE_MUFFLE_DB),
          usableIn: spot.usableIn ?? 'any',
        };
        this._byKey.set(key, volume);
        list.push(volume);
        this._all.push(volume);
      }
      this._byModule.set(module.id, list);
    }
  }

  // -- lookups --------------------------------------------------------------

  get size(): number {
    return this._byKey.size;
  }

  keys(): HideSpotKey[] {
    return [...this._byKey.keys()];
  }

  volumes(): readonly HideVolume[] {
    return this._all;
  }

  volume(key: HideSpotKey): HideVolume | undefined {
    return this._byKey.get(key);
  }

  /** Throws if the spot is missing — use where absence is a bug, not a case. */
  require(key: HideSpotKey): HideVolume {
    const v = this._byKey.get(key);
    if (!v) throw new Error(`HideSpotGraph: unknown hide spot '${key}'`);
    return v;
  }

  inModule(moduleId: ModuleId): readonly HideVolume[] {
    return this._byModule.get(moduleId) ?? NO_VOLUMES;
  }

  /** Modules with at least one hide spot. */
  modules(): ModuleId[] {
    const out: ModuleId[] = [];
    for (const [id, list] of this._byModule) if (list.length > 0) out.push(id);
    return out;
  }

  /**
   * Can this spot be entered under `gravity`?
   *
   * An equipment bay you have to stand up into is `'nominal'`; a stowage net
   * you float into is `'zero'`; a bunk with restraints is `'any'`. The check is
   * live rather than baked, because the §5 director drops gravity mid-round and
   * a bay that was usable a minute ago may not be now — which is a genuinely
   * good moment and not a bug.
   */
  usableIn(volume: HideVolume, gravity: GravityMode): boolean {
    return scopeAdmits(volume.usableIn, gravity);
  }

  /** `usableIn`, reading the module's CURRENT gravity from the graph. */
  usableNow(volume: HideVolume): boolean {
    return this.usableIn(volume, this.graph.gravityOf(volume.module));
  }

  /** Apply a spot's shell to a source loudness (§3). Clamped at 0. */
  muffle(volume: HideVolume, loudness: number): number {
    return muffledLoudness(loudness, volume.muffleDb);
  }

  // -- geometry -------------------------------------------------------------

  /** World point → the spot's local frame, written into `out`. */
  private toLocal(volume: HideVolume, world: Vec3, out: Vec3): Vec3 {
    return worldToLocalInto(world, { pos: volume.centre, quat: volume.quat }, out);
  }

  /**
   * Is `worldPos` inside this volume, expanded by `margin`?
   *
   * This is the alien's contact-test exclusion: a body whose position is inside
   * an occupied volume is not somewhere it can reach by walking into it.
   */
  containsPoint(volume: HideVolume, worldPos: Vec3, margin = 0): boolean {
    const p = this.toLocal(volume, worldPos, this._localA);
    const h = volume.halfExtents;
    return (
      Math.abs(p.x) <= h.x + margin &&
      Math.abs(p.y) <= h.y + margin &&
      Math.abs(p.z) <= h.z + margin
    );
  }

  /** The volume containing `worldPos`, or null. Pass `moduleId` to skip the
   *  station-wide scan — the caller almost always knows it. */
  containing(worldPos: Vec3, moduleId?: ModuleId, margin = 0): HideVolume | null {
    const candidates = moduleId === undefined ? this._all : this.inModule(moduleId);
    for (let i = 0; i < candidates.length; i++) {
      const v = candidates[i];
      // Broad-phase: a sphere test before the three transforms.
      if (distance(worldPos, v.centre) > v.radius + margin) continue;
      if (this.containsPoint(v, worldPos, margin)) return v;
    }
    return null;
  }

  /** Closest point on this volume's box (surface, or `worldPos` itself when
   *  inside) to `worldPos`, written into `out`, world space. */
  closestPointInto(volume: HideVolume, worldPos: Vec3, out: Vec3): Vec3 {
    const p = this.toLocal(volume, worldPos, this._localA);
    const h = volume.halfExtents;
    p.x = Math.max(-h.x, Math.min(h.x, p.x));
    p.y = Math.max(-h.y, Math.min(h.y, p.y));
    p.z = Math.max(-h.z, Math.min(h.z, p.z));
    return localToWorldInto(p, { pos: volume.centre, quat: volume.quat }, out);
  }

  /**
   * Nearest usable spot by distance to the box SURFACE, with the closest
   * surface point written into `outPoint`.
   *
   * This is the "press E to get in" query. It used to be `nearestEntry` — the
   * distance to the authored standing point — but the entry stands a body
   * radius plus clearance off the shell, so the prompt appeared (and its glyph
   * anchored) more than a metre from the box it was about: "the E interact to
   * hide shows up far from the actual hiding spot". Measuring to the box makes
   * the prompt behave like every other object's: you get it when you are AT
   * the thing, from any side of it.
   */
  nearestSurface(
    moduleId: ModuleId,
    worldPos: Vec3,
    maxDistance: number,
    gravity: GravityMode | undefined,
    outPoint: Vec3,
  ): HideVolume | null {
    const mode = gravity ?? this.graph.gravityOf(moduleId);
    let best: HideVolume | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    const list = this.inModule(moduleId);
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!this.usableIn(v, mode)) continue;
      // Broad-phase: the bounding sphere before three transforms.
      if (distance(worldPos, v.centre) > v.radius + maxDistance) continue;
      const d = distance(worldPos, this.closestPointInto(v, worldPos, this._localB));
      if (d > maxDistance || d >= bestD) continue;
      best = v;
      bestD = d;
    }
    if (best) this.closestPointInto(best, worldPos, outPoint);
    return best;
  }

  /**
   * Nearest spot whose ENTRY is within `maxDistance` of `worldPos` and which is
   * usable under the module's current gravity.
   */
  nearestEntry(
    moduleId: ModuleId,
    worldPos: Vec3,
    maxDistance: number,
    gravity?: GravityMode,
  ): HideVolume | null {
    const mode = gravity ?? this.graph.gravityOf(moduleId);
    let best: HideVolume | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    const list = this.inModule(moduleId);
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!this.usableIn(v, mode)) continue;
      const d = distance(worldPos, v.entry);
      if (d > maxDistance || d >= bestD) continue;
      best = v;
      bestD = d;
    }
    return best;
  }

  /**
   * Does a swept sphere of `radius` from `a` to `b` pass through any hide
   * volume in `moduleId`? Returns the FIRST volume hit along the sweep.
   *
   * THE alien-side query, and the reason hiding works at all: its sweep does
   * not pass through you. Implemented as an exact segment-vs-slab test against
   * the box expanded by `radius`, in the box's own frame — which treats the
   * swept sphere's rounded corners as square and therefore reports a block
   * slightly MORE often than the true capsule test would. That error is in the
   * only safe direction: the failure this must never have is the alien clipping
   * a corner of a locker somebody is inside.
   */
  sweepBlocked(
    moduleId: ModuleId,
    a: Vec3,
    b: Vec3,
    radius = 0,
    filter?: (volume: HideVolume) => boolean,
  ): HideSweepHit | null {
    const list = this.inModule(moduleId);
    let best: HideSweepHit | null = null;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (filter && !filter(v)) continue;
      const t = this.segmentHit(v, a, b, radius);
      if (t === null) continue;
      if (best === null || t < best.t) best = { volume: v, t };
    }
    return best;
  }

  /**
   * Parameter along a→b at which the segment first enters this volume expanded
   * by `radius`, or null if it never does. Slab method, exact for the box.
   */
  segmentHit(volume: HideVolume, a: Vec3, b: Vec3, radius = 0): number | null {
    const p = this.toLocal(volume, a, this._localA);
    const q = this.toLocal(volume, b, this._localB);
    const h = volume.halfExtents;
    const ex = h.x + radius;
    const ey = h.y + radius;
    const ez = h.z + radius;

    let tMin = 0;
    let tMax = 1;
    const axes: Array<[number, number, number]> = [
      [p.x, q.x - p.x, ex],
      [p.y, q.y - p.y, ey],
      [p.z, q.z - p.z, ez],
    ];
    for (const [origin, delta, extent] of axes) {
      if (Math.abs(delta) < 1e-9) {
        // Parallel to this slab: either inside it for the whole sweep, or never.
        if (origin < -extent || origin > extent) return null;
        continue;
      }
      const inv = 1 / delta;
      let t0 = (-extent - origin) * inv;
      let t1 = (extent - origin) * inv;
      if (t0 > t1) {
        const swap = t0;
        t0 = t1;
        t1 = swap;
      }
      if (t0 > tMin) tMin = t0;
      if (t1 < tMax) tMax = t1;
      if (tMin > tMax) return null;
    }
    return tMin;
  }

  /** World position a body occupies while inside a spot — the box centre. */
  occupantPosition(key: HideSpotKey): Vec3 {
    return cloneV3(this.require(key).centre);
  }

  // -- validation -----------------------------------------------------------

  /** Layout validation: human-readable problems, empty when clean. */
  validate(): string[] {
    const problems: string[] = [];
    for (const v of this._all) {
      const h = v.halfExtents;
      if (h.x <= 0 || h.y <= 0 || h.z <= 0) {
        problems.push(`hide spot '${v.key}' has a zero or negative half-extent`);
      }
      if (v.muffleDb > 0) {
        problems.push(`hide spot '${v.key}' has a positive muffleDb (${v.muffleDb}) — it would amplify`);
      }
      // The entry must be OUTSIDE the box, or "walk to the entry, then get in"
      // has no second step and the prompt fires from within the geometry.
      if (this.containsPoint(v, v.entry)) {
        problems.push(`hide spot '${v.key}' has its entryPos inside its own volume`);
      }
      const reach = distance(v.entry, v.centre);
      if (reach > v.radius + 2.5) {
        problems.push(
          `hide spot '${v.key}' has its entryPos ${reach.toFixed(2)}m from the volume — too far to read as the same object`,
        );
      }
      // A spot usable ONLY in a mode the module can never be in is dead
      // content. The director can flip any module to 'zero', so only the
      // 'nominal'-only case is checkable here.
      if (v.usableIn === 'nominal' && this.graph.authoredGravity(v.module) === 'zero') {
        problems.push(
          `hide spot '${v.key}' is usable only under gravity, but module '${v.module}' is authored zero-G`,
        );
      }
    }
    if (this._all.length > 0 && this._all.length < HIDE_SPOTS_MIN) {
      problems.push(
        `the station has ${this._all.length} hide spots, under the ${HIDE_SPOTS_MIN} a round needs to make hiding a real option`,
      );
    }
    return problems;
  }
}
