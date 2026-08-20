/**
 * Deterministic RNG helpers for level authoring (DESIGN.md §2).
 *
 * Decor placement, locker contents and fuse/card/decoy distribution all need to
 * be reproducible from a seed: the level file must be byte-stable between
 * regenerations, and the server has to be able to hand every client the same
 * locker layout from one number (§7 — the server is authoritative).
 *
 * No three.js import here on purpose: `buildLevel.ts` runs this under tsx.
 */

/** FNV-1a over a string — a stable 32-bit seed from any id. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 — small, fast, good enough, and identical on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded generator from any mix of ids and numbers. */
export function rngFor(...parts: Array<string | number>): () => number {
  return mulberry32(hashString(parts.map(String).join('|')));
}

export function randRange(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[Math.floor(rng() * items.length) % items.length] as T;
}

/** Fisher–Yates on a copy. */
export function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
