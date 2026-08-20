/**
 * `npm run server` — the ISS game server (DESIGN.md §7).
 *
 * One Colyseus room type, 'station', at 20 Hz. It also serves two plain HTTP
 * endpoints on the same port so you can tell from a browser that it is alive:
 *
 *   GET /health   → {"ok":true,...}
 *   GET /ice      → the ICE server list clients get in `welcome` (§7 voice)
 *
 * Environment (all optional, see `config.ts`):
 *   PORT, HOST, TICK_MS, MAX_PLAYERS, AUTO_START, SEED, DEBUG_NOISE,
 *   STATION_LAYOUT, STUN_URLS, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { TICK_HZ } from '@shared/constants';
import { config, iceServers } from './config';
import { StationRoom } from './rooms/StationRoom';

/** Room name clients pass to `client.joinOrCreate('station')`. */
export const ROOM_NAME = 'station';

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // The client is served by Vite on another origin during development.
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

// Colyseus attaches its own `/matchmake/*` handler in front of these listeners
// (it preserves the ones already registered), so plain routes keep working.
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  if (url.startsWith('/health')) {
    json(res, 200, {
      ok: true,
      room: ROOM_NAME,
      tickHz: TICK_HZ,
      maxPlayers: config.maxPlayers,
      uptimeS: Math.round(process.uptime()),
    });
    return;
  }
  if (url.startsWith('/ice')) {
    json(res, 200, { iceServers: iceServers() });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  // A room that empties out disposes itself; nothing here needs to survive it.
  greet: false,
});

gameServer.define(ROOM_NAME, StationRoom);

async function main(): Promise<void> {
  await gameServer.listen(config.port, config.host);
  const ice = iceServers();
  const hasTurn = ice.some((entry) => entry.urls.some((u) => u.startsWith('turn')));
  console.log(`[server] ISS station server on ws://${config.host}:${config.port}`);
  console.log(`[server] room '${ROOM_NAME}', ${TICK_HZ} Hz, up to ${config.maxPlayers} players`);
  console.log(
    hasTurn
      ? '[server] TURN configured — symmetric NAT is covered'
      : '[server] STUN only. Set TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL before a real ' +
          'playtest: §1 is blunt that one friend behind symmetric NAT costs the whole night',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[server] ${signal} — shutting down`);
    void gameServer.gracefullyShutdown();
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
