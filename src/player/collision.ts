/**
 * Swept-sphere collision against the static station BVH (DESIGN.md §4:
 * "Hand-rolled kinematic controller, swept sphere against a BVH of static
 * geometry"; §1 picks `three-mesh-bvh` for exactly this). The sphere is
 * `PLAYER_RADIUS`, which §14 owns and has already moved once.
 *
 * The integrator hands us whatever it has — a `MeshBVH`, a `Mesh` whose geometry
 * already carries `boundsTree`, or a whole `Object3D` to walk. Everything is
 * normalised into `{ bvh, matrixWorld }` pairs so a module placed by the station
 * loader's transform collides correctly without re-baking geometry.
 *
 * The sweep is substepped (never more than half a radius per step) so a body at
 * PUSH_MAX cannot tunnel a bulkhead, and each substep is depenetrated against
 * every triangle inside the sphere. That is enough for tubes and hatch rims, and
 * it is stable in a corner, which a single-plane response is not.
 *
 * THE WALKING PIVOT ADDED A CAPSULE, AND CHANGED NOTHING ELSE. `sweep()` and
 * `depenetrate()` take an optional list of sphere OFFSETS from the body point.
 * Omit it — as every zero-G call site does — and you get the identical single
 * sphere, byte for byte, which is why both of §4's hard-won fixes (the
 * pre-restitution approach speed, and shut hatches stopping the body on the
 * swept path) carry over untouched. Pass two offsets and the same machinery
 * resolves a capsule: §14 defines the walking body as exactly that, two spheres
 * of PLAYER_RADIUS at `floor + r` and `floor + height − r`.
 *
 * `raycast()` is the other addition: the ground probe (§4 `GROUND_PROBE_M`)
 * needs to answer "is there a deck under my feet, and which way does it face",
 * which no amount of depenetration will tell you.
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { ExtendedTriangle } from 'three-mesh-bvh';
import {
  COLLISION_SUBSTEP_FACTOR,
  CONTACT_EPSILON,
  DEPENETRATION_ITERATIONS,
} from './tuning';

/**
 * WHY THIS FILE TALKS TO THE BVH THROUGH `intersectsRange` RATHER THAN
 * `intersectsTriangle`, AND WHY `raycast()` NO LONGER CALLS `raycastFirst`.
 *
 * Both are allocation, and this file runs the innermost loop of the frame.
 * MEASURED, per call, on the real station BVH (Node 22, scavenge-counting
 * meter — see the report):
 *
 *   bvh.raycastFirst(...)                        1357 B   <- the ground probe
 *   bvh.shapecast({ intersectsTriangle })         660 B   <- depenetration
 *   bvh.shapecast({ intersectsRange })            463 B
 *
 * `raycastFirst` mints an intersection record per candidate triangle: a
 * `point`, an interpolated `normal`, a `face` with its own `normal`, a
 * `barycoord`, and a `uv` per uv set — for a query that wants one distance and
 * one geometric normal, both of which we then copy into a `RayHit` we already
 * own. `intersectsTriangle` costs a closure per call, because `BVH.shapecast`
 * has to wrap it in an `intersectsRange` it builds on the spot; handing it the
 * range callback directly skips that.
 *
 * NEITHER CHANGES A NUMBER. The range callback runs the identical triangles in
 * the identical order (`iterateOverTriangles` is the loop it replaces, and it
 * reads the same index/position attributes the same way), and the ray test is
 * `THREE.Ray.intersectTriangle` with `backfaceCulling = false` plus
 * `Triangle.getNormal` — which is exactly what `checkBufferGeometryIntersection`
 * does for `DoubleSide` and what fills `face.normal`. A BVH built with
 * `indirect: true` reorders triangles behind a lookup, so those fall back to
 * the library's own iteration and are unaffected.
 *
 * What is left is ~320 B per cast inside `three-mesh-bvh` itself:
 * `BufferStack.setBuffer` builds three fresh typed-array views over the node
 * buffer on every single cast. That is not reachable from here.
 */

/**
 * Sphere centres, as offsets from the body point, that make up the collider.
 *
 * `undefined` (and the frozen `SINGLE_SPHERE` below) both mean "one sphere at
 * the body point" — the §4 zero-G body, unchanged.
 */
export type BodyOffsets = readonly THREE.Vector3[] | null | undefined;

/** What a ground probe found. Reused between calls — copy anything you keep. */
export interface RayHit {
  hit: boolean;
  /** Metres from the ray origin to the surface. */
  distance: number;
  /** World-space contact point. */
  point: THREE.Vector3;
  /** World-space unit normal, flipped to oppose the ray so a deck authored
   *  either way round still reads as a floor. */
  normal: THREE.Vector3;
}

export function makeRayHit(): RayHit {
  return { hit: false, distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };
}

/** A BVH plus the world transform of the object it was built for. */
export interface ColliderEntry {
  bvh: MeshBVH;
  matrixWorld?: THREE.Matrix4;
}

export type ColliderSource = MeshBVH | THREE.Object3D | ColliderEntry;
export type ColliderInput = ColliderSource | readonly ColliderSource[] | null | undefined;

/** Outcome of a sweep or a depenetration. Reused between calls — copy anything
 *  you intend to keep. */
export interface ContactResult {
  /** True if geometry pushed the sphere at all. */
  hit: boolean;
  /** Unit normal of the last contact, world space, pointing away from the wall. */
  normal: THREE.Vector3;
  /** Total metres of penetration resolved. */
  depth: number;
}

interface InternalEntry {
  bvh: MeshBVH;
  matrixWorld: THREE.Matrix4;
  inverse: THREE.Matrix4;
  /** Uniform scale factor of matrixWorld, used to scale the query radius. */
  scale: number;
  source: THREE.Object3D | null;
  /** Index and position attributes of `bvh.geometry`, hoisted so the range
   *  callbacks below do not re-walk the geometry on every leaf. Null when the
   *  BVH is `indirect`, which is the signal to use the library's own
   *  triangle iteration instead (see the file header). */
  index: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null;
}

const _local = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _worldAfter = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _push = new THREE.Vector3();
const _step = new THREE.Vector3();
const _ray = new THREE.Ray();
const _normalMatrix = new THREE.Matrix3();
const _hitNormal = new THREE.Vector3();
/** The one triangle every range callback fills. `THREE.Triangle`, not
 *  `ExtendedTriangle`: the two share `closestPointToPoint` and `getNormal`
 *  verbatim, and nothing here needs the SAT cache the extended one maintains. */
const _tri = new THREE.Triangle();
/** Ray query scratch — the entry point of a bounds box, and the triangle hit. */
const _boxPoint = new THREE.Vector3();
const _triPoint = new THREE.Vector3();

/** The default collider: one sphere, centred on the body point. */
const SINGLE_SPHERE: readonly THREE.Vector3[] = Object.freeze([new THREE.Vector3(0, 0, 0)]);

export class StationCollider {
  private entries: InternalEntry[] = [];

  /**
   * State the shapecast callbacks below read, and the callbacks themselves.
   *
   * `shapecast` is the innermost thing the §4 controller does — up to
   * DEPENETRATION_ITERATIONS passes per substep, every frame, forever. Written
   * as an object literal with two closures inside `resolveOnce` it minted three
   * objects on every one of those passes for no reason at all: the query is
   * always this one sphere against this one collider, so the callbacks are
   * built once and the per-query values are handed over as fields.
   *
   * The sphere centre itself lives in `_local`, the module scratch the whole
   * class already shares — nothing here is re-entrant and nothing needs to be.
   */
  private probeRadius = 0;
  private probeRadiusSq = 0;
  private probeMoved = false;
  /** Attributes of the entry currently being probed. Set by `resolveOnce`. */
  private probeIndex: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null = null;
  private probePosition: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null = null;

  /** One sphere against one triangle. The body of both probe callbacks. */
  private probeTriangle(tri: THREE.Triangle): void {
    tri.closestPointToPoint(_local, _closest);
    const distSq = _closest.distanceToSquared(_local);
    if (distSq >= this.probeRadiusSq) return;
    const dist = Math.sqrt(distSq);
    if (dist > 1e-6) {
      _dir.subVectors(_local, _closest).divideScalar(dist);
    } else {
      // Dead centre on the face: push along the face normal.
      tri.getNormal(_dir);
      if (_dir.lengthSq() < 1e-12) return;
    }
    _local.addScaledVector(_dir, this.probeRadius - dist);
    this.probeMoved = true;
  }

  private readonly probeCallbacks = {
    intersectsBounds: (box: THREE.Box3): boolean =>
      box.distanceToPoint(_local) <= this.probeRadius,
    /** The fast path: our own leaf iteration, so `BVH.shapecast` does not have
     *  to build an `intersectsRange` closure per cast. Identical triangles in
     *  identical order — see the file header. */
    intersectsRange: (offset: number, count: number): boolean => {
      const index = this.probeIndex;
      const position = this.probePosition;
      if (!position) return false;
      for (let i = offset, end = offset + count; i < end; i++) {
        setTriangleFrom(_tri, i * 3, index, position);
        this.probeTriangle(_tri);
      }
      return false; // keep collecting; a corner needs every triangle
    },
  };

  /** The `indirect: true` fallback — the library resolves the triangle order,
   *  so it has to do the iterating. Same maths, one closure per cast. */
  private readonly probeCallbacksIndirect = {
    intersectsBounds: (box: THREE.Box3): boolean =>
      box.distanceToPoint(_local) <= this.probeRadius,
    intersectsTriangle: (tri: ExtendedTriangle): boolean => {
      this.probeTriangle(tri);
      return false;
    },
  };

  // -- ray query state, read by `rayCallbacks` ------------------------------
  /** Local-space near/far bound of the ray currently being cast. */
  private rayNear = 0;
  private rayFar = 0;
  /** Distance to the best hit so far, local metres. Also the live cull bound. */
  private rayBest = 0;
  private rayHitFound = false;
  private rayIndex: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null = null;
  private rayPosition: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null = null;
  private readonly rayPoint = new THREE.Vector3();
  private readonly rayNormal = new THREE.Vector3();

  private rayTriangle(tri: THREE.Triangle): void {
    // `backfaceCulling: false` is `DoubleSide`, which is what this class has
    // always asked `raycastFirst` for and why a deck authored either way round
    // still reads as a floor.
    if (!_ray.intersectTriangle(tri.a, tri.b, tri.c, false, _triPoint)) return;
    const dist = _ray.origin.distanceTo(_triPoint);
    if (dist < this.rayNear || dist > this.rayFar) return;
    if (this.rayHitFound && dist >= this.rayBest) return;
    this.rayHitFound = true;
    this.rayBest = dist;
    this.rayPoint.copy(_triPoint);
    THREE.Triangle.getNormal(tri.a, tri.b, tri.c, this.rayNormal);
  }

  private readonly rayCallbacks = {
    intersectsBounds: (box: THREE.Box3): boolean => {
      if (!_ray.intersectBox(box, _boxPoint)) return false;
      // A box we are already inside returns its EXIT point, which would look
      // like a far box and prune a node we are standing in. Distance 0 is the
      // honest answer there.
      const entry = box.containsPoint(_ray.origin) ? 0 : _ray.origin.distanceTo(_boxPoint);
      return entry <= (this.rayHitFound ? Math.min(this.rayFar, this.rayBest) : this.rayFar);
    },
    intersectsRange: (offset: number, count: number): boolean => {
      const index = this.rayIndex;
      const position = this.rayPosition;
      if (!position) return false;
      for (let i = offset, end = offset + count; i < end; i++) {
        setTriangleFrom(_tri, i * 3, index, position);
        this.rayTriangle(_tri);
      }
      return false;
    },
  };

  private readonly rayCallbacksIndirect = {
    intersectsBounds: this.rayCallbacks.intersectsBounds,
    intersectsTriangle: (tri: ExtendedTriangle): boolean => {
      this.rayTriangle(tri);
      return false;
    },
  };

  /** True once there is anything to collide with. Before that the controller
   *  flies free, which keeps the client usable while the station streams in. */
  get ready(): boolean {
    return this.entries.length > 0;
  }

  get colliderCount(): number {
    return this.entries.length;
  }

  /** Replace the whole collision set. */
  set(input: ColliderInput): void {
    this.entries = [];
    this.add(input);
  }

  /** Add to the collision set. Accepts a MeshBVH, an Object3D (walked for
   *  meshes), a `{bvh, matrixWorld}` pair, or an array of any of those. */
  add(input: ColliderInput): void {
    if (!input) return;
    if (Array.isArray(input)) {
      for (const item of input as readonly ColliderSource[]) this.add(item);
      return;
    }
    const single = input as ColliderSource;
    if (single instanceof MeshBVH) {
      this.pushEntry(single, null, null);
      return;
    }
    if (isColliderEntry(single)) {
      this.pushEntry(single.bvh, single.matrixWorld ?? null, null);
      return;
    }
    if (isObject3D(single)) {
      single.updateWorldMatrix(true, true);
      single.traverse((child) => {
        if (!isMesh(child)) return;
        const geometry = child.geometry;
        if (!geometry || !geometry.attributes.position) return;
        const existing = geometry.boundsTree as MeshBVH | undefined;
        const bvh = existing ?? new MeshBVH(geometry);
        if (!existing) geometry.boundsTree = bvh;
        this.pushEntry(bvh, child.matrixWorld, child);
      });
    }
  }

  clear(): void {
    this.entries = [];
  }

  /** Re-read the world matrices of every Object3D-sourced collider. Static
   *  geometry rarely moves, but a station assembled after `set()` will. */
  refreshTransforms(): void {
    for (const entry of this.entries) {
      if (!entry.source) continue;
      entry.source.updateWorldMatrix(true, false);
      entry.matrixWorld.copy(entry.source.matrixWorld);
      entry.inverse.copy(entry.matrixWorld).invert();
      entry.scale = uniformScale(entry.matrixWorld);
    }
  }

  /**
   * Push a body out of any geometry it is inside. `center` is mutated.
   * Returns the shared result object.
   *
   * `offsets` are sphere centres relative to `center`. Omitted, the body is the
   * single §4 sphere and this behaves exactly as it always has. Supplied, each
   * sphere is resolved in turn and its correction applied to the whole body, so
   * a capsule wedged under a coaming is pushed out by the sphere that is
   * actually stuck rather than by an average of the two.
   */
  depenetrate(
    center: THREE.Vector3,
    radius: number,
    out: ContactResult = makeResult(),
    offsets?: BodyOffsets,
  ): ContactResult {
    out.hit = false;
    out.depth = 0;
    out.normal.set(0, 0, 0);
    if (this.entries.length === 0) return out;

    const spheres = offsets && offsets.length > 0 ? offsets : SINGLE_SPHERE;
    for (let i = 0; i < DEPENETRATION_ITERATIONS; i++) {
      _push.set(0, 0, 0);
      let moved = 0;
      for (let s = 0; s < spheres.length; s++) {
        // Resolve each sphere where it actually is, then carry its correction
        // back to the body point. The offsets are rigid, so the whole capsule
        // moves together and the next sphere is tested from the new position.
        _probeBefore.copy(center).add(spheres[s]);
        _probeAfter.copy(_probeBefore);
        moved += this.resolveOnce(_probeAfter, radius, _push);
        center.add(_probeAfter.sub(_probeBefore));
      }
      if (moved <= CONTACT_EPSILON) break;
      out.hit = true;
      out.depth += moved;
      if (_push.lengthSq() > 1e-12) out.normal.copy(_push).normalize();
    }
    return out;
  }

  /**
   * Would a body of this shape be intersecting geometry at `center`?
   *
   * Non-mutating, and asked for exactly one reason: may a crouching player stand
   * up here (§4 — crouch has to be genuinely useful for getting under things,
   * which means standing back up has to be genuinely refusable). The tolerance
   * exists because a body at rest on the deck is always a hair inside it.
   */
  overlaps(center: THREE.Vector3, radius: number, offsets?: BodyOffsets, tolerance = 0): boolean {
    if (this.entries.length === 0) return false;
    const spheres = offsets && offsets.length > 0 ? offsets : SINGLE_SPHERE;
    let moved = 0;
    for (let s = 0; s < spheres.length; s++) {
      _overlapProbe.copy(center).add(spheres[s]);
      _push.set(0, 0, 0);
      moved += this.resolveOnce(_overlapProbe, radius, _push);
      if (moved > tolerance) return true;
    }
    return false;
  }

  /**
   * First surface along a ray, world space. The §4 ground probe.
   *
   * `DoubleSide` on purpose: a deck authored as a one-sided plane is a coin toss
   * under `FrontSide`, and "the floor is missing for half the station" is not a
   * failure mode worth leaving open to a winding order.
   */
  raycast(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    out: RayHit = makeRayHit(),
  ): RayHit {
    out.hit = false;
    out.distance = maxDistance;
    if (this.entries.length === 0) return out;

    for (const entry of this.entries) {
      _ray.origin.copy(origin).applyMatrix4(entry.inverse);
      _ray.direction.copy(direction).transformDirection(entry.inverse).normalize();
      // The direction was renormalised in the entry's local frame, so the ray
      // parameter is local metres: convert the budget in and the answer out.
      this.rayNear = 0;
      this.rayFar = out.distance / entry.scale;
      this.rayBest = this.rayFar;
      this.rayHitFound = false;
      if (entry.position) {
        this.rayIndex = entry.index;
        this.rayPosition = entry.position;
        entry.bvh.shapecast(this.rayCallbacks);
      } else {
        entry.bvh.shapecast(this.rayCallbacksIndirect);
      }
      if (!this.rayHitFound) continue;

      const worldDistance = this.rayBest * entry.scale;
      if (out.hit && worldDistance >= out.distance) continue;
      out.hit = true;
      out.distance = worldDistance;
      out.point.copy(this.rayPoint).applyMatrix4(entry.matrixWorld);
      _normalMatrix.getNormalMatrix(entry.matrixWorld);
      _hitNormal.copy(this.rayNormal).applyMatrix3(_normalMatrix).normalize();
      // Face the ray, so no caller has to care which way the triangle wound.
      if (_hitNormal.dot(direction) > 0) _hitNormal.negate();
      out.normal.copy(_hitNormal);
    }
    return out;
  }

  /**
   * Move a sphere by `delta`, substepping and depenetrating as it goes.
   * `center` is mutated to the final position.
   *
   * `onStep` runs after every substep with the current centre; return true to
   * abort the rest of the sweep — that is how the §4 buffered grab latches the
   * instant a rail enters range, rather than at the end of the frame.
   */
  sweep(
    center: THREE.Vector3,
    delta: THREE.Vector3,
    radius: number,
    onStep?: (center: THREE.Vector3, stepIndex: number) => boolean | void,
    out: ContactResult = makeResult(),
    offsets?: BodyOffsets,
  ): ContactResult {
    out.hit = false;
    out.depth = 0;
    out.normal.set(0, 0, 0);

    const distance = delta.length();
    if (distance <= 1e-9) {
      if (this.entries.length > 0) this.depenetrate(center, radius, out, offsets);
      onStep?.(center, 0);
      return out;
    }

    const maxStep = Math.max(0.05, radius * COLLISION_SUBSTEP_FACTOR);
    const steps = Math.max(1, Math.ceil(distance / maxStep));
    _step.copy(delta).divideScalar(steps);

    for (let i = 0; i < steps; i++) {
      center.add(_step);
      if (this.entries.length > 0) {
        const contact = this.depenetrate(center, radius, sweepScratch, offsets);
        if (contact.hit) {
          out.hit = true;
          out.depth += contact.depth;
          out.normal.copy(contact.normal);
        }
      }
      if (onStep?.(center, i) === true) break;
    }
    return out;
  }

  /** Nearest surface point to `point` across every collider, world space.
   *  Null when nothing is within `maxDistance`. */
  closestPoint(point: THREE.Vector3, maxDistance = Infinity): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bestDist = maxDistance;
    for (const entry of this.entries) {
      _local.copy(point).applyMatrix4(entry.inverse);
      const hit = entry.bvh.closestPointToPoint(_local, undefined, 0, bestDist / entry.scale);
      if (!hit) continue;
      const world = hit.point.clone().applyMatrix4(entry.matrixWorld);
      const d = world.distanceTo(point);
      if (d < bestDist) {
        bestDist = d;
        best = world;
      }
    }
    return best;
  }

  // -- internals ------------------------------------------------------------

  private pushEntry(
    bvh: MeshBVH,
    matrixWorld: THREE.Matrix4 | null,
    source: THREE.Object3D | null,
  ): void {
    const m = matrixWorld ? matrixWorld.clone() : new THREE.Matrix4();
    // `indirect` BVHs keep their own triangle order behind `resolveTriangleIndex`,
    // so leaf ranges do not map to `index` positionally: leave both null and the
    // queries fall back to the library's iteration.
    const direct = !bvh.indirect;
    const geometry = bvh.geometry;
    this.entries.push({
      bvh,
      matrixWorld: m,
      inverse: m.clone().invert(),
      scale: uniformScale(m),
      source,
      index: direct ? geometry.getIndex() : null,
      position: direct
        ? (geometry.getAttribute('position') as THREE.BufferAttribute | undefined) ?? null
        : null,
    });
  }

  /**
   * One depenetration pass. Returns the metres moved and accumulates the world
   * push direction into `pushOut`.
   */
  private resolveOnce(center: THREE.Vector3, radius: number, pushOut: THREE.Vector3): number {
    let total = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      _local.copy(center).applyMatrix4(entry.inverse);
      const localRadius = radius / entry.scale;
      this.probeRadius = localRadius;
      this.probeRadiusSq = localRadius * localRadius;
      this.probeMoved = false;

      if (entry.position) {
        this.probeIndex = entry.index;
        this.probePosition = entry.position;
        entry.bvh.shapecast(this.probeCallbacks);
      } else {
        entry.bvh.shapecast(this.probeCallbacksIndirect);
      }

      if (!this.probeMoved) continue;
      _worldAfter.copy(_local).applyMatrix4(entry.matrixWorld);
      _delta.subVectors(_worldAfter, center);
      const len = _delta.length();
      if (len <= CONTACT_EPSILON) continue;
      total += len;
      pushOut.add(_delta);
      center.copy(_worldAfter);
    }
    return total;
  }
}

function makeResult(): ContactResult {
  return { hit: false, normal: new THREE.Vector3(), depth: 0 };
}

/** Private to `sweep`, so a caller may safely pass its own result object in. */
const sweepScratch = makeResult();
/** Private to the capsule loop in `depenetrate`. */
const _probeBefore = new THREE.Vector3();
const _probeAfter = new THREE.Vector3();
/** Private to `overlaps`, which must not disturb the depenetration scratch. */
const _overlapProbe = new THREE.Vector3();

/**
 * Fill `tri` from the geometry at vertex offset `i`.
 *
 * A transcription of `three-mesh-bvh`'s own `setTriangle`, which is what its
 * `iterateOverTriangles` calls before every `intersectsTriangle` — same
 * attributes, same index indirection, same component order — so a leaf walked
 * here and a leaf walked by the library produce the identical triangles.
 */
function setTriangleFrom(
  tri: THREE.Triangle,
  i: number,
  index: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null,
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): void {
  let i0 = i;
  let i1 = i + 1;
  let i2 = i + 2;
  if (index) {
    i0 = index.getX(i0);
    i1 = index.getX(i1);
    i2 = index.getX(i2);
  }
  tri.a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0));
  tri.b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1));
  tri.c.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2));
}

function uniformScale(m: THREE.Matrix4): number {
  const e = m.elements;
  const sx = Math.hypot(e[0], e[1], e[2]);
  return sx > 1e-9 ? sx : 1;
}

function isObject3D(value: unknown): value is THREE.Object3D {
  return typeof value === 'object' && value !== null && (value as THREE.Object3D).isObject3D === true;
}

function isMesh(value: THREE.Object3D): value is THREE.Mesh {
  return (value as THREE.Mesh).isMesh === true;
}

function isColliderEntry(value: unknown): value is ColliderEntry {
  return typeof value === 'object' && value !== null && (value as ColliderEntry).bvh instanceof MeshBVH;
}
