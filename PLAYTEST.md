# ISS — Playtest protocol and log

**Why this file exists.** Almost every milestone gate in `DESIGN.md` §12 is a *subjective
observation*, not a passing test: "zero-G feels good", "a playtester lowers their real voice", "the
room goes quiet on its own". Code completeness cannot satisfy any of them. And §14's constants can
only be validated by watching people play — the r1 draft's floor, attenuation and error formula were
each individually plausible and jointly broken, and only arithmetic caught it. Next time it will be
people.

---

## Standing rules

1. **Do not explain the game.** State only what the menu states: the alien has no eyes, it hunts by
   sound, and the game is played un-muted. If a player needs more than that, the noise ring has
   failed and *that* is the finding.
2. **Record the round length.** Every round. It is the single cheapest signal about whether the
   escalation director is working.
3. **Watch the voices, not the screen.** The thing you are measuring in M3 and M6 is whether people
   lower their real voices without being told.
4. **Never fix a number mid-session.** Log it, finish the session, change one constant, re-check the
   whole set (§14), then run again.
5. **Ask one question at the end**, not a survey: *when were you most afraid?* Everything else is
   observation.

---

## Open hypotheses

These are the actual unknowns. Each one, when resolved, unblocks a gate in `ROADMAP.md`.

| ID | Hypothesis | Gate it unblocks | Status |
|---|---|---|---|
| H1 | With comfort options on, no player quits to motion sickness | M0 | **Untested at scale** — one machine only |
| H2 | Players lower their real voice unprompted, within one round | M3 | **Untested** |
| H3 | The group stays in the game's voice channel and does not route around it via Discord | M6 | **Untested — the biggest threat in the project** (§7, §13) |
| H4 | Rounds land in the 20–25 minute band | §5 director | **Untested** |
| H5 | Silent-slow play does not dominate; teams take loud-fast paths under pressure | §11 hard rule | **Untested** |
| H6 | Six players split across parallel puzzles instead of bunching at one panel | §13 | **Untested** |
| H7 | Mic calibration absorbs real hardware variance — nobody breathes at loudness 55 | §7 | **Untested** |
| H8 | Players build a correct model of the alien's hearing within one round | Pillar 3 | **Untested** |
| H9 | The knock-code protocol emerges without prompting | §10 | **Untested** |
| H10 | Early deaths do not end a player's session — spectators stay engaged | §10 | **Untested** |

**H3 is the one to watch first.** It cannot be detected or engineered around, and if the group routes
around voice, four separate systems (the reunion phase, knock codes, the coolant valve, the spectator
headset) stop being the game we designed. Test it in the very first six-player session, not after
polish.

---

## Session template

Copy this block per session. Keep them all — the value is in the sequence, not any one entry.

```
### Session NN — YYYY-MM-DD

Players:            n
Build:              <commit / date>
Constants changed since last session: <none | list>

Rounds:
  1.  length __:__   escaped _/_   first death at __:__   cause ________
  2.  length __:__   escaped _/_   first death at __:__   cause ________

Hypotheses touched:  H_, H_
Observations:
  -
Voice: did anyone lower their real voice unprompted?      yes / no
Discord: did the group stay in-game?                       yes / no
Bunching: worst moment of everyone-in-one-module           __:__
"When were you most afraid?"
  -
Actions taken:       (constant changes, backlog rows added)
```

---

## Log

*No sessions recorded yet. The first entry should be the first six-player round —
see `BACKLOG.md` B-05, blocked on coturn (B-04).*

---

## Constant change log

Every change to `shared/constants/` (`DESIGN.md` §14) lands here with the evidence that motivated it.
**Change one, re-check the set** — and re-run §14's six sanity checks before committing.

| Date | Constant | From | To | Evidence | Sanity checks re-run |
|---|---|---|---|---|---|
| r1 → r2 | `ATTENUATION_PER_M` | 2.0 | 1.0 | Arithmetic: a knock specified as carrying two modules died at 2.5 m | yes |
| r1 → r2 | `FLOOR` | 10 | 2 | The floor sat above the entire quiet tier, giving quiet actions a noise cost of zero | yes |
| r1 → r2 | tracker beep | 12 | 20 | At 12 it propagated ~1 m, making mute a free action | yes |
| r1 → r2 | `errorRadius` | `clamp(20-level,0,12)` | `clamp((70-level)/5,2,12)` | Old formula returned 0 error for almost every real arrival | yes |
| r1 → r2 | `PUSH_MAX` | 9 | 6 | At 9 m/s the grab window was 89 ms, beneath human reaction time | yes |
| r1 → r2 | catch noise | `impactNoise` | `8 + 3v` | A perfect 9 m/s catch was louder than a pry bar; there was no quiet way to be fast | yes |
| r1 → r2 | `ANTICAMP_MS` | flat 90 s | `rand(60s, 150s)` | A flat disclosed timer was a *guaranteed* escape valve — freezing became provably safe | yes |

*Everything above predates the first playtest and came from a review pass. Every row below this line
should cite an observation instead.*
