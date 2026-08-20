/**
 * ISS — transient status lines.
 *
 * §6 says four HUD elements and means it, so this is deliberately not a fifth:
 * no icon, no panel, no permanent chrome. It is a one-line teletype above the
 * tracker that exists because `GameEvents` defines `ui:toast` and something has
 * to consume it — connection state, "medkit taken", "seal charge spent".
 *
 * Keep it for facts the world cannot show you. Anything the world CAN show you
 * belongs in the world.
 */

import { bus as sharedBus, type EventBus, type GameEvents, type Unsubscribe } from '../core/eventBus';
import { el } from './dom';

const DEFAULT_MS = 2600;
const MAX_VISIBLE = 3;

export interface ToastLayerOptions {
  parent: HTMLElement;
  /** Bus to read `ui:toast` from. `null` to drive it manually. */
  bus?: EventBus<GameEvents> | null;
}

interface LiveToast {
  node: HTMLElement;
  expires: number;
}

export class ToastLayer {
  readonly root: HTMLDivElement;

  private readonly items: LiveToast[] = [];
  private readonly unsubscribe: Unsubscribe | null;
  private elapsed = 0;

  constructor(opts: ToastLayerOptions) {
    this.root = el('div', { class: 'iss-toasts' });
    opts.parent.appendChild(this.root);

    const bus = opts.bus === undefined ? sharedBus : opts.bus;
    this.unsubscribe = bus ? bus.on('ui:toast', ({ text, ms }) => this.push(text, ms)) : null;
  }

  push(text: string, ms: number = DEFAULT_MS): void {
    const node = el('div', { class: 'iss-toast', text });
    this.root.appendChild(node);
    this.items.push({ node, expires: this.elapsed + Math.max(0.2, ms / 1000) });
    while (this.items.length > MAX_VISIBLE) {
      const oldest = this.items.shift();
      oldest?.node.remove();
    }
  }

  /** Expire old lines. Call once per frame with the frame delta in seconds. */
  update(dt: number): void {
    if (this.items.length === 0) return;
    this.elapsed += dt;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (this.elapsed >= item.expires) {
        item.node.remove();
        this.items.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const item of this.items) item.node.remove();
    this.items.length = 0;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.clear();
    this.root.remove();
  }
}
