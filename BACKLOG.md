# ISS — Backlog

Sized, triaged work. One row per thing. `ROADMAP.md` says *when*; this says *what and how big*.

Sizes are evenings, because that is the unit this project is actually built in
(`DESIGN.md` §12: "6–12 months of evenings").

Priority — `P0` blocks the next release · `P1` wanted for it · `P2` after · `WONT` decided against.

---

## Open

| ID | Item | § | Size | Pri | Notes |
|---|---|---|---|---|---|
| B-01 | **Wire cargo bag physics.** `src/puzzles/cargoPhysics.ts` exists but is not constructed in `main.ts`, and the protocol has no per-bag ownership relay. Puzzle 3 is currently unfinishable | §11·3, §1 | 3–5 | P0 | The designated cut. Owner-simulates, server relays — do **not** add server-side physics |
| B-02 | **Spectator module cameras.** Bodies persist and the headset channel works; flying a free camera between module cams does not exist | §10 | 2–3 | P1 | Cameras show modules and players, **never** the alien |
| B-03 | **Enable jammed lockers.** Implemented in the puzzle host, hard-defaulted to 0% because an unopenable fuse is an unwinnable round | §11·4 | 1 | P1 | Needs the client `pry`/`pump` path proven first, then raise the rate |
| B-04 | **Deploy coturn and verify against a hostile NAT.** Server already reads `STUN_URLS` / `TURN_URLS` / credentials and ships them in `welcome` | §7 | 1–2 | P0 | Non-optional. One symmetric NAT costs a whole playtest night |
| B-05 | **Run the first real six-player session.** Six humans, six networks, one round | §10, §13 | 1 | P0 | Blocked on B-04. Protocol in `PLAYTEST.md` |
| B-06 | **Validate mic calibration across real hardware.** Calibration ships; it has only met this machine's microphone | §7 | 1 | P0 | Raw RMS variance is the failure mode — one hot mic sits at loudness 55 while breathing |
| B-07 | **Alien rail-FOLLOWING.** The IK itself is done (`src/alien/ik.ts`): all four limbs solve to authored contacts, and the stance travel is derived from the measured speed so contacts cannot slide at any speed. What is left is the server choosing a path along the §2 rail graph for the hands to follow, instead of the fixed handhold line the view assumes | §5, M8 | 4–6 | P2 | Re-sized down from 15+. Most of that estimate was the IK, and the IK was a triangle |
| B-08 | **Art pass.** The station is still boxes and cylinders. The ALIEN is no longer a debt: 972 tris, eight instanced draw calls, IK, morph targets, its own skin shader | §9, M8 | 16+ | P2 | Whoever takes this decides FIRST whether a sculpted GLB replaces the procedural alien or only the station. It would replace it — a baked clip brings its own animation, so the IK, the spine wave, the springs and the morphs are all discarded with the cylinders. Loading one needs no new dependency (three ships `GLTFLoader`); it needs a rig, clips per §5 state, root motion baked out, and a measured stride per clip or the thing skates. Kenney / Quaternius (CC0), Poly Haven, NASA ISS models as reference — decimate hard |
| B-09 | **Sound design pass.** Every noise is currently synthesised from oscillators and filtered noise | §8, M8 | 8+ | P2 | It reads correctly; it is not *scored*. The routing underneath it is done |
| B-10 | **Rebinding UI.** `KEYMAP` in `src/player/keymap.ts` is one object; mutate it and call `player.input.refreshBindings()` | — | 1 | P2 | Cut candidate #4 |

## Watch list — not work yet, but will be

| ID | Item | Trigger to act |
|---|---|---|
| W-01 | Ambient hum raising the audibility floor per director stage | Only if playtests show rounds still dragging after the director is tuned (§5, optional lever) |
| W-02 | Hauling bodies instead of carrying a medkit to them | Only if the game earns it in polish. Physics + animation + networking all at once (§10) |
| W-03 | Voice mesh bandwidth at six players | If it bites, cull gain at **two** hops, not one — never tear down and rebuild peers (§7) |
| W-04 | Station growing past 10 modules | Resist. Six people in a big station never rejoin; the noise floor never rises (§2) |

## Decided against

| ID | Item | Why |
|---|---|---|
| B-N1 | Anti-cheat | Among friends this is a social problem, not an engineering one. Alien transform is synced to everyone; read it through `getAlienForClient()` if that ever changes (§7) |
| B-N2 | Server-side physics | Died when the player controller became a hand-rolled kinematic controller. Five cargo bags do not justify WASM Rapier in Node (§1) |
| B-N3 | Prediction / reconciliation / rollback | Clients own their movement outright. Momentum-based zero-G is the easy case for client authority (§7) |
| B-N4 | A second alien | Two would make the tracker pulse ambiguous and destroy the shared mental model (§10) |
| B-N5 | A full ECS | Not earned at this scale (§1) |
| B-N6 | Physics ragdoll for the alien's tail (Rapier is already a dependency) | Tempting, and wrong for this creature specifically. A physics tail is **not deterministic across clients** — it integrates against each machine's frame timing — so two players looking at the same monster would see different tails. That is the exact property `scanBearing()` gives up randomness to preserve, and §10's shared mental model depends on it: people call out what the thing is doing over proximity voice. The spring in `alienView.ts` is deterministic, costs no solver, and already overshoots. Revisit only if the tail ever needs to collide with the station, which it does not |

---

## Adding a row

Give it an ID, cite the DESIGN.md section it serves, and size it in evenings. **If it doesn't serve
one of the three pillars, it doesn't get a row** — that rule has already removed rollback netcode, a
sanity meter and a stamina bar, and it is the only thing keeping this project shippable.
