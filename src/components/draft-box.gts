import Component from '@glimmer/component';
import { on } from '@ember/modifier';

/**
 * A component *signature*. This is the piece of Glimmer that has no real
 * equivalent in Vue: it types the TEMPLATE, not just the class.
 *
 * Vue's `defineProps<T>()` covers roughly the `Args` half. Glimmer also types
 * where `...attributes` may land, and what each named block yields back.
 */
export interface DraftBoxSignature {
  /**
   * Everything a caller may pass with `@`. Two consequences you get for free:
   * passing an arg that is not listed is a compile error, and omitting a
   * required one is too. `<DraftBox @lable="x" />` fails to build rather than
   * silently rendering nothing — that typo class is otherwise invisible.
   */
  Args: {
    label: string;
    value: string;
    /**
     * A callback, typed as a function. The caller owns the state; we only
     * report upward. This is Glimmer's data-down-actions-up convention, and
     * unlike Vue there is no `v-model` escape hatch — `this.args.value` is
     * genuinely readonly, enforced by the compiler rather than by etiquette.
     */
    onInput: (next: string) => void;
  };

  /**
   * Where `...attributes` goes. This makes `<DraftBox class="mt-2" />`
   * type-check, and — more usefully — stops you splatting attributes onto a
   * component that has nowhere to put them.
   */
  Element: HTMLDivElement;
}

export default class DraftBox extends Component<DraftBoxSignature> {
  /**
   * A plain getter is Glimmer's `computed`. No decorator, no wrapper: because
   * it reads `this.args.value`, autotracking records that dependency the first
   * time it runs and re-runs it when the value changes. The tracking is a
   * consequence of the read, not of any annotation.
   */
  get charCount(): number {
    return this.args.value.length;
  }

  /**
   * `Event` is what the DOM hands you, so `event.target` is typed
   * `EventTarget | null` — an EventTarget has no `.value`. The instanceof
   * check narrows it to something that does.
   *
   * This is not ceremony. `event.target` really can be null, and on a
   * delegated handler it really can be some other element; the check is the
   * runtime guard you should have written anyway, and TypeScript's only
   * contribution is refusing to let you skip it.
   */
  handleInput = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    this.args.onInput(target.value);
  };

  <template>
    <div class="draft" ...attributes>
      <label class="draft__label" for="draft-input">{{@label}}</label>
      <textarea
        id="draft-input"
        class="draft__input"
        rows="6"
        spellcheck="true"
        value={{@value}}
        {{on "input" this.handleInput}}
      ></textarea>
      <p class="draft__count">{{this.charCount}} characters</p>
    </div>
  </template>
}
