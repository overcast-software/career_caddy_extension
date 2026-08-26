import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { layout } from '../state/layout.ts';
import type { DeskEntry } from '../domain/answer-desk.ts';

/**
 * The form's questions, as a dropdown or as rows.
 *
 * Doug asked for both — *"a dropdown of questions and an alternate with a list
 * of all the questions"* — so this is **two views of ONE list with exactly one
 * on screen**, the shape `quick-copy-card.gts` already established. Rendering
 * both would give the panel two ways to select the same question, which is
 * worse than either.
 *
 * The `<select>` is a real native one. There is no combobox anywhere in this
 * codebase, and building the first would mean roving tabindex,
 * `aria-activedescendant` and type-ahead for no gain over a control the
 * browser already ships.
 *
 * **The flag marks the selected question.** Doug's split: the golfer goes on
 * the page, next to the question — that is where you take the swing; the flag
 * goes here, marking what you are aiming at. This component owns the panel
 * half, and it is the whole of it in phase A.
 */
export interface QuestionPickerSignature {
  Args: {
    /** Every scanned question, choice controls included. */
    entries: DeskEntry[];
    selectedKey: string | null;
    onSelect: (key: string) => void;
    /**
     * What to say when there are no entries. Two genuinely different
     * sentences live behind this — see `answerDesk.scanNote`.
     */
    emptyNote: string;
  };
  Element: HTMLDivElement;
}

export default class QuestionPicker extends Component<QuestionPickerSignature> {
  get layout(): typeof layout {
    return layout;
  }

  get isEmpty(): boolean {
    return this.args.entries.length === 0;
  }

  toggleView = (): void => layout.toggleAnswerList();

  /**
   * `<select>` reports through its element; rows report through a closure.
   * Both land here, so there is one path from "the user pointed at a question"
   * to the desk regardless of which view is on screen.
   */
  pickFromSelect = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    this.args.onSelect(target.value);
  };

  <template>
    <div class="qp" ...attributes>
      <div class="qp__head">
        <label class="qp__label" for="qp-select">Question</label>
        {{#unless this.isEmpty}}
          <button
            type="button"
            class="qp__toggle"
            aria-expanded={{ariaBool this.layout.answerListExpanded}}
            {{on "click" this.toggleView}}
          >{{if this.layout.answerListExpanded "Dropdown" "List all"}}</button>
        {{/unless}}
      </div>

      {{#if this.isEmpty}}
        {{! Two empty states, never one. link-card.gts records the lesson:
            "no labelled questions here" is a hint to look again, and "this
            form is in a frame I can't read" is not — one message for both
            sends people hunting for a bug that is a permission boundary. }}
        <p class="qp__empty">{{@emptyNote}}</p>

      {{else if this.layout.answerListExpanded}}
        <ul class="qp__list">
          {{#each @entries key="key" as |entry|}}
            <li class="qp__row">
              {{! Rows follow link-card's shape but are NEVER disabled while
                  in flight, and that is a deliberate departure. There, the row
                  action MINTS something and a second click costs a duplicate.
                  Here it only selects, which is free and idempotent — and
                  disabling a generating row would break the exact workflow
                  this surface exists for: fire one off, move to the next,
                  come back to the first WHILE it is still working. The
                  in-flight guard belongs on the button that spends a call, and
                  that is Answer/Refine in <AnswerEditor>. }}
              <button
                type="button"
                class="qp__pick {{selectedClass @selectedKey entry.key}}"
                aria-current={{ariaBool (isSelected @selectedKey entry.key)}}
                {{on "click" (choose @onSelect entry.key)}}
              >
                {{! The flag marks what you are aiming at. Rendered as a span
                    rather than swapped into the label so the question text
                    never shifts as the selection moves. }}
                <span class="qp__flag" aria-hidden="true">
                  {{if (isSelected @selectedKey entry.key) "⛳" ""}}
                </span>
                <span class="qp__text">
                  <span class="qp__q">{{ordinalFor entry}}{{entry.field.label}}</span>
                  <span class="qp__meta">{{metaFor entry}}</span>
                </span>
              </button>
            </li>
          {{/each}}
        </ul>

      {{else}}
        <select id="qp-select" class="qp__select" {{on "change" this.pickFromSelect}}>
          {{#each @entries key="key" as |entry|}}
            <option value={{entry.key}} selected={{isSelected @selectedKey entry.key}}>
              {{optionLabel entry}}
            </option>
          {{/each}}
        </select>
      {{/if}}
    </div>
  </template>
}

function ariaBool(value: boolean): string {
  return value ? 'true' : 'false';
}

function isSelected(selectedKey: string | null, key: string): boolean {
  return selectedKey === key;
}

function selectedClass(selectedKey: string | null, key: string): string {
  return selectedKey === key ? 'is-selected' : '';
}

/**
 * Bind the key to the click handler — a plain closure, deliberately not
 * `{{fn}}`.
 *
 * `link-card.gts:157-175` records the reason and it is not superstition:
 * yielded contextual components also "built fine" here and then threw
 * `Cannot read properties of null (reading 'manager')` at render under this
 * project's owner-less `renderComponent`. A render-time failure blanks the
 * panel with a clean console, which is the most expensive failure mode this
 * codebase has and the one no gate catches. A closure costs nothing and cannot
 * fail that way.
 *
 * **This is the conservative choice, NOT an answer.** `segmented.gts:47` ships
 * `{{fn}}` and drives the live theme switcher, so the codebase contradicts
 * itself and exactly one side is wrong. **CCEXT-53** tracks settling it, and it
 * needs a loaded extension rather than more reasoning: `{{fn}}` builds clean,
 * type-checks, and passes every gate under both worlds.
 */
function choose(fn: (key: string) => void, key: string): () => void {
  return () => fn(key);
}

/**
 * The occurrence prefix, shown from the SECOND identical label onwards.
 *
 * A form with two "Why?" boxes is asking two questions, and they are NOT
 * deduped. That is only defensible if the picker can tell them apart, so the
 * number that distinguishes them is the number shown.
 */
function ordinalFor(entry: DeskEntry): string {
  return entry.field.occurrence > 0 ? `(${entry.field.occurrence + 1}) ` : '';
}

/**
 * The trailing annotation: what kind of control, and where this question got to.
 *
 * A choice control is LISTED and marked, never hidden. Hiding it makes the
 * scanner look broken to anyone who can see a Yes/No dropdown on their screen;
 * what actually protects it is that it carries no token, so nothing can be
 * written into it.
 */
function metaFor(entry: DeskEntry): string {
  const parts: string[] = [];
  if (entry.field.kind === 'choice') parts.push(entry.field.control);
  else if (entry.field.control === 'input') parts.push('single line');
  if (entry.field.weak) parts.push('label guessed');
  if (entry.draft?.status === 'generating') parts.push('generating…');
  else if (entry.draft?.content) parts.push('answered');
  return parts.join(' · ');
}

/** One `<option>`'s text. Same information as a row, flattened to one line. */
function optionLabel(entry: DeskEntry): string {
  const label = entry.field.label;
  const trimmed = label.length > 70 ? `${label.slice(0, 69)}…` : label;
  const meta = metaFor(entry);
  return `${ordinalFor(entry)}${trimmed}${meta ? ` · ${meta}` : ''}`;
}
