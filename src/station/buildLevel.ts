/**
 * Level generator — regenerates `levels/station.json` from the kit.
 *
 *     npx tsx src/station/buildLevel.ts
 *
 * The JSON is the artefact everything else reads (client loader, and the server
 * via `JSON.parse(readFileSync(...))`), but it is generated, not hand-edited:
 * edit `stationSpec.ts` or `kit.ts` and re-run this. It refuses to write a
 * station that does not pass `ModuleGraph.validate()` and `RailGraph.validate()`,
 * so a broken rail joint or an unsnapped port can never reach the game.
 *
 * This is the only file in `src/station/` that touches node: nothing imports it,
 * so it never reaches the browser bundle.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  CULL_HOPS,
  HIDE_SPOTS_MIN,
  STATION_MODULES_MAX,
  STATION_MODULES_MIN,
  ZERO_G_AUTHORED_MAX,
} from '@shared/constants';
import { ModuleGraph, PASSABLE_OPEN_ONLY } from '@shared/graph/moduleGraph';
import { RailGraph } from '@shared/graph/railGraph';
import { HideSpotGraph } from '@shared/graph/hideSpots';
import type { StationLayout } from '@shared/types';
import { buildStationLayout } from './stationSpec';
import { checkWalkable } from './walkable';

const OUT_URL = new URL('../../levels/station.json', import.meta.url);

function main(): void {
  const layout = buildStationLayout();
  const graph = new ModuleGraph(layout.modules);
  const rails = new RailGraph(graph);
  const hideSpots = new HideSpotGraph(graph);

  // The third validator (see `walkable.ts`): topology and rail joints can both
  // be perfect in a station whose corridors are blocked by their own furniture.
  const walk = checkWalkable(layout);
  const problems = [
    ...graph.validate(),
    ...rails.validate(),
    ...hideSpots.validate(),
    ...railsReachEveryHatch(layout),
    ...walk.problems,
  ];
  if (problems.length > 0) {
    console.error('station is invalid:');
    for (const p of problems) console.error('  -', p);
    process.exitCode = 1;
    return;
  }

  // -- report ---------------------------------------------------------------
  console.log(`${layout.id} — ${layout.modules.length} modules, ${rails.size} rail segments`);
  if (
    layout.modules.length < STATION_MODULES_MIN ||
    layout.modules.length > STATION_MODULES_MAX
  ) {
    console.warn(
      `  ! §2 wants ${STATION_MODULES_MIN}–${STATION_MODULES_MAX} modules, this has ${layout.modules.length}`,
    );
  }
  for (const m of layout.modules) {
    const links = m.ports.filter((p) => p.link).length;
    console.log(
      `  ${m.id.padEnd(14)} ${m.kind.padEnd(9)} ${m.gravity.padEnd(7)} ${links} link(s), ` +
        `${m.rails.length} rails, ${m.props.length} props, ` +
        `${(m.hideSpots ?? []).length} hide, ${m.volume} m³, ${m.lighting}`,
    );
  }

  // §2's zero-G budget and §4's hide spot floor, reported rather than only
  // asserted: these are the two numbers a level drifts past one well-meaning
  // module at a time, and the whole point of the pivot is that walking stays the
  // default.
  const zeroG = layout.modules.filter((m) => m.gravity === 'zero').map((m) => m.id);
  console.log(
    `  zero-G: ${zeroG.length}/${layout.modules.length} (max ${ZERO_G_AUTHORED_MAX})` +
      `${zeroG.length > 0 ? ` — ${zeroG.join(', ')}` : ''}`,
  );
  console.log(
    `  hide spots: ${hideSpots.size} across ${hideSpots.modules().length} modules ` +
      `(min ${HIDE_SPOTS_MIN})`,
  );
  console.log('  walkable deck (largest connected pocket, and reach to each port):');
  for (const m of walk.modules) {
    if (m.skipped) {
      console.log(`    ${m.module.padEnd(14)} zero-G, no deck`);
      continue;
    }
    // `door`/`SHUT` is the doorway test, which is about the hatch opening rather
    // than the deck: a port can be 2 cm away and still be one you cannot walk
    // through. See `DOORWAY_STEP_M` in walkable.ts.
    const ports = m.ports
      .map((p) => `${p.port} ${p.distance.toFixed(2)}m ${p.doorway ? 'door' : 'SHUT'}`)
      .join(', ');
    console.log(
      `    ${m.module.padEnd(14)} ${m.area.toFixed(1)} m\u00b2 in ${m.islands} pocket(s), ` +
        `${m.loops} loop(s) \u2014 ${ports}`,
    );
  }

  // Loop check — §2 explicitly wants the station not to be a pure line.
  const loopFrom = 'node-alpha';
  const neighbours = graph.neighbours(loopFrom);
  let loop = false;
  for (const n of neighbours) {
    const detour = graph.findPath(loopFrom, n, {
      passable: (e) => !(e.from === loopFrom && e.to === n) && !(e.from === n && e.to === loopFrom),
    });
    if (detour && detour.length > 2) {
      loop = true;
      console.log(`  loop: ${detour.join(' → ')} → ${loopFrom}`);
      break;
    }
  }
  if (!loop) console.warn('  ! no loop found — §2 asks for at least one');

  const cull = graph.cullSet(loopFrom, CULL_HOPS);
  console.log(`  two-hop cull set from ${loopFrom}: ${cull.join(', ')}`);
  const openOnly = graph.hopsFrom(loopFrom, { passable: PASSABLE_OPEN_ONLY });
  console.log(
    `  reachable through open hatches: ${openOnly.size}/${layout.modules.length} modules`,
  );

  // -- write ----------------------------------------------------------------
  const path = fileURLToPath(OUT_URL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');
  console.log(`wrote ${path}`);
}

/**
 * Every LINKED port must have a rail that declares it, on both sides.
 *
 * `RailGraph.validate()` checks that segments authored as connected actually
 * meet; it has no opinion about a hatch with no rail at it at all, and that is
 * the failure mode this pass introduced the possibility of. Kit pieces now vary
 * their rail set by gravity — a `nominal` node drops the spoke to its floor
 * port, because `nodeDeck` plates over that port and nothing can be mated there
 * — and a level that mates something to a port whose module authors no spoke
 * would get a rail graph with a silent hole in it: the alien's A* would route
 * around a hatch it should walk through, and a GRIPPING player in a `zero`
 * module would find the station's rail network cut in two.
 *
 * §2 says cross-module rail continuity is "the single easiest thing in the
 * system to break", so it is machinery rather than a comment.
 */
function railsReachEveryHatch(layout: StationLayout): string[] {
  const problems: string[] = [];
  for (const module of layout.modules) {
    for (const port of module.ports) {
      if (!port.link) continue;
      if (module.rails.some((r) => r.portLink === port.id)) continue;
      problems.push(
        `${module.id}: port '${port.id}' is linked to ` +
          `${port.link.module}:${port.link.port} but no rail segment declares it — ` +
          'the rail graph stops at this hatch (§2 rail continuity)',
      );
    }
  }
  return problems;
}

main();
