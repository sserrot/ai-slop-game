# ISS — Roadmap

**What this file is for.** `DESIGN.md` §12 fixes the *build order* and never changes. This file
tracks *where we actually are* against it, and it is expected to change every week. If the two ever
disagree about what is built, this file wins; if they disagree about what should be built next,
DESIGN.md wins.

Last reviewed: **2026-08-19**

Legend — `SHIPPED` gate met and playable · `PARTIAL` builds and runs, gate not met ·
`OPEN` not started · `CUT` deliberately not doing (see `DECISIONS.md`)

---

## Now

The engineering risk of M0–M7 is behind us. The two things blocking a confident "this game works"
are both empirical, not technical:

1. **A real six-player playtest over real network conditions**, with coturn deployed. Every gate
   from M5 onward has been exercised against a live server but not against six humans and six NATs.
   `DESIGN.md` §7 is blunt that one friend behind symmetric NAT costs the entire evening.
2. **Confirming the round actually lands at 20–25 minutes** and that silent-slow play does not
   dominate. The escalation director exists solely to prevent this and has never been observed under
   load. See `PLAYTEST.md` H4 and H5.

Everything else is downstream of what those two tell us.

## Next

- Wire the cargo bag physics (`src/puzzles/cargoPhysics.ts`) into `main.ts` with a per-bag ownership
  relay — the last unfinishable puzzle, and the designated cut if the schedule turns (`BACKLOG.md` B-01).
- Spectator module cameras, so the dead have something to look at as well as something to say (B-02).
- Turn jammed lockers on above 0% once the pry/pump client path is proven (B-03).

## Later

- **M8** in full: alien animation, art pass, real sound design. Deliberately last. Do not start on
  animation before the game underneath it is proven fun (`DESIGN.md` §5, §9).
- Anything from the playtest log that is a *pacing* fix. Escalate harder before adding content.

---

## Milestone board

| # | Milestone | Gate — "done when" | Status |
|---|---|---|---|
| M0 | Zero-G feel, comfort options | Zero-G feels good | `SHIPPED` |
| M1 | Rail graph, buffered grip, catch-vs-crash | Three ways across a module at three real risk levels | `SHIPPED` |
| M2 | Station graph, hatches, two-hop culling | You can get lost | `SHIPPED` — 9 modules authored |
| M3 | Noise, coalescing, tracker, heart rate | A playtester lowers their real voice | `SHIPPED` (built) / gate **unverified** — see H2 |
| M4 | Alien FSM, A*, escalation director, decoys | Single-player is genuinely scary | `SHIPPED` (built) / gate **unverified** |
| M5 | Colyseus, 6 players, spawns | Six people share a station and can't find each other | `SHIPPED` (built) / gate **unverified** — no 6-player session yet |
| M6 | WebRTC voice, mic calibration, coturn | The room goes quiet on its own | `PARTIAL` — mesh works, **coturn not deployed** |
| M7a | Puzzles 1, 2, 4 + escape + win/lose | The thesis is playable end to end | `SHIPPED` |
| M7b | Death, spectator channel, medkit revival | Nobody watches a black screen | `PARTIAL` — headset channel in, **module cameras not built** |
| M7c | Puzzles 3, 5 | Feature complete | `PARTIAL` — puzzle 5 in, **puzzle 3 has no physics bags** |
| M8 | Animation, art, audio and post pass | It's *your* game | `OPEN` |

**Read the "built vs gate met" distinction carefully.** Six milestones are coded and wired but their
gates are subjective observations that require a human in the chair. Marking those SHIPPED on code
completeness alone is exactly how a project convinces itself it is further along than it is. The
gates are tracked as hypotheses in `PLAYTEST.md`.

---

## Release definition

**"Playable with friends"** — the only milestone that matters before M8:

- [x] All six puzzles exist server-side
- [ ] All six puzzles are *completable* by a client (blocked on B-01)
- [ ] coturn deployed and a session survives a hostile NAT (B-04)
- [ ] One full six-player round completed end to end by real humans
- [ ] Round length observed in the 20–25 minute band across three sessions
- [ ] No player drops out to motion sickness with comfort options on

Nothing on this list is art. That is deliberate.

---

## Standing cut list, in the order things get cut

Written down *now*, while nothing is on fire, so the decision is not made under schedule pressure.

1. **Cargo stow (puzzle 3)** — named the designated cut in `DESIGN.md` §11. The escape needs four of
   five gated systems, so a round is winnable without it. Cutting it also removes the only reason
   Rapier is in the build at all.
2. **Spectator module cameras** — the headset channel is the load-bearing half of the spectator job;
   the cameras are the nice half.
3. **Jammed lockers** — pure flavour on top of the fuse hunt.
4. **Rebinding UI** — `KEYMAP` is one object; power users can edit it.

Things that are **never** cut, no matter what: comfort options (§4), mic calibration (§7), audio
occlusion and port-panning (§8, §13). Each one is load-bearing for a pillar.

---

See also — `BACKLOG.md` (what, sized) · `PLAYTEST.md` (what we still don't know) ·
`DECISIONS.md` (why it is the way it is) · `DESIGN.md` (the spec).
