/**
 * ISS-CAR-03 — the fuse. 0.05 ⌀ × 0.11, 120–200 triangles.
 *
 * "Smallest asset in the game — a barrel with bright end caps. Three carried per
 * round; size alone distinguishes it."
 *
 * THE SILHOUETTE IS THE SCALE. Nothing else a player can pick up is 11 cm long,
 * so the fuse needs no distinguishing feature beyond being obviously tiny — and
 * the way you SELL tiny in a dark module with no reference object is to make the
 * proportions unmistakably those of a component rather than a tool: two fat
 * brass caps on a slim dark barrel, the classic cartridge fuse, a shape a player
 * has held in their own hand. At 5 cm across it is also the one carryable that
 * can be missed entirely, which is exactly what the filament accent is for.
 *
 * It RESTS ON ITS SIDE, along +X: a cartridge stood on end in a locker would be
 * a thing balanced by a level designer, and the barrel is what touches the shelf.
 * §11 puzzle 4 has three of them in randomised lockers, so this pose is the one
 * a player sees three times a round.
 */

import type * as THREE from 'three';
import { mergeParts } from '../artKit';
import type { ItemBuild } from './common';
import { HEX, at, stripedRing, tube } from './common';

const SEG = 12;
/** Cap radius — the widest part, so also the resting height of the axis. */
const CAP_R = 0.025;
const CAP_L = 0.024;
const BARREL_R = 0.021;
const BARREL_L = 0.062;
/** Height of the barrel axis above the shelf it lies on. */
export const FUSE_AXIS_Y = CAP_R;
/** Where a thumb and forefinger pinch it. */
export const FUSE_GRIP = Object.freeze({ x: 0, y: FUSE_AXIS_Y, z: 0 });

export function buildFuse(): ItemBuild {
  const parts: THREE.BufferGeometry[] = [];

  // Smoked glass barrel. Dark, so the brass caps are the thing that catches a
  // torch — a 5 cm object has to advertise itself with a specular hit, not an
  // outline.
  parts.push(at(tube(BARREL_R, BARREL_R, BARREL_L, SEG, HEX.glass, { axis: 'x' }), 0, FUSE_AXIS_Y));

  // Contact caps. Full-radius, square-shouldered: the step from 21 to 25 mm is
  // the only silhouette event on the whole asset and it must not be chamfered
  // away.
  for (const sx of [-1, 1]) {
    parts.push(
      at(
        tube(CAP_R, CAP_R, CAP_L, SEG, HEX.brass, { axis: 'x' }),
        (sx * (BARREL_L + CAP_L)) / 2,
        FUSE_AXIS_Y,
      ),
    );
  }

  // The rating band at mid-barrel. One cuff, alternating, so "which fuse" is a
  // pattern rather than a hue nobody can see at 5 candela.
  parts.push(
    at(
      stripedRing(BARREL_R + 0.0012, 0.014, SEG, HEX.yellow, HEX.stencil, 'x'),
      0,
      FUSE_AXIS_Y,
    ),
  );

  return {
    geometry: mergeParts(parts),
    accent: {
      // The filament: a bar accent laid along the barrel, cap to cap. It is 66
      // mm against a 62 mm barrel, so it overhangs onto the brass at each end,
      // which is precisely how a filament is anchored.
      at: { x: 0, y: FUSE_AXIS_Y, z: BARREL_R },
      normal: { x: 0, y: 0, z: 1 },
      shape: 'bar',
    },
  };
}
