/**
 * Keyboard + mouse capture for the player controller (DESIGN.md §4).
 *
 * Pointer lock is handled with the NATIVE API, not three's
 * `PointerLockControls`. That class was only ever used here for its lock
 * lifecycle — `enabled` was forced false so its yaw/pitch Euler never touched
 * the camera, because that Euler assumes a world up vector and this game has
 * none (the body carries a free quaternion; see `look.ts`). We already read raw
 * `movementX/Y` ourselves.
 *
 * It was also the thing breaking pointer lock outright. In the browser it threw
 * `THREE.PointerLockControls: Unable to use Pointer Lock API` followed by
 * `WrongDocumentError: The root document of this element is not valid for
 * pointer lock`, so the lock never engaged — which is why Escape appeared to do
 * nothing: there was no lock to exit, and the game retried fast enough to earn a
 * `SecurityError` on top. Keeping a class for one lifecycle event, at the cost
 * of the feature that lifecycle exists to serve, was a bad trade.
 *
 * The native path locks `document.body` — always connected, always in the active
 * document — and listens to `pointerlockchange` / `pointerlockerror` directly.
 *
 * Every binding comes from `KEYMAP` (keymap.ts). Nothing here hard-codes a key.
 */

import {
  KEYMAP,
  MOUSE_BINDINGS,
  buildCodeIndex,
  type Keymap,
  type PlayerAction,
} from './keymap';

export interface LookDelta {
  /** Raw horizontal mouse movement in pixels since the last consume. */
  dx: number;
  /** Raw vertical mouse movement in pixels since the last consume. */
  dy: number;
}

export interface PlayerInputOptions {
  /** Element that receives pointer lock. Defaults to `document.body`. */
  domElement?: HTMLElement | null;
  /**
   * Accepted and ignored. It existed only to satisfy `PointerLockControls`,
   * whose rotation this game never used; the native lock path needs no camera.
   * Kept so existing call sites do not have to change.
   */
  camera?: unknown;
  /** Bindings. Defaults to the shared, mutable `KEYMAP`. */
  keymap?: Keymap;
  /** Attach DOM listeners immediately. Default true (false is headless-safe). */
  attach?: boolean;
  /** Click the element to request pointer lock. Default true. */
  lockOnClick?: boolean;
}

const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';

/** Clicks inside any of these never request pointer lock. `#menu` is the
 *  interactive overlay from index.html; add `data-no-pointer-lock` to anything
 *  else the UI subsystem needs to stay clickable. */
const NO_LOCK_SELECTOR = '#menu, [data-no-pointer-lock], button, input, select, textarea, a[href]';

/** ms a click is refused after the pointer is released. See `relockBlockedUntil`. */
const RELOCK_COOLDOWN_MS = 1400;

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * Edge-triggered input state. `pressed()` / `released()` report what happened
 * since the last `endFrame()`, which `Player.update` calls for you.
 */
export class PlayerInput {
  private keymap: Keymap;
  private codeIndex: Map<string, PlayerAction[]>;

  private readonly downSet = new Set<PlayerAction>();
  private readonly pressedSet = new Set<PlayerAction>();
  private readonly releasedSet = new Set<PlayerAction>();

  private lookDx = 0;
  private lookDy = 0;
  private snapSteps = 0;

  private attached = false;
  private readonly lockOnClick: boolean;
  private readonly element: HTMLElement | null;

  /**
   * Timestamp until which click-to-lock is refused, set whenever the pointer is
   * released.
   *
   * Escape is the only pause this game has, and without this it did not work.
   * The click that follows Escape — on the canvas, which is deliberately not in
   * `NO_LOCK_SELECTOR` — recaptured the pointer instantly, so the cursor
   * flickered and vanished. Worse, Chrome treats a page that re-locks straight
   * after a user-initiated exit as hostile: it blocks the request and escalates
   * its overlay to "hold Esc", which is exactly the reported symptom of pressing
   * Escape and having nothing happen.
   *
   * 1.4s clears Chrome's own ~1.25s lock cooldown with margin. Menu buttons are
   * unaffected — they match `NO_LOCK_SELECTOR` and return before this is read.
   */
  private relockBlockedUntil = 0;

  /**
   * The element the pointer is locked to. `document.body` rather than the
   * canvas: it is guaranteed connected to the active document, which is exactly
   * the condition `WrongDocumentError` reports as missing. Null when headless.
   */
  private readonly lockTarget: HTMLElement | null;

  /** Subscribers to lock/unlock, driven by the native `pointerlockchange`. */
  private readonly lockListeners = new Set<(locked: boolean) => void>();

  /** Last state we broadcast, so one event never fires a duplicate callback. */
  private lastLockedState = false;

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (this.setFromCode(e.code, true) && this.shouldPreventDefault(e.code)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.setFromCode(e.code, false);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.lookDx += e.movementX;
    this.lookDy += e.movementY;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    const action = MOUSE_BINDINGS[e.button];
    if (!action) return;
    if (!this.locked && this.lockOnClick) return; // first click just grabs the pointer
    this.press(action);
    e.preventDefault();
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    const action = MOUSE_BINDINGS[e.button];
    if (action) this.release(action);
  };

  private readonly onContextMenu = (e: Event): void => {
    if (this.locked) e.preventDefault();
  };

  private readonly onClick = (e: MouseEvent): void => {
    if (!this.lockOnClick || this.locked) return;
    // index.html's #menu is the interactive overlay (comfort options, results).
    // Clicking a button there must not steal the pointer out from under it.
    const target = e.target;
    if (target instanceof Element && target.closest(NO_LOCK_SELECTOR)) return;
    // Just released the pointer? Let the player actually see their cursor.
    if (now() < this.relockBlockedUntil) return;
    this.lock();
  };

  /** A tab switch mid-push must not leave Shift stuck down forever. */
  private readonly onBlur = (): void => {
    this.releaseAll();
  };

  constructor(opts: PlayerInputOptions = {}) {
    this.keymap = opts.keymap ?? KEYMAP;
    this.codeIndex = buildCodeIndex(this.keymap);
    this.lockOnClick = opts.lockOnClick ?? true;
    this.element = opts.domElement ?? (hasDom ? document.body : null);

    this.lockTarget = hasDom ? document.body : null;

    if (opts.attach ?? true) this.attach();
  }

  // -- lifecycle ------------------------------------------------------------

  attach(): void {
    if (this.attached || !hasDom || !this.element) return;
    this.attached = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
    this.element.addEventListener('contextmenu', this.onContextMenu);
    this.element.addEventListener('click', this.onClick);
  }

  detach(): void {
    if (!this.attached || !hasDom || !this.element) return;
    this.attached = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    this.element.removeEventListener('click', this.onClick);
    this.releaseAll();
  }

  dispose(): void {
    this.detach();
  }

  /**
   * The single source of truth for lock state. Losing the pointer (Escape,
   * alt-tab) must also drop every held key, arm the re-lock cooldown, and tell
   * every subscriber — the menu hangs off this.
   */
  private readonly onPointerLockChange = (): void => {
    const locked = this.locked;
    if (!locked) {
      this.releaseAll();
      this.relockBlockedUntil = now() + RELOCK_COOLDOWN_MS;
    }
    if (locked === this.lastLockedState) return;
    this.lastLockedState = locked;
    for (const fn of this.lockListeners) fn(locked);
  };

  /**
   * A refused lock is normal (no gesture, or inside the browser's post-Escape
   * cooldown). Swallow it, but arm the cooldown so we do not immediately retry
   * and escalate Chrome's overlay to "hold Esc".
   */
  private readonly onPointerLockError = (): void => {
    this.relockBlockedUntil = now() + RELOCK_COOLDOWN_MS;
  };

  // -- pointer lock ---------------------------------------------------------

  get locked(): boolean {
    return hasDom && this.lockTarget !== null && document.pointerLockElement === this.lockTarget;
  }

  lock(): void {
    const target = this.lockTarget;
    if (!target || this.locked) return;
    // Requires a user gesture, and the browser refuses within its own cooldown
    // after the user pressed Escape. Both are normal outcomes — the menu simply
    // stays up — so neither may surface as an unhandled rejection.
    try {
      const pending = target.requestPointerLock() as unknown as Promise<void> | undefined;
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {
          /* no lock; `pointerlockchange` never fires and the menu stays up */
        });
      }
    } catch {
      /* same */
    }
  }

  unlock(): void {
    if (hasDom && this.locked) document.exitPointerLock();
  }

  /** `fn` fires whenever the pointer is captured or released — the menu overlay
   *  in index.html hangs off this. */
  onLockChange(fn: (locked: boolean) => void): () => void {
    this.lockListeners.add(fn);
    return () => {
      this.lockListeners.delete(fn);
    };
  }

  // -- bindings -------------------------------------------------------------

  setKeymap(map: Keymap): void {
    this.keymap = map;
    this.codeIndex = buildCodeIndex(map);
    this.releaseAll();
  }

  /** Re-read the map after a rebind mutated it in place. */
  refreshBindings(): void {
    this.codeIndex = buildCodeIndex(this.keymap);
  }

  // -- queries --------------------------------------------------------------

  /** Held right now. */
  isDown(action: PlayerAction): boolean {
    return this.downSet.has(action);
  }

  /** Went down since the last `endFrame()`. */
  pressed(action: PlayerAction): boolean {
    return this.pressedSet.has(action);
  }

  /** Came up since the last `endFrame()`. */
  released(action: PlayerAction): boolean {
    return this.releasedSet.has(action);
  }

  /**
   * WASD as a camera-relative wish vector: `x` is strafe (+right), `y` is
   * forward (+forward). Never longer than 1, so diagonals are not faster.
   */
  axis(target: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.isDown('right')) x += 1;
    if (this.isDown('left')) x -= 1;
    if (this.isDown('forward')) y += 1;
    if (this.isDown('back')) y -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    target.x = x;
    target.y = y;
    return target;
  }

  /** Roll input, -1 (left) to +1 (right). Ignored when roll-lock is on. */
  rollAxis(): number {
    return (this.isDown('rollRight') ? 1 : 0) - (this.isDown('rollLeft') ? 1 : 0);
  }

  /** Accumulated mouse movement, zeroed by the read. */
  consumeLook(target: LookDelta = { dx: 0, dy: 0 }): LookDelta {
    target.dx = this.lookDx;
    target.dy = this.lookDy;
    this.lookDx = 0;
    this.lookDy = 0;
    return target;
  }

  /** Net snap-turn steps requested since the last read (+right, -left). */
  consumeSnapSteps(): number {
    const n = this.snapSteps;
    this.snapSteps = 0;
    return n;
  }

  /** Clears the edge sets. `Player.update` calls this at the end of every frame. */
  endFrame(): void {
    this.pressedSet.clear();
    this.releasedSet.clear();
  }

  // -- injection (tests, gamepad, a future VR mapping) -----------------------

  press(action: PlayerAction): void {
    if (this.downSet.has(action)) return;
    this.downSet.add(action);
    this.pressedSet.add(action);
    if (action === 'snapLeft') this.snapSteps -= 1;
    if (action === 'snapRight') this.snapSteps += 1;
  }

  release(action: PlayerAction): void {
    if (!this.downSet.delete(action)) return;
    this.releasedSet.add(action);
  }

  releaseAll(): void {
    for (const action of [...this.downSet]) this.release(action);
    this.lookDx = 0;
    this.lookDy = 0;
  }

  addLook(dx: number, dy: number): void {
    this.lookDx += dx;
    this.lookDy += dy;
  }

  // -- internals ------------------------------------------------------------

  private setFromCode(code: string, down: boolean): boolean {
    const actions = this.codeIndex.get(code);
    if (!actions) return false;
    for (const action of actions) {
      if (down) this.press(action);
      else this.release(action);
    }
    return true;
  }

  /** Space scrolls the page and arrows move the caret; both would be visible
   *  under pointer lock as a jittering scrollbar. */
  private shouldPreventDefault(code: string): boolean {
    return code === 'Space' || code.startsWith('Arrow') || code === 'Tab';
  }
}
