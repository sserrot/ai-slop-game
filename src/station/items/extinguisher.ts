/**
 * ISS-CAR-05 — the fire extinguisher. 0.13 ⌀ × 0.42, 500–800 triangles.
 *
 * "Tallest carryable, with an unmistakable horn. Doubles as the zero-G thruster,
 * so the silhouette has to read as something you POINT."
 *
 * THE SILHOUETTE IS THE HORN ON A STICK. Everything about the layout serves one
 * job: the player must look at this thing and know which end the gas comes out
 * of, because §4 spends it as a thruster — `EXTINGUISHER_DELTA_V` of rescue at
 * `LOUDNESS.EXTINGUISHER` = 65, four modules of consequence, and "a panic button
 * with a price" is only fair if the price is legible. So the flare is 36 mm
 * against a 16 mm hose and it sits at the END of a corrugated run that leaves
 * the valve head sideways: an arrow, drawn in three parts.
 *
 * THE HORN POINTS ALONG +X, NOT +Z. Every other carryable faces its accent at
 * the player, and so does this one — the charge gauge is on +Z. If the horn were
 * on +Z too, the held pose would have to choose between showing the player their
 * own gauge and pointing the nozzle away from them. Putting the business end on
 * the side lets the hold swing the nozzle forward while the gauge stays in view
 * at a raking angle, which is also exactly how a person carries one.
 *
 * Hazard yellow, the whole bottle. It is the one carryable that is safety
 * equipment, it is the one a stranded player is hunting for in the dark, and
 * `PALETTE.warning` is a hero colour precisely so it can be found.
 */

import type * as THREE from 'three';
import { boltRing, chamferedBox, labelPlate, mergeParts, ribbedCylinder } from '../artKit';
import type { ItemBuild } from './common';
import { HEX, at, bent, paint, tube } from './common';

const SEG = 14;
const BOTTLE_R = 0.065;
/** Stack, bottom up: boot, base taper, bottle, shoulder, neck. */
const BOOT_H = 0.016;
const TAPER_H = 0.028;
const BOTTLE_H = 0.294;
const SHOULDER_H = 0.035;
const NECK_H = 0.045;

const BOOT_Y = BOOT_H / 2;
const TAPER_Y0 = BOOT_H;
const BOTTLE_Y0 = TAPER_Y0 + TAPER_H;
const SHOULDER_Y0 = BOTTLE_Y0 + BOTTLE_H;
const NECK_Y0 = SHOULDER_Y0 + SHOULDER_H;
const NECK_Y1 = NECK_Y0 + NECK_H;

/** The carry handle above the valve — where the hand closes. */
export const EXTINGUISHER_GRIP = Object.freeze({ x: 0, y: NECK_Y1 - 0.014, z: 0.006 });

export function buildExtinguisher(): ItemBuild {
  const parts: THREE.BufferGeometry[] = [];

  // ── Bottle ──────────────────────────────────────────────────────────────
  parts.push(at(tube(0.058, 0.062, BOOT_H, SEG, HEX.rubber), 0, BOOT_Y));
  parts.push(at(tube(BOTTLE_R, 0.058, TAPER_H, SEG, HEX.yellow), 0, TAPER_Y0 + TAPER_H / 2));
  parts.push(
    at(
      paint(
        ribbedCylinder(BOTTLE_R, BOTTLE_H, {
          ribs: 3,
          ribHeight: 0.005,
          ribWidth: 0.016,
          radialSegments: SEG,
        }),
        HEX.yellow,
      ),
      0,
      BOTTLE_Y0 + BOTTLE_H / 2,
    ),
  );
  parts.push(at(tube(0.042, BOTTLE_R, SHOULDER_H, SEG, HEX.yellow), 0, SHOULDER_Y0 + SHOULDER_H / 2));

  // ── Valve head ──────────────────────────────────────────────────────────
  parts.push(
    at(
      paint(
        ribbedCylinder(0.02, NECK_H, {
          ribs: 1,
          ribHeight: 0.004,
          ribWidth: 0.008,
          radialSegments: 10,
        }),
        HEX.metal,
      ),
      0,
      NECK_Y0 + NECK_H / 2,
    ),
  );
  // Bolt ring on the shoulder: this is a pressure vessel, and a bolted collar is
  // how a player knows it at a glance without reading anything.
  parts.push(
    at(
      paint(
        boltRing(0.03, 5, { boltRadius: 0.006, height: 0.005, segments: 4, axis: 'y' }),
        HEX.steel,
      ),
      0,
      SHOULDER_Y0 + SHOULDER_H - 0.002,
    ),
  );

  // Fixed carry handle and, under it, the squeeze lever. Two bars, not one:
  // "something you point" needs a visible trigger.
  parts.push(
    at(
      paint(chamferedBox({ x: 0.016, y: 0.014, z: 0.078 }, 0.004, { axis: 'z' }), HEX.rubber),
      EXTINGUISHER_GRIP.x,
      EXTINGUISHER_GRIP.y,
      EXTINGUISHER_GRIP.z,
    ),
  );
  parts.push(
    at(
      paint(chamferedBox({ x: 0.014, y: 0.012, z: 0.07 }, 0.004, { axis: 'z' }), HEX.steel),
      0,
      NECK_Y1 - 0.032,
      0.004,
    ),
  );

  // ── Hose and horn — the arrow ───────────────────────────────────────────
  // A corrugated stub out of the valve, angled DOWN and out, flaring into the
  // horn at its end. Ribbed on purpose: a smooth tube reads as pipework, a
  // corrugated one reads as something flexible you aim.
  //
  // Down rather than up, for two reasons that both come from the numbers. Up
  // would put the flare at y = 0.48 and blow the bible's 0.42 envelope by an
  // eighth; and down is where a person aims one, so the stowed pose already
  // shows the player the vector. The held pose yaws it forward from here.
  const AIM = -0.45;
  const ax = Math.cos(AIM);
  const ay = Math.sin(AIM);
  const stubL = 0.045;
  const stubR = 0.022;
  const jointY = NECK_Y0 + NECK_H * 0.45;
  parts.push(
    bent(
      paint(
        ribbedCylinder(0.009, stubL, {
          ribs: 3,
          ribHeight: 0.003,
          ribWidth: 0.007,
          radialSegments: 8,
          axis: 'x',
        }),
        HEX.hose,
      ),
      AIM,
      stubR + ax * (stubL / 2),
      jointY + ay * (stubL / 2),
    ),
  );
  parts.push(
    bent(
      tube(0.036, 0.014, 0.062, 12, HEX.rubber, { open: true, axis: 'x' }),
      AIM,
      stubR + ax * (stubL + 0.031),
      jointY + ay * (stubL + 0.031),
    ),
  );

  // ── Instruments and markings ────────────────────────────────────────────
  // The charge gauge can. The accent is its needle-lit dial, so the can has to
  // exist as geometry for the lamp to sit in.
  const gaugeY = NECK_Y0 + NECK_H * 0.42;
  parts.push(at(tube(0.016, 0.016, 0.008, 10, HEX.dark, { axis: 'z' }), 0, gaugeY, 0.021));

  // Two bars: the instruction plate every bottle on every spacecraft carries.
  parts.push(
    at(
      labelPlate(0.058, 0.044, { bars: 2, depth: 0.002, barDepth: 0.0012 }),
      0,
      BOTTLE_Y0 + BOTTLE_H * 0.62,
      BOTTLE_R - 0.004,
    ),
  );

  return {
    geometry: mergeParts(parts),
    accent: {
      // On the face of the gauge can, so "how much is left" and "you can use
      // this" are the same lamp. A bulb, because a gauge gets approached from
      // any side and a flat quad would vanish at a raking angle.
      at: { x: 0, y: gaugeY, z: 0.025 },
      normal: { x: 0, y: 0, z: 1 },
      shape: 'bulb',
    },
  };
}
