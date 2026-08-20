/**
 * ISS — tiny DOM helpers for the UI layer (DESIGN.md §6).
 *
 * No framework. The HUD is four elements and three screens; a builder function
 * and a resize-aware canvas wrapper are the entire abstraction budget.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ElOptions {
  class?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  children?: (Node | null | undefined)[];
}

/** Create an HTML element. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  if (opts.style) Object.assign(node.style, opts.style);
  if (opts.children) for (const child of opts.children) if (child) node.appendChild(child);
  return node;
}

/** Create an SVG element (crosshair glyphs). */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Resolve a mount point: an element, a selector, or a documented fallback id. */
export function resolveMount(
  mount: HTMLElement | string | undefined,
  fallbackId: string,
): HTMLElement {
  if (mount instanceof HTMLElement) return mount;
  if (typeof mount === 'string') {
    const found = document.querySelector(mount);
    if (found instanceof HTMLElement) return found;
    throw new Error(`[ui] mount selector '${mount}' matched nothing`);
  }
  const byId = document.getElementById(fallbackId);
  if (byId) return byId;
  // index.html always ships #app / #hud / #menu, but a test harness might not.
  const created = el('div', { attrs: { id: fallbackId } });
  document.body.appendChild(created);
  return created;
}

/** addEventListener that hands back a disposer, so `dispose()` stays one line. */
export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  handler: (ev: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void;
export function listen(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/**
 * A 2D canvas sized in CSS pixels but backed at device resolution, so the
 * tracker traces and the noise ring stay crisp on a retina panel. Call
 * `sync()` once a frame; it is a no-op unless something actually changed.
 */
export class HiDpiCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Logical (CSS-pixel) size — draw against these, never `canvas.width`. */
  width: number;
  height: number;
  private dpr = 1;

  constructor(cssWidth: number, cssHeight: number, className?: string) {
    this.canvas = el('canvas', { class: className });
    this.width = cssWidth;
    this.height = cssHeight;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('[ui] 2D canvas context unavailable');
    this.ctx = ctx;
    this.sync();
  }

  /** Match the backing store to the current devicePixelRatio. */
  sync(): void {
    const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
    const w = Math.round(this.width * dpr);
    const h = Math.round(this.height * dpr);
    if (this.dpr === dpr && this.canvas.width === w && this.canvas.height === h) return;
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Resize in CSS pixels. */
  resize(cssWidth: number, cssHeight: number): void {
    if (cssWidth === this.width && cssHeight === this.height) return;
    this.width = cssWidth;
    this.height = cssHeight;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.dpr = -1; // force sync()
    this.sync();
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }
}

/** Format milliseconds as M:SS for the results screen. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
