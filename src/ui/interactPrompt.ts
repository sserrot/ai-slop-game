/**
 * ISS — the interact prompt (DESIGN.md §6, §11).
 *
 * §6 gives the crosshair a `hand` state for "there is something here", and a
 * playtester read it as decoration: the affordance said *something* was in
 * reach and never said which key, which verb, or what it would cost. This is
 * the missing half — a line under the reticle that names the bound key, the
 * verb, and the noise price.
 *
 * Four rules it is built to:
 *
 * 1. **NOTHING HARDCODES A KEY.** §4 makes the keymap the single source of
 *    bindings and lets the player rebind at runtime, so the label is resolved
 *    from `KEYMAP` every frame (a Map lookup and a string compare — the DOM is
 *    only touched when the label actually changed). Rebind E to F and the
 *    prompt says F on the next frame with nothing else to notify.
 * 2. **THE PRICE IS PART OF THE AFFORDANCE.** §11's dual-path rule is that a
 *    loud-fast option sits next to a quiet-slow one, and a player can only
 *    *choose* if they can see both halves of the trade. So a spec carries
 *    loudness and duration — and it can carry an `alt`, which is how a jammed
 *    locker shows `HOLD 3S [V] PRY ))60` and `HOLD 25S [B] PUMP ))6` at the
 *    same time, stacked, instead of making the player guess that a second
 *    option exists. Every number comes from `LOUDNESS` / §14, never a literal
 *    typed here.
 * 3. **A HOLD READS AS A HOLD.** The verbs that must be held say so and fill a
 *    bar; the verbs that commit you for a while after one press (climbing into
 *    a hide spot) print the duration without the word, because telling a player
 *    to hold a key that is already doing the thing teaches a wrong model.
 * 4. **UNOBTRUSIVE, AND IT FADES.** This is a horror game. It is a hairline row
 *    of dim phosphor 40 px under the crosshair, it never pops, and it is gone
 *    the instant there is no target.
 *
 * It takes what it is given. There is no raycast in this file and no reference
 * to the scene graph — §9 keeps render and UI decoupled and the prompt is not
 * the place to start reaching across.
 */

import {
  BREAKER_OVERRIDE_TIME_S,
  HAND_PUMP_TIME_S,
  LOUDNESS,
  PRY_TIME_S,
  UNDOCK_HOLD_S,
} from '@shared/constants';
import { KEYMAP, codeLabel, primaryCode, type Keymap, type PlayerAction } from '../player/keymap';
import { el } from './dom';
import { clamp01, loudnessBand } from './theme';

// ---------------------------------------------------------------------------
// The interface the interaction raycaster hands us
// ---------------------------------------------------------------------------

/**
 * Which key performs the verb.
 *
 * Normally a `PlayerAction` — the prompt then reads the live binding out of
 * `KEYMAP` and follows a rebind for free. The `{ code }` form is the escape
 * hatch for a verb the keymap has no action for yet: the caller passes the
 * `KeyboardEvent.code` it actually bound and we still label it through
 * `codeLabel()` rather than inventing a glyph. Nothing in `PROMPT` uses it any
 * more — the pry bar and the hand pump were the last two, and they are real
 * `KEYMAP` actions now — so prefer the action form; see the note on `PROMPT`.
 */
export type PromptKey = PlayerAction | { readonly code: string };

/**
 * One offered action, priced. Deliberately narrow: an id, words, a key, and the
 * two numbers §11 needs. Nothing in it is a scene object.
 */
export interface InteractPromptSpec {
  /**
   * Stable identity for the thing being offered — `${module}:${propId}`, a
   * puzzle region id, a hide-spot key. Only used to notice that the target
   * changed, so it need only be stable while the player is looking at it.
   */
  readonly id: string;
  /** Short verb, lowercase: 'open', 'read', 'pry', 'stow', 'seal'. */
  readonly verb: string;
  /** What is being acted on: 'locker', 'card', 'cargo bag'. Optional. */
  readonly noun?: string;
  /** Which key does it. Defaults to the `interact` action (E out of the box). */
  readonly key?: PromptKey;
  /**
   * Loudness at the source, from `LOUDNESS` (§14). Omit when the action has no
   * price — opening a locker door costs nothing and a `))0` chip would be a
   * lie. §11's rule is to show the cost *where one exists*.
   */
  readonly loudness?: number;
  /**
   * Seconds the key must be held DOWN — the pry bar's 3, the hand pump's 25,
   * the undock lever's 5. Prints "HOLD 25S", because letting go loses it.
   */
  readonly holdSeconds?: number;
  /**
   * Seconds the action commits you for after a single press — climbing into a
   * hide spot is 2.5 s easing or 0.5 s diving (§4) and you do not keep the key
   * down for it. Prints the duration WITHOUT "hold". Mutually exclusive with
   * `holdSeconds`; both fill the bar.
   */
  readonly takesSeconds?: number;
  /**
   * Progress 0–1 when the caller tracks it authoritatively (the server owns
   * puzzle holds). Leave undefined and `setHolding()` will integrate it locally
   * from whichever duration is set instead.
   */
  readonly progress?: number;
  /**
   * False when the target is in range but cannot be used right now. Still
   * shown — dimmed, with `blocked` in place of the price — because a key that
   * silently does nothing reads as a broken build.
   */
  readonly usable?: boolean;
  /** Three or four words on why not: 'sealed', 'no charge', 'hands full'. */
  readonly blocked?: string;
  /**
   * The other half of a §11 dual path, drawn as a second, dimmer line.
   *
   * ONE LEVEL DEEP — an `alt` on an `alt` is ignored. There are exactly two
   * paths through any puzzle in the document and a third line under the
   * crosshair would be a legend, which §6 spends the whole section arguing
   * against.
   */
  readonly alt?: InteractPromptSpec;
}

export interface InteractPromptOptions {
  /** HUD root to attach to. */
  parent: HTMLElement;
  /** Keymap to resolve bindings against. Defaults to the live `KEYMAP`. */
  keymap?: Keymap;
}

/** Which of the two lines a hold applies to. */
export type PromptSlot = 'primary' | 'alt';

/** Shown when an action's key is bound to nothing at all. */
const UNBOUND_LABEL = '--';

/** Fallback action when a spec does not name a key. */
const DEFAULT_ACTION: PlayerAction = 'interact';

// ---------------------------------------------------------------------------
// One line of the prompt
// ---------------------------------------------------------------------------

class PromptRow {
  readonly root: HTMLDivElement;

  private readonly timeTag: HTMLElement;
  private readonly keyCap: HTMLElement;
  private readonly verbEl: HTMLElement;
  private readonly nounEl: HTMLElement;
  private readonly costEl: HTMLElement;
  private readonly fill: HTMLElement;

  private keyLabel = '';
  private shownProgress = -1;

  constructor(modifier: string) {
    this.timeTag = el('span', { class: 'iss-prompt__time' });
    this.keyCap = el('kbd', { class: 'iss-prompt__key' });
    this.verbEl = el('span', { class: 'iss-prompt__verb' });
    this.nounEl = el('span', { class: 'iss-prompt__noun' });
    this.costEl = el('span', { class: 'iss-prompt__cost' });
    this.fill = el('i', { class: 'iss-prompt__fill' });

    this.root = el('div', {
      class: `iss-prompt__opt${modifier}`,
      children: [
        el('div', {
          class: 'iss-prompt__row',
          children: [this.timeTag, this.keyCap, this.verbEl, this.nounEl, this.costEl],
        }),
        el('div', { class: 'iss-prompt__track', children: [this.fill] }),
      ],
    });
    this.root.dataset.timed = 'false';
    this.root.dataset.usable = 'true';
  }

  /** Rewrite every word. Called only when the spec actually changed. */
  render(spec: InteractPromptSpec, keymap: Keymap): void {
    this.keyLabel = resolveKeyLabel(spec.key, keymap);
    this.keyCap.textContent = this.keyLabel;

    const seconds = durationSeconds(spec);
    this.root.dataset.timed = seconds > 0 ? 'true' : 'false';
    // "HOLD 25S" is the quiet-slow half of §11's trade stated on the prompt
    // itself: the pry bar's 3 s and the hand pump's 25 s are the entire reason
    // one of them is worth 60 loudness and the other is worth 6.
    this.timeTag.textContent =
      seconds <= 0
        ? ''
        : spec.holdSeconds !== undefined
          ? `hold ${formatSeconds(seconds)}`
          : formatSeconds(seconds);

    this.verbEl.textContent = spec.verb;
    this.nounEl.textContent = spec.noun ?? '';

    const usable = spec.usable !== false;
    this.root.dataset.usable = usable ? 'true' : 'false';

    if (!usable && spec.blocked) {
      this.costEl.textContent = spec.blocked;
      this.costEl.dataset.kind = 'blocked';
      this.costEl.removeAttribute('data-band');
      this.costEl.removeAttribute('aria-label');
    } else if (spec.loudness !== undefined && usable) {
      const loudness = Math.round(spec.loudness);
      this.costEl.textContent = String(loudness);
      this.costEl.dataset.kind = 'cost';
      this.costEl.dataset.band = loudnessBand(spec.loudness);
      this.costEl.setAttribute('aria-label', `loudness ${loudness}`);
    } else {
      this.costEl.textContent = '';
      this.costEl.dataset.kind = 'none';
      this.costEl.removeAttribute('data-band');
      this.costEl.removeAttribute('aria-label');
    }

    // A new spec starts its bar empty rather than inheriting the last one's.
    this.shownProgress = -1;
  }

  /** Re-read the binding, so a rebind reaches the HUD on the next frame. */
  syncKey(spec: InteractPromptSpec, keymap: Keymap): void {
    const label = resolveKeyLabel(spec.key, keymap);
    if (label === this.keyLabel) return;
    this.keyLabel = label;
    this.keyCap.textContent = label;
  }

  setProgress(progress: number): void {
    // Quantise: a scaleX to five decimal places every frame is a style
    // recalculation nobody can see.
    const quantised = Math.round(clamp01(progress) * 200) / 200;
    if (quantised === this.shownProgress) return;
    this.shownProgress = quantised;
    this.fill.style.transform = `scaleX(${quantised})`;
  }
}

// ---------------------------------------------------------------------------

export class InteractPrompt {
  readonly root: HTMLDivElement;

  private readonly rows: Readonly<Record<PromptSlot, PromptRow>>;
  private readonly keymap: Keymap;

  private spec: InteractPromptSpec | null = null;
  private suppressed = false;
  /** Which line the player is holding down, if any. */
  private holdingSlot: PromptSlot | null = null;
  /** Locally integrated progress for `holdingSlot`, when no spec supplies one. */
  private localProgress = 0;
  private shown = false;

  constructor(opts: InteractPromptOptions) {
    this.keymap = opts.keymap ?? KEYMAP;
    this.rows = {
      primary: new PromptRow(''),
      alt: new PromptRow(' iss-prompt__opt--alt'),
    };

    this.root = el('div', {
      class: 'iss-prompt',
      attrs: { role: 'status', 'aria-live': 'polite' },
      children: [this.rows.primary.root, this.rows.alt.root],
    });
    this.root.dataset.shown = 'false';
    this.root.dataset.alt = 'false';
    opts.parent.appendChild(this.root);
  }

  /** The target currently being offered, or null. */
  get target(): InteractPromptSpec | null {
    return this.spec;
  }

  /** True while the prompt is actually on screen. */
  get visible(): boolean {
    return this.shown;
  }

  /**
   * Offer a target, or `null` for "nothing in reach".
   *
   * Safe to call every frame with the same spec: a spec whose id, words and
   * numbers are unchanged touches no DOM at all. Re-offering a *different* id
   * drops any locally integrated hold, because you are not still holding the
   * thing you stopped looking at.
   */
  set(spec: InteractPromptSpec | null): void {
    if (spec === null) {
      if (this.spec === null) return;
      this.spec = null;
      this.holdingSlot = null;
      this.localProgress = 0;
      this.syncVisibility();
      return;
    }

    const previous = this.spec;
    if (previous && previous.id !== spec.id) {
      this.holdingSlot = null;
      this.localProgress = 0;
    }
    this.spec = spec;

    if (!previous || !sameSpec(previous, spec)) {
      this.rows.primary.render(spec, this.keymap);
      const alt = spec.alt;
      this.root.dataset.alt = alt ? 'true' : 'false';
      if (alt) this.rows.alt.render(alt, this.keymap);
      // An offer with no second path cannot leave a stale hold pointing at one.
      if (!alt && this.holdingSlot === 'alt') {
        this.holdingSlot = null;
        this.localProgress = 0;
      }
    }
    this.syncVisibility();
  }

  /** Clear the prompt. Same as `set(null)`. */
  clear(): void {
    this.set(null);
  }

  /**
   * Tell the prompt a key is down, so it can fill that line's bar itself.
   *
   * Only used when the spec does not carry a `progress`. It integrates against
   * the spec's own duration — the same §14 constant the server counts with — so
   * the bar and the server agree to within a tick of latency, which is all a
   * HUD owes anybody. An authoritative caller should keep passing `progress` in
   * the spec and never touch this.
   *
   * `slot` says WHICH of a dual path is being held: pass `'alt'` for the second
   * line (the hand pump under the pry bar). Only one can be held at a time.
   */
  setHolding(active: boolean, slot: PromptSlot = 'primary'): void {
    if (!active) {
      // A release for a line nobody is holding is not this line's release.
      if (this.holdingSlot === null || this.holdingSlot !== slot) return;
      this.holdingSlot = null;
      this.localProgress = 0;
      return;
    }
    if (this.holdingSlot === slot) return;
    this.holdingSlot = slot;
    this.localProgress = 0;
  }

  /** Hide without forgetting the target — the menu and the results screen. */
  setSuppressed(suppressed: boolean): void {
    if (suppressed === this.suppressed) return;
    this.suppressed = suppressed;
    this.syncVisibility();
  }

  /**
   * Advance the fill bars and re-check the bindings. Call once per rendered
   * frame from `GameUI.update`.
   */
  update(dt: number): void {
    const spec = this.spec;
    if (!spec) return;

    this.rows.primary.syncKey(spec, this.keymap);
    if (spec.alt) this.rows.alt.syncKey(spec.alt, this.keymap);

    const held = this.holdingSlot === null ? null : (this.holdingSlot === 'alt' ? spec.alt : spec);
    if (held && held.progress === undefined) {
      const seconds = durationSeconds(held);
      if (seconds > 0) this.localProgress = clamp01(this.localProgress + dt / seconds);
    }

    this.rows.primary.setProgress(this.progressFor(spec, 'primary'));
    if (spec.alt) this.rows.alt.setProgress(this.progressFor(spec.alt, 'alt'));
  }

  dispose(): void {
    this.root.remove();
  }

  // -- internals ------------------------------------------------------------

  private progressFor(spec: InteractPromptSpec, slot: PromptSlot): number {
    if (spec.progress !== undefined) return clamp01(spec.progress);
    if (this.holdingSlot !== slot) return 0;
    return durationSeconds(spec) > 0 ? this.localProgress : 0;
  }

  private syncVisibility(): void {
    const shouldShow = this.spec !== null && !this.suppressed;
    if (shouldShow === this.shown) return;
    this.shown = shouldShow;
    this.root.dataset.shown = shouldShow ? 'true' : 'false';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveKeyLabel(key: PromptKey | undefined, keymap: Keymap): string {
  if (key !== undefined && typeof key === 'object') return codeLabel(key.code);
  const code = primaryCode(key ?? DEFAULT_ACTION, keymap);
  return code === null ? UNBOUND_LABEL : codeLabel(code);
}

/** Seconds the action runs for, whichever of the two forms the spec used. */
function durationSeconds(spec: InteractPromptSpec): number {
  return spec.holdSeconds ?? spec.takesSeconds ?? 0;
}

/** Cheap structural compare, so a per-frame `set()` is free when nothing moved. */
function sameSpec(
  a: InteractPromptSpec | undefined,
  b: InteractPromptSpec | undefined,
  depth = 0,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return (
    a.id === b.id &&
    a.verb === b.verb &&
    a.noun === b.noun &&
    a.loudness === b.loudness &&
    a.holdSeconds === b.holdSeconds &&
    a.takesSeconds === b.takesSeconds &&
    a.usable === b.usable &&
    a.blocked === b.blocked &&
    sameKey(a.key, b.key) &&
    // One level, matching what `set()` renders. Deeper alts do not exist.
    (depth > 0 || sameSpec(a.alt, b.alt, depth + 1))
  );
}

function sameKey(a: PromptKey | undefined, b: PromptKey | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'object' && typeof b === 'object') return a.code === b.code;
  return false;
}

/** `3` → "3s", `25` → "25s", `2.5` → "2.5s". No trailing zeroes. */
export function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// The priced verbs — §11's catalogue, with §14's numbers already attached
// ---------------------------------------------------------------------------

/**
 * Prebuilt specs for every interaction in the game that has a price.
 *
 * This table exists so that `src/main.ts` never has to type a loudness or a
 * hold time next to a verb — the one place those two numbers can drift out of
 * §14 is a caller retyping them. Every value below is imported.
 *
 * `pry` and `pump` are now real `KEYMAP` actions (they were raw `{ code }`
 * literals while `src/main.ts` matched V and B by hand), so every verb in this
 * table follows a runtime rebind. `PromptKey` still accepts the `{ code }` form
 * for a verb the keymap has not grown yet.
 */
export const PROMPT = Object.freeze({
  /** A locker door. Cosmetic and client-side; costs nothing (§11, §10). */
  openLocker: (noun = 'locker'): InteractPromptSpec => ({ id: `locker:${noun}`, verb: 'open', noun }),

  /** The §11 sequence card, stowed in a locker in another module. */
  readCard: (id = 'breaker-sequence:card'): InteractPromptSpec => ({ id, verb: 'read', noun: 'card' }),

  /** §11's canonical loud-fast path: a jammed locker forced in 3 s at 60. */
  pry: (id: string, noun = 'locker'): InteractPromptSpec => ({
    id,
    verb: 'pry',
    noun,
    key: 'pry',
    loudness: LOUDNESS.PRY_BAR,
    holdSeconds: PRY_TIME_S,
  }),

  /** …and the quiet-slow one it must sit beside: 25 s at 6. */
  pump: (id: string, noun = 'locker'): InteractPromptSpec => ({
    id,
    verb: 'pump',
    noun,
    key: 'pump',
    loudness: LOUDNESS.HAND_PUMP,
    holdSeconds: HAND_PUMP_TIME_S,
  }),

  /**
   * A JAMMED LOCKER — both paths at once, which is the whole point.
   *
   * §11: "every puzzle has a loud-fast path and a quiet-slow path", and the
   * rule "is what keeps the noise system relevant after the map is learned".
   * A prompt that offered only the pry bar would quietly delete the choice for
   * every player who never discovered B, so the two lines are one offer.
   */
  jammed: (id: string, noun = 'locker'): InteractPromptSpec => ({
    ...PROMPT.pry(id, noun),
    alt: PROMPT.pump(id, noun),
  }),

  /** One breaker of the six (§11 puzzle 1). A CLACK, every time. */
  breaker: (index: number): InteractPromptSpec => ({
    id: `breaker-${index}`,
    verb: 'throw',
    noun: `breaker ${index + 1}`,
    loudness: LOUDNESS.BREAKER,
  }),

  /** The manual override under the panel: 20 s anchored, unable to look. */
  override: (): InteractPromptSpec => ({
    id: 'breaker-sequence:override',
    verb: 'override',
    noun: 'panel',
    loudness: LOUDNESS.HAND_PUMP,
    holdSeconds: BREAKER_OVERRIDE_TIME_S,
  }),

  /** Easing the coolant wheel (§11 puzzle 2) — the patient half. */
  valveSlow: (): InteractPromptSpec => ({
    id: 'coolant-valve:wheel:slow',
    verb: 'ease',
    noun: 'valve',
    loudness: LOUDNESS.VALVE_SLOW,
  }),

  /** Spinning it. Five times the loudness for a fraction of the wait. */
  valveFast: (): InteractPromptSpec => ({
    id: 'coolant-valve:wheel:fast',
    verb: 'spin',
    noun: 'valve',
    loudness: LOUDNESS.VALVE_FAST,
  }),

  /** The wheel, both ways at once — §11 puzzle 2's own dual path. */
  valve: (): InteractPromptSpec => ({ ...PROMPT.valveSlow(), alt: PROMPT.valveFast() }),

  /** Sealing the needle in the green band. */
  valveLock: (): InteractPromptSpec => ({
    id: 'coolant-valve:gauge',
    verb: 'lock',
    noun: 'valve',
    loudness: LOUDNESS.VALVE_SLOW,
  }),

  /** Airlock keyswitch — 45 however careful you were (§11 puzzle 5). */
  keyswitch: (which: 'a' | 'b'): InteractPromptSpec => ({
    id: `airlock-keyswitch:${which}`,
    verb: 'turn',
    noun: `key ${which.toUpperCase()}`,
    loudness: LOUDNESS.KEYSWITCH,
  }),

  /** An undock release lever — five seconds, three players, 60 (§11 puzzle 6). */
  lever: (id = 'undock-sequence'): InteractPromptSpec => ({
    id,
    verb: 'pull',
    noun: 'release',
    loudness: LOUDNESS.UNDOCK_LEVER,
    holdSeconds: UNDOCK_HOLD_S,
  }),

  /** Cycling a hatch: 45, ~3 modules, and the alien pays the same to follow. */
  hatch: (id: string, open: boolean): InteractPromptSpec => ({
    id,
    verb: open ? 'close' : 'open',
    noun: 'hatch',
    loudness: LOUDNESS.HATCH_CYCLE,
  }),

  /** Knocking a handrail — the §10 knock-code primitive. */
  knock: (): InteractPromptSpec => ({
    id: 'rail:knock',
    verb: 'knock',
    noun: 'rail',
    key: 'knock',
    loudness: LOUDNESS.KNOCK,
  }),

  /** The extinguisher: a panic button with a price (§4). */
  extinguisher: (): InteractPromptSpec => ({
    id: 'item:extinguisher',
    verb: 'burst',
    noun: 'extinguisher',
    key: 'extinguisher',
    loudness: LOUDNESS.EXTINGUISHER,
  }),

  /** Throwing a decoy — two per round, no respawn (§5). */
  decoy: (): InteractPromptSpec => ({
    id: 'item:decoy',
    verb: 'throw',
    noun: 'decoy',
    loudness: LOUDNESS.DECOY,
  }),

  /**
   * A hide spot in reach (§4). The price is not fixed — it is whatever your
   * held gait makes it, 2.5 s at 8 easing in or 0.5 s at 30 diving — so the
   * caller passes the live numbers straight off `Player.hideCandidate`, which
   * already computes both from §14. Watching them change as you let go of
   * sprint is the whole loud-fast/quiet-slow lesson in one glance.
   */
  hide: (id: string, loudness: number, seconds: number): InteractPromptSpec => ({
    id: `hide:${id}`,
    verb: 'hide',
    noun: 'in here',
    key: 'interact',
    loudness,
    // `takesSeconds`, not `holdSeconds`: `Player.toggleHide()` is a tap that
    // commits you for the climb. Printing "HOLD 2.5S" would teach a player to
    // keep a key down through the one moment §4 gives them nothing to do.
    takesSeconds: seconds,
  }),

  /** Climbing back out. Free — the shell is behind you either way. */
  leaveHide: (id: string): InteractPromptSpec => ({
    id: `hide:${id}:out`,
    verb: 'climb',
    noun: 'out',
    key: 'interact',
  }),

  /** A loose cargo bag (§11 puzzle 3). Gentle is free; a throw is 30. */
  takeBag: (id: string): InteractPromptSpec => ({ id: `bag:${id}`, verb: 'take', noun: 'bag' }),

  /** Letting one go. `release()` with no velocity is the quiet option. */
  dropBag: (id: string): InteractPromptSpec => ({ id: `bag:${id}:drop`, verb: 'let go', noun: 'bag' }),

  /** A downed crewmate within arm's reach (§10 medkit revival). */
  revive: (id: string): InteractPromptSpec => ({ id: `revive:${id}`, verb: 'revive', noun: 'crew' }),

  /** Boarding the capsule. */
  board: (): InteractPromptSpec => ({ id: 'escape:board', verb: 'board', noun: 'capsule' }),
});
