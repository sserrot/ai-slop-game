/**
 * ISS-CAR-06 — the pry bar. 0.68 long, 200–320 triangles.
 *
 * "The only long thin item — lean on that. A split claw at one end, an amber
 * grip at the other. Loudest hand tool in the game."
 *
 * THE SILHOUETTE IS THE ASPECT RATIO. 0.68 m against a 24 mm shaft is 28:1, and
 * nothing else in the game — carryable, prop or fixture — is remotely that
 * proportion, so the pry bar is identified before any of its features resolve.
 * The features are there for the near view: a knurled grip at one end, a
 * flat blade bent up at 24° at the other, and the blade SPLIT into two prongs.
 *
 * The split is the one detail worth its triangles. §11 uses this to force jammed
 * lockers and doors at `LOUDNESS.PRY_BAR` = 60 — four modules, the loudest thing
 * a player can choose to do with their hands — and a forked claw is the universal
 * shorthand for a tool you lever with. A plain wedge would read as a chisel, and
 * a chisel is not a thing you would try on a door.
 *
 * It RESTS ALONG +X on the knurl and the claw bend, shaft floating 2 mm clear,
 * which is what a bar dropped on a deck actually does.
 */

import type * as THREE from 'three';
import { box, chamferedBox, mergeParts, ribbedCylinder } from '../artKit';
import type { ItemBuild } from './common';
import { HEX, at, bent, paint } from './common';

/** Knurl outer radius — the fattest point, so also the axis height. */
const AXIS_Y = 0.012;
const GRIP_R = 0.0095;
const GRIP_L = 0.11;
/**
 * Bar stock, along X. Half-height 0.010, so it floats 2 mm off the deck.
 *
 * 0.436 is not a taste number: it is what is left of the bible's 0.68 once the
 * butt cap, the 0.11 knurl, the taper and the claw's 0.089 of reach at 24° have
 * taken their share. Change any of those and this one has to move with it.
 */
const SHAFT = Object.freeze({ x: 0.436, y: 0.02, z: 0.018 });
/** Rise of the claw, in radians off the shaft. */
const CLAW_ANGLE = 0.42;

const BUTT_X = -0.317;
const GRIP_X0 = BUTT_X + 0.012;
const SHAFT_X0 = GRIP_X0 + GRIP_L - 0.005;
const TAPER_X0 = SHAFT_X0 + SHAFT.x;
const TAPER_L = 0.042;
const BLADE_X0 = TAPER_X0 + TAPER_L - 0.004;
const BLADE_L = 0.06;

/** Middle of the knurled grip — where a fist closes. */
export const PRY_BAR_GRIP = Object.freeze({ x: GRIP_X0 + GRIP_L / 2, y: AXIS_Y, z: 0 });

export function buildPryBar(): ItemBuild {
  const parts: THREE.BufferGeometry[] = [];

  // ── Grip end ────────────────────────────────────────────────────────────
  // Four knurl ribs. They are also the feet: the ribs are what touches a deck,
  // which is why the axis sits at the rib radius and not the barrel radius.
  parts.push(
    at(
      paint(
        ribbedCylinder(GRIP_R, GRIP_L, {
          ribs: 4,
          ribHeight: 0.0025,
          ribWidth: 0.01,
          radialSegments: 8,
          axis: 'x',
        }),
        HEX.rubber,
      ),
      PRY_BAR_GRIP.x,
      AXIS_Y,
    ),
  );
  parts.push(at(paint(box({ x: 0.012, y: 0.022, z: 0.022 }), HEX.brass), BUTT_X + 0.006, AXIS_Y));

  // ── Shaft ───────────────────────────────────────────────────────────────
  // Octagonal, not round: a chamfered box gives the bar eight faces, so a torch
  // sweeping past it produces a moving highlight instead of one dead grey line.
  parts.push(
    at(
      paint(chamferedBox(SHAFT, 0.005, { axis: 'x' }), HEX.steel),
      SHAFT_X0 + SHAFT.x / 2,
      AXIS_Y,
    ),
  );
  parts.push(
    at(
      paint(chamferedBox({ x: TAPER_L, y: 0.017, z: 0.016 }, 0.004, { axis: 'x' }), HEX.steel),
      TAPER_X0 + TAPER_L / 2,
      AXIS_Y,
    ),
  );

  // ── The claw ────────────────────────────────────────────────────────────
  const cx = Math.cos(CLAW_ANGLE);
  const cy = Math.sin(CLAW_ANGLE);
  parts.push(
    bent(
      paint(chamferedBox({ x: BLADE_L, y: 0.016, z: 0.014 }, 0.004, { axis: 'x' }), HEX.metal),
      CLAW_ANGLE,
      BLADE_X0 + cx * (BLADE_L / 2),
      AXIS_Y + cy * (BLADE_L / 2),
    ),
  );
  // Two prongs with a 3 mm gap: the split. Small, but it is the difference
  // between "chisel" and "thing you lever a door with".
  for (const sz of [-1, 1]) {
    parts.push(
      bent(
        paint(box({ x: 0.03, y: 0.007, z: 0.0055 }), HEX.metal),
        CLAW_ANGLE,
        BLADE_X0 + cx * (BLADE_L + 0.014),
        AXIS_Y + cy * (BLADE_L + 0.014),
        sz * 0.0045,
      ),
    );
  }

  return {
    geometry: mergeParts(parts),
    accent: {
      // The grip band, on the near face of the knurl. It marks the end you HOLD,
      // which on a 0.68 m tool with two very different ends is a real piece of
      // information — and it is the end a hand is already reaching for, so the
      // lamp is never buried in a shelf.
      at: { x: PRY_BAR_GRIP.x, y: AXIS_Y, z: GRIP_R + 0.0025 },
      normal: { x: 0, y: 0, z: 1 },
      shape: 'bar',
    },
  };
}
