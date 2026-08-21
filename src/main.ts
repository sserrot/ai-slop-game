/**
 * ISS — the client bootstrap (DESIGN.md §1 `src/`).
 *
 * Eight subsystems were built against one shared contract; this file is the
 * only place that knows all eight exist. It owns the construction order, the
 * fixed-timestep loop (§7: 20 Hz sim, render-rate draw) and every seam the
 * subsystems left as a callback.
 *
 * THE DATA PATHS THAT MATTER, and where each is wired below:
 *
 *   action → NoiseEvent → server → coalescer → alien
 *     `player.onNoise` and `NoiseEmitter` → `net.sendNoise` → StationRoom
 *     re-derives loudness from §14 and hands it to the alien's own coalescer.
 *
 *   server noise → client runtime → audio (PANNED AT THE ARRIVAL PORT) + ring
 *     `net.on('noise')` → `NoiseRuntime.ingest` → bus `noise:heard`
 *     (`resolution.panPosition` is the connecting port, §8) and `noise:self`
 *     (`carriedMetres` scales the §6 ring).
 *
 *   alien position → tracker PULSE RATE (never a bearing, §6)
 *     `NetClient.update` → bus `alien:proximity` → WristTracker + TrackerAudio
 *     + HeartRate. Nothing on the HUD ever prints a distance.
 *
 *   puzzle → system online → director stage → alien speed + attention
 *     panel region → `interact` → StationRoom → EscalationDirector → `stage`
 *     broadcast → bus `director:stage`.
 *
 *   mic → calibration → voiceLevel → server → NoiseEvent
 *     `VoiceMesh` → `net.sendVoiceLevel` (10 Hz) → StationRoom.
 *
 *   station BVH → player collision, rail graph → grip and alien navigation
 *     `player.setCollider(station.bvh)` / `player.setStation(graph, rails)`.
 *
 *   server gravity → station regime → the controller under your feet (§4)
 *     `net.gravity()` (continuous state) → `station.applyGravitySnapshots` →
 *     `ModuleGraph.gravity` mutated in place → `Player.currentGravity()` reads
 *     it live, so a §5 director failure lands on the player with nothing else
 *     to wire. The `gravity` MESSAGE is the 2.5 s announcement on top of that:
 *     it drives the audible wind-down and nothing else.
 *
 *   footstep → NoiseEvent → server → coalescer → alien
 *     `StrideMeter` inside the controller fires one event per stride (§3, a
 *     DISTANCE not a timer) through the same `onNoise` seam as everything else.
 *
 *   hide spot → `hide` message → the server puts you in the box
 *     `player.onHide` → `net.sendHide`. The server owns the timer and the
 *     state; §4's HIDDEN is not reachable by asserting it on a transform.
 */

import * as THREE from 'three';

import {
  CULL_HOPS,
  DECK_Y_M,
  MAX_PLAYERS,
  PUSH_MAX,
  SYSTEMS_TO_ESCAPE,
  assertConstantsCoherent,
  clamp,
} from '@shared/constants';
import type {
  AlienSnapshot,
  AlienState,
  ModuleId,
  NoiseEvent,
  NoiseKind,
  PlayerId,
  PortId,
  StationLayout,
  Vec3,
} from '@shared/types';
import { distance } from '@shared/graph/math';
import { parseHideSpotKey } from '@shared/graph/hideSpots';

import { Ticker, bus } from './core';
import { Renderer } from './render';
import { ITEM_KINDS, Station, defaultStationLayout, itemKindOf, kitPiece } from './station';
import type { ItemKind, Locker, StationPanel } from './station';
import { FirstPersonHands, KEYMAP, Player, RemoteCrewViews, type NoiseInfo } from './player';
import type { CrewBodyInput, InteractableInfo } from './player';
import {
  PROMPT,
  createUI,
  type InteractPromptSpec,
  type Panel,
  type PanelRegion,
} from './ui';
import { NoiseEmitter, NoiseRuntime } from './noise';
import { createAudioSystem, type VoiceSignalling } from './audio';
import { AlienProxy, tryLoadAlienSkin } from './alien';
import { NetClient } from './net';
import type { WelcomeMessage } from './net';
import {
  CargoStow,
  PuzzleInteractor,
  createPuzzlePanels,
  jamProgress01,
  panelSpecsFromLayout,
  puzzleStore,
} from './puzzles';
import type { JamState } from './puzzles';

// ===========================================================================
// Local tuning — nothing §14 defines. Everything else is imported.
// ===========================================================================

/** How far you can reach a hatch. Mirrors StationRoom's own check. */
const HATCH_REACH_M = 2.5;
/** Revive range, mirroring the room (§10 "carry a medkit to the body"). */
const REVIVE_RANGE_M = 2.0;
/** Interaction ray length. Mirrors `src/player/tuning.ts` INTERACT_RANGE. */
const INTERACT_RANGE_M = 2.5;
/** How far ahead of you a thrown decoy lands (§5). The server clamps it. */
const DECOY_THROW_M = 4;
/** Give up on the server after this long and boot into offline sandbox mode. */
const CONNECT_TIMEOUT_MS = 6000;
/**
 * Eye height used by the OFFLINE spawn only, above `DECK_Y_M`.
 *
 * Deliberately a hair under `EYE_HEIGHT_STAND_M`: the controller's ground probe
 * snaps a body that is slightly low, and a body that is slightly high falls the
 * difference — which on the first frame of a session is a landing noise nobody
 * made. With a server, `welcome.spawn` is authoritative and this is unused.
 */
const EYE_SPAWN_M = 1.5;

/**
 * Noise kinds the local player must NOT report to the server, because the server
 * already emits them from state it owns. See `sendNoise()` for the reasoning on
 * each one; they are still heard locally and still ring §6, which is the whole
 * point of emitting them on this side at all.
 */
const SERVER_OWNED_NOISE: ReadonlySet<NoiseKind> = new Set<NoiseKind>([
  'voice',
  'breathing',
  'hide-enter',
  'hide-exit',
]);

/** Noise kinds that are also an IMPACT — the hands flinch on these (§4). */
const BRACING_NOISE: ReadonlySet<NoiseKind> = new Set<NoiseKind>([
  'catch',
  'impact',
  'body-collision',
  'landing',
]);

// ===========================================================================
// 0 · sanity
// ===========================================================================

// §14: "Change one, re-check the set." This throws with a list of failures.
assertConstantsCoherent();

// ===========================================================================
// 1 · renderer, scene, camera, UI — everything that must exist before the
//     network answers, so the menu can say what is happening.
// ===========================================================================

const appHost = document.getElementById('app') as HTMLElement;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / Math.max(1, window.innerHeight),
  0.05,
  200,
);
scene.add(camera); // the flashlight parents to the camera (§9)

const renderer = new Renderer(scene, camera, { container: appHost });

const ticker = new Ticker();
const net = new NetClient({
  // src/noise resolves every event itself (below); without this the same sound
  // would be resolved, played and rung twice.
  resolveNoise: false,
});

let station: Station | null = null;
let player: Player | null = null;
let interactor: PuzzleInteractor | null = null;
/** Offline sandbox only — with a server the room's phase is authoritative. */
let offlineRunning = false;
let localId = '';

/**
 * Is a round actually live?
 *
 * Read the ROOM's phase rather than latching a local flag on `roundStart`: that
 * message only goes to the clients present when the round began, so a late
 * joiner would never start sending transforms and would stand still forever.
 */
function roundLive(): boolean {
  return net.connected ? net.phase === 'RUNNING' : offlineRunning;
}

/** The real bindings, including the keys `src/player/keymap.ts` does not own:
 *  hatches, decoys, the two jammed-locker holds and the spectator cameras are
 *  the room's, not the controller's. */
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['MOUSE', 'look'],
  // §4's risk dial comes first because it is the thing the player holds down
  // all round. The zero-G verbs share the same physical keys deliberately —
  // Shift is "run" on a deck and "hold on" in vacuum — and that is why the two
  // rows read as one control each.
  ['W A S D', 'walk · slide along a rail · steer a drift'],
  ['HOLD SHIFT', 'sprint (30, always heard) — or grip a rail in zero-G'],
  ['HOLD CTRL', 'crouch (4, near-silent, half speed)'],
  ['SPACE', 'jump — loud unless you land crouched · hold to charge a push-off'],
  ['T', 'get into / out of a hide spot — your gait sets the price'],
  ['E', 'interact — panels, lockers, cargo, a hide spot, a downed crewmate'],
  ['Q', 'knock on a handrail (15, carries ~2 modules)'],
  ['G', 'open / close the nearest hatch (45, and it hears you)'],
  ['H', 'SEAL the nearest hatch — two charges a round, no undo'],
  ['R', 'throw a decoy (70) — two a round, found in lockers'],
  ['HOLD V', 'pry a jammed locker — 60, 3 s (§11 loud-fast)'],
  ['HOLD B', 'hand-pump a jammed locker — 6, 25 s (§11 quiet-slow)'],
  ['X', 'fire extinguisher (65) — three bursts, for when you are stranded'],
  ['F', 'flashlight (silent)'],
  ['Z / C', 'roll · ARROWS snap-turn'],
  ['M', 'mute the wrist tracker — silent, and blind'],
  ['[ / ]', 'DEAD — cycle the module cameras (§10: never the alien)'],
  ['ESC', 'menu'],
];

const ui = createUI({
  controls: CONTROLS,
  // §6 CONFLICT: src/player/keymap.ts already binds KeyM → trackerMute and
  // re-broadcasts `ui:trackerMute`, which the tracker picks up. Two bindings
  // would cancel each other out, so the player controller owns the key.
  muteKey: null,
  crewTotal: MAX_PLAYERS,
  onStart: () => void beginRound(),
  onAgain: () => void beginRound(true),
  // Fires once at construction with whatever was persisted (§13: comfort
  // settings survive the session), and again on every edit. `setComfort` is the
  // whole wiring: the camera takes FOV/roll/snap, the renderer takes FOV, the
  // vignette and — since it owns the one light §9 budgets — the flashlight
  // brightness trim.
  onComfortChange: (options) => {
    player?.comfort.set(options);
    renderer.setComfort(options);
  },
  // §9's frame guard moves the preset on its own. `auto` hands it the whole
  // ladder with `high` as the ceiling; a pinned level turns the guard off and
  // holds what the player asked for, including through a rough patch.
  //
  // This fires from inside `createUI`, so it must not touch `ui` — that
  // binding is still in its temporal dead zone. The panel's readout is driven
  // by `renderer.onQualityChange` below instead.
  onGraphicsChange: (choice) => {
    if (choice === 'auto') {
      renderer.setQuality('high');
      renderer.setAutoQuality(true);
    } else {
      renderer.setAutoQuality(false);
      renderer.setQuality(choice);
    }
  },
});
// A quality change the player did not ask for used to be invisible: the guard
// could leave someone on `low` for a whole session and nothing said so.
renderer.onQualityChange(({ level, previous, reason, fps }) => {
  console.info(`[render] quality ${previous} -> ${level} (${reason}, ${fps.toFixed(0)} fps)`);
  ui.setQuality(level);
});
ui.setQuality(renderer.quality);
ui.menu.setStatus('connecting to the station…');

// ===========================================================================
// 2 · noise runtime + emitter (§3), constructed before the station so nothing
//     downstream has to care whether the graph has arrived yet.
// ===========================================================================

const runtime = new NoiseRuntime();
const emitter = new NoiseEmitter(runtime, {
  network: { sendNoise: (intent) => net.send('noise', intent) },
});

/**
 * The emitter the AUDIO subsystem gets.
 *
 * `createAudioSystem` fires `emitter.breathing()` from its own breath clock,
 * and `src/player` already emits one breath per beat of its own heart-rate
 * model (§6) — two sources, one ring, double ripples. The player's is the one
 * that stays (it is the same model the server runs), so this one is muted.
 * Tracker beeps and voice still come from here, phase-locked to the sounds the
 * player actually hears.
 */
class AudioEmitter extends NoiseEmitter {
  override breathing(): null {
    return null;
  }
}
const audioEmitter = new AudioEmitter(runtime, {
  network: { sendNoise: (intent) => net.send('noise', intent) },
});

// ===========================================================================
// 3 · voice signalling over the Colyseus room (§7)
// ===========================================================================

const signalling: VoiceSignalling = {
  get localId() {
    return net.sessionId;
  },
  send: (to, signal) => net.sendSignal(to, signal),
  onSignal: (handler) => net.on('signal', ({ from, data }) => handler(from, data)),
  onPeerJoin: (handler) => net.on('peerJoin', ({ id }) => handler(id)),
  onPeerLeave: (handler) => net.on('peerLeave', ({ id }) => handler(id)),
  peers: () => net.peers,
};

// ===========================================================================
// 4 · boot
// ===========================================================================

async function boot(): Promise<void> {
  const welcome = await connect();
  const layout = welcome?.layout ?? defaultStationLayout();
  localId = net.sessionId || 'local';

  buildStation(layout);
  buildPlayer();
  // After the player, because the hands are a camera child and the camera is the
  // controller's; before the pre-warm, because both the arms and all six held
  // items have to be in the scene graph when `compileAsync` walks it.
  buildHands();
  buildAudio(welcome);
  buildPuzzles(layout);
  // Rapier's wasm loads here, behind the menu, and before the pre-warm below.
  await buildCargo(layout);
  buildAlien();
  // Before `buildCrew`/`prewarm`: see `buildAlienSkin`. Costs one `if` and no
  // network traffic at all until somebody actually points it at a file.
  await buildAlienSkin();
  buildCrew();
  wireNetwork();
  wireLoop();

  // Pay every first-draw cost now, while the menu is still up. Without this the
  // first tour of the station hitches (measured: 77.5 / 13.1 / 10.9 / 7.6 ms)
  // as shaders link and buffers upload on first sight of each module; a second
  // pass over the same route ran 0.61 ms mean. See `Renderer.prewarm()`.
  ui.menu.setStatus('warming up — compiling shaders and uploading geometry…');
  ui.menu.setStartLabel('warming up…', false);
  beginPrewarm();
  try {
    const warm = await renderer.prewarm();
    console.log(
      `[main] prewarm ${warm.milliseconds.toFixed(0)}ms — ` +
        `${warm.programs} programs (+${warm.programsCompiled}), ` +
        `${warm.geometries} geometries (+${warm.geometriesUploaded}), ` +
        `${warm.textures} textures (+${warm.texturesUploaded})`,
    );
  } catch (err) {
    // A failed pre-warm costs smoothness, never the session.
    console.warn(`[main] prewarm skipped (${describe(err)})`);
  }
  endPrewarm();
  ui.menu.setStartLabel('begin');

  if (welcome) {
    ui.menu.setStatus(
      `connected — ${net.peers.length + 1} in the room. ` +
        `${SYSTEMS_TO_ESCAPE} systems, then the capsule.`,
    );
    if (welcome.spawn) player?.spawnAt(welcome.spawn);
  } else {
    ui.menu.setStatus('OFFLINE — no server. Free flight only: no alien, no puzzles, no crew.');
    ui.menu.setStartLabel('free flight');
    spawnOffline();
  }

  ticker.start();
}

/**
 * Everything that is EMPTY at boot, filled for the duration of the pre-warm.
 *
 * `Renderer.prewarm()` makes every object visible and turns frustum culling off,
 * which is the whole answer for a plain mesh and only half of it for an
 * `InstancedMesh`: a set with `count === 0` is skipped by the draw, so its vertex
 * buffers never upload and the first frame that has something to put in it pays
 * for them instead. Two classes of that exist in this client:
 *
 *   • six sets inside the station — `Station.setPrewarm` names them;
 *   • the crew's eight parts, which `PartInstances` hides outright at zero
 *     instances (exactly right in a solo round, exactly wrong here).
 *
 * The hands are always in the scene and their six held forms are built by
 * `buildHands`; the items, fixtures and plants are packed with real instances at
 * load; the alien is `visible = false` until its first snapshot but writes its
 * instance matrices in its constructor. So this is the whole of the gap.
 */
const PREWARM_CREW_ID = '__prewarm__';

const prewarmCrew: CrewBodyInput[] = [];

function beginPrewarm(): void {
  // Six sets of instances that are empty at boot and would otherwise upload
  // their buffers mid-round — the first seal, the first gravity warning, the
  // first locker. See `Station.setPrewarm`.
  station?.setPrewarm(true);
  if (!crew || !station) return;
  const module = station.modules[0];
  const centre = module ? station.graph.centre(module.id) : null;
  if (!module || !centre) return;
  // A FULL crew, not one body: `CrewIdentities` hands out a different stripe
  // count per seat and `RemoteCrewViews` caches the stripe transforms per count,
  // so posing all six fills the widest instance buffer the round can produce and
  // primes every identity at once.
  prewarmCrew.length = 0;
  for (let i = 0; i < MAX_PLAYERS; i++) {
    prewarmCrew.push({
      id: `${PREWARM_CREW_ID}${i}`,
      pos: { x: centre.x + i * 0.4, y: centre.y + DECK_Y_M + EYE_SPAWN_M, z: centre.z },
      quat: { x: 0, y: 0, z: 0, w: 1 },
      module: module.id,
      state: 'GROUNDED',
      alive: true,
      gait: 'walk',
    });
  }
  crew.sync(prewarmCrew, 1 / 60);
}

function endPrewarm(): void {
  station?.setPrewarm(false);
  if (!crew) return;
  for (const body of prewarmCrew) crew.forget(body.id);
  prewarmCrew.length = 0;
  crew.sync(EMPTY_CREW, 0);
}

const EMPTY_CREW: readonly [] = Object.freeze([]);

/** Colyseus rejects with plain objects as often as with Errors. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const record = err as { message?: unknown; code?: unknown };
    if (typeof record.message === 'string' && record.message) return record.message;
    if (record.code !== undefined) return `code ${String(record.code)}`;
  }
  return String(err);
}

async function connect(): Promise<WelcomeMessage | null> {
  try {
    const welcome = await Promise.race([
      net.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), CONNECT_TIMEOUT_MS),
      ),
    ]);
    console.log(`[main] joined as ${net.sessionId}`);
    return welcome;
  } catch (err) {
    console.warn(`[main] no server (${describe(err)}) — booting the offline sandbox`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4a · station (§2)
// ---------------------------------------------------------------------------

function buildStation(layout: StationLayout): void {
  // The layout comes from the SERVER when there is one, so both sides run §3
  // propagation over identical geometry. `validate: false` because a layout
  // problem should degrade the level, never blank the screen; the problems are
  // printed instead.
  // `ambient: false`: §9 budgets ONE ambient fill and `LightingRig` already owns
  // it ('station-ambient', §14 `AMBIENT_INTENSITY`). A second AmbientLight
  // inside `station.group` was invisible to the rig, so §5's HUNT dim
  // (`ambient × (1 − 0.35 × hunt)`) and the red-alert tint only ever bit on the
  // rig's 46% of the real fill. Measured: dropping it costs under 2% of
  // whole-frame luminance — below what the emergency lights' own flicker moves
  // — so nothing is raised to compensate. One light, one knob, and the knob is
  // the one that reacts to the alien.
  station = new Station(layout, { validate: false, seed: 0, ambient: false });
  scene.add(station.group);

  const problems = [
    ...station.graph.validate(),
    ...station.rails.validate(),
    // §4: a hide spot the alien can never route around is a decoration, and one
    // authored outside its module is a body that vanishes. Both are level bugs
    // that only show up as "hiding does nothing", so say them out loud.
    ...station.hideSpots.validate(),
  ];
  for (const problem of problems) console.warn(`[station] ${problem}`);

  wireGravity(station);

  // §9: the flashlight is the only shadow caster, and geometry must opt IN —
  // which means a subsystem is also allowed to opt OUT. The instanced handrails
  // and props (src/station/instancing.ts) and the invisible collision hull
  // (src/station/collision.ts) both do, and flag themselves with
  // `userData.noShadow`. Blanket-setting over them put every handrail in the
  // cull set back into the 1024×1024 flashlight shadow map every frame — §9
  // budgets one shadow map, it did not budget the handrails in it.
  //
  // This is still the pass that sets `receiveShadow`, and it deliberately opts
  // IN generously: `src/render/shadowPolicy.ts` then subtracts the meshes that
  // must not cast (the emissive strips, the hatch indicators, the unlit §6
  // panel screens), and `Renderer.setModules` re-runs it on every cull change.
  // The `applyCull` below is the first of those, so nothing renders in between.
  station.group.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    if (object.userData.noShadow === true) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });

  // ONE canonical graph. The noise runtime, the player, the alien proxy and the
  // renderer all read this one; `NetClient` keeps its own copy of the same Port
  // objects fresh in step (both call `refreshHatches()` on a change).
  runtime.setGraph(station.graph);

  station.onCullChanged = (visible) => {
    bus.emit('cull:changed', { visible });
    applyCull(visible);
  };
  applyCull(station.visibleModules);

  // §10: everybody wakes on emergency lighting. Systems coming back online
  // light their module (see `wireNetwork`).
  station.setAllLighting('emergency');

  // Fog is tuned to hide the two-hop cull boundary (§2/§9).
  renderer.setFogVisibility((CULL_HOPS + 1) * 5);
}

/**
 * §4's gravity set-piece, client side.
 *
 * Three things happen when a module loses its floor, and they belong to three
 * different owners:
 *
 *   1. **The 2.5 s warning** is the fairness guarantee — "the floor never simply
 *      vanishes under anyone" — and it is DIEGETIC: §6 refuses a HUD indicator
 *      on the grounds that a warning sound is better information delivered
 *      earlier. So the only thing that must never be skipped here is
 *      `audio.gravity.warn()`, and it is resolved through the §3 graph so it
 *      pans at the connecting port from the next module along (§8).
 *   2. **The `gravity-shift` noise at 35** belongs to the SERVER. It emits it at
 *      the module centre — nobody caused it, so nobody is blamed for it — and it
 *      arrives here like any other NoiseEvent. Emitting a second one from the
 *      client would put six copies of one event into §3's coalescing window.
 *      Offline there is no server and no director, so the local emit below is
 *      the sandbox's only copy and is `localOnly` besides.
 *   3. **The regime itself** is `StationModule.gravity`, mutated in place, which
 *      the player controller re-reads every frame. That is why nothing here
 *      pushes anything at the player.
 */
function wireGravity(target: Station): void {
  target.onGravityWarning = (event) => {
    bus.emit('gravity:warning', event);
    const centre = target.graph.centre(event.module);
    // The plant winding down, for as long as the announcement says it has.
    if (centre) audio?.gravity.warn(event.module, centre, event.inMs / 1000);
  };

  target.onGravityShift = (shift) => {
    bus.emit('gravity:changed', shift);
    // Stop the wind-down and let the room take on its new character (§8: a
    // `zero` module is THINNER, not quieter — the plant and its pump stop, the
    // air handling does not).
    audio?.gravity.shift({ module: shift.module, to: shift.to });
    // Online the server's own 35 is already on its way and carries the actor-less
    // origin §4 insists on. Offline it is this or silence.
    if (!net.connected && shift.loudness > 0) {
      emitter.emit('gravity-shift', shift.origin, shift.module, {
        loudness: shift.loudness,
        localOnly: true,
      });
    }
  };
}

function applyCull(visible: readonly ModuleId[]): void {
  if (!station) return;
  renderer.setModules(
    visible.flatMap((id) => {
      const centre = station!.graph.centre(id);
      const module = station!.module(id);
      return centre && module ? [{ id, centre, lighting: module.lighting }] : [];
    }),
  );
  // §10: "Cameras show modules and players, never the alien." An empty visible
  // set is `AlienView`'s own hide, so this survives every later cull change.
  alien?.setVisibleModules(spectating ? NO_MODULES : visible);
}

/** Shared empty set — the alien's cull list while a spectator is watching. */
const NO_MODULES: readonly ModuleId[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// 4b · player (§4)
// ---------------------------------------------------------------------------

/**
 * The gloved hands, in the camera (§4, ISS-CHR-02).
 *
 * They are a CAMERA child rather than a scene child, which is what makes them
 * render at the eye without a per-frame transform, and it is also what keeps
 * them out of both the §9 shadow map and the station BVH: the blanket
 * `castShadow` traverse in `buildStation` walks `station.group`, the collider is
 * built from station geometry alone, and every mesh in here is flagged
 * `noShadow` / `noCollide` besides.
 */
let hands: FirstPersonHands | null = null;

function buildHands(): void {
  hands = new FirstPersonHands({ materials: station?.materials ?? null });
  camera.add(hands.object3D);
  // BEFORE `renderer.prewarm()`, and that is the whole reason this is a separate
  // call: the held form of all six carryables is built now, while the menu is
  // up, rather than two meshes and a geometry the first time somebody picks
  // something up. That hitch is the one this project has killed twice.
  const preloaded = hands.preloadHeld(ITEM_KINDS);
  console.log(`[main] hands: ${preloaded} held items preloaded, ${hands.triangles} arm triangles`);
}

function buildPlayer(): void {
  player = new Player({
    camera,
    id: localId,
    domElement: renderer.three.domElement,
    comfort: ui.comfort,
    moduleGraph: station?.graph ?? null,
    railGraph: station?.rails ?? null,
    // ONE hide-spot graph for the whole client. The controller would happily
    // build its own from the same module graph — it is pure geometry — but then
    // `station.hideSpotNear()` and `player.hideCandidate` would be reasoning
    // about two objects, and occupancy is the thing they have to agree on.
    hideSpots: station?.hideSpots ?? null,
    // Only consulted before the graph arrives. §4's pivot: walking is the
    // default and the overwhelming majority of the station.
    defaultGravity: 'nominal',
    collider: station?.bvh,
    interactables: station?.interactables ?? [],
    // §2: a real containment test beats `nearestModule`'s centre comparison —
    // the module id is stamped on every NoiseEvent and drives the cull set.
    moduleAt: (pos, hint) => station?.moduleAt(pos, hint) ?? null,

    // §6's interact prompt, half of it. The controller resolves GEOMETRY — it
    // has one raycast, sampled at AIM_RAYCAST_HZ, and the crosshair's `hand`
    // glyph already comes off it — but only the station knows a breaker panel
    // from a locker, so it asks. `object` is the raycast LEAF (a mesh under
    // whatever went into `interactables`), which is exactly what
    // `Station.interactableAt` walks upward from.
    //
    // Asked every frame with one object on purpose: a locker's `usable` goes
    // false the moment it is emptied and the player is still standing in front
    // of it when that happens. `_describeInfo` is refilled rather than minted —
    // `Player.refreshInteractTarget` copies the fields out and keeps nothing.
    describeInteractable: (object) => describeInteractable(object),
    // The player's own noise: heard instantly and locally (§8 "they have to
    // feel the mistake as they make it"), and reported to the server, which
    // re-derives the loudness from §14 (§7).
    onNoise: (event, info) => {
      // The hands flinch off the same event the alien hears. §4 prices a catch
      // at 26 and a crash at 51 and the player has to be able to tell which
      // happened without reading a number, so the brace is scaled by the speed
      // the event was MADE at — the same field `sendNoise` refuses to re-derive.
      if (BRACING_NOISE.has(event.kind)) {
        hands?.brace(clamp((info?.speed ?? player?.speed ?? 0) / PUSH_MAX, 0, 1));
      }
      sendNoise(event, info);
    },
    onFlashlight: (on) => renderer.setFlashlight(on),

    // §4's four transitions. `LocomotionAudio` decides for itself which of them
    // §3 already carries: `transitionNoise() > 0` means a real NoiseEvent has
    // already gone out through `onNoise` above and this layer stays out of the
    // way; `=== 0` (a walking launch, every liftoff) means the transition is
    // genuinely silent on the wire and this is the only thing that will ever
    // make a sound for it. Calling it for a `landing` as well would double it.
    onTransition: (transition) => {
      audio?.locomotion.transition(transition);
    },

    // §4's hide spots. The `hide-enter` / `hide-exit` NoiseEvent has already
    // gone out through `onNoise`; this is the §7 message, and it is the ONLY
    // way into `PlayerState.HIDDEN` — a client that simply asserts the state on
    // a transform is quietly corrected back to the regime default.
    onHide: (message) => {
      if (net.connected) net.sendHide(message.module, message.spot, message.action, message.haste);
    },

    // The floor came or went under the local player. The ambient bed follows
    // the LISTENER's module, so this is the same seam `applyModuleAmbience`
    // uses when you walk across a hatch instead.
    onGravityMode: (mode, module) => {
      audio?.gravity.setListenerModule(module, mode);
    },
  });
  renderer.setComfort(ui.comfort);

  // The interact key is driven here rather than through `config.onInteract`
  // because puzzle controls are HELD (the 20 s override, the valve wheel, the
  // undock levers) and need a release edge as well as a press.
  const interactCodes = new Set(KEYMAP.interact);
  window.addEventListener('keydown', (event) => {
    if (event.repeat || !interactCodes.has(event.code)) return;
    onInteractPress();
  });
  window.addEventListener('keyup', (event) => {
    if (!interactCodes.has(event.code)) return;
    onInteractRelease();
  });
  window.addEventListener('keydown', onExtraKeys);
  window.addEventListener('keyup', onExtraKeyUp);

  // Pointer lock is the menu's on/off switch. Escape releases it, which is the
  // only "pause" this game has.
  player.input.onLockChange((locked) => {
    if (locked) {
      ui.hideMenu();
      return;
    }
    // Releasing the pointer ALWAYS has to show something. This used to be gated
    // on `roundLive()`, so pressing Escape between rounds — or while dead —
    // released the pointer and put nothing on screen: the game carried on
    // rendering, and the next click silently recaptured the cursor. From the
    // player's side that reads as "Escape doesn't work". The `inScreen` guard
    // stays, because the results and spectator screens are already something.
    releaseAllHolds();
    if (!ui.inScreen) ui.showMenu();
  });
}

/** Keys the player controller does not own: hatches, decoys, spectating. */
function onExtraKeys(event: KeyboardEvent): void {
  if (event.repeat || !player?.pointerLocked) return;

  // §10: the dead get one job and one control — the module cameras.
  if (!player.alive) {
    if (event.code === 'BracketLeft') cycleSpectator(-1);
    else if (event.code === 'BracketRight') cycleSpectator(1);
    return;
  }

  // §11's dual path on a jammed locker. Read through KEYMAP rather than
  // compared against a literal: the §6 prompt names the bound key off the same
  // map (`PROMPT.pry` / `PROMPT.pump`), and a verb whose key is typed in two
  // places is a verb that stops following a rebind. `.includes` over a
  // one-entry array is live, where a Set built at boot would go stale.
  if (KEYMAP.pry.includes(event.code)) {
    beginJam('pry');
    return;
  }
  if (KEYMAP.pump.includes(event.code)) {
    beginJam('pump');
    return;
  }

  switch (event.code) {
    case 'KeyG':
      cycleNearestHatch();
      break;
    case 'KeyH':
      sealNearestHatch();
      break;
    case 'KeyR':
      throwDecoy();
      break;
    default:
      break;
  }
}

/** The other half: both jam paths are holds, so they need a release edge. */
function onExtraKeyUp(event: KeyboardEvent): void {
  if (KEYMAP.pry.includes(event.code) || KEYMAP.pump.includes(event.code)) endJam();
}

// ---------------------------------------------------------------------------
// 4c · audio (§8) and voice (§7)
// ---------------------------------------------------------------------------

let audio: ReturnType<typeof createAudioSystem>;

function buildAudio(welcome: WelcomeMessage | null): void {
  audio = createAudioSystem({
    runtime,
    emitter: audioEmitter,
    voice: {
      signalling,
      net: { sendVoiceLevel: (msg) => net.sendVoiceLevel(msg.level) },
      iceServers: (welcome?.iceServers ?? []) as RTCIceServer[],
      pushToTalk: false,
    },
  });
  teardown.push(audio.attach());
}

// ---------------------------------------------------------------------------
// 4d · puzzles (§11)
// ---------------------------------------------------------------------------

/** `${module}:${propId}` → the canvas face drawn on that station panel. */
const panelByProp = new Map<string, Panel<unknown>>();

function buildPuzzles(layout: StationLayout): void {
  interactor = new PuzzleInteractor({ send: (msg) => net.send('interact', msg) });

  const specs = panelSpecsFromLayout(layout).map((spec) => {
    // The station already builds the physical panel where §11 says the hardware
    // is; we only supply the glass. Size the canvas to the real screen so the
    // drawing is not stretched, and do NOT add a second plane to the scene.
    const screen = station?.panel(propIdOf(spec.key));
    // Match the station's real screen face (PROP_ARCHETYPES.panel, 0.86 × 0.58
    // with an 0.86/0.82 inset) so the drawing is not stretched.
    return screen ? { ...spec, width: 0.74, height: 0.476 } : spec;
  });

  const puzzlePanels = createPuzzlePanels(ui.panels, specs);
  for (const [key, panel] of puzzlePanels.panels) {
    panelByProp.set(key, panel);
    const target = station?.panel(propIdOf(key));
    if (target) {
      target.setTexture(panel.texture);
      // The face is a lit-looking screen in a very dark station: keep it out of
      // the ACES curve so the gauges stay readable (§6 — the panel IS the UI).
      target.material.toneMapped = false;
      // The canvas plane the UI made is unused: the station's screen mesh shows
      // the texture, and it is the thing the interaction ray already hits.
      panel.mesh.visible = false;
    } else {
      // No authored hardware for this panel — fall back to the UI's own plane.
      scene.add(panel.mesh);
    }
  }

  net.on('puzzle', (msg) => puzzleStore.apply(msg));
  puzzleStore.applyAll(net.puzzles());
}

// ---------------------------------------------------------------------------
// 4d-ii · cargo stow (§11 puzzle 3) — the one puzzle with loose bodies in it
// ---------------------------------------------------------------------------

/** Five bags, five slots, one Rapier world. Null when the level has no rack. */
let cargo: CargoStow | null = null;

/**
 * Build the cargo puzzle.
 *
 * Awaited during boot, on purpose: it dynamically imports Rapier (~2.8 MB of
 * wasm), which belongs behind the menu with the rest of the loading cost rather
 * than as a hitch the first time somebody walks into `tube-spine`. Doing it
 * before `renderer.prewarm()` also gets the bag meshes into the pre-warm pass.
 */
async function buildCargo(layout: StationLayout): Promise<void> {
  try {
    cargo = await CargoStow.create({
      layout,
      localPlayerId: localId,
      // §1: the server's placement is authoritative. The authored rack agrees
      // with it, and `CargoStow` falls back to the authored one on a mismatch.
      module: net.state?.puzzles.get('cargo-stow')?.module ?? null,
      onStow: (bagId) => interactor?.stowBag(bagId),
      // 30 — "cargo bag bounce", about a module. The bag is a body like any
      // other; the noise goes through the same §3 door everything else does.
      onNoise: (intent) =>
        emitter.emit(
          intent.kind,
          intent.pos,
          intent.module,
          intent.speed === undefined ? {} : { speed: intent.speed },
        ),
    });
  } catch (err) {
    // No Rapier, no wasm, no cargo — but the other six puzzles and the whole
    // round still work. This must never be the thing that blanks the screen.
    console.warn(`[main] cargo stow unavailable (${describe(err)})`);
    cargo = null;
    return;
  }
  if (cargo) scene.add(cargo.object3D);
  else console.warn('[main] cargo stow: no rack in this layout');
}

/**
 * Who may own a bag this tick (§1: "the nearest player is authority for a bag").
 *
 * An EMPTY list means nobody owns anything, and an unowned bag reports neither
 * its bounces nor its stows — so this is not optional in a live round.
 */
const cargoPlayerList: Array<{ id: PlayerId; pos: Vec3 }> = [];
/** Parallel pool — `cargoPlayerList[i]` is always `cargoPlayerPool[i]`. */
const cargoPlayerPool: Array<{ id: PlayerId; pos: Vec3 }> = [];

/**
 * Safe to pool: `CargoBags.step` → `assignOwners` (src/puzzles/cargoPhysics.ts)
 * reads this list synchronously and retains nothing.
 *
 * The position is copied rather than aliased, which is a fix as well as a
 * saving — the old code handed the physics step a live reference to the
 * controller's own `player.position` vector.
 */
function pushCargoPlayer(id: PlayerId, pos: Vec3): void {
  let entry = cargoPlayerPool[cargoPlayerList.length];
  if (!entry) {
    entry = { id: '', pos: { x: 0, y: 0, z: 0 } };
    cargoPlayerPool.push(entry);
  }
  entry.id = id;
  entry.pos.x = pos.x;
  entry.pos.y = pos.y;
  entry.pos.z = pos.z;
  cargoPlayerList.push(entry);
}

function cargoPlayers(): Array<{ id: PlayerId; pos: Vec3 }> {
  cargoPlayerList.length = 0;
  const module = cargo?.module;
  if (!module) return cargoPlayerList;
  if (player && player.alive && player.module === module) {
    pushCargoPlayer(localId, player.position);
  }
  for (const body of net.remoteBodies()) {
    if (body.id === localId || !body.alive || body.escaped) continue;
    if (body.module === module) pushCargoPlayer(body.id, body.pos);
  }
  return cargoPlayerList;
}

// ---------------------------------------------------------------------------
// 4e · alien (§5) — a capsule until M8, and it never decides anything
// ---------------------------------------------------------------------------

let alien: AlienProxy | null = null;

function buildAlien(): void {
  alien = new AlienProxy({
    // Kept for the `flesh: false` fallback only. The creature normally builds
    // its OWN material (`src/alien/flesh.ts`) from this same palette row — same
    // colour, same roughness, same zero emissive, so every contrast promise
    // `assertPaletteCoherent()` made still holds — because it is the one thing
    // in the game that is not made of metal and wants a different BRDF for it.
    // That costs one extra WebGLProgram link at boot and nothing else.
    materials: station?.materials ?? null,
    // §4/§5: walk on a deck, rail-pull in vacuum. This is the gait readout the
    // player's life depends on and it is the ONLY readout, because ISS-CHR-01
    // carries no emissive at all — so it is resolved from the live module
    // gravity, which a §5 director floor drop mutates in place.
    gravityOf: (module) => station?.moduleGravity(module) ?? 'nominal',
    // §9's one shadow map, spent on the thing that is hunting you.
    //
    // `alienView.ts` argued the other way for the whole of r3 — a 1024² map
    // spent on the monster is a map not spent on the doorway you are about to
    // walk through — and `buildCrew()` below had already broken the tie without
    // noticing: it spends the same map on other players because "another
    // player's shadow sliding across a bulkhead is the cheapest 'you are not
    // alone' signal in the game". Every word of that is more true here.
    //
    // It is also the ONLY way this creature can be seen without being looked
    // at. It carries no emissive (§9, and `assertInert` enforces it), so with
    // the torch off it is invisible — but a shadow crossing a bulkhead ahead of
    // the body arrives before you have decided to look, which is the difference
    // between being startled and being frightened.
    castShadow: true,
    listener: () => camera.position,
    cullByModule: true,
    // `NetClient` already publishes `alien:proximity`; two publishers would
    // double the tracker's pulse rate.
    emitProximity: false,
  });
  scene.add(alien.object3D);
  console.log(`[main] alien: ${alien.drawCalls} draw calls, ${alien.triangles} triangles`);
}

/**
 * URL of a sculpted alien (BACKLOG B-08), or null for the procedural body.
 *
 * NULL BY DEFAULT, and that is a decision rather than a placeholder. No asset
 * exists yet, and a loader pointed at a file that is not there costs every
 * player a 404 and a console warning on every boot to gain exactly nothing.
 * Set this when a GLB lands in `public/`.
 *
 * `?skin=/models/alien.glb` overrides it, so an artist can try an export
 * against the running game without touching this file or rebuilding — which is
 * the whole point of `src/alien/skin.ts` having a contract that reports every
 * violation at once instead of the first.
 */
const ALIEN_SKIN_URL: string | null = null;

function alienSkinUrl(): string | null {
  try {
    const q = new URLSearchParams(location.search).get('skin');
    if (q) return q;
  } catch {
    /* no `location` — not a browser. Fall through to the constant. */
  }
  return ALIEN_SKIN_URL;
}

/**
 * Load the sculpted body, if there is one, and shrug if not.
 *
 * AWAITED DURING BOOT, before the pre-warm, and both halves of that matter.
 * Before, so a skinned mesh's program and buffers are paid for behind the menu
 * with everything else rather than on the first frame the monster is visible —
 * which is the single worst moment in the game to drop 20 ms. Awaited, so the
 * creature cannot pop from cylinders to sculpt in front of a player mid-round.
 *
 * A missing, broken or contract-violating GLB costs a less interesting monster
 * and nothing else: `tryLoadAlienSkin` logs why and returns null, and the
 * procedural body it was going to replace is still standing there.
 */
async function buildAlienSkin(): Promise<void> {
  const url = alienSkinUrl();
  if (!url || !alien) return;
  const skin = await tryLoadAlienSkin(url, { castShadow: true });
  if (!skin) return;
  alien.adoptSkin(skin);
  console.log(
    `[main] alien skin: ${skin.triangles} triangles, ` +
      `clips [${skin.clipNames.join(', ') || 'none'}]`,
  );
}

// ---------------------------------------------------------------------------
// 4f · the rest of the crew (§7 interpolated bodies, ISS-CHR-03)
// ---------------------------------------------------------------------------

/**
 * Every other player, in eight instanced draw calls and none at all when you are
 * alone (`PartInstances.end()` hides a part at zero instances).
 *
 * This REPLACES the grey capsules: a capsule could not say which way somebody
 * was facing, what gait they were holding — which is your risk too, §4 — or
 * whether they were the person you have been following for ten minutes. The band
 * count and hue do the last one and `RemoteCrewViews` owns the seat allocation.
 */
let crew: RemoteCrewViews | null = null;

function buildCrew(): void {
  if (!station) return;
  crew = new RemoteCrewViews(station.materials, {
    // §9's one shadow map, spent deliberately: another player's shadow sliding
    // across a bulkhead is the cheapest "you are not alone" signal in the game.
    castShadow: true,
  });
  scene.add(crew.object3D);
}

// ---------------------------------------------------------------------------
// 4g · what is in your hand (§5 decoy, §10 medkit, §11 card and fuses)
// ---------------------------------------------------------------------------

/**
 * The carryable the hands are holding, or null.
 *
 * THE INVENTORY IS THE SERVER'S and it is a SET, not a selection: §7 sends
 * `inventory { items }` and nothing anywhere picks one of them. So the rule here
 * is "the thing you picked up most recently is the thing in your hand", which is
 * what a person does and needs no new key, no new message and no new state on
 * the wire. Using an item (throwing the decoy, spending the medkit) drops it out
 * of the list and the hand falls back to whatever is left.
 *
 * A cargo bag is not an `ItemKind` — it is a loose rigid body in §11 puzzle 3 —
 * and while you are carrying one your hands are on it, so the held item is
 * suppressed rather than fought over.
 */
let heldItem: ItemKind | null = null;
let inventory: readonly ItemKind[] = [];
/** The locker we last swung open, so an arriving item can leave its shelf. */
let lastOpenedLocker: string | null = null;

function onInventory(items: readonly ItemKind[]): void {
  // Newest first: anything in `items` that was not in the last list.
  let next: ItemKind | null = null;
  for (const item of items) {
    if (!inventory.includes(item)) next = item;
  }
  // Whatever just arrived came out of the locker we just opened, and that is the
  // only signal the server gives us: §7 sends the inventory, never the shelf.
  // The fuses and the card are re-asserted from the room's own records a tick
  // later (`pumpWorldItems`), so this only has to be right for the decoys.
  if (next && lastOpenedLocker) station?.takeFromLocker(lastOpenedLocker, next);
  if (!next) {
    // Nothing new. Keep what is in hand if we still have one, else fall back to
    // the last thing in the list so an empty hand only ever means an empty bag.
    next = heldItem && items.includes(heldItem) ? heldItem : (items[items.length - 1] ?? null);
  }
  inventory = [...items];
  heldItem = next;
}

/** Offline, and for the local pickup path: put something in the hand directly. */
function takeItem(kind: ItemKind): void {
  if (!inventory.includes(kind)) inventory = [...inventory, kind];
  heldItem = kind;
  ui.toast(`picked up: ${kind.replace('-', ' ')}`, 2000);
}

// ===========================================================================
// 5 · network wiring
// ===========================================================================

const teardown: Array<() => void> = [];

function wireNetwork(): void {
  runtime.setLocalPlayer(localId);
  emitter.setActor(localId);
  audioEmitter.setActor(localId);

  teardown.push(runtime.attach(), emitter.attach(), audioEmitter.attach());

  // Server noise → the one client-side resolution (§3), which drives audio
  // (§8, panned at the arrival port) and the §6 ring.
  teardown.push(
    runtime.connect({
      onNoise: (handler) =>
        net.on('noise', (msg) => {
          // Our own sounds were played the instant we made them; the round trip
          // must not play them again.
          if (msg.actor && msg.actor === localId) return;
          handler(msg);
        }),
    }),
  );

  // Hatches: the server owns them (§7). Apply the authoritative state to the
  // station so the door swings, the BVH-adjacent blocker discs move and — the
  // single most likely runtime bug in the project — the graph's cached hatch
  // attenuation is refreshed.
  station?.applyHatchSnapshots(net.hatches(), true);
  teardown.push(
    bus.on('hatch:changed', ({ module, port, open, sealed }) => {
      station?.setHatch(module, port, { open, sealed }, false);
    }),
  );

  // §4's gravity set-piece. The message arrives TWICE per failure and the two
  // arrivals are different events, told apart by `inMs`:
  //
  //   inMs > 0 — the announcement. Schedule it locally so the deck lets go on
  //              the frame the wind-down finishes rather than a round trip
  //              later, and start the 2.5 s of audible warning. `scheduleGravity`
  //              does not restart a running timer, so a re-announcement (the
  //              server broadcasts on every state change) cannot warn twice.
  //   inMs = 0 — it landed. The `gravity-shift` NoiseEvent is already on its way
  //              as a separate `noise` message, at the module centre.
  //
  // The continuous `state.gravity` array is applied every tick regardless, so a
  // dropped packet here costs the drama, never the truth.
  teardown.push(
    net.on('gravity', (event) => {
      if (!station) return;
      const centre = station.graph.centre(event.module);
      if (event.inMs > 0) {
        station.scheduleGravity(event.module, event.to, event.cause, event.t, event.inMs);
        // Driven from HERE and not only from `station.onGravityWarning`, because
        // the two are racing: the continuous `state.gravity` array can land the
        // pending change first, in which case `scheduleGravity` sees a timer
        // already running and correctly declines to warn a second time — and
        // the warning would never play at all. Both calls are idempotent per
        // module, so whichever arrives first wins and the other is a no-op.
        if (centre) audio.gravity.warn(event.module, centre, event.inMs / 1000);
      } else {
        station.setGravity(event.module, event.to, event.cause);
        // Same race, same reason: stop the wind-down and change the room's
        // character even if the snapshot got here first and set the mode
        // silently. The 35-loudness bang is a separate `noise` message.
        audio.gravity.shift(event);
      }
    }),
  );

  // Mirror the whole array on join, so a late arrival is not standing in a room
  // it believes has a floor.
  station?.applyGravitySnapshots(net.gravity());
  audio.gravity.applySnapshot(net.gravity());

  // §7's `inventory` is the whole carried-item contract — see `onInventory`.
  teardown.push(net.on('inventory', (msg) => onInventory(msg.items)));
  onInventory(net.inventory);

  // A genuine departure, which is the one signal that may free an identity seat
  // and a voice peer. Falling out of one `remoteBodies()` snapshot is not that.
  teardown.push(
    net.on('peerLeave', ({ id }) => {
      crew?.forget(id);
      voicePeers.delete(id);
    }),
  );

  // Round lifecycle.
  teardown.push(
    net.on('roundStart', (msg) => {
      puzzleStore.reset();
      cargo?.reset();
      station?.setAllLighting('emergency');
      // §11's hardware back to rest, and this round's items back in the lockers
      // the round's own seed puts them in. No geometry is built: every slot a
      // locker could ever fill was created at load (see `stationItems.ts`).
      station?.fixtures.reset();
      station?.stockLockers(msg.seed);
      fuseRevision = -1;
      cardRevision = -1;
      heldItem = null;
      inventory = [];
      // §5: "the round begins precisely as authored" — stage 0's gravity budget
      // is exactly zero, so every floor the director dropped comes back.
      station?.resetGravity();
      audio.gravity.reset();
      audio.gravity.applySnapshot(station?.gravitySnapshots() ?? []);
      exitSpectator();
      if (msg.spawn) player?.spawnAt(msg.spawn);
      player?.setAlive(true);
      audio.tracker.setAlive(true);
      ui.tracker.setAlive(true);
      ui.toast('you wake alone. find the others.', 4000);
    }),
    net.on('death', ({ playerId, cause }) => {
      if (playerId !== localId) return;
      player?.setAlive(false);
      releaseAllHolds();
      ui.toast(cause === 'alien' ? 'it found you' : 'you are dead', 5000);
      // §10: the dead speak to the living over the headset channel …
      audio.voice?.setPushToTalk(false);
      // … and they see through the module cameras, not out of their own corpse.
      enterSpectator();
    }),
    net.on('revived', ({ id }) => {
      if (id !== localId) return;
      exitSpectator();
      player?.setAlive(true);
      ui.toast('back with us', 3000);
    }),
    net.on('escaped', ({ id }) => {
      if (id !== localId) return;
      ui.toast('clear of the station', 5000);
      // An escapee is still `alive` server-side (`StationRoom.markEscaped`), so
      // neither tracker's own alive-gate nor `onNoiseIntent`'s `if (!alive)`
      // stops it — and a tracker beeping from the capsule is a loudness-20
      // event the crew left behind still has to pay for (§6).
      audio.tracker.setAlive(false);
      ui.tracker.setAlive(false);
    }),
    net.on('correction', ({ pos }) => {
      // §7: the server sanity-checks speed and teleports. No reconciliation.
      player?.teleport(pos);
    }),
    net.on('roundEnd', () => {
      releaseAllHolds();
      exitSpectator();
      player?.unlockPointer();
    }),
  );

  // The alien's pose is read per FRAME from `NetClient.alien()` — see
  // `drawAlien()` below. The obvious wiring (push `net.state.alien` on
  // `net:tick`, lerp with the ticker's alpha) looks like §7 but is not: the
  // local ticker's alpha and the server's patch cadence are independent clocks,
  // so a patch that lands late leaves alpha to run past 1, slide the capsule
  // forward, and snap it back when the real sample arrives. `net.alien()` is a
  // proper time-buffered interpolator over a render clock held one
  // `interpolationDelayMs` behind the newest sample — the same buffer
  // `remoteBodies()` uses — so it is already smooth and already late-tolerant.
  alien?.setVisibleModules(station?.visibleModules ?? null);

  // Systems coming online relight their module and escalate the director (§5).
  teardown.push(
    bus.on('puzzle:changed', ({ id, solved }) => {
      if (!solved) return;
      const module = net.state?.puzzles.get(id)?.module;
      if (module && station?.module(module)) {
        station.setLighting(module, 'nominal');
        renderer.setModuleLighting(module, 'nominal');
      }
    }),
    bus.on('director:stage', ({ stage }) => renderer.setDirectorStage(stage)),
    bus.on('alien:state', ({ to }) => renderer.setAlienState(to as AlienState)),
    bus.on('module:entered', ({ module }) => {
      // A drifting corpse still crosses modules; the room tone belongs to the
      // camera you are watching, not to the body you left (§10).
      if (spectating) return;
      applyModuleAmbience(module);
    }),
  );

  // Voice placement (§7: keep every peer connected, gate gain by proximity).
  teardown.push(
    net.on('welcome', () => {
      for (const id of net.peers) audio.voice?.addPeer(id);
    }),
  );
  for (const id of net.peers) audio.voice?.addPeer(id);
}

/** Forward a locally-made sound to the server. §7: we say what we did, never
 *  how loud it was — the server re-derives that from §14. */
function sendNoise(event: NoiseEvent, info?: NoiseInfo): void {
  // Kinds the SERVER already makes for itself. Forwarding them puts two copies
  // of one sound into §3's coalescing window, and the second one is the loud one
  // often enough to move the alien.
  //
  //   voice      — derived from the 10 Hz `voiceLevel` message (§7).
  //   breathing  — derived from the server's own heart-rate model (§6).
  //   hide-enter — `StationRoom.onHide` emits it "the instant you start climbing
  //   hide-exit    in", because the server owns the entry timer and therefore
  //                owns the haste that prices it. MEASURED before this line
  //                existed: one careful entry put TWO `hide-enter` events on the
  //                wire, at 8 and at 19, from the same keypress.
  if (SERVER_OWNED_NOISE.has(event.kind)) return;
  if (!net.connected) return;
  // The speed this event was MADE at, captured at emit time (§4) — NEVER
  // `player.speed`. By the time this runs the controller has arrested a catch
  // to zero and bled a crash through restitution and tangent friction, and an
  // impact's loudness is the closing speed along the contact normal rather than
  // the body's full speed. Re-deriving it here broadcast catchNoise(0) = 8 for
  // every catch and impactNoise(1.21) = 22 for a full-charge crash — under
  // HUNT_TRIGGER, so §5's chase loop step 3 could never fire. The local player
  // heard the correct value, which is why this was invisible in single-player.
  // `gait` and `hidden` are the same discipline one step further on. A footstep
  // and a landing are functions of the gait (§14 `footstepLoudness` /
  // `landingNoise`), and a hidden emitter pays §4's −8 dB shell. The server does
  // not TRUST either — it prices the step off the gait on your last accepted
  // transform and off its own record of who it put in a locker, which is the
  // §7 rule and the right one — but the contract carries them, and a client
  // that sends nothing is asserting nothing rather than asserting the truth.
  net.sendNoise(
    event.kind,
    event.origin,
    event.module,
    info?.speed ?? player?.speed,
    info?.gait,
    info?.hidden,
  );
}

// ===========================================================================
// 6 · the loop (§7: 20 Hz sim, render-rate draw)
// ===========================================================================

function wireLoop(): void {
  ticker.onFixed((dt) => {
    net.update();

    // §4/§7: the server owns which rooms have a floor, and this is the truth
    // rather than the drama — `state.gravity` is continuous, so a client that
    // joined late or dropped the `gravity` message still gets the regime right.
    // It writes `StationModule.gravity` in place, which is what the controller
    // reads every frame, so this one line is the whole "server → player mode"
    // path. It diffs internally and only touches modules that actually changed.
    //
    // `externalTimers` is the other half and it is not optional: with a server
    // in the room the announced countdown must run on ONE clock. Both sides
    // running it looks like a latency win and is a race — measured as a
    // liftoff/settle/liftoff flap on a single failure, three bangs and three
    // repaints. Offline it goes back to false and the local timer runs, which
    // is what keeps `station.scheduleGravity()` usable in the sandbox.
    if (station) {
      station.gravity.externalTimers = net.connected;
      if (net.connected) station.applyGravitySnapshots(net.gravity());
    }

    // §11 puzzle 3, on the fixed tick because it is a physics world (§1: the
    // nearest player is authority for a bag; an empty list owns nothing).
    if (cargo) cargo.update(dt, cargoPlayers());

    if (player) {
      // The ears go where the head is, BEFORE anything resolves a sound. While
      // dead that head is a camera in another module (§10) — the same ear
      // `NetClient.handleNoise` picks when it resolves noise for a spectator.
      runtime.setListener(
        spectating ? spectatorCamera.position : player.position,
        viewModule() ?? player.module,
      );
      // The Web Audio listener rides the same 20 Hz beat, and it belongs here
      // rather than in `onRender`: `AudioEngine.setListener` issues nine
      // `setTargetAtTime` calls per invocation (540/s at 60 fps, against a
      // budget §9 spends on the frame). Its smoothing constant is 15 ms, so at
      // 50 ms between updates every parameter still reaches its target well
      // before the next one arrives — 180/s, and nothing to hear.
      updateAudioListener();
      if (net.connected && roundLive()) {
        net.sendTransform(player.transformMessage(net.tick));
      }
    }

    interactor?.update(dt);
    audio.update(dt);

    // §11's hardware, from §11's state. Fixed rate, because that is the rate the
    // state arrives at; the joints themselves are eased per frame inside
    // `station.tick`, so a lever throw is smooth at any frame rate.
    pumpFixtures();
    // Where the loose carryables are, from the room's own puzzle records.
    pumpWorldItems();
    // §4: a hide spot's lamp goes out while somebody is in it, and "is that box
    // free?" is a question a teammate has to be able to answer across a module.
    pumpHideSpots();
    // §6's interact prompt — what [E] would do right now, and what it costs.
    // Fixed rate, with the other HUD pumps: it reads puzzle state that only
    // changes on a `puzzle` message, and `CargoStow.pick` is documented as a
    // fixed-tick query. `InteractPrompt.set()` structurally compares, so an
    // unchanged offer touches no DOM; the fade and the fill bar run per frame
    // inside `ui.update()`.
    pumpInteractPrompt();

    // §9's LightingRig pins its first light to the module you are looking at,
    // and §6's panels only draw for the module you are standing in. Both fall
    // back to something plausible when nobody tells them, which is why nothing
    // looked broken — but "plausible" is camera-distance ordering, not your
    // module. Idempotent: both early-return when the value has not changed.
    const view = viewModule();
    renderer.setPlayerModule(view);
    ui.setPlayerModule(view);

    // Crew count has no bus event — the authoritative list is the room state.
    // Counted off that state rather than through `players()`: the old idiom
    // (`players().filter(...).length`) built an array, a second array from the
    // filter, a `PlayerView` per player and a `pos`/`quat`/`items` triple inside
    // each — ~30 objects at 20 Hz for one integer.
    if (net.crewCount() > 0) ui.setCrew(net.crewAlive(), MAX_PLAYERS);
    // §6 calls the tracker's second trace the tutorial for the breathing
    // mechanic, and `StationRoom.updateBodies` owns that model — the client's
    // HeartRate is a different curve with an exertion term the server lacks.
    // Show the server's number or the trace teaches something the alien cannot
    // hear. `setServerHeartRate` latches: the bus estimate stops driving the
    // trace from the first call, and stays in charge offline where there is none.
    // One field, so it reads the field — `localPlayer()` materialises a whole
    // PlayerView (five objects) to hand back a single number.
    const heart = net.localHeartRate();
    if (heart !== null) ui.setServerHeartRate(heart);
  });

  ticker.onRender((_alpha, frameDt) => {
    // §7: never interpolate the local player. Render-rate update, real delta.
    player?.update(frameDt, net.tick);

    if (player) {
      // Culling follows the VIEW, not the corpse: a spectated module that is
      // three hops from your body must still be built and lit. The animation
      // tick is split out so landed gravity events carry the right §7 tick —
      // `update(view, frameDt)` would tick them with 0.
      station?.update(viewModule(), 0);
      station?.tick(frameDt, net.tick);
      // A bag follows the camera while you are carrying it. Render rate, not
      // fixed rate: it is in your hands, so it must not lag your head.
      if (cargo?.carrying && player.alive && !spectating) {
        cargo.carryFromCamera(player.position, cameraForward(_carryDir));
      }
      // A module camera has no hands: the crosshair would otherwise be frozen
      // at whatever the corpse was looking at when it died.
      ui.setCrosshair(
        spectating ? 'dot' : player.crosshair === 'charge' ? 'rail' : player.crosshair,
      );
    }

    // Remote bodies and the alien ARE interpolated (§7).
    drawAlien(frameDt);
    syncRemoteBodies(frameDt);

    // The hands ride the camera, so they update AFTER `player.update` wrote it:
    // the rail reach is resolved against this frame's camera matrix, not last
    // frame's. `Player` satisfies `HandsInput` structurally — no adapter, and
    // nothing that can drift out of step with the controller.
    if (hands && player) {
      // A module camera has no hands, and neither does a corpse (§10).
      hands.setVisible(!spectating && player.alive);
      // A cargo bag is already in both of them (§11 puzzle 3).
      hands.setHeld(cargo?.carrying ? null : heldItem);
      hands.update(frameDt, player, camera);
    }

    ui.update(frameDt);

    // A bolted-down module camera neither bobs nor swings: the corpse is still
    // drifting and still eating mouse deltas, and feeding either to §9's
    // flashlight bob and comfort vignette would shake a static shot.
    renderer.update(frameDt, {
      angularVelocity: spectating ? 0 : (player?.look.angularSpeed ?? 0),
      motion: spectating ? 0 : clamp((player?.speed ?? 0) / PUSH_MAX, 0, 1),
    });
  });
}

// ---------------------------------------------------------------------------
// 6a · puzzle state → the hardware on the wall (§11)
// ---------------------------------------------------------------------------

/** Reused: this runs at 20 Hz and an array a tick is an array a tick. */
const undockEngaged: boolean[] = [];

/**
 * Push §11's state into §11's ironmongery.
 *
 * `PuzzleFixture` diffs every joint target internally, so calling this every
 * fixed tick with unchanged state costs a handful of comparisons and writes
 * nothing. The clock matters though: `BreakerState.faultUntilMs` is a SERVER
 * epoch stamp — `src/puzzles/panels.ts` reads it against `Date.now()` too — and
 * it is what makes the whole lever gang shiver while the panel is buzzing.
 */
function pumpFixtures(): void {
  const fixtures = station?.fixtures;
  if (!fixtures) return;

  const breaker = puzzleStore.state('breaker-sequence');
  if (breaker) fixtures.setBreaker(breaker, Date.now());

  // One puzzle, two fixtures, two modules — §11's thesis puzzle. The wheel takes
  // the synced float, the gauge takes its damped follower and the green band.
  const coolant = puzzleStore.state('coolant-valve');
  if (coolant) {
    fixtures.setValve(coolant);
    fixtures.setGauge(coolant);
  }

  const keys = puzzleStore.state('airlock-keyswitch');
  if (keys) {
    for (let i = 0; i < keys.switches.length; i++) {
      fixtures.setKeyswitch(i, keys.switches[i]?.turnedAtMs != null);
    }
  }

  const undock = puzzleStore.state('undock-sequence');
  if (undock) {
    undockEngaged.length = 0;
    for (const lever of undock.levers) undockEngaged.push(lever.engaged);
    // `armed` unlatches all three red covers at once — the station announcing
    // four systems online, and the only global state that changes a shape.
    fixtures.setUndock(undock.armed, undockEngaged);
  }
}

// ---------------------------------------------------------------------------
// 6b · where the carryables are (§11 puzzles 1 and 4)
// ---------------------------------------------------------------------------

/** Last applied puzzle revision, so a 20 Hz pump does not rebuild a Set a tick. */
let fuseRevision = -1;
let cardRevision = -1;
const fuseLockers: string[] = [];

/**
 * The world form of the fuses and the sequence card, from the ROOM's records.
 *
 * `Station.stockLockers` seeds these from the client's own deterministic plan,
 * which is right offline and right for the first frame; once the server's puzzle
 * state arrives it is the truth, and it is the only thing that knows a fuse has
 * been picked up or fitted. An item still lying in a locker somebody emptied is
 * a lie a player would cross the station for.
 */
function pumpWorldItems(): void {
  const items = station?.items;
  if (!items) return;

  const fuse = puzzleStore.state('fuse-hunt');
  if (fuse && fuse.revision !== fuseRevision) {
    fuseRevision = fuse.revision;
    fuseLockers.length = 0;
    for (const record of fuse.fuses) {
      if (record.carriedBy || record.installed) continue;
      fuseLockers.push(record.locker);
    }
    items.setKindLocations('fuse', fuseLockers);
  }

  const breaker = puzzleStore.state('breaker-sequence');
  if (breaker && breaker.revision !== cardRevision) {
    cardRevision = breaker.revision;
    const locker = breaker.card.locker;
    items.setKindLocations('sequence-card', locker ? [locker] : []);
  }
}

// ---------------------------------------------------------------------------
// 6c · hide-spot lamps (§4)
// ---------------------------------------------------------------------------

/** Spot ids whose lamp is currently out, and this tick's set. Two Sets for the
 *  life of the process rather than two a tick. */
const lampsOut = new Set<string>();
const occupiedNow = new Set<string>();

/**
 * A taken hide spot goes dark.
 *
 * The alien is blind, so there is no sight logic to hang an occupancy cue on and
 * `props.ts` spends the one channel it has: a lit dot means you can get in, a
 * dark one means somebody already did. The local player is read off the
 * controller (which is authoritative for our own hide) and everybody else off
 * the raw schema — `net.players()` would materialise a `PlayerView` per player
 * at 20 Hz to read one string.
 */
function pumpHideSpots(): void {
  if (!station) return;
  occupiedNow.clear();

  const mine = player?.hideSpot ?? null;
  if (mine) occupiedNow.add(spotIdOf(mine));
  net.state?.players.forEach((p) => {
    if (p.id === localId || !p.hideSpot) return;
    occupiedNow.add(spotIdOf(p.hideSpot));
  });

  for (const spot of occupiedNow) {
    if (!lampsOut.has(spot)) station.setHideSpotOccupied(spot, true);
  }
  for (const spot of lampsOut) {
    if (!occupiedNow.has(spot)) station.setHideSpotOccupied(spot, false);
  }
  lampsOut.clear();
  for (const spot of occupiedNow) lampsOut.add(spot);
}

/** `${module}:${spot}` → `spot`, which is how `props.ts` keys its lamps.
 *  Tolerant, because a malformed key must not take the frame down. */
function spotIdOf(key: string): string {
  const i = key.indexOf(':');
  return i < 0 ? key : parseHideSpotKey(key).spot;
}

/**
 * The ears, in world space (§8).
 *
 * They ride the ACTIVE camera, so a spectator hears the module the camera he
 * chose is looking at (§10) and the §8 panning agrees with the picture instead
 * of with a corpse three modules away. Driven from the 20 Hz fixed step, not
 * per frame — see the call site for why that is inaudible.
 */
function updateAudioListener(): void {
  if (!player) return;
  if (spectating) {
    audio.engine.setListener(
      spectatorCamera.position,
      _earForward.set(0, 0, -1).applyQuaternion(spectatorCamera.quaternion),
      _earUp.set(0, 1, 0).applyQuaternion(spectatorCamera.quaternion),
    );
  } else {
    audio.engine.setListener(
      player.position,
      player.look.forward(_earForward),
      player.look.up(_earUp),
    );
  }
}

/**
 * The alien, from the net layer's own time-buffered interpolator.
 *
 * `net.alien()` samples a render clock held `interpolationDelayMs` behind the
 * newest snapshot, exactly like `remoteBodies()`, so what comes back is already
 * the pose for THIS frame. Hence `update(1, …)`: interpolating it a second time
 * against the local ticker's alpha — two clocks that never agreed — is what
 * made a late patch slide the capsule forward and then snap it back.
 */
/**
 * Refilled per frame rather than rebuilt. `AlienView.applySnapshot` copies
 * everything out through setTransform/setState/setModule and keeps no
 * reference, so one record is enough — and the COMPONENTS are copied, not the
 * vectors: `snap.pos`/`snap.quat` are the net layer's pooled objects and the
 * next interpolation overwrites them.
 */
const alienSnap: AlienSnapshot = {
  pos: { x: 0, y: 0, z: 0 },
  quat: { x: 0, y: 0, z: 0, w: 1 },
  state: 'DORMANT',
  module: '',
};

function drawAlien(frameDt: number): void {
  if (!alien) return;
  const snap = net.alien();
  if (snap) {
    alienSnap.pos.x = snap.pos.x;
    alienSnap.pos.y = snap.pos.y;
    alienSnap.pos.z = snap.pos.z;
    alienSnap.quat.x = snap.quat.x;
    alienSnap.quat.y = snap.quat.y;
    alienSnap.quat.z = snap.quat.z;
    alienSnap.quat.w = snap.quat.w;
    alienSnap.state = snap.state as AlienState;
    alienSnap.module = snap.module;
    alien.applySnapshot(alienSnap);
    // `applySnapshot` resolves the gait through `gravityOf` on every module
    // CHANGE, which misses the case §4 cares most about: the director cutting the
    // floor under an alien that is standing still. Re-read it every frame — it is
    // one map lookup and one field write, and `AlienView` blends the two
    // locomotions over 2.5 s rather than snapping between them.
    alien.setGravity(station?.moduleGravity(snap.module) ?? 'nominal');
  }
  alien.update(1, frameDt);
}

// ---------------------------------------------------------------------------
// remote bodies (§7 interpolation) and the voice placement that rides them
// ---------------------------------------------------------------------------

/** Peers we have already handed to the voice mesh, so a reunion never
 *  renegotiates (§7: "keep all peers connected permanently"). */
const voicePeers = new Set<string>();

/**
 * One pass over the interpolated bodies: draw them, place their voices.
 *
 * `net.remoteBodies()` is called ONCE and the array is shared with
 * `RemoteCrewViews.sync`, which reads it synchronously and retains nothing —
 * that array and the views in it belong to the net layer and are reused between
 * calls, so nothing here may hold one across a frame.
 *
 * Culling is passed in rather than applied to the object: the crew is one set of
 * instanced parts for the whole station, so a body in a module outside the
 * two-hop set is simply not written into the buffer.
 */
function syncRemoteBodies(frameDt: number): void {
  const bodies = net.remoteBodies();

  for (const body of bodies) {
    if (body.escaped) continue;
    if (!voicePeers.has(body.id)) {
      voicePeers.add(body.id);
      // A peer is a voice as much as a body (§7).
      audio.voice?.addPeer(body.id);
    }
    audio.voice?.setPeerPlacement(body.id, body.pos, body.module);
    audio.voice?.setPeerChannel(body.id, body.alive ? 'proximity' : 'headset');
  }

  crew?.sync(bodies, frameDt, {
    isVisible: (module) => (station ? station.isVisible(module) : true),
    // §4: a body in a `zero` module takes the whole orientation quaternion, roll
    // included; one on a deck takes yaw only and plants its feet.
    gravityOf: (module) => station?.moduleGravity(module) ?? 'nominal',
  });
}

// ===========================================================================
// 7 · interaction (§4 raycaster, §11 panels, §10 lockers and revival)
// ===========================================================================

/** `${module}:${propId}` → `propId`. Prop ids never contain a colon. */
function propIdOf(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

const _earForward = new THREE.Vector3();
const _earUp = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _carryDir = new THREE.Vector3();
const _pickDir = new THREE.Vector3();

/** Unit world-space forward of the eye camera, into `out`. */
function cameraForward(out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
}

const pickRay = new THREE.Raycaster();
const pickDir = new THREE.Vector3();
let heldRegion: string | null = null;
/** `${module}:${propId}` of the locker currently being pried or pumped. */
let heldJamKey: string | null = null;

/**
 * §11's canonical loud-fast / quiet-slow pair, on the jammed lockers hiding the
 * breaker card and the spare fuses: pry (60, 3 s) or hand-pump (6, 25 s).
 *
 * Both are HOLDS. `PuzzleInteractor` re-sends the heartbeat at 10 Hz and the
 * server expires it 250 ms after the last one, so letting go really does lose
 * the progress — which is the whole reason the quiet path costs 25 seconds
 * anchored and unable to look around.
 */
function beginJam(mode: 'pry' | 'pump'): void {
  if (!station || !interactor) return;
  const hit = pickInteractable();
  const target = hit ? station.interactableAt(hit.object) : null;
  if (!target || 'screen' in target) {
    // Panels are not lockers. Say so — a hold that silently does nothing reads
    // as a broken key, and the server has no message to send back either.
    ui.toast('nothing to force open here');
    return;
  }
  const key = `${target.module}:${target.id}`;
  if (heldJamKey && heldJamKey !== key) endJam();
  heldJamKey = key;
  // `pry`/`pump` are holds, NOT `net.sendInteract` one-shots: the server drops
  // them 250 ms after the last heartbeat.
  if (mode === 'pry') interactor.pry(key);
  else interactor.pump(key);
  // §6: which of the prompt's two lines is filling. `lockerPrompt` also feeds
  // the server's authoritative `progress`, which always wins over the local
  // integration — this is what says WHICH path you took while it does.
  ui.setInteractHolding(true, mode === 'pry' ? 'primary' : 'alt');
}

/**
 * Drop every held control — death, disconnect, the menu, the end of a round.
 * `releaseAll()` alone would leave `heldRegion` / `heldJamKey` pointing at a
 * control the server has already forgotten, so the next release edge would send
 * a stray message for it.
 */
function releaseAllHolds(): void {
  interactor?.releaseAll();
  heldRegion = null;
  heldJamKey = null;
  clearPromptHolds();
}

/** Every fill bar the prompt could be drawing, in one call. */
function clearPromptHolds(): void {
  ui.setInteractHolding(false, 'primary');
  ui.setInteractHolding(false, 'alt');
}

function endJam(): void {
  clearPromptHolds();
  if (!heldJamKey || !interactor) return;
  // `releaseJam` sends 'release-locker', NOT a bare 'release': on
  // breaker-sequence 'release' is the 20 s manual override's release and never
  // reaches the card locker (src/puzzles/logic/breakerSequence.ts).
  interactor.releaseJam(heldJamKey);
  heldJamKey = null;
}

function onInteractPress(): void {
  if (!player?.pointerLocked || !station || !player.alive) return;

  // Inside a hide spot, E is the way out and nothing else. §4: "no locomotion
  // input is read at all — you are a pair of ears and a decision about when to
  // leave", and the interaction ray can still see the panel you were standing
  // next to when you climbed in.
  if (player.hideSpot) {
    player.toggleHide();
    return;
  }

  // A bag in your hands is what E is for, until you put it down. Release is
  // deliberately gentle: `release()` with no velocity is the quiet option, and
  // the loud one (>1 m/s of contact loss = 30) is a throw you have to mean.
  if (cargo?.carrying) {
    cargo.release();
    return;
  }

  const hit = pickInteractable();
  if (hit) {
    const target = station.interactableAt(hit.object);
    if (target && 'screen' in target) {
      const panel = panelByProp.get(`${target.module}:${target.id}`);
      const region = panel && hit.uv ? panel.regionAt(hit.uv) : null;
      if (region && interactor?.pressRegion(region.id)) {
        heldRegion = region.id;
        // §6: only the two controls the prompt prices as a HOLD get a fill bar.
        // The valve regions are held too, but they are a continuous turn with
        // no completion to draw — a bar creeping toward an end that does not
        // exist would teach the wrong thing about the one puzzle whose whole
        // lesson is "slow is quiet".
        if (region.id === 'override' || region.id === 'lever') ui.setInteractHolding(true);
        return;
      }
      // The two panels that are not puzzles: the egress hatch and the capsule.
      if (/egress|capsule/.test(target.id)) {
        net.sendInteract(target.id, 'escape');
        return;
      }
      return;
    }
    if (target) {
      // A locker can hold a room item (medkit, decoy, pry bar) AND a puzzle
      // input (the §11 sequence card, a fuse). Ask for all three; the two that
      // do not apply are no-ops on the server.
      const key = `${target.module}:${target.id}`;
      // A JAMMED locker does not open to a press, and its door must not swing
      // to one. The door is cosmetic and client-side — §7 has no message for it
      // — so nothing upstream would have stopped it, and it is also what
      // REVEALS the contents: `StationItems` gates the world item on the door.
      // Swinging a jammed box open showed the fuse inside it and left the §6
      // prompt saying "HOLD 3S PRY LOCKER" over a door that was already open.
      // The server's answer is a toast; this is the same answer, in geometry.
      if (jamFor(target.id)) {
        ui.toast('jammed — pry it (60) or pump it (25 s)', 2500);
        return;
      }
      // Otherwise it swings on the press, either way. `StationItems` gates the
      // world item on the door, because a shut steel box showing its contents
      // (and its amber lamp) through 3 cm of plate is worse than no world item
      // at all.
      station.openLocker(target.id);
      lastOpenedLocker = target.id;
      if (net.connected) {
        net.sendInteract(key, 'loot');
        net.sendInteract(key, 'take');
        net.sendInteract(key, 'read-card');
        // Re-assert the room's own item records over the local reveal on the
        // next tick, whatever the server decides about this locker.
        fuseRevision = -1;
        cardRevision = -1;
      } else {
        // OFFLINE. The server owns looting, so with no server there is nobody to
        // ask — and "free flight only" still has to be able to open a box and see
        // what an item looks like in your hand, which is the whole of §5's decoy
        // and §11's card as a player meets them. The station's own locker plan is
        // the same deterministic roll the online path mirrors.
        lootOffline(target.id);
      }
      return;
    }
  }

  // Nothing authored in front of you. A cargo bag, then — it is a loose body
  // rather than an `interactable`, so it has its own pick against the Rapier
  // world's meshes rather than against the station BVH.
  if (cargo && player.module === cargo.module) {
    const bag = cargo.pick(player.position, cameraForward(_pickDir), INTERACT_RANGE_M);
    if (bag && cargo.grab(bag)) return;
  }

  // A hide spot within reach (§4). T is the primary binding and stays; this is
  // here because the crosshair already reports `hand` for a spot in range, so a
  // player who has learned "the hand means E" would otherwise be told to press
  // E and get nothing. It runs AFTER the interactable raycast on purpose: a
  // panel, a locker or a downed crewmate is never worth losing to a bunk you
  // happened to be standing beside.
  if (player.hideCandidate && player.toggleHide()) return;

  // Nothing in front of you: a downed crewmate within arm's reach (§10)?
  const me = player.position;
  for (const other of net.players()) {
    if (other.id === localId || other.alive || other.escaped) continue;
    if (distance(other.pos, { x: me.x, y: me.y, z: me.z }) <= REVIVE_RANGE_M) {
      net.sendInteract(other.id, 'revive');
      return;
    }
  }
}

/**
 * The offline sandbox's locker: take the first thing in it.
 *
 * Deliberately not a shadow inventory system. It reads what the station says is
 * in that locker — the same deterministic `planLockerContents` roll the online
 * path mirrors — takes one, and hands it to the same `heldItem` the server drives
 * online. The door has already swung by the time this runs.
 */
function lootOffline(lockerId: string): void {
  if (!station) return;
  const kind = station.items.contentsOf(lockerId)[0] ?? null;
  if (!kind) {
    ui.toast('empty', 1500);
    return;
  }
  station.takeFromLocker(lockerId, kind);
  takeItem(kind);
}

function onInteractRelease(): void {
  if (!heldRegion) return;
  interactor?.releaseRegion(heldRegion);
  heldRegion = null;
  ui.setInteractHolding(false);
}

function pickInteractable(): THREE.Intersection | null {
  if (!station) return null;
  camera.getWorldDirection(pickDir);
  pickRay.set(camera.getWorldPosition(_rayOrigin), pickDir);
  pickRay.near = 0;
  pickRay.far = INTERACT_RANGE_M;
  const hits = pickRay.intersectObjects(station.interactables, true);
  return hits[0] ?? null;
}

// ---------------------------------------------------------------------------
// 7a · the §6 interact prompt — "[E] OPEN LOCKER", priced
// ---------------------------------------------------------------------------
//
// The playtest note this exists for was blunt: "can u also have an interact
// button E pop up so people know they can interact with it." §6 already gave
// the crosshair a `hand` state and that is all it gave — the affordance said
// SOMETHING was there and never said which key, which verb, or what it cost.
//
// Two subsystems own the halves and neither may own the seam:
//
//   `src/player`  resolves GEOMETRY. One raycast, sampled at AIM_RAYCAST_HZ,
//                 feeding both `Player.crosshair` and `Player.interactTarget`
//                 — which is why a prompt built off it can never disagree with
//                 the glyph the player is looking through. It cannot tell a
//                 breaker panel from a locker, so it asks through
//                 `describeInteractable` below.
//   `src/ui`      renders and prices. `PROMPT` carries §14's loudness and hold
//                 times so nothing here retypes a number, and it draws §11's
//                 dual path as TWO lines rather than picking one for you.
//
// THE ONE RULE THIS FILE OWES BOTH OF THEM: `currentPrompt()` mirrors
// `onInteractPress()`'s priority order exactly. A prompt naming a different
// verb from the one the key runs is worse than no prompt at all — so the hide
// spot you are already inside beats the bag in your hands beats the ray beats a
// loose cargo bag beats a hide spot in reach beats a downed crewmate, in that
// order, in both functions.
//
// NOT re-raycast: the common case reads `player.interactTarget`, which is the
// cached aim result. The one live cast is against a single panel's screen mesh
// (`regionUnderCrosshair`), because a panel's verb is per-REGION and the
// controller does not carry a UV.

/** Refilled, never minted: `Player.refreshInteractTarget` copies the fields out
 *  on the same line and keeps no reference. */
const _describeInfo: InteractableInfo = {};

function describeInteractable(object: THREE.Object3D): InteractableInfo | null {
  const thing = station?.interactableAt(object) ?? null;
  if (!thing) return null;
  if ('screen' in thing) {
    _describeInfo.kind = 'panel';
    _describeInfo.label = /egress|capsule/.test(thing.id) ? 'capsule' : 'panel';
    _describeInfo.usable = true;
    return _describeInfo;
  }
  _describeInfo.kind = 'locker';
  _describeInfo.label = 'locker';
  // A jammed locker is very much usable — it is the §11 pry-or-pump choice, and
  // dimming it would hide the one prompt in the game that teaches the rule. An
  // emptied one is not: a key that silently does nothing reads as a broken
  // build, so it is reported and dimmed rather than dropped.
  _describeInfo.usable = jamFor(thing.id) !== null || !isSpentLocker(thing);
  return _describeInfo;
}

/** Open, and with nothing left in it that this client knows about. */
function isSpentLocker(locker: Locker): boolean {
  return locker.open && (station?.items.contentsOf(locker.id).length ?? 0) === 0;
}

/**
 * The live jam on a locker, or null.
 *
 * §11's jammed lockers are SERVER state and they belong to two different
 * puzzles — the breaker card's locker and each of the three fuse lockers — so
 * "is this box jammed" is a question only the puzzle store can answer. Both
 * record it against the locker's own prop id, which is what
 * `Station.interactableAt` hands back.
 */
function jamFor(lockerId: string): JamState | null {
  const card = puzzleStore.state('breaker-sequence')?.card;
  if (card && card.locker === lockerId && card.jam?.jammed) return card.jam;
  const fuses = puzzleStore.state('fuse-hunt')?.fuses;
  if (fuses) {
    for (const record of fuses) {
      if (record.locker === lockerId && record.jam.jammed) return record.jam;
    }
  }
  return null;
}

function pumpInteractPrompt(): void {
  ui.setInteractPrompt(currentPrompt());
}

/**
 * What [E] would do this instant, priced — or null for "nothing in reach".
 *
 * Reads `onInteractPress()`'s order top to bottom. Keep them in step.
 */
function currentPrompt(): InteractPromptSpec | null {
  if (!player || !station) return null;
  // A corpse watching a module camera has no hands, and neither has anyone
  // staring at the menu with the pointer released (§10, §6).
  if (!player.alive || spectating !== null || !player.pointerLocked) return null;

  // Inside a hide spot, E is the way out and nothing else (§4).
  if (player.hideSpot) return PROMPT.leaveHide(player.hideSpot);
  // A bag in your hands is what E is for until you put it down (§11 puzzle 3).
  if (cargo?.carrying) return PROMPT.dropBag(cargo.carrying);

  // The cached aim result — the same one the crosshair's `hand` state comes
  // from. `object` is null only for a hide spot, which is handled below.
  const target = player.interactTarget;
  const thing = target?.object ? station.interactableAt(target.object) : null;
  if (thing) {
    // Both branches are terminal in `onInteractPress`, so they are terminal
    // here: a panel with no control under the crosshair offers nothing, and it
    // must not fall through to the bunk you happen to be standing beside.
    return 'screen' in thing ? panelPrompt(thing) : lockerPrompt(thing);
  }

  // A loose cargo bag. Not an `interactable` — it is a rigid body in the Rapier
  // world — so it has its own pick, and `CargoStow.pick` is documented as a
  // fixed-tick query, which is the rate this runs at.
  if (cargo && player.module === cargo.module) {
    const bag = cargo.pick(player.position, cameraForward(_pickDir), INTERACT_RANGE_M);
    if (bag) return PROMPT.takeBag(bag);
  }

  // A hide spot in reach (§4). PRICED BY THE GAIT YOU ARE HOLDING RIGHT NOW:
  // `hideCandidate` recomputes both numbers from §14 every frame, so the cost
  // chip visibly drops from 30 to 8 as you let go of sprint. That is the
  // loud-fast/quiet-slow rule taught in one glance, with no tutorial text.
  const spot = player.hideCandidate;
  if (spot) {
    const usable = target?.kind === 'hide' ? target.usable : true;
    return {
      ...PROMPT.hide(spot.volume.key, spot.loudness, spot.seconds),
      usable,
      blocked: usable ? undefined : 'taken',
    };
  }

  // A downed crewmate within arm's reach (§10). Read off the raw schema rather
  // than `net.players()`, which mints a PlayerView plus a pos/quat/items triple
  // per player to answer one distance question.
  const me = player.position;
  let downed: string | null = null;
  net.state?.players.forEach((other) => {
    if (downed !== null || other.id === localId || other.alive || other.escaped) return;
    const dx = other.pos.x - me.x;
    const dy = other.pos.y - me.y;
    const dz = other.pos.z - me.z;
    if (dx * dx + dy * dy + dz * dz <= REVIVE_RANGE_M * REVIVE_RANGE_M) downed = other.id;
  });
  return downed === null ? null : PROMPT.revive(downed);
}

/** A §11 panel: whichever control is actually under the crosshair. */
function panelPrompt(panel: StationPanel): InteractPromptSpec | null {
  const face = panelByProp.get(`${panel.module}:${panel.id}`);
  const region = face ? regionUnderCrosshair(panel, face) : null;
  const spec = region ? promptForRegion(region.id) : null;
  if (spec) return spec;
  // The two panels that are not puzzles: the egress hatch and the capsule.
  // `onInteractPress` falls back to them the same way, after the regions.
  if (/egress|capsule/.test(panel.id)) return PROMPT.board();
  // A §11 panel with no control under the crosshair. Pressing E here really
  // does nothing — `pressRegion` returns false and the handler returns — and
  // that is easier to hit than it sounds: the six breakers are authored with a
  // 1% dead lane between them, and the exact centre of the main bus panel falls
  // in it (measured headlessly). A `hand` crosshair over silence is the precise
  // complaint this prompt exists to answer, so it says which half is missing
  // rather than nothing at all.
  return face
    ? {
        id: `${panel.module}:${panel.id}`,
        verb: 'use',
        noun: 'panel',
        usable: false,
        blocked: 'aim at a control',
      }
    : null;
}

/**
 * The panel region the crosshair is on, from ONE mesh.
 *
 * `pickInteractable()` casts against all 22 interactables to find out WHICH
 * thing you are aiming at; `player.interactTarget` has already answered that,
 * so this only has to ask WHERE on that panel's glass — one mesh, no
 * broad-phase, and nothing allocated past three's own intersection records. It
 * is cast from the CAMERA, exactly like the press-time ray, so the prompt and
 * the key resolve the same control; and if the head has turned off the panel
 * since the controller last sampled its aim, the cast simply misses and the
 * prompt goes.
 */
const _regionHits: THREE.Intersection[] = [];

function regionUnderCrosshair(panel: StationPanel, face: Panel<unknown>): PanelRegion | null {
  camera.getWorldDirection(pickDir);
  pickRay.set(camera.getWorldPosition(_rayOrigin), pickDir);
  pickRay.near = 0;
  pickRay.far = INTERACT_RANGE_M;
  _regionHits.length = 0;
  pickRay.intersectObject(panel.screen, false, _regionHits);
  const uv = _regionHits[0]?.uv ?? null;
  _regionHits.length = 0;
  return uv ? face.regionAt(uv) : null;
}

/**
 * One panel control → its priced prompt. Mirrors `PuzzleInteractor.pressRegion`
 * case for case; a region it does not name is a control that does nothing, and
 * offering a verb for one would be a lie.
 */
function promptForRegion(regionId: string): InteractPromptSpec | null {
  const breaker = /^breaker-(\d+)$/.exec(regionId);
  if (breaker) return PROMPT.breaker(Number.parseInt(breaker[1]!, 10));
  switch (regionId) {
    case 'override':
      return overridePrompt();
    case 'valve-open-slow':
    case 'valve-close-slow':
      return PROMPT.valveSlow();
    case 'valve-open-fast':
    case 'valve-close-fast':
      return PROMPT.valveFast();
    case 'valve-lock':
      return PROMPT.valveLock();
    case 'key-a':
      return PROMPT.keyswitch('a');
    case 'key-b':
      return PROMPT.keyswitch('b');
    case 'lever':
      return leverPrompt();
    case 'install':
      return installPrompt();
    case 'board':
    case 'launch':
      return PROMPT.board();
    default:
      return null;
  }
}

/**
 * The fusebox (§11 puzzle 4). You need a fuse in your hands.
 *
 * Read off the puzzle state and not off `inventory`: the room tracks a fuse as
 * `FuseRecord.carriedBy` and that is what its `install` handler consults, so
 * anything else here would be a second opinion. Fitting one has no entry in
 * §14's loudness table, and inventing a number is exactly what `PROMPT` exists
 * to prevent — so it is offered unpriced rather than priced wrongly.
 */
function installPrompt(): InteractPromptSpec {
  const fuses = puzzleStore.state('fuse-hunt')?.fuses;
  const carrying = fuses?.some((f) => f.carriedBy === localId && !f.installed) ?? false;
  return {
    id: 'fuse-hunt:install',
    verb: 'fit',
    noun: 'fuse',
    usable: carrying,
    blocked: carrying ? undefined : 'no fuse',
  };
}

/** The 20 s manual override, with the SERVER's count rather than the HUD's. */
function overridePrompt(): InteractPromptSpec {
  const override = puzzleStore.state('breaker-sequence')?.override;
  const spec = PROMPT.override();
  // Somebody else's hold is their progress, not yours — and a bar filling while
  // your hands are nowhere near the lever would be a lie about who is exposed.
  // Only mirror it when the holder is us.
  return override && override.holder === localId
    ? { ...spec, progress: override.progress01 }
    : spec;
}

/** An undock lever (§11 puzzle 6). Three players, five seconds, all at once. */
function leverPrompt(): InteractPromptSpec {
  const undock = puzzleStore.state('undock-sequence');
  const spec = PROMPT.lever();
  if (!undock) return spec;
  // `progress` is the SHARED count — it only moves while all three are down and
  // any release zeroes it. That is the number three people are counting to over
  // voice, so it is the number the bar should show.
  const progress = undock.required > 0 ? undock.progress / undock.required : 0;
  return undock.armed
    ? { ...spec, progress }
    : { ...spec, progress: 0, usable: false, blocked: 'not armed' };
}

/** A locker: the §11 dual path if it is jammed, otherwise the door. */
function lockerPrompt(locker: Locker): InteractPromptSpec {
  const key = `${locker.module}:${locker.id}`;
  const jam = jamFor(locker.id);
  // BOTH prices, stacked — pry (60, 3 s) over pump (6, 25 s). §11 calls the
  // loud-fast/quiet-slow rule "what keeps the noise system relevant after the
  // map is learned", and a prompt naming only the pry bar would delete the
  // quiet half for every player who never found B. The progress is the
  // server's own: it owns the hold and drops it 250 ms after the last
  // heartbeat, so a locally integrated bar would keep filling after a lag spike
  // had already cost you the 25 seconds.
  if (jam) return { ...PROMPT.jammed(key), progress: jamProgress01(jam) };
  if (isSpentLocker(locker)) {
    return { ...PROMPT.openLocker(), id: key, usable: false, blocked: 'empty' };
  }
  return { ...PROMPT.openLocker(), id: key };
}

// ---------------------------------------------------------------------------
// hatches (§5's chase loop, step 4) and decoys (§5)
// ---------------------------------------------------------------------------

function nearestPort(): { module: ModuleId; port: PortId; open: boolean; sealed: boolean } | null {
  if (!station || !player) return null;
  const here = { x: player.position.x, y: player.position.y, z: player.position.z };
  let best: { module: ModuleId; port: PortId; open: boolean; sealed: boolean } | null = null;
  let bestDistance = HATCH_REACH_M;
  const module = station.module(player.module);
  if (!module) return null;
  for (const port of module.ports) {
    if (!port.link) continue;
    const world = station.graph.portWorldPos(module.id, port.id);
    if (!world) continue;
    const d = distance(world, here);
    if (d > bestDistance) continue;
    bestDistance = d;
    best = { module: module.id, port: port.id, open: port.hatch.open, sealed: port.hatch.sealed };
  }
  return best;
}

function cycleNearestHatch(): void {
  const target = nearestPort();
  if (!target) {
    ui.toast('no hatch in reach');
    return;
  }
  if (target.sealed) {
    ui.toast('sealed');
    return;
  }
  net.sendHatch(target.module, target.port, target.open ? 'close' : 'open');
}

function sealNearestHatch(): void {
  const target = nearestPort();
  if (!target) {
    ui.toast('no hatch in reach');
    return;
  }
  // §5: two charges per round, held by the server. It will refuse a third.
  net.sendHatch(target.module, target.port, 'seal');
}

function throwDecoy(): void {
  if (!player) return;
  if (net.connected && !net.inventory.includes('decoy')) {
    ui.toast('no decoy');
    return;
  }
  const forward = player.look.forward();
  const origin: Vec3 = {
    x: player.position.x + forward.x * DECOY_THROW_M,
    y: player.position.y + forward.y * DECOY_THROW_M,
    z: player.position.z + forward.z * DECOY_THROW_M,
  };
  // 70 on impact, the loudest thing in the game, and one of two per round.
  emitter.decoy(origin, player.module);
  // Online, the server's next `inventory` takes it out of your hand. Offline
  // there is no inventory message, so the hand has to empty itself or the decoy
  // you just threw is still in it.
  if (!net.connected && heldItem === 'decoy') {
    inventory = inventory.filter((item) => item !== 'decoy');
    heldItem = inventory[inventory.length - 1] ?? null;
  }
}

// ===========================================================================
// 7b · spectator cameras (§10, M7b)
//
//   "Spectators get a job. The dead see through module cameras and speak to
//    the living over the headset channel at loudness 5 — the team's eyes, at
//    almost no noise cost. Cameras show modules and players, never the alien."
//
// Every half of this existed and none of it was connected: the server already
// accepts `interact { action:'spectate', value: <module> }` and stores
// `player.spectating` (which it also uses as the dead player's noise ear), and
// `Renderer.setCamera` / `PostChain.setCamera` / `Flashlight.setCamera` were all
// written for exactly this. Nothing sent the verb and nothing swapped the
// camera, so death left you inside your own drifting corpse — watching the
// alien proxy, which is the one thing §10 says the cameras must not show.
// ===========================================================================

/**
 * The camera bolted in the module, as opposed to the one in your head.
 *
 * Kept out of the scene graph's hot path: it is only re-placed when the
 * spectator cycles, and `Renderer.setCamera` owns its aspect and FOV.
 */
const spectatorCamera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / Math.max(1, window.innerHeight),
  0.05,
  200,
);
spectatorCamera.name = 'spectator-camera';
scene.add(spectatorCamera);

/** The module we are watching, or null while alive. */
let spectating: ModuleId | null = null;
/** Cycle order, built once per death from the live station. */
let spectatorOrder: ModuleId[] = [];

const _specPos = new THREE.Vector3();
const _specEye = new THREE.Vector3();
const _specAt = new THREE.Vector3();
const _specQuat = new THREE.Quaternion();

/**
 * The module the local VIEW is in — the camera you are watching through, or
 * your own module. Culling, lighting, the panel gate and the noise ear all key
 * off this rather than off `player.module`, because a corpse keeps drifting
 * after you have stopped looking through it.
 */
function viewModule(): ModuleId | null {
  return spectating ?? player?.module ?? null;
}

function enterSpectator(): void {
  if (!station || spectating) return;
  spectatorOrder = station.modules.map((m) => m.id);
  if (spectatorOrder.length === 0) return;

  // The server parks you on your own module the instant it kills you
  // (`StationRoom.markDead`), so start where the body is and let them walk it.
  const start = net.localPlayer()?.spectating || player?.module || spectatorOrder[0]!;
  const index = Math.max(0, spectatorOrder.indexOf(start));
  setSpectatorModule(spectatorOrder[index]!);
  renderer.setCamera(spectatorCamera);
  ui.toast(
    `camera ${index + 1}/${spectatorOrder.length} — [ and ] to cycle. ` +
      'you are still on the headset.',
    6000,
  );
}

function exitSpectator(): void {
  if (!spectating) return;
  spectating = null;
  spectatorOrder = [];
  renderer.setCamera(camera);
  // The alien is drawable again …
  applyCull(station?.visibleModules ?? []);
  // … and the room tone belongs to the module you woke up in. `module:entered`
  // only fires on a CHANGE, so reviving where you died would otherwise leave
  // the ambience on the last camera you were watching.
  if (player) applyModuleAmbience(player.module);
}

/** §8 room tone and reverb for one module. */
function applyModuleAmbience(module: ModuleId | null): void {
  const m = module ? station?.module(module) : undefined;
  if (!m) return;
  audio.engine.setListenerModule(m.kind, m.volume);
  audio.ambience.setModule(m.kind, m.volume);
  audio.ambience.setLighting(m.lighting);
  // §4/§8: a `zero` module is THINNER, not quieter — the plant and its pump are
  // what stopped. This is the line that makes a floorless room SOUND like one,
  // and `GravityAudio` owns that knob: never call `ambience.setGravity()` here
  // as well, or the two will fight over the same fader.
  audio.gravity.setListenerModule(m.id, m.gravity);
}

function cycleSpectator(step: number): void {
  if (!spectating || spectatorOrder.length === 0) return;
  const at = spectatorOrder.indexOf(spectating);
  const next = (((at < 0 ? 0 : at) + step) % spectatorOrder.length + spectatorOrder.length) %
    spectatorOrder.length;
  setSpectatorModule(spectatorOrder[next]!);
  ui.toast(`camera ${next + 1}/${spectatorOrder.length} — ${spectatorOrder[next]}`, 2000);
}

function setSpectatorModule(module: ModuleId): void {
  spectating = module;
  placeSpectatorCamera(module);
  // Tell the room, so the dead player's noise ear (StationRoom.updateBodies)
  // moves to the module they are actually watching.
  if (net.connected) net.sendInteract('spectate', 'spectate', module);
  // Cameras show modules and players, never the alien (§10). An empty visible
  // set is how `AlienView` hides itself; `applyCull` re-applies this on every
  // cull change, so drifting out of the corpse's hop set cannot un-hide it.
  applyCull(station?.visibleModules ?? []);
  // The two-hop cull set is built around the VIEW now, so pull the station over
  // in the same frame rather than waiting for the next render.
  station?.update(module, 0);
  applyModuleAmbience(module);
}

/**
 * Where a station camera would actually be bolted: up in a corner at one end of
 * the module, looking down its long axis. Derived from the kit piece rather
 * than authored, so it is right for all five shapes and for any level.
 */
function placeSpectatorCamera(module: ModuleId): void {
  const m = station?.module(module);
  if (!m) return;
  const piece = kitPiece(m.kind);
  const radius = Math.max(0.6, piece.radius);
  const half = Math.max(0.8, piece.length * 0.5);

  _specQuat.set(m.transform.quat.x, m.transform.quat.y, m.transform.quat.z, m.transform.quat.w);
  _specPos.set(m.transform.pos.x, m.transform.pos.y, m.transform.pos.z);
  _specEye.set(0, radius * 0.55, half - 0.45).applyQuaternion(_specQuat).add(_specPos);
  _specAt.set(0, -radius * 0.1, -half).applyQuaternion(_specQuat).add(_specPos);

  spectatorCamera.position.copy(_specEye);
  // "Up" is the module's up, not the world's: the station is a graph of tubes
  // pointing every which way, and a world-up camera rolls at random.
  spectatorCamera.up.set(0, 1, 0).applyQuaternion(_specQuat);
  spectatorCamera.lookAt(_specAt);
  // The flashlight reads `matrixWorld`, and this camera only moves when the
  // spectator cycles — so update it here rather than once per frame.
  spectatorCamera.updateMatrixWorld(true);
}

// ===========================================================================
// 8 · starting a round
// ===========================================================================

async function beginRound(restart = false): Promise<void> {
  ui.hideMenu();
  player?.lockPointer();

  // Web Audio needs a gesture, and this is the only one we are guaranteed.
  await audio.engine.resume();

  if (net.connected) {
    if (restart) net.restartRound();
    else net.startRound();
    void startVoice();
  } else {
    offlineRunning = true;
  }
}

let voiceStarted = false;

/** §7: "Calibrate the mic, or hardware variance kills the feature in session
 *  one." Non-negotiable, and it only ever runs once per browser. */
async function startVoice(): Promise<void> {
  const voice = audio.voice;
  if (!voice || voiceStarted) return;
  voiceStarted = true;
  try {
    await voice.start();
    const calibrated = voice.micCalibration.at > 0;
    if (!calibrated) {
      ui.toast('mic calibration — say nothing for two seconds', 2500);
      let announced = '';
      await voice.calibrate({
        onProgress: ({ phase }) => {
          if (phase === announced) return;
          announced = phase;
          if (phase === 'speech') ui.toast('now speak normally', 4000);
        },
      });
      ui.toast('mic calibrated', 2500);
    }
  } catch (err) {
    voiceStarted = false;
    console.warn('[voice] unavailable:', describe(err));
    ui.toast('no microphone — voice is off', 4000);
  }
}

/** Offline sandbox: drop into the first spawnable module so §4 is playable
 *  with no server at all (M0/M1 in the finished station). */
function spawnOffline(): void {
  if (!station || !player) return;
  // §10 gained a constraint with the pivot: never wake somebody in an authored
  // zero-G module. The first thirty seconds are when a player builds the
  // spatial model pillar 3 exists to protect, and they should build it standing
  // on a floor. Fall back to anything at all rather than refusing to spawn.
  const candidates = station.spawnCandidates();
  const module =
    candidates.find((id) => station!.moduleGravity(id) === 'nominal') ??
    candidates[0] ??
    station.modules[0]?.id;
  if (!module) return;
  if (station.moduleGravity(module) === 'nominal') {
    // On the deck, eyes at standing height. `player.position` IS the eye in both
    // regimes (the body hangs below it), so spawning at the deck plane itself
    // would bury the camera in the plating.
    const centre = station.graph.centre(module);
    if (centre) {
      player.spawnAt({
        pos: { x: centre.x, y: centre.y + DECK_Y_M + EYE_SPAWN_M, z: centre.z },
        module,
      });
    }
  } else {
    // No floor: put them on a handrail, which is where zero-G starts.
    const rails = station.rails.inModule(module);
    const anchor = rails[0]?.mid ?? station.graph.centre(module);
    if (anchor) player.spawnAt({ pos: { x: anchor.x, y: anchor.y + 0.4, z: anchor.z }, module });
  }
  offlineRunning = true;
}

// ===========================================================================
// 9 · teardown
// ===========================================================================

window.addEventListener('beforeunload', () => {
  for (const off of teardown) off();
  ticker.stop();
  player?.dispose();
  hands?.dispose();
  crew?.dispose();
  alien?.dispose();
  cargo?.dispose();
  audio?.dispose();
  void net.disconnect();
});

// A round that lasts §14's STAGE_TIMEOUT is 8 minutes of frames; a thrown
// exception during boot must not leave a black screen with no explanation.
void boot().catch((err) => {
  console.error('[main] boot failed:', err);
  ui.menu.setStatus(`boot failed: ${describe(err)}`);
});

// Handy in the console while playtesting; costs nothing.
Object.assign(globalThis as Record<string, unknown>, {
  iss: {
    get station() {
      return station;
    },
    get player() {
      return player;
    },
    net,
    runtime,
    emitter,
    bus,
    ui,
    renderer,
    ticker,
    get alien() {
      return alien;
    },
    get hands() {
      return hands;
    },
    get crew() {
      return crew;
    },
    /** Put something in your hand without a server — playtesting the held forms. */
    hold: (kind: ItemKind | null) => {
      heldItem = kind;
      return kind;
    },
    get interactor() {
      return interactor;
    },
    get cargo() {
      return cargo;
    },
    get audio() {
      return audio;
    },
  },
});

export {};
