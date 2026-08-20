/**
 * ISS — wrist tracker (DESIGN.md §6).
 *
 * Bottom-left, framed as a wrist-cam feed. It shows proximity as PULSE RATE and
 * never as position: a beep every 3s when far, accelerating as the alien
 * closes, a solid tone when it is adjacent. There is no bearing, no distance
 * readout and no dot on a map anywhere in this file — the trace tells you *how
 * fast*, and that is the whole instrument.
 *
 * The beep is a real noise in the world at loudness 20 (§3), emitted through
 * the `onBeep` callback so this file never has to know where the player is or
 * how the net layer works. Muting silences it and blinds you at the same time:
 * with the signal muted the proximity lane goes dead, because the information
 * and the noise are the same thing. And since the pulse quickens with danger,
 * leaving it live costs you most at exactly the moment it matters most (§6).
 *
 * What you SEE and what the world HEARS run on two clocks. The pulse follows
 * `trackerPulseInterval` in `../audio/tracker` — the same function the audio
 * half calls, so the trace and the beep are the same clock and cannot drift.
 * The emitted NoiseEvent is `trackerEmitInterval` from `./trackerCadence`,
 * floored at one per §3 coalescing window, because a second identical event
 * inside the same window cannot change anything the alien does. Playtest 2
 * changed only the first of those: the device got legible, not louder.
 *
 * EVERYTHING on the prox lane keys off the same urgency the audio does — the
 * spike shape is the chirp's own amplitude envelope, the shimmer under a solid
 * tone runs at the tremolo rate you are hearing, the lane colour steps through
 * the §14 urgency bands, and the RATE pips fill with them. §6 asks only for
 * pulse rate; the player who filed this could not decode pulse rate alone, so
 * every other channel on the device was pointed at the same number rather than
 * given something else to say.
 *
 * Second trace on the same device: your own heart rate, which is a mechanic and
 * not decoration (§6) — it drives the breathing loop at 6–14 loudness, so the
 * freeze meta has a price. The server owns that model, so `setServerHeartRate`
 * is what the trace should be fed; the bus estimate is a fallback for the
 * offline sandbox. Third readout: crew alive, because three of six escaping is
 * a win (§10) and the team needs to know where it stands.
 *
 * DRAWING. r1 repainted the whole scope at display rate: 513 canvas calls a
 * frame, 456 of them polyline vertices re-stroked from a ring buffer that had
 * moved by one column. The scope is now three stacked canvases inside the same
 * `iss-tracker__scope` frame, and a steady frame touches almost none of them
 * (§9 — this is a HUD, not the game):
 *
 *   back    graticule, lane divider, labels, edge cursor. Repainted only when
 *           the backing store's scale changes, i.e. almost never.
 *   trace   the two waveforms, on a canvas twice the scope's width. Every
 *           sample is drawn at column `h` AND at column `h + width`, so the last
 *           N columns are always one contiguous window — which means scrolling
 *           is a `translate3d` on the compositor and not a pixel of work on the
 *           main thread. Only the single new column is ever drawn.
 *   front   the readouts that change — RATE pips, CONTACT, the mute overlay.
 *           Repainted only when the value it displays actually changes.
 *
 * A steady frame is therefore one `style.transform` write plus two one-pixel
 * line segments, and only on the frames that carry a new sample. Compositing the
 * three layers is the compositor's job, which is what it is for.
 *
 * (The obvious middle road — cache the layers offscreen and `drawImage` them
 * onto one visible canvas — was built and measured first, and it is SLOWER than
 * r1: three full-surface 228x108 composites move more pixels than 456 short line
 * segments do, whatever the call count says. Hence the transform.)
 */

import {
  LOUDNESS,
  MAX_PLAYERS,
  TRACKER_BEEP_DECAY_FAR_S,
  TRACKER_BEEP_DECAY_NEAR_S,
  TRACKER_BEEP_INTERVAL_FAR_S,
  TRACKER_SOLID_TREMOLO_HZ,
} from '@shared/constants';
import type { PlayerId } from '@shared/types';
// The cadence, band and urgency mappings live with the tracker's voice so the
// two halves of the device physically cannot hold different copies of them —
// they did once, and disagreed by 3.3x. Nothing here reaches into audio state;
// these are pure functions of a distance.
import { trackerBand, trackerPulseInterval, type TrackerBand } from '../audio/tracker';
import { bus as sharedBus, type EventBus, type GameEvents, type Unsubscribe } from '../core/eventBus';
import { el, listen } from './dom';
import { clamp01, mix, UI_COLORS, uiFont } from './theme';
import { isTrackerSolid, trackerEmitInterval, trackerUrgency } from './trackerCadence';

/** What the tracker hands to the noise layer when it chirps. */
export interface TrackerBeep {
  /** Always LOUDNESS.TRACKER_BEEP (20). Passed so callers never re-type it. */
  loudness: number;
  /** True when the alien is adjacent and the device is holding a solid tone. */
  solid: boolean;
  /** Seconds until the next chirp — 0 while solid. Drives the audio pitch/ADSR. */
  intervalSeconds: number;
}

export type TrackerBeepHandler = (beep: TrackerBeep) => void;

export interface WristTrackerOptions {
  parent: HTMLElement;
  /** Bus for `alien:proximity` / `player:heartRate`. `null` to drive manually. */
  bus?: EventBus<GameEvents> | null;
  /** Called on every chirp. Wire it to the noise emitter AND to local audio. */
  onBeep?: TrackerBeepHandler;
  /** Crew size for the alive counter. Defaults to MAX_PLAYERS (6). */
  crewTotal?: number;
  /** `KeyboardEvent.code` that toggles mute. `null` to bind nothing. */
  muteKey?: string | null;
  startMuted?: boolean;
  /** Resting heart rate shown before the player subsystem reports one. */
  restingBpm?: number;
}

/**
 * Samples per second pushed into the scope, one sample per column.
 *
 * 30, not the r1 60. At 60 the scope held 3.8 s, which at the far cadence of
 * TRACKER_BEEP_INTERVAL_FAR_S is barely one pulse on screen — you cannot read a
 * rate off a single spike, which is a fair part of why the device was
 * undecodable. 30 shows 7.6 s, so the idle state is visibly "three slow ticks"
 * and the closing state is visibly denser. The scroll is still one pixel per
 * step, so it reads as continuous motion, and it halves the sampling work.
 */
const SAMPLE_HZ = 30;
/** Scope size in CSS pixels — one sample per column. */
const SCOPE_W = 228;
const SCOPE_H = 108;
/**
 * The drawn spike is the chirp's own amplitude envelope (§14's decay constants),
 * widened by this factor purely so it survives being sampled into one-pixel
 * columns: a 70 ms decay at 30 Hz is two pixels. The SHAPE relationship is what
 * carries the information — far chirps are soft and wide, near chirps are sharp
 * and narrow, and near contact they visibly begin to merge exactly as the sound
 * does — so the factor is applied to both ends equally and nothing is invented.
 */
const TRACE_ENVELOPE_SCALE = 2;

/** Prox lane geometry, CSS px. */
const PROX_BASE = 48;
const PROX_AMP = 38;
const HR_BASE = 84;
const HR_AMP = 26;
const LANE_SPLIT = 54;

/** RATE pips — the rate readout, in the corner the CONTACT badge uses. */
const PIP_COUNT = 9;
const PIP_W = 4;
const PIP_H = 5;
const PIP_GAP = 2;
const PIP_RIGHT = SCOPE_W - 5;
const PIP_TOP = 4;
const PIP_SPAN = PIP_COUNT * PIP_W + (PIP_COUNT - 1) * PIP_GAP;

/**
 * The scroll transform for every possible head column, built once.
 *
 * `refresh()` runs at SAMPLE_HZ and wrote `translate3d(${-percent.toFixed(4)}%,
 * 0, 0)` — a `toFixed` string plus a template literal — every time. `headX` is
 * an integer in [0, SCOPE_W), so there are exactly SCOPE_W of these and none of
 * them ever changes.
 */
const SCROLL_TRANSFORMS: readonly string[] = Array.from({ length: SCOPE_W }, (_, x) => {
  const percent = (x / (SCOPE_W * 2)) * 100;
  return `translate3d(${-percent.toFixed(4)}%, 0, 0)`;
});

/**
 * Pulse interval for a given distance, in seconds. `0` means "solid tone".
 *
 * The curve itself lives in `../audio/tracker`, which is also what the beep is
 * scheduled from. This wrapper only adds the "0 means solid" convention the HUD
 * reads.
 */
export function beepInterval(metres: number): number {
  if (!Number.isFinite(metres)) return TRACKER_BEEP_INTERVAL_FAR_S;
  if (isTrackerSolid(metres)) return 0;
  return trackerPulseInterval(metres);
}

/** True when the alien is close enough for the device to hold a solid tone. */
export function isSolidTone(metres: number): boolean {
  return isTrackerSolid(metres);
}

/** One synthesised heartbeat, phase 0–1 → −0.35…1. */
function ecgSample(p: number): number {
  if (p < 0.1) return 0.12 * Math.sin(Math.PI * (p / 0.1)); // P
  if (p < 0.16) return 0;
  if (p < 0.19) return -0.18 * Math.sin(Math.PI * ((p - 0.16) / 0.03)); // Q
  if (p < 0.23) return Math.sin(Math.PI * ((p - 0.19) / 0.04)); // R
  if (p < 0.28) return -0.32 * Math.sin(Math.PI * ((p - 0.23) / 0.05)); // S
  if (p < 0.45) return 0;
  if (p < 0.62) return 0.22 * Math.sin(Math.PI * ((p - 0.45) / 0.17)); // T
  return 0;
}

/**
 * One stacked canvas of the scope, sized in CSS pixels and backed at `scale`
 * device pixels per CSS pixel. Drawing code always works in CSS pixels.
 */
interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function makeLayer(cssW: number, cssH: number, scale: number): Layer {
  // Sized as a PERCENTAGE of the frame, never in pixels: hud.css owns the
  // scope's box and is not ours to read (it is `border-box` today, so the
  // content area is the declared 228x108 minus the bezel). A layer that fills
  // 100% — or 200% for the double-width trace — lands exactly on the frame
  // whatever that box turns out to be, and the trace's scroll offset is a
  // percentage of its own width for the same reason.
  const canvas = el('canvas', {
    style: {
      position: 'absolute',
      left: '0',
      top: '0',
      display: 'block',
      width: `${Math.round((cssW / SCOPE_W) * 100)}%`,
      height: '100%',
    },
  });
  canvas.width = Math.round(cssW * scale);
  canvas.height = Math.round(cssH * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[ui] 2D canvas context unavailable');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return { canvas, ctx };
}

export class WristTracker {
  readonly root: HTMLDivElement;

  /** The scope's frame — carries `iss-tracker__scope`, clips the trace layer. */
  private readonly frame: HTMLDivElement;
  private readonly bpmValue: HTMLSpanElement;
  private readonly crewValue: HTMLSpanElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly muteLabel: HTMLSpanElement;
  private readonly disposers: (() => void)[] = [];

  private onBeep: TrackerBeepHandler | null;
  private readonly bus: EventBus<GameEvents> | null;

  // proximity state — distance is used ONLY to compute the pulse rate.
  private metres = Number.POSITIVE_INFINITY;
  private interval = TRACKER_BEEP_INTERVAL_FAR_S;
  private urgency = 0;
  private band: TrackerBand = 'idle';
  private solid = false;
  private beepTimer = 0;
  /** Counts down to the next EMITTED loudness-20 event — not to the next chirp. */
  private emitTimer = 0;
  private chirpEnvelope = 0;

  // lifecycle — the dead do not carry a beeping tracker, and a finished round
  // has nothing to hear it (§10). Visuals stay; only emission is gated.
  private alive = true;
  private roundLive = true;
  private localId: PlayerId | null = null;

  // heart rate
  private bpm: number;
  private targetBpm: number;
  private hrPhase = 0;
  /**
   * True once the authoritative (server) heart rate has been supplied. The
   * server runs the model the alien actually hears (§6); the client-side one in
   * `src/player/heartRate.ts` is a different curve, so once the real number is
   * available the bus estimate stops driving the trace.
   */
  private authoritativeBpm = false;

  private crewAlive: number;
  private crewTotal: number;
  private _muted: boolean;

  private sampleAccumulator = 0;
  private elapsed = 0;

  // ---- layers ------------------------------------------------------------
  private layerScale = 0;
  private back: Layer | null = null;
  private trace: Layer | null = null;
  private front: Layer | null = null;
  /** CSS-px column of the newest vertex in the ring image's primary copy. */
  private headX = 0;
  /** Last `headX` pushed to the compositor, so the transform is written once. */
  private scrolledTo = -1;
  private lastProxY = PROX_BASE;
  private lastHrY = HR_BASE;
  private tracePrimed = false;
  /** The two halves of the readout's cache key, compared as VALUES. Joining
   *  them into a `"band:lit"` string built one throwaway string per frame. */
  private frontBand = '';
  private frontLit = -1;
  private frontMuted = false;

  /** Cached DOM text, so a steady BPM is not written to the DOM 60x a second.
   *  `bpmShown` is the rounded number the text was built from — comparing that
   *  keeps the frame from formatting a string it will discard. */
  private bpmShown = Number.NaN;
  private bpmText = '';
  private bpmFlag = '';

  constructor(opts: WristTrackerOptions) {
    this.crewTotal = opts.crewTotal ?? MAX_PLAYERS;
    this.crewAlive = this.crewTotal;
    this._muted = opts.startMuted ?? false;
    this.onBeep = opts.onBeep ?? null;
    this.bpm = opts.restingBpm ?? 64;
    this.targetBpm = this.bpm;

    // ---- frame -----------------------------------------------------------
    this.root = el('div', { class: 'iss-tracker iss-scan iss-flicker' });
    this.root.dataset.muted = String(this._muted);

    const head = el('div', {
      class: 'iss-tracker__head',
      children: [
        el('span', { text: 'WRIST-CAM 01 / PROX' }),
        el('span', { class: 'iss-tracker__rec', text: '● REC' }),
      ],
    });

    // The frame keeps the `iss-tracker__scope` class — hud.css still owns the
    // bezel, the size and the screen colour — and becomes the positioning and
    // clipping context for the three stacked layers.
    this.frame = el('div', {
      class: 'iss-tracker__scope',
      style: { position: 'relative', overflow: 'hidden' },
    });

    this.bpmValue = el('span', { class: 'iss-tracker__v', text: '--' });
    this.crewValue = el('span', { class: 'iss-tracker__v', text: `${this.crewAlive}/${this.crewTotal}` });

    const rows = el('div', {
      class: 'iss-tracker__rows',
      children: [
        el('div', {
          class: 'iss-tracker__row',
          children: [el('span', { class: 'iss-tracker__k', text: 'BPM' }), this.bpmValue],
        }),
        el('div', {
          class: 'iss-tracker__row',
          children: [el('span', { class: 'iss-tracker__k', text: 'CREW' }), this.crewValue],
        }),
      ],
    });

    this.muteLabel = el('span', { text: 'SIGNAL LIVE' });
    this.muteButton = el('button', {
      class: 'iss-tracker__mute',
      attrs: { type: 'button', 'aria-label': 'Toggle tracker signal' },
      children: [
        el('span', { class: 'iss-tracker__lamp' }),
        this.muteLabel,
        el('span', { text: opts.muteKey === null ? '' : '[M]' }),
      ],
    });
    rows.appendChild(this.muteButton);

    this.root.appendChild(head);
    this.root.appendChild(this.frame);
    this.root.appendChild(rows);
    opts.parent.appendChild(this.root);

    this.disposers.push(listen(this.muteButton, 'click', () => this.toggleMute()));

    const muteKey = opts.muteKey === undefined ? 'KeyM' : opts.muteKey;
    if (muteKey) {
      this.disposers.push(
        listen(window, 'keydown', (ev: KeyboardEvent) => {
          if (ev.code !== muteKey || ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
          const target = ev.target as HTMLElement | null;
          const tag = target?.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          this.toggleMute();
        }),
      );
    }

    this.bus = opts.bus === undefined ? sharedBus : opts.bus;
    if (this.bus) {
      this.disposers.push(
        this.bus.on('alien:proximity', ({ metres }) => this.setProximity(metres)),
        // Fallback only: the client-side heart-rate model. `setServerHeartRate`
        // takes over permanently the first time the server's number arrives.
        this.bus.on('player:heartRate', ({ bpm }) => {
          if (!this.authoritativeBpm) this.applyHeartRate(bpm);
        }),
        // Someone else may own the mute key (the player controller binds one
        // too). `setMuted` is a no-op when the value already matches, so this
        // syncs rather than ping-pongs.
        this.bus.on('ui:trackerMute', ({ muted }) => this.setMuted(muted)),
        // `player:died` is broadcast for everybody, so it has to be filtered
        // against our own session id or a teammate's death would silence us.
        this.bus.on('net:connected', ({ sessionId }) => {
          this.localId = sessionId;
        }),
        this.bus.on('player:died', ({ playerId }) => {
          if (this.localId !== null && playerId === this.localId) this.alive = false;
        }),
        this.bus.on('player:revived', ({ id }) => {
          if (this.localId !== null && id === this.localId) this.alive = true;
        }),
        this.bus.on('round:started', () => {
          this.alive = true;
          this.roundLive = true;
        }),
        this.bus.on('round:ended', () => {
          this.roundLive = false;
        }),
      );
    }

    this.syncMuteUi();
    this.refresh();
  }

  // ---------------------------------------------------------------- inputs --

  /**
   * Distance to the alien, in metres. This is the ONLY place a distance enters
   * the tracker, and it leaves again as a pulse rate — never as a readout.
   * Pass `Infinity` (or anything non-finite) when the alien is unreachable.
   */
  setProximity(metres: number): void {
    this.metres = metres;
    const wasSolid = this.solid;
    this.solid = isSolidTone(metres);
    this.interval = beepInterval(metres);
    this.urgency = trackerUrgency(metres);
    this.band = trackerBand(metres);
    if (this.solid && !wasSolid) {
      // Entering solid tone reads immediately: the transition must be felt.
      // The chirp is visual and free; the EMITTED noise is not, so it stays on
      // its own clock rather than firing an extra loudness-20 event here.
      this.beepTimer = 0;
      this.chirpEnvelope = 1;
    }
  }

  /**
   * Heart rate in bpm from the client-side model. Kept for manual driving and
   * for the offline sandbox; ignored once the server's number is in hand.
   */
  setHeartRate(bpm: number): void {
    if (this.authoritativeBpm) return;
    this.applyHeartRate(bpm);
  }

  /**
   * The server's heart rate for the local player (§6, §7).
   *
   * The server runs the model that actually decides when you breathe and how
   * loud — `src/player/heartRate.ts` runs a different curve with an exertion
   * term the server does not have. §6 calls this device the tutorial for that
   * mechanic, so it has to trace the model the alien is listening to, not a
   * plausible-looking local one.
   */
  setServerHeartRate(bpm: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    this.authoritativeBpm = true;
    this.applyHeartRate(bpm);
  }

  /** True once the trace is showing the server's model rather than the local one. */
  get heartRateIsAuthoritative(): boolean {
    return this.authoritativeBpm;
  }

  private applyHeartRate(bpm: number): void {
    this.targetBpm = Math.max(30, Math.min(220, bpm));
  }

  /** Crew alive out of the round's crew size (§10). */
  setCrew(alive: number, total?: number): void {
    if (total !== undefined) this.crewTotal = Math.max(1, Math.round(total));
    this.crewAlive = Math.max(0, Math.min(this.crewTotal, Math.round(alive)));
    this.crewValue.textContent = `${this.crewAlive}/${this.crewTotal}`;
    const critical = this.crewAlive <= 1;
    this.crewValue.dataset.alarm = String(critical);
    this.crewValue.dataset.warn = String(!critical && this.crewAlive <= 3);
  }

  /** Replace the beep callback (e.g. once the net layer is connected). */
  setBeepHandler(handler: TrackerBeepHandler | null): void {
    this.onBeep = handler;
  }

  /**
   * Whether the device's owner is still in the round. Gates EMISSION only — the
   * scope keeps running, because a spectator still watches it (§10). Driven off
   * `player:died` / `player:revived` automatically; call it directly for the
   * cases the bus does not carry, such as escaping the station.
   */
  setAlive(alive: boolean): void {
    this.alive = alive;
  }

  /** False between `round:ended` and the next `round:started`. */
  setRoundLive(live: boolean): void {
    this.roundLive = live;
  }

  /** Unmuted, alive, mid-round, and the alien's distance is known. */
  get isEmitting(): boolean {
    return this.emitting;
  }

  /** Audible/visual pulses per second at the current range. 0 while solid. */
  get pulseHz(): number {
    return this.interval > 0 ? 1 / this.interval : 0;
  }

  /** Which of the four §14 urgency bands the device is showing. */
  get proximityBand(): TrackerBand {
    return this.band;
  }

  // ------------------------------------------------------------------ mute --

  get muted(): boolean {
    return this._muted;
  }

  setMuted(muted: boolean): void {
    if (muted === this._muted) return;
    this._muted = muted;
    this.syncMuteUi();
    this.bus?.emit('ui:trackerMute', { muted });
  }

  toggleMute(): void {
    this.setMuted(!this._muted);
  }

  private syncMuteUi(): void {
    this.root.dataset.muted = String(this._muted);
    this.muteLabel.textContent = this._muted ? 'SIGNAL MUTED' : 'SIGNAL LIVE';
    if (this._muted) this.chirpEnvelope = 0;
  }

  // ----------------------------------------------------------------- frame --

  /** Advance timers, sample both traces and repaint what changed. Once a frame. */
  update(dt: number): void {
    if (!(dt > 0)) return;
    const step = Math.min(dt, 0.25);
    this.elapsed += step;

    // Heart rate eases toward its target so the trace never jumps.
    this.bpm += (this.targetBpm - this.bpm) * Math.min(1, step * 3);
    this.hrPhase = (this.hrPhase + (this.bpm / 60) * step) % 1;

    // The world only hears the device once there is something to be near, and
    // only while its owner is alive in a live round (§10 — the server drops
    // noise from the dead, so sending it is pure spam). This clock is NOT the
    // one you hear: it is floored at one event per §3 coalescing window, and
    // playtest 2 deliberately left it alone. See ./trackerCadence.
    if (this.emitting) {
      this.emitTimer -= step;
      if (this.emitTimer <= 0) {
        this.emitTimer = trackerEmitInterval(this.metres);
        this.emitBeep();
      }
    } else {
      this.emitTimer = 0;
    }

    // Sample the trace at a fixed rate so the scroll speed is frame-rate
    // independent; cap the catch-up so an alt-tab does not fill the buffer.
    // The pulse clock lives in here too, which quantises the drawn spike onto
    // the sample grid — otherwise a chirp fired between two samples shows up at
    // a random fraction of full height.
    this.sampleAccumulator += step;
    const sampleDt = 1 / SAMPLE_HZ;
    let guard = 0;
    while (this.sampleAccumulator >= sampleDt && guard++ < 12) {
      this.sampleAccumulator -= sampleDt;
      this.advancePulse(sampleDt);
      this.pushSample(sampleDt);
    }
    if (guard >= 12) this.sampleAccumulator = 0;

    this.syncReadouts();
    this.refresh();
  }

  /**
   * The clock you HEAR and SEE. A muted tracker makes no sound and shows no
   * proximity — silent and blind, which is the entire trade (§6).
   */
  private advancePulse(sampleDt: number): void {
    if (this._muted) return;
    if (this.solid) {
      this.chirpEnvelope = 1;
      return;
    }
    // An unknown distance still ticks: `beepInterval` hands back the far
    // cadence, so a powered device with nothing to report reads as "clear"
    // rather than as "broken".
    this.beepTimer -= sampleDt;
    if (this.beepTimer <= 0) {
      this.beepTimer += Math.max(0.05, this.interval);
      this.chirpEnvelope = 1;
    }
  }

  /** Unmuted, powered, in range of a known alien, alive, mid-round. */
  private get emitting(): boolean {
    return !this._muted && this.alive && this.roundLive && Number.isFinite(this.metres);
  }

  private emitBeep(): void {
    this.onBeep?.({
      loudness: LOUDNESS.TRACKER_BEEP,
      solid: this.solid,
      intervalSeconds: this.interval,
    });
  }

  /** The DOM half of the readout. Written only when the displayed text moves. */
  private syncReadouts(): void {
    // Compare the NUMBER, then build the string. `String(Math.round(bpm))` ran
    // sixty times a second to be thrown away fifty-nine of them.
    const shown = Math.round(this.bpm);
    if (shown !== this.bpmShown) {
      this.bpmShown = shown;
      const text = String(shown);
      this.bpmText = text;
      this.bpmValue.textContent = text;
    }
    const flag = this.bpm >= 140 ? 'alarm' : this.bpm >= 105 ? 'warn' : '';
    if (flag !== this.bpmFlag) {
      this.bpmFlag = flag;
      this.bpmValue.dataset.alarm = String(flag === 'alarm');
      this.bpmValue.dataset.warn = String(flag === 'warn');
    }
  }

  // ------------------------------------------------------------------ draw --

  /**
   * The drawn chirp is the audible chirp's own decay (§14), widened so it can
   * be seen at one pixel per sample. Far: soft and wide. Near: sharp, narrow,
   * and starting to merge with the next one — which is what it sounds like.
   */
  private chirpDecayS(): number {
    return (
      mix(TRACKER_BEEP_DECAY_FAR_S, TRACKER_BEEP_DECAY_NEAR_S, clamp01(this.urgency)) *
      TRACE_ENVELOPE_SCALE
    );
  }

  private proxColor(): string {
    if (this._muted) return UI_COLORS.redDim;
    switch (this.band) {
      case 'contact':
      case 'near':
        return UI_COLORS.red;
      case 'closing':
        return UI_COLORS.amber;
      default:
        return UI_COLORS.green;
    }
  }

  private hrColor(): string {
    return this.bpm >= 140 ? UI_COLORS.red : this.bpm >= 105 ? UI_COLORS.amber : UI_COLORS.green;
  }

  /** One column of both lanes, appended to the ring image. */
  private pushSample(sampleDt: number): void {
    let prox: number;
    if (this._muted) {
      // Dead lane: a hair of receiver hiss so the device still looks powered.
      prox = (Math.random() - 0.5) * 0.06;
    } else if (this.solid) {
      // The shimmer runs at the tremolo you are hearing under the solid tone.
      // Held just below full deflection so the CONTACT badge stays readable
      // through it — the band is already unmistakable against a row of spikes.
      prox = 0.78 + 0.12 * Math.sin(this.elapsed * 2 * Math.PI * TRACKER_SOLID_TREMOLO_HZ);
    } else {
      prox = this.chirpEnvelope;
      this.chirpEnvelope *= Math.exp(-sampleDt / this.chirpDecayS());
    }
    const hr = ecgSample(this.hrPhase);

    const trace = this.trace;
    if (!trace) return;
    const proxY = PROX_BASE - prox * PROX_AMP;
    const hrY = HR_BASE - hr * HR_AMP;

    if (!this.tracePrimed) {
      this.tracePrimed = true;
      this.lastProxY = proxY;
      this.lastHrY = hrY;
      return;
    }

    const ctx = trace.ctx;
    const x0 = this.headX;
    const x1 = x0 + 1;
    // Erase the column we are about to draw into, in both copies. Its previous
    // contents are one full lap old and already outside the display window.
    ctx.clearRect(x0, 0, 1, SCOPE_H);
    ctx.clearRect(x0 + SCOPE_W, 0, 1, SCOPE_H);

    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';

    ctx.strokeStyle = this.proxColor();
    ctx.beginPath();
    ctx.moveTo(x0, this.lastProxY);
    ctx.lineTo(x1, proxY);
    ctx.moveTo(x0 + SCOPE_W, this.lastProxY);
    ctx.lineTo(x1 + SCOPE_W, proxY);
    ctx.stroke();

    ctx.strokeStyle = this.hrColor();
    ctx.beginPath();
    ctx.moveTo(x0, this.lastHrY);
    ctx.lineTo(x1, hrY);
    ctx.moveTo(x0 + SCOPE_W, this.lastHrY);
    ctx.lineTo(x1 + SCOPE_W, hrY);
    ctx.stroke();

    this.lastProxY = proxY;
    this.lastHrY = hrY;
    this.headX = x1 >= SCOPE_W ? 0 : x1;
  }

  /**
   * Rebuild the layers if the backing-store scale moved (a window dragged to a
   * different monitor). Returns true when anything was rebuilt.
   */
  private ensureLayers(): boolean {
    const scale = Math.max(1, Math.min(3, Math.round(globalThis.devicePixelRatio || 1)));
    if (scale === this.layerScale && this.back && this.trace && this.front) return false;

    const previous = this.trace;
    this.layerScale = scale;
    const back = makeLayer(SCOPE_W, SCOPE_H, scale);
    const trace = makeLayer(SCOPE_W * 2, SCOPE_H, scale);
    const front = makeLayer(SCOPE_W, SCOPE_H, scale);
    // The trace is the only layer that ever moves; promise the compositor that
    // up front so a scroll never triggers a raster.
    trace.canvas.style.willChange = 'transform';
    // Carry the history across at the new resolution rather than blanking the
    // scope: one scaled blit, and the player never sees the trace restart.
    if (previous) {
      trace.ctx.save();
      trace.ctx.setTransform(1, 0, 0, 1, 0, 0);
      trace.ctx.drawImage(previous.canvas, 0, 0, trace.canvas.width, trace.canvas.height);
      trace.ctx.restore();
    }
    this.back = back;
    this.trace = trace;
    this.front = front;
    // Order is the stack: graticule under the waveforms, readouts over them.
    this.frame.replaceChildren(back.canvas, trace.canvas, front.canvas);
    this.paintBack();
    this.frontBand = '';
    this.frontLit = -1;
    this.frontMuted = false;
    this.scrolledTo = -1;
    return true;
  }

  /** Static furniture. Repainted only when the backing-store scale changes. */
  private paintBack(): void {
    const layer = this.back;
    if (!layer) return;
    const ctx = layer.ctx;
    const w = SCOPE_W;
    const h = SCOPE_H;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = UI_COLORS.screen;
    ctx.fillRect(0, 0, w, h);

    // Graticule.
    ctx.strokeStyle = UI_COLORS.lineFaint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 19) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 0; y <= h; y += 18) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    // Lane divider.
    ctx.strokeStyle = UI_COLORS.line;
    ctx.beginPath();
    ctx.moveTo(0, LANE_SPLIT + 0.5);
    ctx.lineTo(w, LANE_SPLIT + 0.5);
    ctx.stroke();

    // Leading-edge cursor: the scope is live, not a picture.
    ctx.strokeStyle = 'rgba(77, 255, 155, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w - 0.5, 0);
    ctx.lineTo(w - 0.5, h);
    ctx.stroke();

    // Lane labels.
    ctx.font = uiFont(8);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.fillText('PROX', 4, 4);
    ctx.fillText('HR', 4, 58);
  }

  /**
   * The changing readout: the RATE pips, the CONTACT badge, the mute overlay.
   *
   * Repainted only when the value it shows actually changes — the pips move on
   * nine thresholds across the whole range, so in practice this runs a handful
   * of times a minute rather than sixty times a second. Returns true if it did.
   */
  private syncFront(): boolean {
    const lit = !Number.isFinite(this.metres)
      ? 0
      : this.solid
        ? PIP_COUNT
        : Math.max(1, Math.ceil(clamp01(this.urgency) * PIP_COUNT));
    const muted = this._muted;
    if (muted === this.frontMuted && (muted || (this.band === this.frontBand && lit === this.frontLit))) {
      return false;
    }
    this.frontMuted = muted;
    this.frontBand = this.band;
    this.frontLit = lit;

    const layer = this.front;
    if (!layer) return false;
    const ctx = layer.ctx;
    const w = SCOPE_W;
    ctx.clearRect(0, 0, w, SCOPE_H);

    if (this._muted) {
      ctx.fillStyle = 'rgba(4, 6, 5, 0.72)';
      ctx.fillRect(0, 0, w, LANE_SPLIT);
      ctx.font = uiFont(10, 'bold');
      ctx.fillStyle = UI_COLORS.red;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      ctx.fillText('— SIGNAL MUTED —', w / 2, 22);
      ctx.font = uiFont(8);
      ctx.fillStyle = UI_COLORS.redDim;
      ctx.fillText('SILENT AND BLIND', w / 2, 36);
      ctx.textAlign = 'left';
      return true;
    }

    ctx.textBaseline = 'top';
    if (this.solid) {
      // At contact the pips are pinned anyway; the word says it better.
      ctx.font = uiFont(9, 'bold');
      ctx.fillStyle = UI_COLORS.red;
      ctx.textAlign = 'right';
      ctx.fillText('CONTACT', PIP_RIGHT, PIP_TOP - 1);
      ctx.textAlign = 'left';
      return true;
    }

    // RATE pips. Nine steps of the same urgency the pitch and the cadence use,
    // so "the bar is filling" and "the beeps are speeding up" and "the note is
    // rising" are one fact learned three ways.
    const colour = this.proxColor();
    ctx.font = uiFont(8);
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.textAlign = 'right';
    ctx.fillText('RATE', PIP_RIGHT - PIP_SPAN - 4, PIP_TOP);
    ctx.textAlign = 'left';
    for (let i = 0; i < PIP_COUNT; i++) {
      ctx.fillStyle = i < lit ? colour : UI_COLORS.lineFaint;
      ctx.fillRect(PIP_RIGHT - PIP_SPAN + i * (PIP_W + PIP_GAP), PIP_TOP, PIP_W, PIP_H);
    }
    return true;
  }

  /**
   * Everything a frame does to the scope: keep the layers valid, repaint the
   * readout if its value moved, and hand the compositor the new scroll offset.
   * The window always ends on the newest vertex, and that vertex's mirror sits
   * exactly one scope-width right of the primary copy, so the last SCOPE_W
   * columns are contiguous wherever the head is. No blit, no re-stroke.
   */
  private refresh(): void {
    this.ensureLayers();
    this.syncFront();
    const trace = this.trace;
    if (!trace || this.scrolledTo === this.headX) return;
    this.scrolledTo = this.headX;
    trace.canvas.style.transform = SCROLL_TRANSFORMS[this.headX]!;
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    this.root.remove();
  }
}
