/**
 * Interpolation for remote bodies (DESIGN.md §7).
 *
 * "20 Hz server tick; clients render interpolated at display rate… Do not build
 * rollback machinery. Interpolate remote players and the alien."
 *
 * NEVER interpolate the local player: you are authoritative for your own
 * transform (§7 client authority), so your own position comes from the
 * controller, not from the network.
 *
 * The buffer is time-based, not tick-based: samples are stamped with the local
 * clock as they arrive and rendered `delayMs` in the past, so a late or dropped
 * patch shows as a slightly stale body rather than a snap.
 */

import { TICK_MS } from '@shared/constants';
import type { Quat, Vec3 } from '@shared/types';

/** Two ticks of buffer — enough to ride out one dropped patch. */
export const INTERP_DELAY_MS = TICK_MS * 2;

export interface TransformSample {
  /** Local receive time in ms. */
  t: number;
  pos: Vec3;
  quat: Quat;
}

export interface InterpolatedTransform {
  pos: Vec3;
  quat: Quat;
  /** True when the sample is older than the whole buffer — the body is stale. */
  extrapolated: boolean;
}

/**
 * A reusable `InterpolatedTransform` for `SnapshotBuffer.sampleInto`.
 *
 * One per body, held by the caller. `sampleAt` allocated three objects per body
 * per RENDERED frame for a value the renderer copies into a `Vector3` and
 * throws away; at six players that was 20 objects a frame at 60 Hz for data
 * that only changes at the 20 Hz tick.
 */
export function transformBuffer(): InterpolatedTransform {
  return { pos: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 }, extrapolated: false };
}

/** Shortest-arc quaternion interpolation. */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  return slerpQuatInto(a, b, t, { x: 0, y: 0, z: 0, w: 1 });
}

/** `slerpQuat` writing into `out`. Same arithmetic, same order, no allocation. */
export function slerpQuatInto(a: Quat, b: Quat, t: number, out: Quat): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  // Nearly parallel: linear blend, then normalise. Cheaper and stable.
  if (cos > 0.9995) {
    out.x = a.x + (bx - a.x) * t;
    out.y = a.y + (by - a.y) * t;
    out.z = a.z + (bz - a.z) * t;
    out.w = a.w + (bw - a.w) * t;
    return normaliseQuatInto(out, out);
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  out.x = a.x * wa + bx * wb;
  out.y = a.y * wa + by * wb;
  out.z = a.z * wa + bz * wb;
  out.w = a.w * wa + bw * wb;
  return out;
}

export function normaliseQuat(q: Quat): Quat {
  return normaliseQuatInto(q, { x: 0, y: 0, z: 0, w: 1 });
}

/** `normaliseQuat` writing into `out`. `out` may alias `q`. */
export function normaliseQuatInto(q: Quat, out: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-8) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return out;
  }
  out.x = q.x / len;
  out.y = q.y / len;
  out.z = q.z / len;
  out.w = q.w / len;
  return out;
}

function lerp3Into(a: Vec3, b: Vec3, t: number, out: Vec3): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

function copyV3(from: Vec3, out: Vec3): Vec3 {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  return out;
}

function copyQuat(from: Quat, out: Quat): Quat {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  out.w = from.w;
  return out;
}

/** Copy one stored sample into a result buffer. */
function fill(
  out: InterpolatedTransform,
  sample: TransformSample,
  extrapolated: boolean,
): InterpolatedTransform {
  copyV3(sample.pos, out.pos);
  copyQuat(sample.quat, out.quat);
  out.extrapolated = extrapolated;
  return out;
}

/**
 * A short ring of timestamped transforms with a time-based read.
 * One per remote player, one for the alien.
 */
export class SnapshotBuffer {
  private samples: TransformSample[] = [];

  constructor(private readonly capacity = 24) {}

  /** Record a server value. Duplicate consecutive values are still recorded —
   *  a body that stopped moving must stop moving on screen too. */
  push(t: number, pos: Vec3, quat: Quat): void {
    this.samples.push({ t, pos: { ...pos }, quat: { ...quat } });
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  get length(): number {
    return this.samples.length;
  }

  get latest(): TransformSample | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
  }

  clear(): void {
    this.samples.length = 0;
  }

  /**
   * The transform to draw at `renderTime` (already delayed by the caller).
   * Returns null only when nothing has ever been received.
   */
  sampleAt(renderTime: number): InterpolatedTransform | null {
    return this.sampleInto(renderTime, transformBuffer());
  }

  /**
   * `sampleAt` writing into a caller-owned buffer instead of allocating.
   *
   * Nothing is shared: one buffer per body, so two `NetClient`s (or two rooms
   * under test) cannot tread on each other. `out` is only touched when a sample
   * exists — a null return leaves it exactly as it was.
   */
  sampleInto(renderTime: number, out: InterpolatedTransform): InterpolatedTransform | null {
    if (this.samples.length === 0) return null;
    if (this.samples.length === 1) {
      return fill(out, this.samples[0], false);
    }

    const first = this.samples[0];
    if (renderTime <= first.t) {
      return fill(out, first, false);
    }
    const last = this.samples[this.samples.length - 1];
    if (renderTime >= last.t) {
      // Ran off the end of the buffer: hold the last known transform. Zero-G
      // bodies drift, but guessing is worse than being 50 ms behind.
      return fill(out, last, true);
    }

    for (let i = this.samples.length - 1; i > 0; i--) {
      const b = this.samples[i];
      const a = this.samples[i - 1];
      if (renderTime < a.t) continue;
      const span = b.t - a.t;
      const t = span > 1e-6 ? (renderTime - a.t) / span : 1;
      lerp3Into(a.pos, b.pos, t, out.pos);
      slerpQuatInto(a.quat, b.quat, t, out.quat);
      out.extrapolated = false;
      return out;
    }
    return fill(out, last, false);
  }
}

/**
 * Convenience wrapper: a buffer plus the non-interpolated fields that come with
 * it (module, state…). The fields are read at their latest value — only the
 * transform is interpolated.
 */
export class InterpolatedBody<Meta extends object> {
  readonly buffer: SnapshotBuffer;
  private _meta: Meta | null = null;

  constructor(capacity?: number) {
    this.buffer = new SnapshotBuffer(capacity);
  }

  update(t: number, pos: Vec3, quat: Quat, meta: Meta): void {
    this.buffer.push(t, pos, quat);
    this._meta = meta;
  }

  get meta(): Meta | null {
    return this._meta;
  }

  sample(renderTime: number): InterpolatedTransform | null {
    return this.buffer.sampleAt(renderTime);
  }

  /** `sample` into a caller-owned buffer — see `SnapshotBuffer.sampleInto`. */
  sampleInto(renderTime: number, out: InterpolatedTransform): InterpolatedTransform | null {
    return this.buffer.sampleInto(renderTime, out);
  }

  clear(): void {
    this.buffer.clear();
    this._meta = null;
  }
}
