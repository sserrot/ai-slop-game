# ISS

Co-op first-person horror. Up to six players trapped on the International Space Station with
something that hunts entirely by sound.

`DESIGN.md` is the specification. **§14 is the single source of truth for every tuning constant** —
import them from `@shared/constants`, never re-type them.

## The documents

| File | Answers | Changes |
|---|---|---|
| `DESIGN.md` | What the game *is*. The spec, and §14, the constants | Rarely, and deliberately |
| `README.md` | How to run it, what's implemented, the ground rules | When the code does |
| `ROADMAP.md` | Where we are against §12, and what's next | Weekly |
| `BACKLOG.md` | What's left, sized in evenings, and what we decided against | Continuously |
| `PLAYTEST.md` | What we still don't know, and every constant change with its evidence | After every session |
| `DECISIONS.md` | Why it is the way it is, and what would reopen each call | When a decision changes |
| `PITCH.html` | The vision, for people who will never read `DESIGN.md` | Per major milestone |

If `DESIGN.md` and `ROADMAP.md` disagree about what is *built*, the roadmap wins. If they disagree
about what should be built *next*, the design doc wins.

---

## Install and run

Dependencies are already installed. If you are starting from a clean clone:

```bash
npm install
```

Then run the two halves in **two terminals**:

```bash
npm run server     # tsx watch server/index.ts  → ws://localhost:2567  (GET /health)
npm run dev        # vite                       → http://localhost:5173
```

Open http://localhost:5173 and press **Begin round**. Everyone else opens the same URL; the room
auto-starts three seconds after the last person joins, so the whole crew gets one roll of the spawn
solver (§10). Up to six players per room.

Other scripts:

```bash
npm run typecheck  # tsc --noEmit   (clean)
npm run build      # vite build → dist/
npm run preview    # serve dist/
```

**With no server running the client still boots** into an offline sandbox: the real station, the
zero-G controller, collision, rails, noise propagation and the HUD, but no alien, no crew and no
puzzles. It is the fastest way to work on §4 feel.

### Playing over the internet

The client connects to `ws://<page host>:2567` by default. Point it somewhere else with
`VITE_SERVER_URL=ws://host:2567 npm run dev`.

**Set up TURN before a real playtest.** §1 is blunt about this: one friend behind symmetric NAT
costs you the whole night. The server reads `STUN_URLS`, `TURN_URLS`, `TURN_USERNAME` and
`TURN_CREDENTIAL` and ships them to clients in the `welcome` message; see `server/config.ts` for a
coturn recipe. Without TURN the voice mesh works only when everybody's NAT cooperates — and voice
is not a nicety here, it *is* a mechanic.

### Server environment

Every variable has a working default.

| Variable | Default | What it does |
|---|---|---|
| `PORT` / `HOST` | `2567` / `0.0.0.0` | Colyseus transport |
| `TICK_MS` | `50` | §7's 20 Hz tick |
| `MAX_PLAYERS` | `6` | Room cap (§10) |
| `AUTO_START` | `1` | Start 3 s after the last join |
| `STATION_LAYOUT` | `levels/station.json` | The authored station both sides use |
| `SEED` | `0` (random) | Spawns, locker contents, alien rolls |
| `DEBUG_NOISE` | `0` | Log what the alien hears |
| `USE_FALLBACK_SIMS` | `0` | Swap in `server/sim/fallback*.ts` for bisecting |

---

## Controls

Pointer lock is the on/off switch: click to play, **Esc** for the menu. Comfort options (roll-lock,
snap-turn, FOV, vignette) are in the menu and persist to `localStorage` (§4 — they ship in M0, not
as a later pass).

| Key | Action | Loudness (§3) |
|---|---|---|
| Mouse | look | — |
| `W A S D` | slide along a rail (1.2 m/s), steer a drift | rail pull **4** per metre |
| Hold RMB / `Shift` / `Ctrl` | grip — auto-latches the first rail in range (§4 buffered latch) | catch **8 + 3v** |
| Hold LMB / `Space` | charge a push-off, release to launch (2 → 6 m/s over 1.2 s) | push-off **8** |
| — | hitting a bulkhead instead of catching one | impact **15 + 6v** |
| `E` | interact: panel controls, lockers, a downed crewmate with a medkit | — |
| `Q` | knock on a handrail — invent your own codes (§10) | **15**, ~2 modules |
| `G` | open / close the nearest hatch | **45**, ~3 modules |
| `H` | **seal** the nearest hatch — two charges a round, and the alien cannot open it | **45** |
| `R` | throw a decoy — two a round, found in lockers, no respawn | **70**, ~5 modules |
| `X` | fire extinguisher — three bursts, for when you are stranded mid-module | **65** |
| `F` | flashlight | silent |
| `Z` / `C` | roll · `←` `→` snap-turn | — |
| `M` | mute the wrist tracker — silent, and blind | beep **20** |
| `Esc` | menu | — |

Your own voice is 10–55 depending on how loud you speak, sampled at 10 Hz and calibrated once per
browser at the first round (say nothing for 1.5 s, then speak normally for 4 s). Your breathing is
6–14 and rises with your heart rate, which rises with the alien's proximity. **Holding still is not
free.**

The ring around the crosshair expands to show how far every sound you make actually carried. That
is the whole tutorial.

---

## What is implemented

Milestones M0 – M7c from §12, grey-boxed. Everything below is wired end to end and was exercised
against a live server.

- **M0 · zero-G feel.** Hand-rolled kinematic controller, swept sphere (0.35 m) against a
  `three-mesh-bvh` hull, drag as a 4 s half-life, comfort options in the menu.
- **M1 · the risk ladder.** Rail graph, buffered grip, charged push-off, and catch-vs-crash as two
  different sounds (26 vs 51 at full speed).
- **M2 · the station.** Nine authored modules (`levels/station.json`), hatches that open, close and
  seal, two-hop portal culling with exponential fog behind it.
- **M3 · noise.** §3 propagation over the module graph, a rolling 1 s coalescer with margin-based
  discard and per-module diminishing returns, the noise ring, the wrist tracker (pulse rate only —
  never a bearing, never a distance readout), heart rate and breathing.
- **M4 · the alien.** Full FSM, A\* over modules and rail-following inside them, hatch opening,
  anti-camp eviction, decoys, and the escalation director (a stage per system online, plus one free
  stage every 8 minutes).
- **M5 · six players.** Colyseus at 20 Hz, client-authoritative movement with a speed sanity check,
  interpolated remote bodies and alien, §10's constrained spawn roll.
- **M6 · voice.** WebRTC mesh over the room's signalling relay, mandatory mic calibration, gain
  gated by §3 propagation so a shout carries five modules and a whisper does not.
- **M7a/b/c · puzzles and attrition.** All six puzzles, the escape condition (four systems, then
  the undock sequence, then the capsule), death, medkit revival, the spectator headset channel, and
  "three of six escaping is a win".

**Audio is the half of the project §8 says it is:** every sound is graph-resolved per listener,
cross-module sound is panned **at the hatch it came through**, closed hatches lowpass at 400 Hz,
filter changes ramp rather than step, `PannerNode`s are pooled, each module kind has its own
convolution, and the world bus ducks under a sub-bass bed on HUNT.

---

## What is *not* implemented

By design (§9, §12: "grey-box everything in primitives until M8"):

- **M8 art.** Everything is boxes, cylinders and capsules. Handrails get a high-contrast material
  because they are the movement grammar; nothing else is dressed.
- **Alien animation.** It is a capsule that slides along the rails. §5 is explicit that this is the
  hidden giant and that a capsule is enough until M8, and it is.
- **Sound design.** Every noise is synthesized procedurally from oscillators and filtered noise.
  It reads correctly; it is not *scored*.

Deliberately cut or deferred, with the reasoning:

- **Cargo stow (§11·3) has no physics bags.** The puzzle exists server-side and the five rack slots
  are authored in the level, but the client-authoritative Rapier bags (`src/puzzles/cargoPhysics.ts`)
  are not wired into `main.ts` and there is no per-bag ownership relay in the protocol. §11 names
  this "the designated cut" and the escape needs four of the five gated systems, so a round is
  winnable without it. This is the one puzzle you cannot currently finish.
- **Spectator module cameras (§10).** A dead player's body persists and drifts, and they keep
  talking to the living on the headset channel, which is the part that keeps the group inside the
  game's own voice channel. Flying the free camera between module cameras is not built.
- **Jammed lockers** (pry 60 / 3 s versus hand-pump 6 / 25 s) are implemented in the puzzle host
  but default to a 0% chance, because a jammed locker is unopenable until the client sends
  `pry`/`pump` and an unopenable fuse is an unwinnable round.
- **Anti-cheat**, per §7. The alien's transform is synced to everyone and the tracker is computed
  client-side. Read it through `getAlienForClient()` if that ever needs to change.
- **A rebinding UI.** `KEYMAP` in `src/player/keymap.ts` is one object; mutate it and call
  `player.input.refreshBindings()`.

---

## Layout

```
index.html          # Vite entry at the project root; loads /src/main.ts
levels/
  station.json      # the authored 9-module station — regenerate with
                    #   npx tsx src/station/buildLevel.ts
src/                # browser client
  main.ts           # THE integration point: construction order, the loop, every callback
  core/             # event bus, fixed-timestep ticker
  station/ player/ noise/ alien/ puzzles/ ui/ audio/ net/ render/
server/             # Colyseus server, run with tsx
  rooms/ sim/ round/ station/ net/
shared/             # imported by BOTH src/ and server/
  constants/        # DESIGN.md §14
  types/            # every cross-boundary type
  graph/            # module graph, rail graph, noise propagation
```

`src/main.ts` is the only file that knows all eight subsystems exist. If you are looking for how
something is connected, its header comment lists the six data paths that matter and where each one
is wired.

### The `@shared` alias

Both sides import shared code as `@shared/...`:

```ts
import { FLOOR, catchNoise } from '@shared/constants';
import type { StationModule, NoiseEvent } from '@shared/types';
import { ModuleGraph, RailGraph, propagate } from '@shared/graph';
```

The alias is declared in **two** places and both are required — `tsconfig.json`
(`compilerOptions.paths`, which `tsc` and `tsx` read) and `vite.config.ts` (`resolve.alias`, which
the client bundle reads). Keep them in step.

### three.js imports

three is r185. **Use the `addons` form everywhere** — mixing it with `three/examples/jsm/...` in one
bundle duplicates modules:

```ts
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
```

Note the `.js` extension — it is required.

---

## Ground rules from the design doc

- **Never invent a constant §14 already defines.** `assertConstantsCoherent()` runs at import in dev
  and throws if the set stops being coherent. Change one number, re-check the set.
- **Sound is the only currency.** Everything routes through `@shared/graph/noise`. The server
  re-derives every loudness from §14; a client says *what it did*, never how loud it was.
- **Cross-module sound is panned at the hatch it came through** (§8). `resolve()` hands you
  `throughPort` and `panPosition` for exactly this; do not pan along the source's true bearing.
- **Clients own their own movement outright** (§7). No prediction, no reconciliation, no rollback.
- **`ModuleGraph` caches hatch state on its edges.** Call `graph.refreshHatches()` after ANY hatch
  change, or use `Station.setHatch()`, which does it for you. This is the single most likely runtime
  bug in the project.
- **The alien is a capsule until M8** (§5). Do not start on animation.

---

## Debugging

The client exposes `window.iss` in the console: `station`, `player`, `net`, `runtime`, `emitter`,
`bus`, `ui`, `renderer`, `ticker`, `audio`, `alien`, `interactor`. Some things worth trying:

```js
iss.net.director()                         // { stage, systemsOnline, msToNextFreeStage }
iss.net.alien()                            // interpolated capsule pose + state
iss.station.hatchSnapshots()               // every door, as the server sees it
iss.bus.on('noise:heard', console.log)     // what you can hear, and through which port
iss.runtime.resolveAt(pos, module, 45)     // "how loud would a hatch cycle be from there?"
```

`DEBUG_NOISE=1 npm run server` logs the alien's ear. Note that the real alien owns its own
coalescing window, so the per-window lines only appear under `USE_FALLBACK_SIMS=1`.
