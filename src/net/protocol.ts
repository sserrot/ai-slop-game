/**
 * The wire protocol, browser side (DESIGN.md §7).
 *
 * MIRROR FILE of `server/net/protocol.ts` — same names, same payloads. It is
 * duplicated rather than shared because importing anything under `server/` into
 * the client bundle would drag Colyseus's Node build in with it, and `shared/`
 * belongs to the foundation. Change one, change the other.
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
// Client → server
// ---------------------------------------------------------------------------

export interface SignalMessage {
  to: PlayerId;
  data: unknown;
}

export interface ReadyMessage {
  name?: string;
}

export interface ClientMessages extends ClientToServerMessages {
  signal: SignalMessage;
  ready: ReadyMessage;
}

export type ClientMessageName = keyof ClientMessages;

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  sessionId: PlayerId;
  tick: number;
  phase: RoundPhase;
  /** The station itself — build your graphs from THIS, not from a local file,
   *  or the two sides propagate noise over different geometry (§3). */
  layout: StationLayout;
  iceServers: IceServerConfig[];
  spawn: { module: ModuleId; pos: Vec3 } | null;
  peers: PlayerId[];
  decoysRemaining: number;
  sealCharges: number;
  serverTimeMs: number;
}

export interface SignalRelayMessage {
  from: PlayerId;
  data: unknown;
}

export interface PeerMessage {
  id: PlayerId;
  initiator: boolean;
}

export interface CorrectionMessage {
  pos: Vec3;
  quat: Quat;
  reason: 'speed' | 'unknown-module' | 'not-alive';
}

export interface InventoryMessage {
  items: ItemKind[];
  decoysRemaining: number;
  sealCharges: number;
}

export interface RevivedMessage {
  id: PlayerId;
  by: PlayerId;
}

export interface EscapedMessage {
  id: PlayerId;
  escaped: number;
}

export interface RoundStartMessage {
  seed: number;
  tick: number;
  startedAtMs: number;
  spawn: { module: ModuleId; pos: Vec3 } | null;
}

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
 * smaller session id makes the offer. The server also sends `initiator` on
 * `peerJoin`; this is here so you can work it out for the peers already in the
 * room when you arrive.
 */
export function isInitiator(self: PlayerId, other: PlayerId): boolean {
  return self < other;
}
