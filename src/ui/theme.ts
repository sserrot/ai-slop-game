/**
 * ISS — UI palette and canvas-drawing constants (DESIGN.md §6).
 *
 * `hud.css` owns the DOM side of this palette as custom properties; this file
 * is the same palette in a form the 2D canvas API can use, because the wrist
 * tracker's scope, the noise ring and every in-world puzzle panel are drawn
 * with `CanvasRenderingContext2D` and cannot read CSS variables cheaply.
 *
 * Keep the two in sync by eye — they are twenty values and they never change
 * once the look is right.
 */

export const UI_COLORS = Object.freeze({
  /** Near-black backdrop. */
  black: '#040605',
  /** Panel/scope interior — a shade off black so the bezel reads. */
  screen: '#020504',
  /** Phosphor green: the readable, safe, nominal colour. */
  green: '#4dff9b',
  greenMid: '#2fbf72',
  greenDim: '#1c6b41',
  /** Amber: caution, "you may act", loud. */
  amber: '#ffb03a',
  amberDim: '#8a5c1c',
  /** Red: alarm, dead, very loud. */
  red: '#ff4a3d',
  redDim: '#7a231c',
  /** Body text and dim labels. */
  text: '#9fe8c4',
  textDim: '#5c8f76',
  /** Hairlines and grids. */
  line: 'rgba(77, 255, 155, 0.22)',
  lineFaint: 'rgba(77, 255, 155, 0.10)',
} as const);

/** The one font stack the whole UI uses, in canvas `font` shorthand form. */
export const UI_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/**
 * Build a canvas `font` string in the house style.
 *
 * MEMOISED. Every canvas draw in the HUD and on every §6 panel sets `ctx.font`,
 * and the shorthand is a template literal — one string per call, several calls
 * per panel per redraw, sixty times a second on the tracker. There are only a
 * couple of dozen distinct (size, weight) pairs in the whole UI, and the string
 * for each is identical every time, so the cache never grows and the result is
 * character for character what the template produced.
 */
const FONT_CACHE = new Map<number, string>();
export function uiFont(sizePx: number, weight: 'normal' | 'bold' = 'normal'): string {
  // Key both fields in one number: sizes are small and non-negative.
  const key = weight === 'bold' ? sizePx * 2 + 1 : sizePx * 2;
  const cached = FONT_CACHE.get(key);
  if (cached !== undefined) return cached;
  const font = `${weight} ${sizePx}px ${UI_FONT}`;
  // A caller feeding a continuously varying size would otherwise grow this
  // forever. Nothing in the UI does, but the cache must not be able to leak.
  if (FONT_CACHE.size < 256) FONT_CACHE.set(key, font);
  return font;
}

/**
 * The three loudness bands the player learns by ear: quiet below a handrail
 * knock, loud up to a hatch cycle, alarm above it.
 *
 * ONE definition of the two thresholds. The noise ring, the panels and the §6
 * interact prompt all colour by loudness, and the interact prompt does it in
 * CSS rather than on a canvas — so it needs the band as a class name, not as a
 * hex string, and the two must not be able to disagree about where amber
 * starts.
 */
export type LoudnessBand = 'quiet' | 'loud' | 'alarm';

export function loudnessBand(loudness: number): LoudnessBand {
  if (loudness < 15) return 'quiet';
  if (loudness < 45) return 'loud';
  return 'alarm';
}

/**
 * Loudness → colour. Used by the noise ring (§6) and by panels that want to
 * show "how loud is this action".
 */
export function loudnessColor(loudness: number): string {
  switch (loudnessBand(loudness)) {
    case 'quiet':
      return UI_COLORS.green;
    case 'loud':
      return UI_COLORS.amber;
    case 'alarm':
      return UI_COLORS.red;
  }
}

/** Same bands, as an rgba string with explicit alpha (canvas strokes fade). */
export function loudnessRgba(loudness: number, alpha: number): string {
  const band = loudnessBand(loudness);
  const [r, g, b] =
    band === 'quiet' ? [77, 255, 155] : band === 'loud' ? [255, 176, 58] : [255, 74, 61];
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

/** Clamp helper local to the UI so nothing here needs a runtime import cycle. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear interpolation. */
export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
