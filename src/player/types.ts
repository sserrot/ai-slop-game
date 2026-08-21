/**
 * Public shapes for the player subsystem (DESIGN.md §4).
 *
 * Everything the integrator hands in or reads back is declared here. Anything
 * owned by a subsystem that does not exist yet (station collision geometry, the
 * net layer's noise sink, the alien's proximity feed) is a narrow local
 * interface or a callback — never an import from another agent's directory.
 */

import type * as THREE from 'three';
import type {
  Gait,
  GravityMode,
  HideMessage,
  HideSpotKey,
  LocomotionTransition,
  ModuleId,
  NoiseEvent,
  PlayerId,
  Vec3,
} from '@shared/types';
import type { ModuleGraph } from '@shared/graph/moduleGraph';
import type { HideSpotGraph, HideVolume } from '@shared/graph/hideSpots';
import type { RailGraph } from '@shared/graph/railGraph';
import type { ColliderInput } from './collision';
import type { PlayerComfort, PlayerComfortOptions } from './comfort';
import type { PlayerInput } from './input';
import type { Keymap } from './keymap';

/**
 * §6: "Crosshair states — dot / hand (interactable) / rail (grabbable) / charge
 * arc (push-off)."
 *
 * A hide spot in reach reports `hand`, not a fifth state. It IS a hand verb —
 * you are opening a locker — and the §6 list is deliberately short because the
 * crosshair is the tutorial: adding glyphs is how a diegetic HUD turns into a
 * legend. `Player.hideCandidate` is there for a prompt that wants to say more.
 */
export type CrosshairState = 'dot' | 'hand' | 'rail' | 'charge';

/** What the interaction raycaster found in front of you (§1, §6: you must
 *  physically be at the panel). */
export interface InteractionHit {
  object: THREE.Object3D;
  point: THREE.Vector3;
  distance: number;
}

/**
 * What kind of verb the interact key would be this frame.
 *
 * Deliberately open-ended on the caller's side: the player subsystem cannot know
 * a locker from a panel — that is `Station.interactableAt`'s job — so anything
 * it is told through `PlayerConfig.describeInteractable` is passed through
 * verbatim. `hide` is the one kind the controller resolves by itself, because
 * hide spots are its own geometry (§4).
 */
export type InteractKind = 'panel' | 'locker' | 'hide' | 'item' | 'crew' | 'other';

/** What a consumer says about an object the interaction ray hit. */
export interface InteractableInfo {
  kind?: InteractKind;
  /** Short human label — "Breaker panel", "Locker". Rendered next to the key. */
  label?: string;
  /** False for a target that exists but cannot be used right now (a spent
   *  locker, a dead panel). The prompt still reports it, with `usable` false. */
  usable?: boolean;
}

/**
 * The §6 interact prompt: what `[E]` would do right now, and whether it would
 * do anything at all.
 *
 * THIS IS THE SAME RESULT THE CROSSHAIR USES. `Player.crosshair` reports `hand`
 * exactly when this is non-null — one raycast, sampled at `AIM_RAYCAST_HZ`,
 * feeding both — so a HUD that draws the prompt can never disagree with the
 * glyph the player is looking through. Do not re-raycast to build a prompt.
 *
 * Owned by the controller and refilled in place. Read it every frame; never
 * keep a reference to `point`.
 */
export interface InteractTarget {
  kind: InteractKind;
  label: string;
  /** The object the ray is on. Null for a hide spot, which is authored volume
   *  rather than scene geometry. */
  object: THREE.Object3D | null;
  /** Where to anchor a world-space prompt: the ray's contact point, or the
   *  spot's entry position. */
  point: THREE.Vector3;
  /** Metres from the body to `point`. */
  distance: number;
  /**
   * The body is close enough for §6's "you must physically be AT the panel",
   * i.e. within `INTERACT_REACH_M` of the prop's surface — not merely inside
   * the 2.5 m ray. False means "walk closer"; a HUD may dim the prompt.
   */
  inReach: boolean;
  /**
   * Pressing the key this frame would actually do something: alive, not
   * mid-climb, and the target itself said it was usable.
   */
  usable: boolean;
  /** Populated for `kind === 'hide'` — what the climb would cost (§14). */
  hide: HidePrompt | null;
}

/** Extra context handed to the noise sink alongside the event. */
export interface NoiseInfo {
  /** Source loudness, from §14's `noiseLoudness()` — never a client guess. */
  loudness: number;
  /**
   * Metres this sound carries in open air before it drops under FLOOR:
   * `(loudness - FLOOR) / ATTENUATION_PER_M`. The §6 noise ring is "scaled to
   * how far it actually carried" — this is that number.
   */
  carriedMetres: number;
  /**
   * The speed in m/s that PRODUCED this event, captured at emit time. 0 for the
   * kinds whose loudness does not scale with speed.
   *
   * SEND THIS, never `player.speed`. §7 has the client say what it did and the
   * server re-derive the loudness from §14 — so the server needs the same speed
   * this loudness came from. By the time a sink runs, the controller has already
   * arrested a catch to zero and bled a crash through restitution and tangent
   * friction, and an impact's loudness is the closing speed along the contact
   * normal rather than the body's full speed. Sampling live state instead of
   * this field is what turned every catch into `catchNoise(0)` = 8 and a
   * full-charge crash into `impactNoise(1.21)` = 22 — under HUNT_TRIGGER, so
   * §5's chase loop never fired.
   */
  speed: number;
  /**
   * The gait the event was made in. `footstep` and `landing` are functions of
   * it (§14 `footstepLoudness` / `landingNoise`), so the server needs it to
   * re-derive the loudness the same way it needs `speed` — send it on the
   * `NoiseIntentMessage`.
   */
  gait: Gait;
  /**
   * The emitter was inside a `HideSpot`. The client reports the FACT; the
   * server does the subtraction (§4). `loudness` above already has the shell
   * applied, because the player must hear their own noise correctly (§8).
   */
  hidden: boolean;
  /** The spot's own `muffleDb`, NEGATIVE, or 0 when not hidden. */
  muffleDb: number;
}

/** The net layer's hook: every NoiseEvent the local player generates. */
export type NoiseSink = (event: NoiseEvent, info: NoiseInfo) => void;

/** Where the player wakes up (§10 random spawns). */
export interface PlayerSpawn {
  pos?: Vec3;
  module?: ModuleId;
  /** Optional world point to face on arrival. */
  lookAt?: Vec3;
}

export interface PlayerConfig {
  /** The scene camera. The controller owns its position, rotation and FOV. */
  camera: THREE.PerspectiveCamera;
  /** Network id. Stamped onto every NoiseEvent as `actor`. */
  id?: PlayerId;

  /** Element that receives pointer lock. Defaults to `document.body`. */
  domElement?: HTMLElement | null;
  /** Supply your own input instance (tests, a replay, a gamepad layer). */
  input?: PlayerInput;
  /** Bindings. Defaults to the shared `KEYMAP`. */
  keymap?: Keymap;
  /** Attach DOM listeners on construction. Default true. */
  autoInput?: boolean;
  /** Clicking the canvas requests pointer lock. Default true; clicks inside
   *  `#menu` or `[data-no-pointer-lock]` are ignored either way. */
  lockOnClick?: boolean;

  /** Comfort settings, or a live `PlayerComfort` shared with a settings menu. */
  comfort?: Partial<PlayerComfortOptions> | PlayerComfort;

  /** Station graphs (§2). Both may arrive later via `setStation()`. */
  moduleGraph?: ModuleGraph | null;
  railGraph?: RailGraph | null;
  /**
   * Hide spots (§4). Optional: built from the module graph on `setStation()`
   * when omitted, which is pure geometry and costs nothing to duplicate. Hand
   * one in if another subsystem already owns the instance and wants occupancy
   * to agree.
   */
  hideSpots?: HideSpotGraph | null;
  /** Static collision geometry, in any form `StationCollider` accepts. */
  collider?: ColliderInput;

  /**
   * Regime to assume when there is no module graph to ask.
   *
   * Defaults to `'zero'`, and deliberately: with no station there is no deck to
   * stand on, and a controller that spawned into `nominal` would fall out of the
   * world forever in every harness that constructs a `Player` before the level
   * loads. Once a graph is attached, `StationModule.gravity` is the only source
   * of truth and this is never consulted again.
   */
  defaultGravity?: GravityMode;

  spawn?: PlayerSpawn;
  /** Bursts in the extinguisher bottle (§4). */
  extinguisherCharges?: number;
  /**
   * Objects the interaction ray may hit (panels, levers, lockers).
   *
   * These are ALSO the props the swept body is kept out of — see
   * `./propBarrier`. An interactable is by definition a thing the player walks
   * up to and presses their face against, and the station's static BVH does not
   * carry them at their built extent, so the controller measures them itself.
   */
  interactables?: THREE.Object3D[];

  /**
   * Name what the interaction ray is on, for the §6 prompt.
   *
   * The controller resolves geometry, never identity: `Station.interactableAt`
   * is what knows a breaker panel from a locker, and importing it here would
   * cross a subsystem boundary this file exists to keep (see the header). Hand
   * in a resolver and `Player.interactTarget` carries a real label; omit it and
   * the prompt still works, reporting kind `other` with an empty label.
   *
   * The argument is the raycast's LEAF — a mesh somewhere under the object you
   * put in `interactables`, exactly as `InteractionHit.object` is. Resolve
   * upward through `parent`, which is what `Station.interactableAt` already
   * does. Called once per frame with one object, so a map lookup is fine; it is
   * asked every frame rather than once per target on purpose, because a
   * locker's `usable` goes false the moment somebody empties it and the player
   * is still standing in front of it when that happens.
   */
  describeInteractable?: (object: THREE.Object3D) => InteractableInfo | null;

  /** Mirror events onto the shared `bus` from src/core. Default true. */
  emitToBus?: boolean;
  /** Track alien proximity from the bus's `alien:proximity`. Default true. */
  subscribeAlienProximity?: boolean;
  /** Server tick for `NoiseEvent.t`, if `update()` is not given one. */
  tickProvider?: () => number;

  /**
   * Authoritative "which module is this world position inside?".
   *
   * `ModuleGraph.nearestModule` compares module CENTRES, which a body in a
   * hatchway can flip at frame rate — and every flip changes the module stamped
   * on a NoiseEvent (§3) and the two-hop cull set (§2). `src/station/` exposes a
   * real containment test (`Station.moduleAt`); hand it in and it wins. Return
   * null to fall back to the nearest-centre heuristic.
   *
   * `pos` is a scratch vector owned by the player and overwritten every frame:
   * read it, never keep a reference to it.
   */
  moduleAt?: (pos: Vec3, hint: ModuleId | null) => ModuleId | null;

  onNoise?: NoiseSink;
  onInteract?: (hit: InteractionHit | null) => void;

  /**
   * The §6 interact prompt changed — a different target, or the same one
   * becoming reachable or unusable.
   *
   * Edge-triggered, so a HUD can show and hide the `[E]` chip without polling.
   * The argument is the controller's own live `InteractTarget` (or null); read
   * it, do not keep it. `Player.interactTarget` is the same value if you would
   * rather poll.
   */
  onInteractTarget?: (prompt: InteractTarget | null) => void;
  onFlashlight?: (on: boolean) => void;
  onTrackerMute?: (muted: boolean) => void;

  /**
   * A `launch`, `settle`, `landing` or `liftoff` happened (§4's four
   * transitions). The NoiseEvent, if the transition earns one, has already been
   * emitted through `onNoise` — this is the structured record, for the HUD, the
   * audio layer's foley, and anything that wants to know the player just lost
   * the floor.
   *
   * `transition.loudness === 0` means the transition was genuinely silent and NO
   * NoiseEvent was sent. §4 is explicit that a phantom zero-loudness event in
   * §3's coalescing window is a bug that takes a day to find.
   */
  onTransition?: (transition: LocomotionTransition) => void;

  /**
   * The local player started climbing into or out of a hide spot. Forward it to
   * the server as the §7 `hide` message; the `hide-enter` / `hide-exit`
   * NoiseEvent has already gone out through `onNoise` separately.
   */
  onHide?: (message: HideMessage) => void;

  /** The held gait changed (§4's risk dial). For the HUD. */
  onGait?: (gait: Gait) => void;

  /**
   * The regime under the player's feet changed, because they crossed a hatch or
   * because the station did it to them. `cause` distinguishes the two, and it is
   * the difference between a `launch` you chose and a `liftoff` you did not.
   */
  onGravityMode?: (mode: GravityMode, module: ModuleId, cause: 'crossed' | 'station') => void;
}

/** A hide spot within reach, and how the verb would be priced right now. */
export interface HidePrompt {
  volume: HideVolume;
  /** Metres from the body to the spot's `entryPos`. */
  distance: number;
  /** 0–1, from the held gait — crouch is quiet and slow, sprint is a dive. */
  haste: number;
  /** Seconds the climb would take at that haste (§14 `hideEnterSeconds`). */
  seconds: number;
  /** Loudness it would cost (§14 `hideNoise`). */
  loudness: number;
}

/** Re-exported so a consumer of `Player.hideSpot` need not reach into shared. */
export type { HideSpotKey };
