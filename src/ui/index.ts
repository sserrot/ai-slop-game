/**
 * ISS — UI subsystem (DESIGN.md §6).
 *
 * Diegetic by default; four HUD elements and nothing else:
 *
 *   1. WRIST TRACKER   bottom-left, proximity as pulse rate + heart rate + crew
 *   2. NOISE RING      around the crosshair, scaled to how far a sound carried
 *   3. CROSSHAIR       dot / hand / rail, plus the push-off charge arc — and
 *                      under it the interact prompt, which is the same element:
 *                      the glyph says "something is here", the prompt names the
 *                      bound key, the verb and the §11 noise price. Not a fifth
 *                      element; the caption on the third.
 *   4. PUZZLE PANELS   CanvasTexture planes in the world, 10 Hz, module-gated
 *
 * Plus three screens that are not HUD: the main menu (which states the alien's
 * rules and the Discord contract outright), comfort options, and the round
 * report. All of it is DOM/CSS and 2D canvas — there is no second WebGL scene
 * anywhere in this directory, which is the call §6 makes explicitly.
 *
 * Usage:
 *
 *     import { createUI } from './ui';
 *
 *     const ui = createUI({
 *       onStart: () => startRound(),
 *       onComfortChange: (c) => camera.applyComfort(c),
 *       onTrackerBeep: (beep) => net.emitNoise('tracker-beep', player.pos, player.module),
 *     });
 *     scene.add(ui.panels.group);
 *     ticker.onRender((_alpha, frameDt) => ui.update(frameDt));
 */

import './hud.css';

import { MAX_PLAYERS } from '@shared/constants';
import type { ComfortOptions, ModuleId } from '@shared/types';
import { bus as sharedBus, type EventBus, type GameEvents, type Unsubscribe } from '../core/eventBus';
import { Crosshair, type CrosshairState } from './crosshair';
import { el, resolveMount } from './dom';
import { InteractPrompt, type InteractPromptSpec, type PromptSlot } from './interactPrompt';
import { MainMenu, type ControlRow } from './menu';
import { NoiseRing } from './noiseRing';
import { PanelSystem } from './panel';
import { ResultsScreen } from './results';
import { SettingsPanel, type GraphicsChoice } from './settings';
import { ToastLayer } from './toast';
import { WristTracker, type TrackerBeepHandler } from './wristTracker';

export interface GameUiOptions {
  /** HUD host. Defaults to `#hud` from index.html (pointer-events: none). */
  hud?: HTMLElement | string;
  /** Overlay host. Defaults to `#menu` from index.html (interactive). */
  menu?: HTMLElement | string;
  /** Event bus. Defaults to the shared one; pass `null` to wire nothing. */
  bus?: EventBus<GameEvents> | null;
  /** Fired on every tracker chirp — wire to the noise emitter and local audio. */
  onTrackerBeep?: TrackerBeepHandler;
  /** "Begin round" pressed. */
  onStart?: () => void;
  /** Comfort options changed (also fired once at construction with the saved set). */
  onComfortChange?: (options: ComfortOptions) => void;
  /** Graphics row changed (also fired once at construction with the saved choice). */
  onGraphicsChange?: (choice: GraphicsChoice) => void;
  /** "Run it back" on the results screen. */
  onAgain?: () => void;
  /** Crew size for the tracker's alive counter and the results screen. */
  crewTotal?: number;
  /** `KeyboardEvent.code` for tracker mute. Default 'KeyM'; `null` binds nothing. */
  muteKey?: string | null;
  /** Override the menu's control list. */
  controls?: readonly ControlRow[];
  startMuted?: boolean;
  /** Show the results screen automatically on `round:ended`. Default true. */
  autoResults?: boolean;
  /** Start with the main menu up. Default true. */
  startInMenu?: boolean;
}

/**
 * The whole UI, wired together. One `update()` per frame drives every animated
 * part of it; everything else reacts to the event bus.
 */
export class GameUI {
  readonly hudRoot: HTMLDivElement;
  readonly menuHost: HTMLElement;

  readonly crosshair: Crosshair;
  readonly interactPrompt: InteractPrompt;
  readonly noiseRing: NoiseRing;
  readonly tracker: WristTracker;
  readonly toasts: ToastLayer;
  readonly panels: PanelSystem;
  readonly menu: MainMenu;
  readonly settings: SettingsPanel;
  readonly results: ResultsScreen;

  private readonly disposers: Unsubscribe[] = [];
  private readonly crewTotal: number;
  private hudHidden = false;
  private menuHostHidden = false;

  constructor(opts: GameUiOptions = {}) {
    const bus = opts.bus === undefined ? sharedBus : opts.bus;
    const hudHost = resolveMount(opts.hud, 'hud');
    this.menuHost = resolveMount(opts.menu, 'menu');
    this.crewTotal = opts.crewTotal ?? MAX_PLAYERS;

    this.hudRoot = el('div', { class: 'iss-hud' });
    hudHost.appendChild(this.hudRoot);

    // ---- HUD (§6) --------------------------------------------------------
    this.noiseRing = new NoiseRing({ parent: this.hudRoot, bus });
    this.crosshair = new Crosshair({ parent: this.hudRoot, bus });
    // Under the reticle, and after it in the DOM so it stacks on top: the
    // crosshair says "something is here", this says which key and what it costs.
    this.interactPrompt = new InteractPrompt({ parent: this.hudRoot });
    this.tracker = new WristTracker({
      parent: this.hudRoot,
      bus,
      onBeep: opts.onTrackerBeep,
      crewTotal: opts.crewTotal,
      muteKey: opts.muteKey,
      startMuted: opts.startMuted,
    });
    this.toasts = new ToastLayer({ parent: this.hudRoot, bus });
    this.panels = new PanelSystem({ bus });

    // ---- screens ---------------------------------------------------------
    this.settings = new SettingsPanel({
      parent: this.menuHost,
      onChange: opts.onComfortChange,
      onGraphicsChange: opts.onGraphicsChange,
      onClose: () => {
        if (!this.results.visible) this.menu.show();
      },
    });

    this.menu = new MainMenu({
      parent: this.menuHost,
      controls: opts.controls,
      startVisible: opts.startInMenu ?? true,
      onStart: () => {
        this.menu.hide();
        opts.onStart?.();
      },
      onSettings: () => {
        this.menu.hide();
        this.settings.show();
      },
    });

    this.results = new ResultsScreen({
      parent: this.menuHost,
      onAgain: opts.onAgain
        ? () => {
            this.results.hide();
            opts.onAgain?.();
          }
        : undefined,
      onMenu: () => {
        this.results.hide();
        this.menu.show();
      },
    });

    if (bus && (opts.autoResults ?? true)) {
      this.disposers.push(
        bus.on('round:ended', (result) => {
          this.results.show(result, { crewTotal: this.crewTotal });
        }),
      );
    }

    this.syncOverlayHost();
  }

  // ------------------------------------------------------------------ frame --

  /**
   * Advance every animated element. Call once per rendered frame.
   *
   * @param dt    seconds since the previous frame
   * @param nowMs `performance.now()`; defaults to reading it here
   */
  update(dt: number, nowMs: number = performance.now()): void {
    this.tracker.update(dt);
    this.noiseRing.update(dt);
    this.interactPrompt.update(dt);
    this.toasts.update(dt);
    this.panels.update(nowMs);
    this.syncOverlayHost();
  }

  /**
   * `#menu` covers the screen and swallows pointer events, so it must be
   * `hidden` whenever no screen is up. The HUD hides underneath any screen.
   */
  private syncOverlayHost(): void {
    const anyScreen = this.menu.visible || this.settings.visible || this.results.visible;
    // The prompt keeps its target but stops rendering behind a screen. Hiding
    // the HUD root already does that; this is belt and braces for a caller that
    // drives the prompt directly without going through `setHudVisible`.
    this.interactPrompt.setSuppressed(anyScreen);
    const hideHost = !anyScreen;
    if (hideHost !== this.menuHostHidden) {
      this.menuHostHidden = hideHost;
      this.menuHost.hidden = hideHost;
    }
    if (anyScreen !== this.hudHidden) {
      this.hudHidden = anyScreen;
      this.hudRoot.style.display = anyScreen ? 'none' : '';
    }
  }

  // ---------------------------------------------------------------- helpers --

  /** Reticle state from the interaction raycaster (§6). */
  setCrosshair(state: CrosshairState): void {
    this.crosshair.setState(state);
  }

  /** Push-off charge 0–1 (also arrives automatically via `player:charge`). */
  setCharge(charge: number): void {
    this.crosshair.setCharge(charge);
  }

  /**
   * What the interaction raycaster is on, priced (§6, §11) — or `null` for
   * nothing in reach.
   *
   * Call it every frame right next to `setCrosshair`; an unchanged spec costs a
   * handful of comparisons and touches no DOM. Build the spec from `PROMPT` so
   * the loudness and hold-time numbers keep coming out of §14 rather than out
   * of a caller.
   */
  setInteractPrompt(spec: InteractPromptSpec | null): void {
    this.interactPrompt.set(spec);
  }

  /**
   * A prompt's key is down — fills that line's hold bar (`pry`, `pump`, the
   * breaker override, an undock lever).
   *
   * `slot` picks which line of a §11 dual path: `'alt'` is the quiet-slow one,
   * the hand pump drawn under the pry bar.
   */
  setInteractHolding(active: boolean, slot: PromptSlot = 'primary'): void {
    this.interactPrompt.setHolding(active, slot);
  }

  /** Ripple the noise ring for a sound the local player made. */
  pulseNoise(carriedMetres: number, loudness: number): void {
    this.noiseRing.pulse(carriedMetres, loudness);
  }

  /** Distance to the alien, in metres — becomes a pulse rate, never a readout. */
  setAlienProximity(metres: number): void {
    this.tracker.setProximity(metres);
  }

  /** Client-side heart-rate estimate. Ignored once the server's is in hand. */
  setHeartRate(bpm: number): void {
    this.tracker.setHeartRate(bpm);
  }

  /**
   * The server's heart rate for the local player — `net.localPlayer()?.heartRate`.
   *
   * §6 makes the tracker's second trace the tutorial for the breathing mechanic,
   * and the server owns the model that decides when you breathe and how loud.
   * Feed this every tick and the trace stops teaching a curve the alien cannot
   * hear (the client model in `src/player/heartRate.ts` has an exertion term and
   * a different range).
   */
  setServerHeartRate(bpm: number): void {
    this.tracker.setServerHeartRate(bpm);
  }

  /** Our own session id, so the noise ring can recognise its own events. It is
   *  learned from `net:connected` automatically; this is the manual override. */
  setLocalPlayer(id: string | null): void {
    this.noiseRing.setLocalPlayer(id);
  }

  setCrew(alive: number, total?: number): void {
    this.tracker.setCrew(alive, total);
  }

  /** The local player changed module: gate the panels (§6). */
  setPlayerModule(module: ModuleId | null): void {
    this.panels.setPlayerModule(module);
  }

  get comfort(): ComfortOptions {
    return this.settings.options;
  }

  /** The player's graphics choice (§9) — `auto` unless they pinned a level. */
  get graphics(): GraphicsChoice {
    return this.settings.graphics;
  }

  /**
   * Report the quality level the renderer is actually running (§9).
   *
   * Wire this to `renderer.onQualityChange`. The panel already knows whether
   * the player asked for AUTO, so it can say which of the two moved it.
   */
  setQuality(level: string): void {
    this.settings.setActiveQuality(level);
  }

  toast(text: string, ms?: number): void {
    this.toasts.push(text, ms);
  }

  showMenu(): void {
    this.results.hide();
    this.settings.hide();
    this.menu.show();
    this.syncOverlayHost();
  }

  hideMenu(): void {
    this.menu.hide();
    this.settings.hide();
    this.results.hide();
    this.syncOverlayHost();
  }

  showSettings(): void {
    this.menu.hide();
    this.settings.show();
    this.syncOverlayHost();
  }

  /** True while any full-screen screen is up — pointer lock should be released. */
  get inScreen(): boolean {
    return this.menu.visible || this.settings.visible || this.results.visible;
  }

  setHudVisible(visible: boolean): void {
    this.hudHidden = !visible;
    this.hudRoot.style.display = visible ? '' : 'none';
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    this.crosshair.dispose();
    this.interactPrompt.dispose();
    this.noiseRing.dispose();
    this.tracker.dispose();
    this.toasts.dispose();
    this.panels.dispose();
    this.menu.dispose();
    this.settings.dispose();
    this.results.dispose();
    this.hudRoot.remove();
  }
}

/** Build the UI. See `GameUiOptions`. */
export function createUI(opts: GameUiOptions = {}): GameUI {
  return new GameUI(opts);
}

// ---------------------------------------------------------------------------
// Re-exports — the puzzle, player and audio agents import from '../ui'.
// ---------------------------------------------------------------------------

export { Crosshair, type CrosshairOptions, type CrosshairState } from './crosshair';
export {
  InteractPrompt,
  PROMPT,
  formatSeconds,
  type InteractPromptOptions,
  type InteractPromptSpec,
  type PromptKey,
  type PromptSlot,
} from './interactPrompt';
export { NoiseRing, NOISE_RING_REFERENCE_M, type NoiseRingOptions } from './noiseRing';
export {
  WristTracker,
  beepInterval,
  isSolidTone,
  type TrackerBeep,
  type TrackerBeepHandler,
  type WristTrackerOptions,
} from './wristTracker';
export {
  TRACKER_EMIT_INTERVAL_MIN_S,
  isTrackerSolid,
  trackerBeepInterval,
  trackerEmitInterval,
  trackerUrgency,
} from './trackerCadence';
export {
  Panel,
  PanelSystem,
  panelBackground,
  panelBanner,
  panelBar,
  panelBezel,
  panelGauge,
  panelLamp,
  panelScanlines,
  panelSwitch,
  panelText,
  type BarOptions,
  type GaugeOptions,
  type PanelDraw,
  type PanelFrame,
  type PanelOptions,
  type PanelRegion,
  type PanelSystemOptions,
  type PanelTextOptions,
  type SwitchOptions,
} from './panel';
export { MainMenu, DEFAULT_CONTROLS, type ControlRow, type MainMenuOptions } from './menu';
export {
  SettingsPanel,
  DEFAULT_COMFORT,
  FOV_MIN,
  FOV_MAX,
  SNAP_TURN_CHOICES,
  loadComfortOptions,
  saveComfortOptions,
  loadGraphicsChoice,
  saveGraphicsChoice,
  type GraphicsChoice,
  type SettingsPanelOptions,
} from './settings';
export {
  ResultsScreen,
  rankOutcome,
  type OutcomeRank,
  type ResultsScreenOptions,
  type ResultsShowOptions,
} from './results';
export { ToastLayer, type ToastLayerOptions } from './toast';
export {
  UI_COLORS,
  UI_FONT,
  uiFont,
  loudnessBand,
  loudnessColor,
  loudnessRgba,
  type LoudnessBand,
} from './theme';
export { HiDpiCanvas, el, svgEl, listen, formatDuration, resolveMount } from './dom';
