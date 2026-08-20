/**
 * ISS — main menu (DESIGN.md §5, §7, §6).
 *
 * This screen carries two loads that no other part of the game can:
 *
 * 1. **It states the alien's rules outright.** §5: "Perception is sound +
 *    contact only. No vision cone, ever. State this outright in the menu — a
 *    legible rule is scarier than a mysterious one, because players blame
 *    themselves." Pillar 3 says a player must be able to build a correct mental
 *    model of the alien's hearing within one round; this text is where that
 *    starts.
 *
 * 2. **It states the Discord social contract.** §7 is blunt that the Discord
 *    problem is "the single biggest threat to this being the game you designed",
 *    that it cannot be detected or engineered around, and that "friends honour a
 *    stated contract far more reliably than an implied one." This menu text is
 *    the only defence the design has. Do not soften it, and do not bury it below
 *    the fold — it sits in its own framed block beside the alien's rules.
 *
 * Every number quoted below is read from `@shared/constants`, so the menu can
 * never drift out of sync with §14 the way a hand-written paragraph would.
 */

import {
  ATTN_PATROL,
  ATTN_SEARCH,
  DECOYS_PER_ROUND,
  patrolThreshold,
  searchThreshold,
  HATCH_OPEN_TIME,
  LOUDNESS,
  MAX_PLAYERS,
  SEAL_CHARGES,
  SYSTEMS_TO_ESCAPE,
  VOICE_MAX,
  VOICE_MIN,
  WIN_MIN_SURVIVORS,
} from '@shared/constants';
import { el } from './dom';

/**
 * §14's attention numbers are one shared noise budget for a full crew. With
 * fewer ears on the station they scale (see `crewPressure`), and the menu has
 * to quote both ends or pillar 3's "a correct mental model within one round"
 * is a promise the briefing itself breaks: a solo player who trusted the
 * unscaled 12 would spend the round waiting to be heard by an alien that was
 * simply walking into them.
 */
const SOLO_PATROL = patrolThreshold(0, 1);
const SOLO_SEARCH = searchThreshold(1);

/** [key, meaning] rows for the controls block. */
export type ControlRow = readonly [string, string];

export const DEFAULT_CONTROLS: readonly ControlRow[] = [
  ['MOUSE', 'look'],
  ['W A S D', 'slide along a rail · steer a drift'],
  ['HOLD RMB', 'grip — auto-latches the first rail in range'],
  ['HOLD SPACE', 'charge a push-off · release to launch'],
  ['E', 'interact'],
  ['Q', 'knock on a handrail (loudness 15, carries ~2 modules)'],
  ['V', 'push to talk'],
  ['M', 'mute the wrist tracker — silent, and blind'],
  ['ESC', 'menu'],
];

export interface MainMenuOptions {
  /** Overlay host. Defaults to the `#menu` div from index.html. */
  parent: HTMLElement;
  onStart?: () => void;
  onSettings?: () => void;
  controls?: readonly ControlRow[];
  /** Shown small, bottom-right of the action row (build id, server, name). */
  status?: string;
  startVisible?: boolean;
}

export class MainMenu {
  readonly root: HTMLDivElement;

  private readonly statusEl: HTMLSpanElement;
  private readonly startButton: HTMLButtonElement;
  private _visible: boolean;

  constructor(opts: MainMenuOptions) {
    const controls = opts.controls ?? DEFAULT_CONTROLS;

    // ---- the alien's rules, stated outright (§5) --------------------------
    const rules = el('ul', {
      class: 'iss-list',
      children: [
        el('li', {
          html: '<strong>It has no eyes.</strong> It hunts entirely by sound and by touch. There is no vision cone. Darkness does not hide you and light does not betray you.',
        }),
        el('li', {
          html: `<strong>It hears better when it is already looking for you.</strong> On patrol it reacts to arrivals of <em>${ATTN_PATROL}</em> and above. Once it is searching, <em>${ATTN_SEARCH}</em> — quiet enough that shifting your grip on a rail can be the thing that kills you.`,
        }),
        el('li', {
          html: `<strong>Those numbers are for a full crew.</strong> They are one noise budget shared between six people, so the fewer of you are left alive, the louder you have to be before it reacts: alone on the station it is <em>${SOLO_PATROL}</em> on patrol and <em>${SOLO_SEARCH}</em> while searching, and it gives you a head start before it begins to move at all.`,
        }),
        el('li', {
          html: 'It does not learn exactly where a sound came from. Loud noises pin you closely; a faint arrival leaves it a wide guess. It can never pin you perfectly.',
        }),
        el('li', {
          html: `<strong>It opens closed hatches</strong> — ${HATCH_OPEN_TIME.toFixed(0)} seconds, at loudness ${LOUDNESS.HATCH_CYCLE}, the same as when you cycle one. So you always hear it coming through.`,
        }),
        el('li', {
          html: `<strong>It cannot open a sealed hatch.</strong> You get ${SEAL_CHARGES} seal charges for the whole round, and ${DECOYS_PER_ROUND} decoys. There is no resupply.`,
        }),
        el('li', {
          html: '<strong>It makes noise while it hunts.</strong> A silent charge would be unfair, so it never happens.',
        }),
        el('li', {
          html: 'It gets faster and sharper every time you bring a system online. Progress is what wakes it up.',
        }),
        el('li', {
          html: 'If it finds you, something you did was audible. That is the whole game.',
        }),
      ],
    });

    // ---- the Discord contract (§7) ---------------------------------------
    const contract = el('ul', {
      class: 'iss-list',
      children: [
        el('li', {
          html: '<strong>Play this muted on Discord.</strong> The voice system <em>is</em> the game — every word you say is a noise event in the station, and something is listening to it.',
        }),
        el('li', {
          html: `Speech carries: a whisper arrives around ${VOICE_MIN}, a shout around ${VOICE_MAX} — up to roughly five modules away. Shouting "where is everyone" works, and is exactly as stupid as it sounds.`,
        }),
        el('li', {
          html: 'You wake alone and scattered. Finding each other is the first act, and your only tool for it is the loudest thing you own.',
        }),
        el('li', {
          html: 'Tap a handrail instead. Knocks carry about two modules and mean whatever you agree they mean.',
        }),
        el('li', {
          html: `The dead stay in the game: module cameras, and a headset channel at loudness ${LOUDNESS.HEADSET}. Nobody watches a black screen, and nobody has an excuse to leave for another call.`,
        }),
        el('li', {
          html: 'On a second call, none of this exists. Honour the contract or play a different game — that is the deal.',
        }),
      ],
    });

    // ---- mission ---------------------------------------------------------
    const mission = el('ul', {
      class: 'iss-list',
      children: [
        el('li', {
          html: `Bring <strong>${SYSTEMS_TO_ESCAPE} systems</strong> back online, run the undock sequence, reach the capsule.`,
        }),
        el('li', {
          html: `<strong>Escaping with ${WIN_MIN_SURVIVORS} of ${MAX_PLAYERS} is a win.</strong> Losing people is expected. Leaving without trying is not.`,
        }),
        el('li', {
          html: 'You pull along handrails — slow and quiet — or push off and hope you catch something. A clean catch is quiet. A crash is not.',
        }),
        el('li', {
          html: 'Every puzzle has a loud fast way and a quiet slow way. There is no third way.',
        }),
      ],
    });

    const keys = el('dl', { class: 'iss-keys' });
    for (const [key, meaning] of controls) {
      keys.appendChild(el('dt', { text: key }));
      keys.appendChild(el('dd', { text: meaning }));
    }

    this.startButton = el('button', {
      class: 'iss-btn iss-btn--primary',
      text: 'Begin round',
      attrs: { type: 'button' },
    });
    const settingsButton = el('button', {
      class: 'iss-btn',
      text: 'Comfort & controls',
      attrs: { type: 'button' },
    });
    this.statusEl = el('span', { class: 'iss-status', text: opts.status ?? '' });

    if (opts.onStart) this.startButton.addEventListener('click', opts.onStart);
    if (opts.onSettings) settingsButton.addEventListener('click', opts.onSettings);

    const screen = el('div', {
      class: 'iss-screen',
      children: [
        el('div', {
          class: 'iss-screen__eyebrow',
          children: [
            el('span', { text: 'ISS // ORBITAL PLATFORM · EMERGENCY POWER' }),
            el('span', { text: `CREW ${MAX_PLAYERS} · ESCAPE ${WIN_MIN_SURVIVORS} TO WIN` }),
          ],
        }),
        el('h1', { class: 'iss-screen__title', text: 'ISS' }),
        el('p', {
          class: 'iss-screen__sub',
          text: 'Six of you. One of it. It hunts by sound — stay quiet.',
        }),
        el('div', {
          class: 'iss-cols',
          children: [
            el('section', {
              class: 'iss-block iss-block--warn',
              children: [
                el('h2', { class: 'iss-block__h', text: 'The thing aboard — known rules' }),
                rules,
              ],
            }),
            el('section', {
              class: 'iss-block iss-block--plain',
              children: [
                el('h2', { class: 'iss-block__h', text: 'Crew contract — read this one' }),
                contract,
              ],
            }),
          ],
        }),
        el('div', {
          class: 'iss-cols',
          style: { marginTop: '16px' },
          children: [
            el('section', {
              class: 'iss-block iss-block--plain',
              children: [
                el('h2', { class: 'iss-block__h', text: 'Mission' }),
                mission,
              ],
            }),
            el('section', {
              class: 'iss-block iss-block--plain',
              children: [
                el('h2', { class: 'iss-block__h', text: 'Controls' }),
                keys,
                el('p', {
                  class: 'iss-note',
                  text: 'Motion sickness options — roll-lock, snap-turn, FOV, vignette — are under Comfort & controls. Set them before you launch; zero-g is not gentle.',
                }),
              ],
            }),
          ],
        }),
        el('div', {
          class: 'iss-actions',
          children: [this.startButton, settingsButton, this.statusEl],
        }),
      ],
    });

    this.root = el('div', {
      class: 'iss-overlay iss-scan',
      children: [screen],
    });
    opts.parent.appendChild(this.root);

    this._visible = opts.startVisible ?? true;
    this.root.hidden = !this._visible;
  }

  get visible(): boolean {
    return this._visible;
  }

  show(): void {
    this._visible = true;
    this.root.hidden = false;
    this.startButton.focus({ preventScroll: true });
  }

  hide(): void {
    this._visible = false;
    this.root.hidden = true;
  }

  toggle(): void {
    if (this._visible) this.hide();
    else this.show();
  }

  /** Small right-aligned line in the action row: connection state, build id. */
  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  /** Relabel the primary button ("Begin round" → "Resume", "Connecting…"). */
  setStartLabel(text: string, enabled = true): void {
    this.startButton.textContent = text;
    this.startButton.disabled = !enabled;
  }

  dispose(): void {
    this.root.remove();
  }
}
