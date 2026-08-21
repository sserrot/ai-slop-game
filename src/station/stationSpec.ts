/**
 * The authored station (DESIGN.md §2, §4, §10, §11).
 *
 * Nine modules — inside the §2 target of 8–10 at six players — arranged as an
 * ISS-ish spine with a genuine loop:
 *
 *        escape-soyuz ─ node-alpha ── tube-spine ── node-beta ─ airlock-eva
 *                            │                        │           (zero-G)
 *                       (direct mate)            (direct mate)
 *                            │                        │
 *                       node-delta ─── lab-atlas ── node-gamma
 *                            │
 *                       cupola-nadir
 *
 * The four nodes and the two corridors between them form a ring: alpha →
 * tube-spine → beta → gamma → lab-atlas → delta → alpha. §2 asks for "at least
 * one loop so it is not a pure line", and a loop you can physically run around
 * is worth far more than a longer dead-ended spine — it is the only geometry in
 * which a chase (§5) has an answer other than "push off and pray".
 *
 * The three dead ends are all deliberate: the cupola is an observation dome with
 * one way out, the airlock ends at vacuum, and the escape vehicle is a capsule
 * you undock from. Per §10 the escape module and the finale module are never
 * player spawns, which leaves seven spawnable modules for six players.
 *
 * ---------------------------------------------------------------------------
 * THE ZERO-G BUDGET — why these two, and not the other seven
 * ---------------------------------------------------------------------------
 *
 * §2 allows at most two authored `zero` modules out of eight to ten, and says to
 * "pick the two for meaning, not variety: a module where zero-G *is* the puzzle
 * (cargo stow, §11), and a module on a route people take under pressure." Both
 * slots are spent, and the reasoning matters more than the choice:
 *
 * **`tube-spine` — cargo stow, and the shortcut across the ring.** It does both
 * of §2's jobs at once, which is the only reason there is a slot left over.
 * Puzzle 3's five bags are the flagship use of the mechanic (and the reason
 * Rapier is in the build at all), and floating bags cannot exist in a room with
 * a floor. It is also the single busiest corridor on the map — the direct link
 * between the finale node and the breaker node — so the fast way across the
 * station is the way with nothing to stand on. Under a hunt that is a real
 * decision rather than a corridor: sprint in at 2.4 and you carry that speed
 * through (a `launch`, momentum conserved, and 8 loudness for the privilege),
 * or take the long walk round through delta, the lab and gamma.
 *
 * **`airlock-eva` — §11 puzzle 5, written for exactly this.** "Two keyswitches
 * four metres apart, turned within one second of each other. Trivial on the
 * ground; in zero-G both players must anchor to rails and count down over
 * voice." That puzzle is the reason the room exists, and on a floor it is a
 * two-second walk. It is also diegetically free — there is no gravity plant
 * outboard of the pressure hatch — and it is behind the one hatch the level
 * authors CLOSED, so entering costs a 45-loudness hatch cycle before you have
 * even lost the floor. §2 warns that "a zero-G dead end nobody enters is two
 * modules of budget spent on nothing"; this one is a required system, so
 * everybody enters it, twice, under pressure.
 *
 * **Why not the cupola, which used to be the obvious candidate.** See its
 * placement below: it was mated to node-delta's floor port and hung 2.7 m under
 * the deck. That is a fall of 2.7 m, which caps out `impactNoise` at 51 — a
 * full-speed crash every time anybody visits a fuse. Floating down it would have
 * worked and would have been atmospheric, but it would have spent the second
 * zero-G slot on a dead end to solve a problem that a horizontal mate deletes
 * outright. It is now a side dome at deck level, and §2's "a dead-end bay is not
 * escape geometry; it is a hiding place, and authoring one means authoring it as
 * one, knowingly" is exactly what it now is.
 *
 * ---------------------------------------------------------------------------
 * PANEL HEIGHTS — a whole class of bug the deck introduced
 * ---------------------------------------------------------------------------
 * Every wall panel used to be authored at whatever angle looked good, because in
 * zero-G you can float to any of them. With a deck at `DECK_Y_M` that stops
 * being true in both directions: a panel at 225° sits BELOW the floor, and a
 * panel on a node's +Y face sits 2.2 m over it. Both are now authored at axis
 * height (angle 0/180 on a tube, a side face on a node), which is 0.75 m over
 * the deck — chest height for a standing crew member, and still perfectly
 * reachable by a floating one if the plant fails.
 *
 * This file is browser-safe and pure. `buildLevel.ts` is the tsx script that
 * runs it and writes `levels/station.json`.
 */

import type { HideSpot, PropRef, StationLayout, Vec3 } from '@shared/types';
import { v3 } from '@shared/graph/math';
import { assembleStation } from './assemble';
import type { StationSpec } from './assemble';
import {
  CUPOLA_COLLAR_R,
  KIT,
  NODE_H,
  NODE_PANEL_OFFSET,
  PROP_ARCHETYPES,
  RACK_DEPTH,
  nodeClearFlank,
} from './kit';
import { CARGO_RACK_SIZE, CARGO_SLOT_PITCH, crewBunk, stowageNet } from './deckKit';
import { orientProp } from './transform';
import { randRange, rngFor } from './random';

/** Standoff of a panel's back face from the wall it is bolted to. */
const PANEL_INSET = RACK_DEPTH + PROP_ARCHETYPES.panel.size.y / 2 + 0.01;

/**
 * A puzzle panel on the wall of a cylindrical module.
 *
 * `angleDeg` should be 0 or 180 in any module that has a deck: those put the
 * panel at axis height, 0.75 m over the floor. See the header.
 */
function tubePanel(id: string, radius: number, angleDeg: number, z: number): PropRef {
  const a = (angleDeg * Math.PI) / 180;
  const r = radius - PANEL_INSET;
  return {
    id,
    kind: 'panel',
    localPos: v3(Math.cos(a) * r, Math.sin(a) * r, z),
    localQuat: orientProp(v3(-Math.cos(a), -Math.sin(a), 0), v3(0, 0, 1)),
    interactable: true,
  };
}

/**
 * A puzzle panel on one face of a node, offset along that face so it clears the
 * hatch opening in the middle and the racks above and below it.
 *
 * Use a SIDE face (±X, ±Z). The ±Y faces are the ceiling and the underside of
 * the deck; a panel on either is unreachable once the module has a floor.
 */
function nodePanel(id: string, faceNormal: Vec3, tangent: Vec3): PropRef {
  const inset = PROP_ARCHETYPES.panel.size.y / 2 + 0.02;
  const d = NODE_H - inset;
  // Always on the face's CLEAR flank — the side with no rack bay on it. The kit
  // arranges the four bays as a pinwheel and exports which side that leaves
  // free, so a level author can never bolt a breaker plate to the front of a
  // rack by picking the wrong sign.
  const offset = nodeClearFlank(faceNormal) * NODE_PANEL_OFFSET;
  return {
    id,
    kind: 'panel',
    localPos: v3(
      faceNormal.x * d + tangent.x * offset,
      faceNormal.y * d + tangent.y * offset,
      faceNormal.z * d + tangent.z * offset,
    ),
    localQuat: orientProp(
      v3(-faceNormal.x, -faceNormal.y, -faceNormal.z),
      tangent,
    ),
    interactable: true,
  };
}

/**
 * §11 puzzle 3 — the cargo rack, its five colour-coded slots, and the five
 * numbered bags that go in them.
 *
 * The rack was missing entirely: the level authored bare `slot` markers floating
 * on a wall with no structure behind them and nothing to put in them, which is
 * why the puzzle read as unbuilt. All three parts are authored together here so
 * the numbering, the tints and the geometry cannot drift.
 *
 * The bags are scattered loose down the bore rather than parked tidily: they are
 * rigid bodies (§1, client-authoritative, nearest player simulates), and the
 * puzzle is that moving one gently is slow and moving one hard costs 30 loudness
 * and then keeps costing it. A tidy starting state would have deleted the
 * puzzle's first minute.
 */
function cargoStow(moduleId: string, radius: number, count: number): PropRef[] {
  const out: PropRef[] = [];
  const rng = rngFor('cargo', moduleId);
  const slotInset = RACK_DEPTH + PROP_ARCHETYPES.slot.size.y / 2;
  const wallInward = v3(-1, 0, 0);

  out.push({
    id: `${moduleId}-cargo-rack`,
    kind: 'cargo-rack',
    localPos: v3(radius - CARGO_RACK_SIZE.y / 2, 0, 0),
    localQuat: orientProp(wallInward, v3(0, 0, 1)),
  });

  const span = CARGO_SLOT_PITCH * (count - 1);
  for (let i = 0; i < count; i++) {
    const z = -span / 2 + i * CARGO_SLOT_PITCH;
    out.push({
      id: `${moduleId}-cargo-slot-${i + 1}`,
      kind: 'slot',
      localPos: v3(radius - slotInset, 0, z),
      localQuat: orientProp(wallInward, v3(0, 0, 1)),
    });
    // Loose in the bore, clear of the rack face on +X and of the overhead rail
    // pair. Scattered across the WHOLE bore now rather than a 0.55 m sliver of
    // it: the module is 3 m across, the rails are up at `RAIL_Y_M`, and five
    // bags bunched on one side of a wide tube read as a dropped pallet rather
    // than as a stow that got away from somebody.
    out.push({
      id: `${moduleId}-cargo-bag-${i + 1}`,
      kind: 'cargo-bag',
      localPos: v3(
        randRange(rng, -radius * 0.5, radius * 0.15),
        randRange(rng, -radius * 0.45, radius * 0.35),
        z + randRange(rng, -0.3, 0.3),
      ),
      interactable: true,
    });
  }
  return out;
}

const X = v3(1, 0, 0);
const NX = v3(-1, 0, 0);
const Z = v3(0, 0, 1);
const NZ = v3(0, 0, -1);

/** An extra hide spot authored on top of whatever the kit piece provides. */
function extraSpots(...spots: HideSpot[]): HideSpot[] {
  return spots;
}

export const STATION_SPEC: StationSpec = {
  id: 'iss-station-01',
  name: 'ISS — Expedition 74',
  seed: 20260818,
  escapeModule: 'escape-soyuz',
  // §11 puzzle 6's master console sits next to the capsule; §10 keeps both out
  // of the spawn pool.
  finaleModule: 'node-alpha',
  placements: [
    // -- the ring ---------------------------------------------------------
    {
      id: 'node-alpha',
      kind: 'node',
      at: { pos: v3(0, 0, 0) },
      lighting: 'emergency',
      props: [
        // Undock lever 1 of 3 (§11 puzzle 6) plus the capsule-side console.
        // Both on side faces: the +Y face is 2.2 m over the deck now.
        nodePanel('node-alpha-panel-undock-1', NZ, X),
        nodePanel('node-alpha-panel-egress', NX, Z),
      ],
    },
    {
      // §2's "module where zero-G IS the puzzle", doubling as the shortcut
      // across the ring. See the header.
      id: 'tube-spine',
      kind: 'straight',
      gravity: 'zero',
      mate: { port: 'aft', to: { module: 'node-alpha', port: 'px' } },
      lighting: 'emergency',
      props: cargoStow('tube-spine', KIT.straight.radius, 5),
    },
    {
      id: 'node-beta',
      kind: 'node',
      mate: { port: 'nx', to: { module: 'tube-spine', port: 'fwd' } },
      lighting: 'emergency',
      props: [
        // §11 puzzle 1 — six breakers, the card is stowed in another module.
        nodePanel('node-beta-panel-breaker', Z, X),
        nodePanel('node-beta-panel-undock-2', NZ, X),
      ],
    },
    {
      id: 'node-gamma',
      kind: 'node',
      mate: { port: 'nz', to: { module: 'node-beta', port: 'pz' } },
      lighting: 'emergency',
      props: [
        // §11 puzzle 2 — the wheel. The gauge is a module away, in the lab.
        nodePanel('node-gamma-panel-valve', X, Z),
      ],
    },
    {
      id: 'lab-atlas',
      kind: 'lab',
      mate: { port: 'fwd', to: { module: 'node-gamma', port: 'nx' } },
      lighting: 'emergency',
      props: [
        // Axis height (0 / 180), so all three are at chest height over the deck.
        // These used to sit at 315° and 225°, i.e. 0.8 m UNDER the floor.
        tubePanel('lab-atlas-panel-gauge', KIT.lab.radius, 0, -0.2),
        tubePanel('lab-atlas-panel-fuse-1', KIT.lab.radius, 180, 1.2),
        tubePanel('lab-atlas-panel-undock-3', KIT.lab.radius, 180, -1.2),
      ],
    },
    {
      id: 'node-delta',
      kind: 'node',
      mate: { port: 'px', to: { module: 'lab-atlas', port: 'aft' } },
      lighting: 'emergency',
      props: [nodePanel('node-delta-panel-fuse-2', NZ, X)],
    },
    // -- branches ---------------------------------------------------------
    {
      // Mated to node-delta's −X face, NOT its floor port.
      //
      // The nadir mate put this module 2.7 m below the deck, and with a floor in
      // node-delta the only way in was a 2.7 m drop — `impactNoise` caps at 6
      // m/s, so every visit to the fuse panel in here was a 51-loudness crash
      // and every exit was a climb nobody could make. Sideways, it is a dark
      // dome at the end of a short corridor at the same deck height as the rest
      // of the station: §2's knowingly-authored hiding place, with the best
      // cover on the map and no second way out.
      id: 'cupola-nadir',
      kind: 'cupola',
      mate: { port: 'dock', to: { module: 'node-delta', port: 'nx' } },
      lighting: 'dark',
      // On the collar's −X wall at axis height, where a standing crew member
      // reads it: the +X wall is the equipment bay's, and the old authored pose
      // (a point 0.75 m off the axis on a 34° bearing) was drawn for a 1.25 m
      // collar and would sit 1.6 m over the deck in a 1.88 m one.
      props: [tubePanel('cupola-nadir-panel-fuse-3', CUPOLA_COLLAR_R, 180, -1.35)],
    },
    {
      // §2's second zero-G module: §11 puzzle 5 is written for it, and it is
      // behind the one hatch the level authors closed. See the header.
      id: 'airlock-eva',
      kind: 'airlock',
      gravity: 'zero',
      // Airlocks live closed. It is also the one occluded hatch the team meets
      // in the first minute, which teaches §8's muffling for free.
      mate: {
        port: 'inner',
        to: { module: 'node-beta', port: 'px' },
        hatch: { open: false },
      },
      lighting: 'dark',
      props: [
        // §11 puzzle 5 — two keyswitches on opposite walls at opposite ends:
        // 3.9m apart in a 4m module, which is as close to §11's "four metres"
        // as an airlock you can also fit an EVA suit in gets.
        tubePanel('airlock-eva-panel-keyswitch-a', KIT.airlock.radius, 0, -1.7),
        tubePanel('airlock-eva-panel-keyswitch-b', KIT.airlock.radius, 180, 1.7),
      ],
      // No hide spots here: zero-G modules author none (see the kit pieces —
      // floating cover in an open bore was a free safe square).
    },
    {
      id: 'escape-soyuz',
      kind: 'straight',
      mate: { port: 'fwd', to: { module: 'node-alpha', port: 'nx' } },
      lighting: 'dark',
      props: [tubePanel('escape-soyuz-panel-capsule', KIT.straight.radius, 180, -1.35)],
      // §4 wants six hide spots across the station and §2 wants a dead end
      // authored AS a dead end. The aft port here is capped, so a crew berth
      // built into it plugs a lane that leads nowhere — the one place in a
      // corridor a body-sized recess costs the corridor nothing. It needed a
      // 2.60 m deck to exist: at 1.32 m the same berth left 0.12 m of lane.
      hideSpots: extraSpots(
        crewBunk('escape-soyuz-bunk', KIT.straight.radius, -KIT.straight.length / 2, 1, 1),
      ),
    },
  ],
  links: [
    // Closes the ring: node-delta mates back onto node-alpha face to face.
    { a: { module: 'node-alpha', port: 'pz' }, b: { module: 'node-delta', port: 'nz' } },
  ],
};

/** Assemble the authored station from the kit. Pure; no file I/O. */
export function buildStationLayout(): StationLayout {
  return assembleStation(STATION_SPEC);
}
