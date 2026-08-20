/**
 * ISS — results screen (DESIGN.md §10).
 *
 * "Escaping with three of six is a win. Say so on the results screen and rank
 * the outcome (crew recovered: 3/6). A binary condition at six players means
 * most rounds end in failure and the group quietly stops playing."
 *
 * So the big number on this screen is CREW RECOVERED — N of six — and the
 * verdict beside it says MISSION SUCCESS the moment N reaches
 * `WIN_MIN_SURVIVORS`. The rank above it is what turns "we scraped out with
 * three" into a result worth beating next round, which is the entire reason
 * §10 asks for a ranking rather than a win/lose stamp.
 */

import { MAX_PLAYERS, WIN_MIN_SURVIVORS } from '@shared/constants';
import type { PlayerId, RoundResult } from '@shared/types';
import { el, formatDuration } from './dom';

export interface OutcomeRank {
  /** Short rank shown large: ALL HANDS, FULL CREW… */
  rank: string;
  /** One line of context under it. */
  note: string;
  win: boolean;
}

/**
 * Rank a finished round. Ties to `result.win` for the verdict — the server owns
 * that — and uses the survivor count only to pick which of the win (or loss)
 * ranks to show.
 */
export function rankOutcome(result: RoundResult, crewTotal: number = MAX_PLAYERS): OutcomeRank {
  const escaped = result.escaped.length;
  const win = result.win;
  if (win && escaped >= crewTotal) {
    return { rank: 'ALL HANDS', note: 'Nobody was left aboard. This does not happen.', win };
  }
  if (win && escaped >= crewTotal - 1) {
    return { rank: 'EXEMPLARY', note: 'One empty seat. You were quiet and you were quick.', win };
  }
  if (win && escaped > WIN_MIN_SURVIVORS) {
    return { rank: 'CREW RECOVERED', note: 'More of you left than stayed. Take the win.', win };
  }
  if (win) {
    return {
      rank: 'MINIMUM CREW',
      note: `${WIN_MIN_SURVIVORS} of ${crewTotal} is a win. It was never going to feel like one.`,
      win,
    };
  }
  if (escaped > 0) {
    return {
      rank: 'ABANDONED',
      note: `The capsule undocked short of ${WIN_MIN_SURVIVORS}. Whoever made it will have to explain that.`,
      win,
    };
  }
  return { rank: 'TOTAL LOSS', note: 'The station is quiet again.', win };
}

export interface ResultsShowOptions {
  /** Display names by player id. Falls back to the raw id. */
  names?: Readonly<Record<PlayerId, string>>;
  /** Crew size for this round. Defaults to MAX_PLAYERS. */
  crewTotal?: number;
}

export interface ResultsScreenOptions {
  parent: HTMLElement;
  /** "Run it back" button. Omit and the button is not shown. */
  onAgain?: () => void;
  onMenu?: () => void;
}

export class ResultsScreen {
  readonly root: HTMLDivElement;

  private readonly verdictEl: HTMLParagraphElement;
  private readonly rankEl: HTMLParagraphElement;
  private readonly crewEl: HTMLDivElement;
  private readonly noteEl: HTMLParagraphElement;
  private readonly rosterEl: HTMLUListElement;
  private readonly statsEl: HTMLDivElement;
  private _visible = false;

  constructor(opts: ResultsScreenOptions) {
    this.verdictEl = el('p', { class: 'iss-result__verdict', text: '—' });
    this.rankEl = el('p', { class: 'iss-result__rank', text: '—' });
    this.crewEl = el('div', { class: 'iss-result__crew', text: '0/6' });
    this.noteEl = el('p', { class: 'iss-note' });
    this.rosterEl = el('ul', { class: 'iss-roster' });
    this.statsEl = el('div', { class: 'iss-stats' });

    const actions = el('div', { class: 'iss-actions' });
    if (opts.onAgain) {
      const again = el('button', {
        class: 'iss-btn iss-btn--primary',
        text: 'Run it back',
        attrs: { type: 'button' },
      });
      again.addEventListener('click', opts.onAgain);
      actions.appendChild(again);
    }
    if (opts.onMenu) {
      const menu = el('button', {
        class: 'iss-btn',
        text: 'Main menu',
        attrs: { type: 'button' },
      });
      menu.addEventListener('click', opts.onMenu);
      actions.appendChild(menu);
    }

    const screen = el('div', {
      class: 'iss-screen',
      children: [
        el('div', {
          class: 'iss-screen__eyebrow',
          children: [
            el('span', { text: 'ROUND REPORT' }),
            el('span', { text: 'ISS // ORBITAL PLATFORM' }),
          ],
        }),
        el('div', {
          class: 'iss-cols',
          style: { marginTop: '16px' },
          children: [
            el('section', {
              children: [
                this.verdictEl,
                this.crewEl,
                el('div', { class: 'iss-result__crewlabel', text: 'CREW RECOVERED' }),
                this.rankEl,
                this.noteEl,
                this.statsEl,
              ],
            }),
            el('section', {
              class: 'iss-block iss-block--plain',
              children: [
                el('h2', { class: 'iss-block__h', text: 'Manifest' }),
                this.rosterEl,
              ],
            }),
          ],
        }),
        actions,
      ],
    });

    this.root = el('div', { class: 'iss-overlay iss-scan', children: [screen] });
    this.root.hidden = true;
    opts.parent.appendChild(this.root);
  }

  /** Fill in and reveal. Call once on `round:ended`. */
  show(result: RoundResult, opts: ResultsShowOptions = {}): void {
    const crewTotal = opts.crewTotal ?? MAX_PLAYERS;
    const escaped = result.escaped.length;
    const outcome = rankOutcome(result, crewTotal);
    const names = opts.names ?? {};

    this.verdictEl.textContent = result.win ? 'MISSION SUCCESS' : 'MISSION FAILED';
    this.verdictEl.dataset.win = String(result.win);
    this.crewEl.textContent = `${escaped}/${crewTotal}`;
    this.crewEl.dataset.win = String(result.win);
    this.rankEl.textContent = outcome.rank;
    this.noteEl.textContent = outcome.note;

    this.rosterEl.replaceChildren();
    for (const id of result.escaped) {
      this.rosterEl.appendChild(this.rosterRow(names[id] ?? id, 'ESCAPED', true));
    }
    for (const id of result.dead) {
      this.rosterEl.appendChild(this.rosterRow(names[id] ?? id, 'LOST', false));
    }
    if (result.escaped.length + result.dead.length === 0) {
      this.rosterEl.appendChild(el('li', { text: 'no crew on record' }));
    }

    this.statsEl.replaceChildren(
      this.stat('Duration', formatDuration(result.durationMs)),
      this.stat('Final stage', `${result.finalStage} / 4`),
      this.stat('Lost', String(result.dead.length)),
      this.stat('Needed to win', `${WIN_MIN_SURVIVORS} / ${crewTotal}`),
    );

    this._visible = true;
    this.root.hidden = false;
  }

  private rosterRow(name: string, tag: string, escaped: boolean): HTMLLIElement {
    const row = el('li', {
      children: [
        el('span', { text: name }),
        el('span', { class: 'iss-roster__tag', text: tag }),
      ],
    });
    row.dataset.escaped = String(escaped);
    return row;
  }

  private stat(label: string, value: string): HTMLDivElement {
    return el('div', {
      children: [el('span', { text: label }), el('span', { text: value })],
    });
  }

  get visible(): boolean {
    return this._visible;
  }

  hide(): void {
    this._visible = false;
    this.root.hidden = true;
  }

  dispose(): void {
    this.root.remove();
  }
}
