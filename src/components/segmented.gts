import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';

export interface SegmentedOption {
  value: string;
  label: string;
}

export interface SegmentedSignature {
  Args: {
    /** The choices, in display order. */
    options: SegmentedOption[];
    /** Which one is active. Compared by `value`. */
    value: string;
    /** Called with the chosen `value`. The caller owns the state. */
    onSelect: (value: string) => void;
    /** Announced to screen readers; the control has no visible heading. */
    label: string;
  };
  Element: HTMLDivElement;
}

/**
 * A small segmented control — the layout switch and the theme switch are the
 * same widget, so they are the same component.
 *
 * Note what it does NOT do: it holds no state. `@value` comes in, `@onSelect`
 * goes out, and the caller decides what that means. That is Glimmer's
 * data-down-actions-up convention, and `this.args.value` being readonly is the
 * compiler enforcing it rather than a code-review convention.
 */
export default class Segmented extends Component<SegmentedSignature> {
  isActive = (value: string): boolean => this.args.value === value;

  <template>
    <div class="seg" role="group" aria-label={{@label}} ...attributes>
      {{#each @options key="value" as |option|}}
        <button
          type="button"
          class="seg__btn {{if (this.isActive option.value) 'is-on'}}"
          aria-pressed="{{if (this.isActive option.value) 'true' 'false'}}"
          {{on "click" (fn @onSelect option.value)}}
        >{{option.label}}</button>
      {{/each}}
    </div>
  </template>
}
