/**
 * ISS-CAR-01 — the medkit. 0.30 × 0.22 × 0.12, 400–600 triangles.
 *
 * "Only asset with a carry handle above its body — reads as luggage at any
 * angle. Carried to a downed friend, so it must read while held."
 *
 * THE SILHOUETTE IS THE HANDLE. Nothing else in the game — carryable, prop or
 * fixture — has a rigid grab handle standing clear above a body, so the medkit
 * is identifiable from a torch glance at any yaw, including from behind, which
 * is the case that matters: the decoy is a squat canister and the two must never
 * be confused (§10 revival vs §5 loudness 70 — picking the wrong one is a
 * death). Handle above a wide soft-cornered case reads as luggage; a banded can
 * with a ring on top reads as ordnance. There is no angle where those two
 * outlines are the same shape.
 *
 * The webbing loop under the handle is doing more work than it looks: it is the
 * only piece of fabric on any carryable, it sags, and a sagging strap is the one
 * cue in this palette that says a person stowed this here.
 */

import type * as THREE from 'three';
import {
  box,
  chamferedBox,
  hinge,
  labelPlate,
  latch,
  mergeParts,
  rubberFoot,
  webbingStrap,
} from '../artKit';
import type { ItemBuild } from './common';
import { HEX, at, paint } from './common';

/** Case body, excluding the handle. */
const CASE = Object.freeze({ x: 0.3, y: 0.155, z: 0.12 });
/** Bumper height — how far the case floats off the deck. */
const BUMPER_H = 0.009;
/** Top of the case. */
const LID_Y = BUMPER_H + CASE.y;
/** Centre of the grab handle's grip bar: the point a hand closes on. */
export const MEDKIT_GRIP = Object.freeze({ x: 0, y: 0.212, z: 0 });

export function buildMedkit(): ItemBuild {
  const parts: THREE.BufferGeometry[] = [];

  // ── The case ────────────────────────────────────────────────────────────
  // capChamfer lozenges the two ends as well as the four long edges, so the
  // profile is soft in every view rather than only in plan. The bounding box is
  // still exactly CASE, which is what a locker shelf was sized against.
  parts.push(
    at(
      paint(
        chamferedBox(CASE, 0.016, { axis: 'x', capChamfer: 0.01 }),
        HEX.shell,
      ),
      0,
      BUMPER_H + CASE.y / 2,
    ),
  );

  // The clamshell split. A 6 mm dark band all the way round is what makes a
  // pale box read as a case that OPENS, at any distance the torch reaches.
  parts.push(
    at(paint(box({ x: 0.302, y: 0.006, z: 0.122 }), HEX.dark), 0, BUMPER_H + CASE.y * 0.62),
  );

  // Hinge down the back of the split, latch on the front. Two ends of the same
  // sentence; the latch is also the only thing on the case you would grab if the
  // handle were folded.
  //
  // Both are kept SHALLOW on purpose. The bible's depth for this asset is 0.12
  // and the case is exactly that; a 16 mm latch throw and a hinge standing off
  // the back took the envelope to 0.146, which is a fifth over for two features
  // nobody reads at more than a metre. A 10 mm throw still catches the torch and
  // brings the whole asset to 0.131.
  parts.push(
    at(
      paint(hinge(0.2, { axis: 'x', radius: 0.007, knuckles: 3 }), HEX.metal),
      0,
      BUMPER_H + CASE.y * 0.62,
      -CASE.z / 2 + 0.007,
    ),
  );
  parts.push(
    at(
      paint(latch({ x: 0.048, y: 0.028, z: 0.01 }, { lift: 0.01 }), HEX.steel),
      -0.075,
      BUMPER_H + CASE.y * 0.62,
      CASE.z / 2 - 0.01,
    ),
  );

  // ── The handle: the whole silhouette ────────────────────────────────────
  for (const sx of [-1, 1]) {
    parts.push(
      at(paint(box({ x: 0.014, y: 0.05, z: 0.02 }), HEX.metal), sx * 0.058, LID_Y + 0.023),
    );
  }
  parts.push(
    at(
      paint(chamferedBox({ x: 0.13, y: 0.016, z: 0.022 }, 0.005, { axis: 'x' }), HEX.rubber),
      MEDKIT_GRIP.x,
      MEDKIT_GRIP.y,
      MEDKIT_GRIP.z,
    ),
  );

  // The tether loop, slung between the handle posts and drooping onto the lid.
  parts.push(
    at(
      paint(webbingStrap(0.115, 0.038, { sag: 0.026, segments: 4 }), HEX.webbing),
      0,
      MEDKIT_GRIP.y - 0.012,
      0.026,
    ),
  );

  // ── Markings ────────────────────────────────────────────────────────────
  // The cross is geometry, not a texture and not a second lamp: a vertical and a
  // horizontal bar in hazard yellow. The one accent sits beside it (below), so
  // with the torch off you see a single amber dot, and with the torch on you see
  // a medical cross. Two readings, one lamp.
  const crossY = BUMPER_H + CASE.y * 0.34;
  parts.push(
    at(paint(box({ x: 0.014, y: 0.062, z: 0.004 }), HEX.yellow), -0.04, crossY, CASE.z / 2 - 0.002),
  );
  parts.push(
    at(paint(box({ x: 0.062, y: 0.014, z: 0.004 }), HEX.yellow), -0.04, crossY, CASE.z / 2 - 0.002),
  );

  // One bar = the crew's medical stow. Bar count is the station's language-free
  // label (artKit.labelPlate) and this is the one carryable that gets one.
  parts.push(
    at(
      labelPlate(0.048, 0.034, { bars: 1, depth: 0.003, barDepth: 0.0015 }),
      0.098,
      crossY,
      CASE.z / 2 - 0.001,
    ),
  );

  // ── Feet ────────────────────────────────────────────────────────────────
  // Four bumpers, so the flashlight's one shadow map draws a line under the case
  // and the player can tell which side of a coaming it is on.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(
        at(
          paint(rubberFoot(0.013, BUMPER_H, { segments: 8 }), HEX.rubber),
          sx * 0.115,
          0,
          sz * 0.04,
        ),
      );
    }
  }

  return {
    geometry: mergeParts(parts),
    accent: {
      // Low and to the right of the cross, on the face — the corner a hand does
      // not cover when the case is carried by the handle.
      at: { x: 0.036, y: BUMPER_H + CASE.y * 0.22, z: CASE.z / 2 },
      normal: { x: 0, y: 0, z: 1 },
      shape: 'dot',
    },
  };
}
