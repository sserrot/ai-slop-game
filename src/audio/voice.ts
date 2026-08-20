/**
 * Proximity voice (DESIGN.md §7).
 *
 * A `simple-peer` mesh: six players, fifteen connections, and **every peer stays
 * connected for the whole round**. Proximity gates *gain*, never the connection
 * — §7 is explicit that renegotiating as people drift apart "would clip the
 * first moment of every reunion, which is precisely the moment this game is
 * about."
 *
 * Voice is not a special case in the noise model. A peer's stream runs through
 * the same chain everything else does — gain from the §3 arrival level, a
 * 400 Hz lowpass when a closed hatch is in the way, and a panner **at the port
 * the sound arrives through** (§8). Someone shouting for you two modules away
 * genuinely sounds like it is coming from the hatch, which is the whole reunion
 * phase in one sentence.
 *
 * Mic calibration is mandatory and lives in `calibration.ts`.
 *
 * ORDERING IS NOT THE CALLER'S PROBLEM. `addPeer`, `start()` and an incoming
 * offer can arrive in any order, on either side, and the mesh converges anyway:
 *
 *   - signalling is subscribed the moment it is supplied, not when the mic
 *     opens, so an offer sent while you are still in the menu is not lost;
 *   - a peer added before the mic exists stays in the map and is reconciled by
 *     `start()`, by `addPeer` being called again, by an incoming signal, and by
 *     a slow sweep in `update()`;
 *   - a signal that arrives before its RTCPeerConnection exists is buffered on
 *     the PeerVoice and flushed in order once it does.
 *
 * The previous version bailed out of `openConnection` on a missing stream after
 * `addPeer` had already inserted the peer, and nothing ever revisited it: in a
 * two-tab test the second tab was mute in both directions unless you happened to
 * press Start before your friend joined.
 *
 * WIRING: the integrator supplies signalling over the Colyseus room — see
 * `VoiceSignalling` below. It is four methods.
 */

import { VOICE_LEVEL_HZ, LOUDNESS, clamp, voiceNoise } from '@shared/constants';
import type { ModuleId, Vec3, VoiceLevelMessage } from '@shared/types';
import { cloneV3, distance, v3 } from '@shared/graph/math';

import type { Unsubscribe } from '../core/eventBus';
import type { NoiseRuntime } from '../noise/runtime';
import {
  DEFAULT_CALIBRATION,
  LevelFollower,
  analyserRms,
  calibratedLevel,
  calibrateMic,
  loadCalibration,
  type CalibrationOptions,
  type CalibrationResult,
  type MicCalibration,
} from './calibration';
import type { AudioEngine } from './engine';
import { occlusionCutoffHz, ramp, relativeGain, setNow } from './levels';
import { setPannerPosition } from './pannerPool';

// simple-peer types come from @types/simple-peer; the module itself is loaded
// dynamically so its readable-stream dependency stays out of the first chunk.
import type { Instance as PeerInstance, Options as PeerOptions } from 'simple-peer';

export type PeerId = string;

/**
 * The narrow interface this module needs from `src/net`. Signalling rides the
 * Colyseus room: one relay message type carrying an opaque blob to one peer.
 */
export interface VoiceSignalling {
  /** Our own session id. Also decides who initiates (lexicographically lower). */
  readonly localId: PeerId;
  /** Relay `signal` to `to`, verbatim. */
  send(to: PeerId, signal: unknown): void;
  /** Called when a relayed signal arrives from another peer. */
  onSignal(handler: (from: PeerId, signal: unknown) => void): Unsubscribe;
  /** Called when a player joins the room. */
  onPeerJoin(handler: (id: PeerId) => void): Unsubscribe;
  /** Called when a player leaves. */
  onPeerLeave(handler: (id: PeerId) => void): Unsubscribe;
  /** Peers already present at connect time. */
  peers?(): readonly PeerId[];
}

/** The other half: `voiceLevel` at 10 Hz, which the server turns into a
 *  NoiseEvent (§7). */
export interface VoiceLevelSink {
  sendVoiceLevel(msg: VoiceLevelMessage): void;
}

/** Proximity voice, or the spectator headset channel (§10). */
export type VoiceChannel = 'proximity' | 'headset';

export interface VoiceMeshOptions {
  signalling?: VoiceSignalling | null;
  net?: VoiceLevelSink | null;
  /** Used to resolve every peer through the §3 graph. Strongly recommended. */
  runtime?: NoiseRuntime | null;
  /** coturn (§1: "**Not optional.**"). */
  iceServers?: RTCIceServer[];
  /** Start in push-to-talk mode. */
  pushToTalk?: boolean;
  /** Level send rate. Defaults to VOICE_LEVEL_HZ (10). */
  levelHz?: number;
  /** getUserMedia constraints. AGC stays ON: §7 offers calibration OR post-AGC
   *  RMS, and doing both is more stable than either. */
  audioConstraints?: MediaTrackConstraints;
  /** Called at the level send rate with the calibrated 0–1 level and the §14
   *  loudness it maps to. Wire it to the noise ring (§6). */
  onLevel?: (level01: number, loudness: number) => void;
  /** Called whenever a peer connects or drops, for the UI. */
  onPeerState?: (id: PeerId, connected: boolean) => void;
}

interface PeerPlacement {
  pos: Vec3;
  module: ModuleId;
  /** Their calibrated speaking level, if the server relays it. */
  level01: number;
}

const RECONNECT_DELAY_MS = 1500;
const PEER_REFRESH_S = 0.1;
/**
 * Seconds between reconciliation sweeps. Peers can be added before the mic
 * exists, before `simple-peer` has finished loading, or before signalling
 * arrives; the sweep is what makes every one of those orderings converge on the
 * same state instead of leaving somebody permanently mute.
 */
const PEER_RECONCILE_S = 2;
/** Signals buffered for a peer whose RTCPeerConnection does not exist yet. */
const MAX_PENDING_SIGNALS = 64;

/** One remote player's audio path. Built once, kept for the whole round. */
class PeerVoice {
  readonly id: PeerId;
  peer: PeerInstance | null = null;
  /** True while `openConnection` is awaiting the dynamic `simple-peer` import. */
  opening = false;
  channel: VoiceChannel = 'proximity';
  placement: PeerPlacement;

  /**
   * Offers and ICE candidates that arrived before there was anything to give
   * them to. Dropping these is the difference between "voice works" and "the
   * tab that joined first is mute in both directions": the offer IS the thing
   * that makes us the answerer.
   */
  private pendingSignals: unknown[] = [];

  private readonly engine: AudioEngine;
  private readonly gain: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly panner: PannerNode;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: HTMLAudioElement | null = null;
  private connected = false;

  constructor(engine: AudioEngine, id: PeerId) {
    this.engine = engine;
    this.id = id;
    this.placement = { pos: v3(), module: '', level01: 0.55 };

    const ctx = engine.ctx;
    const now = ctx.currentTime;

    this.gain = ctx.createGain();
    setNow(this.gain.gain, 0, now);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.7;
    setNow(this.filter.frequency, occlusionCutoffHz(false), now);

    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 1;
    // §3 owns attenuation; the panner owns direction. Same rule as the pool.
    this.panner.rolloffFactor = 0;
    this.panner.maxDistance = 10000;

    this.gain.connect(this.filter);
    this.filter.connect(this.panner);
    this.panner.connect(engine.buses.voice);
  }

  attachStream(stream: MediaStream): void {
    const ctx = this.engine.ctx;
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    // Chromium will not pump a WebRTC MediaStream through Web Audio unless the
    // stream is also attached to a media element. It stays muted; the audible
    // path is the graph below. This is a long-standing browser quirk, not a
    // belt-and-braces flourish — without it every peer is silent.
    const sink = new Audio();
    sink.srcObject = stream;
    sink.muted = true;
    sink.autoplay = true;
    void sink.play().catch(() => undefined);
    this.sink = sink;

    this.source = ctx.createMediaStreamSource(stream);
    this.source.connect(this.gain);
    this.connected = true;
  }

  setPlacement(pos: Vec3, module: ModuleId, level01?: number): void {
    this.placement.pos = cloneV3(pos);
    this.placement.module = module;
    if (level01 !== undefined) this.placement.level01 = clamp(level01, 0, 1);
  }

  /**
   * Re-drive gain, filter and panner from the §3 propagation. Called ~10 Hz.
   */
  refresh(runtime: NoiseRuntime | null): void {
    if (!this.connected) return;
    const ctx = this.engine.ctx;
    const now = ctx.currentTime;

    if (this.channel === 'headset') {
      // §10: the dead speak over the headset at loudness 5. What LEAKS into the
      // room is quiet; what you hear in your own ear is a radio, so it is not
      // proximity-gated at all. The 5-loudness NoiseEvent is emitted by whoever
      // owns the spectator channel, not here.
      ramp(this.gain.gain, 0.85, now);
      ramp(this.filter.frequency, 3200, now);
      setPannerPosition(this.panner, 0, 0, 0, now, 0.05);
      return;
    }

    const sourceLoudness = voiceNoise(this.placement.level01);

    if (!runtime || this.placement.module === '') {
      // No graph yet: fall back to plain distance with the §3 falloff so voice
      // still behaves sensibly in a single-module test scene.
      const d = distance(this.placement.pos, this.engine.listenerPosition);
      const level = sourceLoudness - d;
      ramp(this.gain.gain, relativeGain(level, sourceLoudness), now);
      ramp(this.filter.frequency, occlusionCutoffHz(false), now);
      setPannerPosition(
        this.panner,
        this.placement.pos.x,
        this.placement.pos.y,
        this.placement.pos.z,
        now,
        0.05,
      );
      return;
    }

    const res = runtime.resolveAt(this.placement.pos, this.placement.module, sourceLoudness, 'voice');
    // Relative, not absolute: the stream already arrives at full amplitude, and
    // what we want from the graph is the LOSS it applied.
    ramp(this.gain.gain, res.audible ? relativeGain(res.level, sourceLoudness) : 0, now);
    ramp(this.filter.frequency, occlusionCutoffHz(res.occluded), now);
    // §8: through a hatch, they sound like they are at the hatch.
    const p = res.audible ? res.panPosition : this.placement.pos;
    setPannerPosition(this.panner, p.x, p.y, p.z, now, 0.05);
  }

  setChannel(channel: VoiceChannel): void {
    this.channel = channel;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Park a signal until the RTCPeerConnection exists. Order is preserved: the
   *  offer has to reach `signal()` before the candidates that follow it. */
  queueSignal(signal: unknown): void {
    if (this.pendingSignals.length >= MAX_PENDING_SIGNALS) this.pendingSignals.shift();
    this.pendingSignals.push(signal);
  }

  /** Hand every parked signal to the peer, in arrival order. */
  flushSignals(): void {
    if (!this.peer || this.pendingSignals.length === 0) return;
    const queued = this.pendingSignals;
    this.pendingSignals = [];
    for (const signal of queued) {
      try {
        this.peer.signal(signal as never);
      } catch (err) {
        console.warn(`[voice] queued signal for ${this.id} failed:`, err);
      }
    }
  }

  destroyPeer(): void {
    this.opening = false;
    this.pendingSignals = [];
    if (!this.peer) return;
    try {
      this.peer.destroy();
    } catch {
      /* already destroyed */
    }
    this.peer = null;
    this.connected = false;
    ramp(this.gain.gain, 0, this.engine.ctx.currentTime, 0.02);
  }

  dispose(): void {
    this.destroyPeer();
    if (this.sink) {
      this.sink.srcObject = null;
      this.sink = null;
    }
    for (const node of [this.source, this.gain, this.filter, this.panner]) {
      if (!node) continue;
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.source = null;
  }
}

type PeerCtor = new (opts?: PeerOptions) => PeerInstance;

let peerCtor: PeerCtor | null = null;

async function loadPeerCtor(): Promise<PeerCtor> {
  if (peerCtor) return peerCtor;
  const mod = (await import('simple-peer')) as unknown as { default?: PeerCtor };
  const ctor = (mod.default ?? (mod as unknown as PeerCtor)) as PeerCtor;
  peerCtor = ctor;
  return ctor;
}

export class VoiceMesh {
  private readonly engine: AudioEngine;
  private readonly opts: VoiceMeshOptions;
  private readonly peers = new Map<PeerId, PeerVoice>();
  private readonly reconnects = new Map<PeerId, ReturnType<typeof setTimeout>>();

  private signalling: VoiceSignalling | null;
  private net: VoiceLevelSink | null;
  private runtime: NoiseRuntime | null;

  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private scratch: Float32Array = new Float32Array(1024);
  private follower = new LevelFollower();

  private calibration: MicCalibration;
  private pushToTalk: boolean;
  private talking = true;
  private started = false;

  private levelTimer = 0;
  private refreshTimer = 0;
  private reconcileTimer = 0;
  private lastLevel = 0;
  private subscriptions: Unsubscribe[] = [];
  private signallingConnected = false;

  constructor(engine: AudioEngine, opts: VoiceMeshOptions = {}) {
    this.engine = engine;
    this.opts = opts;
    this.signalling = opts.signalling ?? null;
    this.net = opts.net ?? null;
    this.runtime = opts.runtime ?? null;
    this.pushToTalk = opts.pushToTalk ?? false;
    this.talking = !this.pushToTalk;
    this.calibration = loadCalibration() ?? DEFAULT_CALIBRATION;
    // Listen for signalling from the moment we exist, not from the moment the
    // mic opens. An offer that arrives while the menu is still up used to hit
    // nobody at all; now it is buffered against a PeerVoice and applied as soon
    // as `start()` builds the connection. Waiting for the mic here is what made
    // "who pressed start first" decide whether voice worked.
    if (this.signalling) this.connectSignalling(this.signalling);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Open the mic and wire the analyser. Requires a user gesture on most
   *  browsers, so call it from the menu's "join" button. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.engine.resume();

    const constraints: MediaTrackConstraints = this.opts.audioConstraints ?? {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });

    const ctx = this.engine.ctx;
    this.micSource = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.scratch = new Float32Array(this.analyser.fftSize);
    // Analyser only — the local mic is NEVER routed to the destination. You do
    // not monitor yourself; you would hear yourself twice and feed back.
    this.micSource.connect(this.analyser);

    this.applyTransmitState();
    this.started = true;

    if (this.signalling) this.connectSignalling(this.signalling);

    // THE ORDERING FIX (§7). `addPeer` is routinely called during boot, long
    // before anyone has pressed the button that opens the mic — main.ts does it
    // for every player already in the room. Those peers are in the map with no
    // RTCPeerConnection behind them, because `openConnection` cannot build one
    // without a stream to attach. Nothing used to revisit them, so the second
    // tab in a two-tab test stayed mute in both directions for the whole round
    // and only the ordering "I press start, THEN you join" worked.
    //
    // Now the mic existing is the trigger: reconcile every peer we already know
    // about, then keep sweeping (see `update`) so no arrival order can lose.
    this.reconcilePeers();
  }

  /** Supply signalling after construction (it arrives with the room). */
  setSignalling(signalling: VoiceSignalling | null): void {
    this.teardownSignalling();
    this.signalling = signalling;
    if (!signalling) return;
    this.connectSignalling(signalling);
    this.reconcilePeers();
  }

  setNetwork(net: VoiceLevelSink | null): void {
    this.net = net;
  }

  setRuntime(runtime: NoiseRuntime | null): void {
    this.runtime = runtime;
  }

  private connectSignalling(signalling: VoiceSignalling): void {
    if (this.signallingConnected) return;
    this.signallingConnected = true;
    this.subscriptions.push(
      signalling.onPeerJoin((id) => this.addPeer(id)),
      signalling.onPeerLeave((id) => this.removePeer(id)),
      signalling.onSignal((from, signal) => this.handleSignal(from, signal)),
    );
    for (const id of signalling.peers?.() ?? []) this.addPeer(id);
  }

  private teardownSignalling(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    this.signallingConnected = false;
  }

  // -----------------------------------------------------------------------
  // Calibration (§7 — non-negotiable)
  // -----------------------------------------------------------------------

  /** Run the two-phase calibration. The menu drives the prompts. */
  async calibrate(opts: CalibrationOptions = {}): Promise<CalibrationResult> {
    if (!this.analyser) throw new Error('VoiceMesh.calibrate: call start() first');
    const wasTalking = this.talking;
    this.talking = true;
    this.applyTransmitState();
    const result = await calibrateMic(this.analyser, opts);
    this.calibration = {
      floorDb: result.floorDb,
      speechDb: result.speechDb,
      at: result.at,
      version: result.version,
    };
    this.talking = wasTalking;
    this.applyTransmitState();
    return result;
  }

  get micCalibration(): MicCalibration {
    return this.calibration;
  }

  setCalibration(cal: MicCalibration): void {
    this.calibration = cal;
  }

  // -----------------------------------------------------------------------
  // Push to talk (§7 — "or half your players mute")
  // -----------------------------------------------------------------------

  setPushToTalk(enabled: boolean): void {
    this.pushToTalk = enabled;
    this.talking = !enabled;
    this.applyTransmitState();
  }

  get isPushToTalk(): boolean {
    return this.pushToTalk;
  }

  setTransmitting(on: boolean): void {
    if (!this.pushToTalk) return;
    if (on === this.talking) return;
    this.talking = on;
    this.applyTransmitState();
  }

  get transmitting(): boolean {
    return this.talking;
  }

  /** Hold a key to talk. Returns a teardown. */
  bindPushToTalkKey(code = 'KeyV', target: EventTarget = window): Unsubscribe {
    const down = (event: Event): void => {
      if ((event as KeyboardEvent).code !== code) return;
      if ((event as KeyboardEvent).repeat) return;
      this.setTransmitting(true);
    };
    const up = (event: Event): void => {
      if ((event as KeyboardEvent).code !== code) return;
      this.setTransmitting(false);
    };
    const blur = (): void => this.setTransmitting(false);
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }

  private applyTransmitState(): void {
    if (!this.stream) return;
    for (const track of this.stream.getAudioTracks()) track.enabled = this.talking;
  }

  // -----------------------------------------------------------------------
  // Peers
  // -----------------------------------------------------------------------

  /**
   * All peers stay connected for the whole round (§7).
   *
   * Idempotent, and deliberately not a no-op for a peer we already hold: an
   * existing entry may still be waiting for the mic, so a second call is a
   * second chance to build the connection rather than something to discard.
   */
  addPeer(id: PeerId): void {
    if (!id || id === this.signalling?.localId) return;
    const existing = this.peers.get(id);
    if (existing) {
      this.ensureConnection(existing);
      return;
    }
    const voice = new PeerVoice(this.engine, id);
    this.peers.set(id, voice);
    this.ensureConnection(voice);
  }

  /**
   * Build the RTCPeerConnection for one peer if it does not have one and
   * nothing is already trying. Safe to call as often as you like.
   */
  private ensureConnection(voice: PeerVoice): void {
    if (voice.peer || voice.opening) return;
    if (this.reconnects.has(voice.id)) return;
    if (!this.stream) return;
    void this.openConnection(voice, this.shouldInitiate(voice.id));
  }

  /**
   * Give every peer without a live connection one. Called when the mic opens,
   * when signalling arrives, and on a slow timer — the three moments that can
   * unblock a peer that was added too early.
   */
  private reconcilePeers(): void {
    if (!this.stream) return;
    for (const voice of this.peers.values()) this.ensureConnection(voice);
  }

  removePeer(id: PeerId): void {
    const timer = this.reconnects.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnects.delete(id);
    }
    const voice = this.peers.get(id);
    if (!voice) return;
    voice.dispose();
    this.peers.delete(id);
    this.opts.onPeerState?.(id, false);
  }

  /** Where a peer is, so proximity can gate their gain. Call from net snapshots. */
  setPeerPlacement(id: PeerId, pos: Vec3, module: ModuleId, level01?: number): void {
    const voice = this.peers.get(id);
    if (!voice) return;
    voice.setPlacement(pos, module, level01);
  }

  /** Move a peer onto the spectator headset channel, or back (§10). */
  setPeerChannel(id: PeerId, channel: VoiceChannel): void {
    this.peers.get(id)?.setChannel(channel);
  }

  get peerIds(): PeerId[] {
    return [...this.peers.keys()];
  }

  get connectedPeers(): number {
    let n = 0;
    for (const peer of this.peers.values()) if (peer.isConnected) n++;
    return n;
  }

  /**
   * Mesh snapshot for the console. `peerIsNull: true` on a started mesh means
   * that peer never negotiated — the failure this module used to have when
   * `addPeer` ran before the mic was open.
   */
  get diagnostics(): {
    started: boolean;
    streamNull: boolean;
    entries: { id: PeerId; peerIsNull: boolean; opening: boolean; isConnected: boolean }[];
  } {
    return {
      started: this.started,
      streamNull: this.stream === null,
      entries: [...this.peers.values()].map((voice) => ({
        id: voice.id,
        peerIsNull: voice.peer === null,
        opening: voice.opening,
        isConnected: voice.isConnected,
      })),
    };
  }

  private shouldInitiate(id: PeerId): boolean {
    const localId = this.signalling?.localId ?? '';
    return localId < id;
  }

  private async openConnection(voice: PeerVoice, initiator: boolean): Promise<void> {
    // No mic yet: leave the peer in the map with its signals buffered. `start()`
    // and the reconcile sweep come back for it. NEVER treat this as a failure —
    // that is the bug that made ordering decide whether voice worked at all.
    if (!this.stream) return;
    if (voice.peer || voice.opening) return;

    voice.opening = true;
    let Ctor: PeerCtor;
    try {
      Ctor = await loadPeerCtor();
    } catch (err) {
      voice.opening = false;
      console.error('[voice] failed to load simple-peer:', err);
      return;
    }
    // Everything below the await has to re-check: the peer may have left, the
    // mic may have been stopped, or a second call may have won the race.
    voice.opening = false;
    if (this.peers.get(voice.id) !== voice) return;
    if (!this.stream || voice.peer) return;

    const options: PeerOptions = {
      initiator,
      trickle: true,
      stream: this.stream,
      config: { iceServers: this.opts.iceServers ?? DEFAULT_ICE_SERVERS },
    };
    const peer = new Ctor(options);
    voice.peer = peer;

    peer.on('signal', (data: unknown) => {
      this.signalling?.send(voice.id, data);
    });
    peer.on('stream', (stream: MediaStream) => {
      voice.attachStream(stream);
      this.opts.onPeerState?.(voice.id, true);
    });
    peer.on('connect', () => {
      this.opts.onPeerState?.(voice.id, true);
    });
    peer.on('error', (err: Error) => {
      console.warn(`[voice] peer ${voice.id} error:`, err.message);
      this.scheduleReconnect(voice, initiator);
    });
    peer.on('close', () => {
      this.scheduleReconnect(voice, initiator);
    });

    // Handlers first, then anything that arrived while we were waiting — the
    // buffered offer is what turns us into the answerer.
    voice.flushSignals();
  }

  /**
   * Reconnect on FAILURE only. This is not the proximity teardown §7 forbids —
   * a dropped ICE connection that is never rebuilt means one friend is mute for
   * the rest of the round.
   */
  private scheduleReconnect(voice: PeerVoice, initiator: boolean): void {
    if (!this.peers.has(voice.id)) return;
    if (this.reconnects.has(voice.id)) return;
    voice.destroyPeer();
    const timer = setTimeout(() => {
      this.reconnects.delete(voice.id);
      if (!this.peers.has(voice.id)) return;
      void this.openConnection(voice, initiator);
    }, RECONNECT_DELAY_MS);
    this.reconnects.set(voice.id, timer);
    this.opts.onPeerState?.(voice.id, false);
  }

  private handleSignal(from: PeerId, signal: unknown): void {
    if (!from || from === this.signalling?.localId) return;
    let voice = this.peers.get(from);
    if (!voice) {
      // They got here first. Answer as the non-initiator.
      this.addPeer(from);
      voice = this.peers.get(from);
      if (!voice) return;
    }
    if (!voice.peer) {
      // The connection does not exist yet — the mic may still be closed, or the
      // dynamic `simple-peer` import may still be in flight. Buffer rather than
      // retry-once-and-drop: a dropped offer is a peer that never negotiates.
      voice.queueSignal(signal);
      this.ensureConnection(voice);
      return;
    }
    try {
      voice.peer.signal(signal as never);
    } catch (err) {
      console.warn('[voice] signal failed:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Per-frame
  // -----------------------------------------------------------------------

  /** Drive from the fixed update. Samples the mic at `levelHz` and re-resolves
   *  every peer through the graph at 10 Hz. */
  update(dt: number): void {
    if (!this.started) return;

    const levelPeriod = 1 / (this.opts.levelHz ?? VOICE_LEVEL_HZ);
    this.levelTimer += dt;
    if (this.analyser) {
      const rms = analyserRms(this.analyser, this.scratch);
      this.follower.push(this.talking ? rms : 0, dt);
    }
    if (this.levelTimer >= levelPeriod) {
      this.levelTimer = 0;
      this.publishLevel();
    }

    this.refreshTimer += dt;
    if (this.refreshTimer >= PEER_REFRESH_S) {
      this.refreshTimer = 0;
      for (const voice of this.peers.values()) voice.refresh(this.runtime);
    }

    // Slow safety sweep. `start()`, `addPeer` and `handleSignal` all reconcile
    // on their own; this catches anything that slipped between them (a peer
    // added while the `simple-peer` import was failing, say) so that no arrival
    // order can leave somebody silently mute for a whole round.
    this.reconcileTimer += dt;
    if (this.reconcileTimer >= PEER_RECONCILE_S) {
      this.reconcileTimer = 0;
      this.reconcilePeers();
    }
  }

  private publishLevel(): void {
    const level = this.talking ? calibratedLevel(this.follower.level, this.calibration) : 0;
    this.lastLevel = level;
    this.net?.sendVoiceLevel({ level });
    this.opts.onLevel?.(level, level > 0 ? voiceNoise(level) : 0);
  }

  /** Last calibrated level, 0–1. */
  get level(): number {
    return this.lastLevel;
  }

  /** Loudness the alien hears you at right now: 10–55 (§14). */
  get loudness(): number {
    return this.lastLevel > 0 ? voiceNoise(this.lastLevel) : 0;
  }

  /** The spectator headset's fixed loudness, for whoever emits it (§10). */
  static get headsetLoudness(): number {
    return LOUDNESS.HEADSET;
  }

  stop(): void {
    this.teardownSignalling();
    for (const timer of this.reconnects.values()) clearTimeout(timer);
    this.reconnects.clear();
    for (const voice of this.peers.values()) voice.dispose();
    this.peers.clear();
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        /* already disconnected */
      }
      this.micSource = null;
    }
    this.analyser = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.started = false;
  }
}

/**
 * Public STUN as a default so a LAN session works out of the box. §1 is blunt
 * that this is not enough: "**coturn (STUN + TURN) — not optional. One friend
 * behind symmetric NAT otherwise costs you an entire playtest night.**" Pass
 * your own TURN credentials through `iceServers`.
 */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
