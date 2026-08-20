/**
 * Reading the authored level file (DESIGN.md §2 — "Authoring is then a JSON
 * file, and you get a level editor almost free").
 *
 * `levels/station.json` is a COMPLETE `StationLayout`: transforms, reciprocal
 * port links, hatch state, handrails, props, lighting and volumes are all baked
 * in. Nothing has to run the kit code to use it — the Colyseus server can
 * `JSON.parse(readFileSync(...))` and hand the result straight to `ModuleGraph`.
 * That is deliberate: the client and the server must agree on the station down
 * to the metre, and the cheapest way to guarantee that is one file both read.
 *
 * `buildLevel.ts` regenerates the file from the kit; this module only reads and
 * checks it.
 */

import type {
  GravityMode,
  GravityScope,
  HatchState,
  HideSpot,
  HideSpotKind,
  LightingLevel,
  ModuleKind,
  Port,
  PropRef,
  Quat,
  RailSegment,
  StationLayout,
  StationModule,
  Vec3,
} from '@shared/types';
import { HIDE_SPOT_KINDS, MODULE_KINDS } from '@shared/types';
import { hatchAttenuationDb } from '@shared/graph/moduleGraph';
import { normalizeLayoutGravity } from '@shared/graph/gravity';
import rawStationLevel from '../../levels/station.json';
import { validateLayoutGeometry } from './assemble';

export class StationLayoutError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid station layout (${problems.length}):\n  - ${problems.join('\n  - ')}`);
    this.name = 'StationLayoutError';
    this.problems = problems;
  }
}

/** The bundled 9-module station. Parsed fresh each call — callers mutate hatch
 *  state at runtime and two Stations must not share one layout object. */
export function defaultStationLayout(): StationLayout {
  return parseStationLayout(rawStationLevel as unknown);
}

/** Load a layout from a URL (a level editor, or a server-selected map). */
export async function fetchStationLayout(url: string): Promise<StationLayout> {
  const res = await fetch(url);
  if (!res.ok) throw new StationLayoutError([`fetch ${url} failed: ${res.status} ${res.statusText}`]);
  return parseStationLayout(await res.json());
}

/**
 * Validate and normalise an arbitrary parsed JSON value into a `StationLayout`.
 * Returns a deep copy: the caller owns it and will mutate hatch state on it.
 * Throws `StationLayoutError` listing every problem found.
 */
export function parseStationLayout(raw: unknown): StationLayout {
  const problems: string[] = [];
  const root = asRecord(raw);
  if (!root) throw new StationLayoutError(['layout is not an object']);

  const id = typeof root.id === 'string' ? root.id : '';
  if (!id) problems.push('layout.id is missing');

  const rawModules = Array.isArray(root.modules) ? root.modules : null;
  if (!rawModules) throw new StationLayoutError(['layout.modules is missing or not an array']);

  const modules: StationModule[] = [];
  for (let i = 0; i < rawModules.length; i++) {
    const m = asRecord(rawModules[i]);
    if (!m) {
      problems.push(`modules[${i}] is not an object`);
      continue;
    }
    const mid = typeof m.id === 'string' ? m.id : `modules[${i}]`;
    const kind = MODULE_KINDS.includes(m.kind as ModuleKind) ? (m.kind as ModuleKind) : null;
    if (!kind) {
      problems.push(`${mid}: unknown module kind '${String(m.kind)}'`);
      continue;
    }
    const transform = asRecord(m.transform);
    const pos = readVec3(transform?.pos);
    const quat = readQuat(transform?.quat);
    if (!pos || !quat) {
      problems.push(`${mid}: transform.pos / transform.quat missing or malformed`);
      continue;
    }

    const ports: Port[] = [];
    for (const rawPort of asArray(m.ports)) {
      const p = asRecord(rawPort);
      const localPos = readVec3(p?.localPos);
      const localDir = readVec3(p?.localDir);
      if (!p || typeof p.id !== 'string' || !localPos || !localDir) {
        problems.push(`${mid}: malformed port entry`);
        continue;
      }
      ports.push({
        id: p.id,
        localPos,
        localDir,
        link: readLink(p.link),
        hatch: readHatch(p.hatch),
      });
    }

    const rails: RailSegment[] = [];
    for (const rawRail of asArray(m.rails)) {
      const r = asRecord(rawRail);
      const a = readVec3(r?.a);
      const b = readVec3(r?.b);
      if (!r || typeof r.id !== 'string' || !a || !b) {
        problems.push(`${mid}: malformed rail entry`);
        continue;
      }
      const segment: RailSegment = {
        id: r.id,
        a,
        b,
        connects: asArray(r.connects).filter((c): c is string => typeof c === 'string'),
      };
      if (typeof r.portLink === 'string') segment.portLink = r.portLink;
      rails.push(segment);
    }

    const props: PropRef[] = [];
    for (const rawProp of asArray(m.props)) {
      const p = asRecord(rawProp);
      const localPos = readVec3(p?.localPos);
      if (!p || typeof p.id !== 'string' || typeof p.kind !== 'string' || !localPos) {
        problems.push(`${mid}: malformed prop entry`);
        continue;
      }
      const ref: PropRef = { id: p.id, kind: p.kind, localPos };
      const q = readQuat(p.localQuat);
      if (q) ref.localQuat = q;
      if (typeof p.scale === 'number' && p.scale !== 1) ref.scale = p.scale;
      if (p.interactable === true) ref.interactable = true;
      props.push(ref);
    }

    const hideSpots: HideSpot[] = [];
    for (const rawSpot of asArray(m.hideSpots)) {
      const spot = readHideSpot(rawSpot);
      if (!spot) {
        problems.push(`${mid}: malformed hide spot entry`);
        continue;
      }
      hideSpots.push(spot);
    }

    const module: StationModule = {
      id: mid,
      kind,
      transform: { pos, quat },
      ports,
      rails,
      props,
      lighting: readLighting(m.lighting),
      // §2/§4: `gravity` is REQUIRED on the type but optional in the file, and a
      // level that says nothing has floors everywhere — which is the correct
      // default and the reason a level authored before the pivot still loads.
      gravity: readGravity(m.gravity),
      volume: typeof m.volume === 'number' && m.volume > 0 ? m.volume : 1,
    };
    if (hideSpots.length > 0) module.hideSpots = hideSpots;
    modules.push(module);
  }

  const layout: StationLayout = {
    id,
    modules,
    escapeModule: typeof root.escapeModule === 'string' ? root.escapeModule : '',
    finaleModule: typeof root.finaleModule === 'string' ? root.finaleModule : '',
  };
  if (typeof root.name === 'string') layout.name = root.name;

  normalizeLayoutGravity(layout);
  problems.push(...validateLayoutGeometry(layout));
  if (problems.length > 0) throw new StationLayoutError(problems);
  return layout;
}

// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function readVec3(v: unknown): Vec3 | null {
  const r = asRecord(v);
  if (!r) return null;
  const { x, y, z } = r;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  return { x, y, z };
}

function readQuat(v: unknown): Quat | null {
  const r = asRecord(v);
  if (!r) return null;
  const { x, y, z, w } = r;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof z !== 'number' ||
    typeof w !== 'number'
  ) {
    return null;
  }
  return { x, y, z, w };
}

function readLink(v: unknown): { module: string; port: string } | null {
  const r = asRecord(v);
  if (!r) return null;
  if (typeof r.module !== 'string' || typeof r.port !== 'string') return null;
  return { module: r.module, port: r.port };
}

function readHatch(v: unknown): HatchState {
  const r = asRecord(v);
  const sealed = r?.sealed === true;
  const open = sealed ? false : r?.open === true;
  const hatch: HatchState = { open, sealed, attenuationDb: 0 };
  // The stored dB is a denormalised cache (§2); recompute rather than trust it.
  hatch.attenuationDb = hatchAttenuationDb(hatch);
  return hatch;
}

function readLighting(v: unknown): LightingLevel {
  return v === 'nominal' || v === 'dark' || v === 'emergency' ? v : 'emergency';
}

function readGravity(v: unknown): GravityMode {
  return v === 'zero' ? 'zero' : 'nominal';
}

function readScope(v: unknown): GravityScope | null {
  return v === 'zero' || v === 'nominal' || v === 'any' ? v : null;
}

/** One authored hide spot (§4). Everything past the four required fields is
 *  optional and falls back to the §14 defaults inside `HideSpotGraph`. */
function readHideSpot(v: unknown): HideSpot | null {
  const r = asRecord(v);
  if (!r || typeof r.id !== 'string') return null;
  const kind = HIDE_SPOT_KINDS.includes(r.kind as HideSpotKind) ? (r.kind as HideSpotKind) : null;
  const localPos = readVec3(r.localPos);
  const halfExtents = readVec3(r.halfExtents);
  const entryPos = readVec3(r.entryPos);
  if (!kind || !localPos || !halfExtents || !entryPos) return null;
  const spot: HideSpot = { id: r.id, kind, localPos, halfExtents, entryPos };
  const quat = readQuat(r.localQuat);
  if (quat) spot.localQuat = quat;
  const look = readVec3(r.lookDir);
  if (look) spot.lookDir = look;
  if (typeof r.capacity === 'number' && r.capacity > 0) spot.capacity = Math.floor(r.capacity);
  const scope = readScope(r.usableIn);
  if (scope) spot.usableIn = scope;
  if (typeof r.muffleDb === 'number') spot.muffleDb = r.muffleDb;
  return spot;
}
