/**
 * PannerNode pool (DESIGN.md §8: "Pool your PannerNodes. Browsers degrade past
 * a few dozen HRTF panners").
 *
 * Six players in a station where every grip, breath and hatch is a sound will
 * blow past a few dozen panners in a busy second, so panners are a rented
 * resource. Distance attenuation is deliberately DISABLED on them
 * (`rolloffFactor = 0`): §3 already decided how loud the sound is, in loudness
 * points, over a graph that knows about hatches. Letting Web Audio apply a
 * second, geometric falloff on top would double-attenuate and quietly break the
 * mental model pillar 3 exists to protect. The panner does one job: direction.
 */

const HRTF_DEFAULT_CAPACITY = 24;

export interface PannerLease {
  node: PannerNode;
  release(): void;
}

/** Set a panner's position, ramped when the node exposes AudioParams. */
export function setPannerPosition(
  panner: PannerNode,
  x: number,
  y: number,
  z: number,
  when: number,
  tau = 0.02,
): void {
  const p = panner as PannerNode & {
    positionX?: AudioParam;
    positionY?: AudioParam;
    positionZ?: AudioParam;
  };
  if (p.positionX && p.positionY && p.positionZ) {
    p.positionX.setTargetAtTime(x, when, tau);
    p.positionY.setTargetAtTime(y, when, tau);
    p.positionZ.setTargetAtTime(z, when, tau);
    return;
  }
  // Safari and older Chromium: the deprecated setter is the only way in.
  const legacy = panner as unknown as { setPosition?: (x: number, y: number, z: number) => void };
  legacy.setPosition?.(x, y, z);
}

export class PannerPool {
  private readonly ctx: AudioContext;
  private readonly free: PannerNode[] = [];
  private readonly busy = new Set<PannerNode>();
  readonly capacity: number;

  constructor(ctx: AudioContext, capacity = HRTF_DEFAULT_CAPACITY) {
    this.ctx = ctx;
    this.capacity = capacity;
  }

  get active(): number {
    return this.busy.size;
  }

  get available(): number {
    return this.capacity - this.busy.size;
  }

  /**
   * Rent a panner and connect it to `destination`. Returns null when the pool
   * is exhausted — the caller decides whether to steal a quieter voice or fall
   * back to cheap stereo panning.
   */
  acquire(destination: AudioNode): PannerLease | null {
    if (this.busy.size >= this.capacity) return null;
    const node = this.free.pop() ?? this.create();
    this.busy.add(node);
    node.connect(destination);
    let released = false;
    return {
      node,
      release: () => {
        if (released) return;
        released = true;
        this.recycle(node);
      },
    };
  }

  private create(): PannerNode {
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    // Zero rolloff: §3 owns attenuation, the panner owns direction only.
    panner.rolloffFactor = 0;
    panner.maxDistance = 10000;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain = 1;
    return panner;
  }

  private recycle(node: PannerNode): void {
    try {
      node.disconnect();
    } catch {
      /* already disconnected */
    }
    this.busy.delete(node);
    this.free.push(node);
  }

  /** Drop every pooled node. Only on teardown. */
  dispose(): void {
    for (const node of this.busy) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.busy.clear();
    for (const node of this.free) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.free.length = 0;
  }
}
