/**
 * scripts/verify.ts — the fast regression check. `npm run verify`.
 *
 * This exists because proving the game still works had drifted into running a
 * three-bot crew for twenty-five minutes. Almost nothing that check was
 * defending is actually stochastic: the constants either cohere or they do not,
 * the level either validates or it does not, and the wire loudness for a
 * six-metre crash is a pure function. A long soak proves those slowly and
 * flakily; this proves them in about a second, deterministically.
 *
 * What it CANNOT cover, honestly: anything that needs a browser — pointer lock,
 * real frame pacing, GPU cost, WebRTC. Those need a human with the page open.
 * Everything here runs headless in Node.
 *
 * Each check names the bug it is defending against, so a failure tells you what
 * broke rather than only that something did.
 */

import {
  ATTENUATION_PER_M,
  FLOOR,
  HUNT_TRIGGER,
  PUSH_MAX,
  RAIL_SLIDE,
  SPEED_HUNT,
  SPEED_PATROL,
  SPEED_SPRINT,
  FOOTSTEP_CROUCH,
  FOOTSTEP_WALK,
  FOOTSTEP_RUN,
  ZERO_G_AUTHORED_MAX,
  assertConstantsCoherent,
  catchNoise,
  errorRadius,
  impactNoise,
} from '../shared/constants/index.js';
import { fileURLToPath } from 'node:url';
import { loadStation } from '../server/station/layout.js';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail: string): void {
  checks += 1;
  if (ok) {
    console.log(`  ok    ${name} — ${detail}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name} — ${detail}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------

section('constants (§14)');

let coherent = true;
let coherenceError = '';
try {
  assertConstantsCoherent();
} catch (err) {
  coherent = false;
  coherenceError = err instanceof Error ? err.message : String(err);
}
check('assertConstantsCoherent', coherent, coherent ? 'all §14 sanity checks pass' : coherenceError);

// The two wire pins. Both were real bugs: the client sent a post-mutation speed,
// so every catch went out as 8 and a full-speed crash as ~22 instead of ~51.
check(
  'catch loudness at PUSH_MAX',
  Math.abs(catchNoise(PUSH_MAX) - 26) < 0.001,
  `catchNoise(${PUSH_MAX}) = ${catchNoise(PUSH_MAX)}, expected 26`,
);
check(
  'crash loudness at PUSH_MAX',
  Math.abs(impactNoise(PUSH_MAX) - 51) < 0.001,
  `impactNoise(${PUSH_MAX}) = ${impactNoise(PUSH_MAX)}, expected 51`,
);
check(
  'a full-speed crash still trips HUNT',
  impactNoise(PUSH_MAX) >= HUNT_TRIGGER,
  `${impactNoise(PUSH_MAX)} >= HUNT_TRIGGER ${HUNT_TRIGGER} — §5's chase loop needs this to fire`,
);
check(
  'skill buys silence',
  catchNoise(PUSH_MAX) < impactNoise(PUSH_MAX),
  `clean catch ${catchNoise(PUSH_MAX)} < crash ${impactNoise(PUSH_MAX)}`,
);

// The gait bracket: fleeing works, escaping needs geometry rather than speed.
check(
  'sprint outruns a patrol',
  SPEED_SPRINT > SPEED_PATROL,
  `SPEED_SPRINT ${SPEED_SPRINT} > SPEED_PATROL ${SPEED_PATROL}`,
);
check(
  'sprint cannot outrun a hunt',
  SPEED_SPRINT < SPEED_HUNT,
  `SPEED_SPRINT ${SPEED_SPRINT} < SPEED_HUNT ${SPEED_HUNT}`,
);
check(
  'a rail slide cannot outrun a patrol',
  RAIL_SLIDE < SPEED_PATROL,
  `RAIL_SLIDE ${RAIL_SLIDE} < SPEED_PATROL ${SPEED_PATROL}`,
);

// Footsteps are the player's primary noise dial; they must be ordered and audible.
check(
  'footstep gaits are ordered and audible',
  FLOOR < FOOTSTEP_CROUCH && FOOTSTEP_CROUCH < FOOTSTEP_WALK && FOOTSTEP_WALK < FOOTSTEP_RUN,
  `FLOOR ${FLOOR} < crouch ${FOOTSTEP_CROUCH} < walk ${FOOTSTEP_WALK} < run ${FOOTSTEP_RUN}`,
);

// The r2 reversal. At 2.0/m a knock died at 2.5m; at 1.0/m it carries two modules.
const knockAtTwoModules = 15 - ATTENUATION_PER_M * 10 - 3;
check(
  'a knock still carries two modules',
  knockAtTwoModules >= FLOOR,
  `15 - ${ATTENUATION_PER_M}x10 - 3 = ${knockAtTwoModules} >= FLOOR ${FLOOR}`,
);

// The other r2 reversal: the old clamp(20-level,0,12) was dead above level 20.
check(
  'localisation error never pins exactly',
  errorRadius(100) >= 2,
  `errorRadius at maximum loudness = ${errorRadius(100)}m, the fairness floor is 2m`,
);
check(
  'localisation error reaches its maximum',
  errorRadius(FLOOR) === 12,
  `errorRadius(FLOOR=${FLOOR}) = ${errorRadius(FLOOR)}, expected the 12m maximum`,
);

// ---------------------------------------------------------------------------

section('level (levels/station.json)');

// Must be explicit. `loadStation()` with no path silently falls back to a
// procedural 10-module layout with no zero-G at all, so a verifier that omits
// the path cheerfully validates a station nobody plays.
const LEVEL_PATH = fileURLToPath(new URL('../levels/station.json', import.meta.url));
const station = loadStation(LEVEL_PATH);
const modules = station.layout.modules;

check(
  'the authored level actually loaded',
  station.layout.id !== 'iss-procedural-10',
  `layout id '${station.layout.id}' (${modules.length} modules) — a procedural id here means the level file failed to load`,
);

check(
  'layout validates',
  station.problems.length === 0,
  station.problems.length === 0
    ? `${modules.length} modules, no problems`
    : `${station.problems.length} problem(s): ${station.problems.slice(0, 3).join(' | ')}`,
);

const zeroG = modules.filter((m) => m.gravity === 'zero');
check(
  'zero-G budget respected',
  zeroG.length <= ZERO_G_AUTHORED_MAX,
  `${zeroG.length} authored zero (${zeroG.map((m) => m.id).join(', ') || 'none'}), max ${ZERO_G_AUTHORED_MAX}`,
);
check(
  'walking is the default',
  modules.filter((m) => m.gravity === 'nominal').length > zeroG.length,
  `${modules.length - zeroG.length} nominal vs ${zeroG.length} zero — the pivot's whole point`,
);

// A module whose every exit is zero-G strands a walking player.
const islands = modules.filter((m) => {
  if (m.gravity !== 'nominal') return false;
  const exits = m.ports.filter((p) => p.link);
  return exits.length > 0 && exits.every((p) => {
    const neighbour = modules.find((x) => x.id === p.link!.module);
    return neighbour?.gravity === 'zero';
  });
});
check(
  'no walking islands',
  islands.length === 0,
  islands.length === 0 ? 'every floored module has a floored route out' : `stranded: ${islands.map((m) => m.id).join(', ')}`,
);

// Cargo stow was the designated cut until the pivot gave it a zero-G home.
const cargoModule = modules.find((m) => (m.props ?? []).some((p) => String((p as { id?: string }).id ?? '').includes('cargo')));
check(
  'cargo stow lives in zero-G',
  cargoModule ? cargoModule.gravity === 'zero' : false,
  cargoModule ? `cargo props in '${cargoModule.id}' (${cargoModule.gravity})` : 'no cargo props found in any module',
);

// ---------------------------------------------------------------------------

section('graphs');

check(
  'every module is reachable',
  (() => {
    const seen = new Set<string>([modules[0].id]);
    const queue = [modules[0].id];
    while (queue.length) {
      const id = queue.shift()!;
      const mod = modules.find((m) => m.id === id);
      for (const port of mod?.ports ?? []) {
        if (port.link && !seen.has(port.link.module)) {
          seen.add(port.link.module);
          queue.push(port.link.module);
        }
      }
    }
    return seen.size === modules.length;
  })(),
  `${modules.length} modules form one connected station`,
);

check(
  'rails exist wherever gravity does not',
  zeroG.every((m) => (m.rails ?? []).length > 0),
  zeroG.map((m) => `${m.id}:${(m.rails ?? []).length} rails`).join(', ') || 'no zero-G modules',
);

// ---------------------------------------------------------------------------

console.log(
  `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed` +
    (failures ? `, ${failures} failed` : ''),
);
console.log(
  'Not covered here (needs a browser): pointer lock, frame pacing, GPU cost, WebRTC voice.',
);

process.exit(failures === 0 ? 0 : 1);
