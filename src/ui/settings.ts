/**
 * ISS — comfort options (DESIGN.md §4, §13).
 *
 * "Motion sickness comfort options ship in M0, not as a later pass: roll-lock
 * (fixed horizon), snap-turn, FOV slider, and a vignette that tightens with
 * angular velocity." §13 lists motion sickness as a risk that costs you
 * players, so these are not buried in an options tree — they are one button
 * away from the menu and they persist between sessions.
 *
 * The shape is `ComfortOptions` from `@shared/types`; this panel only edits it
 * and hands it back. Applying it is the camera's job (`onChange`).
 */

import {
  FLASHLIGHT_SCALE_DEFAULT,
  FLASHLIGHT_SCALE_MAX,
  FLASHLIGHT_SCALE_MIN,
} from '@shared/constants';
import type { ComfortOptions } from '@shared/types';
import { el, listen } from './dom';

/**
 * Defaults chosen for the queasiest plausible player, because in zero-g the
 * worst case is the one that stops someone playing: horizon locked, snap turn
 * on, a conservative FOV, and half vignette.
 */
export const DEFAULT_COMFORT: ComfortOptions = Object.freeze({
  rollLock: true,
  snapTurnDegrees: 30,
  fovDegrees: 80,
  vignetteStrength: 0.5,
  flashlightIntensity: FLASHLIGHT_SCALE_DEFAULT,
  // §4: the authored 4.5 cm bob. It ships ON because walking without it reads
  // as gliding, and unlike the other four this one is trivially turned off — a
  // queasy player finds it in one click. It never changes emitted noise, in
  // either direction (§4, and the label says so).
  headBob: 1,
});

export const FOV_MIN = 60;
export const FOV_MAX = 110;
/** The torch trim's slider step. 5% is below the just-noticeable difference on
 *  a 2 m wall, so nobody can land on a value they cannot see the effect of. */
const TORCH_STEP = 0.05;
/** 0 means smooth turning. */
export const SNAP_TURN_CHOICES: readonly number[] = [0, 15, 30, 45];

const STORAGE_KEY = 'iss.comfort';

/**
 * The graphics row (§9).
 *
 * Separate from `ComfortOptions` on purpose: that shape is a shared contract
 * the camera and the noise layer also read, and a render preset has no business
 * in it. `auto` means "let the frame guard choose"; the other three pin it.
 *
 * This row exists because the guard can move the preset on its own. Before it,
 * a player the guard had dropped to `low` — DPR 1, no bloom, a 512² shadow map
 * — could not see that it had happened, could not undo it, and could not tell
 * anyone which level they had been playing on.
 */
export type GraphicsChoice = 'auto' | 'low' | 'medium' | 'high';

const GRAPHICS_CHOICES: readonly GraphicsChoice[] = ['auto', 'low', 'medium', 'high'];
const GRAPHICS_KEY = 'iss.graphics';

function isGraphicsChoice(value: unknown): value is GraphicsChoice {
  return typeof value === 'string' && (GRAPHICS_CHOICES as readonly string[]).includes(value);
}

/** Read the saved graphics choice. Never throws — a blocked localStorage is fine. */
export function loadGraphicsChoice(key: string = GRAPHICS_KEY): GraphicsChoice {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return isGraphicsChoice(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

/** Persist the graphics choice. Never throws. */
export function saveGraphicsChoice(choice: GraphicsChoice, key: string = GRAPHICS_KEY): void {
  try {
    globalThis.localStorage?.setItem(key, choice);
  } catch {
    /* private mode, disabled storage — the session's choice still applies. */
  }
}

function sanitise(partial: Partial<ComfortOptions> | null | undefined): ComfortOptions {
  const p = partial ?? {};
  const snap = Number(p.snapTurnDegrees ?? DEFAULT_COMFORT.snapTurnDegrees);
  return {
    rollLock: Boolean(p.rollLock ?? DEFAULT_COMFORT.rollLock),
    snapTurnDegrees: SNAP_TURN_CHOICES.includes(snap) ? snap : DEFAULT_COMFORT.snapTurnDegrees,
    fovDegrees: Math.min(
      FOV_MAX,
      Math.max(FOV_MIN, Number(p.fovDegrees ?? DEFAULT_COMFORT.fovDegrees)),
    ),
    vignetteStrength: Math.min(
      1,
      Math.max(0, Number(p.vignetteStrength ?? DEFAULT_COMFORT.vignetteStrength)),
    ),
    headBob: clamp01(Number(p.headBob ?? DEFAULT_COMFORT.headBob), DEFAULT_COMFORT.headBob),
    // Clamped to the same window the light itself clamps to (§14), so what the
    // slider shows is what the torch does — and a corrupt or hand-edited
    // localStorage value can never hand the renderer a NaN.
    flashlightIntensity: clampTorch(
      Number(p.flashlightIntensity ?? DEFAULT_COMFORT.flashlightIntensity),
    ),
  };
}

function clampTorch(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMFORT.flashlightIntensity;
  return Math.min(FLASHLIGHT_SCALE_MAX, Math.max(FLASHLIGHT_SCALE_MIN, value));
}

/** 0–1, with a fallback for a corrupt or hand-edited localStorage value. */
function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Read saved comfort options. Never throws — a blocked localStorage is fine. */
export function loadComfortOptions(key: string = STORAGE_KEY): ComfortOptions {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return { ...DEFAULT_COMFORT };
    return sanitise(JSON.parse(raw) as Partial<ComfortOptions>);
  } catch {
    return { ...DEFAULT_COMFORT };
  }
}

/** Persist comfort options. Never throws. */
export function saveComfortOptions(options: ComfortOptions, key: string = STORAGE_KEY): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(options));
  } catch {
    /* private mode, disabled storage — the session's settings still apply. */
  }
}

export interface SettingsPanelOptions {
  parent: HTMLElement;
  /** Fires on every edit, already sanitised. Wire this to the camera rig. */
  onChange?: (options: ComfortOptions) => void;
  /** Graphics row changed (also fired once at construction with the saved choice). */
  onGraphicsChange?: (choice: GraphicsChoice) => void;
  onClose?: () => void;
  initial?: Partial<ComfortOptions>;
  storageKey?: string;
  /** localStorage key for the graphics row. */
  graphicsKey?: string;
  startVisible?: boolean;
}

export class SettingsPanel {
  readonly root: HTMLDivElement;

  private readonly storageKey: string;
  private readonly graphicsKey: string;
  private readonly onChange: ((options: ComfortOptions) => void) | null;
  private readonly onGraphicsChange: ((choice: GraphicsChoice) => void) | null;
  private readonly onClose: (() => void) | null;
  private readonly disposers: (() => void)[] = [];

  private readonly rollButton: HTMLButtonElement;
  private readonly snapSelect: HTMLSelectElement;
  private readonly fovRange: HTMLInputElement;
  private readonly fovValue: HTMLSpanElement;
  private readonly vignetteRange: HTMLInputElement;
  private readonly vignetteValue: HTMLSpanElement;
  private readonly bobRange: HTMLInputElement;
  private readonly bobValue: HTMLSpanElement;
  private readonly torchRange: HTMLInputElement;
  private readonly torchValue: HTMLSpanElement;
  private readonly graphicsSelect: HTMLSelectElement;
  private readonly graphicsValue: HTMLSpanElement;

  private current: ComfortOptions;
  private currentGraphics: GraphicsChoice;
  /** What the renderer is ACTUALLY running, which under `auto` is not the choice. */
  private activeQuality = '';
  private _visible: boolean;

  constructor(opts: SettingsPanelOptions) {
    this.storageKey = opts.storageKey ?? STORAGE_KEY;
    this.graphicsKey = opts.graphicsKey ?? GRAPHICS_KEY;
    this.onChange = opts.onChange ?? null;
    this.onGraphicsChange = opts.onGraphicsChange ?? null;
    this.onClose = opts.onClose ?? null;
    this.current = sanitise({ ...loadComfortOptions(this.storageKey), ...opts.initial });
    this.currentGraphics = loadGraphicsChoice(this.graphicsKey);

    // ---- roll lock -------------------------------------------------------
    this.rollButton = el('button', {
      class: 'iss-switch',
      attrs: { type: 'button' },
      text: 'ON',
    });
    const rollField = this.field(
      'Roll lock',
      this.rollButton,
      null,
      'Keeps a fixed horizon while you tumble. Off is more honest zero-g and much harder on the stomach.',
    );

    // ---- snap turn -------------------------------------------------------
    this.snapSelect = el('select');
    for (const deg of SNAP_TURN_CHOICES) {
      this.snapSelect.appendChild(
        el('option', { text: deg === 0 ? 'SMOOTH' : `${deg}°`, attrs: { value: String(deg) } }),
      );
    }
    const snapField = this.field(
      'Snap turn',
      this.snapSelect,
      null,
      'Rotate in discrete steps instead of sweeping the camera.',
    );

    // ---- FOV -------------------------------------------------------------
    this.fovRange = el('input', {
      attrs: {
        type: 'range',
        min: String(FOV_MIN),
        max: String(FOV_MAX),
        step: '1',
      },
    });
    this.fovValue = el('span', { class: 'iss-field__value' });
    const fovField = this.field(
      'Field of view',
      this.fovRange,
      this.fovValue,
      'Wider sees more of the module. Narrower is calmer.',
    );

    // ---- vignette --------------------------------------------------------
    this.vignetteRange = el('input', {
      attrs: { type: 'range', min: '0', max: '100', step: '5' },
    });
    this.vignetteValue = el('span', { class: 'iss-field__value' });
    const vignetteField = this.field(
      'Vignette',
      this.vignetteRange,
      this.vignetteValue,
      'Tightens with angular velocity — the single most effective anti-nausea trick there is.',
    );

    // ---- head bob --------------------------------------------------------
    // §4: "a bob one player reads as atmosphere another reads as nausea." The
    // hint states the guarantee out loud because §4 requires it to: a comfort
    // setting that changed what the alien hears would make an accessibility
    // option a competitive one.
    this.bobRange = el('input', {
      attrs: { type: 'range', min: '0', max: '100', step: '5' },
    });
    this.bobValue = el('span', { class: 'iss-field__value' });
    const bobField = this.field(
      'Head bob',
      this.bobRange,
      this.bobValue,
      'How much the camera rocks as you walk. Turn it down or off — it changes nothing the alien can hear.',
    );

    // ---- flashlight trim -------------------------------------------------
    // §9 makes the torch the only thing keeping the dark out, and panels vary
    // enormously in how much of a 0.03-luma frame they actually show. This is
    // the one brightness control in the game; it multiplies §14's authored
    // intensity and never touches decay, range or cone.
    this.torchRange = el('input', {
      attrs: {
        type: 'range',
        min: String(Math.round(FLASHLIGHT_SCALE_MIN * 100)),
        max: String(Math.round(FLASHLIGHT_SCALE_MAX * 100)),
        step: String(Math.round(TORCH_STEP * 100)),
      },
    });
    this.torchValue = el('span', { class: 'iss-field__value' });
    const torchField = this.field(
      'Flashlight',
      this.torchRange,
      this.torchValue,
      'Brightness of your torch. Turn it up if the station is unreadable on your screen — it changes nothing the alien can hear.',
    );

    // ---- graphics --------------------------------------------------------
    // §9 targets 60 fps on a mid-range laptop and the frame guard enforces it
    // by moving this. AUTO is the default and the right answer for almost
    // everyone; the three fixed levels exist so a player who has been dropped
    // can climb back out, and so anyone reporting a frame rate can say which
    // level they were on. The value readout shows what is RUNNING, not what was
    // asked for — under AUTO those differ, and that difference is the point.
    this.graphicsSelect = el('select');
    for (const choice of GRAPHICS_CHOICES) {
      this.graphicsSelect.appendChild(
        el('option', {
          text: choice === 'auto' ? 'AUTO' : choice.toUpperCase(),
          attrs: { value: choice },
        }),
      );
    }
    this.graphicsValue = el('span', { class: 'iss-field__value' });
    const graphicsField = this.field(
      'Graphics',
      this.graphicsSelect,
      this.graphicsValue,
      'AUTO drops the preset when frames get long and raises it again when they do not. Pin it if you would rather choose.',
    );

    const closeButton = el('button', {
      class: 'iss-btn iss-btn--primary',
      text: 'Done',
      attrs: { type: 'button' },
    });
    const resetButton = el('button', {
      class: 'iss-btn iss-btn--ghost',
      text: 'Reset to defaults',
      attrs: { type: 'button' },
    });

    const screen = el('div', {
      class: 'iss-screen iss-settings',
      children: [
        el('div', {
          class: 'iss-screen__eyebrow',
          children: [
            el('span', { text: 'COMFORT & CONTROLS' }),
            el('span', { text: 'SAVED LOCALLY' }),
          ],
        }),
        el('h1', {
          class: 'iss-screen__title',
          style: { fontSize: '26px', letterSpacing: '0.2em' },
          text: 'Comfort',
        }),
        el('p', {
          class: 'iss-screen__sub',
          // r2: pillar 2 is the gait dial now, and zero-g is a per-module
          // condition. The old copy read "Zero-g is the risk system", which is
          // the exact sentence the pivot reversed.
          text: 'Most of a round is walking on a floor. Tune the rest before you launch.',
        }),
        rollField,
        snapField,
        fovField,
        vignetteField,
        bobField,
        torchField,
        graphicsField,
        el('div', { class: 'iss-actions', children: [closeButton, resetButton] }),
      ],
    });

    this.root = el('div', { class: 'iss-overlay iss-scan', children: [screen] });
    opts.parent.appendChild(this.root);

    this.disposers.push(
      listen(this.rollButton, 'click', () => {
        this.apply({ rollLock: !this.current.rollLock });
      }),
      listen(this.snapSelect, 'change', () => {
        this.apply({ snapTurnDegrees: Number(this.snapSelect.value) });
      }),
      listen(this.fovRange, 'input', () => {
        this.apply({ fovDegrees: Number(this.fovRange.value) });
      }),
      listen(this.vignetteRange, 'input', () => {
        this.apply({ vignetteStrength: Number(this.vignetteRange.value) / 100 });
      }),
      listen(this.bobRange, 'input', () => {
        this.apply({ headBob: Number(this.bobRange.value) / 100 });
      }),
      listen(this.torchRange, 'input', () => {
        this.apply({ flashlightIntensity: Number(this.torchRange.value) / 100 });
      }),
      listen(this.graphicsSelect, 'change', () => {
        const value = this.graphicsSelect.value;
        this.applyGraphics(isGraphicsChoice(value) ? value : 'auto');
      }),
      listen(resetButton, 'click', () => this.apply({ ...DEFAULT_COMFORT })),
      listen(closeButton, 'click', () => {
        this.hide();
        this.onClose?.();
      }),
    );

    this._visible = opts.startVisible ?? false;
    this.root.hidden = !this._visible;
    this.syncUi();
    // Announce the loaded settings so the camera starts in the right state.
    this.onChange?.({ ...this.current });
    this.onGraphicsChange?.(this.currentGraphics);
  }

  private field(
    label: string,
    control: HTMLElement,
    value: HTMLElement | null,
    hint: string,
  ): HTMLDivElement {
    return el('div', {
      class: 'iss-field',
      children: [
        el('span', { class: 'iss-field__label', text: label }),
        control,
        value ?? el('span', { class: 'iss-field__value' }),
        el('span', { class: 'iss-field__hint', text: hint }),
      ],
    });
  }

  get options(): ComfortOptions {
    return { ...this.current };
  }

  /** The player's graphics choice — `auto` unless they pinned a level. */
  get graphics(): GraphicsChoice {
    return this.currentGraphics;
  }

  /** Set the graphics row, persist it, notify. */
  applyGraphics(choice: GraphicsChoice): void {
    this.currentGraphics = choice;
    saveGraphicsChoice(choice, this.graphicsKey);
    this.syncGraphicsUi();
    this.onGraphicsChange?.(choice);
  }

  /**
   * Report what the renderer is actually running.
   *
   * Under `auto` this is not the same as the choice, and the difference is the
   * whole reason the row exists: a silent drop now reads "RUNNING LOW" next to
   * a select that still says AUTO, instead of the game just quietly getting
   * uglier with no explanation and no way back.
   */
  setActiveQuality(level: string): void {
    this.activeQuality = level;
    this.syncGraphicsUi();
  }

  /** Merge a change, persist it, sync the controls and notify. */
  apply(partial: Partial<ComfortOptions>): void {
    this.current = sanitise({ ...this.current, ...partial });
    this.syncUi();
    saveComfortOptions(this.current, this.storageKey);
    this.onChange?.({ ...this.current });
  }

  private syncUi(): void {
    this.rollButton.textContent = this.current.rollLock ? 'ON' : 'OFF';
    this.rollButton.dataset.on = String(this.current.rollLock);
    this.snapSelect.value = String(this.current.snapTurnDegrees);
    this.fovRange.value = String(this.current.fovDegrees);
    this.fovValue.textContent = `${Math.round(this.current.fovDegrees)}°`;
    this.vignetteRange.value = String(Math.round(this.current.vignetteStrength * 100));
    this.vignetteValue.textContent =
      this.current.vignetteStrength <= 0 ? 'OFF' : `${Math.round(this.current.vignetteStrength * 100)}%`;
    this.bobRange.value = String(Math.round(this.current.headBob * 100));
    this.bobValue.textContent =
      this.current.headBob <= 0 ? 'OFF' : `${Math.round(this.current.headBob * 100)}%`;
    this.torchRange.value = String(Math.round(this.current.flashlightIntensity * 100));
    this.torchValue.textContent = `${Math.round(this.current.flashlightIntensity * 100)}%`;
    this.syncGraphicsUi();
  }

  private syncGraphicsUi(): void {
    this.graphicsSelect.value = this.currentGraphics;
    const running = this.activeQuality.toUpperCase();
    if (!running) {
      this.graphicsValue.textContent = this.currentGraphics === 'auto' ? 'AUTO' : '';
      return;
    }
    // Only worth spelling out under AUTO, where the two can disagree.
    this.graphicsValue.textContent = this.currentGraphics === 'auto' ? `RUNNING ${running}` : running;
  }

  get visible(): boolean {
    return this._visible;
  }

  show(): void {
    this._visible = true;
    this.root.hidden = false;
  }

  hide(): void {
    this._visible = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this._visible) this.hide();
    else this.show();
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    this.root.remove();
  }
}
