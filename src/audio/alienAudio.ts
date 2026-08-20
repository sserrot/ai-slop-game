/**
 * The alien, heard (DESIGN.md §5, §8).
 *
 * §5 is emphatic: "**It makes loud noise while hunting.** Non-negotiable: a
 * silent charge is unfair and reads as a bug." So while the alien is in HUNT or
 * ATTACK this module runs a *continuous* vocalisation at LOUDNESS.ALIEN_HUNT,
 * re-resolved through the §3 graph as it moves — which means it comes out of
 * the hatch it is behind, muffles when a closed hatch is between you, and gets
 * louder as it closes, all from the same propagation everything else uses.
 *
 * It also drives §8's HUNT treatment: duck the world bus, swell the sub-bass.
 *
 * The one-shot 'alien' NoiseEvents the server broadcasts are suppressed in
 * `NoiseAudio` while this loop is running, or you hear the thing twice.
 */

import { LOUDNESS } from '@shared/constants';
import type { AlienState, ModuleId, Vec3 } from '@shared/types';
import { cloneV3, v3 } from '@shared/graph/math';

import type { EventBus, Unsubscribe } from '../core/eventBus';
import { bus as defaultBus, type GameEvents } from '../core/eventBus';
import type { NoiseRuntime } from '../noise/runtime';
import type { AudioEngine, PlayingSound } from './engine';
import type { NoiseAudio } from './noiseAudio';

export interface AlienAudioOptions {
  bus?: EventBus<GameEvents>;
  /** Needed to place and attenuate the hunt loop. Without it the loop still
   *  plays, unspatialised, so a graph-less test session still hears it. */
  runtime?: NoiseRuntime | null;
  /** Suppress duplicate one-shots while the loop runs. */
  noiseAudio?: NoiseAudio | null;
  /** Source loudness of the hunt vocalisation. §14's ALIEN_HUNT (55). */
  loudness?: number;
  /** How often the loop is re-resolved through the graph, in seconds. */
  resolveIntervalS?: number;
}

const HUNTING_STATES: ReadonlySet<AlienState> = new Set<AlienState>(['HUNT', 'ATTACK']);

export class AlienAudio {
  private readonly engine: AudioEngine;
  private readonly bus: EventBus<GameEvents>;
  private readonly runtime: NoiseRuntime | null;
  private readonly noiseAudio: NoiseAudio | null;
  private readonly loudness: number;
  private readonly resolveInterval: number;

  private subscriptions: Unsubscribe[] = [];
  private state: AlienState = 'DORMANT';
  private pos: Vec3 = v3();
  private module: ModuleId = '';
  private loop: PlayingSound | null = null;
  private timer = 0;

  constructor(engine: AudioEngine, opts: AlienAudioOptions = {}) {
    this.engine = engine;
    this.bus = opts.bus ?? defaultBus;
    this.runtime = opts.runtime ?? null;
    this.noiseAudio = opts.noiseAudio ?? null;
    this.loudness = opts.loudness ?? LOUDNESS.ALIEN_HUNT;
    this.resolveInterval = opts.resolveIntervalS ?? 0.1;
  }

  attach(): Unsubscribe {
    this.detach();
    this.subscriptions.push(
      this.bus.on('alien:state', ({ to }) => this.setState(to)),
      this.bus.on('alien:moved', ({ pos, module }) => this.setPosition(pos, module)),
      this.bus.on('round:ended', () => this.setState('DORMANT')),
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

  setPosition(pos: Vec3, module: ModuleId): void {
    this.pos = cloneV3(pos);
    this.module = module;
  }

  setState(state: AlienState): void {
    if (state === this.state) return;
    this.state = state;
    const hunting = HUNTING_STATES.has(state);
    this.engine.setHunt(hunting);
    if (hunting) this.startLoop();
    else this.stopLoop();
  }

  get hunting(): boolean {
    return HUNTING_STATES.has(this.state);
  }

  /** Drive from the fixed update: re-resolves the loop as the alien moves. */
  update(dt: number): void {
    if (!this.loop) return;
    this.timer += dt;
    if (this.timer < this.resolveInterval) return;
    this.timer = 0;
    this.refresh();
  }

  private startLoop(): void {
    if (this.loop) return;
    this.noiseAudio?.setSkipped('alien', true);
    const placement = this.resolve();
    this.loop = this.engine.play({
      kind: 'alien',
      level: placement.level,
      position: placement.position,
      occluded: placement.occluded,
      bus: 'world',
      sustain: true,
      reverb: 1.1,
      // Never silent, however far away: HUNT is the one sound the player is
      // always entitled to hear, and the level still shapes how near it feels.
      gain: undefined,
    });
    if (!this.loop) {
      // Below the floor at this instant (it started on the far side of the
      // station). Force it in quietly so the loop exists and can swell.
      this.loop = this.engine.play({
        kind: 'alien',
        level: placement.level,
        position: placement.position,
        occluded: placement.occluded,
        bus: 'world',
        sustain: true,
        reverb: 1.1,
        gain: 0.0001,
      });
    }
  }

  private stopLoop(): void {
    if (!this.loop) return;
    this.loop.stop(0.6);
    this.loop = null;
    this.noiseAudio?.setSkipped('alien', false);
  }

  private refresh(): void {
    if (!this.loop) return;
    const placement = this.resolve();
    this.loop.update({
      level: placement.level,
      position: placement.position,
      occluded: placement.occluded,
    });
  }

  private resolve(): { level: number; position: Vec3 | null; occluded: boolean } {
    if (!this.runtime || this.module === '') {
      return { level: this.loudness, position: null, occluded: false };
    }
    const res = this.runtime.resolveAt(this.pos, this.module, this.loudness, 'alien');
    return {
      level: res.level,
      // §8: through a hatch, it comes from the hatch. This is what tells you
      // which way to run.
      position: res.panPosition,
      occluded: res.occluded,
    };
  }

  dispose(): void {
    this.detach();
    this.stopLoop();
  }
}
