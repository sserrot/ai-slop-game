/**
 * ISS-CAR-04 — the sequence card. 0.14 × 0.09 × 0.002, 40–80 triangles.
 *
 * "The only flat asset. Punched corner and clipped edge read as paperwork. Its
 * face must accept a canvas texture later without redesign — it is read, not
 * just held."
 *
 * THE SILHOUETTE IS FLATNESS PLUS ASYMMETRY. Two millimetres thick is a shape no
 * other carryable comes near, so at any angle except perfectly edge-on the card
 * is instantly not-a-tool. Edge-on it would vanish, which is why the outline is
 * asymmetric: one corner clipped at 45°, one corner punched with an aluminium
 * grommet. Those two features tell a player which way up the card is BEFORE they
 * can read anything on it, and they are the reason this asset is a hand-authored
 * outline rather than a `chamferedBox` (which clips all four corners
 * symmetrically and reads as a rounded tile).
 *
 * §11 puzzle 1: the breaker order is on this card, stowed in a locker in another
 * module, somewhere different each round. A player finds it, reads it, and says
 * it out loud on voice comms. So the face is a UV'd flat quad spanning 0…1 —
 * `SEQUENCE_CARD_FACE` names the plane and the extents — and a `CanvasTexture`
 * can be dropped on it later with nothing about this file changing. There are no
 * fonts and never will be; until then the three raised order bars say "this
 * carries a printed sequence" the way every other label in the station does.
 */

import type * as THREE from 'three';
import { box, mergeParts } from '../artKit';
import type { ItemBuild } from './common';
import { HEX, at, flatPolyPrism, paint, tube } from './common';

const W = 0.14;
const H = 0.09;
const T = 0.002;
/** Corner clip, on the top-right of the face. */
const CLIP = 0.018;
/** Bars stand this far proud of the face — under a millimetre, so a texture
 *  mapped onto the face still reads flat around them. */
const BAR_PROUD = 0.0008;
/** Grommet eyelet: it stands proud of BOTH faces, which is what an eyelet does. */
const GROMMET_H = T + 0.0035;
/**
 * The card rests on the grommet's lower rim, not on its own underside — so the
 * lift is half the eyelet, not half the card. Get this wrong and the card sinks
 * 1.7 mm into the deck, which on a 2 mm object is most of it.
 */
const REST_LIFT = GROMMET_H / 2;

/**
 * The clean, UV'd face of the card, in the canonical (resting) frame.
 *
 * The card lies flat, so the face points +Y. `y` is the plane a texture would
 * sit on; `width`/`height` are the extents its 0…1 UVs span, in metres, in X
 * and Z. Nothing else in the game needs this — §11 puzzle 1 does.
 */
export const SEQUENCE_CARD_FACE = Object.freeze({
  y: REST_LIFT + T / 2,
  width: W,
  height: H,
  /** Local axis the 0…1 U runs along, and the axis V runs along. */
  u: 'x' as const,
  v: 'z' as const,
});

/** Where a thumb pinches the card: the bottom-left of the face. */
export const CARD_GRIP = Object.freeze({ x: -0.05, y: REST_LIFT, z: 0.03 });

export function buildSequenceCard(): ItemBuild {
  const parts: THREE.BufferGeometry[] = [];

  // Outline, counter-clockwise seen from the face, in the XY plane. Built there
  // and laid flat at the end, because that is the plane every flat helper in
  // artKit authors in.
  const outline: Array<readonly [number, number]> = [
    [-W / 2, -H / 2],
    [W / 2, -H / 2],
    [W / 2, H / 2 - CLIP],
    [W / 2 - CLIP, H / 2],
    [-W / 2, H / 2],
  ];
  parts.push(flatPolyPrism(outline, T, HEX.card));

  // The punched corner. A hole cannot be booleaned out of an indexed prism
  // without a CSG pass nobody is paying for, so the grommet IS the hole: a
  // 10 mm aluminium eyelet reads as a punched card at every distance the torch
  // reaches, and the dark ring through the middle of it does the rest.
  parts.push(
    at(
      tube(0.005, 0.005, GROMMET_H, 10, HEX.metal, { open: true, axis: 'z' }),
      -W / 2 + 0.018,
      H / 2 - 0.016,
    ),
  );

  // Three order bars, low on the face, leaving the upper two thirds clear for a
  // canvas texture later.
  for (let i = 0; i < 3; i++) {
    parts.push(
      at(
        paint(box({ x: 0.082, y: 0.005, z: BAR_PROUD }), HEX.dark),
        -0.014,
        -H / 2 + 0.014 + i * 0.011,
        T / 2 + BAR_PROUD / 2,
      ),
    );
  }

  // Lay it flat: the +Z face becomes the +Y face, then lift the card onto the
  // shelf so the grommet's lower rim is y = 0.
  const geometry = mergeParts(parts);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, REST_LIFT, 0);

  return {
    geometry,
    accent: {
      // The edge tag: a bar along the CLIPPED edge of the face, beside the
      // grommet, where an index tab would be. `rotateX(-90°)` sends the face's
      // former +Y (its top edge, carrying the clip and the punch) to −Z, so this
      // is the same corner the bible draws it on. Face-up, so a card lying on a
      // shelf is a lit dash on the deck rather than nothing at all.
      at: { x: -0.03, y: SEQUENCE_CARD_FACE.y, z: -(H / 2 - 0.012) },
      normal: { x: 0, y: 1, z: 0 },
      shape: 'bar',
    },
  };
}
