import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';
import DraftBox from './draft-box.gts';
import Icon from './icon.gts';
import { answerDesk } from '../state/answer-desk.ts';
import type { DeskEntry } from '../domain/answer-desk.ts';

/**
 * The answer desk: several questions at once, each with its own draft.
 *
 * ONE INPUT, TWO IDENTITIES. Before an answer exists it is the prompt box —
 * "anything else the model should know?". After one it is the refine box —
 * "what should change?". Not a dialogue and not a transcript: the turn history
 * already exists server-side, because every generate and every refine is
 * another `Answer` row against the same `Question`. There is nothing here to
 * invent a client-side transcript for, and rendering one later is a change to
 * this file alone with no data to migrate.
 *
 * INSTRUCTIONS ACCUMULATE, as chips. "This is a Toptal form, third person"
 * stays in force when you later say "highlight my time at evendent.io" — which
 * is why they are chips with an × rather than an input you retype. Taking one
 * back out has to be possible and has to be visible.
 */
export default class AnswerDesk extends Component {
  get desk(): typeof answerDesk {
    return answerDesk;
  }

  get entries(): DeskEntry[] {
    return answerDesk.entries;
  }

  get selected(): DeskEntry | null {
    return answerDesk.selected;
  }

  get hasQuestions(): boolean {
    return this.entries.length > 0;
  }

  get scanLabel(): string {
    if (answerDesk.scanState === 'scanning') return 'Scanning…';
    return this.hasQuestions ? 'Rescan' : 'Find questions';
  }

  /**
   * "3 generating" — the parallelism made visible.
   *
   * Worth a line of its own because it is the claim this surface is making:
   * you are not waiting on one answer at a time. If the number never moves
   * past one, the feature is not doing what it says.
   */
  get busyLabel(): string {
    const n = answerDesk.generatingCount;
    if (n === 0) return '';
    return n === 1 ? '1 generating…' : `${n} generating…`;
  }

  get question(): string {
    return this.selected?.field.label ?? '';
  }

  get matchedBy(): string {
    return this.selected?.field.how ?? '';
  }

  get isWeak(): boolean {
    return this.selected?.field.weak ?? false;
  }

  /**
   * A choice control is reported, never filtered out of the list.
   *
   * Hiding it would look like a scanner that missed a question. What actually
   * protects the user is that it carries no token, so `insertAnswerIntoField`
   * cannot be handed one — a compile error rather than a runtime check.
   */
  get isChoice(): boolean {
    return this.selected?.field.kind === 'choice';
  }

  get choiceNote(): string {
    const field = this.selected?.field;
    if (!field || field.kind !== 'choice') return '';
    const options = field.options.length ? ` — ${field.options.join(' / ')}` : '';
    return `This is a ${field.control}${options}. Draft an answer here if it helps, but the option is yours to pick.`;
  }

  /** A single-line input will not hold three paragraphs. Say so before Insert. */
  get narrowFieldNote(): string {
    const field = this.selected?.field;
    if (!field || field.kind !== 'text') return '';
    return field.control === 'input'
      ? 'That field is a single-line input — a long answer may not fit.'
      : '';
  }

  get existingNote(): string {
    const field = this.selected?.field;
    if (!field || field.kind !== 'text' || !field.existing) return '';
    return 'That field already has text. Insert replaces it.';
  }

  get instructions(): string[] {
    return this.selected?.draft?.instructions ?? [];
  }

  get input(): string {
    return this.selected?.draft?.input ?? '';
  }

  get content(): string {
    return this.selected?.draft?.content ?? '';
  }

  get note(): string {
    return this.selected?.draft?.note ?? '';
  }

  get isGenerating(): boolean {
    return this.selected?.draft?.status === 'generating';
  }

  get hasAnswer(): boolean {
    return this.content.trim().length > 0;
  }

  /** The two identities of the one input, in one place. */
  get actionLabel(): string {
    if (this.isGenerating) return 'Working…';
    return this.hasAnswer ? 'Refine' : 'Answer';
  }

  get inputLabel(): string {
    return this.hasAnswer ? 'What should change?' : 'Anything the model should know?';
  }

  get inputPlaceholder(): string {
    return this.hasAnswer
      ? 'e.g. shorter, and highlight my time at evendent.io'
      : 'Optional. e.g. this is a Toptal form — write in the third person';
  }

  get canInsert(): boolean {
    return this.selected?.field.kind === 'text' && this.hasAnswer;
  }

  rescan = (): void => void answerDesk.scan();

  pick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    answerDesk.select(target.value);
  };

  updateInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (this.selected) answerDesk.setInput(this.selected.key, target.value);
  };

  /** DraftBox reports upward; the desk owns the text. Data down, actions up. */
  updateContent = (next: string): void => {
    if (this.selected) answerDesk.setContent(this.selected.key, next);
  };

  submit = (): void => {
    if (this.selected && !this.isGenerating) void answerDesk.run(this.selected.key);
  };

  dropChip = (index: number): void => {
    if (this.selected) answerDesk.dropInstruction(this.selected.key, index);
  };

  insert = (): void => {
    if (this.selected) void answerDesk.insert(this.selected.key);
  };

  copy = (): void => {
    if (this.selected) void answerDesk.copy(this.selected.key);
  };

  <template>
    <div class="ad">
      <p class="ad__head">
        Questions on this page
        <span class="ad__head-actions">
          {{#if this.busyLabel}}<span class="ad__busy">{{this.busyLabel}}</span>{{/if}}
          <button type="button" class="ad__scan" {{on "click" this.rescan}}>
            {{this.scanLabel}}
          </button>
        </span>
      </p>

      {{#if this.desk.scanNote}}
        <p class="ad__note">{{this.desk.scanNote}}</p>
      {{/if}}

      {{#if this.hasQuestions}}
        {{! The picker. CCEXT-26 M2: the form's own labels, so nobody has to
            highlight a question by hand to be offered an answer for it. }}
        <label class="ad__pick-label" for="ad-picker">Question</label>
        <select id="ad-picker" class="ad__picker" {{on "change" this.pick}}>
          {{#each this.entries key="key" as |entry|}}
            <option value={{entry.key}} selected={{isChosen this.desk.selectedKey entry.key}}>
              {{optionLabel entry}}
            </option>
          {{/each}}
        </select>

        <p class="ad__q">{{this.question}}</p>
        <p class="ad__how">
          Matched by {{this.matchedBy}}{{#if this.isWeak}} — a guess, so check it{{/if}}
        </p>

        {{#if this.isChoice}}
          <p class="ad__choice">{{this.choiceNote}}</p>
        {{/if}}
        {{#if this.narrowFieldNote}}
          <p class="ad__warn">{{this.narrowFieldNote}}</p>
        {{/if}}
        {{#if this.existingNote}}
          <p class="ad__warn">{{this.existingNote}}</p>
        {{/if}}

        {{#if this.instructions.length}}
          <ul class="ad__chips">
            {{#each this.instructions key="@index" as |instruction index|}}
              <li class="ad__chip">
                <span class="ad__chip-text">{{instruction}}</span>
                <button
                  type="button"
                  class="ad__chip-x"
                  title="Drop this instruction"
                  aria-label="Drop instruction: {{instruction}}"
                  {{on "click" (fn this.dropChip index)}}
                >×</button>
              </li>
            {{/each}}
          </ul>
        {{/if}}

        <label class="ad__input-label" for="ad-input">{{this.inputLabel}}</label>
        <textarea
          id="ad-input"
          class="ad__input"
          rows="2"
          spellcheck="true"
          placeholder={{this.inputPlaceholder}}
          value={{this.input}}
          {{on "input" this.updateInput}}
        ></textarea>

        <div class="ad__actions">
          <button
            type="button"
            class="ad__btn ad__btn--go"
            disabled={{this.isGenerating}}
            {{on "click" this.submit}}
          >{{this.actionLabel}}</button>

          {{#if this.hasAnswer}}
            <button type="button" class="ad__btn" {{on "click" this.copy}}>
              <Icon @name="copy" />Copy
            </button>
          {{/if}}

          {{#if this.canInsert}}
            <button type="button" class="ad__btn" {{on "click" this.insert}}>
              <Icon @name="check" />Insert
            </button>
          {{/if}}
        </div>

        {{#if this.note}}
          <p class="ad__status">{{this.note}}</p>
        {{/if}}

        {{#if this.hasAnswer}}
          {{! We insert what is IN THE BOX, not what came back — an edit made
              here is the answer, and the model's version is only a start. }}
          <DraftBox
            @label="Answer"
            @value={{this.content}}
            @onInput={{this.updateContent}}
          />
        {{/if}}
      {{/if}}
    </div>
  </template>
}

function isChosen(selectedKey: string | null, key: string): boolean {
  return selectedKey === key;
}

/**
 * One line in the picker.
 *
 * The occurrence number is shown from the SECOND onwards, because that is the
 * only thing distinguishing two identical labels — a form with two "Why?"
 * boxes is asking two questions, and a picker that shows "Why?" twice with no
 * way to tell them apart is worse than one that never listed them.
 */
function optionLabel(entry: DeskEntry): string {
  const { field, draft } = entry;
  const ordinal = field.occurrence > 0 ? `(${field.occurrence + 1}) ` : '';
  const label = field.label.length > 70 ? `${field.label.slice(0, 69)}…` : field.label;
  const kind = field.kind === 'choice' ? ` · ${field.control}` : '';
  const state =
    draft?.status === 'generating' ? ' · …' : draft?.content ? ' · ✓' : '';
  return `${ordinal}${label}${kind}${state}`;
}
