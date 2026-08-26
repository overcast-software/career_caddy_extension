import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import DraftBox from './draft-box.gts';
import Icon from './icon.gts';
import type { DeskEntry } from '../domain/answer-desk.ts';

/**
 * One question's draft: what you have told it, what it wrote, where it goes.
 *
 * **ONE INPUT, TWO IDENTITIES.** Before an answer exists it is the prompt box
 * — "anything else the model should know?". After one it is the refine box —
 * "what should change?". Not a dialogue and not a transcript: the turn history
 * already exists server-side, because every generate and every refine is
 * another `Answer` row against the same `Question`.
 *
 * **INSTRUCTIONS ACCUMULATE, as chips.** "This is a Toptal form, third person"
 * stays in force when you later say "highlight my time at evendent.io" — which
 * is exactly why they are chips with an × rather than an input you retype.
 * Taking one back out has to be possible, and it has to be visible.
 */
export interface AnswerEditorSignature {
  Args: {
    /** The selected question. The parent renders this only when there is one. */
    entry: DeskEntry;
    onInput: (value: string) => void;
    onContent: (value: string) => void;
    onDropChip: (index: number) => void;
    onSubmit: () => void;
    onInsert: () => void;
    onCopy: () => void;
  };
  Element: HTMLDivElement;
}

export default class AnswerEditor extends Component<AnswerEditorSignature> {
  get field(): DeskEntry['field'] {
    return this.args.entry.field;
  }

  get instructions(): string[] {
    return this.args.entry.draft?.instructions ?? [];
  }

  get input(): string {
    return this.args.entry.draft?.input ?? '';
  }

  get content(): string {
    return this.args.entry.draft?.content ?? '';
  }

  get note(): string {
    return this.args.entry.draft?.note ?? '';
  }

  get isGenerating(): boolean {
    return this.args.entry.draft?.status === 'generating';
  }

  get hasAnswer(): boolean {
    return this.content.trim().length > 0;
  }

  get isChoice(): boolean {
    return this.field.kind === 'choice';
  }

  /**
   * A choice control is described, never decorated with an Insert button.
   *
   * It carries no token, so the write path could not accept it even if this
   * said otherwise — the type system refuses it. This is the same rule stated
   * as a sentence, so the user learns why nothing can be inserted rather than
   * hunting for a missing button.
   */
  get choiceNote(): string {
    const field = this.field;
    if (field.kind !== 'choice') return '';
    const options = field.options.length ? ` — ${field.options.join(' / ')}` : '';
    return `This is a ${field.control}${options}. Draft an answer here if it helps, but the option is yours to pick.`;
  }

  get narrowFieldNote(): string {
    const field = this.field;
    if (field.kind !== 'text') return '';
    return field.control === 'input'
      ? 'That field is a single-line input — a long answer may not fit.'
      : '';
  }

  get existingNote(): string {
    const field = this.field;
    if (field.kind !== 'text' || !field.existing) return '';
    return 'That field already has text. Insert replaces it.';
  }

  get matchedBy(): string {
    return this.field.how;
  }

  get isWeak(): boolean {
    return this.field.weak;
  }

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

  /** Insert only reaches a writable field with something to put in it. */
  get canInsert(): boolean {
    return this.field.kind === 'text' && this.hasAnswer;
  }

  handleInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    this.args.onInput(target.value);
  };

  submit = (): void => {
    if (!this.isGenerating) this.args.onSubmit();
  };

  <template>
    <div class="ae" ...attributes>
      <p class="ae__q">{{this.field.label}}</p>
      <p class="ae__how">
        Matched by {{this.matchedBy}}{{#if this.isWeak}} — a guess, so check it{{/if}}
      </p>

      {{#if this.isChoice}}
        <p class="ae__choice">{{this.choiceNote}}</p>
      {{/if}}
      {{#if this.narrowFieldNote}}
        <p class="ae__warn">{{this.narrowFieldNote}}</p>
      {{/if}}
      {{#if this.existingNote}}
        <p class="ae__warn">{{this.existingNote}}</p>
      {{/if}}

      {{#if this.instructions.length}}
        <ul class="ae__chips">
          {{#each this.instructions key="@index" as |instruction index|}}
            <li class="ae__chip">
              <span class="ae__chip-text">{{instruction}}</span>
              <button
                type="button"
                class="ae__chip-x"
                title="Drop this instruction"
                aria-label="Drop instruction: {{instruction}}"
                {{on "click" (drop @onDropChip index)}}
              >×</button>
            </li>
          {{/each}}
        </ul>
      {{/if}}

      <label class="ae__input-label" for="ae-input">{{this.inputLabel}}</label>
      <textarea
        id="ae-input"
        class="ae__input"
        rows="2"
        spellcheck="true"
        placeholder={{this.inputPlaceholder}}
        value={{this.input}}
        {{on "input" this.handleInput}}
      ></textarea>

      <div class="ae__actions">
        {{! The in-flight guard lives HERE, on the control that spends an api
            call — not on the question rows, which only select. }}
        <button
          type="button"
          class="ae__btn ae__btn--go"
          disabled={{this.isGenerating}}
          {{on "click" this.submit}}
        >{{this.actionLabel}}</button>

        {{#if this.hasAnswer}}
          <button type="button" class="ae__btn" {{on "click" @onCopy}}>
            <Icon @name="copy" />Copy
          </button>
        {{/if}}

        {{#if this.canInsert}}
          <button type="button" class="ae__btn" {{on "click" @onInsert}}>
            <Icon @name="check" />Insert
          </button>
        {{/if}}
      </div>

      {{#if this.note}}
        <p class="ae__status">{{this.note}}</p>
      {{/if}}

      {{#if this.hasAnswer}}
        {{! We insert what is IN THE BOX, not what came back — an edit made
            here is the answer, and the model's version is only a start. }}
        <DraftBox
          @label="Answer"
          @value={{this.content}}
          @onInput={{@onContent}}
        />
      {{/if}}
    </div>
  </template>
}

/**
 * Bind the chip index — a closure rather than `{{fn}}`, for the reason
 * `link-card.gts:157-175` records: a render-time failure under this project's
 * owner-less `renderComponent` blanks the panel with a clean console, and no
 * gate catches it. A closure cannot fail that way and costs nothing.
 *
 * The conservative choice, not a verdict — `segmented.gts:47` ships `{{fn}}`,
 * so one of the two is wrong. **CCEXT-53** settles it, in a browser.
 */
function drop(fn: (index: number) => void, index: number): () => void {
  return () => fn(index);
}
