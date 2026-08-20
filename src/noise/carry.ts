/**
 * "How far did that carry?" — the number behind the §6 noise ring.
 *
 * The ring is the tutorial: it expands on every sound you emit, scaled to how
 * far the sound actually travelled, so a player learns the loudness table
 * without reading it. That means the number has to come from the real §3
 * propagation, not from a lookup on the kind.
 */

import { ATTENUATION_PER_M, FLOOR } from '@shared/constants';
import type { Propagation } from '@shared/graph/noise';

export interface CarryReport {
  /** Longest path length (metres) along which the sound stayed above FLOOR. */
  metres: number;
  /** Modules the sound reached above FLOOR, including the one it came from. */
  modules: number;
}

/**
 * Free-field radius: how far a sound of this loudness survives with nothing in
 * the way. `(loudness - FLOOR) / ATTENUATION_PER_M`.
 *
 * A knock (15) → 13 m. A rail pull (4) → 2 m, exactly as the §3 table says.
 */
export function carryRadiusMetres(
  loudness: number,
  floor: number = FLOOR,
  attenuationPerM: number = ATTENUATION_PER_M,
): number {
  return Math.max(0, (loudness - floor) / attenuationPerM);
}

/**
 * The real answer, read off a completed propagation: for every module the sound
 * reached, how far past that module's entry point it can still travel before it
 * drops under the floor. Hatches shorten it; open runs of tube do not.
 */
export function carryReport(
  propagation: Propagation,
  floor: number = FLOOR,
  attenuationPerM: number = ATTENUATION_PER_M,
): CarryReport {
  let metres = 0;
  let modules = 0;
  for (const arrival of propagation.arrivals.values()) {
    modules++;
    const remaining = Math.max(0, (arrival.level - floor) / attenuationPerM);
    const reach = arrival.distance + remaining;
    if (reach > metres) metres = reach;
  }
  if (modules === 0) {
    // No graph, or the event started somewhere the graph does not know about.
    metres = carryRadiusMetres(propagation.event.loudness, floor, attenuationPerM);
    modules = 1;
  }
  return { metres, modules };
}

/**
 * Plain-language description of a carry, for the toast the first time a player
 * does something expensive. Deliberately vague in modules, not metres —
 * "roughly how many modules away can this be heard" is the mental model §3
 * asks us to protect.
 */
export function describeCarry(report: CarryReport): string {
  if (report.metres < 3) return 'barely a whisper';
  if (report.modules <= 1) return 'heard in this module';
  if (report.modules === 2) return 'heard next door';
  if (report.modules <= 4) return `heard ${report.modules} modules out`;
  return 'heard across the station';
}
