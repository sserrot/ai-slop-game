/**
 * The keymap — DESIGN.md §4 / §10.
 *
 * ONE exported object. Every binding in the game lives here; nothing else in
 * `src/player` reads a raw `KeyboardEvent.code`. Rebind at runtime with
 * `rebind()` (a settings menu can drive it directly) and every input instance
 * built from `KEYMAP` follows, because `PlayerInput` re-indexes on change.
 *
 * Codes are `KeyboardEvent.code` values — physical keys, so the bindings survive
 * an AZERTY or QWERTZ layout unchanged.
 */

/** Everything the controller can be asked to do. */
export type PlayerAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'crouch'
  | 'sprint'
  | 'jump'
  | 'hide'
  | 'grip'
  | 'charge'
  | 'extinguisher'
  | 'flashlight'
  | 'knock'
  | 'interact'
  | 'trackerMute'
  | 'rollLeft'
  | 'rollRight'
  | 'snapLeft'
  | 'snapRight';

export type Keymap = Record<PlayerAction, string[]>;

/** Every action, in a stable order — handy for a bindings UI. */
export const PLAYER_ACTIONS: readonly PlayerAction[] = [
  'forward',
  'back',
  'left',
  'right',
  'crouch',
  'sprint',
  'jump',
  'hide',
  'grip',
  'charge',
  'extinguisher',
  'flashlight',
  'knock',
  'interact',
  'trackerMute',
  'rollLeft',
  'rollRight',
  'snapLeft',
  'snapRight',
] as const;

/**
 * THE keymap. Mutable on purpose: this is the object a settings screen edits.
 *
 * - WASD — walk in a `nominal` module (§4); slide along a gripped rail in a
 *   `zero` one; while floating, only aims an extinguisher burst.
 * - Ctrl — crouch. Shift — sprint. HELD, not toggled: the gait is the risk dial
 *   and §0 pillar 2 says the player holds it down all round. Crouch beats
 *   sprint when both are down, so a panicking player who mashes everything gets
 *   the quiet one.
 * - Space — jump on the deck (§4, 0.45 m: loud unless you land crouched); hold
 *   it while GRIPPING to charge a push-off, release to fire.
 * - T — get into or out of a hide spot (§4). Your GAIT sets the price: crouch in
 *   slowly and quietly, sprint in for a last-second dive that is always heard.
 *   T rather than the obvious V because `src/main.ts` already binds V to the
 *   pry bar; if the integrator would rather spend the interact key on it (the
 *   crosshair already shows `hand` for a spot in reach, and `Player.toggleHide`
 *   is one call), rebind or route E through `Player.hideCandidate` instead.
 * - Shift or Ctrl — grip. HOLD it: the first rail entering GRAB_RANGE latches
 *   automatically (§4, the 133 ms buffered-latch argument).
 * - Q — knock a handrail, loudness 15, ~2 modules (§10 knock codes).
 * - F — flashlight (§9's one shadow-casting light).
 * - E — interact. M — mute the wrist tracker (§6): silent but blind.
 * - X — fire extinguisher burst, loudness 65 (§4).
 * - Z / C — roll, when roll-lock is off. Arrows — snap turn.
 *
 * `crouch`/`sprint` deliberately share their physical keys with `grip`, and
 * `jump` shares Space with `charge`. That is not a collision to be tidied away:
 * a code may map to several actions (`buildCodeIndex` returns a list), and the
 * controller reads only the actions its CURRENT gravity regime has a use for. So
 * Shift is "run" on a deck and "hold on" in vacuum, and Space is "jump" on a
 * deck and "charge a push-off" on a rail — one hand position, two regimes, no
 * second mental model to build. Rebinding either half independently still works.
 */
export const KEYMAP: Keymap = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  crouch: ['ControlLeft', 'ControlRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  hide: ['KeyT'],
  grip: ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'],
  charge: ['Space'],
  extinguisher: ['KeyX'],
  flashlight: ['KeyF'],
  knock: ['KeyQ'],
  interact: ['KeyE'],
  trackerMute: ['KeyM'],
  rollLeft: ['KeyZ'],
  rollRight: ['KeyC'],
  snapLeft: ['ArrowLeft'],
  snapRight: ['ArrowRight'],
};

/** Mouse buttons, by `MouseEvent.button`. Right-drag to grip is the natural
 *  zero-G idiom; left is the charge, so push-off is click-and-hold. */
export const MOUSE_BINDINGS: Readonly<Record<number, PlayerAction>> = Object.freeze({
  0: 'charge',
  2: 'grip',
});

/** A fresh, independent copy — use it when a second controller (a spectator
 *  free-cam, a rebinding preview) must not share the live map. */
export function cloneKeymap(map: Keymap = KEYMAP): Keymap {
  const out = {} as Keymap;
  for (const action of PLAYER_ACTIONS) out[action] = [...map[action]];
  return out;
}

/** Replace the codes bound to one action, in place. */
export function rebind(action: PlayerAction, codes: string[], map: Keymap = KEYMAP): void {
  map[action] = [...codes];
}

/** Index `code -> actions`, which is what the input layer actually needs. */
export function buildCodeIndex(map: Keymap): Map<string, PlayerAction[]> {
  const index = new Map<string, PlayerAction[]>();
  for (const action of PLAYER_ACTIONS) {
    for (const code of map[action]) {
      const list = index.get(code);
      if (list) list.push(action);
      else index.set(code, [action]);
    }
  }
  return index;
}

/** First code bound to an action, for a HUD prompt ("[E] Interact"). */
export function primaryCode(action: PlayerAction, map: Keymap = KEYMAP): string | null {
  return map[action][0] ?? null;
}

/** Human-readable label for a `KeyboardEvent.code`. */
export function codeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `${code.slice(5)} Arrow`;
  switch (code) {
    case 'ShiftLeft':
      return 'L Shift';
    case 'ShiftRight':
      return 'R Shift';
    case 'ControlLeft':
      return 'L Ctrl';
    case 'ControlRight':
      return 'R Ctrl';
    case 'Space':
      return 'Space';
    default:
      return code;
  }
}
