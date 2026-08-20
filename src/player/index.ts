/**
 * src/player — the two-mode kinematic controller (DESIGN.md §4) and everything
 * that hangs off it: walking with three gaits and distance-based footsteps, the
 * zero-G float/grip/charge controller scoped to modules that have lost their
 * floor, the four transitions between them, hide spots, the free-rotation
 * camera, comfort options, heart rate and breathing (§6), the fire
 * extinguisher, and the single keymap.
 *
 *     import { Player, KEYMAP, PlayerComfort } from './player';
 *
 *     const player = new Player({ camera, domElement: renderer.domElement });
 *     player.setStation(moduleGraph, railGraph);  // hide spots are built here
 *     player.setCollider(stationRoot);            // Object3D | Mesh | MeshBVH
 *     ticker.onRender((_, frameDt) => player.update(frameDt, net.tick));
 *
 * Which regime the body is in is never chosen here: it is read live off
 * `StationModule.gravity` (§2, mutated in place like `Port.hatch`) every frame,
 * so a §5 director gravity failure lands on the player with nothing to wire.
 */

export { Player } from './player';
export { PlayerCamera } from './camera';
export { PlayerComfort, VignetteMeter, DEFAULT_COMFORT } from './comfort';
export type { PlayerComfortOptions, ComfortListener } from './comfort';
export { PlayerInput } from './input';
export type { PlayerInputOptions, LookDelta } from './input';
export {
  KEYMAP,
  MOUSE_BINDINGS,
  PLAYER_ACTIONS,
  buildCodeIndex,
  cloneKeymap,
  codeLabel,
  primaryCode,
  rebind,
} from './keymap';
export type { Keymap, PlayerAction } from './keymap';
export { StationCollider, makeRayHit } from './collision';
export type {
  BodyOffsets,
  ColliderEntry,
  ColliderInput,
  ColliderSource,
  ContactResult,
  RayHit,
} from './collision';
export { HatchBarrier } from './hatchBarrier';
export type { HatchBlock } from './hatchBarrier';
export {
  DOWN,
  HeadBob,
  UP,
  ViewLag,
  accelerateDeck,
  bodyHeightFor,
  capsuleOffsets,
  deckComponent,
  deckDistance,
  eyeHeightFor,
  heightGain,
  makeGroundInfo,
  probeGround,
} from './walk';
export type { GroundInfo } from './walk';
export { HideController, hasteForGait } from './hiding';
export type { HideEvent, HidePhase } from './hiding';
export { FirstPersonHands, HANDS_REST_REACH_M } from './hands';
export type { HandsInput, HandsOptions } from './hands';
export { RemoteCrewViews, CrewIdentities, CREW_TINTS, crewIdentityAt } from './bodyView';
export type { CrewBodyInput, CrewIdentity, CrewSyncOptions, RemoteCrewOptions } from './bodyView';
export { HeartRate } from './heartRate';
export { Extinguisher } from './extinguisher';
export type {
  CrosshairState,
  HidePrompt,
  InteractionHit,
  NoiseInfo,
  NoiseSink,
  PlayerConfig,
  PlayerSpawn,
} from './types';
export * as playerTuning from './tuning';
