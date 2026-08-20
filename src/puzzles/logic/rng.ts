/**
 * Seeded RNG for puzzle setup (DESIGN.md §11 — "a locker in another module,
 * somewhere different each round").
 *
 * Seeded rather than `Math.random` so a round can be replayed from its seed:
 * the same seed puts the laminated card and the fuses in the same lockers, which
 * turns "it hid the card somewhere impossible" from an argument into a bug
 * report you can reproduce.
 */

/** mulberry32 — 32-bit, fast, good enough for placement rolls. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [0, n). Returns 0 for n <= 0. */
export function randInt(rng: () => number, n: number): number {
  if (n <= 0) return 0;
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** Uniform float in [lo, hi). */
export function randRange(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Pick one element. Returns undefined only for an empty list. */
export function pick<T>(rng: () => number, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[randInt(rng, items.length)];
}

/** Fisher–Yates on a copy. */
export function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** A random permutation of 0..n-1 — the breaker order (§11 puzzle 1). */
export function permutation(rng: () => number, n: number): number[] {
  const base: number[] = [];
  for (let i = 0; i < n; i++) base.push(i);
  return shuffled(rng, base);
}
