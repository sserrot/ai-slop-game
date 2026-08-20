/**
 * ISS — crosshair (DESIGN.md §6, §4).
 *
 * Four states, and only four:
 *   dot    — nothing in reach
 *   hand   — an interactable is under the reticle
 *   rail   — a grabbable handrail is under the reticle
 *   charge — the push-off arc, "the only non-diegetic HUD element", and §4 is
 *            explicit that it belongs on the crosshair rather than in a corner.
 *
 * The arc is drawn on top of whichever base state is active, because you charge
 * *while gripping a rail*: the rail glyph must not vanish the moment you hold
 * Space.
 */

import { bus as sharedBus, type EventBus, type GameEvents, type Unsubscribe } from '../core/eventBus';
import { svgEl } from './dom';
import { clamp01 } from './theme';

/** The base reticle states. The charge arc is an overlay on top of these. */
export type CrosshairState = 'dot' | 'hand' | 'rail';

export interface CrosshairOptions {
  /** Where to attach. Defaults to the HUD root the caller passes in. */
  parent: HTMLElement;
  /** Bus to read `player:charge` from. Pass `null` to drive charge manually. */
  bus?: EventBus<GameEvents> | null;
}

const ARC_RADIUS = 17;
const ARC_CIRCUMFERENCE = 2 * Math.PI * ARC_RADIUS;

export class Crosshair {
  readonly root: SVGSVGElement;

  private readonly arc: SVGCircleElement;
  private readonly unsubscribe: Unsubscribe | null;
  private _state: CrosshairState = 'dot';
  private _charge = 0;
  private _visible = true;

  constructor(opts: CrosshairOptions) {
    const svg = svgEl('svg', {
      class: 'iss-crosshair',
      viewBox: '0 0 56 56',
      width: '56',
      height: '56',
      'aria-hidden': 'true',
    });
    svg.dataset.state = 'dot';
    svg.dataset.charging = 'false';
    svg.dataset.chargeLevel = 'low';
    svg.dataset.visible = 'true';

    // --- dot: the resting state. A pixel of phosphor, nothing more. --------
    const dotGroup = svgEl('g', { class: 'ch-group ch-dot-group' });
    dotGroup.appendChild(svgEl('circle', { class: 'ch-dot', cx: '28', cy: '28', r: '1.6' }));
    dotGroup.appendChild(
      svgEl('circle', {
        class: 'ch-stroke',
        cx: '28',
        cy: '28',
        r: '6',
        'stroke-opacity': '0.35',
      }),
    );

    // --- hand: an interactable. Four inward ticks closing on the target. ---
    const handGroup = svgEl('g', { class: 'ch-group ch-hand-group' });
    handGroup.appendChild(svgEl('circle', { class: 'ch-dot', cx: '28', cy: '28', r: '1.6' }));
    for (const d of [
      'M 28 15 L 28 20',
      'M 28 36 L 28 41',
      'M 15 28 L 20 28',
      'M 36 28 L 41 28',
    ]) {
      handGroup.appendChild(svgEl('path', { class: 'ch-stroke', d }));
    }
    handGroup.appendChild(
      svgEl('circle', { class: 'ch-stroke', cx: '28', cy: '28', r: '9', 'stroke-opacity': '0.7' }),
    );

    // --- rail: a grabbable handrail. Two bars and a clasp between them. ----
    const railGroup = svgEl('g', { class: 'ch-group ch-rail-group' });
    railGroup.appendChild(svgEl('path', { class: 'ch-stroke', d: 'M 13 22 L 43 22' }));
    railGroup.appendChild(svgEl('path', { class: 'ch-stroke', d: 'M 13 34 L 43 34' }));
    railGroup.appendChild(
      svgEl('path', { class: 'ch-stroke', d: 'M 22 22 L 22 34 M 34 22 L 34 34' }),
    );
    railGroup.appendChild(svgEl('circle', { class: 'ch-dot', cx: '28', cy: '28', r: '1.6' }));

    // --- charge arc: 0→1 over CHARGE_TIME, drawn clockwise from the top. ---
    const arcGroup = svgEl('g', { class: 'ch-arc-group' });
    arcGroup.appendChild(
      svgEl('circle', {
        class: 'ch-arc-track',
        cx: '28',
        cy: '28',
        r: String(ARC_RADIUS),
      }),
    );
    const arc = svgEl('circle', {
      class: 'ch-arc',
      cx: '28',
      cy: '28',
      r: String(ARC_RADIUS),
      transform: 'rotate(-90 28 28)',
      'stroke-dasharray': String(ARC_CIRCUMFERENCE),
      'stroke-dashoffset': String(ARC_CIRCUMFERENCE),
    });
    arcGroup.appendChild(arc);

    svg.appendChild(dotGroup);
    svg.appendChild(handGroup);
    svg.appendChild(railGroup);
    svg.appendChild(arcGroup);
    opts.parent.appendChild(svg);

    this.root = svg;
    this.arc = arc;

    const bus = opts.bus === undefined ? sharedBus : opts.bus;
    this.unsubscribe = bus
      ? bus.on('player:charge', ({ charge }) => this.setCharge(charge))
      : null;
  }

  get state(): CrosshairState {
    return this._state;
  }

  /** Set the base reticle. Cheap enough to call every frame from the raycaster. */
  setState(state: CrosshairState): void {
    if (state === this._state) return;
    this._state = state;
    this.root.dataset.state = state;
  }

  get charge(): number {
    return this._charge;
  }

  /**
   * Push-off charge, 0–1. Anything above 0 shows the arc; exactly 0 hides it.
   * The colour crosses to amber past half and red at full, so a player learns
   * "how hard am I about to throw myself" without a number.
   */
  setCharge(charge: number): void {
    const c = clamp01(charge);
    if (c === this._charge) return;
    this._charge = c;
    this.arc.setAttribute('stroke-dashoffset', String(ARC_CIRCUMFERENCE * (1 - c)));
    this.root.dataset.charging = c > 0 ? 'true' : 'false';
    this.root.dataset.chargeLevel = c >= 0.99 ? 'full' : c >= 0.5 ? 'high' : 'low';
  }

  get visible(): boolean {
    return this._visible;
  }

  /** Hide the reticle for menus, cutscenes and the results screen. */
  setVisible(visible: boolean): void {
    if (visible === this._visible) return;
    this._visible = visible;
    this.root.dataset.visible = visible ? 'true' : 'false';
  }

  dispose(): void {
    this.unsubscribe?.();
    this.root.remove();
  }
}
