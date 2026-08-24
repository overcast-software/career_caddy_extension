import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import Icon from './icon.gts';
import type { IconName } from './icon.gts';
import { me } from '../state/me.ts';
import { layout } from '../state/layout.ts';
import { answerDesk } from '../state/answer-desk.ts';
import { FRONTEND_ORIGIN } from '../lib/api.ts';
import { actionFor, isLinkLike, previewOf } from '../domain/quick-copy.ts';
import type { QuickCopyItem } from '../domain/quick-copy.ts';

/**
 * The snippets you paste into application forms over and over.
 *
 * Two kinds of thing live here, and the card has to serve both: short profile
 * links, and multi-hundred-character prompts. That is not a design choice, it
 * is history — the field was built for links and, in Doug's words, "sprouted
 * into common prompts". So every row shows a NAME and a one-line preview, and
 * copies the whole value. Rendering the value itself would give one 450-char
 * row the whole panel, which is what made the legacy card too tall (CCEXT-38).
 *
 * A link-ish snippet additionally gets "open"; a prose one does not, because
 * there is nowhere to open prose.
 *
 * ── PRESSING A PROMPT SENDS IT TO THE DESK (CCEXT-86) ──────────────────────
 *
 * A prose snippet is a saved instruction, so pressing it puts it on the
 * selected question's instruction stack rather than on the clipboard. Doug
 * asked for that and worried it would need a second input — it does not. The
 * desk's one input keeps both its identities; the snippet arrives as a chip
 * next to the ones typed by hand, and leaves through the same ×.
 *
 * `domain/quick-copy.ts:actionFor` owns the choice, so the rule is testable
 * without a panel. This file owns only the SAYING of it, and that half is
 * load-bearing: the desk lives in a different accordion section, so a chip
 * appearing there is not confirmation anyone can see from here. Every press
 * therefore reports what it did — including "I copied it instead, and here is
 * why", which is the outcome a silent no-op would have hidden.
 */
type ActedOutcome = 'copied' | 'added' | 'already-there' | 'copied-no-question' | 'failed';

/** A tick is read at a glance; a sentence has to be read. */
const RESET_MS = 1600;
const RESET_MS_EXPLAINED = 2800;

export default class QuickCopyCard extends Component {
  /** The item most recently pressed, so one row can confirm. */
  @tracked actedName: string | null = null;
  @tracked outcome: ActedOutcome | null = null;

  private resetTimer: number | undefined;

  get me(): typeof me {
    return me;
  }

  get items(): QuickCopyItem[] {
    return me.items;
  }

  /**
   * A tracked read, so the rows re-label themselves the moment a question is
   * selected — the same press means something different before and after, and
   * the button has to say which.
   */
  get hasSelectedQuestion(): boolean {
    return answerDesk.selectedKey !== null;
  }

  /**
   * What just happened, in a sentence.
   *
   * Silent on a plain copy: the tick already says it and a line of prose for
   * the ordinary case would be noise. Everything else is either new behaviour
   * worth seeing (the chip went somewhere off-screen) or a refusal that owes
   * the user a reason.
   */
  get noteText(): string {
    switch (this.outcome) {
      case 'added':
        return `Added to “${this.selectedLabel}”.`;
      case 'already-there':
        return `Already in force on “${this.selectedLabel}”.`;
      case 'copied-no-question':
        return 'No question selected — copied instead. Caddy the form and pick one.';
      case 'failed':
        return 'Copy failed — the panel needs focus.';
      default:
        return '';
    }
  }

  private get selectedLabel(): string {
    const label = answerDesk.selected?.field.label ?? 'this question';
    return label.length > 40 ? label.slice(0, 39) + '…' : label;
  }

  /**
   * /settings/quick-copy — the route that owns snippet editing as of frontend
   * c11e413 (PR #244).
   *
   * This pointed at /settings/profile/edit while CCEXT-20 sat unmerged. That
   * is now WORSE than wrong rather than merely suboptimal: the merge strips
   * the editing UI out of profile/edit, leaving only a nav link, so the old
   * target lands on a page where the feature is gone. Verified against
   * origin/main, not assumed.
   */
  get layout(): typeof layout {
    return layout;
  }

  toggleExpanded = (): void => layout.toggleQuickCopy();

  get editUrl(): string {
    return `${FRONTEND_ORIGIN}/settings/quick-copy`;
  }

  press = (item: QuickCopyItem): void => {
    if (actionFor(item.value, this.hasSelectedQuestion) === 'inject') {
      const result = answerDesk.pushInstruction(item.value);
      if (result === 'added') return this.settle(item.name, 'added');
      if (result === 'already-there') return this.settle(item.name, 'already-there');
      // `no-question` here means the selection went stale between the two
      // reads — the question was re-rendered away. Rare, and the clipboard is
      // still a useful answer, so fall through rather than refuse.
    }

    // A link goes to the clipboard because it is a link; prose goes there
    // because there was nowhere to put it. The user cannot tell those apart
    // from a tick, so they are reported as different things.
    this.toClipboard(item, isLinkLike(item.value) ? 'copied' : 'copied-no-question');
  };

  /** The full value, never the preview. */
  private toClipboard(item: QuickCopyItem, ok: ActedOutcome): void {
    void navigator.clipboard
      .writeText(item.value)
      .then(() => this.settle(item.name, ok))
      // Clipboard writes need a focused document. A panel that has lost focus
      // fails here, and silently doing nothing would read as a dead button.
      .catch(() => this.settle(item.name, 'failed'));
  }

  private settle(name: string, outcome: ActedOutcome): void {
    this.actedName = name;
    this.outcome = outcome;
    window.clearTimeout(this.resetTimer);
    this.resetTimer = window.setTimeout(
      () => {
        this.actedName = null;
        this.outcome = null;
      },
      outcome === 'copied' ? RESET_MS : RESET_MS_EXPLAINED,
    );
  }

  override willDestroy(): void {
    super.willDestroy();
    window.clearTimeout(this.resetTimer);
  }

  <template>
    {{#if this.items.length}}
      <div class="qc">
        <p class="qc__head">
          Quick copy
          <span class="qc__head-actions">
            <button
              type="button"
              class="qc__toggle"
              aria-expanded={{ariaBool this.layout.quickCopyExpanded}}
              {{on "click" this.toggleExpanded}}
            >{{if this.layout.quickCopyExpanded "Collapse" "Expand"}}</button>
            <a class="qc__edit" href={{this.editUrl}} target="_blank" rel="noopener">Edit</a>
          </span>
        </p>

        {{#if this.noteText}}
          {{!-- The desk is in another section, so "it went there" has to be
              said HERE. This is also the only place a collapsed chip bar can
              report a refusal — a chip has no room for a sentence. --}}
          <p class="qc__note">{{this.noteText}}</p>
        {{/if}}

        {{#unless this.layout.quickCopyExpanded}}
          {{!-- CCEXT-38: the bar and the rows are TWO VIEWS OF ONE LIST, and
              exactly one is on screen. Showing both would give the card two
              ways to copy the same value, which is worse than either. --}}
          <div class="qc__bar">
            {{#each this.items key="name" as |item|}}
              {{!-- The name rides on title/aria-label because several custom
                  items share the same golf glyph; without it the bar is a
                  guessing game, and Expand is the answer for anyone who
                  cannot tell two apart at a glance. --}}
              <button
                type="button"
                class="qc__chip {{actedClass this.actedName item.name this.outcome}}"
                title={{pressLabel
                  this.actedName
                  item.name
                  this.outcome
                  (goesToDesk item.value this.hasSelectedQuestion)
                }}
                aria-label={{pressLabel
                  this.actedName
                  item.name
                  this.outcome
                  (goesToDesk item.value this.hasSelectedQuestion)
                }}
                {{on "click" (pick this.press item)}}
              >
                {{#if (isBrand item.icon)}}
                  <Icon @name={{brandIcon item.icon}} />
                {{else}}
                  <span class="qc__emoji" aria-hidden="true">{{emojiFor item.icon}}</span>
                {{/if}}
              </button>
            {{/each}}
          </div>
        {{/unless}}

        {{#if this.layout.quickCopyExpanded}}
        <ul class="qc__list">
          {{#each this.items key="name" as |item|}}
            <li class="qc__row">
              <button
                type="button"
                class="qc__copy"
                title={{item.value}}
                aria-label={{pressLabel
                  this.actedName
                  item.name
                  this.outcome
                  (goesToDesk item.value this.hasSelectedQuestion)
                }}
                {{on "click" (pick this.press item)}}
              >
                <span class="qc__icon">
                  {{#if (isBrand item.icon)}}
                    <Icon @name={{brandIcon item.icon}} />
                  {{else}}
                    <span class="qc__emoji" aria-hidden="true">{{emojiFor item.icon}}</span>
                  {{/if}}
                </span>

                <span class="qc__text">
                  <span class="qc__name">{{item.name}}</span>
                  {{#unless (sameAsName item)}}
                    {{!-- Suppressed when the name IS the value: an unnamed
                        snippet would otherwise print the same string twice. --}}
                    <span class="qc__preview">{{preview item.value}}</span>
                  {{/unless}}
                </span>

                <span class="qc__action">
                  {{#if (isActed this.actedName item.name)}}
                    {{#if (didFail this.outcome)}}
                      <span class="qc__failed">can't copy</span>
                    {{else}}
                      <Icon @name="check" />
                    {{/if}}
                  {{else if (goesToDesk item.value this.hasSelectedQuestion)}}
                    {{!-- The affordance has to name the destination. A copy
                        glyph on a control that does not copy is precisely the
                        lie CCEXT-49 refused to carry across the rewrite. --}}
                    <span class="qc__to">→ desk</span>
                  {{else}}
                    <Icon @name="copy" />
                  {{/if}}
                </span>
              </button>

              {{#if (isLink item.value)}}
                <a
                  class="qc__open"
                  href={{item.value}}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open"
                >↗</a>
              {{/if}}
            </li>
          {{/each}}
        </ul>
        {{/if}}
      </div>
    {{/if}}
  </template>
}

function pick(fn: (item: QuickCopyItem) => void, item: QuickCopyItem): () => void {
  return () => fn(item);
}

function isBrand(icon: string): boolean {
  return icon === 'linkedin' || icon === 'github';
}

/** Narrows a brand icon key to an IconName so Glint can check the arg. */
function brandIcon(icon: string): IconName {
  return icon === 'github' ? 'github' : 'linkedin';
}

const EMOJI: Record<string, string> = {
  flag: '⛳',
  golfer: '🏌️',
  trophy: '🏆',
  target: '🎯',
  finish: '🏁',
};

function emojiFor(icon: string): string {
  return EMOJI[icon] ?? EMOJI['flag'] ?? '';
}

function preview(value: string): string {
  return previewOf(value);
}

function isLink(value: string): boolean {
  return isLinkLike(value);
}

function sameAsName(item: QuickCopyItem): boolean {
  return item.name === item.value;
}

function isActed(actedName: string | null, name: string): boolean {
  return actedName === name;
}

function didFail(outcome: ActedOutcome | null): boolean {
  return outcome === 'failed';
}

/** Would pressing this one send it to the desk? Mirrors `actionFor`. */
function goesToDesk(value: string, hasSelectedQuestion: boolean): boolean {
  return actionFor(value, hasSelectedQuestion) === 'inject';
}

/**
 * A chip has no label to swap for "Copied", so the confirmation is a class
 * plus the tooltip — the legacy's solution, and still the right one.
 */
function actedClass(
  actedName: string | null,
  name: string,
  outcome: ActedOutcome | null,
): string {
  if (actedName !== name) return '';
  if (outcome === 'failed') return 'is-failed';
  if (outcome === 'added' || outcome === 'already-there') return 'is-added';
  return 'is-copied';
}

/**
 * The one string that tells the truth about this button.
 *
 * It has to carry the destination BEFORE the press as well as after, because
 * the same glyph now does two different things depending on whether a question
 * is selected — and the tooltip is the only place a chip can say which.
 */
function pressLabel(
  actedName: string | null,
  name: string,
  outcome: ActedOutcome | null,
  toDesk: boolean,
): string {
  if (actedName !== name) {
    return toDesk ? `Add to the answer desk — ${name}` : `Copy ${name}`;
  }
  switch (outcome) {
    case 'added':
      return `Added to the answer desk — ${name}`;
    case 'already-there':
      return `Already in force — ${name}`;
    case 'copied-no-question':
      return `No question selected — copied ${name} instead`;
    case 'failed':
      return `Copy failed — ${name}`;
    default:
      return `Copied ${name}`;
  }
}

function ariaBool(value: boolean): string {
  return value ? 'true' : 'false';
}
