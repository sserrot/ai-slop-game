/**
 * Being inside a hide spot (DESIGN.md §4 "Hiding", §8).
 *
 * §4 is blunt about what hiding is and is not: "Because the alien is blind,
 * hiding is not about being unseen. It is exactly two things: not being
 * physically swept through, and staying quiet." Neither of those is an audio
 * problem — the first is geometry in `@shared/graph/hideSpots`, the second is
 * `muffleDb` applied server-side to what you EMIT.
 *
 * What is left, and what this file owns, is the other direction: what reaches
 * YOU through the shell. That is not a mechanic, it is the entire feeling of
 * the verb — three feet from the thing with a locker door between you — and it
 * has to be immediate and unmistakable, because the decision it supports is
 * whether to sit still or take the two-second breach window and run.
 *
 * §8's occlusion machinery is reused wholesale rather than reinvented, exactly
 * as the brief asks. A locker is a closed hatch you are standing inside: the
 * world goes behind the same `OCCLUSION_LOWPASS_HZ` lowpass, ramped over the
 * same ~100 ms, and ducks. See `AudioBuses.setEnclosed()`.
 *
 * Your own breathing gets LOUDER, and that is the point of the whole treatment.
 * It is the one sound you cannot stop making — panicked breathing at 14 becomes
 * 6 through the shell, which decays under `ATTN_SEARCH` after three metres, and
 * `HIDE_SAFE_RADIUS_M` = 3 is derived from that. So the sound the mix pushes at
 * you while you sit in the dark is precisely the sound that will give you away
 * if it gets close enough. Nothing else needs to be said about hiding.
 *
 * The three hide VERBS — enter (8→30 by haste), exit, and the alien breaching
 * (55) — all emit real NoiseEvents and are played by the ordinary §3 path in
 * `NoiseAudio`. This file does not touch them.
 */

import type { PlayerId, PlayerState } from '@shared/types';

import type { EventBus, Unsubscribe } from '../core/eventBus';
import { bus as defaultBus, type GameEvents } from '../core/eventBus';
import type { AudioEngine, PlayingSound } from './engine';
import { hideShell } from './synth';

export interface HideAudioOptions {
  bus?: EventBus<GameEvents>;
  /**
   * Who we are, read lazily — the noise runtime learns the session id in the
   * network wiring pass, after the audio system is built.
   *
   * With it, `attach()` drives the whole treatment off `player:state` and
   * nothing else has to call anything: the controller already publishes
   * `HIDDEN` when you get in a locker. Without it, drive `setHidden()` yourself.
   */
  localPlayerId?: () => PlayerId | null;
  /** Body-bus gain of the shell bed. Almost nothing, by design. */
  shellGain?: number;
}

/** Loudness the shell bed is mixed at — it is a texture, not an event. */
const SHELL_LEVEL = 4;

export class HideAudio {
  private readonly engine: AudioEngine;
  private readonly bus: EventBus<GameEvents>;
  private readonly localPlayerId: (() => PlayerId | null) | undefined;
  private readonly shellGain: number;

  private subscriptions: Unsubscribe[] = [];
  private shell: PlayingSound | null = null;
  private _hidden = false;
  private seed = 6151;

  constructor(engine: AudioEngine, opts: HideAudioOptions = {}) {
    this.engine = engine;
    this.bus = opts.bus ?? defaultBus;
    this.localPlayerId = opts.localPlayerId;
    this.shellGain = opts.shellGain ?? 0.5;
  }

  /**
   * Follow the local player's own state machine.
   *
   * `HIDDEN` is a PlayerState in both regimes (§4), so this is one subscription
   * and it cannot drift out of step with the controller: whatever the player
   * layer decides HIDDEN means, the mix agrees with it on the same frame.
   */
  attach(): Unsubscribe {
    this.detach();
    this.subscriptions.push(
      this.bus.on('player:state', ({ id, state }) => {
        const me = this.localPlayerId?.();
        // Before the session id lands, every state event is ours: offline
        // sandbox sessions have exactly one player and no id to match against.
        if (me !== null && me !== undefined && id !== me) return;
        this.setHidden(state === ('HIDDEN' satisfies PlayerState));
      }),
      // You do not stay in the locker after either of these.
      this.bus.on('player:died', () => this.setHidden(false)),
      this.bus.on('round:started', () => this.setHidden(false)),
    );
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.detach();
    };
  }

  detach(): void {
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
  }

  get hidden(): boolean {
    return this._hidden;
  }

  /** Explicit control, if you are not going through the bus. Idempotent. */
  setHidden(hidden: boolean): void {
    if (hidden === this._hidden) return;
    this._hidden = hidden;
    this.engine.setEnclosed(hidden);
    if (hidden) this.startShell();
    else this.stopShell();
  }

  dispose(): void {
    this.detach();
    this.setHidden(false);
  }

  private startShell(): void {
    if (this.shell && !this.shell.ended) return;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this.shell = this.engine.play({
      // A locker is a place you emit from, not a sound the room makes — body
      // bus, unpanned, and it moves with you because it is around you.
      kind: 'breathing',
      level: SHELL_LEVEL,
      position: null,
      bus: 'body',
      sustain: true,
      // Bone dry: the reverb tail belongs to the module, and you are not in it.
      reverb: 0,
      gain: this.shellGain,
      source: (ctx, dest, when, opts) => hideShell(ctx, dest, when, opts.seed ?? 211),
      seed: this.seed % 9973,
    });
  }

  private stopShell(): void {
    this.shell?.stop(0.18);
    this.shell = null;
  }
}
