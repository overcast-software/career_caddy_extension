import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import Icon from './icon.gts';
import type { IconName } from './icon.gts';
import { me } from '../state/me.ts';
import { layout } from '../state/layout.ts';
import { FRONTEND_ORIGIN } from '../lib/api.ts';
import { isLinkLike, previewOf } from '../domain/quick-copy.ts';
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
 */
export default class QuickCopyCard extends Component {
  /** The item name most recently copied, so one row can confirm. */
  @tracked copiedName: string | null = null;
  @tracked failed = false;

  private resetTimer: number | undefined;

  get me(): typeof me {
    return me;
  }

  get items(): QuickCopyItem[] {
    return me.items;
  }

  /**
   * /settings/profile/edit, NOT /settings/quick-copy.
   *
   * The legacy pointed at /settings/quick-copy and 404s (CCEXT-36): that route
   * only exists on frontend branch feature/ccext18-quick-copy, which has never
   * merged to main — CCEXT-20 is marked Done on the board but the code is not
   * in the deployed app. Until it lands, profile/edit is where `links` is
   * actually editable. Move this the day that branch merges.
   */
  get layout(): typeof layout {
    return layout;
  }

  toggleExpanded = (): void => layout.toggleQuickCopy();

  get editUrl(): string {
    return `${FRONTEND_ORIGIN}/settings/profile/edit`;
  }

  copy = (item: QuickCopyItem): void => {
    // The full value, never the preview.
    void navigator.clipboard
      .writeText(item.value)
      .then(() => {
        this.failed = false;
        this.copiedName = item.name;
      })
      .catch(() => {
        // Clipboard writes need a focused document. A panel that has lost
        // focus fails here, and silently doing nothing would read as a dead
        // button — say so instead.
        this.failed = true;
        this.copiedName = item.name;
      })
      .finally(() => {
        window.clearTimeout(this.resetTimer);
        this.resetTimer = window.setTimeout(() => {
          this.copiedName = null;
          this.failed = false;
        }, 1600);
      });
  };

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
                class="qc__chip {{copiedClass this.copiedName item.name this.failed}}"
                title={{copyLabel this.copiedName item.name this.failed}}
                aria-label={{copyLabel this.copiedName item.name this.failed}}
                {{on "click" (pick this.copy item)}}
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
                {{on "click" (pick this.copy item)}}
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
                  {{#if (isCopied this.copiedName item.name)}}
                    {{#if this.failed}}
                      <span class="qc__failed">can't copy</span>
                    {{else}}
                      <Icon @name="check" />
                    {{/if}}
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

function isCopied(copiedName: string | null, name: string): boolean {
  return copiedName === name;
}

/**
 * A chip has no label to swap for "Copied", so the confirmation is a class
 * plus the tooltip — the legacy's solution, and still the right one.
 */
function copiedClass(copiedName: string | null, name: string, failed: boolean): string {
  if (copiedName !== name) return '';
  return failed ? 'is-failed' : 'is-copied';
}

function copyLabel(copiedName: string | null, name: string, failed: boolean): string {
  if (copiedName !== name) return `Copy ${name}`;
  return failed ? `Copy failed — ${name}` : `Copied ${name}`;
}

function ariaBool(value: boolean): string {
  return value ? 'true' : 'false';
}
