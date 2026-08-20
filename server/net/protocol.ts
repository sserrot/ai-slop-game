/**
 * The wire protocol (DESIGN.md §7).
 *
 * `@shared/types` defines the five continuous-state records and the ephemeral
 * messages the design names. A working room needs a handful more: a join
 * handshake that carries the station layout and the ICE config, the WebRTC
 * signalling relay for the voice mesh, and the small round-management messages
 * (inventory, revival, corrections).
 *
 * MIRROR FILE: `src/net/protocol.ts` declares exactly the same names and
 * payloads for the browser side. shared/ is owned by the foundation and this
 * table is server+client glue, so it is duplicated rather than imported across
 * the client/server boundary — importing server code into the browser bundle
 * would drag Colyseus's Node build in with it. Change one, change the other.
 */

import type {
  ClientToServerMessages,
  ModuleId,
  PlayerId,
  Quat,
  ServerToClientMessages,
  StationLayout,
  Vec3,
} from '@shared/types';

/** Room lifecycle. The round is a phase of the room, not a new room. */
export type RoundPhase = 'LOBBY' | 'RUNNING' | 'ENDED';

/** Things a player can be carrying (§10 medkits, §5 decoys, §11 fuses/card). */
export type ItemKind = 'medkit' | 'decoy' | 'fuse' | 'sequence-card' | 'extinguisher' | 'pry-bar';

/** ICE server entry, shaped for `new RTCPeerConnection({ iceServers })`. */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

// ---------------------------------------------------------------------------
// Client → server (in addition to @shared/types ClientToServerMessages)
// ---------------------------------------------------------------------------

/** WebRTC signalling, relayed verbatim to `to` (§7 voice mesh). */
export interface SignalMessage {
  to: PlayerId;
  data: unknown;
}

/** Sent once the client is loaded and willing to be spawned. */
export interface ReadyMessage {
  name?: string;
}

export interface ClientMessages extends ClientToServerMessages {
  signal: SignalMessage;
  ready: ReadyMessage;
}

export type ClientMessageName = keyof ClientMessages;

// ---------------------------------------------------------------------------
// Server → client (in addition to @shared/types ServerToClientMessages)
// ---------------------------------------------------------------------------

/**
 * First message after join. Carries the station itself: the server generates or
 * loads the layout, so both sides are guaranteed to run their noise propagation
 * over identical geometry (§3 lives in shared/ precisely so they can).
 */
export interface WelcomeMessage {
  sessionId: PlayerId;
  tick: number;
  phase: RoundPhase;
  layout: StationLayout;
  iceServers: IceServerConfig[];
  /** Where the server put you (§10 random spawns). null while in LOBBY. */
  spawn: { module: ModuleId; pos: Vec3 } | null;
  /** Everyone already in the room — dial these for the voice mesh. */
  peers: PlayerId[];
  decoysRemaining: number;
  sealCharges: number;
  /** `Date.now()` on the server when this was sent, for clock offset. */
  serverTimeMs: number;
}

/** A signalling payload from another peer. */
export interface SignalRelayMessage {
  from: PlayerId;
  data: unknown;
}

/**
 * Peer arrived / left. `initiator` is the mesh tie-break: exactly one side of
 * each pair creates the offer, decided by session id ordering so both clients
 * agree without another round trip.
 */
export interface PeerMessage {
  id: PlayerId;
  initiator: boolean;
}

/** The server rejected a transform (§7 speed / teleport sanity check). */
export interface CorrectionMessage {
  pos: Vec3;
  quat: Quat;
  reason: 'speed' | 'unknown-module' | 'not-alive';
}

/** Your carried items changed, plus the two team-wide scarce resources (§5). */
export interface InventoryMessage {
  items: ItemKind[];
  decoysRemaining: number;
  sealCharges: number;
}

/** Someone was brought back with a medkit (§10 revival, v1). */
export interface RevivedMessage {
  id: PlayerId;
  by: PlayerId;
}

/** A player reached the capsule and left the station (§11 escape condition). */
export interface EscapedMessage {
  id: PlayerId;
  escaped: number;
}

/** The round began: everyone has a spawn, the alien is placed (§10). */
export interface RoundStartMessage {
  seed: number;
  tick: number;
  startedAtMs: number;
  spawn: { module: ModuleId; pos: Vec3 } | null;
}

/** Human-readable feedback ("no medkit", "sealed", "systems: 2/4"). */
export interface ToastMessage {
  text: string;
}

export interface ServerMessages extends ServerToClientMessages {
  welcome: WelcomeMessage;
  signal: SignalRelayMessage;
  peerJoin: PeerMessage;
  peerLeave: PeerMessage;
  correction: CorrectionMessage;
  inventory: InventoryMessage;
  revived: RevivedMessage;
  escaped: EscapedMessage;
  roundStart: RoundStartMessage;
  toast: ToastMessage;
}

export type ServerMessageName = keyof ServerMessages;

/**
 * Deterministic mesh tie-break, shared by both sides: the lexicographically
 * smaller session id makes the offer.
 */
export function isInitiator(self: PlayerId, other: PlayerId): boolean {
  return self < other;
}
