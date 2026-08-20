# ISS — Architecture & Build Plan

*Revision 3 — the locomotion pivot: players walk by default and zero-G becomes a per-module condition.
Changes from r1 and r2 are noted inline wherever a number or a decision was reversed, so the reasoning
survives.*

Working title: **ISS**. Co-op first-person horror. Up to **6 players** trapped on the International
Space Station with something that hunts entirely by sound. You wake alone and scattered — find each
other, bring the station's systems back online, reach the escape vehicle. Stay quiet.

---

## 0. Design pillars

These three constrain every technical decision below. If a feature doesn't serve one, cut it.

1. **Sound is the only currency.** The alien has no eyes. Every mechanic — movement, puzzles, voice
   chat, the tracker itself — is a noise budget decision. The player must always be able to answer
   "was that loud?"
2. **Every metre is bought with noise.** Movement is the risk dial, and the player holds it down all
   round: crouch (4), walk (12), sprint (30) — three gaits, one choice, made continuously. Speed and
   silence are never available at the same time. Zero-G is the same bargain sharpened to a point, in
   the few modules that have lost their floor. Traversal is already a gamble; no extra stamina or
   sanity meter needed.
3. **Legible, not realistic.** The player must be able to build a correct mental model of the alien's
   hearing within one round. Fairness is what makes it scary rather than frustrating.

A fourth, learned the hard way in review: **the numbers are a system, not a list.** Every constant in
this document is cross-referenced in §14. Change one, re-check the set — the first draft's loudness
table, hearing floor and error formula each looked sensible alone and were mutually contradictory.

> **r2 reversal — pillar 2 used to read "Zero-G is the risk system. Nobody walks."** It isn't, and
> they do. Walking with three gaits is the risk dial; zero-G is a per-module condition that a handful
> of rooms are in. The full reasoning — motion sickness, hiding being impossible, one-dimensional
> chases, and the playtest report that forced the issue — is at the top of §4. It is the **only**
> pillar the pivot touches, and that restraint was deliberate: pillar 1 and pillar 3 are what the
> whole document hangs off, and a locomotion change has no business near either.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Build | Vite + TypeScript | Fast HMR; TS pays for itself the moment netcode appears |
| Render | three.js (`WebGLRenderer`) | Forward rendering is fine at this scale |
| Physics | Rapier (`@dimforge/rapier3d-compat`) — **client only** | Cargo bags and loose bodies. Nothing else needs it |
| Net | Colyseus | Rooms, schema state sync, TS end to end, low ceremony |
| Voice | WebRTC mesh (`simple-peer`) | 6 players = 15 connections, ~200 kbps up per peer — the ceiling for mesh, but it holds. Pin the version; it's effectively unmaintained |
| NAT traversal | coturn (STUN + TURN) | **Not optional.** One friend behind symmetric NAT otherwise costs you an entire playtest night |
| Audio | Web Audio API directly | You need custom occlusion filtering and port-positioned panning; `PositionalAudio` won't do it |
| Collision queries | `three-mesh-bvh` | Fast raycasts against static station geometry |

> **r1 reversal — no server-side physics.** The original rationale for Rapier was "same physics on
> client and server." That died the moment the player controller became a hand-rolled kinematic
> controller (§4): the alien is a rail-follower, noise is graph maths, and the only dynamic bodies
> left are five cargo bags and the occasional corpse. Running WASM Rapier in Node and keeping
> rigid-body state in lockstep is a real integration tax for five bags. Instead: **the nearest player
> is authority for a bag** (owner simulates, server relays). Deletes a whole category of risk.

> **r2 note — gravity does not change that, and does not buy you a character controller.** The
> obvious move on adding a floor is to reach for Rapier's `KinematicCharacterController`. Don't. The
> walking mode is the *same* hand-rolled swept controller with a down vector and a ground probe added
> (§4), for one reason: two of this project's hardest-won fixes live inside that controller — the
> pre-restitution approach-speed capture that makes catch-vs-crash loudness correct on the wire, and
> the closed-*and*-sealed hatch block on both the swept path and the rail path. An engine swap
> re-opens both, and both are load-bearing for §3 and §5. Extend, never replace.

Deliberately **not** used: a full ECS, server-authoritative physics, rollback netcode (§7).

```
src/
  core/        # game loop, fixed-timestep ticker, event bus
  station/     # module graph, rail graph, loader, portal culling
  player/      # walk + zero-g controller, gaits, hiding, camera, interaction raycaster
  noise/       # event bus, graph propagation, listener resolution
  alien/       # FSM, A* over module graph, rail follower, escalation director
  puzzles/     # puzzle registry + individual puzzle logic
  ui/          # wrist tracker, noise ring, crosshair, canvas panels
  audio/       # bus graph, occlusion filters, panner pool, voice capture
  net/         # colyseus client, interpolation
server/
  rooms/       # StationRoom: authoritative sim
  sim/         # alien AI + noise propagation + director
shared/
  types/       # schemas used by both sides — single source of truth
  graph/       # module graph + rail graph traversal (client and server)
  constants/   # §14, imported everywhere, never duplicated
```

---

## 2. The station graph

One data structure drives level layout, sound propagation, AI pathfinding, and render culling.
Getting this right first is the highest-leverage decision in the project.

```ts
type ModuleId = string;

interface StationModule {
  id: ModuleId;
  kind: 'straight' | 'node' | 'cupola' | 'airlock' | 'lab';
  transform: { pos: Vec3; quat: Quat };
  ports: Port[];
  gravity: 'nominal' | 'zero';   // REQUIRED, authored, and mutable at runtime (§4)
  rails: RailSegment[];          // see below — not optional, but only load-bearing while zero
  hideSpots?: HideSpot[];        // lockers, equipment bays, crew bunks (§4). Most modules have none
  props: PropRef[];
  lighting: 'nominal' | 'emergency' | 'dark';
  volume: number;                // m³, drives reverb selection
}

interface Port {
  id: string;
  localPos: Vec3;            // ALSO the audio panner position for cross-module sound (§8)
  localDir: Vec3;
  link: { module: ModuleId; port: string } | null;
  hatch: {
    open: boolean;
    sealed: boolean;         // powered lock; blocks the alien, needs a charge to set (§5)
    attenuationDb: number;   // open -3, closed -25, sealed -40
  };
}
```

Modules are cylinders — build a kit of five pieces (straight 5m, 6-way node, endcap, cupola, airlock)
and snap them via ports. Authoring is then a JSON file, and you get a level editor almost free.

`gravity` is a required field with a sane default: a loader normalising raw JSON writes `'nominal'`
when the level says nothing, so a level authored before the pivot still loads and simply has floors
everywhere — which is the correct default. It is also **mutated in place at runtime**, exactly the way
`Port.hatch` already is, so every consumer that reads the layout live sees a gravity failure with
nothing to invalidate.

### Authored zero-G is a budget, not a flavour

**At most two of the 8–10 modules may be authored `zero`**, and authored-plus-director-dropped may
never exceed half the station (§14; `ModuleGraph.validate()` fails the level otherwise). Author half
a station without a floor and you have rebuilt the round the pivot exists to delete, one JSON file at
a time. The check is in the validator precisely because this is the mistake that will feel reasonable
at the time.

Pick the two for meaning, not variety: a module where zero-G *is* the puzzle (cargo stow, §11), and a
module on a route people take under pressure. A zero-G dead end nobody enters is two modules of budget
spent on nothing.

### Gravity modules need geometry — corners, not tubes

**A bare 5-metre tube with a floor is the same countdown as a bare 5-metre tube without one.** A
fleeing player in a featureless cylinder has exactly one variable — speed — and speed alone against a
faster pursuer is not a chase. That one-dimensionality is a named reason for the whole pivot (§4), and
adding a deck does not fix it by itself.

So it is an authoring requirement, not a suggestion. **Every gravity module a chase can plausibly
cross must contain at least one of:**

- a **corner** or a bend that puts geometry between you and your pursuer,
- a **partial bulkhead** — a half-height rack, a stowage wall, a console island you can put a body
  width of steel around,
- a **side bay with a second exit**, or
- a **loop** you can run around.

Because the alien is blind, none of these break its *sight* — they break its *committed path*. A loop
is the highest-value piece of geometry in the kit for exactly that reason: the thing has to pick a
direction, and it can pick wrong. A dead-end bay is not escape geometry; it is a hiding place, and
authoring one means authoring it as one, knowingly.

Nodes get this for free. Straight runs do not, and a straight run is the kit piece you will use most,
so the props in a straight piece are doing structural design work and should be laid out as such.

None of it is free geometrically: the deck below is **1.32 m wide**, which is one body. Every corner,
bay and loop has to buy its own width out of the tube, so read the next section before authoring any
of them.

### The deck — one handshake the kit and the controller must agree on

The straight kit piece has a **1.0 m interior radius**, and the deck is inset into it. Three shared
constants settle it, and **all three are in §14 — do not invent a floor height, and do not hardcode
−0.75 anywhere**:

| Constant | Value | What it fixes |
|---|---|---|
| `DECK_Y_M` | −0.75 | deck offset from the module centreline, along `STATION_DOWN` |
| `DECK_HEADROOM_M` | 1.75 | deck to tube ceiling — a 1.7 m standing collider fits with 5 cm spare |
| `DECK_HALF_WIDTH_M` | 0.66 | walkable half-width at that inset: **1.32 m of floor** |

Five centimetres of headroom is deliberately cramped and should feel it, but it is tight enough that
if the deck inset moves, standing players clip the ceiling. Deck height is a shared constant and not a
kit detail for exactly that reason: a change to it is a change to §14's collider constants and needs
the kit and the controller in the room together.

**1.32 m of walkable floor is the number the chase geometry above has to fight.** A metre and a third
is one body wide. Corners, bays and loops have to *widen the deck locally* to exist at all — a bulkhead
you cannot get a body width around is a wall, not cover — so the geometry requirement and the deck
inset are one problem, not two.

Related and cosmetic: handrails are authored at y = −0.6, which sits 15 cm above this deck — trip
height, straight across a walkable floor. Harmless to the simulation, since rails are scenery in a
`nominal` module, but it will look wrong and read as a mistake. Move them up or drop them from the
straight piece when the art pass lands.

### The rail graph — build it at the same time

Both the player's GRIPPING state (§4) and the alien's in-module navigation (§5) need to know how
handrails connect. Neither works without it, and it was missing from r1 entirely.

```ts
interface RailSegment {
  id: string;
  a: Vec3; b: Vec3;          // endpoints in module space
  connects: string[];        // other segment ids reachable without letting go
  portLink?: string;         // segment continues through this hatch
}
```

Author it once per kit piece; it instances with the geometry. A* runs over modules, then over rail
segments within each. **Design it before M1** — retrofitting rail continuity onto a working grip
system is miserable.

**Author rails in every module, but only zero-G modules use them for player movement.** The rail
graph is scoped by gravity mode, and the two consumers scope it differently on purpose:

- **The player** queries at scope `zero` — grabbing and sliding only work where there is no floor, so
  you can never slide out of a zero-G module into a room you should be walking through.
- **The alien** queries at scope `any`. Rails are its nervous system; it rail-follows inside *every*
  module regardless of gravity (§5), and scoping them would break its pathfinding across most of the
  station.

That is why rails stay non-optional. It is also why a module can lose its floor at any moment without
the level needing a second authoring pass: the rails were always there, they simply became relevant.

**The hatch rule runs first, always.** Gravity scope is layered *on top of* `jointOpen()` in
continuation picking, never in place of it. A closed hatch blocks and a sealed hatch blocks, on the
swept path and on the rail path, in both gravity modes. This has been broken once and measured back
into place once; if you touch continuation picking, re-measure it by counting **modules crossed**, not
distance travelled — a long slide can rack up hundreds of metres circulating inside one module's own
rail loop and read as a pass.

### Culling

Render the player's module plus everything **two hops** away through open hatches. One hop was wrong:
down a straight run of aligned 5m tubes you can plainly see two modules ahead, and the second would
pop into existence in view. Two hops is still one trivial traversal; set the exponential fog so hop
three is invisible anyway.

Target scope: **8–10 modules** at six players. Six people in six modules is crowded — the reunion
phase ends before it starts and the noise floor never drops. That is still a complete game; resist
twenty.

---

## 3. Noise system

The heart of the project. Lives in `shared/` because the server is authoritative but clients need it
locally for audio.

### Event

```ts
interface NoiseEvent {
  kind: NoiseKind;
  origin: Vec3;
  module: ModuleId;
  loudness: number;   // 0–100 at source
  t: number;          // server tick
  actor?: PlayerId;
}
```

### Propagation

BFS outward from the origin module, accumulating attenuation:

```
level(module) = loudness
              - ATTENUATION_PER_M * distanceMetres    // in-module linear falloff
              + Σ hatchAttenuationDb(edges crossed)   // NOTE: these constants are NEGATIVE

stop expanding when level < FLOOR                     // physical audibility floor
```

**Sign convention.** §14 defines the hatch constants as negative dB offsets (`HATCH_OPEN = -3`),
so they are **added**, not subtracted. An earlier revision of this section subtracted magnitudes,
which was arithmetically identical but read as a contradiction against §14 and against
`Port.hatch.attenuationDb`. Add the constants everywhere; `hatchAttenuationMagnitude()` exists if
you genuinely want the positive number.

Linear falloff, not inverse-square: realism here makes the mechanic illegible, and players need to
reason about "roughly how many modules away can this be heard."

> **r1 reversals — two constants changed, and they were the worst bugs in the document.**
>
> **Attenuation 2.0 → 1.0 per metre.** At 2.0, a single 5m module ate 10 points, so nothing under
> loudness 10 crossed a room and nothing under 25 crossed the station. The handrail knock (§10) was
> specified as carrying "about two modules" and actually died at 2.5 metres: `15 − 2.0×10 − 3 = −8`.
> At 1.0 the same knock arrives at exactly 2 — audible at the floor, two modules out, as designed.
>
> **Floor 10 → 2.** The old floor sat *above* the entire quiet tier: rail pull 4, push-off 8, hand
> pump 6, headset 5 — all of them inaudible at zero distance in the same module. The quiet tier had
> a noise cost of literally zero, which quietly deleted pillar 1. Everything in the table is now
> physically audible at short range; what changes by situation is whether the alien is *listening*.

### Attention thresholds — what the alien bothers to react to

The floor is physics. Attention is behaviour, and it is state-dependent:

| Alien state | Reacts to arrivals ≥ |
|---|---|
| PATROL | 12 |
| INVESTIGATE / SEARCH | 4 |
| HUNT | anything |

This is the tension the design always wanted and never had: a rail pull (4, audible to ~2m) is
completely safe at distance, and *fatal* when the thing is sweeping your module and you shift your
grip. It is one sentence to explain — "it hears better when it's already looking for you" — so it
costs nothing against pillar 3.

The escalation director (§5) lowers the PATROL threshold as the round progresses.

### Loudness table

Tune these first — they *are* the difficulty curve. All values sanity-checked against §14.

| Action | Loudness | Carries roughly |
|---|---|---|
| **Footstep, crouched** | **4** | 2 m |
| Rail pull | 4 | 2 m |
| Headset speaker (spectator comms) | 5 | 3 m |
| Hand pump / manual override | 6 | 4 m |
| Gentle push-off | 8 | 6 m |
| Slipping into a hide spot, carefully | 8 | 6 m |
| Panicked breathing | 6–14 | scales with heart rate (§6) |
| **Clean rail catch** | **8 + 3 × speed** | 26 at full 6 m/s |
| **Footstep, walking** | **12** | ~1 module |
| Handrail knock | 15 | ~2 modules |
| Tracker beep (unmuted) | 20 | ~1 module |
| Body collision while carrying | 25 | ~1 module |
| **Footstep, running** | **30** | ~2 modules |
| Cargo bag bounce | 30 | ~1 module |
| Diving into a hide spot | 30 | ~2 modules |
| Breaker toggle | 35 | ~2 modules |
| Gravity plant failing (emitted at the module centre) | 35 | ~2 modules |
| Hatch cycle (either party) | 45 | ~3 modules |
| **Landing** | soft for your gait → **that gait's footstep**; otherwise `15 + 6 × speed` | 4 crouched or 33 sprinting, off the same jump |
| **Uncontrolled impact** | **15 + 6 × speed** | 51 at 6 m/s |
| Voice (proximity) | 10–55 | up to ~5 modules at a shout |
| Alien breaching a hide spot | 55 | ~4 modules |
| Pry bar / power tool | 60 | ~4 modules |
| Fire extinguisher thrust | 65 | ~4 modules |
| Decoy impact | 70 | ~5 modules |

**Footsteps are events, not a loop.** One noise per stride, and a stride is a *distance*: 0.55 m
crouched, 0.75 m walking, 1.15 m running. Never a timer. A timer charges the player shuffling against
a bulkhead the same as the one crossing a module, and charges twice for a journey taken in two halves.
Distance makes the cost exactly proportional to ground actually covered, which is the only honest
version of pillar 2 — and it means the audio layer emits discrete `footstep` events the player hears
themselves make (§8), not an ambient walking bed that nobody can price.

The three values are the difficulty curve now, so read them against the attention table above: a
crouched step (4) equals a rail pull and is fatal only point-blank in a SEARCH; a walking step (12) is
*exactly* the stage-0 PATROL threshold, so walking is heard only at point-blank early and a module away
by stage 4; a running step (30) clears every patrol threshold at every stage and every crew size.
**Running is always heard. There is no stage of the game at which it isn't.**

> **r1 fix — the tracker beep was 12**, which at any attenuation propagated about a metre. "The
> hardest button in the game to press" was a free mute. At 20 it carries a module, so muting is a
> genuine trade. Note the consequence, and tune it deliberately rather than discovering it in a
> playtest: since the beep accelerates as the alien closes, an unmuted tracker gets *louder* the more
> danger you're in. That death spiral is good design, but it is sharp.

### Localization error — the fairness mechanic

The alien does not learn the exact origin. It investigates a point offset by:

```ts
errorRadius = clamp((70 - level) / 5, 2, 12);   // metres
```

> **r1 reversal.** The old formula, `clamp(20 - level, 0, 12)`, was nearly dead code: it returned
> zero error for anything arriving at 20 or above — which on this table is almost everything, so a
> breaker toggle one module away pinned your exact coordinates — and its upper bound of 12 required
> an arrival of 8, which the old floor of 10 could never deliver. The mechanic existed in a
> ten-point sliver of a hundred-point scale.

The new curve: precision requires genuinely loud events (a pry bar at close range → ~3m), a
whisper-level arrival gives 12m of slop, and the **2m minimum means the alien can never teleport-pin
anybody**. That floor is the fairness guarantee the old formula lacked.

### Coalescing

Six players generate a continuous stream of events. If the alien re-targets on every one it thrashes
between destinations and reads as broken.

- Evaluate a **rolling 1.0s window**; act on the loudest event in it.
- **Discard by margin, not absolutely:** only drop events more than **15 points below** the window's
  loudest. Anything within 15 is retained as a secondary investigation target.
- **Diminishing returns per module:** each consecutive window whose loudest event comes from the same
  module widens that module's effective error radius by 3m, to a maximum of +12. Resets when the
  loudest event comes from anywhere else.

> **r1 fix — this was a remote control.** The original rule (1.5s, discard everything quieter,
> "players will feel clever, let them") composed with decoys into a leash: one player kites the alien
> with a repeating 70-loudness source while five teammates cycle hatches at 45 in total impunity.
> Margin-based discard means a hatch cycle under a decoy is still *remembered*; diminishing returns
> means the alien stops falling for the same trick in the same place. Masking a rail pull under a pry
> bar — the emergent play actually worth having — still works exactly as intended.

Decoys are correspondingly scarce: **two per round**, found in lockers, no respawn (§5).

---

## 4. Player controller — two modes

Hand-rolled kinematic controller, swept capsule against a BVH of static geometry. Two locomotion
regimes, chosen per module by `StationModule.gravity` (§2): **`nominal`, where you walk, and `zero`,
where you float.** Walking is the default and the overwhelming majority of the station.

> **r2 reversal — the locomotion pivot. This is the largest change in the document.**
>
> **The old model:** zero-G everywhere. Nobody walked, ever. You pulled along handrails at 1.2 m/s or
> pushed off at up to 6 and caught something. Pillar 2 said so outright — "zero-G is the risk system"
> — and every subsystem was built on it. Three things killed it.
>
> **1 · Motion sickness.** It was already the first entry in §13's risk list and the reason comfort
> options were pulled forward into M0. Six continuous degrees of freedom for forty minutes makes some
> fraction of any friend group ill, and no vignette fixes that for the people it affects. A game that
> costs you a third of your players in the first ten minutes does not get a second session.
>
> **2 · Hiding was impossible.** There is nowhere to *be* in a tube you are drifting down the middle
> of. The genre's central verb — get in the locker, hold your breath, listen to it pass — could not
> exist, which is why the alien only ever had two answers: outrun it, or die.
>
> **3 · Chases were one-dimensional, and §5 admitted it in a heading.** A 5 m tube gives a fleeing
> player no corner, no branch, no route choice. The alien hunts at 3.0 and a rail slide is 1.2, so the
> only escape was a push-off, and a push-off resolves into a catch or a crash inside one module. The
> playtest report was blunt: ***"the monster finds you basically instantly and is faster than you."***
> That is not a tuning complaint. There is no value of `SPEED_HUNT` that fixes a corridor.
>
> **The new model:** every module has a local floor and players walk by default. Zero-G is a
> per-module condition — two authored modules plus whatever the director drops (§5) — a spike of
> tension in a few places instead of a tax on every second of play. Pillar 2 becomes the gait dial.
>
> **What did not change, deliberately:** the noise system, the alien FSM, the escalation director, the
> puzzles, the netcode, and every zero-G number below. Zero-G was well tuned. It was never the tuning
> that was wrong, it was the dose.

### One down vector for the whole station

`STATION_DOWN` is a single frozen global, `(0, −1, 0)`. Every module that has a floor has the **same**
floor.

Per-module gravity *directions* were considered and rejected outright. They sound atmospheric — a node
where the wall becomes the deck, a lab you enter sideways — and they destroy the exact thing pillar 3
exists to protect. Every hatch becomes a reorientation puzzle; "it's two modules that way" stops
meaning anything; and §3's localisation error, the fairness guarantee of the entire design, becomes
unreadable, because reasoning about a 12-metre error radius requires knowing which way is up. The
player's spatial mental model is the product. Do not charge them to rebuild it at every port.

−Y is also free: it matches the kit (handrails authored below each module axis), the level's
horizontal layout, and every assumption an artist or a player will make without being told.

The gravity **mode** varies per module. The gravity **direction** never does.

### Walking — the default, and the risk dial

**States:** `GROUNDED | AIRBORNE`

| Gait | Speed | Stride | Footstep | Silent landing up to |
|---|---|---|---|---|
| Crouch | 0.75 m/s | 0.55 m | **4** | 3.4 m/s |
| Walk | 1.4 m/s | 0.75 m | **12** | 1.8 m/s |
| Sprint | 2.4 m/s | 1.15 m | **30** | 1.2 m/s |

Three gaits, held on a key, switchable mid-stride. This table is the risk system, and it is meant to
be readable in one glance: crouching costs half your speed and buys near-silence; sprinting is heard
by everything, everywhere, always.

The two speeds that matter are bounded by the alien, not by feel:

- **Sprint 2.4 > `SPEED_PATROL` 1.5.** You can outrun a patrol. Fleeing is a real verb, which under
  the old model it simply was not.
- **Sprint 2.4 < `SPEED_HUNT` 3.0.** You cannot outrun a hunt. Escape requires **geometry** — a
  corner, a side bay, a hatch, a loop (§2) — and the 0.6 m/s deficit is precisely what makes geometry
  matter. It eats one module of your lead every 8.3 seconds, during which you cover four more. That is
  a chase with decisions in it rather than a countdown.
- **Walk 1.4 < patrol 1.5**, and **crouch 0.75 < rail slide 1.2**. The careful options are slower than
  everything hunting you, in both regimes. That is the point of them.

The full ladder, asserted in §14: crouch 0.75 < rail slide 1.2 = SEARCH 1.2 < walk 1.4 < PATROL 1.5 <
sprint 2.4 < HUNT 3.0 < push-off 6.0. **A push-off is still the fastest thing in the game**, so zero-G
remains the high-risk shortcut it was designed to be rather than a punishment.

**Footsteps are distance-based** (§3), and the meter must be fed *ground-plane* distance, not total
displacement, or a falling body gets charged for footsteps it never took. It starts half-primed so the
first step from a standstill lands where a real first step lands, not a full stride later.

**Jump is 0.45 m, and the smallness is the mechanic.** You land at `sqrt(2gh)` = 2.97 m/s, which sits
*above* walking's silent-landing tolerance (1.8) and *below* crouching's (3.4). Therefore: **jumping is
loud unless you land in a crouch** — 4 instead of 33, bought with one keypress. That is §11's
loud-fast/quiet-slow rule applied to a movement verb, and it is the whole jump design in one number.

**Falls cap at 6 m/s**, deliberately equal to `PUSH_MAX`, so the §3 table's authored top end —
"uncontrolled impact, 51 at 6 m/s" — bounds every impact in the game no matter how far anyone falls.
Terminal is reached from rest in 0.61 s over 1.83 m, inside one module's height. A routine trip must
never be able to out-shout a thrown decoy on a scale with no room left above it.

All of it is sized against the **deck**, not against a person: `DECK_Y_M` −0.75 and `DECK_HEADROOM_M`
1.75 (§2) are what the ground probe and the standing collider are measured from, and 5 cm of clearance
over a 1.7 m collider is the whole margin. Import those constants; a controller that invents its own
floor height clips the ceiling in every straight piece in the station.

The rest is unglamorous and should stay that way. `STEP_HEIGHT_M` 0.4 so you walk over coamings, racks
and cable runs without a jump input. `GROUND_PROBE_M` 0.35, deliberately *shorter* than the step
height — the probe answers "am I standing on something", step height answers "may I walk up onto
that", and a probe longer than a step is how a controller ends up hovering over a two-step drop.
`GROUND_ACCEL_M_S2` 24, reaching sprint in 0.1 s, because mushy acceleration reads as input lag in a
horror game. `AIR_CONTROL` 0.25 — you may steer a jump, you may not accelerate out of a fall.

### Zero-G — scoped to modules with `gravity: 'zero'`

Every number here is unchanged from r2. What changed is that you meet it two or three times a round
instead of continuously, which is what makes it frightening again.

**States:** `FLOATING | GRIPPING | CHARGING`

- **FLOATING** — `pos += vel * dt`. No gravity. Air drag as a **half-life**: `vel *= 0.5^(dt / 4)`,
  i.e. velocity halves every 4 seconds. (r1 said `vel *= 0.98^dt`, which in seconds is 2% loss per
  second — a bad 9 m/s push is still doing 7.4 m/s ten seconds later, so the drag "quietly rescuing
  bad pushes" rescued nothing. The ambiguity between per-second and per-frame was itself a bug
  waiting to happen; specify half-lives, never bare exponents.)
- **GRIPPING** — anchored to a rail segment. WASD slides you along the rail axis at **1.2 m/s**, and
  you can traverse to connected segments via the rail graph (§2). Look stays free.
- **CHARGING** — hold Space while gripping. Charge 0→1 over 1.2s, release for
  `cameraForward * lerp(2, 6)` m/s. The charge arc is the only non-diegetic HUD element and belongs
  on the crosshair, not in a corner.

#### Catching a rail — buffered, and quieter than crashing

**Hold Grip to auto-latch the first rail entering range.** Not a tap-to-grab on arrival: grab range is
0.8m, so at full speed the reaction window is `0.8 / 6 = 133ms` — and at r1's 9 m/s it was **89ms**,
beneath human reaction time. Fast travel would have been a guaranteed crash, collapsing M1's promise
of "three ways across a module at three risk levels" down to one. Buffered latching is the difference
between a skill ceiling and a trap.

**A clean catch and a crash are not the same sound.** Arrested grab is `8 + 3 × speed`; uncontrolled
impact is `15 + 6 × speed`. In r1 both used the impact formula, so a perfect 9 m/s catch was loudness
69 — louder than a pry bar — and there was no quiet way to be fast, ever. Now a full-speed clean catch
is 26 and a full-speed crash is 51: skill buys you roughly a module and a half of silence, which is
what makes the risk ladder real.

Both of those numbers reach the server correctly for one reason, and it is worth knowing before you
touch collision code: **approach speed is captured from the pre-restitution velocity**, before
restitution and tangent friction have mutated it. Sample after the bounce and every crash in the game
quietly reports as a gentle one. §14 pins 51 and 26 as build-breaking assertions so a constant drift
can no longer re-break §5's chase loop in silence.

Push-off caps at **6 m/s**, down from 9. At 9 you cross a 5m module in half a second with no time to
steer, and the crash loudness topped the decoy.

**Fire extinguisher** — limited-charge thruster for when you're stranded mid-module with no rail in
reach. Loud (65). A panic button with a price.

**Rails are only movement here.** In a `nominal` module handrails are scenery to the player — still
authored, still instanced, still the alien's nervous system (§2), but you walk past them. Never design
a gravity module that requires the rail graph to cross it.

### Crossing between the two — four transitions

| Transition | When | Velocity | Noise |
|---|---|---|---|
| **launch** | you walk or run out of a gravity module into a zero-G one | ground speed carried through, unchanged | ≥ 2 m/s pays `PUSH_OFF` (8); below that, genuinely silent |
| **settle** | you float into a module that has a floor | you start falling; the landing resolves separately | 0 |
| **landing** | you reach the deck | closing speed along `STATION_DOWN` | soft for your gait → one footstep; otherwise `impactNoise` |
| **liftoff** | the floor fails underneath you | 0.6 m/s residual push from legs that were holding you down | 0 |

**Momentum is conserved on a launch.** No free boost, no free brake — you enter zero-G doing exactly
what you were doing. A walk (1.4) drifts in silently; a sprint (2.4) clears `LAUNCH_MIN` and announces
itself at 8. `LAUNCH_MIN` **is** `PUSH_MIN`, 2 m/s: §14 already defined 2 as the slowest thing that
counts as a push, so the rule needed no new number, only the observation that it was already there.
Sprinting into a failed module is exactly as loud as pushing off, which is correct — it is the same
act.

**`LIFTOFF_IMPULSE_M_S` = 0.6** is the entire feel of losing the floor: enough that a standing body
visibly leaves the deck, low enough that the deck stays within reach for about a second, which is your
window to get a hand on a rail. Asserted strictly below `RAIL_SLIDE`, so it can never read as a
launch.

**Zero loudness means emit no event at all**, not an event carrying zero. A walking launch and every
liftoff are silent, and a phantom 0-loudness event in the coalescing window (§3) is a bug that will
take a day to find.

**Landing velocity must be sampled before contact resolution** — the same discipline as the catch
capture above, and the same failure mode. A landing sampled after the stop reads 0 m/s and reports one
quiet footstep no matter how far you fell.

### Gravity failure — a set-piece, never a surprise

A module's gravity can be cut by the escalation director (§5), by damage, or by a puzzle, and restored
the same ways. It is always announced, in this order:

1. **2.5 seconds of warning** (`GRAVITY_WARNING_S`). The plant winds down audibly first. The floor
   never simply vanishes under anyone.
2. A **`gravity-shift` noise at 35** — breaker-toggle loud, about two modules — emitted **at the module
   centre, not at any player**. Nobody caused it, so nobody is blamed for it. But the alien hears it
   and moves, so a failure is a real event on the map and not just weather.
3. Everyone standing gets a `liftoff`. Anyone already airborne simply keeps floating.

2.5 seconds is 6 metres at a sprint — more than a module length — so from anywhere in the room you can
reach a rail. That is the fairness guarantee, and it is the only reason a director-triggered failure
reads as dramatic rather than cheap. Route gravity changes through the announced path; the immediate
setter exists for level load and puzzle scripting, not for anything the player is meant to survive.

A director failure **self-repairs after 90 seconds**. A §11 puzzle can restore it sooner, which makes
"go turn the floor back on" a legitimate objective rather than a chore.

### Hiding — the genre gap r1 and r2 left open

There was no hiding mechanic in this design at all. In a game about a blind predator that is not an
omission, it is a missing verb: every ancestor of this game is built on the moment where you are three
feet from the thing with a locker door between you, and the old document's only answer to "it's
coming" was "move faster."

**Hide spots** are authored per module — lockers, equipment bays, crew bunks — as a small oriented box
with an entry position, a look direction, and a capacity (default one body). **Minimum six across the
station**, roughly one per module outside the escape and finale rooms.

`HIDDEN` is a player state in **both** regimes and it is the sixth state in the game. While you are in
one, no locomotion input is read at all — you are a pair of ears and a decision about when to leave.

**Because the alien is blind, hiding is not about being unseen.** It is exactly two things:

1. **Not being physically swept through.** The hide volume is geometry the alien's body has to route
   around. A box the alien can walk through is not a hide spot, it is a decoration.
2. **Staying quiet.** The shell takes **−8 dB** off everything you emit, additively, exactly like a
   hatch offset — `level + muffleDb` is the entire implementation. That number is sized off the one
   sound you cannot stop making: panicked breathing at 14 becomes 6, which decays below `ATTN_SEARCH`
   (4) after three metres. So `HIDE_SAFE_RADIUS_M` = 3 is **derived, not chosen**: the thing has to be
   practically leaning on the locker. Deeper muffling makes hiding a win button; shallower makes it
   theatre.

> **There is no sight logic anywhere in this codebase, and hiding does not introduce any.** No vision
> cone, no line-of-sight query, no "can it see me" test — not in the hide system, not in the alien, not
> anywhere. The hide graph is pure geometry: containment, sweeps, and distances. If a future feature
> seems to need a visibility test, the feature is wrong, not the rule. This is the same commitment §5
> makes about perception, restated where it would be easiest to break.

**Getting in costs noise, and haste sets the price.** A careful entry takes **2.5 s at loudness 8** —
under the base PATROL threshold (12) at every crew size, and by stage 4, when that threshold has fallen
to 4, still only audible within four metres. Genuinely quiet, in other words, without ever being free.
A last-second dive takes **0.5 s at loudness 30** — above even a solo patrol's threshold of 20, so it
is *always* heard, at every stage and every crew size. And §14 asserts that the
careful entry does not fit inside the 1.67 s a HUNT needs to cross a module: **hiding late cannot be
bought.** Hiding *early*, before it has a fix on you, is the skilled play. Same loud-fast/quiet-slow
rule as everything else in the document.

**A heard hide spot is not a coffin.** If the alien resolves your box it breaches: 1.2 m contact range,
2 seconds, loudness 55 — equal to `ALIEN_HUNT`, because §5's non-negotiable rule is that it never does
anything decisive in silence. Those two seconds are a window to bail out, loudly, into a room with the
thing in it. A decision, not a cutscene.

Spots declare which regime they work in. An equipment bay you stand up into is `nominal`; a stowage net
you float into is `zero`; a bunk with restraints is either, and most are.

### Comfort options — still M0, now doing less work

Roll-lock (fixed horizon), snap-turn, FOV slider, a vignette that tightens with angular velocity, and
now a **head-bob slider** (0 = off, 1 = the authored 4.5 cm) because a bob one player reads as
atmosphere another reads as nausea.

**Head bob never changes emitted noise**, in either direction. A comfort setting may not alter what the
alien hears — that would make an accessibility option a competitive one, and it would break the mental
model pillar 3 protects for the player who most needs it intact. Say so in the menu.

The pivot itself is the largest comfort feature in this document: most of a round is now walking on a
floor with a fixed horizon.

---

## 5. Alien

```
DORMANT → PATROL → INVESTIGATE → SEARCH → HUNT → ATTACK
                       ↑____________|        |
                       └── RETREAT ←─────────┘
```

**Perception is sound + contact only.** No vision cone, ever. State this outright in the menu — a
legible rule is scarier than a mysterious one, because players blame themselves.

### Speeds

r1 never stated these, which left everything from chase design to whether a SEARCH sweep is
geometrically possible undefined.

| | Speed |
|---|---|
| PATROL / INVESTIGATE | 1.5 m/s |
| SEARCH | 1.2 m/s |
| HUNT | 3.0 m/s |

These three numbers now have to be read against the gait table (§4), because they bracket it on both
sides and that bracketing *is* the chase design:

- Patrol at 1.5 sits above a walk (1.4) and above the 1.2 m/s rail slide — **you cannot out-walk it and
  you cannot out-slide it.** Both careful options are slower than the thing's idle speed, in both
  regimes, which is what makes careful a real cost rather than a free win.
- Patrol at 1.5 sits below a sprint (2.4). **You can outrun a patrol**, and everything within two
  modules hears you do it.
- HUNT at 3.0 beats every option except a full push-off, but only by 0.6 m/s. That margin is the entire
  chase: small enough that geometry decides it, large enough that an absence of geometry decides it too.

> **r2 note.** Nothing in this table changed with the pivot. It did not need to — the numbers were
> always right, and it was the player's side of the comparison that was missing. Under the old model
> the only entry in that comparison was the 1.2 rail slide, which is why every chase resolved the same
> way.

### Chases — two loops now, and only one of them is a corridor

> **r2 reversal — this heading used to read "Chases are one-dimensional, so design them explicitly."**
> That sentence was the most honest line in r1 and it is cited as reason 3 for the whole pivot (§4).
> A design document that names a structural flaw in a heading and then designs around it has diagnosed
> itself. Half of it is now fixed and the other half is deliberately kept, because in a zero-G module
> one-dimensionality is *correct* — that is what makes those two rooms frightening.

**The gravity chase — the default, and the one with decisions in it.** It hunts at 3.0; you sprint at
2.4. You are losing at 0.6 m/s, which costs you one module of lead every 8.3 seconds while you cover
four more. That is time to spend, and the geometry requirement in §2 is what you spend it on:

1. You are heard the whole way. A sprint is 30, which clears every patrol threshold at every stage and
   crew size, so fleeing is never stealthy — it is a decision to spend noise for distance.
2. Break its **committed path** — a corner, a partial bulkhead, a side bay with a second exit, a loop.
   It is blind, so it is not tracking you visually; it is tracking a stream of noise to a point. Put
   steel between that point and yourself and it has to *pick a direction*, and it can pick wrong.
3. Or break the noise: get into a hide spot (§4) **before** it has a fix, and stop being a source.
4. Or close a hatch: 45, buys ~3 seconds while it opens the hatch — *also* 45, so you hear it coming.
5. Or drop to a crouch (4) and let a SEARCH sweep past you, which works exactly until it doesn't.

The failure mode to author against is a chase that offers only option 1. That is a countdown, and the
playtest report quoted in §4 is what a countdown feels like from the inside.

**The zero-G chase — unchanged, and still a corridor.** In a `zero` module the old loop is exactly the
loop, and it is kept on purpose:

1. It hunts at 3.0; you slide at 1.2. You lose.
2. Push off (up to 6 m/s) and you outrun it — briefly. It is still the fastest thing in the game.
3. You must catch (26, it keeps a fix on you) or crash (51, it definitely does).

Two authored modules' worth of that is a spike. A station's worth of it was the problem.

### Hatches

**The alien opens closed hatches** — 3 seconds, loudness 45, so it announces itself. It **cannot open
sealed ones**. Sealing costs one of **two power charges per round**, so barricading is a real tool
and not the whole game; without that scarcity the optimal play is to seal the station into halves and
win by carpentry, since a closed hatch at −25 already makes anything under 45 near-inaudible next
door.

### States

- **PATROL** — A* over the module graph, rail-following within each module at rail scope `any` (§2).
  Gravity mode does not change how it moves: it pulls along the same handrails in a room you are
  walking through as in one you are floating in, which after the pivot makes it **the only thing in
  the station that moves the same way everywhere.** That is a good property for the monster to have.
  **Crowd bias:** weight target selection 2:1 toward the module holding the largest cluster of
  players, so the far side of a ten-module station doesn't have a boring round.
- **INVESTIGATE** — moves to `origin + randomInSphere(errorRadius)` from §3.
- **SEARCH** — on arrival, sweeps that module and its neighbours for ~15s at 1.2 m/s. Most kills
  happen here, when someone breaks cover early — and with the SEARCH attention threshold at 4, so
  does every rail pull and every crouched footstep in the room. A sweep **routes around hide volumes**
  rather than through them (§4), and if a noise resolves to within `HIDE_BREACH_RANGE_M` of one, it
  breaches: 2 seconds, loudness 55. It resolves a hide spot by arriving at it, never by looking at it —
  there is no visibility test in this state or any other.
- **HUNT** — triggered by an arrival above 50 within 10m (above **35** at director stage 4), or by
  contact. **It makes loud noise while hunting.** Non-negotiable: a silent charge is unfair and reads
  as a bug.
- **RETREAT** — after a kill, or when pulled by a decoy.

**Anti-camping director:** if the alien has been within 15m of a living player for a **fuzzed 60–150
seconds** without a kill, force PATROL to a distant module. r1 used a flat, disclosed 90s, which was a
*guaranteed* escape valve — anchor, freeze, and it provably leaves. Fuzzed and undisclosed, freezing
is a gamble rather than a proof.

### The escalation director — the biggest thing r1 was missing

There was no timer, no escalation and no resource pressure anywhere in the original document. Every
puzzle had a quiet-slow path, quiet movement was free, and a 45-minute round cost the team nothing —
so the boring-optimal play is rail-pull-only, hand-pump-everything, freeze-when-the-tracker-quickens.
Silent-slow strictly dominated, and a group of friends converges on that by round three.

The station gets more dangerous as it comes back to life. Stage advances **per system brought
online** (diegetic, and it rewards progress with pressure), plus one free stage every 8 minutes so a
stalling team escalates anyway. That caps a round at roughly 20–25 minutes and gives every run an arc.

| Stage | Trigger | Patrol speed | PATROL threshold | Zero-G failures | Also |
|---|---|---|---|---|---|
| 0 | start | 1.5 | 12 | **0** | — |
| 1 | 1 system | 1.6 | 10 | **0** | — |
| 2 | 2 systems | 1.8 | 8 | **1** | crowd bias on |
| 3 | 3 systems | 2.0 | 6 | **1** | SEARCH duration → 25s |
| 4 | all systems / undock live | 2.2 | 4 | **2** | HUNT triggers at 35 |

**Thresholds scale with the living crew.** Six people generate six people's worth of noise; one
survivor generates a sixth of it, and against an unscaled table a lone player is latched onto
permanently. `crewScaledStage()` raises the thresholds as the crew shrinks — a solo survivor faces
PATROL 20 and SEARCH 8 rather than 12 and 4. Every hiding and footstep number in this document is
checked against the whole stage × crew-size grid, not just the six-player row (§14).

### Cutting the floor — the director's newest and heaviest lever

**The director may drop a module's gravity**, and the `Zero-G failures` column is its budget: how many
modules it may be holding in `zero` *on top of the ones the level authored* (§2). Stage 0 is exactly
zero, deliberately — **the round begins precisely as authored**, and the first thing that happens to a
player is never a systems failure they had no hand in. The budget is monotone from there.

The first failure lands at **stage 2**, and the timing is the design. Stage 2 is where §11's parallel
puzzles have the team split three ways, so a dropped floor almost always lands on somebody working
alone. Two at **stage 4**, because undock is live and the station coming apart is the point.

- It is **never a surprise**: 2.5 s of warning, then a `gravity-shift` at 35 emitted at the module
  centre (§4). The alien hears that and moves, so a failure relocates the monster as well as the floor.
  Nobody caused it, so nobody is blamed for it — this is the only loud event in the game with no actor.
- A director failure **self-repairs after 90 s**, and a §11 puzzle restores it sooner. "Go turn the
  floor back on" is a legitimate objective, and it is a *travel* objective, which is the thing the
  director is short of.
- **Solo caps at one**, never the stage-4 pair. A lone player has nobody to cycle a hatch for them,
  and two simultaneous failures ends a round to geometry rather than to the alien. §14 asserts the
  crew-scaled row is never harsher than the row above: fewer hands must never mean more zero-G.
- The hard ceiling is **half the station**, authored plus dropped, enforced in `ModuleGraph.validate()`
  as well as in the constants (§14). The director cannot rebuild the old game by accident.

Use it as a beat, not as weather. A failure is worth more than the sum of its noise: it converts a
known room into an unknown one, strands whoever is in it, and gives the team a reason to go somewhere.

Optional lever if rounds still drag: raise the ambient station hum by +2 to the audibility floor per
stage. Progress makes movement marginally safer while the alien gets sharper — a nice inversion, but
add it only if playtests demand it.

### Decoys

Throwable, loudness 70 on impact, pulls the alien and triggers RETREAT. **Two per round, found in
lockers, no respawn.** This is the best co-op tool in the game precisely because spending one has to
hurt (§3, coalescing).

### Navigation and animation — budget this honestly

"It moves the way the player does" means rail-following along the §2 rail graph with IK, and that is
plausibly the largest combined art-and-code line item in the project. It hid in a single sentence of
r1's rendering section.

**Through M4–M7 the alien is a capsule.** A scary audio source with a sphere for a body is genuinely
enough — §9 is right that horror lives in audio and lighting. Animation is M8 work, and if M8 never
happens the game still works.

---

## 6. UI

Diegetic by default. Four elements.

**Wrist tracker** — bottom-left, framed as a wrist-cam feed. Shows proximity as *pulse rate*, never
position: a beep every 3s when far, accelerating as the alien closes, solid tone when adjacent. Build
it as a DOM/CSS overlay, not a second WebGL scene.

> The tracker is audible in-world at **loudness 20** and has a mute toggle. Muted, you are silent but
> blind. Because the beep quickens with danger, leaving it on gets progressively more expensive
> exactly when you most want the information.

**Heart rate — core, not optional.** r1 filed this as a nice-to-have; it is load-bearing. Your heart
rate climbs with alien proximity and drives a breathing loop that emits 6–14 loudness. That is
roughly thirty lines, and it is the direct counter to the freeze meta: holding still next to the
alien stops being free. It also converts proximity into escalating dread mechanically rather than
theatrically. Show it as a second trace on the tracker.

**Noise ring** — a ring around the crosshair that expands on every sound you emit, scaled to how far
it actually carried. This is the tutorial; no text needed.

The pivot makes it do more work for free. Footsteps are discrete events (§3), so the ring now pulses
once per stride at a radius set by your gait — **the risk dial reads itself**, without a gait
indicator, a stamina bar or a line of text. Change to a crouch and watch the ring shrink; that is the
entire tutorial for the most important system in the game. It is also why footsteps must never be an
ambient loop: a continuous bed has nothing to draw.

**Crosshair states** — dot / hand (interactable) / rail (grabbable, zero-G only) / hide (a spot you
can get into) / charge arc (push-off).

**No gravity indicator, deliberately.** Losing a floor is announced by the plant winding down for 2.5
seconds and by the room going quiet in a specific way (§4, §8) — it is diegetic, it is audible from the
next module, and a HUD warning would be strictly worse information delivered later. The one thing the
UI owes you is that the warning sound be unmistakable, which is an audio job.

**Puzzle panels rendered in-world** — but as `CanvasTexture`, not render-to-texture of a second 3D
scene. These are gauges, needles and breakers: draw them with the 2D canvas API and update at 10 Hz
only while a player is in the module. Same in-world vulnerability — you must physically be at the
panel, one hand on a rail, back exposed, which is the entire reason puzzles exist — at a fraction of
the cost, and consistent with the DOM-overlay call above.

**No health bar.** You are caught or you are not.

---

## 7. Netcode

- **20 Hz server tick**; clients render interpolated at display rate.
- **Server owns:** alien state, noise propagation, the escalation director, puzzle state, hatches,
  deaths.
- **Clients own their own movement outright.** Send your transform; the server sanity-checks speed
  and teleports; done. The bound is `MAX_LEGAL_SPEED_M_S` **7.0**, and it is a §14 constant rather
  than a number in the room handler because the pivot moved it: the worst *legal* case is now a
  terminal-velocity fall with full lateral air control, `hypot(6, 2.4) = 6.46`, plus a tick of jitter.
  Re-derive it from the old zero-G-only numbers and the server starts rejecting honest falls.

> **r1 reversal — no prediction, no reconciliation.** The original said movement was "predicted
> locally, softly reconciled," but if the client owns it, that isn't prediction — it's client
> authority, and among friends that's the right call taken all the way. Momentum-based zero-G is the
> *easy* case for it: there are no server-driven forces to disagree about. Do not build rollback
> machinery. Interpolate remote players and the alien. M5 shrinks by about a week.

**Anti-cheat: deliberately skipped.** Sync the alien transform to everyone and compute the tracker
pulse client-side. That deletes a per-client server computation and a visibility test, and it makes
debugging enormously easier — spawn a free camera and watch the AI work. Someone with devtools could
see the alien; among friends that's a social problem, not an engineering one.

Cheap hedge: read alien position through a single accessor (`getAlienForClient(playerId)`) so if this
ever goes public there's exactly one place to change.

```ts
// Colyseus state (continuous)
players: { id, pos, quat, state, module, gait, gripId, hideSpot, alive, charge, heartRate }[]
alien:   { pos, quat, state }
hatches: { portId, open, sealed }[]
gravity: { module, gravity, pending, pendingMs }[]   // per module, incl. announced-not-landed
puzzles: { id, state, solved }[]
director:{ stage, systemsOnline }

// Ephemeral messages
noise    { pos, module, level, kind }
interact { targetId, action }
hide     { module, spot, action, haste }             // client → server
gravity  { module, from, to, cause, inMs }           // server → client, 2.5s AHEAD of the shift
death    { playerId, cause }
```

Four of those fields are the pivot and none of them are optional. **`module` and `gait` are required
on every transform** because noise resolution needs them: §3 cannot price a footstep without knowing
which gait made it or which module to propagate from, and a server that infers either from position is
a server that gets it wrong during a launch. **`hideSpot` is state, not a flag** — non-null implies
`HIDDEN`, and it is what tells the server to apply the −8 dB shell to everything that player emits.
The **`gravity` message is sent ahead of the change, never with it**; the 2.5 s warning is a fairness
guarantee (§4) and it only exists if the wire respects it.

### Voice

Peers connect WebRTC mesh for the audio; separately each client samples its own mic RMS and sends
`voiceLevel` at 10 Hz, which the server converts into a NoiseEvent. Offer push-to-talk, or half your
players mute and skip the best mechanic in the game.

**Calibrate the mic, or hardware variance kills the feature in session one.** Raw RMS is dominated by
per-player gain differences — one friend's hot mic sits at loudness 55 while breathing. Either run a
short calibration step at join (speak normally, normalise) or map post-AGC RMS with the browser's
automatic gain control on. Non-negotiable.

Keep **all** peers connected permanently and gate *gain* by proximity, rather than tearing down and
rebuilding connections as people drift out of earshot: renegotiation takes a second or two and would
clip the first moment of every reunion, which is precisely the moment this game is about. If
bandwidth ever bites, cull at two hops, not one.

### The Discord problem

Your friends will be in a Discord call before the game launches, and that defeats voice-as-noise, the
reunion phase, knock codes and the coolant valve's entire premise. You cannot detect it and cannot
engineer around it. What you can do:

- **State the contract in the menu**, the same way you state the alien's rules: *this game is played
  muted on Discord at your own peril — the voice system is the game.* Friends honour a stated
  contract far more reliably than an implied one.
- **Ship the spectator headset channel** (§10) specifically so the dead have a legitimate in-game
  reason to keep talking. If death means going silent, the Discord habit reasserts itself instantly
  and never goes back.
- **Playtest M6 with the real group, early.** If they route around it you want to know before you've
  polished the mesh.

---

## 8. Audio

The most underrated half of this project. Budget real time for it.

**Position cross-module sounds at the hatch they came through.** This is the single most important
line in this section and it was missing from r1. Propagation gives you *how loud* and *how muffled* —
but in a game whose entire premise is localising by ear, a sound from the next module must appear to
come **from the connecting port**, not through the bulkhead along the source's true bearing. You
already store `Port.localPos` (§2); pan there for any cross-module path. Without it, players' mental
model — the thing pillar 3 exists to protect — breaks in the first minute.

- Per sound, run the §3 graph propagation to the listener and drive a `GainNode` **and** a
  `BiquadFilterNode` from the result. Closed hatch = lowpass at 400 Hz, −25 dB. Muffled-through-a-door
  is the most immersive detail available and it costs almost nothing.
- **Ramp filter changes, never step them.** Use `setTargetAtTime` over ~100ms or every hatch cycle
  clicks audibly.
- **Pool your `PannerNode`s.** Browsers degrade past a few dozen HRTF panners.
- `ConvolverNode` per module kind with a short IR — a lab and a node tube shouldn't sound alike.
- Separate buses: world / your own body (breathing, grips) / tracker / voice. Duck the world bus and
  swell a sub-bass bed on HUNT.
- Every noise the player emits must be audible to them at full volume. They have to *feel* the mistake
  as they make it.

---

## 9. Rendering budget

Target 60 fps on a mid-range laptop.

- Max 4 real-time lights. **One** shadow map (the flashlight, 1024²). Everything else is emissive
  strips and cheap ambient.
- Exponential fog — hides draw distance and does more for dread than any model.
- `InstancedMesh` for handrails and repeated props; one draw call per prop type.
- Two-hop portal culling from the module graph (§2).
- Post: `EffectComposer` → bloom on emissives, vignette, film grain, light chromatic aberration.
- **Grey-box everything in primitives until M8.** Horror lives in lighting, audio and frame pacing,
  not polygon count. Handrails get a high-contrast material from day one because they're the movement
  grammar and must be readable in the dark.

Assets when you get there: Kenney and Quaternius (CC0), Poly Haven for textures/HDRIs, NASA's own ISS
models as reference (accurate, far too heavy — decimate hard).

Alien: long, thin, pale, moving by pulling along the same rails you do — **in M8**. Until then it is a
capsule (§5).

---

## 10. Six players: spawns, reunion, attrition

### Random spawns

Every player wakes alone, in a random module, on emergency lighting, with no idea where anyone else
is. The first few minutes become a separate game — a quiet, dread-heavy reunion phase before a single
puzzle is touched — and it costs almost nothing to build.

Constraints on the roll:

- **No two players in the same module.** Ten modules, six players; the roll is easy.
- **Minimum one hop apart.** Adjacent spawns are fine and make good stories. Co-located skips the act.
- **Never in the escape module**, and never in the module holding the finale.
- **Never in an authored zero-G module.** The first thirty seconds are when a player builds the mental
  model of the station that pillar 3 exists to protect, and they should build it standing up. Waking
  disoriented with no floor also front-loads the precise motion sickness the pivot exists to spread
  thin. Find zero-G later, on purpose, ideally through a hatch you chose to open.
- **The alien spawns randomly too**, at least three hops from the majority of players. Without that
  floor, someone dies at the ten-second mark and spectates for twenty minutes.

The reunion is tense for one reason: your only tool for finding people is your voice, and your voice
is the loudest thing you own. Shouting "where is everyone" works and is exactly as stupid as it
sounds.

### Knock codes

Tap a handrail — **loudness 15, carrying about two modules** under the corrected propagation constant
(§3). Quieter than speech, shaped by the module graph, and carrying no fixed meaning, so players
invent their own codes for "here", "safe", "run". That emergent protocol beats any comms system you
could design, and it's one input, one sound, about ten lines of code.

### Death, spectating, revival

At six players someone dies early. Every round. Plan for it, or a friend spends twenty minutes
watching a black screen.

- **Bodies persist** as physics objects (client-authoritative, §1). They lie on the deck in a
  `nominal` module and drift in a `zero` one — corpse physics only genuinely matter in the second
  case, which is now two rooms rather than the whole station.
- **Revival, v1: carry a medkit to the body.** Not the body to medical. You keep 80% of the tension —
  loud travel, exposed anchoring, a downed friend as a fixed destination — for 20% of the work.
  Hauling a ragdoll — dragging one down a 1.32 m deck or wrestling it through a zero-G module, with
  collision noise either way — is a physics, animation *and* networking project, and it was the most
  expensive single feature in r1. Upgrade to hauling in
  polish if the game earns it.
- **Spectators get a job.** The dead see through module cameras and speak to the living over the
  headset channel at loudness 5 — the team's eyes, at almost no noise cost. Cameras show modules and
  players, never the alien. This also keeps the group inside the game's own voice channel (§7).

### Winning with losses

**Escaping with three of six is a win.** Say so on the results screen and rank the outcome (crew
recovered: 3/6). A binary condition at six players means most rounds end in failure and the group
quietly stops playing.

### What six players actually costs

| Area | Change from four |
|---|---|
| Station size | 6 modules → **8–10**. The main scope increase |
| Noise floor | ~50% more events — coalescing (§3) mandatory |
| Voice mesh | 15 connections, ~200 kbps up per peer — at the ceiling, but it holds |
| Netcode | Linear and trivial |
| Alien count | Still **one**. Two would make the tracker pulse ambiguous and destroy the shared mental model |
| Pacing | Needs crowd-bias patrol (§5) |
| Puzzles | Need 2- and 3-player gates, or six people bottleneck around one panel |

**Six players is a content and pacing change, not an engineering one.** The netcode barely notices.
The station gets bigger and the puzzles have to spread people out.

---

## 11. Puzzles

```ts
interface Puzzle {
  id: string;
  module: ModuleId;
  state: unknown;         // server-authoritative
  solved: boolean;
  gates: string[];        // which escape systems this unlocks
}
```

**Hard design rule: every puzzle has a loud-fast path and a quiet-slow path.** A jammed hatch can be
pried (60, 3 seconds) or hand-pumped (6, 25 seconds, locked in place throughout). This rule is what
keeps the noise system relevant after the map is learned — and the escalation director (§5) is what
stops the quiet path from being free.

### Catalog

Six puzzles, deliberately simple. The difficulty is the alien, never the logic. Nothing here should
make a player feel stuck; it should make them feel *exposed*.

**1 · Breaker sequence** — *1 player · teaches the whole game*

Six breakers thrown in the right order. Each throw is a CLACK (35); a wrong order resets the panel
with a buzz (50). The sequence is on a laminated card stowed in a locker in another module, somewhere
different each round. Brute force is 720 permutations and roughly a death sentence. There's a manual
override under the panel: hold a lever 20 seconds at loudness 6, anchored, unable to look around.

Six booleans and an order array. Build it first — it teaches the loud-fast/quiet-slow rule with no
tutorial text.

**2 · Coolant valve** — *2 players · 2 modules · the thesis puzzle*

Module A has a pressure gauge and no valve. Module B has the valve wheel and no gauge. One turns, the
other reads the needle and talks them into the green band. Turning slowly is quiet (8); spinning the
wheel is loud (40), so the reader has to stay patient while their partner sits alone in the dark.

One synced float, a target range, a needle. Thirty lines, and it is the entire design in one
interaction. Build it second.

*Known hole, deliberately unpatched:* two players who've worked out knock codes can signal up/down
through the bulkhead and solve this in near-silence. The doc used to claim it "cannot be solved
without speaking." It can — and the group that discovers that will tell the story for years. Leave it.

**3 · Cargo stow** — *1–2 players · dexterity, zero logic · build last*

Five numbered bags float loose; each goes in its matching rack slot. They're rigid bodies — push one
too hard and it bounces off a bulkhead at loudness 30, then keeps bouncing, and now you have five
problems. Moving them gently is the whole puzzle, and gentle is slow.

It's the only puzzle that could exist nowhere but this game, and it is still the only reason Rapier is
in the build at all. Client-authoritative bags, owner-simulates (§1).

> **r2 reversal — cargo stow is no longer the designated cut.** r1 and r2 both flagged it as the first
> thing to drop if the schedule turned, on the grounds that it was expensive and optional. It is still
> expensive. It stopped being optional the moment zero-G became a budget.
>
> §2 allows **two** authored zero-G modules in the whole station and says to pick them for meaning.
> Cargo stow *is* one of those two: it is the only content in the document where zero-G is the puzzle
> rather than the hazard, and cutting it spends half the authored zero-G budget on a room with nothing
> in it. Worse, it takes the pivot's best argument with it — that zero-G is worth keeping *somewhere*
> because it does something no floor can. Cut this and the honest next step is to cut zero-G entirely,
> which is a different and much larger decision than a schedule trim.
>
> It stays in **M7c**, still built last, but built. The module it lives in is authored `zero` from M2
> whether or not the racks work yet.

**4 · Fuse hunt** — *any number · pure traversal · the designated cut*

Three blown fuses, three replacements in randomised lockers. Zero logic — its job is to force travel
while the alien is awake, and it's what spaces out the pacing between the thinky ones.

**It inherits the designated-cut slot from cargo stow**, for the reason that made it necessary in the
first place: it is the only puzzle with no idea in it. Its whole job is to make people walk somewhere
dangerous, and the director now does that directly — a dropped floor strands a module, and restoring
it is a travel objective with a monster attached (§5). The redundancy is real, so this is the honest
thing to lose.

It moves out of M7a and into **M7c** with the rest of the cuttable work, because M7 is explicitly
ordered by cuttability (§12) and a designated cut scheduled first is not ordered by anything.

Be clear-eyed that cutting it saves almost nothing: it is three lockers and a boolean. If the schedule
genuinely turns, the relief is in **M8** and in shipping **8 modules instead of 10** (§13), not in the
puzzle list. A designated cut you can make in an afternoon is a comfort blanket, not a plan.

**5 · Airlock keyswitch** — *2 players · same module · commitment*

Two keyswitches four metres apart, turned within one second of each other. Loud on activation (45) no
matter how careful you are — place it late. Two booleans with timestamps.

**The pivot forces a choice here that r2 got for free.** The old line was "trivial on the ground; in
zero-G both players must anchor to rails" — and the ground is now the default, so half that sentence
became the whole game. Pick one and mean it. Put it in an **authored `zero` module** and anchoring is
the puzzle: two people committed to rails, unable to look around, counting down over voice. Put it in
a **`nominal` module** and the puzzle is exposure instead: two people standing still in the open, four
metres apart, making 45 in a room the alien is now walking toward. Both are good. The failure is
authoring the zero-G version and then letting the module have a floor, which reduces it to a keypress.

**6 · Undock sequence** — *3 players · 3 modules · the finale*

Three release levers held for five seconds simultaneously. The whole team, split up, counting down
over voice, at loudness 60. The alien is coming and everyone knows it.

Three players and not six, so a half-dead crew can still get out (§10).

### Sequencing

Puzzles 1–4 run in parallel — six players split into two or three groups, each generating noise that
endangers the others. Puzzle 5 needs a pair; puzzle 6 needs the team reassembled. Round shape:
**scatter → reunite → split → converge**, with the director (§5) tightening at every transition.

The **split** is also where the director's first gravity failure lands, at stage 2. That is deliberate
and the two systems were tuned against each other: it is the phase with the most people working alone,
so a dropped floor is most likely to strand somebody who has to solve it by themselves.

Escape condition: four systems online, then the undock sequence, then the capsule.

---

## 12. Build order

Do not skip ahead. In particular, do not network before M4.

| # | Milestone | Done when |
|---|---|---|
| M0 | Vite + three, one grey-box module **with a deck**, PointerLock, three gaits + jump, comfort options | **Walking feels good and the room reads.** Do not proceed until it does |
| M1 | Zero-G: rail graph, buffered grip, charged push-off, catch-vs-crash noise, **the four transitions** | You can cross a gravity module on foot, a zero-G module three ways, and the boundary between them without thinking about it |
| M2 | Station graph, 8–10 modules, hatches, **hide spots**, two-hop culling | You can get lost |
| M3 | Noise system, coalescing, noise ring, tracker, heart rate, dummy patroller | A playtester lowers their real voice |
| M4 | Alien FSM, A*, rail-following (**capsule placeholder**), escalation director, decoys, **gravity failures + hide-spot breach** | Single-player is genuinely scary |
| M5 | Colyseus, 6 players, client authority + interpolation, random spawns | Six people share a station and can't find each other |
| M6 | WebRTC voice + mic calibration + **coturn**, knock codes | The room goes quiet on its own |
| M7a | Puzzles 1, 2 + escape + win/lose | The thesis is playable end to end |
| M7b | Death, spectator cameras, headset channel, medkit revival | Nobody watches a black screen |
| M7c | Puzzles 3, 4, 5 | Feature complete |
| M8 | Alien animation, art, audio and post pass | It's *your* game |

r1 had a single M7 comparable in size to M0–M6 combined; it's now split and ordered by cuttability.
Random spawns moved into M5 — the reunion phase is the first thing you'll want to playtest with real
friends and it's twenty lines on top of working multiplayer.

> **r2 reversal — M0 and M1 swapped subject.** M0's gate used to be "zero-G feels good, do not proceed
> until it does." That gate was correct when zero-G was the entire game and is now aimed at two rooms
> out of ten. **Walking is what M0 has to prove**, because it is what a player does for 90% of a round,
> and a mushy walk is a worse outcome than a mushy float. Zero-G keeps its week — it moves to M1, where
> it now sits next to the four transitions (§4), which is the right place for it: the transitions are
> only testable once both modes exist, and they are where this pivot's new bugs will live.

**Honest calendar: 6–12 months of evenings**, even with everything cut above. The gates are right; the
risk is underestimating M4 and M7.

---

## 13. Known risks

- **Walking feel is the new big unknown**, and it is a less exciting risk than the one it replaced,
  which is the point. A first-person walk on a 1.32 m deck with a 5 cm ceiling margin is easy to get
  subtly wrong — head bob, step height, camera height, stopping distance — and wrong reads as cheap.
  M0, and give yourself permission to spend a week there.
- **The two-mode boundary is where the bugs will be.** Two locomotion regimes is not twice the
  controller, but the four transitions (§4) are a genuinely new class of defect: velocity sampled on
  the wrong side of a contact, a state that survives a module change it should not, a landing that
  reports 0 m/s. Two of the three things this document calls load-bearing — the pre-restitution
  approach-speed capture and the closed-*and*-sealed hatch block — live within a metre of that code
  and must hold in **both** modes. Re-measure them after anything touches the controller.
- **Zero-G feel still matters**, in the two rooms that have it. Sublime or nauseating with little in
  between; the pivot lowered the dose, not the difficulty. M1.
- **The Discord problem** (§7) is the single biggest threat to this being the game you designed, and
  it's social, not technical.
- **Silent-slow play** dominating is what the escalation director exists to prevent. If playtests
  still drag, escalate harder before you add content.
- **Alien locomotion and animation** is the hidden giant (§5). Capsule until M8, and mean it.
- **Motion sickness** is the risk the pivot was mostly *for*, and it is now mostly defused: a round is
  walking on a floor with a fixed horizon. Do not read that as solved. The residual exposure is the
  zero-G rooms, the transitions between them, and head bob — which is exactly why head bob got a slider
  and why that slider may never change emitted noise (§4). Comfort options stay in M0.
- **Six players is a crowd.** The real failure mode isn't bandwidth, it's six people bunched around
  one panel while nothing happens. Parallel puzzles (§11) must be in before the first six-player test
  or that test tells you nothing.
- **Early deaths.** Without revival and a spectator job (§10) the first casualty stops playing.
- **Scope.** 8–10 modules, six puzzles, one alien. The designated cut is the **fuse hunt**, not cargo
  stow (§11) — and if the schedule really turns, the relief is M8 and shipping 8 modules, not the
  puzzle list.
- **Chase geometry is a content risk masquerading as a level-design detail.** The pivot only pays off
  if gravity modules have corners, bays and loops (§2) on a deck 1.32 m wide. Author a station of bare
  tubes with floors added and you have shipped the old chase with extra steps — and you will not find
  out until a playtest, because it will look fine in an editor.
- **Audio occlusion and port-panning are not polish.** If a closed hatch doesn't muffle, or sound
  doesn't arrive from the hatch, players stop believing the model and the tension collapses.

---

## 14. Tuning constants — single source of truth

Live in `shared/constants/`. Import them; never re-type them. **Change one, re-check the set** — the
r1 draft's floor, attenuation and error formula were individually plausible and jointly broken.

```ts
// ─── Propagation ──────────────────────────────────────────────────
ATTENUATION_PER_M   = 1.0
FLOOR               = 2       // physical audibility
HATCH_OPEN          = -3
HATCH_CLOSED        = -25
HATCH_SEALED        = -40

// ─── Attention (see director for PATROL at stage > 0) ───────────────
ATTN_PATROL         = 12
ATTN_SEARCH         = 4
crewScaledStage(stage, living)  // raises thresholds as the crew shrinks:
                                // solo faces PATROL 20 / SEARCH 8, not 12 / 4 (§5)

// ─── Localization ──────────────────────────────────────────────
errorRadius(level)  = clamp((70 - level) / 5, 2, 12)

// ─── Coalescing ─────────────────────────────────────────────────
WINDOW_MS           = 1000
DISCARD_MARGIN      = 15
REPEAT_PENALTY_M    = 3       // per repeat, max +12

// ─── Station frame ───────────────────────────────────────────────────────
STATION_DOWN        = (0, -1, 0)   // frozen. THE global down. Never per-module (§4)
STATION_UP          = (0,  1, 0)   // exact negation, so five subsystems can't each get it wrong
MODULE_LENGTH_M     = 5            // the straight kit piece; every "N modules away" is in these

// ─── Deck geometry — the kit/controller handshake (§2) ────────────────────
DECK_Y_M            = -0.75   // deck offset from centreline, along STATION_DOWN
DECK_HEADROOM_M     = 1.75    // deck to ceiling in a 1.0m-radius tube
DECK_HALF_WIDTH_M   = 0.66    // walkable half-width → 1.32 m of floor

// ─── Gravity and falling ─────────────────────────────────────────────────
STATION_GRAVITY_M_S2  = 9.81  // Earth-normal: every player's fall-time intuition is calibrated here
TERMINAL_VELOCITY_M_S = 6     // == PUSH_MAX, deliberately. 0.61s from rest, over 1.83m
MAX_LEGAL_SPEED_M_S   = 7.0   // §7 anti-teleport bound; hypot(6, 2.4) = 6.46 plus jitter
JUMP_HEIGHT_M         = 0.45  // small, and the smallness IS the mechanic
JUMP_SPEED_M_S        = sqrt(2 * g * h) = 2.9718   // DERIVED, never re-typed
STEP_HEIGHT_M         = 0.4   // coamings, racks, cable runs — no jump input
GROUND_PROBE_M        = 0.35  // shorter than STEP_HEIGHT_M on purpose
GROUND_SNAP_M         = 0.4   // >= GROUND_PROBE_M, or you find ground you refuse to snap to
GROUND_ACCEL_M_S2     = 24    // sprint in 0.1s; mush reads as input lag
GROUND_STOP_HALFLIFE_S = 0.06 // crisp without the dead feel of a hard zero
AIR_CONTROL           = 0.25  // steer a jump, never accelerate out of a fall
BOB_AMPLITUDE_M       = 0.045 // at headBob = 1. NEVER touches loudness

// ─── Collider ────────────────────────────────────────────────────────────
PLAYER_RADIUS          = 0.35  // unchanged; capsule is two spheres of this
PLAYER_STAND_HEIGHT_M  = 1.7   // vs DECK_HEADROOM_M 1.75 — 5cm of margin, and that's all
PLAYER_CROUCH_HEIGHT_M = 1.0
EYE_HEIGHT_STAND_M     = 1.55
EYE_HEIGHT_CROUCH_M    = 0.85
// Collapses to the single §4 swept sphere in zero-G, which is why both hard-won
// sweep fixes carry over unchanged.

// ─── Player — walking. THE RISK DIAL (§4) ────────────────────────────────
//                            crouch / walk / sprint
SPEED_*              = 0.75 / 1.4  / 2.4    // m/s
FOOTSTEP_*           = 4    / 12   / 30     // loudness per step
STRIDE_*_M           = 0.55 / 0.75 / 1.15   // metres per step — DISTANCE, never a timer
LANDING_SOFT_*_MPS   = 3.4  / 1.8  / 1.2    // closing speed absorbed silently
STRIDE_START_FRACTION = 0.5                 // meter starts half-primed
landingNoise(v, gait) = v <= soft(gait) ? footstep(gait)
                                        : max(impactNoise(v), footstep(gait))
// DERIVED, asserted monotone: cadence 1.36 / 1.87 / 2.09 Hz
//                             loudness per metre 7.3 / 16.0 / 26.1

// ─── Transitions between the two modes (§4) ──────────────────────────────
GRAVITY_WARNING_S        = 2.5     // the fairness guarantee. 6.0m at a sprint
GRAVITY_FAIL_DURATION_MS = 90_000  // director failure self-repairs; Infinity = permanent
LIFTOFF_IMPULSE_M_S      = 0.6     // 0 < it < RAIL_SLIDE, asserted
LAUNCH_MIN_SPEED_M_S     = PUSH_MIN = 2    // NOT a new number, and that is the point
transitionNoise(kind, v, gait):
  landing         -> landingNoise(v, gait)
  launch          -> v >= LAUNCH_MIN ? LOUDNESS.PUSH_OFF (8) : 0
  settle, liftoff -> 0
// 0 MEANS EMIT NO EVENT AT ALL, never an event carrying zero (§4)

// ─── Hiding (§4) ─────────────────────────────────────────────────────────
HIDE_MUFFLE_DB          = -8    // negative, ADDED, exactly like a hatch offset
HIDE_SAFE_RADIUS_M      = 3     // DERIVED from the above, not chosen
HIDE_QUIET / HIDE_LOUD  = 8 / 30
HIDE_ENTER_TIME_SLOW/FAST_S = 2.5 / 0.5
HIDE_BREACH_RANGE_M     = 1.2   // contact range, inside one module
HIDE_BREACH_TIME_S      = 2.0   // the window to bail out, loudly
HIDE_SPOT_CAPACITY_DEFAULT = 1
HIDE_SPOTS_MIN          = 6     // ~one per module outside escape and finale

// ─── Player — zero-G. Scoped to `zero` modules (§4) ──────────────────────
RAIL_SLIDE          = 1.2     // m/s
PUSH_MIN / MAX      = 2 / 6   // m/s
CHARGE_TIME         = 1.2     // s
GRAB_RANGE          = 0.8     // m, buffered latch
DRAG_HALFLIFE       = 4.0     // s
catchNoise(v)       = 8 + 3 * v
impactNoise(v)      = 15 + 6 * v

// ─── Alien ──────────────────────────────────────────────────────
SPEED_PATROL        = 1.5     // m/s, > RAIL_SLIDE and > walk, < sprint, by design
SPEED_SEARCH        = 1.2
SPEED_HUNT          = 3.0
HUNT_TRIGGER        = 50      // 35 at director stage 4
SEARCH_DURATION     = 15      // s, 25 at stage 3+
HATCH_OPEN_TIME     = 3.0     // s, loudness 45
ANTICAMP_MS         = rand(60_000, 150_000)

// ─── Round ──────────────────────────────────────────────────────
DECOYS_PER_ROUND    = 2
SEAL_CHARGES        = 2
STAGE_TIMEOUT_MS    = 480_000 // free escalation every 8 min

// ─── Zero-G budget — walking must stay the default (§2, §5) ──────────────
ZERO_G_AUTHORED_MAX  = 2      // of 8–10 modules, enforced in ModuleGraph.validate()
ZERO_G_FRACTION_MAX  = 0.5    // authored + director-dropped, same validator
gravityFailures      = [0, 0, 1, 1, 2]   // by director stage; solo caps at 1

// ─── Loudness table entries added by the pivot (§3) ──────────────────────
FOOTSTEP_CROUCH / WALK / RUN = 4 / 12 / 30   // == RAIL_PULL / == ATTN_PATROL / above everything
LOUDNESS.GRAVITY_SHIFT       = 35   // breaker rung; emitted at the MODULE CENTRE, no actor
LOUDNESS.HIDE_BREACH         = 55   // == ALIEN_HUNT
```

**No pre-pivot value was altered.** Every constant that predates the pivot — propagation, attention,
localization, coalescing, the zero-G player block, the alien, the round — is exactly what r2 shipped.
That is the strongest thing that can be said for this change: it added a mode, it did not retune the
game. The only edit to existing lines was replacing three bare `5`s inside sanity checks with
`MODULE_LENGTH_M`: identical arithmetic, three fewer literals.

### Where the new numbers come from

Most of the rationale lives next to the mechanic — gaits and the jump in §4, the deck in §2, the
failure budget in §5. What follows is the reasoning that belongs to no single section because it is
about how the numbers *hold each other up*:

- **`TERMINAL_VELOCITY_M_S` = `PUSH_MAX` = 6 is a constraint, not a coincidence.** §3's table tops its
  movement tier at "uncontrolled impact, 51 at 6 m/s", and `noiseLoudness` clamps to `PUSH_MAX`. Let a
  fall exceed it and either a routine trip out-shouts a thrown decoy, or the clamp silently flattens it
  and the extra speed does nothing. Raise this and you must raise the clamp *and* re-author the table.
- **`STATION_GRAVITY_M_S2` = 9.81, Earth-normal, in orbit.** A "realistic" station number is the wrong
  call twice over: every player's intuition for how long a fall takes is calibrated on 9.81 (pillar 3),
  and weaker gravity stretches the drop after a `settle` into dead time at the sharpest moment.
- **`FOOTSTEP_*` are pinned to existing constants, not chosen freely.** Crouch 4 **is**
  `LOUDNESS.RAIL_PULL` — the cheapest deliberate movement must cost the same in both regimes, or one
  becomes the free way to be careful. Walk 12 **is** `ATTN_PATROL`, which is what makes a stage-0
  patrol deaf to walking at 1 m (12 − 1 = 11) and alert to it a module away by stage 4. Run 30 clears
  the whole stage × crew grid. Two of the three are equalities; treat them as such.
- **Stride is a distance because a timer is dishonest.** A timer charges the player shuffling against
  a bulkhead the same as the one crossing a module, and charges a stuttered journey twice.
  `STRIDE_START_FRACTION` 0.5 exists so the first step out of a standstill lands where a real first
  step lands rather than a full stride later.
- **The two derived gait tables are the ones that catch mistakes.** Cadence (1.36 / 1.87 / 2.09 Hz)
  must be monotone or a faster gait steps *less* often; loudness-per-metre (7.3 / 16.0 / 26.1) must be
  monotone or crouching is strictly worse than walking for the same ground and nobody ever crouches.
  Both fall out of speed ÷ stride, so both break silently if you tune a stride in isolation.
- **`LAUNCH_MIN_SPEED_M_S` is `PUSH_MIN`, and no new number was needed.** §14 already defined 2 m/s as
  the slowest thing that counts as a push. That a walk (1.4) drifts into zero-G silently and a sprint
  (2.4) pays `PUSH_OFF` is not a rule that was designed; it is a rule that was noticed.
- **`HIDE_SAFE_RADIUS_M` is derived from `HIDE_MUFFLE_DB`, in that order.** −8 dB is sized off the one
  sound a hidden player cannot stop making: breathing at 14 becomes 6, which falls under `ATTN_SEARCH`
  (4) past two metres. Three is that, rounded to a number a player can picture. Change the muffle and
  the radius moves with it — never tune them independently.
- **`MAX_LEGAL_SPEED_M_S` is a netcode constant that the pivot invalidated.** The old ceiling was a
  push-off. The new worst legal case is a terminal fall with full lateral air control, and a server
  still holding the old bound rejects honest players for falling (§7).
- **`ZERO_G_FRACTION_MAX` and `ZERO_G_AUTHORED_MAX` are pinned to each other.** Half of §2's minimum 8
  modules is 4, which is precisely `ZERO_G_AUTHORED_MAX` (2) plus the stage-4 director budget (2).
  The check fails the moment somebody raises one without the other, which is the entire reason it is
  written as an assertion instead of a paragraph.

### Sanity checks these constants must pass

Re-run these whenever you touch the table above. Each one caught a real bug in r1:

1. Every entry in the §3 loudness table exceeds `FLOOR` at zero distance.
2. Knock (15) reaches two modules: `15 − 1.0×10 − 3 = 2` ≥ `FLOOR`. ✓
3. `errorRadius` returns its maximum for some *reachable* arrival level.
4. A full-speed clean catch is quieter than a pry bar: `8 + 3×6 = 26 < 60`. ✓
5. `SPEED_PATROL > RAIL_SLIDE`, and `SPEED_HUNT > PUSH_MAX` is **false** by design — a push-off is
   the only thing that outruns a hunt, and only briefly. ✓
6. Grab window at max speed exceeds human reaction: `GRAB_RANGE / PUSH_MAX = 133ms`, and it's
   buffered anyway. ✓

**Added by the pivot.** These are not prose — `assertConstantsCoherent()` runs all of them and the
build fails if one stops holding. The first four are the ones that decide whether the pivot worked at
all; the rest exist because a locomotion change touches more numbers than it looks like it touches.

7. **Fleeing is a real verb:** `SPEED_SPRINT 2.4 > SPEED_PATROL 1.5`. ✓ Break this and you have
   restored the old game, in which the only answer to the alien was a push-off.
8. **Escape needs geometry:** `SPEED_SPRINT 2.4 < SPEED_HUNT 3.0`. ✓ Break this the other way and a
   chase is a straight line you win by holding a key, which is worse than a chase you lose.
9. **Every footstep is physically audible:** 4, 12, 30 all `> FLOOR` (2) at zero distance. ✓ A gait
   below the floor is a free way to move, and free movement deletes pillar 2 — the same bug r1's
   floor of 10 introduced for the whole quiet tier.
10. **The gaits are ordered in both directions:** speed `0.75 < 1.4 < 2.4` **and** loudness
    `4 < 12 < 30`. ✓ Quiet must always cost speed; there must never be a gait that is both quieter and
    faster than another, in either direction.
11. **The full ladder holds:** crouch 0.75 < `RAIL_SLIDE` 1.2 = `SPEED_SEARCH` 1.2 < walk 1.4 <
    `SPEED_PATROL` 1.5 < sprint 2.4 < `SPEED_HUNT` 3.0 < `PUSH_MAX` 6.0. ✓ A push-off stays the
    fastest thing in the game, so zero-G is still a shortcut and not a punishment.
12. **Loudness per metre is monotone by gait:** 7.3 < 16.0 < 26.1. ✓ Without it, crouching covers
    ground *louder* than walking and the quiet option is a trap.
13. **Cadence is monotone and cannot merge on the wire:** 1.36 < 1.87 < 2.09 Hz, and the shortest
    period (~0.48 s) is an order of magnitude over the 50 ms server tick. ✓ Two footsteps must never
    arrive as one.
14. **Crouching a jump is worth doing:** landing at `JUMP_SPEED` 2.97 sits between
    `LANDING_SOFT_WALK` 1.8 and `LANDING_SOFT_CROUCH` 3.4, so the same jump costs 4 crouched and 33
    sprinting — a saving of more than one walking footstep. ✓
15. **`landingNoise` is monotone non-decreasing in *both* arguments** across 0–6 m/s, and a terminal
    fall always costs more than an ordinary footstep in every gait. ✓ The `max(…, footstep)` floor is
    load-bearing: without it a sprinting landing at 1.3 m/s reports 23, quieter than the 30 the same
    stride already cost.
16. **The two regression pins:** `impactNoise(PUSH_MAX) === 51`, `catchNoise(PUSH_MAX) === 26`, and
    `impactNoise(PUSH_MAX) >= HUNT_TRIGGER`. ✓ These are build-breaking assertions rather than prose
    precisely because they are what the pre-restitution approach-speed capture (§4) exists to deliver.
17. **Falls stay inside the authored table:** `TERMINAL_VELOCITY <= PUSH_MAX`. ✓
18. **The anti-teleport bound admits an honest fall:** `MAX_LEGAL_SPEED 7.0 >= hypot(TERMINAL 6,
    SPEED_SPRINT 2.4) = 6.46`. ✓
19. **The gravity warning is crossable:** `GRAVITY_WARNING_S 2.5 × SPEED_SPRINT 2.4 = 6.0 m >=
    MODULE_LENGTH_M / 2`. ✓ From anywhere in a module you can reach a rail before the floor goes.
20. **A liftoff can never read as a launch:** `0 < LIFTOFF_IMPULSE 0.6 < RAIL_SLIDE 1.2`. ✓
21. **`LAUNCH_MIN_SPEED_M_S === PUSH_MIN`**, with walk 1.4 below it and sprint 2.4 above. ✓ Pinned, so
    it cannot drift into being a second number that means the same thing.
22. **Hiding is not a win button:** `BREATHING_MAX 14 + HIDE_MUFFLE_DB (−8) = 6`, which falls below
    `ATTN_SEARCH` 4 within `HIDE_SAFE_RADIUS_M` 3. ✓ The alien has to be leaning on the locker.
23. **Hiding late cannot be bought:** `HIDE_ENTER_TIME_SLOW_S 2.5 > MODULE_LENGTH_M / SPEED_HUNT`
    (1.67 s). ✓ And `HIDE_QUIET 8 < ATTN_PATROL 12` while `HIDE_LOUD 30 >` a solo patrol's 20, so the
    careful entry is quiet at every crew size and the dive is heard at every crew size.
24. **The footstep anchors are equalities:** `FOOTSTEP_CROUCH === LOUDNESS.RAIL_PULL`,
    `FOOTSTEP_WALK === ATTN_PATROL`, and `FOOTSTEP_RUN` exceeds every PATROL threshold over the whole
    6 × 5 stage-by-crew-size grid. ✓ **Running is always heard. There is no stage at which it isn't.**
25. **The zero-G budget is pinned to itself:** `ZERO_G_AUTHORED_MAX 2 + gravityFailures[4] 2 ===
    ZERO_G_FRACTION_MAX 0.5 × 8`. ✓ Also checked in `ModuleGraph.validate()`, against the real level.
26. **The failure schedule starts empty and only grows:** `gravityFailures[0] === 0`, the row is
    monotone non-decreasing, and the crew-scaled row is never harsher than the stage row. ✓ Fewer
    hands must never mean more zero-G.
27. **A dropped floor always moves the alien:** `LOUDNESS.GRAVITY_SHIFT 35 >=` a solo patrol's 20. ✓
    At every stage and every crew size, a failure is an event on the map rather than weather.
28. **A standing player fits the station:** `PLAYER_STAND_HEIGHT 1.7 < DECK_HEADROOM 1.75`, and
    `GROUND_PROBE 0.35 < STEP_HEIGHT 0.4 <= GROUND_SNAP 0.4 < PLAYER_CROUCH_HEIGHT 1.0`. ✓ The last
    chain is what stops the controller hovering over drops, refusing to snap to ground it just found,
    or clipping a crouched head on a step.
