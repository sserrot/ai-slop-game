# ISS — Decision log

**Why this file exists.** `DESIGN.md` r2 carries its own revision history inline, as
`> r1 reversal —` blocks, so the reasoning that produced each number survives. That was right once
and does not scale: by r4 the spec would be more archaeology than specification.

From here, **DESIGN.md describes the current state and this file remembers why.** When a decision
changes the spec, edit DESIGN.md to read as though it was always that way, and add an entry here.

Status — `ACCEPTED` in force · `SUPERSEDED by D-NN` · `OPEN` decided but unproven · `REVISIT` a
trigger has been named

---

## Inherited from the r1 → r2 review pass

These predate this log. Full reasoning lives in the cited DESIGN.md sections; recorded here so the
index is complete.

| ID | Decision | § | Status |
|---|---|---|---|
| D-01 | No server-side physics. Nearest player is authority for a cargo bag; server relays | §1 | `ACCEPTED` |
| D-02 | No prediction, reconciliation or rollback. Clients own their movement outright | §7 | `ACCEPTED` |
| D-03 | No anti-cheat. Alien transform synced to all; tracker computed client-side | §7 | `ACCEPTED` |
| D-04 | Linear sound falloff, not inverse-square — legibility beats realism | §3 | `ACCEPTED` |
| D-05 | Hatch constants are **negative** dB offsets and are added, never subtracted | §3, §14 | `ACCEPTED` |
| D-06 | Margin-based coalescing discard plus per-module diminishing returns | §3 | `ACCEPTED` |
| D-07 | A clean catch and a crash are two different loudness formulas | §4 | `ACCEPTED` |
| D-08 | Buffered grip latching, not tap-to-grab on arrival | §4 | `ACCEPTED` |
| D-09 | The escalation director: a stage per system online, plus a free stage every 8 minutes | §5 | `ACCEPTED` |
| D-10 | The alien is a capsule until M8 | §5, §9 | `ACCEPTED` |
| D-11 | Revival is carrying a medkit to the body, not the body to medical | §10 | `ACCEPTED` |
| D-12 | Escaping with three of six is a win, and the results screen says so | §10 | `ACCEPTED` |
| D-13 | Every puzzle has a loud-fast path and a quiet-slow path | §11 | `ACCEPTED` |
| D-14 | Puzzle panels are `CanvasTexture`, not a second rendered 3D scene | §6 | `ACCEPTED` |
| D-15 | Cross-module sound is panned at the hatch it came through, not along true bearing | §8 | `ACCEPTED` |
| D-16 | Two-hop portal culling, not one | §2 | `ACCEPTED` |
| D-17 | The coolant valve's knock-code solution stays unpatched | §11·2 | `ACCEPTED` |
| D-18 | Comfort options ship in M0, not as a later pass | §4 | `ACCEPTED` |
| D-19 | Scope ceiling: 8–10 modules, six puzzles, one alien | §2, §10 | `REVISIT` — only downward |

---

## Open decisions

Decided, in force, but resting on an assumption a playtest has not yet confirmed. Each names the
observation that would reopen it.

### D-20 · The Discord contract is stated, not enforced

**Status** `OPEN` · **§7** · relates to `PLAYTEST.md` H3

We cannot detect an out-of-band voice call and cannot engineer around one. So we state the contract
in the menu the way we state the alien's rules, and we ship the spectator headset channel
specifically so the dead have an in-game reason to keep talking.

**Reopen if:** the first six-player session shows the group in Discord anyway. There is no technical
fix waiting behind this — the response would be design-level, most likely making the in-game channel
strictly better than Discord rather than merely legitimate.

### D-21 · Ambient hum per director stage is held back

**Status** `OPEN` · **§5**, optional lever · `BACKLOG.md` W-01

Raising the audibility floor by +2 per stage would make movement marginally safer as the alien gets
sharper — a nice inversion. Not shipped, because it is a second escalation axis on top of an
untested first one.

**Reopen if:** `PLAYTEST.md` H4 fails and rounds still drag after the existing director is tuned.

### D-22 · Jammed lockers default to a 0% chance

**Status** `OPEN` · **§11·4** · `BACKLOG.md` B-03

The pry/pump paths exist in the puzzle host, but a jammed locker is unopenable until the client sends
`pry` or `pump`, and an unopenable fuse is an unwinnable round. Safer to ship the flavour off.

**Reopen if:** the client path is proven end to end. Then raise the rate deliberately and log it.

### D-23 · A doorway outranks whatever is parked beside it

**Status** `ACCEPTED` · **§2**, **§4** · `src/station/deckKit.ts`, `src/station/walkable.ts`

A standing body does not fit through the 0.7 m circle this kit was drawn around, so a linked port is
cut down to a doorway: ±0.42 m wide, 0.96 m over the axis, sill at the deck. That slot is now the
narrowest thing in the station and the only piece of geometry a player cannot route around — and the
cupola proved it, with an equipment bay whose inner face stood 0.24 m off the port axis for the full
depth of the collar. Nobody could leave the module, and the walkability validator was happy: the
deck came within 2 cm of the hatch, which is a question about the floor, not about the hole.

Fittings yield to the doorway and never the reverse. `bayHalfWidthBesidePort()` sizes a deck bay
from what the doorway leaves rather than from the deck alone, the cupola's bay gives up 0.18 m of
width and takes it back in depth at the same 0.42 m³, and `walkable.ts` plants a standing collider
in every linked doorway and one step inboard so `buildLevel` refuses a station that does it again.
Widening `DOORWAY_HALF_W` was the alternative and was rejected: 7 cm a side is already generous
against a 0.35 m body, and every centimetre past that comes out of a bulkhead ring that five kit
pieces share.

The cost is real and lands on the hide spots. The cupola's is 0.42 m wide rather than 0.60 — you
back into it rather than step in — and narrow-bore pieces will keep paying: the lab's 1.4 m bore
fits a default bay beside a doorway with 2 mm to spare, and there is nothing under it that does.

**Reopen if:** a kit piece under a 1.25 m bore needs a hide spot, or playtest reports the cupola bay
reads as a cupboard rather than as cover.

---

## Adding an entry

```
### D-NN · <the decision, as a statement>

**Status** `ACCEPTED` · **§N** · relates to <BACKLOG id / PLAYTEST hypothesis>

<Context: what forced a choice.>
<Decision: what we do, and what we explicitly do not do.>
<Consequence: what this costs us, stated honestly.>

**Reopen if:** <the specific observation that would change this.>
```

Two rules. **Name the consequence**, not just the upside — D-03 costs us a public release without
rework, and saying so is what makes the decision reviewable. And **name a reopen trigger**, or the
entry is an opinion rather than a decision.
