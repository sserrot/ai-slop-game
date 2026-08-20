/**
 * Fire extinguisher — DESIGN.md §4.
 *
 * "Limited-charge thruster for when you're stranded mid-module with no rail in
 * reach. Loud (65). A panic button with a price."
 *
 * Discrete bursts, not a continuous throttle: the HUD can show three pips, the
 * player can ration them, and every burst is exactly one loudness-65 NoiseEvent
 * (LOUDNESS.EXTINGUISHER, §14) instead of a smeared stream of them. Total speed
 * after a burst is clamped to PUSH_MAX so the extinguisher is a rescue and never
 * a better push-off — §14 check 5b depends on nothing exceeding PUSH_MAX.
 */

import { EXTINGUISHER_CHARGES, EXTINGUISHER_DELTA_V } from './tuning';

export class Extinguisher {
  private _charges: number;

  constructor(charges: number = EXTINGUISHER_CHARGES) {
    this._charges = Math.max(0, Math.floor(charges));
  }

  /** Bursts left. Draw this as pips (§6 keeps the HUD diegetic). */
  get charges(): number {
    return this._charges;
  }

  get empty(): boolean {
    return this._charges <= 0;
  }

  /** m/s of delta-v one burst provides. */
  get deltaV(): number {
    return EXTINGUISHER_DELTA_V;
  }

  /** Spend a burst. False when the bottle is dry. */
  fire(): boolean {
    if (this._charges <= 0) return false;
    this._charges -= 1;
    return true;
  }

  /** Pick up a fresh bottle (lockers, §5/§10 stock the round's consumables). */
  refill(charges: number = EXTINGUISHER_CHARGES): void {
    this._charges = Math.max(0, Math.floor(charges));
  }
}
