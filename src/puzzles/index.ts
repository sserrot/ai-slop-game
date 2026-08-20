/**
 * src/puzzles — the six puzzles (DESIGN.md §11).
 *
 *   1 breaker sequence   1 player    · teaches the whole game
 *   2 coolant valve      2 players   · 2 modules · the thesis puzzle
 *   3 cargo stow         1–2 players · dexterity, client-authoritative physics
 *   4 fuse hunt          any number  · pure traversal
 *   5 airlock keyswitch  2 players   · same module · commitment
 *   6 undock sequence    3 players   · 3 modules · the finale
 *
 * Every one of them obeys the hard rule: A LOUD-FAST PATH AND A QUIET-SLOW PATH.
 * That rule is what keeps the noise system relevant after the map is learned,
 * and the escalation director (§5) is what stops the quiet path from being free.
 *
 * LAYERS
 *   `./logic`         isomorphic state machines + the escape condition. The
 *                     server imports this and only this.
 *   `./store`         client mirror of the server's `puzzle` messages.
 *   `./interactor`    client → server intents, including hold heartbeats.
 *   `./panels`        the 2D canvas drawings, bound to the UI agent's Panel API.
 *   `./cargoPhysics`  Rapier bags, owner-simulates, dynamically imported.
 *   `./cargo`         puzzle 3 assembled: the rack read out of the layout, the
 *                     bags rendered and carried, `stow` reported to the server.
 *
 * The client never runs `interact()` or `tick()` locally. Puzzle state is
 * server-authoritative and there is no prediction anywhere in this project (§7).
 */

export * from './logic/index';
export * from './types';
export * from './store';
export * from './interactor';
export * from './panels';
export * from './cargoPhysics';
export * from './cargo';
