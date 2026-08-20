/**
 * The station's material palette (DESIGN.md §9, `docs/asset-bible.html`).
 *
 * THE STATION IS DARK. A 5 candela flashlight, 13 m of range, a 23° cone, one
 * 1024² shadow map and exponential fog. Every value below follows from that, and
 * from three rules the asset bible refuses to bend:
 *
 *   1. SILHOUETTE FIRST — a player names an object by its outline in a torch
 *      beam. The palette's job is not to make things pretty, it is to keep
 *      outlines from merging. Hence `hero` and the pairwise distance check.
 *   2. EMISSIVE MEANS "YOU CAN TOUCH THIS" — one small self-lit accent per
 *      interactable, nothing else glows. `PALETTE.interact` is the only material
 *      in the game that carries that promise, and `assertPaletteCoherent()`
 *      defends it: no surface may glow in the accent's hue, and the accent must
 *      out-glow every surface by `ACCENT_DOMINANCE`.
 *   3. COLOUR IS NEVER THE ONLY CUE — the distance metric here deliberately
 *      discounts chroma by `CHROMA_WEIGHT`, because at 5 candela through fog
 *      chroma is the first thing to go. Two materials that differ only in hue
 *      FAIL the check, which is also what makes the palette colourblind-safe.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS A DATA TABLE AND NOT A PILE OF `new MeshStandardMaterial`
 *
 * `PALETTE` is plain numbers, so the coherence check is a pure function of the
 * palette and runs headlessly at import time in dev — the same trick
 * `assertConstantsCoherent()` plays in `shared/constants`. `StationMaterials`
 * is a thin factory over it. Six agents author assets against the NAMES; the
 * numbers stay in one table where the check can see all of them at once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDING A MATERIAL IS ALMOST FREE. ADDING A *FLAG COMBINATION* IS NOT.
 *
 * three.js caches WebGLPrograms by a key built from shader id and feature flags
 * (`WebGLPrograms.getProgramCacheKey`). Colour, roughness, metalness, emissive
 * and emissiveIntensity are UNIFORMS — they are not in the key. `side`,
 * `vertexColors`, `flatShading`, `toneMapped` and the shader id ARE. So thirty
 * MeshStandardMaterials that differ only in colour share ONE compiled program,
 * and one extra `flatShading: true` material costs a whole program that
 * `Renderer.prewarm()` has to link at boot (~20 ms each, measured).
 *
 * `programKey()` computes that key and `assertPaletteCoherent()` asserts the
 * palette stays inside `PROGRAM_KEY_BUDGET`. If you need a new look, change a
 * colour. If you think you need a new flag, spend one of the two spare slots
 * deliberately and say why.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * r3 CHANGES YOU MIGHT TRIP OVER
 *
 *  • `rail` IS NO LONGER YELLOW. It is pale ice-blue with a cool self-lit
 *    core. The bible's legend moved it: rails are the movement grammar, the
 *    amber accent is "you can act on this", and a yellow rail beside an amber
 *    dot was two signals in one hue — the exact false positive rule 2 forbids.
 *    Blue against amber is also the safest pair under every form of colour
 *    vision deficiency. Rails are `gravity: 'zero'` only now (§4), so inside
 *    those modules they must be the most readable object in frame, and
 *    `assertPaletteCoherent()` proves it against every other surface.
 *  • `indicatorClosed` IS NO LONGER AMBER. A closed hatch shows `idle` — a dim
 *    slate lamp reading "present, unpowered" (the bible's "green open, dark
 *    closed, red sealed"). Amber on a hatch competed with the accent.
 */

import * as THREE from 'three';
import type { GravityMode, LightingLevel } from '@shared/types';

// ===========================================================================
// Roles, channels and the spec shape
// ===========================================================================

/**
 * What a material IS, which decides which checks apply to it.
 *
 *  • `surface`   — an object is made of it. Judged on silhouette contrast; may
 *                  carry only a whisper of emissive (`EMISSIVE_BANDS.surface`).
 *  • `glass`     — a dark pane or dead screen. Dark by design, so it is exempt
 *                  from the hero-contrast floor.
 *  • `accent`    — THE interactable cue. Exactly one entry has this role.
 *  • `indicator` — a state lamp on something that already has state (and so is
 *                  already interactable). Small, self-lit, `toneMapped: false`.
 *  • `strip`     — a room light or a floor edge run. Big, dim per unit area,
 *                  and per-module: `createStripMaterial`/`createEdgeMaterial`.
 */
export type MaterialRole = 'surface' | 'glass' | 'accent' | 'indicator' | 'strip';

/**
 * The five self-lit channels, and the only five meanings light may carry.
 *
 *   amber  "a player action is relevant here"   — the accent, and state lamps
 *                                                 on things that carry one
 *   green  "this system is nominal"             — hatch open, floor present,
 *                                                 gauge inside the target band
 *   red    "this will kill you"                 — sealed hatch, airlock outer
 *   white  "here is a reading"                  — instrument backlight
 *   idle   "present, unpowered"                 — closed hatch, dead console
 *
 * `assertPaletteCoherent()` proves the five are pairwise distinguishable at
 * `JND_LIT`, and that none of them can be confused with a handrail.
 */
export type AccentChannel = 'amber' | 'green' | 'red' | 'white' | 'idle';

/** Which shader program family. `basic` is unlit — cheaper, and correct for a
 *  surface that is only ever a canvas readout. */
export type MaterialShader = 'standard' | 'basic';

/** Face culling. Part of the program cache key, so it is declared, not guessed. */
export type MaterialSide = 'front' | 'back' | 'double';

export interface MaterialSpec {
  /** Human name, echoed in coherence failures. Matches the `PaletteName` key. */
  readonly name: string;
  readonly role: MaterialRole;
  readonly shader: MaterialShader;
  readonly side: MaterialSide;
  /**
   * True when confusing this material with another one changes a player's
   * decision — a floor for a wall, a crewmate for the alien, a grating for a
   * plate, a valve for a switch. Hero materials are held to `JND_LOW_LIGHT`
   * pairwise and `HERO_MIN_CONTRAST` against the hull.
   *
   * Everything else is identified by SILHOUETTE and the palette makes no
   * promise about its colour. Marking a material hero is a promise the check
   * will hold you to; do not do it for decoration.
   */
  readonly hero: boolean;
  /** Base colour, sRGB hex. Multiplied by vertex colour when `vertexColors`. */
  readonly color: number;
  readonly roughness: number;
  readonly metalness: number;
  /** Emissive colour, sRGB hex. `0x000000` for anything inert. */
  readonly emissive: number;
  /** Emissive multiplier. Range enforced per role by `EMISSIVE_BANDS`. */
  readonly emissiveIntensity: number;
  /** Vertex colours multiply `color`. Costs a program key — see the header. */
  readonly vertexColors?: boolean;
  /** `false` keeps the material out of ACES so it clears the §9 bloom
   *  threshold. Costs a program key. Self-lit roles only. */
  readonly toneMapped?: boolean;
  /** Self-lit channel this entry speaks on. Only `accent`/`indicator` have one. */
  readonly channel?: AccentChannel;
  /**
   * The colour the checks should JUDGE this entry by, when `color` is a
   * multiplier rather than an appearance. `hazard` is white because its vertex
   * colours supply the stripes; its swatch is the yellow half of the stripe.
   */
  readonly swatch?: number;
}

// ===========================================================================
// The palette
// ===========================================================================

/**
 * Every material name in the game. Six agents build against these strings, so
 * the union is exhaustive and stable — add to it, never rename.
 *
 * Legacy aliases (`trim`, `furniture`, `rack`, …) are kept as their own entries
 * rather than folded into `painted`/`structure`: distinct entries cost nothing
 * (same program key, uniforms only) and keep each surface independently
 * tunable, which is worth more than a shorter table.
 */
export type PaletteName =
  // structure
  | 'hull'
  | 'structure'
  | 'painted'
  | 'aluminium'
  | 'frame'
  | 'door'
  // deck
  | 'deck'
  | 'grating'
  // movement grammar
  | 'rail'
  // markings
  | 'warning'
  | 'hazard'
  // soft goods and small parts
  | 'plastic'
  | 'webbing'
  | 'rubber'
  | 'brass'
  | 'stowage'
  // bodies
  | 'organic'
  | 'suit'
  // fixtures and furniture
  | 'furniture'
  | 'rack'
  | 'cable'
  | 'cargoRack'
  | 'locker'
  | 'lockerDoor'
  | 'hideShell'
  | 'panelBody'
  | 'slot'
  | 'hub'
  | 'laptop'
  // dark glass
  | 'glass'
  | 'screen'
  | 'panelScreen'
  // self-lit
  | 'interact'
  | 'indicatorAmber'
  | 'indicatorGreen'
  | 'indicatorRed'
  | 'indicatorWhite'
  | 'indicatorIdle';

function spec(
  name: string,
  role: MaterialRole,
  color: number,
  roughness: number,
  metalness: number,
  extra: Partial<MaterialSpec> = {},
): MaterialSpec {
  // Frozen: one spec object is shared by every reader, and a stray mutation
  // would slip past `assertPaletteCoherent()` — which runs once, at import.
  return Object.freeze({
    name,
    role,
    shader: 'standard',
    side: 'front',
    hero: false,
    color,
    roughness,
    metalness,
    emissive: 0x000000,
    emissiveIntensity: 0,
    ...extra,
  });
}

/** The yellow half of a hazard stripe. Also `warning`'s paint colour. */
export const HAZARD_YELLOW = 0xe8c21a;
/** The dark half of a hazard stripe. Also `rubber`. */
export const HAZARD_DARK = 0x14171a;

/**
 * THE PALETTE. Lightness is spread deliberately across the L\* axis — a station
 * is grey, so two mid-tone greys are the default failure mode and the check
 * exists to catch it. Read the `hero` flags as "the check is watching this one".
 */
export const PALETTE: Readonly<Record<PaletteName, MaterialSpec>> = Object.freeze({
  // ---------------------------------------------------------------- structure
  /** Hull interior. `back` side: you are always inside, the outward half of
   *  every wall is wasted fill. This is the REFERENCE the contrast metric
   *  measures everything else against. L* 48. */
  hull: spec('hull', 'surface', 0x6b7370, 0.92, 0.05, { side: 'back', hero: true }),
  /** Hull structure — ring frames, endcaps, window surrounds. Reads as the
   *  skeleton behind the skin, so it is lighter and more metallic than the
   *  hull. `double` because a ring is seen from both faces. Legacy: `trim`. */
  structure: spec('structure', 'surface', 0x9aa3a0, 0.55, 0.35, { side: 'double' }),
  /** Painted metal: fixture bodies, bulkheads, equipment cases. The station's
   *  default "manufactured object" surface. */
  painted: spec('painted', 'surface', 0x46545c, 0.62, 0.18),
  /** Brushed aluminium: machined parts, gauge bezels, lever shafts. High
   *  metalness so the torch sweeps a highlight across it — that travelling
   *  highlight is the only motion cue an inert prop gets. */
  aluminium: spec('aluminium', 'surface', 0xa9b0b4, 0.38, 0.78),
  /** Hatch frames and coaming rings. Brighter than `structure` so a doorway
   *  edge reads before the door inside it does. */
  frame: spec('frame', 'surface', 0xb0b8b5, 0.45, 0.6),
  /** Hatch door leaf. `double` — you see the back of it when it swings. */
  door: spec('door', 'surface', 0x8d9490, 0.55, 0.45, { side: 'double' }),

  // --------------------------------------------------------------------- deck
  /** Deck plate. Cooler and much darker than the hull so the flashlight cone
   *  reads as a POOL on the ground rather than a smear on a wall — that
   *  distinction is the whole reason gravity modules feel like rooms. */
  deck: spec('deck', 'surface', 0x3f4a4e, 1, 0.08, { hero: true }),
  /** Deck grating. Darker and far more metallic than plate: the bible asks
   *  grating and plate to differentiate footstep TIMBRE, and a player has to be
   *  able to see which one they are about to step onto before they hear it. */
  grating: spec('grating', 'surface', 0x212829, 0.7, 0.45, { hero: true }),

  // --------------------------------------------------------- movement grammar
  /**
   * HANDRAIL. The single most readable material in the game, and the check
   * proves it: highest contrast against the hull of any surface, by at least
   * `RAIL_CONTRAST_MARGIN`.
   *
   * Pale ice-blue albedo does the work inside the torch cone; the cool self-lit
   * core (`emissive` at `emissiveIntensity` 1) does it at the cone's edge and
   * in the fog beyond, where albedo contributes nothing. Rails only exist in
   * `gravity: 'zero'` modules now (§4), and there they are the only way to
   * move, so "findable before you can use it" is a mechanical requirement and
   * not a stylistic one.
   */
  rail: spec('rail', 'surface', 0xdcecfa, 0.34, 0.1, {
    hero: true,
    emissive: 0x2f6ea8,
    emissiveIntensity: 1,
  }),

  // ----------------------------------------------------------------- markings
  /** Warning yellow. PAINT, not a light: it is bright in the beam and black
   *  out of it, which is exactly the difference between a marking and a
   *  promise. Nothing painted yellow is claimed to be interactable. */
  warning: spec('warning', 'surface', HAZARD_YELLOW, 0.6, 0.1, { hero: true }),
  /**
   * Hazard stripe. `vertexColors` so one material, one draw call and one
   * program cover every striped band in the station (`hazardStripeBand()` in
   * artKit paints the alternation). `color` is white because vertex colour
   * MULTIPLIES it; `swatch` is what the checks judge.
   *
   * Geometry carrying this material must have a `color` attribute or the band
   * renders black — and it may only be merged with other vertex-coloured
   * geometry, because `mergeGeometries` requires matching attribute sets.
   */
  hazard: spec('hazard', 'surface', 0xffffff, 0.7, 0.08, {
    vertexColors: true,
    swatch: HAZARD_YELLOW,
  }),

  // ------------------------------------------------- soft goods, small parts
  /** Soft plastic: grips, caps, housings, handle cores. Warm and dead matte,
   *  so a moulded part never reads as machined metal. */
  plastic: spec('plastic', 'surface', 0x9c9280, 0.85, 0),
  /** Fabric and webbing: straps, stowage nets, bunk curtains. Olive drab at
   *  full roughness — the only material in the palette with no specular at all,
   *  which is what sells "not rigid" in a torch beam. */
  webbing: spec('webbing', 'surface', 0x4d5140, 1, 0),
  /** Rubber: feet, seals, hatch gaskets, tool grips. Near-black, so it reads as
   *  a gap in a silhouette rather than as a part. */
  rubber: spec('rubber', 'surface', HAZARD_DARK, 0.95, 0.02),
  /** Copper/brass, for valve wheels and plumbing. The bible is explicit: brass
   *  is how a player knows a coolant valve is PLUMBING and not electronics, so
   *  it is hero and it is the only warm metal in the station. */
  brass: spec('brass', 'surface', 0xc0862f, 0.42, 0.85, { hero: true }),
  /** Stowage soft-goods: bags, bundles, Velcro'd-down sacks. */
  stowage: spec('stowage', 'surface', 0xb8ac94, 1, 0),

  // -------------------------------------------------------------------- bodies
  /**
   * PALE ORGANIC — the alien. No eyes, no accent, no glow: it hunts by sound
   * and a lit eye would be both a cliché and a lie about the mechanic. Its
   * pale value against a dark hull is its ONLY cue, which is why this is hero
   * and why it sits 28 L\* above the hull.
   */
  organic: spec('organic', 'surface', 0xb7bda6, 0.55, 0, { hero: true }),
  /**
   * Suit fabric — a crewmate. Deliberately the second-highest-contrast surface
   * in the game and a full 15 units of low-light distance from `organic`:
   * mistaking a crewmate for the alien at 10 m in a dark tube must be relief,
   * never confusion. Per-player identity is a colour band, not this material
   * (see `AccentChannel` and `attachAccent`).
   */
  suit: spec('suit', 'surface', 0xd8e0ea, 0.75, 0.04, { hero: true }),

  // ------------------------------------------------- fixtures and furniture
  /** Deck furniture: bulkheads, benches, banks, coamings. Chase geometry (§2),
   *  so it reads as part of the room rather than as a prop. */
  furniture: spec('furniture', 'surface', 0x4d5450, 0.85, 0.18),
  /** Equipment racks — 64 instances, the visual bulk of the station, and
   *  INERT. Nothing on a rack glows, ever. */
  rack: spec('rack', 'surface', 0x555c59, 0.88, 0.12),
  /** Cable bundles. Almost black and fully rough: a cable run should read as a
   *  sagging line, never as a pipe. */
  cable: spec('cable', 'surface', 0x24282a, 0.96, 0),
  /** Cargo rack for §11 puzzle 3. */
  cargoRack: spec('cargoRack', 'surface', 0x4a534f, 0.8, 0.25),
  /** Stowage locker body. Lootable, so the locker itself carries an accent —
   *  the BODY does not glow, the accent does. */
  locker: spec('locker', 'surface', 0x4a5b63, 0.7, 0.2),
  /** Locker door leaf. Lighter than the body so an open door reads as open from
   *  across a module, before you can see into it. */
  lockerDoor: spec('lockerDoor', 'surface', 0x6f8590, 0.55, 0.3, {
    emissive: 0x06161c,
    emissiveIntensity: 1,
  }),
  /**
   * Hide-spot shells (§4). Notably lighter than `furniture` and 16 units of
   * low-light distance from the `hull`: a box you can get INTO must be
   * distinguishable from a console you cannot, and from the wall behind it. The
   * faint emissive is a hair of ambient pickup so a shell's mouth is visible
   * from inside; it is nowhere near the accent's output (`ACCENT_DOMINANCE`).
   */
  hideShell: spec('hideShell', 'surface', 0x8c9993, 0.7, 0.25, {
    hero: true,
    emissive: 0x0b1512,
    emissiveIntensity: 0.5,
  }),
  /** Puzzle-panel body — the bezel around a canvas readout. Dark so the
   *  readout is the brightest thing on the fixture. Legacy: `panel`. */
  panelBody: spec('panelBody', 'surface', 0x22282b, 0.6, 0.4),
  /** Cargo slot recess (§11 puzzle 3). Emptiness is the message, so the recess
   *  is darker than the rack it sits in. */
  slot: spec('slot', 'surface', 0x3c4643, 0.8, 0.2),
  /** Junction hub shells. Infrastructure — inert. */
  hub: spec('hub', 'surface', 0x8b9490, 0.5, 0.4),
  /**
   * Crew laptop body. The faintest glow in the palette (output ≈ 10, against
   * the accent's 153): the bible calls for "screen dark with a faint glow" and
   * an accent that is "a small power light only". A laptop is instanced, so the
   * glow is baked into the shared material and the power LED is a separate
   * accent placement.
   */
  laptop: spec('laptop', 'surface', 0x181c1e, 0.5, 0, {
    emissive: 0x0d3242,
    emissiveIntensity: 0.55,
  }),

  // ---------------------------------------------------------------- dark glass
  /** Cupola panes. `double` — you see them from inside and edge-on. The only
   *  window in the level and the only relief in it. */
  glass: spec('glass', 'glass', 0x05070d, 0.12, 0.85, {
    side: 'double',
    emissive: 0x0a1428,
    emissiveIntensity: 0.6,
  }),
  /** Dark screen glass: dead displays, laptop screens, gauge covers. Low
   *  roughness and high metalness so it catches the torch as a hard sheet
   *  reflection — a black rectangle that FLASHES is a screen; one that does not
   *  is a hole. */
  screen: spec('screen', 'glass', 0x0b1116, 0.18, 0.6, {
    emissive: 0x0a1a26,
    emissiveIntensity: 0.4,
  }),
  /** Live puzzle readout. Unlit `basic`, because the UI agent replaces it
   *  wholesale with a `CanvasTexture` material (§6) and a canvas does not want
   *  shading. */
  panelScreen: spec('panelScreen', 'glass', 0x0b2a33, 1, 0, { shader: 'basic' }),

  // ------------------------------------------------------------------ self-lit
  /**
   * THE INTERACTABLE ACCENT. The only material in the game that means "you can
   * touch this". Attach it through `attachAccent()` in artKit, never by hand:
   * the helper fixes the size and the brightness so six authors produce one
   * cue, and its `InteractKind` argument makes it impossible to put an accent
   * on an inert prop by accident.
   *
   * `toneMapped: false` keeps it out of ACES so it clears the §9 bloom
   * threshold — a 22 mm dot has to bloom or it is invisible at 8 m.
   */
  interact: spec('interact', 'accent', 0xff8c14, 1, 0, {
    channel: 'amber',
    emissive: 0xff8c14,
    emissiveIntensity: 2.2,
    toneMapped: false,
  }),
  /** Amber STATE lamp, on fixtures that already carry an accent. Same channel
   *  as `interact` by construction — "an action is relevant here" — so it is
   *  not a false positive. Never put this on something inert. */
  indicatorAmber: spec('indicatorAmber', 'indicator', 0xff8c14, 1, 0, {
    channel: 'amber',
    emissive: 0xff8c14,
    emissiveIntensity: 2.5,
    toneMapped: false,
  }),
  /** Green: system nominal. Hatch open, floor present, gauge in band. The
   *  bible reserves green for exactly this, so keep it rare. */
  indicatorGreen: spec('indicatorGreen', 'indicator', 0x30ff90, 1, 0, {
    channel: 'green',
    emissive: 0x30ff90,
    emissiveIntensity: 2.5,
    toneMapped: false,
  }),
  /** Red: this will kill you. Sealed hatch, airlock outer door. Mistaking
   *  sealed for merely closed is a death, so red is never used for anything
   *  else — not for errors, not for power, not for style. */
  indicatorRed: spec('indicatorRed', 'indicator', 0xff2a2a, 1, 0, {
    channel: 'red',
    emissive: 0xff2a2a,
    emissiveIntensity: 2.5,
    toneMapped: false,
  }),
  /** White: here is a reading. Instrument backlights, gauge tick marks. */
  indicatorWhite: spec('indicatorWhite', 'indicator', 0xcfe8ff, 1, 0, {
    channel: 'white',
    emissive: 0xcfe8ff,
    emissiveIntensity: 2,
    toneMapped: false,
  }),
  /** Idle: present, unpowered. A closed hatch, a dead console. Dim enough
   *  (output ≈ 33) that it locates a thing without promising anything about
   *  it — the honest reading of the bible's "dark closed". */
  indicatorIdle: spec('indicatorIdle', 'indicator', 0x5f7480, 1, 0, {
    channel: 'idle',
    emissive: 0x5f7480,
    emissiveIntensity: 0.7,
    toneMapped: false,
  }),
});

/** Every palette key, for iteration and for the coherence check. */
export const PALETTE_NAMES: readonly PaletteName[] = Object.freeze(
  Object.keys(PALETTE) as PaletteName[],
);

// ===========================================================================
// Per-module looks (unchanged from r2 — the reasoning below still holds)
// ===========================================================================

export interface LightingLook {
  color: number;
  emissive: number;
  intensity: number;
}

/**
 * The deck edge is the only thing in a dark module that tells you which way is
 * down, so it also tells you whether the floor still works (§4 gravity failure)
 * — and, via `createModeMarkerMaterial`, whether the floor works on the OTHER
 * side of a hatch you have not crossed yet (ISS-GRV-09).
 *
 * `nominal` is a cold running-light white-green: the plant is holding. `zero` is
 * a dim, near-dead amber that reads as "unpowered" rather than as "danger" —
 * §4 is explicit that a gravity failure is announced 2.5 s ahead by SOUND, and
 * a screaming red floor would quietly replace that with a visual warning that a
 * player facing the other way never sees.
 *
 * Its output (≈ 12) is a thirteenth of the accent's, so a dim amber floor line
 * cannot be mistaken for a thing you can touch.
 */
export const GRAVITY_LOOKS: Record<GravityMode, LightingLook> = {
  nominal: { color: 0xa8f0c8, emissive: 0x35ff8c, intensity: 1.6 },
  zero: { color: 0x6a5230, emissive: 0x6b4a12, intensity: 0.35 },
};

/** Five colour-coded cargo bags and their five matching slots (§11 puzzle 3).
 *  Numbering is unreadable in the dark; the bible numbers them by BAND COUNT
 *  and these tints are the redundant second cue, never the only one. */
export const CARGO_TINTS: readonly number[] = [
  0xff5a3c, 0xffc93c, 0x4cd964, 0x3ca8ff, 0xc77dff,
];

/** §10 — the station wakes on emergency lighting; puzzles restore it. */
export const LIGHTING_LOOKS: Record<LightingLevel, LightingLook> = {
  nominal: { color: 0xe8eeff, emissive: 0xdfe9ff, intensity: 2.4 },
  emergency: { color: 0xff7a3c, emissive: 0xff5a20, intensity: 1.15 },
  dark: { color: 0x141a1e, emissive: 0x0a1014, intensity: 0.06 },
};

// ===========================================================================
// The metric: low-light perceptual distance
// ===========================================================================

/**
 * How much a chroma difference counts, relative to a lightness difference.
 *
 * 0.4, and it is the most important number in this file. Scotopic and mesopic
 * vision lose chroma discrimination long before they lose lightness
 * discrimination, and this scene is fogged and lit by 5 candela. Weighting
 * chroma at full strength would let "two greys that differ only in hue" pass a
 * check they should fail — which is the same failure mode as a palette that is
 * unreadable to a colourblind player. One knob, both problems.
 */
export const CHROMA_WEIGHT = 0.4;

/**
 * How much a material's own glow counts toward its apparent lightness.
 *
 * 0.5. A surface's albedo term only exists while the torch is on it; the
 * emissive term is there always. Half-weighting the glow says "self-lit is
 * worth about as much as albedo across the average of in-beam and out-of-beam",
 * which is the honest average for a player sweeping a 23° cone around a room.
 */
export const SELF_LIT_WEIGHT = 0.5;

export interface Lab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** CIELAB (D65) for an sRGB hex. Perceptually uniform enough that a distance
 *  in it means something; cheap enough to run at import time. */
export function labOf(hex: number): Lab {
  const r = srgbToLinear(((hex >> 16) & 255) / 255);
  const g = srgbToLinear(((hex >> 8) & 255) / 255);
  const b = srgbToLinear((hex & 255) / 255);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * How much light a material makes on its own: emissive lightness × intensity.
 *
 * This is the number the whole "emissive is the readability budget" rule is
 * enforced in. A surface may sit at ≤ `SURFACE_GLOW_MAX`; the accent must beat
 * every surface by `ACCENT_DOMINANCE`.
 */
export function emissiveOutput(s: MaterialSpec): number {
  if (s.emissiveIntensity <= 0) return 0;
  return labOf(s.emissive).L * s.emissiveIntensity;
}

/**
 * Where a material sits perceptually once its own glow is counted: lightness
 * gains `SELF_LIT_WEIGHT × output`, and the hue slides from albedo toward the
 * emissive colour in proportion to how much of the look the glow is.
 */
export function apparentLab(s: MaterialSpec): Lab {
  const base = labOf(s.swatch ?? s.color);
  const out = emissiveOutput(s);
  if (out <= 0) return base;
  const em = labOf(s.emissive);
  const w = Math.min(1, out / 100);
  return {
    L: base.L + out * SELF_LIT_WEIGHT,
    a: base.a * (1 - w) + em.a * w,
    b: base.b * (1 - w) + em.b * w,
  };
}

/** Perceptual distance between two materials as a player sees them in the dark:
 *  full weight on lightness, `CHROMA_WEIGHT` on hue. */
export function lowLightDistance(a: MaterialSpec, b: MaterialSpec): number {
  const p = apparentLab(a);
  const q = apparentLab(b);
  const dL = p.L - q.L;
  const da = (p.a - q.a) * CHROMA_WEIGHT;
  const db = (p.b - q.b) * CHROMA_WEIGHT;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** How far a material stands off the hull — the station's background value.
 *  This is the findability score the handrail has to win. */
export function hullContrast(s: MaterialSpec, hull: MaterialSpec = PALETTE.hull): number {
  return Math.abs(apparentLab(s).L - apparentLab(hull).L);
}

/**
 * The three.js program cache key for a spec — see the file header. Two specs
 * with the same key share one compiled shader no matter how different they
 * look; two specs with different keys cost `Renderer.prewarm()` a link each.
 */
export function programKey(s: MaterialSpec): string {
  return [
    s.shader,
    s.side,
    s.vertexColors ? 'vc' : '-',
    s.toneMapped === false ? 'raw' : 'tm',
  ].join('|');
}

/** Distinct program keys a palette needs. */
export function paletteProgramKeys(
  palette: Readonly<Record<PaletteName, MaterialSpec>> = PALETTE,
): readonly string[] {
  return [...new Set(PALETTE_NAMES.map((n) => programKey(palette[n])))].sort();
}

// ===========================================================================
// Thresholds
// ===========================================================================

/**
 * Just-noticeable difference between two HERO surfaces in a torch beam at
 * range, in the chroma-discounted metric above.
 *
 * 9. A lab JND is ~2.3 ΔE for two swatches touching under good light; this is
 * two objects several metres apart, in fog, lit by 5 candela, glimpsed. 9 is
 * roughly four lab JNDs and the tightest hero pair in the palette
 * (`organic` / `hideShell`, 12.6) clears it with margin.
 */
export const JND_LOW_LIGHT = 9;

/**
 * Just-noticeable difference between two self-lit CHANNELS. Higher (16) than
 * `JND_LOW_LIGHT` because a channel confusion is a wrong decision, not a
 * misread surface: amber-for-red means you touch a sealed hatch. The tightest
 * channel pair (`amber` / `red`, 27.8) clears it comfortably.
 */
export const JND_LIT = 16;

/** How far ahead of the next-best surface the handrail must sit. 10 — enough
 *  that a lighting change or a later tweak cannot silently dethrone it. */
export const RAIL_CONTRAST_MARGIN = 10;

/** No hero surface may be closer than this to the hull, or it vanishes into
 *  the wall it is standing against. */
export const HERO_MIN_CONTRAST = 8;

/** A surface is a surface. Above this it is a light, and the accent's promise
 *  starts leaking. 50 — just above the handrail's 45, which is the one surface
 *  allowed to glow this much and the reason the ceiling is here at all. */
export const SURFACE_GLOW_MAX = 50;

/** How far the accent must out-glow the glowiest surface. 2.5×. Below that, a
 *  player scanning a dark module cannot tell the promise from the scenery. */
export const ACCENT_DOMINANCE = 2.5;

/**
 * Program keys the palette may spend. 6 in use, 2 spare.
 *
 * Not an arbitrary cap: each key is a shader `Renderer.prewarm()` links at
 * boot, measured at ~20 ms, and prewarm is what keeps first-visit frames off
 * the 77 ms hitch that motivated it. Spend a spare deliberately.
 */
export const PROGRAM_KEY_BUDGET = 8;

// ===========================================================================
// The self-check
// ===========================================================================

export class PaletteCoherenceError extends Error {
  readonly failures: readonly string[];
  constructor(failures: readonly string[]) {
    super(
      `station palette coherence failed (${failures.length}):\n  - ${failures.join('\n  - ')}`,
    );
    this.name = 'PaletteCoherenceError';
    this.failures = failures;
  }
}

/**
 * Every promise this palette makes, as machinery rather than prose.
 *
 * In the spirit of `assertConstantsCoherent()`: each check below corresponds to
 * a line in the art direction that a future edit would otherwise break
 * silently, months before anyone noticed. Re-run it whenever you touch a
 * number. It throws `PaletteCoherenceError` listing every failure at once,
 * because fixing them one exception at a time is how you end up chasing your
 * own tail around a colour wheel.
 *
 * `palette` is a parameter so a proposed change can be checked before it is
 * committed to the table — pass `{ ...PALETTE, rail: { ...PALETTE.rail, ... } }`
 * and find out whether your new rail still wins.
 */
export function assertPaletteCoherent(
  palette: Readonly<Record<PaletteName, MaterialSpec>> = PALETTE,
): void {
  const fail: string[] = [];
  const check = (ok: boolean, msg: string): void => {
    if (!ok) fail.push(msg);
  };
  const hull = palette.hull;
  const contrast = (s: MaterialSpec): number => hullContrast(s, hull);

  const all = PALETTE_NAMES.map((n) => palette[n]);
  const surfaces = all.filter((s) => s.role === 'surface');
  const lit = all.filter((s) => s.role === 'accent' || s.role === 'indicator');
  const accents = all.filter((s) => s.role === 'accent');

  // 0 — the table is self-consistent.
  for (const name of PALETTE_NAMES) {
    check(
      palette[name].name === name,
      `naming: PALETTE.${name} is labelled "${palette[name].name}"`,
    );
  }
  check(
    accents.length === 1,
    `accent: exactly one material may mean "you can touch this"; found ${accents.length} (${accents
      .map((s) => s.name)
      .join(', ')})`,
  );
  const accent = accents[0] as MaterialSpec;

  // 1 — THE HANDRAIL IS THE MOST READABLE SURFACE IN THE GAME.
  //
  // Scoped to `surface` on purpose, and the scoping is the argument: an
  // indicator is a LAMP, not something an object is made of. Its area is capped
  // by `ACCENT_SIZE_M` (checked in artKit), so a 22 mm dot at output 153 cannot
  // out-read 0.8 m of rail — but its per-pixel brightness certainly beats it,
  // and pretending otherwise would make this check lie.
  const railContrast = contrast(palette.rail);
  // Reported as ONE failure listing the worst offenders rather than one per
  // material: dulling the rail crowds it against all thirty surfaces at once,
  // and thirty near-identical lines buries the number that matters.
  const crowding = surfaces
    .filter((s) => s.name !== 'rail' && railContrast - contrast(s) < RAIL_CONTRAST_MARGIN)
    .map((s) => ({ name: s.name, contrast: contrast(s) }))
    .sort((a, b) => b.contrast - a.contrast);
  check(
    crowding.length === 0,
    `handrail: the rail contrasts ${railContrast.toFixed(1)} against the hull and ` +
      `${crowding.length} surface(s) come within ${RAIL_CONTRAST_MARGIN} of it — worst: ` +
      `${crowding
        .slice(0, 3)
        .map((c) => `"${c.name}" at ${c.contrast.toFixed(1)}`)
        .join(', ')}. The rail is the movement grammar in every zero-G module and it is ` +
      `the only way to move there; nothing may crowd it.`,
  );

  // 2 — no hero surface disappears into the wall it stands against.
  for (const s of surfaces) {
    if (!s.hero || s.name === 'hull') continue;
    check(
      contrast(s) >= HERO_MIN_CONTRAST,
      `hero contrast: "${s.name}" is only ${contrast(s).toFixed(1)} from the hull ` +
        `(floor ${HERO_MIN_CONTRAST}) — a hero material a player cannot separate from the ` +
        `wall behind it is not doing its job`,
    );
  }

  // 3 — NO TWO HERO MATERIALS ARE WITHIN A JND. This is silhouette rule 1
  //     expressed in colour: two things that matter never read the same.
  const heroes = surfaces.filter((s) => s.hero);
  for (let i = 0; i < heroes.length; i++) {
    for (let j = i + 1; j < heroes.length; j++) {
      const a = heroes[i] as MaterialSpec;
      const b = heroes[j] as MaterialSpec;
      const d = lowLightDistance(a, b);
      check(
        d >= JND_LOW_LIGHT,
        `hero pair: "${a.name}" and "${b.name}" are ${d.toFixed(1)} apart in low light ` +
          `(need ${JND_LOW_LIGHT}) — they will read as the same material in a torch beam`,
      );
    }
  }

  // 4 — the five self-lit channels are pairwise unmistakable, and none of them
  //     can be mistaken for a handrail's glow.
  const byChannel = new Map<AccentChannel, MaterialSpec>();
  for (const s of lit) {
    check(s.channel !== undefined, `channel: "${s.name}" is self-lit but declares no channel`);
    if (s.channel && !byChannel.has(s.channel)) byChannel.set(s.channel, s);
  }
  const channels = [...byChannel.entries()];
  for (let i = 0; i < channels.length; i++) {
    for (let j = i + 1; j < channels.length; j++) {
      const [ca, a] = channels[i] as [AccentChannel, MaterialSpec];
      const [cb, b] = channels[j] as [AccentChannel, MaterialSpec];
      const d = lowLightDistance(a, b);
      check(
        d >= JND_LIT,
        `channel pair: "${ca}" and "${cb}" are ${d.toFixed(1)} apart (need ${JND_LIT}) — ` +
          `a channel confusion is a wrong decision, not a misread surface`,
      );
    }
  }
  for (const [ch, s] of channels) {
    const d = lowLightDistance(s, palette.rail);
    check(
      d >= JND_LIT,
      `channel vs rail: "${ch}" is ${d.toFixed(1)} from the handrail (need ${JND_LIT}) — ` +
        `a rail read as an indicator is a grab that never comes`,
    );
  }

  // 5 — emissive intensities sit in a sane band, per role.
  for (const s of all) {
    const band = EMISSIVE_BANDS[s.role];
    if (s.emissiveIntensity === 0) {
      check(
        band.min === 0,
        `emissive band: "${s.name}" is a ${s.role} and must be self-lit ` +
          `(band ${band.min}–${band.max}) but has intensity 0`,
      );
      continue;
    }
    check(
      s.emissiveIntensity >= band.min && s.emissiveIntensity <= band.max,
      `emissive band: "${s.name}" (${s.role}) has intensity ${s.emissiveIntensity}, ` +
        `outside the ${band.min}–${band.max} band for its role`,
    );
  }
  for (const look of [...Object.values(LIGHTING_LOOKS), ...Object.values(GRAVITY_LOOKS)]) {
    const band = EMISSIVE_BANDS.strip;
    check(
      look.intensity >= band.min && look.intensity <= band.max,
      `emissive band: a strip/edge look has intensity ${look.intensity}, ` +
        `outside the ${band.min}–${band.max} strip band`,
    );
  }

  // 6 — EMISSIVE IS THE READABILITY BUDGET. A surface is a surface; the accent
  //     out-glows every one of them by a margin a player can act on.
  let worstSurfaceGlow = 0;
  let worstSurfaceName = '(none)';
  for (const s of surfaces) {
    const out = emissiveOutput(s);
    if (out > worstSurfaceGlow) {
      worstSurfaceGlow = out;
      worstSurfaceName = s.name;
    }
    check(
      out <= SURFACE_GLOW_MAX,
      `surface glow: "${s.name}" emits ${out.toFixed(1)} (ceiling ${SURFACE_GLOW_MAX}) — ` +
        `above this it is a light, and every glowing surface devalues the accent`,
    );
  }
  const accentGlow = emissiveOutput(accent);
  check(
    accentGlow >= worstSurfaceGlow * ACCENT_DOMINANCE,
    `accent dominance: the accent emits ${accentGlow.toFixed(1)} against "${worstSurfaceName}"'s ` +
      `${worstSurfaceGlow.toFixed(1)} — needs ${ACCENT_DOMINANCE}× so a player scanning a dark ` +
      `module can tell the promise from the scenery`,
  );

  // 7 — nothing may GLOW in the accent's hue. Yellow PAINT is fine: it is
  //     bright in the beam and black out of it, so it never promises anything.
  //     A glowing yellow surface is a promise the game cannot keep.
  const flat = (s: MaterialSpec): MaterialSpec => ({ ...s, emissive: 0x000000, emissiveIntensity: 0 });
  for (const s of [...surfaces, ...all.filter((m) => m.role === 'glass')]) {
    if (emissiveOutput(s) <= 0) continue;
    const hueGap = lowLightDistance(flat(s), flat(accent));
    check(
      hueGap >= JND_LOW_LIGHT,
      `false accent: "${s.name}" glows and its albedo is only ${hueGap.toFixed(1)} from the ` +
        `accent's hue — one false positive costs every true one`,
    );
  }
  for (const tint of CARGO_TINTS) {
    const s = cargoSpec(tint);
    check(
      emissiveOutput(s) <= SURFACE_GLOW_MAX,
      `cargo tint 0x${tint.toString(16)} emits ${emissiveOutput(s).toFixed(1)}, over the ` +
        `${SURFACE_GLOW_MAX} surface ceiling`,
    );
  }

  // 8 — the palette stays inside its shader budget (see the file header).
  const keys = paletteProgramKeys(palette);
  check(
    keys.length <= PROGRAM_KEY_BUDGET,
    `program budget: the palette needs ${keys.length} distinct shader programs ` +
      `(${keys.join(', ')}), over the ${PROGRAM_KEY_BUDGET} Renderer.prewarm() is budgeted for`,
  );

  if (fail.length > 0) throw new PaletteCoherenceError(fail);
}

/** Emissive intensity a material of each role is allowed to sit in. */
export const EMISSIVE_BANDS: Readonly<Record<MaterialRole, { min: number; max: number }>> =
  Object.freeze({
    /** A surface may whisper. `rail` at 1.0 is the loudest legal whisper. */
    surface: { min: 0, max: 1.2 },
    /** Dark glass picks up a hint of the room so a pane is not a void. */
    glass: { min: 0, max: 1 },
    /** The accent has to bloom or a 22 mm dot is invisible at 8 m. */
    accent: { min: 1.6, max: 3 },
    /** `idle` at 0.7 is the floor: present, unpowered, not inviting. */
    indicator: { min: 0.5, max: 3 },
    /** `LIGHTING_LOOKS.dark` at 0.06 is the floor — near-dead, not dead. */
    strip: { min: 0.05, max: 3 },
  });

function cargoSpec(tint: number): MaterialSpec {
  return spec(`cargo-${tint.toString(16)}`, 'surface', tint, 0.85, 0, {
    emissive: tint,
    emissiveIntensity: 0.28,
  });
}

function isDevEnvironment(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env && typeof env.DEV === 'boolean') return env.DEV;
  } catch {
    /* import.meta.env is absent under plain Node — fall through. */
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc && proc.env) return proc.env.NODE_ENV !== 'production';
  return true;
}

/** True when the palette check ran and passed at import time (dev only). */
export const PALETTE_CHECKED: boolean = (() => {
  if (!isDevEnvironment()) return false;
  assertPaletteCoherent();
  return true;
})();

// ===========================================================================
// The factory
// ===========================================================================

/**
 * One material object per palette entry, shared by every mesh in the station.
 *
 * Named fields rather than a bare map because six agents autocomplete against
 * them, and because the legacy names (`trim`, `panel`, `indicatorOpen`, …) have
 * to keep working — a lot of code already imports this class. Every field is a
 * reference into the same `byName` record, so `dispose()` is exact and two
 * names for the same look really are one program and one uniform block.
 */
export class StationMaterials {
  /** Every palette entry by name. Use this from generic code; use the named
   *  fields from asset code, where the name is documentation. */
  readonly byName: Readonly<Record<PaletteName, THREE.Material>>;

  // ------------------------------------------------------------- structure ---
  readonly hull: THREE.MeshStandardMaterial;
  /** Hull structure. `trim` is the legacy name for the same material. */
  readonly structure: THREE.MeshStandardMaterial;
  readonly trim: THREE.MeshStandardMaterial;
  readonly painted: THREE.MeshStandardMaterial;
  readonly aluminium: THREE.MeshStandardMaterial;
  readonly frame: THREE.MeshStandardMaterial;
  readonly door: THREE.MeshStandardMaterial;

  // ------------------------------------------------------------------ deck ---
  /** Deck tread. Deliberately unlike the hull so the floor reads as a floor. */
  readonly deck: THREE.MeshStandardMaterial;
  /** Open grating. Pair it with a different footstep sound, never without. */
  readonly grating: THREE.MeshStandardMaterial;

  // ------------------------------------------------------ movement grammar ---
  /** §9: "Handrails get a high-contrast material from day one." The highest
   *  contrast in the game, and `assertPaletteCoherent()` keeps it that way. */
  readonly rail: THREE.MeshStandardMaterial;

  // -------------------------------------------------------------- markings ---
  readonly warning: THREE.MeshStandardMaterial;
  /** Vertex-coloured. For geometry from `hazardStripeBand()` and `labelPlate()`. */
  readonly hazard: THREE.MeshStandardMaterial;
  /**
   * The palette's ONE vertex-coloured program, under its honest name. Same
   * material object as `hazard`; use whichever name describes what you are
   * building, and remember that its geometry must carry a `color` attribute
   * (`withVertexColor()`) or it renders black.
   */
  readonly vertexPainted: THREE.MeshStandardMaterial;

  // ----------------------------------------------- soft goods, small parts ---
  readonly plastic: THREE.MeshStandardMaterial;
  readonly webbing: THREE.MeshStandardMaterial;
  readonly rubber: THREE.MeshStandardMaterial;
  readonly brass: THREE.MeshStandardMaterial;
  readonly stowage: THREE.MeshStandardMaterial;

  // ---------------------------------------------------------------- bodies ---
  /** The alien. No accent, ever — it has no eyes and it hunts by sound. */
  readonly organic: THREE.MeshStandardMaterial;
  readonly suit: THREE.MeshStandardMaterial;

  // ------------------------------------------- fixtures, furniture, shells ---
  /** Deck furniture: bulkheads, benches, banks, coamings. */
  readonly furniture: THREE.MeshStandardMaterial;
  readonly rack: THREE.MeshStandardMaterial;
  readonly cable: THREE.MeshStandardMaterial;
  readonly cargoRack: THREE.MeshStandardMaterial;
  readonly locker: THREE.MeshStandardMaterial;
  readonly lockerDoor: THREE.MeshStandardMaterial;
  /** Hide spot shells — lighter than the furniture so a locker you can get
   *  INTO is distinguishable from a console you cannot. */
  readonly hideShell: THREE.MeshStandardMaterial;
  /** Puzzle panel body. `panel` is the legacy name for the same material. */
  readonly panelBody: THREE.MeshStandardMaterial;
  readonly panel: THREE.MeshStandardMaterial;
  readonly slot: THREE.MeshStandardMaterial;
  readonly hub: THREE.MeshStandardMaterial;
  readonly laptop: THREE.MeshStandardMaterial;

  // ------------------------------------------------------------ dark glass ---
  readonly glass: THREE.MeshStandardMaterial;
  readonly screen: THREE.MeshStandardMaterial;
  /** Replaced wholesale by the UI agent's CanvasTexture (§6). */
  readonly panelScreen: THREE.MeshBasicMaterial;

  // -------------------------------------------------------------- self-lit ---
  /** THE interactable accent. Reach for `attachAccent()` before this. */
  readonly interact: THREE.MeshStandardMaterial;
  readonly indicatorAmber: THREE.MeshStandardMaterial;
  readonly indicatorGreen: THREE.MeshStandardMaterial;
  readonly indicatorRed: THREE.MeshStandardMaterial;
  readonly indicatorWhite: THREE.MeshStandardMaterial;
  readonly indicatorIdle: THREE.MeshStandardMaterial;

  /** Hatch state, legacy names. Open = green, closed = idle (present but
   *  unpowered), sealed = red. Three geometrically distinct door positions back
   *  them up — colour is never the only cue. */
  readonly indicatorOpen: THREE.MeshStandardMaterial;
  readonly indicatorClosed: THREE.MeshStandardMaterial;
  readonly indicatorSealed: THREE.MeshStandardMaterial;

  private readonly strips: THREE.MeshStandardMaterial[] = [];
  private readonly edges: THREE.MeshStandardMaterial[] = [];
  private readonly cargo: THREE.MeshStandardMaterial[] = [];
  private readonly owned: THREE.Material[] = [];

  constructor() {
    const byName = {} as Record<PaletteName, THREE.Material>;
    for (const name of PALETTE_NAMES) byName[name] = this.own(build(PALETTE[name]));
    this.byName = Object.freeze(byName);

    const std = (name: PaletteName): THREE.MeshStandardMaterial =>
      byName[name] as THREE.MeshStandardMaterial;

    this.hull = std('hull');
    this.structure = std('structure');
    this.trim = this.structure;
    this.painted = std('painted');
    this.aluminium = std('aluminium');
    this.frame = std('frame');
    this.door = std('door');

    this.deck = std('deck');
    this.grating = std('grating');
    this.rail = std('rail');
    this.warning = std('warning');
    this.hazard = std('hazard');
    this.vertexPainted = this.hazard;

    this.plastic = std('plastic');
    this.webbing = std('webbing');
    this.rubber = std('rubber');
    this.brass = std('brass');
    this.stowage = std('stowage');

    this.organic = std('organic');
    this.suit = std('suit');

    this.furniture = std('furniture');
    this.rack = std('rack');
    this.cable = std('cable');
    this.cargoRack = std('cargoRack');
    this.locker = std('locker');
    this.lockerDoor = std('lockerDoor');
    this.hideShell = std('hideShell');
    this.panelBody = std('panelBody');
    this.panel = this.panelBody;
    this.slot = std('slot');
    this.hub = std('hub');
    this.laptop = std('laptop');

    this.glass = std('glass');
    this.screen = std('screen');
    this.panelScreen = byName.panelScreen as THREE.MeshBasicMaterial;

    this.interact = std('interact');
    this.indicatorAmber = std('indicatorAmber');
    this.indicatorGreen = std('indicatorGreen');
    this.indicatorRed = std('indicatorRed');
    this.indicatorWhite = std('indicatorWhite');
    this.indicatorIdle = std('indicatorIdle');

    this.indicatorOpen = this.indicatorGreen;
    this.indicatorClosed = this.indicatorIdle;
    this.indicatorSealed = this.indicatorRed;
  }

  /** The material for a self-lit channel. `amber` returns the ACCENT — the one
   *  that means "you can touch this" — so route interactable cues through
   *  `attachAccent()` and use this only when you are placing a state lamp. */
  indicatorFor(channel: AccentChannel): THREE.MeshStandardMaterial {
    switch (channel) {
      case 'amber':
        return this.indicatorAmber;
      case 'green':
        return this.indicatorGreen;
      case 'red':
        return this.indicatorRed;
      case 'white':
        return this.indicatorWhite;
      case 'idle':
        return this.indicatorIdle;
    }
  }

  /** A fresh light-strip material for one module, so lighting is per-module. */
  createStripMaterial(level: LightingLevel): THREE.MeshStandardMaterial {
    const look = LIGHTING_LOOKS[level];
    const m = new THREE.MeshStandardMaterial({
      color: look.color,
      emissive: look.emissive,
      emissiveIntensity: look.intensity,
      roughness: 1,
      toneMapped: false,
    });
    this.strips.push(m);
    return m;
  }

  /** A fresh deck-edge material for one module, so gravity state is per-module. */
  createEdgeMaterial(gravity: GravityMode): THREE.MeshStandardMaterial {
    const look = GRAVITY_LOOKS[gravity];
    const m = new THREE.MeshStandardMaterial({
      color: look.color,
      emissive: look.emissive,
      emissiveIntensity: look.intensity,
      roughness: 1,
      toneMapped: false,
    });
    this.edges.push(m);
    return m;
  }

  /**
   * Material for a mode threshold marker (ISS-GRV-09) on the near side of a
   * hatch, showing the gravity of the module BEYOND it.
   *
   * Identical to `createEdgeMaterial` on purpose. §4 makes the warning window
   * before a gravity failure a fairness guarantee, and a marker that could
   * disagree with the floor it is advertising would break exactly that promise
   * — so a marker and a deck edge are the same light, driven by the same
   * `applyGravity` call, and cannot drift apart. Differentiate the two by
   * GEOMETRY (bars for nominal, chevrons for zero); colour is never the only
   * cue and here it is not even a separate material.
   */
  createModeMarkerMaterial(gravity: GravityMode): THREE.MeshStandardMaterial {
    return this.createEdgeMaterial(gravity);
  }

  applyGravity(material: THREE.MeshStandardMaterial, gravity: GravityMode): void {
    const look = GRAVITY_LOOKS[gravity];
    material.color.setHex(look.color);
    material.emissive.setHex(look.emissive);
    material.emissiveIntensity = look.intensity;
    material.needsUpdate = true;
  }

  /** One of the five §11 cargo tints, shared by bag `index` and its slot. */
  createCargoMaterial(index: number): THREE.MeshStandardMaterial {
    const color = CARGO_TINTS[index % CARGO_TINTS.length] as number;
    const m = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.28,
      roughness: 0.85,
    });
    this.cargo.push(m);
    return m;
  }

  applyLighting(material: THREE.MeshStandardMaterial, level: LightingLevel): void {
    const look = LIGHTING_LOOKS[level];
    material.color.setHex(look.color);
    material.emissive.setHex(look.emissive);
    material.emissiveIntensity = look.intensity;
    material.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.owned) m.dispose();
    for (const m of this.strips) m.dispose();
    for (const m of this.edges) m.dispose();
    for (const m of this.cargo) m.dispose();
    this.owned.length = 0;
    this.strips.length = 0;
    this.edges.length = 0;
    this.cargo.length = 0;
  }

  private own<T extends THREE.Material>(m: T): T {
    this.owned.push(m);
    return m;
  }
}

const SIDES: Record<MaterialSide, THREE.Side> = {
  front: THREE.FrontSide,
  back: THREE.BackSide,
  double: THREE.DoubleSide,
};

/** Turn one spec into one three.js material. The only place in the codebase
 *  that should be calling a material constructor for station art. */
export function build(s: MaterialSpec): THREE.Material {
  if (s.shader === 'basic') {
    return new THREE.MeshBasicMaterial({
      color: s.color,
      side: SIDES[s.side],
      vertexColors: s.vertexColors === true,
      toneMapped: s.toneMapped !== false,
      fog: true,
    });
  }
  return new THREE.MeshStandardMaterial({
    color: s.color,
    roughness: s.roughness,
    metalness: s.metalness,
    emissive: s.emissive,
    emissiveIntensity: s.emissiveIntensity,
    side: SIDES[s.side],
    vertexColors: s.vertexColors === true,
    toneMapped: s.toneMapped !== false,
    fog: true,
  });
}
