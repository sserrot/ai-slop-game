/**
 * src/dev/alienViewer.ts — the model viewer behind `alien.html`.
 *
 * A dev tool, and it earns its keep by importing the REAL `AlienView` rather
 * than a copy of it. There is no second creature here to drift out of sync: the
 * body on screen is the body in the game, built by the same constructor, posed
 * by the same `applyPose`, riding the same `PALETTE.organic` material, and
 * running the same `assertAlienCoherent()` at import. If this page looks wrong,
 * the game looks wrong.
 *
 * Three things it does that a screenshot cannot:
 *
 *  • IT DRIVES THE REAL TRANSPORT. The alien is not animated directly; a fake
 *    20 Hz server writes `setTransform` and the render loop interpolates
 *    between ticks exactly as §7 does. That matters because the tail's whip is
 *    driven by a yaw rate MEASURED off the interpolated heading — animate the
 *    body by hand and you would be testing something the game never runs.
 *  • IT WALKS A CIRCLE. Standing still hides the entire point. On a curve the
 *    hips lead and the tail trails and overshoots, which is the change.
 *  • IT A/Bs. `secondary: false` rebuilds the view as the r3 sine-only
 *    creature. The difference is the argument.
 *
 * Not shipped: `vite build` has one input (`index.html`). Run `npm run dev` and
 * open /alien.html.
 */

import * as THREE from 'three';
import { AlienView, ALIEN_DECK_DROP_M, alienGeometryReport } from '../alien/alienView';
import { FLESH_WRAP_AVAILABLE } from '../alien/flesh';
import { tryLoadAlienSkin } from '../alien/skin';
import type { AlienSkin } from '../alien/skin';
import type { AlienState, GravityMode } from '@shared/types';

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

/** m — the circle the fake server walks it around. Comfortably inside the back
 *  wall, so the shadow has somewhere to land through the whole lap. */
const WALK_RADIUS = 2.0;
/** The §7 tick the interpolation is written against. Not a round 60. */
const SERVER_HZ = 20;
const SERVER_DT = 1 / SERVER_HZ;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
// §9's exponential fog. It is doing as much work on this page as it does in the
// game: it is what stops a pale body reading as a toy on a turntable.
scene.fog = new THREE.FogExp2(0x05070a, 0.075);

const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 80);

// -- the room ---------------------------------------------------------------
// Deliberately not a grid and not a studio. Two dark planes, one lamp, one
// shadow map: the smallest thing that can honestly answer "what does this look
// like in the station".
const deckMat = new THREE.MeshStandardMaterial({ color: 0x272c2e, roughness: 0.94 });
const deck = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), deckMat);
deck.rotation.x = -Math.PI / 2;
deck.position.y = -ALIEN_DECK_DROP_M;
deck.receiveShadow = true;
scene.add(deck);

const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(24, 7),
  new THREE.MeshStandardMaterial({ color: 0x1e2427, roughness: 0.9 }),
);
wall.position.set(0, 3.05 - ALIEN_DECK_DROP_M, -4.6);
wall.receiveShadow = true;
scene.add(wall);

// -- the light --------------------------------------------------------------
// A stand-in for §9's one shadow-casting spot: same 1024², same soft edge, same
// short throw. The shadow it draws on that back wall is the whole reason the
// alien was given `castShadow: true`, so the viewer had better be able to show
// it.
scene.add(new THREE.AmbientLight(0x2b3540, 0.55));
const key = new THREE.SpotLight(0xfff0dc, 26, 22, 0.42, 0.55, 1.6);
key.position.set(2.6, 3.4, 4.2);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 22;
key.shadow.bias = -0.0007;
key.shadow.normalBias = 0.02;
scene.add(key);
scene.add(key.target);

// A cold rim from behind, so the silhouette separates from the wall even where
// the key does not reach. One light, and it casts nothing.
const rim = new THREE.DirectionalLight(0x7d9ab8, 0.85);
rim.position.set(-4, 2.4, -3.5);
scene.add(rim);

// ---------------------------------------------------------------------------
// The creature
// ---------------------------------------------------------------------------

let view: AlienView | null = null;
let skin: AlienSkin | null = null;

function buildView(secondary: boolean, flesh: boolean): void {
  view?.dispose();
  // `dispose()` takes the skin with it, so a rebuild starts from cylinders and
  // the caller re-adopts. That is the honest behaviour to expose here: it is
  // exactly what the game would do if a quality tier dropped the sculpt.
  skin = null;
  view = new AlienView({ castShadow: true, secondary, flesh });
  scene.add(view.object3D);
  // A rebuild resets the phase, so re-seed it from the sim rather than letting
  // the body teleport back to the start of the circle.
  view.setTransform(bodyPos(theta), bodyQuat(theta));
  view.setTransform(bodyPos(theta), bodyQuat(theta));
  view.setState(state);
  view.setGravity(gravity);
}

// ---------------------------------------------------------------------------
// The fake server (§7, in twelve lines)
// ---------------------------------------------------------------------------

let state: AlienState = 'SEARCH';
let gravity: GravityMode = 'nominal';
let speed = 0;
let moving = true;
let theta = 0;

const scratchQ = new THREE.Quaternion();
const FORWARD = new THREE.Vector3(0, 0, -1);
const tangent = new THREE.Vector3();

function bodyPos(t: number): { x: number; y: number; z: number } {
  return moving
    ? { x: Math.cos(t) * WALK_RADIUS, y: 0, z: Math.sin(t) * WALK_RADIUS }
    : { x: 0, y: 0, z: 0 };
}

function bodyQuat(t: number): { x: number; y: number; z: number; w: number } {
  // Facing along the tangent, which is what makes this a TURN and not a slide.
  tangent.set(-Math.sin(t), 0, Math.cos(t)).normalize();
  scratchQ.setFromUnitVectors(FORWARD, moving ? tangent : FORWARD);
  return { x: scratchQ.x, y: scratchQ.y, z: scratchQ.z, w: scratchQ.w };
}

function stepServer(dt: number): void {
  if (moving && speed > 0) theta += (speed / WALK_RADIUS) * dt;
  view?.setTransform(bodyPos(theta), bodyQuat(theta));
}

// ---------------------------------------------------------------------------
// Camera — hand-rolled orbit, because a dev page should not pull in an addon
// ---------------------------------------------------------------------------

let azimuth = 0.65;
let elevation = 0.24;
let dist = 5.4;
let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  azimuth -= (e.clientX - lastX) * 0.006;
  elevation = Math.max(-0.35, Math.min(1.25, elevation + (e.clientY - lastY) * 0.005));
  lastX = e.clientX;
  lastY = e.clientY;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    dist = Math.max(1.6, Math.min(14, dist * (1 + Math.sign(e.deltaY) * 0.1)));
  },
  { passive: false },
);

const focus = new THREE.Vector3();
const focusTarget = new THREE.Vector3();
/** Nudge along Z, so the dev handle can frame the head or the tail. */
let focusBias = 0;

function placeCamera(): void {
  // Track the body, but only 40% of the way and heavily smoothed. A camera
  // pinned to the creature turns a lap into the ROOM spinning, which hides the
  // one thing the lap is here to show — that the body turns and the tail does
  // not turn with it.
  const p = view?.object3D.position;
  if (p) focus.lerp(focusTarget.set(p.x * 0.4, 0, p.z * 0.4 + focusBias), 0.04);
  camera.position.set(
    focus.x + Math.cos(azimuth) * Math.cos(elevation) * dist,
    focus.y + Math.sin(elevation) * dist + 0.35,
    focus.z + Math.sin(azimuth) * Math.cos(elevation) * dist,
  );
  camera.lookAt(focus.x, focus.y - 0.05, focus.z);
  key.target.position.set(focus.x, focus.y - 0.2, focus.z);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const STATES: readonly AlienState[] = [
  'DORMANT',
  'PATROL',
  'INVESTIGATE',
  'SEARCH',
  'HUNT',
  'ATTACK',
  'RETREAT',
];

/** §5's speeds, so a state button also picks the cadence the player would see
 *  it at. The slider still overrides — reading a gait AT a speed is the point. */
const STATE_SPEED: Readonly<Record<AlienState, number>> = {
  DORMANT: 0,
  PATROL: 1.5,
  INVESTIGATE: 1.2,
  SEARCH: 1.2,
  HUNT: 3.0,
  ATTACK: 3.0,
  RETREAT: 2.2,
};

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const stateRow = el<HTMLDivElement>('states');
const speedInput = el<HTMLInputElement>('speed');
const speedOut = el<HTMLSpanElement>('speed-out');
const gravityBtn = el<HTMLButtonElement>('gravity');
const movingBtn = el<HTMLButtonElement>('moving');
const secondaryBtn = el<HTMLButtonElement>('secondary');
const fleshBtn = el<HTMLButtonElement>('flesh');
const skinInput = el<HTMLInputElement>('skin');
const skinNote = el<HTMLDivElement>('skin-note');
const dropSkinBtn = el<HTMLButtonElement>('drop-skin');
const stats = el<HTMLDivElement>('stats');

for (const s of STATES) {
  const b = document.createElement('button');
  b.textContent = s;
  b.dataset.state = s;
  b.addEventListener('click', () => setState(s));
  stateRow.appendChild(b);
}

function setState(s: AlienState): void {
  state = s;
  view?.setState(s);
  speed = STATE_SPEED[s];
  speedInput.value = String(speed);
  syncUi();
}

speedInput.addEventListener('input', () => {
  speed = Number(speedInput.value);
  syncUi();
});

gravityBtn.addEventListener('click', () => {
  gravity = gravity === 'nominal' ? 'zero' : 'nominal';
  view?.setGravity(gravity);
  syncUi();
});

movingBtn.addEventListener('click', () => {
  moving = !moving;
  syncUi();
});

let useSecondary = true;
secondaryBtn.addEventListener('click', () => {
  useSecondary = !useSecondary;
  buildView(useSecondary, useFlesh);
  syncUi();
});

let useFlesh = true;
fleshBtn.addEventListener('click', () => {
  useFlesh = !useFlesh;
  buildView(useSecondary, useFlesh);
  syncUi();
});

// The GLB seam, driven the way the game would drive it: hand it a URL, take a
// skin or a null, carry on either way. Nothing here knows or cares which body
// is on screen — see `AlienView.adoptSkin`.
skinInput.addEventListener('change', async () => {
  const file = skinInput.files?.[0];
  if (!file || !view) return;
  const url = URL.createObjectURL(file);
  skinNote.textContent = `loading ${file.name}…`;
  const loaded = await tryLoadAlienSkin(url, { castShadow: true, flesh: useFlesh });
  URL.revokeObjectURL(url);
  if (!loaded) {
    skinNote.textContent = `${file.name} did not satisfy the contract — see the console. Still procedural.`;
    return;
  }
  skin = loaded;
  view.adoptSkin(loaded);
  skinNote.textContent =
    `${file.name}: ${loaded.triangles} tris, clips [${loaded.clipNames.join(', ') || 'none'}]`;
  syncUi();
});

dropSkinBtn.addEventListener('click', () => {
  view?.adoptSkin(null);
  skin = null;
  skinNote.textContent = 'back to the procedural body.';
  syncUi();
});

function syncUi(): void {
  for (const b of Array.from(stateRow.children) as HTMLButtonElement[]) {
    b.classList.toggle('on', b.dataset.state === state);
  }
  speedOut.textContent = `${speed.toFixed(1)} m/s`;
  gravityBtn.textContent = gravity === 'nominal' ? 'deck — walk' : 'vacuum — rail-pull';
  gravityBtn.classList.toggle('on', gravity === 'zero');
  movingBtn.textContent = moving ? 'walking a circle' : 'parked';
  movingBtn.classList.toggle('on', !moving);
  secondaryBtn.textContent = useSecondary ? 'secondary motion ON' : 'r3 — sine only';
  secondaryBtn.classList.toggle('warn', !useSecondary);
  fleshBtn.textContent = useFlesh ? 'flesh shader ON' : 'flat palette material';
  fleshBtn.classList.toggle('warn', !useFlesh);
  dropSkinBtn.disabled = skin === null;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function resize(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width === w && canvas.height === h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}

let acc = 0;
let last = performance.now();
let statTimer = 0;

/** One frame, decoupled from `requestAnimationFrame`. See {@link ISS_VIEWER}. */
function step(dt: number): void {
  acc += dt;
  while (acc >= SERVER_DT) {
    acc -= SERVER_DT;
    stepServer(SERVER_DT);
  }
  view?.update(acc / SERVER_DT, dt);

  resize();
  placeCamera();
  renderer.render(scene, camera);

  statTimer += dt;
  if (statTimer > 0.25 && view) {
    statTimer = 0;
    const body = view.sculpted
      ? `sculpted · ${view.sculpted.triangles} tris`
      : `${view.drawCalls} draw calls · ${view.triangles} tris`;
    stats.textContent = `${body} · ${view.speed.toFixed(2)} m/s measured · ${view.gravity}`;
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Clamped: an alt-tab hands this a multi-second dt, and the springs are
  // substepped against ~16 ms rather than against however long you were away.
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  step(dt);
}

/**
 * A handle on the running viewer, for driving it from a console or a test.
 *
 * The page draws from `requestAnimationFrame`, which every browser pauses when
 * the tab is not compositing — so anything automating this page (a screenshot
 * harness, a shader-compile check, a headless smoke test) has no way to make it
 * produce a frame, and "no errors in the console" would mean only that nothing
 * had been attempted. `step()` gives it one, synchronously.
 *
 * `renderer.info` after a `step()` is the honest answer to "did the flesh
 * shader actually compile on this GPU", because a shader that fails to link
 * shows up there and nowhere else.
 */
export const ISS_VIEWER = {
  step,
  info: () => renderer.info,
  renderer: () => renderer,
  view: () => view,
  /** Point the orbit rig somewhere specific. `focusZ` is in rig space, so -0.85
   *  is the head and +0.75 is the tail tip. */
  camera: (az: number, el: number, d: number, focusZ = 0) => {
    azimuth = az;
    elevation = el;
    dist = d;
    focusBias = focusZ;
  },
};
(window as unknown as Record<string, unknown>).ISS_VIEWER = ISS_VIEWER;

const report = alienGeometryReport();
el<HTMLDivElement>('geom').textContent =
  `${report.total} tris · ${report.length.toFixed(2)} m nose to tail · ` +
  `${(report.length / (report.bodyHalfWidth * 2)).toFixed(1)}:1 slenderness`;

el<HTMLDivElement>('wrap-note').textContent = FLESH_WRAP_AVAILABLE
  ? 'subsurface wrap: compiled'
  : 'subsurface wrap: UNAVAILABLE — three moved the chunk, see flesh.ts';

buildView(true, true);
setState('SEARCH');
requestAnimationFrame(frame);
