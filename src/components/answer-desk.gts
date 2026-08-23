import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import QuestionPicker from './question-picker.gts';
import AnswerEditor from './answer-editor.gts';
import { answerDesk } from '../state/answer-desk.ts';
import type { DeskEntry } from '../domain/answer-desk.ts';

/**
 * The answer desk — the frame, and nothing else.
 *
 * Three pieces with one job each: this owns the scan control and the wiring,
 * `<QuestionPicker>` owns the list in its two views, `<AnswerEditor>` owns one
 * question's draft. The split is not tidiness — the picker and the editor take
 * `@args` and callbacks, so neither can reach into `answerDesk` and quietly
 * grow a second way to change state. This file is the only place that knows
 * both the desk and the components exist.
 *
 * Binding the key here is what lets the editor's callbacks be argument-free:
 * it never learns which question it is editing, which means it cannot edit a
 * different one.
 */
export default class AnswerDeskCard extends Component {
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
   * Worth its own line because it is the claim this surface makes: you are not
   * waiting on one answer at a time. If this number never moves past one, the
   * feature is not doing what it says.
   */
  get busyLabel(): string {
    const n = answerDesk.generatingCount;
    if (n === 0) return '';
    return n === 1 ? '1 generating…' : `${n} generating…`;
  }

  /**
   * What the picker says when it has nothing to show.
   *
   * Before a scan this is an invitation; after one it is `scanNote`, which
   * already distinguishes "no labelled questions here" from "this form is in a
   * frame I am not allowed to read". Those are different facts and the second
   * is not the user's fault.
   */
  get emptyNote(): string {
    if (answerDesk.scanState === 'scanning') return 'Looking for questions…';
    if (answerDesk.scanNote) return answerDesk.scanNote;
    return 'Find questions to list this form’s prose fields.';
  }

  rescan = (): void => void answerDesk.scan();

  select = (key: string): void => answerDesk.select(key);

  // Each of these closes over the selected key, so the editor never handles one.
  updateInput = (value: string): void => {
    if (this.selected) answerDesk.setInput(this.selected.key, value);
  };

  updateContent = (value: string): void => {
    if (this.selected) answerDesk.setContent(this.selected.key, value);
  };

  dropChip = (index: number): void => {
    if (this.selected) answerDesk.dropInstruction(this.selected.key, index);
  };

  submit = (): void => {
    if (this.selected) void answerDesk.run(this.selected.key);
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

      <QuestionPicker
        @entries={{this.entries}}
        @selectedKey={{this.desk.selectedKey}}
        @onSelect={{this.select}}
        @emptyNote={{this.emptyNote}}
      />

      {{#if this.selected}}
        <AnswerEditor
          @entry={{this.selected}}
          @onInput={{this.updateInput}}
          @onContent={{this.updateContent}}
          @onDropChip={{this.dropChip}}
          @onSubmit={{this.submit}}
          @onInsert={{this.insert}}
          @onCopy={{this.copy}}
        />
      {{/if}}
    </div>
  </template>
}
