/**
 * ISS-CAR-02 — the decoy. 0.14 ⌀ × 0.20, 300–450 triangles.
 *
 * "Squat, hazard-banded, with a pull ring on top. Must never be confused with
 * the medkit — you have two per round and throwing the wrong thing is fatal."
 *
 * THE SILHOUETTE IS THE RING AND THE WAIST. Round where the medkit is
 * rectangular, tall-narrow where the medkit is wide-flat, and topped by a pull
 * ring standing clear of the body where the medkit is topped by a grab handle
 * spanning it. The two side lugs are what keep the profile from reading as a
 * bottle or a fuse when the ring is hidden behind the body: from any yaw at
 * least one lug breaks the cylinder's outline, so the thing always looks like
 * ordnance you would hold in a fist rather than luggage you would carry.
 *
 * §5: two per round, no respawn, loudness 70 on impact. That is five modules of
 * consequence for a mistaken grab, which is why the hazard cuffs alternate light
 * and dark segments instead of being painted yellow — the pattern survives the
 * torch washing every trace of hue out of it, and it survives colour blindness.
 */

import * as THREE from 'three';
import { box, chamferedBox, mergeParts } from '../artKit';
import type { ItemBuild } from './common';
import { HEX, at, paint, stripedRing, tube } from './common';

const SEG = 12;
const BODY_R = 0.064;
/**
 * Skirt 0…0.010, body 0.010…0.140, collar 0.140…0.158, pull ring topping out at
 * 0.202 — the bible's 0.20 including the ring, which is the point: the ring is
 * part of the silhouette, not an accessory above it.
 */
const SKIRT_H = 0.01;
const BODY_H = 0.13;
const BODY_Y0 = SKIRT_H;
const COLLAR_Y0 = BODY_Y0 + BODY_H;
const COLLAR_H = 0.018;
/** Centre of the body — where a fist closes on it. */
export const DECOY_GRIP = Object.freeze({ x: 0, y: BODY_Y0 + BODY_H * 0.5, z: 0 });

export function buildDecoy(): ItemBuild {
  const parts: THREE.BufferGeometry[] = [];

  // ── Body ────────────────────────────────────────────────────────────────
  // Flared rubber skirt so it stands on a deck and does not roll.
  parts.push(at(tube(BODY_R + 0.002, BODY_R + 0.006, SKIRT_H, SEG, HEX.rubber), 0, SKIRT_H / 2));
  parts.push(at(tube(BODY_R, BODY_R, BODY_H, SEG, HEX.dark), 0, BODY_Y0 + BODY_H / 2));

  // Two turned rings on the barrel. They are structure, not decoration: the
  // moving torch highlight breaks on them, so the object registers as you sweep
  // past instead of sitting there as a grey tube.
  for (const y of [BODY_Y0 + BODY_H * 0.26, BODY_Y0 + BODY_H * 0.74]) {
    parts.push(at(tube(BODY_R + 0.005, BODY_R + 0.005, 0.014, SEG, HEX.paint, { open: true }), 0, y));
  }

  // ── Hazard cuffs ────────────────────────────────────────────────────────
  for (const y of [BODY_Y0 + BODY_H * 0.16, BODY_Y0 + BODY_H * 0.86]) {
    parts.push(
      at(stripedRing(BODY_R + 0.0015, 0.02, SEG, HEX.yellow, HEX.stencil), 0, y),
    );
  }

  // ── Head ────────────────────────────────────────────────────────────────
  parts.push(at(tube(0.05, BODY_R - 0.006, COLLAR_H, SEG, HEX.metal), 0, COLLAR_Y0 + COLLAR_H / 2));

  // The pull ring, standing in the vertical plane so it is a RING in profile
  // rather than a disc seen edge-on. 8 sides around and 4 across the tube: at
  // 32 mm across, that is exactly as round as the torch can resolve.
  const shackleTop = COLLAR_Y0 + COLLAR_H + 0.008;
  parts.push(at(paint(box({ x: 0.009, y: 0.016, z: 0.009 }), HEX.metal), 0, shackleTop - 0.004));
  parts.push(
    at(
      paint(new THREE.TorusGeometry(0.016, 0.004, 4, 8), HEX.brass),
      0,
      shackleTop + 0.016,
    ),
  );

  // ── Throwing lugs ───────────────────────────────────────────────────────
  // Sized so the widest point of the whole asset is 0.140 — the bible's ⌀.
  for (const sx of [-1, 1]) {
    parts.push(
      at(
        paint(chamferedBox({ x: 0.014, y: 0.052, z: 0.03 }, 0.004, { axis: 'y' }), HEX.paint),
        sx * 0.063,
        BODY_Y0 + BODY_H * 0.5,
      ),
    );
  }

  return {
    geometry: mergeParts(parts),
    accent: {
      // The arming light, on the collar. High on the body and clear of the
      // fist, so it is still visible in the hand of the player about to throw.
      at: { x: 0, y: COLLAR_Y0 + COLLAR_H * 0.5, z: 0.053 },
      normal: { x: 0, y: 0, z: 1 },
      shape: 'dot',
    },
  };
}
