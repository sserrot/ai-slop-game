/**
 * ISS-CHR-03 — the remote crew member, and the instancing machinery both
 * character families share (DESIGN.md §9 / §10, asset bible "Characters").
 *
 * Before this file every other player was a 0.35 × 0.9 capsule, which is the
 * same primitive the alien was. That is the one confusion the bible calls out
 * as unacceptable:
 *
 *   > mistaking a crewmate for the alien at 10 m in a dark tube should be a
 *   > moment of relief, never confusion.
 *
 * So the crewmate is built as the alien's opposite on every axis of the
 * silhouette. **Squat** — 1.70 m, which is `PLAYER_STAND_HEIGHT_M`, not the
 * bible's 1.80 (see `CREW_HEIGHT_M`). **Upright** — a vertical stack of boxy
 * masses with a hard horizon at the shoulder. **Broad** — a 0.58 m shoulder
 * yoke, wider than anything on the alien. **Hard-helmeted** — a smooth sphere
 * with a dark visor cut into it, which is a closed convex outline where the
 * alien's head is a long tapering wedge on a thin neck. And it walks on two
 * legs with the pelvis at half its own height, where the alien's spine runs
 * horizontally at 0.45 m and it moves on four splayed limbs.
 *
 * DRAW CALLS. Six crewmates × six body parts would be 36 draw calls, and §9's
 * whole budget is 55–100. Instead every part is ONE `InstancedMesh` shared by
 * every crewmate: the rig below is a single offline `Object3D` skeleton that
 * gets posed once per crewmate per frame, its world matrices harvested into
 * instance slots, and then re-posed for the next one. **Eight draw calls for
 * one to six crewmates, flat** — three more than the five loose capsules it
 * replaces, and it no longer scales with crew size.
 *
 *     const crew = new RemoteCrewViews(station.materials);
 *     scene.add(crew.object3D);
 *     ticker.onRender((_alpha, dt) => crew.sync(net.remoteBodies(), dt, {
 *       isVisible: (m) => station.isVisible(m),
 *     }));
 */

import * as THREE from 'three';
import type {
  Gait,
  GravityMode,
  ModuleId,
  PlayerId,
  PlayerState,
  Quat,
  RailKey,
  Vec3,
} from '@shared/types';
import {
  MAX_PLAYERS,
  PLAYER_RADIUS,
  PLAYER_STAND_HEIGHT_M,
  STRIDE_CROUCH_M,
  STRIDE_RUN_M,
  STRIDE_WALK_M,
  gaitProfile,
} from '@shared/constants';
import {
  POLY_BUDGETS,
  accentGeometry,
  accentMatrix,
  assertPolyBudget,
  chamferedBox,
  mergeParts,
  triangleCount,
  withVertexColor,
} from '../station/artKit';
import type { StationMaterials } from '../station/materials';

// ===========================================================================
// PartInstances — the shared "one draw call per body part" primitive
// ===========================================================================

/**
 * One body part, drawn once for every character wearing it.
 *
 * `InstancedSet` (src/station/instancing.ts) solves the static case: fixed
 * placements, repacked when the two-hop cull set changes. Characters are the
 * other case — a handful of instances whose matrices change every single frame
 * — so this is the dynamic sibling: `begin()`, `push()` a posed rig node per
 * character, `end()`.
 *
 * Nothing here allocates after construction. `push` reads a node's
 * `matrixWorld` straight into the instance buffer, so the caller's rig can be a
 * single offline skeleton posed once per character rather than one `Object3D`
 * tree per character.
 */
export class PartInstances {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  private n = 0;
  private readonly tinted: boolean;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    name: string,
    opts: { tinted?: boolean; castShadow?: boolean } = {},
  ) {
    this.capacity = Math.max(1, capacity);
    this.tinted = opts.tinted ?? false;
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.name = name;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // A character is a moving occluder, so it earns the §9 shadow map; a 22 mm
    // indicator lamp does not, and the caller says which this is.
    this.mesh.castShadow = opts.castShadow ?? false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    if (this.tinted) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(this.capacity * 3).fill(1),
        3,
      );
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
  }

  /** Triangles this part costs per instance. */
  get triangles(): number {
    return triangleCount(this.mesh.geometry);
  }

  /** Instances written since the last `begin()`. */
  get count(): number {
    return this.n;
  }

  begin(): void {
    this.n = 0;
  }

  /** Write one instance from a posed rig node. Silently drops past capacity —
   *  a dropped limb is a cosmetic bug, a thrown exception mid-frame is not. */
  push(node: THREE.Object3D, color?: THREE.Color): boolean {
    return this.pushMatrix(node.matrixWorld, color);
  }

  pushMatrix(matrix: THREE.Matrix4, color?: THREE.Color): boolean {
    if (this.n >= this.capacity) return false;
    this.mesh.setMatrixAt(this.n, matrix);
    if (this.tinted && color) this.mesh.setColorAt(this.n, color);
    this.n++;
    return true;
  }

  /** Commit. Uploads only what was written, and hides the mesh outright at
   *  zero instances so an empty part costs no draw call at all. */
  end(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // Instances moved, so the cached sphere the frustum test uses is stale.
    // Six instances make this a rounding error, and skipping it means a
    // crewmate behind you keeps the whole part submitted.
    this.mesh.computeBoundingSphere();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

// ===========================================================================
// Dimensions — every one of them derived from the collider, not from taste
// ===========================================================================

/**
 * m — total standing height, helmet crown included.
 *
 * The bible says 1.80. This is 1.70, and the difference is deliberate:
 * `PLAYER_STAND_HEIGHT_M` is the collider the server prices contact against and
 * `DECK_HEADROOM_M` is 1.75, so a 1.80 m crewmate would put its helmet through
 * every ceiling in the station and stand taller than the body the alien is
 * allowed to touch. "Scale comes from constants, not taste" — the constant wins
 * and the bible's round number loses.
 */
export const CREW_HEIGHT_M = PLAYER_STAND_HEIGHT_M;

/** m — shoulder yoke width. Wider than any part of the alien (0.42 girdle), and
 *  inside the 0.70 m collider diameter so a crewmate never clips a doorway its
 *  own body fits through. */
export const CREW_SHOULDER_W_M = 0.58;

/** m — hip joint height. Half of standing height: the give-away that this thing
 *  is bipedal, read from the leg length alone. */
const HIP_Y = 0.85;
const FOOT_H = 0.1;
const SHIN_L = 0.33;
const THIGH_L = HIP_Y - SHIN_L - FOOT_H; // 0.42
const TORSO_H = 0.44;
const TORSO_Y = 1.25;
const TORSO_D = 0.3;
const TORSO_W = 0.44;
const HIP_BLOCK_H = 0.2;
const YOKE_Y = 1.42;
const YOKE_H = 0.14;
const SHOULDER_Y = 1.38;
const SHOULDER_X = 0.26;
/** m — helmet radius. Big on purpose: a small helmet on a 0.58 m yoke reads as
 *  a head, and a head is what the alien has. A bubble nearly a third of the
 *  shoulder width reads as hardware. */
const HELMET_R = 0.155;
const HELMET_Y = CREW_HEIGHT_M - HELMET_R; // crown lands exactly on 1.70
const UPPER_ARM_L = 0.34;
const FOREARM_L = 0.3;
const GLOVE_L = 0.11;
/** Baked elbow angle, radians. The arm is one rigid mesh: a pressurised suit
 *  does not have a free elbow and pretending otherwise costs a draw call. */
const ELBOW_BAKED = 0.34;

// ===========================================================================
// Identity — six people, told apart by count first and hue second
// ===========================================================================

/**
 * Per-player band colours. Bright and desaturated-toward-white on purpose: at
 * 5 candela through exponential fog a saturated hue goes grey long before a
 * pale one does, which is the same reasoning behind `CHROMA_WEIGHT` in the
 * palette.
 */
export const CREW_TINTS: readonly number[] = Object.freeze([
  0xff8a3c, // orange
  0x4dd2ff, // cyan
  0xffe14d, // yellow
  0xb07dff, // violet
  0x4ce07a, // green
  0xff5f8f, // pink
]);

/**
 * How many identities exist. One per seat, so nobody ever shares a band.
 */
export const CREW_IDENTITY_COUNT = MAX_PLAYERS;

/** s — how long a player must be absent from every snapshot before their gait
 *  state and identity seat are released. */
export const RETIRE_AFTER_S = 5;

/**
 * One crewmate's visual identity.
 *
 * `stripes` is the load-bearing half. Rule 7 of the art direction — "colour is
 * never the only cue" — means six people cannot be six hues and nothing else,
 * because two of any six hues will collapse under some colour vision
 * deficiency and all six collapse under a torch beam at 12 m. So identity `n`
 * wears `n + 1` stripes, stacked vertically and repeated on all four faces of
 * the torso. What actually reads at distance is the STACK HEIGHT, a length cue
 * rather than a count cue, which survives fog, monochrome and peripheral
 * vision.
 */
export interface CrewIdentity {
  readonly index: number;
  readonly color: number;
  readonly stripes: number;
}

const IDENTITIES: readonly CrewIdentity[] = Object.freeze(
  CREW_TINTS.map((color, index) => Object.freeze({ index, color, stripes: index + 1 })),
);

export function crewIdentityAt(index: number): CrewIdentity {
  const n = ((index % IDENTITIES.length) + IDENTITIES.length) % IDENTITIES.length;
  return IDENTITIES[n] as CrewIdentity;
}

function hashId(id: string): number {
  // FNV-1a. Deterministic across clients, which is the whole point: "the cyan
  // one with three stripes" has to mean the same crewmate to everybody on the
  // voice channel.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Stable identity allocation.
 *
 * Hash first so every client independently agrees, then linear-probe into a
 * free seat so a collision never makes two crewmates look identical. Existing
 * assignments are never moved, so a mid-round join or death cannot re-colour
 * the person you have been following for ten minutes.
 */
export class CrewIdentities {
  private readonly byId = new Map<PlayerId, CrewIdentity>();
  private readonly taken = new Set<number>();

  of(id: PlayerId): CrewIdentity {
    const hit = this.byId.get(id);
    if (hit) return hit;
    const start = hashId(id) % IDENTITIES.length;
    let slot = start;
    for (let i = 0; i < IDENTITIES.length; i++) {
      const candidate = (start + i) % IDENTITIES.length;
      if (!this.taken.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    const identity = crewIdentityAt(slot);
    this.taken.add(identity.index);
    this.byId.set(id, identity);
    return identity;
  }

  forget(id: PlayerId): void {
    const hit = this.byId.get(id);
    if (!hit) return;
    this.byId.delete(id);
    this.taken.delete(hit.index);
  }

  clear(): void {
    this.byId.clear();
    this.taken.clear();
  }
}

// ===========================================================================
// Geometry
// ===========================================================================

function tube(
  rTop: number,
  rBottom: number,
  height: number,
  segments = 8,
  open = false,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, height, segments, 1, open);
}

function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  return g;
}

/**
 * Torso, hips, shoulder yoke, life-support pack and helmet, as one mesh.
 *
 * Deliberately ONE mesh: a hard suit's chest, back and helmet move as a single
 * rigid mass, so splitting them would buy a draw call's worth of articulation
 * nobody can see. The helmet being baked in is also why the whole upper body
 * pitches a fraction of the look angle in `poseCrew` — the head cannot turn on
 * its own, so the torso leans instead, which is what a suited body does anyway.
 *
 * Origin is at the FEET, on the deck, facing −Z.
 */
function buildCrewCore(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // Chest — the broad-shouldered box that is the whole silhouette argument.
  parts.push(
    at(chamferedBox({ x: TORSO_W, y: TORSO_H, z: TORSO_D }, 0.03, { capChamfer: 0.02 }), 0, TORSO_Y, 0),
  );
  // Shoulder yoke: a hard horizontal shelf at 1.42 m. The alien has no
  // horizontal anything, so this line alone separates them in a torch beam.
  parts.push(
    at(chamferedBox({ x: CREW_SHOULDER_W_M, y: YOKE_H, z: TORSO_D }, 0.025), 0, YOKE_Y, 0),
  );
  // Pelvis.
  parts.push(at(chamferedBox({ x: 0.4, y: HIP_BLOCK_H, z: 0.3 }, 0.03), 0, HIP_Y + 0.04, 0));
  // Neck ring — the hard collar that says "sealed suit", not "neck".
  parts.push(at(tube(0.088, 0.098, 0.08, 8), 0, 1.47, 0));
  // Helmet: a smooth closed sphere. Convex, symmetrical, unmistakably
  // manufactured — the exact opposite of the alien's tapering wedge.
  parts.push(at(new THREE.SphereGeometry(HELMET_R, 9, 5), 0, HELMET_Y, 0));
  // Sun visor brim over the faceplate. Reads at any distance as a hard hat.
  const brim = chamferedBox({ x: 0.25, y: 0.03, z: 0.12 }, 0.008);
  brim.rotateX(-0.35);
  parts.push(at(brim, 0, HELMET_Y + 0.105, -0.1));
  // Comms stub on the crown. One asymmetric spike on an otherwise perfect
  // sphere, which is what stops the helmet reading as a ball.
  const stub = tube(0.016, 0.02, 0.11, 6);
  stub.rotateX(1.15);
  parts.push(at(stub, 0, HELMET_Y + HELMET_R * 0.5, 0.135));
  // Display and control module on the chest. Boxy hardware at eye level for
  // anybody standing in front of you, and it gives the torso a front.
  parts.push(at(chamferedBox({ x: 0.26, y: 0.16, z: 0.09 }, 0.018), 0, 1.19, -0.18));
  // Life-support pack. Puts mass BEHIND the crewmate, so the profile from the
  // side is a thick vertical slab — the alien's side profile is a thin line.
  parts.push(at(chamferedBox({ x: 0.4, y: 0.44, z: 0.16 }, 0.025), 0, TORSO_Y, 0.225));
  parts.push(at(tube(0.05, 0.05, 0.34, 6), -0.12, TORSO_Y - 0.02, 0.27));
  parts.push(at(tube(0.05, 0.05, 0.34, 6), 0.12, TORSO_Y - 0.02, 0.27));

  const g = mergeParts(parts);
  g.name = 'crew-core';
  return g;
}

/**
 * The faceplate. Its own mesh purely because it is the one part of a crewmate
 * that is not suit-white: a dark hole where a face should be. Pale ring, dark
 * centre — that contrast is what makes a helmet read as a helmet at 10 m, and
 * it costs one instanced draw call for the entire crew.
 */
function buildCrewVisor(): THREE.BufferGeometry {
  // three's sphere puts −Z at phi = −π/2, so this spans the front 103°.
  const g = new THREE.SphereGeometry(HELMET_R * 1.03, 7, 3, -Math.PI / 2 - 0.9, 1.8, 0.86, 1.02);
  g.translate(0, HELMET_Y, 0);
  g.name = 'crew-visor';
  return g;
}

/**
 * One identification stripe.
 *
 * A two-triangle decal, not a raised bar. Identity six wears twenty-four of
 * them and a box each would be 288 triangles of edge nobody can see: at 5
 * candela the stripe reads purely by value against the suit, so the 8 mm of
 * relief a box would add is spent for nothing. Vertex-painted white so
 * `materials.hazard` carries it and `instanceColor` tints it per player — one
 * geometry, one material, one draw call for every band on every crewmate.
 */
function buildCrewStripe(): THREE.BufferGeometry {
  const g = withVertexColor(new THREE.PlaneGeometry(0.19, 0.034), 0xffffff);
  g.name = 'crew-stripe';
  return g;
}

/**
 * Upper arm, forearm and glove as one rigid piece with the elbow baked at
 * `ELBOW_BAKED`. Built at the shoulder joint, hanging along −Y, and
 * bilaterally symmetric about its own YZ plane — which is why the left and
 * right arms are two instances of ONE geometry rather than a mirrored pair
 * (mirroring flips winding, and fixing that costs more than it buys).
 */
function buildCrewArm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(tube(0.086, 0.082, 0.11, 8), 0, -0.02, 0));
  parts.push(at(tube(0.076, 0.062, UPPER_ARM_L, 8), 0, -0.02 - UPPER_ARM_L / 2, 0));

  const elbowY = -0.02 - UPPER_ARM_L;
  const fore = tube(0.062, 0.052, FOREARM_L, 8);
  fore.translate(0, -FOREARM_L / 2, 0);
  fore.rotateX(ELBOW_BAKED);
  parts.push(at(fore, 0, elbowY, 0));

  const wristY = elbowY - Math.cos(ELBOW_BAKED) * FOREARM_L;
  const wristZ = -Math.sin(ELBOW_BAKED) * FOREARM_L;
  const glove = chamferedBox({ x: 0.1, y: GLOVE_L, z: 0.115 }, 0.02);
  glove.rotateX(ELBOW_BAKED);
  parts.push(at(glove, 0, wristY - GLOVE_L / 2, wristZ));

  const g = mergeParts(parts);
  g.name = 'crew-arm';
  return g;
}

/** Thigh. Split from the shank for one reason: a rigid leg swinging at the hip
 *  is a peg-leg, and a bipedal walk is the crewmate's strongest read. */
function buildCrewThigh(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(tube(0.108, 0.09, 0.1, 8), 0, -0.01, 0));
  parts.push(at(tube(0.1, 0.084, THIGH_L, 8), 0, -THIGH_L / 2, 0));
  // Tool pocket on the outer thigh. Two boxes, and they are what makes a swing
  // leg legible: a smooth cylinder rotating about its own axis looks static.
  parts.push(at(new THREE.BoxGeometry(0.055, 0.16, 0.13), 0.098, -0.2, 0.01));
  parts.push(at(new THREE.BoxGeometry(0.055, 0.16, 0.13), -0.098, -0.2, 0.01));
  const g = mergeParts(parts);
  g.name = 'crew-thigh';
  return g;
}

/** Shin and boot, built at the knee, hanging along −Y. The boot's toe points
 *  −Z so a planted foot reads as a direction. */
function buildCrewShank(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(at(tube(0.084, 0.062, SHIN_L, 8), 0, -SHIN_L / 2, 0));
  parts.push(at(chamferedBox({ x: 0.13, y: FOOT_H, z: 0.24 }, 0.02), 0, -SHIN_L - FOOT_H / 2 + 0.02, -0.04));
  parts.push(at(new THREE.BoxGeometry(0.14, 0.026, 0.26), 0, -SHIN_L - FOOT_H + 0.022, -0.04));
  const g = mergeParts(parts);
  g.name = 'crew-shank';
  return g;
}

/** Local matrices for one identity's stripes: `stripes` bars stacked on each of
 *  the four torso faces, so the crewmate is identifiable from any angle. */
function stripeLocals(stripes: number): readonly THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  const pitch = 0.048;
  const top = TORSO_Y + 0.14;
  // `PlaneGeometry` faces +Z, and −Z is the crewmate's forward, so the chest
  // decal is the one that gets the half turn.
  const faces: Array<{ p: [number, number, number]; ry: number }> = [
    { p: [0, 0, -(TORSO_D / 2 + 0.004)], ry: Math.PI },
    { p: [0, 0, TORSO_D / 2 + 0.004], ry: 0 },
    { p: [-(TORSO_W / 2 + 0.004), 0, 0], ry: -Math.PI / 2 },
    { p: [TORSO_W / 2 + 0.004, 0, 0], ry: Math.PI / 2 },
  ];
  for (const face of faces) {
    for (let i = 0; i < stripes; i++) {
      const y = top - i * pitch;
      const m = new THREE.Matrix4().makeRotationY(face.ry);
      m.setPosition(face.p[0], y, face.p[2]);
      out.push(m);
    }
  }
  return out;
}

// ===========================================================================
// The rig
// ===========================================================================

interface CrewRig {
  readonly root: THREE.Object3D;
  readonly core: THREE.Object3D;
  readonly shoulderL: THREE.Object3D;
  readonly shoulderR: THREE.Object3D;
  readonly hipL: THREE.Object3D;
  readonly hipR: THREE.Object3D;
  readonly kneeL: THREE.Object3D;
  readonly kneeR: THREE.Object3D;
}

function node(parent: THREE.Object3D, name: string, x = 0, y = 0, z = 0): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

/**
 * One offline skeleton, re-posed per crewmate per frame.
 *
 * Not in the scene, never rendered. `poseCrew` writes rotations into it,
 * `updateMatrixWorld(true)` resolves them, and `PartInstances.push` copies the
 * results into instance slots. Six crewmates therefore cost six poses and zero
 * allocations, instead of six `Object3D` trees living in the scene graph.
 */
function buildCrewRig(): CrewRig {
  const root = new THREE.Object3D();
  root.name = 'crew-rig';
  const core = node(root, 'core');
  const shoulderL = node(core, 'shoulder-l', -SHOULDER_X, SHOULDER_Y, 0);
  const shoulderR = node(core, 'shoulder-r', SHOULDER_X, SHOULDER_Y, 0);
  const hipL = node(core, 'hip-l', -0.11, HIP_Y, 0);
  const hipR = node(core, 'hip-r', 0.11, HIP_Y, 0);
  const kneeL = node(hipL, 'knee-l', 0, -THIGH_L, 0);
  const kneeR = node(hipR, 'knee-r', 0, -THIGH_L, 0);
  return { root, core, shoulderL, shoulderR, hipL, hipR, kneeL, kneeR };
}

// ===========================================================================
// Input
// ===========================================================================

/**
 * What this view needs from one remote player.
 *
 * Structurally a supertype of `net`'s `RemoteBodyView`, so
 * `crew.sync(net.remoteBodies(), dt)` compiles with nothing in between. `gait`
 * is optional because `RemoteBodyView` does not carry it today — the server has
 * it (`DecodedPlayer.gait`) and it decides eye height, so pass it if you can
 * reach it, and this falls back to `walk`.
 */
export interface CrewBodyInput {
  readonly id: PlayerId;
  /** The EYE, per §4 — "position IS the eye in both regimes". The body hangs
   *  below it by the gait's eye height. */
  readonly pos: Vec3;
  readonly quat: Quat;
  readonly module: ModuleId;
  readonly state: PlayerState;
  readonly gripId?: RailKey | null;
  readonly alive: boolean;
  readonly escaped?: boolean;
  readonly gait?: Gait;
  readonly name?: string;
}

export interface CrewSyncOptions {
  /** Two-hop portal culling (§2). Omit to draw every crewmate. */
  readonly isVisible?: (module: ModuleId) => boolean;
  /** Per-module gravity (§4). A `zero` module means the body takes the full
   *  orientation quaternion instead of yaw-only. */
  readonly gravityOf?: (module: ModuleId) => GravityMode;
  /** Called for each crewmate actually drawn, in sync order. Handy for voice
   *  placement without a second pass over `remoteBodies()`. */
  readonly onDrawn?: (body: CrewBodyInput, identity: CrewIdentity) => void;
}

export interface RemoteCrewOptions {
  /** Cast into the §9 flashlight shadow map. Default true: another player's
   *  shadow sliding across a bulkhead is the cheapest "you are not alone"
   *  signal in the game. */
  readonly castShadow?: boolean;
  /** Draw crewmates who are inside a hide spot. Default true — the shell's own
   *  geometry occludes them, and a curtain gap showing a boot is the point. */
  readonly drawHidden?: boolean;
}

// ===========================================================================
// Animation
// ===========================================================================

interface CrewMotion {
  phase: number;
  speed: number;
  lastX: number;
  lastZ: number;
  /** Smoothed crouch, 0..1. Stops a gait change from snapping the knees. */
  crouch: number;
  /** Smoothed limpness, 0..1. Death is a fall, not a state change. */
  limp: number;
  /** Seconds since this player last appeared in a snapshot. */
  unseen: number;
}

const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _tint = new THREE.Color();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);

function strideFor(gait: Gait): number {
  return gait === 'crouch' ? STRIDE_CROUCH_M : gait === 'sprint' ? STRIDE_RUN_M : STRIDE_WALK_M;
}

function approach(current: number, target: number, rate: number, dt: number): number {
  const k = 1 - Math.exp(-rate * dt);
  return current + (target - current) * k;
}

/**
 * The walk cycle.
 *
 * Bipedal, contralateral, and stiff — a pressurised suit is a set of hinges,
 * not a body, so the amplitudes are small and the knee never straightens
 * completely. `phase` advances at the gait's own cadence (`speed / stride`), so
 * a sprinting crewmate visibly out-cadences a crouching one and you can read
 * somebody's noise budget off their legs from down a corridor. That matters:
 * their gait is your risk too.
 */
function poseCrew(
  rig: CrewRig,
  body: CrewBodyInput,
  motion: CrewMotion,
  gravity: GravityMode,
  drawHidden: boolean,
): boolean {
  const gait = body.gait ?? 'walk';
  const profile = gaitProfile(gait);
  const zeroG = gravity === 'zero' || body.state === 'FLOATING' || body.state === 'GRIPPING' ||
    body.state === 'CHARGING';
  const hidden = body.state === 'HIDDEN';
  if (hidden && !drawHidden) return false;

  // -- orientation --------------------------------------------------------
  _q.set(body.quat.x, body.quat.y, body.quat.z, body.quat.w);
  _fwd.set(0, 0, -1).applyQuaternion(_q);
  const pitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y)));

  rig.root.scale.set(1, 1, 1);
  if (zeroG) {
    // Free-floating: the whole body IS the camera frame, roll included.
    rig.root.quaternion.copy(_q);
    rig.core.rotation.set(0, 0, 0);
  } else {
    // On a deck the legs point at the floor whatever the head is doing, so the
    // root takes yaw only and the torso leans a fraction of the look pitch.
    const yaw = Math.atan2(-_fwd.x, -_fwd.z);
    rig.root.quaternion.setFromAxisAngle(_up, yaw);
    rig.core.rotation.set(pitch * 0.28, 0, 0);
  }

  // -- where the feet are --------------------------------------------------
  // `pos` is the eye. Standing, the feet are `eyeHeight` below it; floating,
  // there is no floor, so the body hangs from its own eye by the same amount
  // and the root rotation carries it wherever the player is facing.
  const eye = profile.eyeHeight;
  if (zeroG) {
    rig.root.position.set(body.pos.x, body.pos.y, body.pos.z);
    rig.core.position.set(0, -eye, 0);
  } else {
    rig.root.position.set(body.pos.x, body.pos.y - eye, body.pos.z);
    rig.core.position.set(0, 0, 0);
  }

  // -- crouch / hide / death ----------------------------------------------
  const c = motion.crouch;
  const limp = motion.limp;

  // A crouch is knees and hips, not a scale. Folding them keeps the eye at
  // EYE_HEIGHT_CROUCH_M without the body shrinking into a doll.
  const hipCrouch = c * 0.95 + limp * 0.2;
  const kneeCrouch = -c * 1.5 - limp * 0.35;

  // -- the cycle -----------------------------------------------------------
  const p = motion.phase;
  const moving = motion.speed > 0.12 && !zeroG && !hidden;
  const amp = moving ? Math.min(1, motion.speed / profile.speed) : 0;
  const swing = amp * (gait === 'sprint' ? 0.62 : 0.42) * (1 - c * 0.55);
  const knee = amp * (gait === 'sprint' ? 0.95 : 0.6);

  const sinL = Math.sin(p);
  const sinR = Math.sin(p + Math.PI);

  rig.hipL.rotation.set(hipCrouch + swing * sinL, 0, 0);
  rig.hipR.rotation.set(hipCrouch + swing * sinR, 0, 0);
  // The knee bends hardest just after the leg passes under the hip, which is
  // what stops the swing foot ploughing through the deck.
  rig.kneeL.rotation.set(kneeCrouch - knee * Math.max(0, -Math.cos(p + 0.9)), 0, 0);
  rig.kneeR.rotation.set(kneeCrouch - knee * Math.max(0, -Math.cos(p + 0.9 + Math.PI)), 0, 0);

  if (zeroG) {
    // Nobody walks in a zero module (§4), so the legs trail and the arms hold
    // whatever they are holding: a slow drift, and a hard tuck on a rail.
    const gripping = body.state === 'GRIPPING' || body.state === 'CHARGING';
    const drift = Math.sin(p * 0.35) * 0.14;
    rig.hipL.rotation.x = 0.42 + drift;
    rig.hipR.rotation.x = 0.34 - drift;
    rig.kneeL.rotation.x = -0.55 - drift * 0.5;
    rig.kneeR.rotation.x = -0.48 + drift * 0.5;
    const reach = gripping ? -2.05 : -0.7 + drift * 0.6;
    rig.shoulderL.rotation.set(reach, 0, gripping ? 0.28 : 0.16);
    rig.shoulderR.rotation.set(reach, 0, gripping ? -0.28 : -0.16);
  } else {
    // Arms counter-swing at half the leg amplitude — suits do not let you
    // swing an arm properly, and the restraint is what reads as "in a suit".
    const armSwing = swing * 0.55;
    rig.shoulderL.rotation.set(armSwing * sinR - c * 0.5 - limp * 0.9, 0, 0.13 + c * 0.1);
    rig.shoulderR.rotation.set(armSwing * sinL - c * 0.5 - limp * 0.9, 0, -0.13 - c * 0.1);
  }

  if (hidden) {
    // Folded small enough to fit a 0.85 m bench shell without a knee through
    // the door. Still a body, still recognisable, just packed.
    rig.core.rotation.x += 0.55;
    rig.shoulderL.rotation.set(-1.5, 0, 0.5);
    rig.shoulderR.rotation.set(-1.5, 0, -0.5);
  }

  if (limp > 0.01) {
    // Death: face down on the deck, arms out. Read as a shape on the floor,
    // never as a standing figure that stopped animating.
    rig.core.rotation.x = limp * (Math.PI / 2 - 0.12);
    rig.core.position.y -= limp * (HIP_Y - 0.16);
    rig.core.position.z -= limp * 0.34;
  }

  rig.root.updateMatrixWorld(true);
  return true;
}

// ===========================================================================
// RemoteCrewViews
// ===========================================================================

/**
 * Every other player in the station, in eight draw calls.
 *
 * Add `object3D` to the scene once — before `Renderer.prewarm()`, so the
 * instanced shader variants link behind the menu rather than the first time
 * somebody walks into the room — then call `sync` once per rendered frame with
 * `net.remoteBodies()`, which is already interpolated (§7).
 */
export class RemoteCrewViews {
  /** Add to the scene. Holds the instanced parts; its transform is identity and
   *  every instance matrix is in world space. */
  readonly object3D: THREE.Group;
  readonly identities = new CrewIdentities();

  private readonly core: PartInstances;
  private readonly visor: PartInstances;
  private readonly stripe: PartInstances;
  private readonly arm: PartInstances;
  private readonly thigh: PartInstances;
  private readonly shank: PartInstances;
  private readonly lampAlive: PartInstances;
  private readonly lampDown: PartInstances;
  private readonly all: PartInstances[];

  private readonly rig = buildCrewRig();
  private readonly motions = new Map<PlayerId, CrewMotion>();
  private readonly stripeCache = new Map<number, readonly THREE.Matrix4[]>();
  private readonly seen = new Set<PlayerId>();
  private readonly lampLocal: THREE.Matrix4;
  private readonly drawHidden: boolean;

  constructor(materials: StationMaterials, opts: RemoteCrewOptions = {}) {
    const shadow = opts.castShadow ?? true;
    this.drawHidden = opts.drawHidden ?? true;
    const seats = MAX_PLAYERS;

    this.object3D = new THREE.Group();
    this.object3D.name = 'remote-crew';

    this.core = new PartInstances(buildCrewCore(), materials.suit, seats, 'crew-core', {
      castShadow: shadow,
    });
    this.visor = new PartInstances(buildCrewVisor(), materials.glass, seats, 'crew-visor');
    // 4 faces × up to 6 stripes × 6 seats. One draw call for every band in the
    // station, which is what makes a count-based identity affordable at all.
    this.stripe = new PartInstances(
      buildCrewStripe(),
      materials.hazard,
      seats * 4 * CREW_IDENTITY_COUNT,
      'crew-stripe',
      { tinted: true },
    );
    this.arm = new PartInstances(buildCrewArm(), materials.suit, seats * 2, 'crew-arm', {
      castShadow: shadow,
    });
    this.thigh = new PartInstances(buildCrewThigh(), materials.suit, seats * 2, 'crew-thigh', {
      castShadow: shadow,
    });
    this.shank = new PartInstances(buildCrewShank(), materials.suit, seats * 2, 'crew-shank', {
      castShadow: shadow,
    });

    // §"emissive means you can touch this": a crewmate IS interactable — §10's
    // revival is a hand verb on a body — so `crew-id` is a legitimate accent,
    // and it is the one lamp on the asset. Amber up, red down: state, not a
    // second identity channel. The pose already says which, so the colour is
    // never the only cue.
    const lamp = accentGeometry('bulb');
    this.lampAlive = new PartInstances(lamp, materials.interact, seats, 'crew-id-lamp');
    this.lampDown = new PartInstances(lamp, materials.indicatorFor('red'), seats, 'crew-down-lamp');
    this.lampLocal = accentMatrix(
      { x: 0.13, y: TORSO_Y + 0.16, z: -(TORSO_D / 2 + 0.002) },
      { x: 0, y: 0, z: -1 },
    );

    this.all = [
      this.core,
      this.visor,
      this.stripe,
      this.arm,
      this.thigh,
      this.shank,
      this.lampAlive,
      this.lampDown,
    ];
    for (const part of this.all) this.object3D.add(part.mesh);
  }

  /** Draw calls this system costs with `n` crewmates on screen. Constant in
   *  `n` above zero, which is the entire point of the design. */
  get drawCalls(): number {
    let n = 0;
    for (const part of this.all) if (part.mesh.visible) n++;
    return n;
  }

  /** Triangles per crewmate for one identity, lamp included. */
  trianglesFor(identity: CrewIdentity): number {
    return (
      this.core.triangles +
      this.visor.triangles +
      this.stripe.triangles * identity.stripes * 4 +
      this.arm.triangles * 2 +
      this.thigh.triangles * 2 +
      this.shank.triangles * 2 +
      this.lampAlive.triangles
    );
  }

  /**
   * One frame. `bodies` is `net.remoteBodies()` — already interpolated and
   * already late-tolerant, so this never touches the network clock.
   */
  sync(bodies: Iterable<CrewBodyInput>, dt: number, opts: CrewSyncOptions = {}): void {
    for (const part of this.all) part.begin();
    this.seen.clear();

    for (const body of bodies) {
      if (body.escaped) continue;
      this.seen.add(body.id);
      const motion = this.advance(body, dt);
      if (opts.isVisible && !opts.isVisible(body.module)) continue;

      const gravity = opts.gravityOf?.(body.module) ?? 'nominal';
      const identity = this.identities.of(body.id);
      if (!poseCrew(this.rig, body, motion, gravity, this.drawHidden)) continue;

      const core = this.rig.core;
      this.core.push(core);
      this.visor.push(core);
      this.arm.push(this.rig.shoulderL);
      this.arm.push(this.rig.shoulderR);
      this.thigh.push(this.rig.hipL);
      this.thigh.push(this.rig.hipR);
      this.shank.push(this.rig.kneeL);
      this.shank.push(this.rig.kneeR);

      _tint.setHex(identity.color);
      for (const local of this.stripesFor(identity)) {
        this.stripe.pushMatrix(_m.multiplyMatrices(core.matrixWorld, local), _tint);
      }

      const lamps = body.alive ? this.lampAlive : this.lampDown;
      lamps.pushMatrix(_m.multiplyMatrices(core.matrixWorld, this.lampLocal));

      opts.onDrawn?.(body, identity);
    }

    for (const part of this.all) part.end();
    this.retire(dt);
  }

  /** Identity a player has been allocated, without drawing them. */
  identityOf(id: PlayerId): CrewIdentity {
    return this.identities.of(id);
  }

  dispose(): void {
    for (const part of this.all) part.dispose();
    // `accentGeometry` is shared station-wide; releasing it here would blank
    // every amber dot in the level.
    this.object3D.removeFromParent();
    this.motions.clear();
    this.identities.clear();
  }

  // -- internals ----------------------------------------------------------

  private stripesFor(identity: CrewIdentity): readonly THREE.Matrix4[] {
    const hit = this.stripeCache.get(identity.stripes);
    if (hit) return hit;
    const built = stripeLocals(identity.stripes);
    this.stripeCache.set(identity.stripes, built);
    return built;
  }

  /**
   * Measure speed from the interpolated transform and advance the stride.
   *
   * Deliberately derived rather than networked: `RemoteBodyView` carries no
   * velocity, and a foot that plants where the body actually stopped beats a
   * foot that plants where a packet said it would.
   */
  private advance(body: CrewBodyInput, dt: number): CrewMotion {
    const gait = body.gait ?? 'walk';
    let motion = this.motions.get(body.id);
    if (!motion) {
      // A random starting phase so six crewmates never march in lockstep.
      motion = {
        phase: Math.random() * Math.PI * 2,
        speed: 0,
        lastX: body.pos.x,
        lastZ: body.pos.z,
        crouch: gait === 'crouch' ? 1 : 0,
        limp: body.alive ? 0 : 1,
        unseen: 0,
      };
      this.motions.set(body.id, motion);
    }
    if (dt > 0) {
      const dx = body.pos.x - motion.lastX;
      const dz = body.pos.z - motion.lastZ;
      const instant = Math.sqrt(dx * dx + dz * dz) / dt;
      // Heavy smoothing: interpolation jitter at 20 Hz would otherwise make the
      // cadence stutter even at a constant walk.
      motion.speed = approach(motion.speed, Math.min(instant, STRIDE_RUN_M * 4), 7, dt);
      motion.limp = approach(motion.limp, body.alive ? 0 : 1, 4.5, dt);
      const crouching = body.state === 'HIDDEN' || gait === 'crouch';
      motion.crouch = approach(motion.crouch, crouching ? 1 : 0, 9, dt);
      const cadence = motion.speed / strideFor(gait);
      motion.phase = (motion.phase + cadence * Math.PI * 2 * dt) % (Math.PI * 2);
    }
    motion.lastX = body.pos.x;
    motion.lastZ = body.pos.z;
    motion.unseen = 0;
    return motion;
  }

  /**
   * Retire anybody who has genuinely gone, after a grace period.
   *
   * The grace matters. §7's own note about voice peers applies here: falling out
   * of one snapshot means escaped, or simply absent from that packet — NOT gone.
   * Dropping a player on the first missing frame would reset their stride and,
   * worse, free their identity seat, so a dropped packet could re-colour the
   * crewmate you have been following for ten minutes. `RETIRE_AFTER_S` of
   * silence is a departure; one frame is a hiccup.
   */
  private retire(dt: number): void {
    if (this.motions.size === this.seen.size) return;
    for (const [id, motion] of this.motions) {
      if (this.seen.has(id)) continue;
      motion.unseen += dt;
      if (motion.unseen < RETIRE_AFTER_S) continue;
      this.motions.delete(id);
      // Free the seat so seven arrivals across one session cannot exhaust six
      // identities and hand two live crewmates the same band.
      this.identities.forget(id);
    }
  }

  /** Drop a player immediately — wire it to the net layer's `peerLeave`, which
   *  is the only authoritative departure signal there is. */
  forget(id: PlayerId): void {
    this.motions.delete(id);
    this.identities.forget(id);
  }
}

// ===========================================================================
// Self-check
// ===========================================================================

/** Thrown when the crewmate's own geometry contradicts the collider. */
export class CrewCoherenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrewCoherenceError';
  }
}

/**
 * Prove the crewmate fits the body the rest of the game prices.
 *
 * "Doll furniture is the most common failure", and a character is the asset
 * that fails it hardest, because there is no room to notice: the collider is
 * 1.70 m tall and 0.70 m across and both numbers are load-bearing for the
 * sweep, the hatch coamings and the alien's contact test.
 */
export function assertCrewCoherent(): void {
  const failures: string[] = [];
  const core = buildCrewCore();
  core.computeBoundingBox();
  const bb = core.boundingBox as THREE.Box3;
  const height = bb.max.y;
  if (Math.abs(height - CREW_HEIGHT_M) > 0.015) {
    failures.push(
      `crown at ${height.toFixed(3)} m but PLAYER_STAND_HEIGHT_M is ${CREW_HEIGHT_M} — ` +
        `a crewmate taller than its own collider puts a helmet through every ceiling`,
    );
  }
  if (bb.min.y < -0.005) {
    failures.push(`core dips to ${bb.min.y.toFixed(3)} m; the origin must be the sole of the boot`);
  }
  const halfW = Math.max(Math.abs(bb.min.x), bb.max.x);
  if (halfW > PLAYER_RADIUS + 0.001) {
    failures.push(
      `half-width ${halfW.toFixed(3)} m exceeds PLAYER_RADIUS ${PLAYER_RADIUS} — ` +
        `geometry outside the sweep clips walls the body is allowed through`,
    );
  }
  const halfD = Math.max(Math.abs(bb.min.z), bb.max.z);
  if (halfD > PLAYER_RADIUS + 0.001) {
    failures.push(`half-depth ${halfD.toFixed(3)} m exceeds PLAYER_RADIUS ${PLAYER_RADIUS}`);
  }
  core.dispose();

  const seen = new Set<number>();
  for (const identity of IDENTITIES) {
    if (seen.has(identity.stripes)) {
      failures.push(`two identities wear ${identity.stripes} stripes — count must be unique`);
    }
    seen.add(identity.stripes);
  }
  if (IDENTITIES.length !== MAX_PLAYERS) {
    failures.push(`${IDENTITIES.length} identities for ${MAX_PLAYERS} seats`);
  }

  // Budget, on the whole assembled crewmate rather than on one part. artKit's
  // `character` band is 400–1200 and the bible's own row for ISS-CHR-03 is
  // 800–1200; both ends matter, because under-spending is what made every
  // character in this game a capsule in the first place.
  const report = crewGeometryReport();
  const band = POLY_BUDGETS.character;
  if (report.perCrewMin < band.min) {
    failures.push(
      `lightest identity is ${report.perCrewMin} triangles, under the ${band.min} floor — ` +
        `detail belongs in the profile, and there is not enough profile here`,
    );
  }
  if (report.perCrewMax > band.max) {
    failures.push(
      `heaviest identity is ${report.perCrewMax} triangles, over the ${band.max} ceiling`,
    );
  }

  if (failures.length > 0) {
    throw new CrewCoherenceError(
      `crewmate (ISS-CHR-03) contradicts the collider:\n  - ${failures.join('\n  - ')}`,
    );
  }
}

/** Triangle counts, for the budget report. Builds and disposes throwaway
 *  copies, so call it from a script rather than per frame. */
export function crewGeometryReport(): {
  core: number;
  visor: number;
  stripe: number;
  arm: number;
  thigh: number;
  shank: number;
  perCrewMin: number;
  perCrewMax: number;
} {
  const measure = (g: THREE.BufferGeometry): number => {
    const n = triangleCount(g);
    g.dispose();
    return n;
  };
  const core = measure(buildCrewCore());
  const visor = measure(buildCrewVisor());
  const stripe = measure(buildCrewStripe());
  const arm = measure(buildCrewArm());
  const thigh = measure(buildCrewThigh());
  const shank = measure(buildCrewShank());
  const lamp = triangleCount(accentGeometry('bulb'));
  const base = core + visor + arm * 2 + thigh * 2 + shank * 2 + lamp;
  return {
    core,
    visor,
    stripe,
    arm,
    thigh,
    shank,
    perCrewMin: base + stripe * 4 * 1,
    perCrewMax: base + stripe * 4 * CREW_IDENTITY_COUNT,
  };
}

/** Local copy of artKit's dev probe — it is deliberately not exported there, and
 *  a character file should not gain an import just to ask. */
function isDevEnvironment(): boolean {
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env && typeof env.DEV === 'boolean') return env.DEV;
  } catch {
    /* plain Node — fall through */
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  if (proc && proc.env) return proc.env.NODE_ENV !== 'production';
  return true;
}

/**
 * True when the checks ran and passed at import (dev only).
 *
 * The whole crewmate is measured against artKit's `character` band (400–1200)
 * at its lightest identity, because under-spending is the bug this art pass
 * exists to fix — a crewmate that came in at 200 triangles would be the capsule
 * again with extra steps.
 */
export const CREW_CHECKED: boolean = (() => {
  if (!isDevEnvironment()) return false;
  assertCrewCoherent();
  const probe = buildCrewCore();
  assertPolyBudget(probe, { label: 'crew core (ISS-CHR-03)', min: 240, max: 440 }, 'crew core');
  probe.dispose();
  return true;
})();
