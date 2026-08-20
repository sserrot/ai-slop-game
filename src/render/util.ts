/**
 * src/render/util.ts — small framerate-independent smoothing helpers.
 *
 * DESIGN.md §4 is emphatic about this: specify half-lives, never bare exponents.
 * `src/core/ticker` exports the same idea as `halfLifeDecay`, but the render
 * subsystem keeps its own copy so it depends on nothing but `three` and `shared/`.
 */

/** Fraction of the current value that survives `dt` seconds at this half-life. */
export function decayFactor(dt: number, halfLife: number): number {
  if (halfLife <= 0 || dt <= 0) return halfLife <= 0 ? 0 : 1;
  return Math.pow(0.5, dt / halfLife);
}

/** Exponential approach: `current` moves toward `target`, halving the gap every `halfLife`. */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  const k = decayFactor(dt, halfLife);
  const next = target + (current - target) * k;
  // Snap when we are within float noise, so uniforms stop churning.
  return Math.abs(next - target) < 1e-5 ? target : next;
}

/**
 * Exponential approach with different attack and release times — the shape every
 * horror response wants (snap on, bleed off).
 */
export function dampAsym(
  current: number,
  target: number,
  riseHalfLife: number,
  fallHalfLife: number,
  dt: number,
): number {
  return damp(current, target, target > current ? riseHalfLife : fallHalfLife, dt);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Cheap band-limited flicker in 0–1, deterministic in `t`. Three summed sines
 * beat a random() call: no state, no per-frame allocation, and it reads as a
 * failing fluorescent rather than TV static.
 */
export function flicker01(t: number): number {
  const v = Math.sin(t) * 0.5 + Math.sin(t * 2.37 + 1.3) * 0.32 + Math.sin(t * 5.11 + 2.7) * 0.18;
  return clamp01(v * 0.5 + 0.5);
}
