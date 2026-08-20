/**
 * Station assembly — snapping kit pieces together through their ports (§2).
 *
 * Pure plain-object code (no three.js), so this runs identically in the browser
 * and under tsx in `buildLevel.ts`, which is what regenerates
 * `levels/station.json`. The authored input is a short list of "put a straight
 * here, mate its aft port to that node's +X port"; the output is a complete
 * `StationLayout` with world transforms, reciprocal port links, handrails and
 * props — exactly what `ModuleGraph` and `RailGraph` consume.
 *
 * Every mate is verified: mated ports must coincide within 1 cm and face
 * opposite ways. A layout that does not physically snap throws here rather than
 * producing a station with a hole in it.
 */

import { HATCH_CLOSED, HATCH_OPEN, HATCH_SEALED } from '@shared/constants';
import type {
  GravityMode,
  HideSpot,
  LightingLevel,
  ModuleId,
  ModuleKind,
  Port,
  PortId,
  PropRef,
  Quat,
  RailSegment,
  StationLayout,
  StationModule,
  Vec3,
} from '@shared/types';
import {
  applyQuat,
  distance,
  dot,
  localDirToWorld,
  localToWorld,
  scale,
  sub,
  v3,
} from '@shared/graph/math';
import { normalizeModuleGravity } from '@shared/graph/gravity';
import { kitPiece } from './kit';
import { rngFor } from './random';
import {
  IDENTITY_QUAT,
  quatFromAxisAngle,
  quatFromUnitVectors,
  quatMul,
  roundQuat,
  roundVec,
} from './transform';

/** Metres. Two mated ports closer than this count as snapped. */
export const SNAP_TOLERANCE_M = 0.01;

export class StationAssemblyError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`station assembly failed (${problems.length}):\n  - ${problems.join('\n  - ')}`);
    this.name = 'StationAssemblyError';
    this.problems = problems;
  }
}

export interface PlacementSpec {
  id: ModuleId;
  kind: ModuleKind;
  lighting?: LightingLevel;
  /**
   * Locomotion regime (§4). Defaults to `'nominal'` — walking is the default and
   * the level says so by saying nothing. `ModuleGraph.validate()` enforces §2's
   * budget on how many modules may say otherwise.
   */
  gravity?: GravityMode;
  /** Hide spots on top of the ones the kit piece authors (§4). */
  hideSpots?: HideSpot[];
  /** Root placement: an explicit pose. Exactly one of `at` / `mate`. */
  at?: { pos: Vec3; quat?: Quat };
  /** Snap `port` onto an already-placed module's port. */
  mate?: {
    port: PortId;
    to: { module: ModuleId; port: PortId };
    /** Radians of spin about the mating axis — orients decor, not topology. */
    roll?: number;
    /** Initial state of the hatch this mate creates. Defaults to open. */
    hatch?: { open?: boolean; sealed?: boolean };
  };
  /** Authored extras on top of the kit's decor: puzzle panels, escape fittings. */
  props?: PropRef[];
  /** Set false to place a bare shell (no racks, cables, bags or locker). */
  decor?: boolean;
}

export interface LinkSpec {
  a: { module: ModuleId; port: PortId };
  b: { module: ModuleId; port: PortId };
  /** Initial hatch state. Defaults to open. `sealed` implies closed (§2). */
  hatch?: { open?: boolean; sealed?: boolean };
}

export interface StationSpec {
  id: string;
  name?: string;
  /** Seeds the decor scatter so the level file is byte-stable. */
  seed?: number;
  placements: PlacementSpec[];
  /** Extra links, for loops a mate chain cannot express (§2 "at least one loop"). */
  links?: LinkSpec[];
  escapeModule: ModuleId;
  finaleModule: ModuleId;
}

// ---------------------------------------------------------------------------

export function assembleStation(spec: StationSpec): StationLayout {
  const problems: string[] = [];
  const modules = new Map<ModuleId, StationModule>();
  const order: ModuleId[] = [];

  for (const placement of spec.placements) {
    if (modules.has(placement.id)) {
      problems.push(`duplicate module id '${placement.id}'`);
      continue;
    }
    const piece = kitPiece(placement.kind);
    let pos: Vec3;
    let quat: Quat;

    if (placement.at) {
      pos = placement.at.pos;
      quat = placement.at.quat ?? IDENTITY_QUAT;
    } else if (placement.mate) {
      const parent = modules.get(placement.mate.to.module);
      if (!parent) {
        problems.push(
          `'${placement.id}' mates to '${placement.mate.to.module}', which is not placed yet`,
        );
        continue;
      }
      const parentPort = parent.ports.find((p) => p.id === placement.mate!.to.port);
      if (!parentPort) {
        problems.push(
          `'${placement.id}' mates to unknown port '${placement.mate.to.module}:${placement.mate.to.port}'`,
        );
        continue;
      }
      const childPort = piece.ports.find((p) => p.id === placement.mate!.port);
      if (!childPort) {
        problems.push(
          `'${placement.id}' has no port '${placement.mate.port}' on kit piece '${placement.kind}'`,
        );
        continue;
      }
      const anchor = localToWorld(parentPort.localPos, parent.transform);
      const facing = scale(localDirToWorld(parentPort.localDir, parent.transform), -1);
      let q = quatFromUnitVectors(childPort.localDir, facing);
      if (placement.mate.roll) {
        q = quatMul(quatFromAxisAngle(facing, placement.mate.roll), q);
      }
      quat = roundQuat(q);
      pos = roundVec(sub(anchor, applyQuat(childPort.localPos, quat)));
    } else {
      problems.push(`'${placement.id}' has neither 'at' nor 'mate'`);
      continue;
    }

    const gravity: GravityMode = placement.gravity ?? 'nominal';
    const rng = rngFor(spec.seed ?? 0, placement.id);
    const props: PropRef[] = [];
    if (placement.decor !== false) props.push(...piece.decor(placement.id, rng, gravity));
    if (placement.props) props.push(...placement.props.map(cloneProp));

    const hideSpots: HideSpot[] = [];
    if (placement.decor !== false) hideSpots.push(...piece.hideSpots(placement.id, gravity));
    if (placement.hideSpots) hideSpots.push(...placement.hideSpots.map(cloneHideSpot));

    const module: StationModule = {
      id: placement.id,
      kind: placement.kind,
      transform: { pos: roundVec(pos), quat: roundQuat(quat) },
      ports: piece.ports.map<Port>((p) => ({
        id: p.id,
        localPos: roundVec(p.localPos),
        localDir: roundVec(p.localDir, 6),
        link: null,
        // Capped until something links to it: an unlinked port is a bulkhead.
        hatch: { open: false, sealed: false, attenuationDb: HATCH_CLOSED },
      })),
      // Rails are authored in BOTH regimes (§2); gravity only decides where they
      // run. See `KitPiece.rails`.
      rails: piece.rails(gravity).map(cloneRail),
      props,
      lighting: placement.lighting ?? piece.defaultLighting,
      gravity,
      volume: piece.volume,
    };
    if (hideSpots.length > 0) module.hideSpots = hideSpots;
    modules.set(placement.id, normalizeModuleGravity(module));
    order.push(placement.id);
  }

  // -- links ---------------------------------------------------------------

  const links: LinkSpec[] = [];
  for (const placement of spec.placements) {
    if (!placement.mate) continue;
    const link: LinkSpec = {
      a: { module: placement.mate.to.module, port: placement.mate.to.port },
      b: { module: placement.id, port: placement.mate.port },
    };
    if (placement.mate.hatch) link.hatch = placement.mate.hatch;
    links.push(link);
  }
  if (spec.links) links.push(...spec.links);

  for (const link of links) {
    const a = modules.get(link.a.module);
    const b = modules.get(link.b.module);
    if (!a || !b) {
      problems.push(`link references unknown module '${!a ? link.a.module : link.b.module}'`);
      continue;
    }
    const pa = a.ports.find((p) => p.id === link.a.port);
    const pb = b.ports.find((p) => p.id === link.b.port);
    if (!pa || !pb) {
      problems.push(
        `link references unknown port '${!pa ? `${a.id}:${link.a.port}` : `${b.id}:${link.b.port}`}'`,
      );
      continue;
    }
    if (pa.link || pb.link) {
      problems.push(`port ${a.id}:${pa.id} or ${b.id}:${pb.id} is already linked`);
      continue;
    }
    pa.link = { module: b.id, port: pb.id };
    pb.link = { module: a.id, port: pa.id };
    const open = link.hatch?.sealed ? false : (link.hatch?.open ?? true);
    const sealed = link.hatch?.sealed ?? false;
    for (const p of [pa, pb]) {
      p.hatch.open = open;
      p.hatch.sealed = sealed;
      p.hatch.attenuationDb = sealed ? HATCH_SEALED : open ? HATCH_OPEN : HATCH_CLOSED;
    }
  }

  const layout: StationLayout = {
    id: spec.id,
    modules: order.map((id) => modules.get(id) as StationModule),
    escapeModule: spec.escapeModule,
    finaleModule: spec.finaleModule,
  };
  if (spec.name) layout.name = spec.name;

  problems.push(...validateLayoutGeometry(layout));
  if (problems.length > 0) throw new StationAssemblyError(problems);
  return layout;
}

// ---------------------------------------------------------------------------
// Geometric validation — shared by the generator and the runtime loader
// ---------------------------------------------------------------------------

/**
 * Checks that the *geometry* of a layout is coherent: mated ports coincide and
 * face each other, rails are non-degenerate, and the escape/finale modules
 * exist. Topological checks (reciprocity, connectivity) belong to
 * `ModuleGraph.validate()`; rail-joint checks to `RailGraph.validate()`.
 */
export function validateLayoutGeometry(layout: StationLayout): string[] {
  const problems: string[] = [];
  const byId = new Map<ModuleId, StationModule>();
  for (const m of layout.modules) {
    if (byId.has(m.id)) problems.push(`duplicate module id '${m.id}'`);
    byId.set(m.id, m);
  }

  for (const m of layout.modules) {
    const seenPorts = new Set<PortId>();
    for (const p of m.ports) {
      if (seenPorts.has(p.id)) problems.push(`${m.id}: duplicate port id '${p.id}'`);
      seenPorts.add(p.id);
      const dirLen = Math.hypot(p.localDir.x, p.localDir.y, p.localDir.z);
      if (Math.abs(dirLen - 1) > 1e-3) {
        problems.push(`${m.id}:${p.id} localDir is not unit length (${dirLen.toFixed(4)})`);
      }
      if (!p.link) continue;
      const other = byId.get(p.link.module);
      if (!other) {
        problems.push(`${m.id}:${p.id} links to unknown module '${p.link.module}'`);
        continue;
      }
      const op = other.ports.find((q) => q.id === p.link!.port);
      if (!op) {
        problems.push(`${m.id}:${p.id} links to unknown port '${p.link.module}:${p.link.port}'`);
        continue;
      }
      if (!op.link || op.link.module !== m.id || op.link.port !== p.id) {
        problems.push(`${m.id}:${p.id} → ${other.id}:${op.id} is not reciprocated`);
        continue;
      }
      const wa = localToWorld(p.localPos, m.transform);
      const wb = localToWorld(op.localPos, other.transform);
      const gap = distance(wa, wb);
      if (gap > SNAP_TOLERANCE_M) {
        problems.push(
          `${m.id}:${p.id} ↔ ${other.id}:${op.id} do not snap — ${gap.toFixed(3)}m apart`,
        );
      }
      const da = localDirToWorld(p.localDir, m.transform);
      const db = localDirToWorld(op.localDir, other.transform);
      if (dot(da, db) > -0.99) {
        problems.push(
          `${m.id}:${p.id} ↔ ${other.id}:${op.id} do not face each other (dot ${dot(da, db).toFixed(3)})`,
        );
      }
      if (p.hatch.open !== op.hatch.open || p.hatch.sealed !== op.hatch.sealed) {
        problems.push(
          `${m.id}:${p.id} ↔ ${other.id}:${op.id} disagree about their shared hatch state`,
        );
      }
    }

    // §4 — one global down, one deck height, no exceptions.
    //
    // Every deck, every piece of chase furniture and every hide spot in
    // `deckKit` is authored in MODULE space at `y = DECK_Y_M`, because the whole
    // authored station is centred on y = 0 and `STATION_DOWN` is global. A module
    // placed with a roll or a pitch would bury its own floor in a wall and stand
    // its lockers on their sides, and the failure would present as "the player
    // falls through the world in one room" three subsystems later. Catch it
    // here, where it is one line of JSON.
    if (m.gravity !== 'zero') {
      const up = localDirToWorld(v3(0, 1, 0), m.transform);
      if (Math.abs(up.y - 1) > 1e-3) {
        problems.push(
          `${m.id}: a 'nominal' module must be placed upright (its local +Y is ${up.y.toFixed(3)} of world up) — the deck is authored in module space`,
        );
      }
    }

    const spotIds = new Set<string>();
    for (const h of m.hideSpots ?? []) {
      if (spotIds.has(h.id)) problems.push(`${m.id}: duplicate hide spot id '${h.id}'`);
      spotIds.add(h.id);
      if (h.halfExtents.x <= 0 || h.halfExtents.y <= 0 || h.halfExtents.z <= 0) {
        problems.push(`${m.id}:${h.id} has a zero or negative half-extent`);
      }
    }

    const railIds = new Set<string>();
    for (const r of m.rails) {
      if (railIds.has(r.id)) problems.push(`${m.id}: duplicate rail id '${r.id}'`);
      railIds.add(r.id);
      if (distance(r.a, r.b) < 1e-3) problems.push(`${m.id}:${r.id} is zero length`);
      for (const c of r.connects) {
        if (!m.rails.some((o) => o.id === c)) {
          problems.push(`${m.id}:${r.id} connects to missing rail '${c}'`);
        }
      }
      if (r.portLink && !m.ports.some((p) => p.id === r.portLink)) {
        problems.push(`${m.id}:${r.id} portLink '${r.portLink}' is not a port of this module`);
      }
    }
  }

  if (!byId.has(layout.escapeModule)) {
    problems.push(`escapeModule '${layout.escapeModule}' is not in the layout`);
  }
  if (!byId.has(layout.finaleModule)) {
    problems.push(`finaleModule '${layout.finaleModule}' is not in the layout`);
  }
  return problems;
}

// ---------------------------------------------------------------------------

function cloneRail(r: RailSegment): RailSegment {
  const out: RailSegment = {
    id: r.id,
    a: roundVec(r.a),
    b: roundVec(r.b),
    connects: [...r.connects],
  };
  if (r.portLink) out.portLink = r.portLink;
  return out;
}

function cloneHideSpot(h: HideSpot): HideSpot {
  const out: HideSpot = {
    id: h.id,
    kind: h.kind,
    localPos: roundVec(h.localPos),
    halfExtents: roundVec(h.halfExtents),
    entryPos: roundVec(h.entryPos),
  };
  if (h.localQuat) out.localQuat = roundQuat(h.localQuat);
  if (h.lookDir) out.lookDir = roundVec(h.lookDir);
  if (h.capacity !== undefined) out.capacity = h.capacity;
  if (h.usableIn !== undefined) out.usableIn = h.usableIn;
  if (h.muffleDb !== undefined) out.muffleDb = h.muffleDb;
  return out;
}

function cloneProp(p: PropRef): PropRef {
  const out: PropRef = { id: p.id, kind: p.kind, localPos: roundVec(p.localPos) };
  if (p.localQuat) out.localQuat = roundQuat(p.localQuat);
  if (p.scale !== undefined && p.scale !== 1) out.scale = p.scale;
  if (p.interactable) out.interactable = true;
  return out;
}
