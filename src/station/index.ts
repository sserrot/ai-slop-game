/**
 * `src/station` — DESIGN.md §2, the station graph and everything built on it.
 *
 * Start here:
 *   const station = await Station.load();      // reads levels/station.json
 *   scene.add(station.group);
 *   station.update(playerModuleId, dt);        // two-hop culling + animations
 *
 * `station.graph` (ModuleGraph) and `station.rails` (RailGraph) are the objects
 * the noise system, the alien and the player controller navigate; `station.bvh`
 * is the static collider; `station.modules` is the `StationModule[]` the shared
 * graph consumes.
 *
 * `buildLevel.ts` is NOT exported here: it imports `node:fs` and exists only as
 * the tsx script that regenerates the level file.
 */

export { Station } from './station';
export type { StationOptions, HatchChange } from './station';

export { defaultStationLayout, fetchStationLayout, parseStationLayout, StationLayoutError } from './layout';
export { STATION_SPEC, buildStationLayout } from './stationSpec';
export {
  assembleStation,
  validateLayoutGeometry,
  StationAssemblyError,
  SNAP_TOLERANCE_M,
} from './assemble';
export type { StationSpec, PlacementSpec, LinkSpec } from './assemble';

export {
  KIT,
  kitPiece,
  PROP_ARCHETYPES,
  propArchetype,
  PORT_RADIUS,
  RAIL_RADIUS,
  RACK_DEPTH,
  CUPOLA_COLLAR_R,
} from './kit';
export type { KitPiece, KitPieceId, KitPortDef, PropKind, PropArchetype, StripDef } from './kit';

// The pivot's authoring layer (§2 chase geometry, §4 decks and hide spots).
export {
  DECK_THICKNESS_M,
  DECK_EDGE_W,
  DECK_EDGE_H,
  HIDE_SHELL_T,
  WALK_LANE_M,
  VAULT_HEIGHT_M,
  DOORWAY_HALF_W,
  DOORWAY_TOP,
  DOORWAY_SILL,
  bayHalfWidthBesidePort,
  BAY_HALF_EXTENTS,
  BULKHEAD_SIZE,
  BENCH_SIZE,
  BANK_SIZE,
  CARGO_RACK_SIZE,
  CARGO_BAG_SIZE,
  deckHalfWidth,
  deckHeadroom,
  tubeDeck,
  nodeDeck,
  cupolaDeck,
  tubeChicane,
  labIsland,
  deckBank,
  nodeConsoleVoid,
  deckBay,
  stowageNet,
} from './deckKit';
export type { DeckDef, DeckPart } from './deckKit';

export { checkWalkable } from './walkable';
export type { WalkReport, ModuleWalkReport } from './walkable';

export { StationGravity } from './gravity';
export type { GravityShift } from './gravity';
export { StationCargo } from './cargo';
export type { CargoBag, CargoSlot } from './cargo';

export { StationMaterials, LIGHTING_LOOKS, GRAVITY_LOOKS, CARGO_TINTS } from './materials';
export { buildStationScene } from './loader';
export type { StationScene, ModuleView } from './loader';
export { PortalCuller } from './culling';
export { StationProps } from './props';
export { StationHandrails } from './handrails';
export { StationHatches } from './hatches';
export type { HatchView, HatchVisualState } from './hatches';
export { StationLockers } from './lockers';
export type { Locker, StationInteractable } from './lockers';
export { StationPanels } from './panels';
export type { StationPanel } from './panels';
export {
  planLockerContents,
  lockerRefs,
  findPanelModule,
} from './lockerContents';
export type { StationItem, StationItemKind, LockerRef, LockerPlanOptions } from './lockerContents';
export {
  buildStationCollider,
  installBvhRaycast,
  HatchBlockers,
  blockedByHatch,
} from './collision';
export type { StationCollider, PortDisc } from './collision';
export { InstancedSet } from './instancing';
export type { InstanceEntry } from './instancing';
export * from './threeUtil';
export * from './transform';
export * from './random';
export {
  buildModuleShell,
  buildPropGeometry,
  buildRailGeometry,
  buildHatchGeometry,
  buildLockerParts,
  buildPanelParts,
  buildHideSpotShell,
  mergeAndDispose,
  toCollisionGeometry,
} from './geometry';
export type { ShellGeometry, HatchGeometry } from './geometry';
