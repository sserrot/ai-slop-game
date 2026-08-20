/**
 * src/net — Colyseus client, typed messages, interpolation (DESIGN.md §7).
 *
 *     import { net } from './net';
 *
 *     const welcome = await net.connect();      // layout + ICE config + spawn
 *     ticker.onFixed(() => {
 *       net.update();                           // pull state, publish on the bus
 *       net.sendTransform(myTransform);         // you own your movement (§7)
 *     });
 *     ticker.onRender(() => {
 *       for (const body of net.remoteBodies()) drawPlayer(body);
 *       const alien = net.alien();              // interpolated, never predicted
 *     });
 *
 * Both of those render-rate reads hand back objects the client OWNS and refills
 * every call — vectors included. Draw from them inside the loop; copy anything
 * you mean to keep. `players()` and `snapshot()` still return fresh data.
 */

export * from './protocol';
export * from './interpolation';
export * from './connection';
