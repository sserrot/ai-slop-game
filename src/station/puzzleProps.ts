/**
 * src/station/puzzleProps.ts — the physical hardware around the puzzle panels
 * (asset bible ISS-PZL-01..05, DESIGN.md §11).
 *
 * THE PROBLEM THIS FILE SOLVES. The six puzzles already work, and they are
 * drawn correctly — as flat pictures on a `CanvasTexture` (§6). What a player
 * cannot do is stand in a doorway, sweep a 5-candela torch across a module and
 * say *"that's the breaker panel"*. Every puzzle looks like the same 0.86 × 0.58
 * grey box with a lit rectangle on it. The canvas readouts are the instruments
 * and they stay untouched; this file bolts the ironmongery around them.
 *
 * THREE RULES IT IS BUILT AGAINST, in priority order.
 *
 * 1 · SILHOUETTE FIRST. Five fixtures, five profiles that cannot be confused at
 *     10 m in a torch beam: a tall box with a vertical comb of levers down one
 *     cheek (breaker); a spoked wheel on a stub pipe (valve); a round dial with
 *     a needle standing proud of it (gauge); a small guarded block with a flat
 *     key paddle (keyswitch); a hazard-striped plinth under a hinged clamshell
 *     (undock). No two share a bounding profile, let alone an outline.
 *
 * 2 · STATE IS GEOMETRY, READ FROM AN ANGLE. The bible's line is "every fixture
 *     needs moving geometry, because state must be readable from an angle", and
 *     that is a stronger claim than "it animates". A drawing on a screen is a
 *     billboard: at 60° off-axis it is a bright sliver. So every state in this
 *     file is carried by something that *sticks out of the wall* and changes its
 *     angle — six lever arms, an override lever travelling through its stroke, a
 *     wheel with an asymmetric rim knob, a needle raised 1 cm off its dial, a
 *     key paddle in one of two detents, a red cover that swings up and a throw
 *     lever that comes 32 cm out at you. Each is legible as a profile against
 *     the wall behind it, which is the one thing that survives a grazing angle
 *     and a fog-limited torch.
 *
 * 3 · IT COSTS ALMOST NO DRAW CALLS. Two-hop portal culling reaches 7 of this
 *     station's 9 modules, so "module-culled" buys much less than it sounds —
 *     nine fixtures of loose meshes would be ~18 permanent draw calls. Instead:
 *
 *       • every fixture's STATIC hardware is vertex-coloured and merged into ONE
 *         mesh PER MODULE, sharing `materials.hazard` (white + `vertexColors`,
 *         the palette's one vertex-coloured program). That is 8 meshes for the
 *         whole station where the panel bodies alone used to be 13, so the
 *         static half of this feature lands at NEGATIVE five draw calls;
 *       • parts that exist once (wheel, needle, band, override) stay plain
 *         meshes — an `InstancedMesh` of one costs the same call and an extra
 *         shader permutation;
 *       • parts that repeat (6 breaker levers, 3 undock covers, 3 undock levers)
 *         are one `InstancedMesh` each, animated by `setMatrixAt`;
 *       • all 13 accents are ONE `InstancedSet` (`buildAccentInstances`).
 *
 *     Net: about +1 typical, +5 worst case. Vertex colour is what pays for it —
 *     one material can be twelve colours, so "merge everything static" costs no
 *     palette entries and no shader programs.
 *
 * WHAT LIVES WHERE. This file is geometry, layout and joint animation. It knows
 * nothing about the network or the puzzle registry; `panels.ts` routes state in.
 * The state shapes below are declared structurally on purpose — they are the
 * fields this file reads, and nothing more, so `src/puzzles` can grow without
 * dragging the station layer behind it.
 */

import * as THREE from 'three';
import type { ModuleId } from '@shared/types';
import { DECK_Y_M } from '@shared/constants';
import {
  ACCENT_BULB_R_M,
  accentGeometry,
  box,
  chamferedBox,
  checkPolyBudget,
  grille,
  hazardStripeBand,
  hinge,
  labelPlate,
  mergeParts,
  orientAxis,
  PolyBudgetError,
  ribbedCylinder,
  triangleCount,
  withVertexColor,
  type InteractKind,
  type Size3,
} from './artKit';
import { HAZARD_DARK, PALETTE } from './materials';
import { PROP_ARCHETYPES } from './kit';

// ===========================================================================
// The fixture frame
// ===========================================================================

/**
 * Every dimension below is in the FIXTURE FRAME:
 *
 *   +X  across the wall, in the plane of the panel (see `fixtureBasis`)
 *   +Y  up — real, world up, derived per panel, never assumed
 *   +Z  out of the wall, toward the player
 *
 * That is exactly the frame `artKit`'s flat helpers already use (XY plane facing
 * +Z) and the frame `orientAxis`, `rubberFoot` and `hinge` are documented in, so
 * every helper drops in without a rotation fix-up.
 *
 * It is deliberately NOT the panel prop's own local frame. The level authors
 * panels with four different quaternions and two of them put the prop's local
 * +X *downwards* — which nobody noticed, because a bare box and a centred
 * rectangle are both symmetric under a 180° roll. A comb of levers is not. So
 * the frame is recovered from world up at build time rather than assumed from
 * the authoring convention, and a fixture can never be installed upside down.
 */
const P = PROP_ARCHETYPES.panel.size;

/** Panel plate, across (its prop-local z). */
export const PANEL_ACROSS = P.z;
/** Panel plate, up (its prop-local x). */
export const PANEL_UP = P.x;
/** Panel plate, out of the wall (its prop-local y). */
export const PANEL_OUT = P.y;
/** Front face of the panel plate. */
export const PANEL_FACE_Z = P.y / 2;
/** The CanvasTexture face, across — `buildPanelParts`' `size.z * 0.82`. */
export const SCREEN_ACROSS = P.z * 0.82;
/** The CanvasTexture face, up — `buildPanelParts`' `size.x * 0.86`. */
export const SCREEN_UP = P.x * 0.86;
/** The CanvasTexture face's own Z, 5 mm proud of the plate. */
export const SCREEN_Z = P.y / 2 + 0.005;

/**
 * The rotation that takes the fixture frame into a panel prop's local frame.
 *
 * `panelWorld` is the panel group's world matrix (module × prop). Up is world
 * up, projected into the panel's plane; across completes a right-handed basis.
 * A panel lying flat (normal within ~6° of vertical) has no meaningful "up", so
 * it falls back to the prop's own local +X — no level authors one today, and a
 * silent NaN basis would be far worse than a defensible guess.
 *
 * Note which way `across` points: a viewer faces the panel along −normal, so
 * their right hand is −X. Everything in this file that hangs off to one side
 * hangs off the VIEWER'S RIGHT, i.e. at negative X.
 */
export function fixtureBasis(panelWorld: THREE.Matrix4): THREE.Quaternion {
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  panelWorld.decompose(pos, rot, scl);

  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(rot).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const up = worldUp.clone().addScaledVector(normal, -worldUp.dot(normal));
  if (up.lengthSq() < 0.01) {
    up.set(1, 0, 0).applyQuaternion(rot);
    up.addScaledVector(normal, -up.dot(normal));
  }
  up.normalize();
  const across = up.clone().cross(normal).normalize();

  // World basis → panel-local basis, so the group can be parented to the panel.
  const inverse = rot.clone().invert();
  across.applyQuaternion(inverse);
  up.applyQuaternion(inverse);
  const outward = new THREE.Vector3(0, 0, 1).crossVectors(across, up).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(across, up, outward),
  );
}

// ===========================================================================
// Roles — which fixture belongs on which authored panel
// ===========================================================================

export type FixtureKind = 'breaker' | 'valve' | 'gauge' | 'keyswitch' | 'undock' | 'plain';

export interface FixtureRole {
  readonly kind: FixtureKind;
  /** Keyswitch a/b → 0/1; undock lever 1..3 → 0..2; otherwise 0. */
  readonly index: number;
  /**
   * Bars on the fixture's identity plate — §11's puzzle number, so a player can
   * say "the four-bar panel" over voice. No fonts exist and none ever will
   * (rule 3), so a count is what "labelled" has to mean; it is also the only
   * labelling scheme that is colourblind-safe and needs no localisation.
   */
  readonly labelBars: number;
  /**
   * The accent gate. `attachAccent`/`buildAccentInstances` will not place a
   * self-lit dot without one of these, which is exactly how the palette stops
   * inert scenery from glowing. Every authored panel IS interactable, so every
   * panel has one — the two that are not puzzles are still doors.
   */
  readonly interact: InteractKind;
}

const PLAIN_ROLE: FixtureRole = { kind: 'plain', index: 0, labelBars: 0, interact: 'panel' };

/**
 * Read the fixture off the authored prop id.
 *
 * The level already names its panels by role (`node-beta-panel-breaker`,
 * `lab-atlas-panel-undock-3`), so the mapping is a parse rather than a second
 * table that can drift out of step with `levels/station.json`.
 */
export function fixtureRoleOf(propId: string): FixtureRole {
  if (/-panel-breaker$/.test(propId)) {
    return { kind: 'breaker', index: 0, labelBars: 1, interact: 'breaker' };
  }
  if (/-panel-valve$/.test(propId)) {
    return { kind: 'valve', index: 0, labelBars: 2, interact: 'valve' };
  }
  // Same bar count as the valve, deliberately: the gauge and the wheel are two
  // halves of one system two modules apart (§11 puzzle 2), and the bible asks
  // for them to read as a visual family. Bar count is the family name.
  if (/-panel-gauge$/.test(propId)) {
    return { kind: 'gauge', index: 0, labelBars: 2, interact: 'gauge' };
  }
  const key = /-panel-keyswitch-([ab])$/.exec(propId);
  if (key) {
    return { kind: 'keyswitch', index: key[1] === 'a' ? 0 : 1, labelBars: 5, interact: 'keyswitch' };
  }
  const undock = /-panel-undock-(\d+)$/.exec(propId);
  if (undock) {
    const n = Number.parseInt(undock[1] as string, 10);
    return {
      kind: 'undock',
      index: Number.isFinite(n) && n > 0 ? n - 1 : 0,
      labelBars: 6,
      interact: 'undock-lever',
    };
  }
  if (/-panel-fuse-\d+$/.test(propId)) {
    return { kind: 'plain', index: 0, labelBars: 4, interact: 'panel' };
  }
  return PLAIN_ROLE;
}

// ===========================================================================
// Colours
// ===========================================================================

/**
 * Every static part is vertex-coloured onto ONE material (`materials.hazard`,
 * white + `vertexColors`). Colour therefore costs nothing — no palette entry, no
 * shader program — which is the whole reason nine fixtures fit in one mesh per
 * module. Roughness and metalness come from that single spec and cannot vary;
 * at 5 candela through exponential fog that is invisible, and the parts where a
 * metallic response genuinely reads (wheel, keys, levers, needle) are the moving
 * ones, which have their own real materials.
 *
 * The palette is imported rather than retyped so a retune upstream lands here.
 */
const C = {
  body: PALETTE.panelBody.color,
  housing: 0x2b3236, // one step up from panelBody so a housing reads as bolted-on
  dark: HAZARD_DARK,
  metal: PALETTE.structure.color,
  light: PALETTE.frame.color,
  brass: PALETTE.brass.color,
  dial: PALETTE.screen.color,
  /**
   * The only colours in this file with no palette entry, and the only ones that
   * needed inventing: a safety cover has to be red or it is not a safety cover.
   * They ride the vertex-coloured material, so they add no `MaterialSpec`, no
   * program and nothing for `assertPaletteCoherent()` to weigh — and they are
   * never the only cue, because the cover is also the only clamshell in the
   * station and sits on the only hazard-striped plinth.
   */
  coverFace: 0xb4241c,
  coverEdge: 0x7d1a14,
  coverRib: 0x8c1a14,
  grab: 0xd8d2c4,
} as const;

function paint(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  return withVertexColor(geometry, hex);
}

function at(geometry: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  geometry.translate(x, y, z);
  return geometry;
}

// ===========================================================================
// The shared panel shell — all 13 panels
// ===========================================================================

/** Gap between the CanvasTexture face and the bezel that frames it. */
const BEZEL_GAP = 0.006;
const BEZEL_T = 0.026;
const APERTURE_ACROSS = SCREEN_ACROSS / 2 + BEZEL_GAP;
const APERTURE_UP = SCREEN_UP / 2 + BEZEL_GAP;

/**
 * Chamfered plate plus a raised bezel around the screen aperture, plus the
 * identity plate. **~104–164 triangles** depending on bar count.
 *
 * This REPLACES the plain 12-triangle box `buildPanelParts` returns for the
 * body: the recess is what makes a lit rectangle read as an instrument set into
 * hardware rather than a poster stuck on a wall, and it is the cheapest possible
 * way to buy that. The chamfer keeps `chamferedBox`'s promise that the bounding
 * box still equals the authored prop size exactly, so nothing that measured
 * against `PROP_ARCHETYPES.panel` has moved.
 */
export function panelShellGeometry(labelBars: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  parts.push(
    paint(
      chamferedBox({ x: PANEL_ACROSS, y: PANEL_UP, z: PANEL_OUT }, 0.014, { axis: 'y' }),
      C.body,
    ),
  );

  const railZ = PANEL_FACE_Z + BEZEL_T / 2;
  const capH = PANEL_UP / 2 - APERTURE_UP;
  const capY = (PANEL_UP / 2 + APERTURE_UP) / 2;
  const sideW = PANEL_ACROSS / 2 - APERTURE_ACROSS;
  const sideX = (PANEL_ACROSS / 2 + APERTURE_ACROSS) / 2;
  parts.push(
    paint(at(box({ x: PANEL_ACROSS, y: capH, z: BEZEL_T }), 0, capY, railZ), C.housing),
    paint(at(box({ x: PANEL_ACROSS, y: capH, z: BEZEL_T }), 0, -capY, railZ), C.housing),
    paint(at(box({ x: sideW, y: APERTURE_UP * 2, z: BEZEL_T }), sideX, 0, railZ), C.housing),
    paint(at(box({ x: sideW, y: APERTURE_UP * 2, z: BEZEL_T }), -sideX, 0, railZ), C.housing),
  );

  // Identity plate on the bottom bezel. Already vertex-coloured by artKit.
  parts.push(
    at(labelPlate(0.115, 0.036, { bars: labelBars }), -0.155, -capY, PANEL_FACE_Z + BEZEL_T),
  );

  return mergeParts(parts);
}

/** Where a plain panel's accent goes: bottom bezel, opposite the label. */
export const PLAIN_ACCENT: { at: Size3; normal: Size3 } = {
  at: { x: 0.19, y: -(PANEL_UP / 2 + APERTURE_UP) / 2, z: PANEL_FACE_Z + BEZEL_T },
  normal: { x: 0, y: 0, z: 1 },
};

// ===========================================================================
// ISS-PZL-01 · breaker panel
// ===========================================================================

/**
 * Six throw levers, a buzzer grille and the 20-second override.
 * Bible: 0.80 × 1.00 × 0.18, 700–1000 tris, animates 6 levers.
 *
 * SILHOUETTE: the only fixture in the station that is WIDER than its panel and
 * carries a vertical comb of six arms down one cheek. From across a module, in
 * profile, it is a ladder — and the rungs are at two different angles, which is
 * the state.
 *
 * The levers go on a cheek rather than on an apron under the screen for one
 * hard reason: the CanvasTexture face is 0.74 × 0.48 of a 0.86 × 0.58 plate, so
 * there is nowhere on the front that is not the instrument. Nothing in this file
 * is allowed to cross it.
 */
export const BREAKER = {
  /** Bible width, so the cheeks land symmetrically outside the plate. */
  half: 0.39,
  cheekX: 0.3325,
  cheekOut: 0.10,
  leverPitch: 0.14,
  leverCount: 6,
  overridePivot: { x: 0, y: -0.4425, z: 0.10 } as Size3,
  accent: { at: { x: 0.24, y: 0.4675, z: 0.075 }, normal: { x: 0, y: 0, z: 1 } },
} as const;

/** Pivot of throw lever `i`, in the fixture frame. */
export function breakerLeverPivot(i: number): Size3 {
  const span = (BREAKER.leverCount - 1) * BREAKER.leverPitch;
  return {
    x: -BREAKER.cheekX,
    y: -span / 2 + i * BREAKER.leverPitch,
    z: BREAKER.cheekOut + 0.012,
  };
}

function breakerStatic(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cheek = { x: 0.115, y: 0.94, z: 0.135 };
  const cheekZ = cheek.z / 2 - PANEL_FACE_Z;

  for (const sign of [-1, 1]) {
    parts.push(
      paint(
        at(chamferedBox(cheek, 0.010, { axis: 'y' }), sign * BREAKER.cheekX, 0, cheekZ),
        C.housing,
      ),
    );
  }
  parts.push(
    paint(
      at(box({ x: BREAKER.half * 2, y: 0.065, z: 0.11 }), 0, 0.4675, 0.11 / 2 - PANEL_FACE_Z),
      C.housing,
    ),
    paint(
      at(
        chamferedBox({ x: BREAKER.half * 2, y: 0.115, z: 0.16 }, 0.012, { axis: 'x' }),
        0,
        -0.4425,
        0.16 / 2 - PANEL_FACE_Z,
      ),
      C.housing,
    ),
  );

  // Lever gang: a dark backplate with seven dividing ribs, so the six levers sit
  // in six visible slots. Hand-built rather than `grille`d because the ribs have
  // to land exactly BETWEEN the lever pivots — a vent whose bars are a fraction
  // out of step with the things moving through it reads as a mistake.
  const gangX = -BREAKER.cheekX;
  parts.push(
    paint(at(box({ x: 0.095, y: 0.86, z: 0.012 }), gangX, 0, BREAKER.cheekOut + 0.006), C.dark),
  );
  const ribSpan = BREAKER.leverCount * BREAKER.leverPitch;
  for (let i = 0; i <= BREAKER.leverCount; i++) {
    const y = -ribSpan / 2 + i * BREAKER.leverPitch;
    parts.push(
      paint(
        at(box({ x: 0.095, y: 0.013, z: 0.022 }), gangX, y, BREAKER.cheekOut + 0.017),
        C.metal,
      ),
    );
  }

  // Buzzer: the wrong-order reset is a 50-loudness buzz (§11) and this is the
  // only geometry that explains where it comes from. Hooded, so it reads as a
  // sounder rather than a vent.
  parts.push(
    paint(
      at(
        grille(0.088, 0.26, { bars: 6, frame: 0.010, depth: 0.014 }),
        BREAKER.cheekX,
        0.10,
        BREAKER.cheekOut + 0.004,
      ),
      C.dark,
    ),
    paint(
      at(box({ x: 0.115, y: 0.018, z: 0.10 }), BREAKER.cheekX, 0.243, 0.10 / 2 - PANEL_FACE_Z),
      C.housing,
    ),
  );

  // Override shroud: two upstands and a bridge, open at the front. §11 puts the
  // player kneeling here for 20 seconds "anchored, unable to look around", and a
  // guard is what says a control is a commitment rather than a tap.
  for (const sign of [-1, 1]) {
    parts.push(
      paint(at(box({ x: 0.018, y: 0.15, z: 0.115 }), sign * 0.088, -0.375, 0.14), C.housing),
    );
  }
  parts.push(paint(at(box({ x: 0.194, y: 0.016, z: 0.115 }), 0, -0.292, 0.14), C.housing));

  return mergeParts(parts);
}

/**
 * One throw lever: pivot at the origin, arm along +Y, so the parent transform is
 * the pivot and the joint angle is a rotation about X. **44 triangles.**
 */
export function breakerLeverGeometry(): THREE.BufferGeometry {
  const arm = at(chamferedBox({ x: 0.048, y: 0.10, z: 0.026 }, 0.006, { axis: 'y' }), 0, 0.05, 0);
  const tip = at(box({ x: 0.056, y: 0.022, z: 0.034 }), 0, 0.105, 0);
  return mergeParts([arm, tip]);
}

/** The 20-second override: a stouter lever with a ribbed grip. */
export function breakerOverrideGeometry(): THREE.BufferGeometry {
  const arm = at(chamferedBox({ x: 0.034, y: 0.15, z: 0.030 }, 0.007, { axis: 'y' }), 0, 0.075, 0);
  const grip = at(
    ribbedCylinder(0.026, 0.09, {
      axis: 'x',
      ribs: 3,
      ribHeight: 0.007,
      ribWidth: 0.016,
      radialSegments: 8,
    }),
    0,
    0.158,
    0,
  );
  return mergeParts([arm, grip]);
}

/**
 * Lever angles. `π/2` points the arm straight out of the wall; the tilt is what
 * you read. Up-and-out is open, down-and-out is thrown — a knife switch you
 * throw downwards, and 0.55 rad each side of horizontal is 63° of separation
 * between the two states, which survives both fog and a grazing angle.
 */
const LEVER_OUT = Math.PI / 2;
const LEVER_TILT = 0.55;

export function breakerLeverAngle(on: boolean): number {
  return LEVER_OUT + (on ? LEVER_TILT : -LEVER_TILT);
}

/** Stowed, hanging down the apron. */
export const OVERRIDE_STOWED = LEVER_OUT + 1.35;
/** In a hand, at the start of its stroke. */
export const OVERRIDE_GRASPED = LEVER_OUT + 0.95;
/** Fully drawn — the 20 seconds are up. */
export const OVERRIDE_DONE = LEVER_OUT + 0.55;

/**
 * The override lever travels its whole stroke over the 20-second hold, so the
 * progress bar is the lever. Non-physical (a real lever would be at its stop the
 * moment you pull it) and worth it: it is the only 20-second commitment in the
 * game, the player is kneeling and cannot look around, and this makes "how much
 * longer" readable from the next module rather than only from the HUD.
 */
export function breakerOverrideAngle(held: boolean, progress01: number): number {
  if (!held) return OVERRIDE_STOWED;
  const p = Math.min(1, Math.max(0, progress01));
  return OVERRIDE_GRASPED + (OVERRIDE_DONE - OVERRIDE_GRASPED) * p;
}

// ===========================================================================
// ISS-PZL-02 · coolant valve handwheel
// ===========================================================================

/**
 * Bible: 0.36 ⌀, 500–700 tris, animates rotation, brass, "deliberately shares a
 * visual family with the gauge".
 *
 * SILHOUETTE: a spoked wheel on a bonnet, on a bracket, off to one side of the
 * panel. Nothing else in the station is a circle with holes in it.
 *
 * MOUNTING. The wheel cannot go in front of the plate (the instrument is there)
 * and it cannot go above it (a panel is a flat plate on a curved 1 m hull, so
 * its top corners are already inside the pressure shell — anything mounted
 * higher is buried). Along the wall is the one direction that keeps its radius,
 * so the wheel hangs off the viewer's right on a stub bracket. It lands at
 * 0.58–0.92 m over the deck: a valve you crouch slightly into, which is where
 * plumbing lives.
 */
export const VALVE = {
  centre: { x: -0.44, y: 0, z: 0.215 } as Size3,
  rimRadius: 0.148,
  tube: 0.019,
  spokes: 5,
  accent: { at: { x: -0.30, y: 0, z: 0.131 }, normal: { x: 0, y: 0, z: 1 } },
} as const;

function valveStatic(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(
    paint(
      at(
        chamferedBox({ x: 0.44, y: 0.105, z: 0.095 }, 0.012, { axis: 'x' }),
        VALVE.centre.x / 2,
        0,
        0.095 / 2 - PANEL_FACE_Z,
      ),
      C.housing,
    ),
  );
  // Bonnet, flange and bolt circle: the vocabulary that says "pipe", not "wire".
  parts.push(
    paint(
      at(
        ribbedCylinder(0.055, 0.145, {
          axis: 'z',
          ribs: 4,
          ribHeight: 0.010,
          ribWidth: 0.018,
          radialSegments: 8,
        }),
        VALVE.centre.x,
        0,
        0.11,
      ),
      C.brass,
    ),
    paint(
      at(
        orientAxis(new THREE.CylinderGeometry(0.088, 0.088, 0.020, 12), 'z'),
        VALVE.centre.x,
        0,
        0.048,
      ),
      C.metal,
    ),
    paint(
      at(
        boltCircle(0.070, 5, 0.010, 0.008),
        VALVE.centre.x,
        0,
        0.058,
      ),
      C.metal,
    ),
    paint(
      at(
        orientAxis(new THREE.CylinderGeometry(0.036, 0.042, 0.030, 6), 'z'),
        VALVE.centre.x,
        0,
        0.196,
      ),
      C.brass,
    ),
  );
  return mergeParts(parts);
}

/**
 * The handwheel: rim, five spokes, hub — and ONE knob on the rim.
 *
 * The knob is the whole readability argument. A five-fold-symmetric wheel shows
 * nothing at all until it has turned 72°, so a player asked to "turn it slowly"
 * (§11: slow is quiet at 8, spinning it is loud at 40) would have no feedback
 * that they were turning it at all. One asymmetric lug makes the angle absolute
 * and readable from any direction, including from behind the wheel.
 *
 * Five spokes rather than four or six: an odd count is never mistaken for a
 * cross, and count is a colourblind-safe identifier in its own right (rule 7).
 */
export function valveWheelGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.TorusGeometry(VALVE.rimRadius, VALVE.tube, 4, 14),
  ];
  const inner = VALVE.rimRadius - VALVE.tube;
  for (let i = 0; i < VALVE.spokes; i++) {
    const a = (i / VALVE.spokes) * Math.PI * 2;
    const spoke = at(box({ x: 0.022, y: inner, z: 0.022 }), 0, inner / 2, 0);
    spoke.rotateZ(a);
    parts.push(spoke);
  }
  parts.push(orientAxis(new THREE.CylinderGeometry(0.035, 0.035, 0.050, 8), 'z'));
  const knob = at(
    chamferedBox({ x: 0.030, y: 0.052, z: 0.030 }, 0.008, { axis: 'y' }),
    0,
    VALVE.rimRadius + 0.016,
    0,
  );
  parts.push(knob);
  return mergeParts(parts);
}

/** Two and a half turns across the puzzle's 0–1 range. */
export const VALVE_TURNS = 2.5;

export function valveWheelAngle(value01: number): number {
  return -value01 * VALVE_TURNS * Math.PI * 2;
}

// ===========================================================================
// ISS-PZL-03 · coolant gauge
// ===========================================================================

/**
 * Bible: 0.28 ⌀, 400–600 tris, animates needle, "needle is geometry, not a
 * drawing, so it's readable off-axis", green target band.
 *
 * SILHOUETTE: a brass-ringed drum on a bracket — a circle where the valve is a
 * ring, which is the family resemblance the bible asks for, and the only pair of
 * fixtures in the station that are meant to be confusable with each other.
 * They are two modules apart, so the confusion costs nothing and the recognition
 * ("this is the other half of the thing my crewmate is holding") is the point.
 *
 * The needle stands 1 cm off the dial and has a counterweight tail. Both are for
 * the same reason: §11's whole puzzle is one player reading this dial aloud to
 * another, over voice, while stood at an angle to it in the dark. A flat drawing
 * of a needle disappears at 60° off-axis; a raised blade with two ends still
 * reads as a line, and it reads against nine physical ticks and a self-lit band.
 */
export const GAUGE = {
  centre: { x: -0.40, y: 0, z: 0.135 } as Size3,
  canRadius: 0.132,
  bezel: 0.014,
  faceZ: 0.136,
  needleZ: 0.146,
  bandZ: 0.140,
  ticks: 9,
  tickRadius: 0.100,
  accent: { at: { x: -0.28, y: 0, z: 0.126 }, normal: { x: 0, y: 0, z: 1 } },
} as const;

/** Sweep: 0 points down-left, 1 points down-right, 270° clockwise between. */
const DIAL_ZERO = (5 * Math.PI) / 4;
const DIAL_SWEEP = (3 * Math.PI) / 2;

/** Angle of a dial reading, measured CCW from +X. */
export function gaugeDialAngle(n01: number): number {
  return DIAL_ZERO - Math.min(1, Math.max(0, n01)) * DIAL_SWEEP;
}

/** Rotation for the needle mesh, whose blade is modelled along +Y. */
export function gaugeNeedleAngle(n01: number): number {
  return gaugeDialAngle(n01) - Math.PI / 2;
}

/** Rotation for the band mesh, which is modelled centred on +X. */
export function gaugeBandAngle(target01: number): number {
  return gaugeDialAngle(target01);
}

function gaugeStatic(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(
    paint(
      at(
        chamferedBox({ x: 0.40, y: 0.10, z: 0.09 }, 0.012, { axis: 'x' }),
        GAUGE.centre.x / 2,
        0,
        0.09 / 2 - PANEL_FACE_Z,
      ),
      C.housing,
    ),
    paint(
      at(
        orientAxis(new THREE.CylinderGeometry(GAUGE.canRadius, GAUGE.canRadius, 0.10, 14), 'z'),
        GAUGE.centre.x,
        0,
        0.085,
      ),
      C.body,
    ),
    paint(
      at(new THREE.CircleGeometry(GAUGE.canRadius - 0.010, 14), GAUGE.centre.x, 0, GAUGE.faceZ),
      C.dial,
    ),
    paint(
      at(
        new THREE.TorusGeometry(GAUGE.canRadius, GAUGE.bezel, 4, 14),
        GAUGE.centre.x,
        0,
        GAUGE.faceZ,
      ),
      C.brass,
    ),
  );
  for (let i = 0; i < GAUGE.ticks; i++) {
    const a = gaugeDialAngle(i / (GAUGE.ticks - 1));
    const major = i === 0 || i === GAUGE.ticks - 1;
    const tick = at(
      box({ x: major ? 0.011 : 0.008, y: major ? 0.030 : 0.022, z: 0.006 }),
      0,
      GAUGE.tickRadius,
      0,
    );
    tick.rotateZ(a - Math.PI / 2);
    parts.push(paint(at(tick, GAUGE.centre.x, 0, GAUGE.faceZ + 0.003), C.light));
  }
  return mergeParts(parts);
}

/**
 * The green target band. `materials.indicatorGreen`, and the only green in the
 * station — which is the bible's line and also why it is a 27° arc 22 mm wide
 * rather than a lit dial: a self-lit accent is the readability budget (rule 2)
 * and this one is spent making a two-player conversation possible in the dark.
 *
 * `bandHalf` is a constant of the puzzle, so the arc is baked. It is passed in
 * rather than imported so `src/station` keeps out of `src/puzzles`' internals.
 */
export function gaugeBandGeometry(bandHalf: number): THREE.BufferGeometry {
  const half = Math.max(0.005, bandHalf) * DIAL_SWEEP;
  return new THREE.RingGeometry(0.096, 0.118, 6, 1, -half, half * 2);
}

/** Pivot at the dial centre, blade along +Y, tail behind it. */
export function gaugeNeedleGeometry(): THREE.BufferGeometry {
  const blade = at(chamferedBox({ x: 0.013, y: 0.115, z: 0.008 }, 0.004, { axis: 'y' }), 0, 0.0475, 0);
  const tail = at(box({ x: 0.020, y: 0.032, z: 0.010 }), 0, -0.026, 0);
  const hub = orientAxis(new THREE.CylinderGeometry(0.016, 0.016, 0.026, 8), 'z');
  return mergeParts([blade, tail, hub]);
}

// ===========================================================================
// ISS-PZL-04 · keyswitch
// ===========================================================================

/**
 * Bible: 0.18 × 0.22 × 0.10, 300–450 tris, animates key turn, "two sit 4 m
 * apart and must turn within a second of each other, so both have to be
 * spottable at once. Raised guards imply deliberate action only."
 *
 * SILHOUETTE: the smallest fixture, and the only one with two bare upstands
 * flanking a flat paddle. Both keyswitches live in `airlock-eva`, which is an
 * authored `zero` module — so §11's choice is made for us: the puzzle is two
 * people anchored to rails, unable to look around, counting down over voice.
 * The paddle therefore has to be readable from across the module by the OTHER
 * player, not by the person holding it, which is why it is a flat plate standing
 * 3 cm off its escutcheon rather than a knob.
 */
export const KEYSWITCH = {
  centre: { x: -0.375, y: 0, z: 0.085 } as Size3,
  keyAt: { x: -0.375, y: 0.015, z: 0.140 } as Size3,
  faceZ: 0.135,
  accent: { at: { x: -0.375, y: -0.098, z: 0.136 }, normal: { x: 0, y: 0, z: 1 } },
} as const;

/** Off is vertical; on is 35° clockwise, and the detent marks say so. */
export const KEY_TURN = -0.62;

export function keyswitchKeyAngle(turned01: number): number {
  return KEY_TURN * Math.min(1, Math.max(0, turned01));
}

function keyswitchStatic(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(
    paint(
      at(
        chamferedBox({ x: 0.20, y: 0.10, z: 0.075 }, 0.010, { axis: 'x' }),
        KEYSWITCH.centre.x / 2,
        0,
        0.075 / 2 - PANEL_FACE_Z,
      ),
      C.housing,
    ),
    paint(
      at(
        chamferedBox({ x: 0.18, y: 0.22, z: 0.10 }, 0.014, { axis: 'z' }),
        KEYSWITCH.centre.x,
        0,
        KEYSWITCH.centre.z,
      ),
      C.body,
    ),
  );
  for (const sign of [-1, 1]) {
    parts.push(
      paint(
        at(box({ x: 0.016, y: 0.17, z: 0.075 }), KEYSWITCH.centre.x + sign * 0.072, 0, 0.172),
        C.housing,
      ),
    );
  }
  parts.push(
    paint(at(box({ x: 0.160, y: 0.014, z: 0.075 }), KEYSWITCH.centre.x, -0.078, 0.172), C.housing),
    paint(
      at(new THREE.RingGeometry(0.030, 0.050, 12), KEYSWITCH.keyAt.x, KEYSWITCH.keyAt.y, KEYSWITCH.faceZ),
      C.brass,
    ),
  );
  // Two detents, so the key's angle is read against something rather than
  // guessed. Geometry, not paint: the marks have to survive a grazing angle too.
  for (const a of [0, KEY_TURN]) {
    const mark = at(box({ x: 0.008, y: 0.018, z: 0.006 }), 0, 0.062, 0);
    mark.rotateZ(a);
    parts.push(
      paint(at(mark, KEYSWITCH.keyAt.x, KEYSWITCH.keyAt.y, KEYSWITCH.faceZ + 0.002), C.light),
    );
  }
  return mergeParts(parts);
}

/** Flat bow, shank, blade. Pivot at the keyway, bow along +Y. */
export function keyswitchKeyGeometry(): THREE.BufferGeometry {
  const bow = at(chamferedBox({ x: 0.052, y: 0.070, z: 0.010 }, 0.006, { axis: 'z' }), 0, 0.050, 0);
  const shank = orientAxis(new THREE.CylinderGeometry(0.0075, 0.0075, 0.034, 8), 'z');
  const blade = at(box({ x: 0.006, y: 0.030, z: 0.014 }), 0, 0.006, 0);
  return mergeParts([bow, shank, blade]);
}

// ===========================================================================
// ISS-PZL-05 · undock lever
// ===========================================================================

/**
 * Bible: 0.25 × 0.55 × 0.20, 500–750 tris, animates cover + throw, "two-handed,
 * under a hinged red safety cover, hazard-striped at the base. Three of these
 * end the game — they should feel final and slightly frightening to touch."
 *
 * SILHOUETTE: a plinth with a clamshell over it. The one fixture with a hinge
 * line across its top and a hazard band at its foot, and — once four systems are
 * online — the one fixture in the station with a red lid standing open.
 *
 * FINALITY IS BUILT INTO THE ANIMATION, not into a colour:
 *   • the cover is LOCKED SHUT until the escape is armed, so three red lids
 *     flipping up across three modules is how the station announces the finale.
 *     Nothing else in the game changes shape because of a global state;
 *   • the throw lever is a two-handed T-bar at chest height (0.95 m over the
 *     deck) that comes 32 cm out of the wall when engaged, which is by far the
 *     largest movement any fixture makes. §11 has three players holding these
 *     for five seconds at loudness 60 in three separate modules, and this is the
 *     only feedback each of them has that the other two are still alive.
 */
export const UNDOCK = {
  x: -0.42,
  coverPivot: { x: -0.42, y: 0.295, z: 0.168 } as Size3,
  leverPivot: { x: -0.42, y: -0.09, z: 0.112 } as Size3,
  accent: { at: { x: -0.42, y: -0.262, z: 0.161 }, normal: { x: 0, y: 0, z: 1 } },
} as const;

/** Shut, latched. */
export const COVER_SHUT = 0;
/** Swung up and over the hinge. */
export const COVER_OPEN = -1.95;
/** Lever at rest, straight up under the cover. */
export const THROW_REST = 0;
/** Lever pulled out and down — 54°, and 32 cm of it. */
export const THROW_ENGAGED = 0.95;

export function undockCoverAngle(open01: number): number {
  return COVER_SHUT + (COVER_OPEN - COVER_SHUT) * Math.min(1, Math.max(0, open01));
}

export function undockLeverAngle(engaged01: number): number {
  return THROW_REST + (THROW_ENGAGED - THROW_REST) * Math.min(1, Math.max(0, engaged01));
}

function undockStatic(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(
    paint(
      at(chamferedBox({ x: 0.25, y: 0.17, z: 0.15 }, 0.014, { axis: 'x' }), UNDOCK.x, -0.20, 0.085),
      C.housing,
    ),
    paint(
      at(chamferedBox({ x: 0.22, y: 0.42, z: 0.13 }, 0.012, { axis: 'y' }), UNDOCK.x, 0.085, 0.075),
      C.body,
    ),
    // Hazard band on the plinth. Already vertex-coloured; laid ONTO the face.
    at(
      hazardStripeBand(0.225, 0.055, { stripes: 7, thickness: 0.010, skew: 0.30, axis: 'x' }),
      UNDOCK.x,
      -0.20,
      0.163,
    ),
  );
  for (const sign of [-1, 1]) {
    parts.push(
      paint(at(box({ x: 0.014, y: 0.34, z: 0.12 }), UNDOCK.x + sign * 0.104, 0.09, 0.145), C.metal),
    );
  }
  parts.push(
    paint(
      at(
        orientAxis(hinge(0.19, { radius: 0.011, knuckles: 3, radialSegments: 6 }), 'x'),
        UNDOCK.coverPivot.x,
        UNDOCK.coverPivot.y,
        UNDOCK.coverPivot.z - 0.013,
      ),
      C.metal,
    ),
    paint(at(box({ x: 0.22, y: 0.020, z: 0.13 }), UNDOCK.x, 0.305, 0.075), C.housing),
  );
  return mergeParts(parts);
}

/** Clamshell: pivot at the hinge, plate hanging DOWN from it. */
export function undockCoverGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(
      at(chamferedBox({ x: 0.208, y: 0.34, z: 0.020 }, 0.008, { axis: 'y' }), 0, -0.17, 0),
      C.coverFace,
    ),
  ];
  for (const sign of [-1, 1]) {
    parts.push(
      paint(at(box({ x: 0.016, y: 0.32, z: 0.055 }), sign * 0.096, -0.17, -0.0375), C.coverEdge),
    );
  }
  for (const dx of [-0.06, 0, 0.06]) {
    parts.push(paint(at(box({ x: 0.014, y: 0.30, z: 0.014 }), dx, -0.17, 0.017), C.coverRib));
  }
  // Pale grab tab: the one place on a red lid that says "lift here", and pale
  // rather than lit, because a self-lit tab would be a second accent.
  parts.push(paint(at(box({ x: 0.180, y: 0.026, z: 0.045 }), 0, -0.345, 0.012), C.grab));
  return mergeParts(parts);
}

/** Two-handed throw lever: pivot at the boss, arm along +Y, T-grip on the end. */
export function undockLeverGeometry(): THREE.BufferGeometry {
  const arm = at(chamferedBox({ x: 0.042, y: 0.28, z: 0.036 }, 0.010, { axis: 'y' }), 0, 0.14, 0);
  const grip = at(
    ribbedCylinder(0.024, 0.19, {
      axis: 'x',
      ribs: 5,
      ribHeight: 0.006,
      ribWidth: 0.016,
      radialSegments: 8,
    }),
    0,
    0.29,
    0,
  );
  const boss = orientAxis(new THREE.CylinderGeometry(0.030, 0.030, 0.052, 8), 'x');
  return mergeParts([arm, grip, boss]);
}

// ===========================================================================
// Shared small parts
// ===========================================================================

/**
 * A ring of bolt heads along +Z. `artKit.boltRing` does this and does it better,
 * but its heads are `CylinderGeometry` and its cheapest configuration is still
 * `count × 4 × segments` triangles; this is the same read for a fifth of the
 * budget, which matters because it appears on a fixture that is already near the
 * top of its band.
 */
function boltCircle(
  radius: number,
  count: number,
  headRadius: number,
  height: number,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    parts.push(
      at(
        box({ x: headRadius * 1.7, y: headRadius * 1.7, z: height }),
        Math.cos(a) * radius,
        Math.sin(a) * radius,
        0,
      ),
    );
  }
  return mergeParts(parts);
}

// ===========================================================================
// Static assembly
// ===========================================================================

/** Static hardware for one fixture kind, or null for a plain panel. */
export function fixtureStaticGeometry(kind: FixtureKind): THREE.BufferGeometry | null {
  switch (kind) {
    case 'breaker':
      return breakerStatic();
    case 'valve':
      return valveStatic();
    case 'gauge':
      return gaugeStatic();
    case 'keyswitch':
      return keyswitchStatic();
    case 'undock':
      return undockStatic();
    default:
      return null;
  }
}

/** Where a fixture's one amber accent goes, in the fixture frame. */
export function fixtureAccent(kind: FixtureKind): { at: Size3; normal: Size3 } {
  switch (kind) {
    case 'breaker':
      return BREAKER.accent;
    case 'valve':
      return VALVE.accent;
    case 'gauge':
      return GAUGE.accent;
    case 'keyswitch':
      return KEYSWITCH.accent;
    case 'undock':
      return UNDOCK.accent;
    default:
      return PLAIN_ACCENT;
  }
}

// ===========================================================================
// Joints — one animated degree of freedom
// ===========================================================================

/** Where a joint writes its angle: a mesh's own rotation, or an instance slot. */
export type JointSink = (angle: number) => void;

interface Joint {
  sink: JointSink;
  /** Exponential approach time constant, seconds. 0 snaps. */
  tau: number;
  current: number;
  target: number;
  dirty: boolean;
}

/**
 * Exponential approach, framerate-independent: `1 - exp(-dt/tau)` rather than a
 * bare `lerp(a, b, k)`. A bare lerp is a different spring at 30 fps and at 144,
 * which is exactly the class of bug §4 calls out for velocity drag ("specify
 * half-lives, never bare exponents").
 */
function approach(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0 || dt <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/**
 * The animated hardware of one panel.
 *
 * Joints are addressed by index because the set is fixed at construction and
 * this runs inside the frame loop; the named accessors below are what callers
 * actually use.
 */
export class PuzzleFixture {
  readonly kind: FixtureKind;
  readonly index: number;
  readonly module: ModuleId;

  private readonly joints: Joint[] = [];
  /** Throw-lever joints, in authored order. */
  private readonly levers: number[] = [];
  private override = -1;
  private wheel = -1;
  private needle = -1;
  private key = -1;
  private cover = -1;
  private throwLever = -1;
  private band: JointSink | null = null;
  private bandSet = false;
  /** Rad/s of buzz on every lever while the panel is in fault (§11's 50-dB buzz). */
  private buzz = 0;
  private buzzPhase = 0;

  constructor(kind: FixtureKind, index: number, module: ModuleId) {
    this.kind = kind;
    this.index = index;
    this.module = module;
  }

  private addJoint(sink: JointSink, tau: number, initial: number): number {
    this.joints.push({ sink, tau, current: initial, target: initial, dirty: true });
    return this.joints.length - 1;
  }

  addLever(sink: JointSink): void {
    this.levers.push(this.addJoint(sink, 0.055, breakerLeverAngle(false)));
  }

  addOverride(sink: JointSink): void {
    this.override = this.addJoint(sink, 0.10, OVERRIDE_STOWED);
  }

  addWheel(sink: JointSink): void {
    this.wheel = this.addJoint(sink, 0.12, 0);
  }

  addNeedle(sink: JointSink): void {
    this.needle = this.addJoint(sink, 0.14, gaugeNeedleAngle(0));
  }

  addKey(sink: JointSink): void {
    this.key = this.addJoint(sink, 0.08, 0);
  }

  addCover(sink: JointSink): void {
    this.cover = this.addJoint(sink, 0.40, COVER_SHUT);
  }

  addThrow(sink: JointSink): void {
    this.throwLever = this.addJoint(sink, 0.13, THROW_REST);
  }

  /** The green band never animates — it is set once, when `target` first lands. */
  addBand(sink: JointSink): void {
    this.band = sink;
  }

  private aim(id: number, angle: number): void {
    const joint = this.joints[id];
    if (!joint || joint.target === angle) return;
    joint.target = angle;
    joint.dirty = true;
  }

  // -- state in --------------------------------------------------------------

  applyBreaker(state: BreakerFixtureState, nowMs: number): void {
    for (let i = 0; i < this.levers.length; i++) {
      this.aim(this.levers[i] as number, breakerLeverAngle(state.switches[i] === true));
    }
    if (this.override >= 0) {
      const o = state.override;
      this.aim(this.override, breakerOverrideAngle(o.holder != null, o.progress01));
    }
    // A fault is a buzz, and a buzz is a thing you can SEE: every lever shivers
    // for as long as the panel is ignoring input. The window is clamped rather
    // than trusted, because `faultUntilMs` is a server clock and this is not.
    const remaining = state.faultUntilMs - nowMs;
    this.buzz = remaining > 0 && remaining < 6000 ? 1 : 0;
  }

  applyValve(state: ValveFixtureState): void {
    if (this.wheel >= 0) {
      const joint = this.joints[this.wheel] as Joint;
      joint.tau = state.turnFast ? 0.05 : 0.14;
      this.aim(this.wheel, valveWheelAngle(state.value));
    }
  }

  applyGauge(state: GaugeFixtureState): void {
    if (this.needle >= 0) this.aim(this.needle, gaugeNeedleAngle(state.needle));
    if (this.band && !this.bandSet) {
      this.band(gaugeBandAngle(state.target));
      this.bandSet = true;
    }
  }

  applyKeyswitch(turned: boolean): void {
    if (this.key >= 0) this.aim(this.key, keyswitchKeyAngle(turned ? 1 : 0));
  }

  applyUndock(armed: boolean, engaged: boolean): void {
    if (this.cover >= 0) this.aim(this.cover, undockCoverAngle(armed ? 1 : 0));
    if (this.throwLever >= 0) this.aim(this.throwLever, undockLeverAngle(engaged ? 1 : 0));
  }

  /** Everything back to its rest pose — a new round, or a disconnect. */
  reset(): void {
    for (let i = 0; i < this.levers.length; i++) {
      this.aim(this.levers[i] as number, breakerLeverAngle(false));
    }
    if (this.override >= 0) this.aim(this.override, OVERRIDE_STOWED);
    if (this.key >= 0) this.aim(this.key, 0);
    if (this.cover >= 0) this.aim(this.cover, COVER_SHUT);
    if (this.throwLever >= 0) this.aim(this.throwLever, THROW_REST);
    this.buzz = 0;
    this.bandSet = false;
  }

  // -- the frame ------------------------------------------------------------

  /** True if anything moved, so the caller knows whether to flush instances. */
  tick(dt: number): boolean {
    let moved = false;
    if (this.buzz > 0) this.buzzPhase += dt * 46;
    const shiver = this.buzz > 0 ? Math.sin(this.buzzPhase) * 0.085 : 0;

    for (let i = 0; i < this.joints.length; i++) {
      const joint = this.joints[i] as Joint;
      const isLever = this.levers.includes(i);
      const target = isLever ? joint.target + shiver : joint.target;
      const next = approach(joint.current, target, dt, joint.tau);
      if (!joint.dirty && Math.abs(next - joint.current) < 1e-5) continue;
      joint.current = next;
      joint.dirty = Math.abs(next - target) > 1e-4 || (isLever && this.buzz > 0);
      joint.sink(next);
      moved = true;
    }
    return moved;
  }
}

/** The fields `applyBreaker` reads. Structural, so `src/puzzles` stays free. */
export interface BreakerFixtureState {
  readonly switches: readonly boolean[];
  readonly faultUntilMs: number;
  readonly override: { readonly holder: unknown; readonly progress01: number };
}

export interface ValveFixtureState {
  readonly value: number;
  readonly turnFast: boolean;
}

export interface GaugeFixtureState {
  readonly needle: number;
  readonly target: number;
  readonly bandHalf: number;
}

// ===========================================================================
// Instanced animated parts
// ===========================================================================

export interface FixtureSlot {
  readonly module: ModuleId;
  /** Fixture-frame pivot → world. The joint angle rotates about its local X. */
  readonly base: THREE.Matrix4;
}

/**
 * One `InstancedMesh` for every copy of one moving part in the station — six
 * breaker levers, three undock covers, three undock levers.
 *
 * Culling is by ZERO-SCALE MATRIX, not by repacking. `InstancedSet` repacks
 * blocks to the front of the buffer and shortens `count`, which is the right
 * answer for static scatter and the wrong one here: repacking renumbers the
 * instances, and slot *k* has to keep meaning lever *k* for its whole life or
 * the animation writes to the wrong arm. A degenerate instance costs a vertex
 * shader invocation and no fragments, and the whole mesh drops out of the draw
 * list the moment none of its modules is in the cull set.
 */
export class FixturePartSet {
  readonly mesh: THREE.InstancedMesh;
  private readonly slots: readonly FixtureSlot[];
  private readonly shown: boolean[];
  private readonly angles: Float64Array;
  private readonly matrix = new THREE.Matrix4();
  private readonly rotation = new THREE.Matrix4();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private dirty = true;

  constructor(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    slots: readonly FixtureSlot[],
  ) {
    this.slots = slots;
    this.shown = slots.map(() => true);
    this.angles = new Float64Array(slots.length);
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, slots.length));
    this.mesh.name = name;
    this.mesh.count = Math.max(1, slots.length);
    // §9 budgets ONE shadow map (the flashlight). Hardware this small opts out,
    // the same call `instancing.ts` makes for the scatter props.
    this.mesh.castShadow = false;
    this.mesh.userData.noShadow = true;
    // Slots can be metres apart across the station, so a bounding volume over
    // them describes most of the station and the frustum test never rejects it.
    // Cheaper to say so than to recompute a sphere that never helps.
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {
      /* the CanvasTexture face is the only ray target on a panel — see panels.ts */
    };
    this.flush();
  }

  setAngle(slot: number, angle: number): void {
    if (slot < 0 || slot >= this.angles.length || this.angles[slot] === angle) return;
    this.angles[slot] = angle;
    this.dirty = true;
  }

  setVisibleModules(visible: ReadonlySet<ModuleId>): void {
    let any = false;
    for (let i = 0; i < this.slots.length; i++) {
      const on = visible.has((this.slots[i] as FixtureSlot).module);
      if (on !== this.shown[i]) {
        this.shown[i] = on;
        this.dirty = true;
      }
      any = any || on;
    }
    this.mesh.visible = any;
  }

  /** Write dirty matrices. Cheap no-op when nothing has changed. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.shown[i]) {
        this.mesh.setMatrixAt(i, this.hidden);
        continue;
      }
      this.rotation.makeRotationX(this.angles[i] as number);
      this.matrix.multiplyMatrices((this.slots[i] as FixtureSlot).base, this.rotation);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

// ===========================================================================
// Budgets
// ===========================================================================

export interface FixtureBudget {
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

/**
 * The asset bible's per-fixture triangle bands, verbatim. `POLY_BUDGETS.fixture`
 * (300–1200) is the palette-level band and every one of these sits inside it;
 * these are tighter because the bible costed each fixture individually and
 * under-spending is the bug this whole pass exists to fix ("everything is just
 * blobs and rails mostly").
 */
export const FIXTURE_BUDGETS: Readonly<Record<Exclude<FixtureKind, 'plain'>, FixtureBudget>> = {
  breaker: { label: 'ISS-PZL-01 breaker panel', min: 700, max: 1000 },
  valve: { label: 'ISS-PZL-02 coolant valve wheel', min: 500, max: 700 },
  gauge: { label: 'ISS-PZL-03 coolant gauge', min: 400, max: 600 },
  keyswitch: { label: 'ISS-PZL-04 keyswitch', min: 300, max: 450 },
  undock: { label: 'ISS-PZL-05 undock lever', min: 500, max: 750 },
};

export interface FixtureTriangles {
  readonly kind: FixtureKind;
  readonly shell: number;
  readonly staticHardware: number;
  readonly moving: number;
  /** What one installed fixture actually draws. */
  readonly total: number;
}

/**
 * Measure every fixture. Builds and disposes throwaway geometry, so it is a
 * verification entry point (and the dev self-check below), never a hot path.
 */
export function measureFixtures(bandHalf = 0.05): FixtureTriangles[] {
  const out: FixtureTriangles[] = [];
  const kinds: FixtureKind[] = ['breaker', 'valve', 'gauge', 'keyswitch', 'undock', 'plain'];

  for (const kind of kinds) {
    const role =
      kind === 'breaker'
        ? 1
        : kind === 'valve' || kind === 'gauge'
          ? 2
          : kind === 'keyswitch'
            ? 5
            : kind === 'undock'
              ? 6
              : 0;
    const shellGeometry = panelShellGeometry(role);
    const shell = triangleCount(shellGeometry);
    shellGeometry.dispose();

    const staticGeometry = fixtureStaticGeometry(kind);
    const staticHardware = staticGeometry ? triangleCount(staticGeometry) : 0;
    staticGeometry?.dispose();

    let moving = 0;
    const count = (g: THREE.BufferGeometry, copies = 1): void => {
      moving += triangleCount(g) * copies;
      g.dispose();
    };
    switch (kind) {
      case 'breaker':
        count(breakerLeverGeometry(), BREAKER.leverCount);
        count(breakerOverrideGeometry());
        break;
      case 'valve':
        count(valveWheelGeometry());
        break;
      case 'gauge':
        count(gaugeNeedleGeometry());
        count(gaugeBandGeometry(bandHalf));
        break;
      case 'keyswitch':
        count(keyswitchKeyGeometry());
        break;
      case 'undock':
        count(undockCoverGeometry());
        count(undockLeverGeometry());
        break;
      default:
        break;
    }

    out.push({ kind, shell, staticHardware, moving, total: shell + staticHardware + moving });
  }
  return out;
}

/**
 * Reach check. Rule 6: "SCALE COMES FROM CONSTANTS, NOT TASTE. Doll furniture is
 * the most common failure." A control's height over the deck is the one
 * dimension in this file that is not free to be pretty, so it is asserted.
 *
 * `panelCentreOverDeck` is how high the authored panel's centre sits above the
 * local deck; every fixture-frame Y adds to it.
 */
export function controlHeightsOverDeck(panelCentreOverDeck = -DECK_Y_M): Array<{
  what: string;
  metres: number;
}> {
  return [
    { what: 'breaker lever, lowest', metres: panelCentreOverDeck + breakerLeverPivot(0).y },
    {
      what: 'breaker lever, highest',
      metres: panelCentreOverDeck + breakerLeverPivot(BREAKER.leverCount - 1).y,
    },
    { what: 'breaker override grip', metres: panelCentreOverDeck + BREAKER.overridePivot.y - 0.15 },
    { what: 'valve handwheel centre', metres: panelCentreOverDeck + VALVE.centre.y },
    { what: 'gauge dial centre', metres: panelCentreOverDeck + GAUGE.centre.y },
    { what: 'keyswitch keyway', metres: panelCentreOverDeck + KEYSWITCH.keyAt.y },
    { what: 'undock T-grip, at rest', metres: panelCentreOverDeck + UNDOCK.leverPivot.y + 0.29 },
  ];
}

export class FixtureCoherenceError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(`puzzleProps coherence failed (${failures.length}):\n  - ${failures.join('\n  - ')}`);
    this.name = 'FixtureCoherenceError';
    this.failures = failures;
  }
}

/**
 * Everything this file promises, checked rather than remembered.
 *
 * Throws `FixtureCoherenceError` listing every failure at once, because fixing
 * these one exception at a time is how a geometry pass eats an afternoon.
 */
export function assertFixturesCoherent(): void {
  const fail: string[] = [];

  for (const m of measureFixtures()) {
    if (m.kind === 'plain') continue;
    const budget = FIXTURE_BUDGETS[m.kind];
    if (m.total > budget.max) {
      fail.push(`${budget.label}: ${m.total} tris over max ${budget.max}`);
    } else if (m.total < budget.min) {
      fail.push(`${budget.label}: ${m.total} tris under min ${budget.min} — spend the budget`);
    }
    const staticGeometry = fixtureStaticGeometry(m.kind);
    if (staticGeometry) {
      const inBand = checkPolyBudget(staticGeometry, 'fixture', budget.label);
      if (inBand.over) fail.push(inBand.message);
      staticGeometry.dispose();
    }
  }

  // Reach: nothing a player must touch may sit below step-over height. There
  // is deliberately NO upper bound: controls a little above the eye line are
  // fine — players can look up (removed at the fourth crew-scale pass, when a
  // 1.05 m eye put the breaker's top lever 5 cm over the line and the ceiling
  // check started legislating art instead of usability).
  for (const c of controlHeightsOverDeck()) {
    if (c.metres < 0.12) fail.push(`${c.what} is ${c.metres.toFixed(2)} m over the deck — too low`);
  }

  // Nothing may cross the CanvasTexture face: the readouts are the instruments.
  const acrossClear = [
    ['valve wheel', VALVE.centre.x + VALVE.rimRadius + VALVE.tube],
    ['gauge bezel', GAUGE.centre.x + GAUGE.canRadius + GAUGE.bezel],
    ['keyswitch body', KEYSWITCH.centre.x + 0.09],
    ['undock plinth', UNDOCK.x + 0.125],
  ] as const;
  for (const [what, edge] of acrossClear) {
    if (edge > -SCREEN_ACROSS / 2) {
      fail.push(`${what} reaches x=${edge.toFixed(3)}, over the screen at ${(-SCREEN_ACROSS / 2).toFixed(3)}`);
    }
  }

  // Two states of one control must be far enough apart to read as two states.
  const separations: Array<[string, number]> = [
    ['breaker lever', breakerLeverAngle(true) - breakerLeverAngle(false)],
    ['override stroke', OVERRIDE_STOWED - OVERRIDE_DONE],
    ['keyswitch', KEY_TURN],
    ['undock cover', COVER_OPEN - COVER_SHUT],
    ['undock throw', THROW_ENGAGED - THROW_REST],
  ];
  for (const [what, delta] of separations) {
    if (Math.abs(delta) < 0.45) {
      fail.push(`${what} moves only ${Math.abs(delta).toFixed(2)} rad — not readable off-axis`);
    }
  }

  // The bezel must actually clear the authored screen, or the frame eats the UI.
  if (APERTURE_ACROSS * 2 < SCREEN_ACROSS || APERTURE_UP * 2 < SCREEN_UP) {
    fail.push('panel bezel aperture is smaller than the CanvasTexture face');
  }

  // One accent per fixture, and it has to be ON the fixture rather than floating.
  for (const kind of ['breaker', 'valve', 'gauge', 'keyswitch', 'undock', 'plain'] as const) {
    const a = fixtureAccent(kind);
    if (a.at.z < PANEL_FACE_Z || a.at.z > 0.30) {
      fail.push(`${kind} accent sits at z=${a.at.z} — off the hardware`);
    }
    if (Math.abs(a.at.x) > 0.60 || Math.abs(a.at.y) > 0.55) {
      fail.push(`${kind} accent sits outside the fixture envelope`);
    }
  }
  if (ACCENT_BULB_R_M <= 0) fail.push('accent geometry has no size');

  if (fail.length > 0) throw new FixtureCoherenceError(fail);
}

/** True when the self-check ran and passed at import. Dev builds only. */
export const FIXTURES_CHECKED: boolean = (() => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.PROD === true) return false;
  try {
    assertFixturesCoherent();
    // Touch the accent cache once so a broken artKit surfaces here, at import,
    // rather than inside the first frame that tries to place a dot.
    if (triangleCount(accentGeometry('bulb')) < 1) throw new PolyBudgetError('empty accent');
    return true;
  } catch (err) {
    if (err instanceof FixtureCoherenceError || err instanceof PolyBudgetError) throw err;
    return false;
  }
})();
