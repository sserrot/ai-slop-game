/**
 * Server configuration, read from the environment (DESIGN.md §7).
 *
 * Everything here has a working default so `npm run server` starts with no
 * environment at all. The one thing you SHOULD set before a real playtest is
 * TURN — see the block comment on `iceServers()` below.
 */

import { fileURLToPath } from 'node:url';
import { MAX_PLAYERS, TICK_MS } from '@shared/constants';

function env(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function envIntOrUndefined(name: string): number | undefined {
  const raw = env(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// ICE — STUN and TURN (§1: "coturn (STUN + TURN) — Not optional")
// ---------------------------------------------------------------------------

/** Shape of one entry in an `RTCConfiguration.iceServers` array. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * ICE servers handed to every client in the `welcome` message, which the voice
 * mesh (§7) feeds straight into `new RTCPeerConnection({ iceServers })`.
 *
 * STUN alone is enough for most home routers. It is NOT enough for symmetric
 * NAT, and §1 is blunt about the cost: "One friend behind symmetric NAT
 * otherwise costs you an entire playtest night." Run coturn on any cheap VPS:
 *
 *   sudo apt install coturn
 *   # /etc/turnserver.conf
 *   listening-port=3478
 *   tls-listening-port=5349
 *   fingerprint
 *   lt-cred-mech
 *   user=iss:CHANGE_ME
 *   realm=your.domain
 *   external-ip=<public ip>
 *   min-port=49160
 *   max-port=49200
 *   # open 3478/udp, 3478/tcp, 5349/tcp and 49160-49200/udp on the firewall
 *
 * then start the game server with:
 *
 *   TURN_URLS="turn:your.domain:3478?transport=udp,turns:your.domain:5349"
 *   TURN_USERNAME="iss"
 *   TURN_CREDENTIAL="CHANGE_ME"
 *
 * Long-term credentials are fine among friends. If this ever goes public,
 * switch coturn to `use-auth-secret` and mint short-lived HMAC credentials
 * here, per session — this function is the single place that would change.
 */
export function iceServers(): IceServer[] {
  const servers: IceServer[] = [];

  const stun = envList('STUN_URLS', [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
  ]);
  if (stun.length > 0) servers.push({ urls: stun });

  const turn = envList('TURN_URLS', []);
  if (turn.length > 0) {
    const username = env('TURN_USERNAME');
    const credential = env('TURN_CREDENTIAL');
    const entry: IceServer = { urls: turn };
    if (username !== undefined) entry.username = username;
    if (credential !== undefined) entry.credential = credential;
    servers.push(entry);
  }

  return servers;
}

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** TCP port the Colyseus transport listens on. */
  port: number;
  /** Interface to bind. `0.0.0.0` so friends on the LAN can reach it. */
  host: string;
  /** Simulation step in ms — §7's 20 Hz tick. */
  tickMs: number;
  /** Hard cap per room (§10: six players). */
  maxPlayers: number;
  /** Start the round as soon as the first player joins. Off = wait for a
   *  client to send `interact { targetId: 'round', action: 'start' }`. */
  autoStart: boolean;
  /** Path to an authored StationLayout JSON (§2). Falls back to the built-in
   *  procedural station when unset or unreadable. */
  layoutPath: string | undefined;
  /** Seed for spawns, locker contents and the alien's rolls. 0 = random. */
  seed: number;
  /** Log every noise event the alien hears. Noisy; useful when tuning §3. */
  debugNoise: boolean;
  /** Run the self-contained fallback alien / director / puzzles instead of the
   *  real ones in `server/sim/`. For bisecting, or when one is mid-surgery. */
  useFallbackSims: boolean;
  /**
   * Derive a hide spot from every `locker` prop when the level authors none
   * (§4). On by default: a station with no cover in it has no answer to "it's
   * coming" except "move faster", which is the gap the pivot exists to close.
   * Set `DERIVE_HIDE_SPOTS=0` to play the level exactly as authored.
   */
  deriveHideSpots: boolean;
  /**
   * ms between free escalation stages (§14 `STAGE_TIMEOUT_MS`, 8 min, stretched
   * toward 12 for a small crew). Leave unset for the crew-scaled value; set it
   * to watch a whole round's arc in a minute while tuning. Pinning it disables
   * the crew scaling of the timer, which is why it is undefined by default.
   */
  stageTimeoutMs: number | undefined;
  /**
   * ms after round start before the §5 director may drop its first module's
   * gravity, and ms between failures after that. Undefined uses
   * `GRAVITY_FIRST_FAILURE_DELAY_MS` / `GRAVITY_FAILURE_SPACING_MS`. Both exist
   * because the beat is otherwise a minute of waiting to look at once.
   */
  gravityFirstFailureMs: number | undefined;
  gravitySpacingMs: number | undefined;
}

/**
 * The authored station (§2) that `src/station/` builds its geometry from. Both
 * sides MUST agree about geometry — the client builds from `welcome.layout` —
 * so the server serves this file unless STATION_LAYOUT overrides it. If it is
 * missing, `loadStation()` falls back to the built-in procedural kit.
 */
const DEFAULT_LAYOUT_PATH = fileURLToPath(new URL('../levels/station.json', import.meta.url));

export const config: ServerConfig = {
  port: envInt('PORT', 2567),
  host: env('HOST') ?? '0.0.0.0',
  tickMs: envInt('TICK_MS', TICK_MS),
  maxPlayers: envInt('MAX_PLAYERS', MAX_PLAYERS),
  autoStart: envBool('AUTO_START', true),
  layoutPath: env('STATION_LAYOUT') ?? DEFAULT_LAYOUT_PATH,
  seed: envInt('SEED', 0),
  debugNoise: envBool('DEBUG_NOISE', false),
  useFallbackSims: envBool('USE_FALLBACK_SIMS', false),
  deriveHideSpots: envBool('DERIVE_HIDE_SPOTS', true),
  stageTimeoutMs: envIntOrUndefined('STAGE_TIMEOUT_MS'),
  gravityFirstFailureMs: envIntOrUndefined('GRAVITY_FIRST_FAILURE_MS'),
  gravitySpacingMs: envIntOrUndefined('GRAVITY_SPACING_MS'),
};
