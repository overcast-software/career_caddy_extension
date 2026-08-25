import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { fn } from '@ember/helper';
import Icon from './icon.gts';
import type { IconName } from './icon.gts';

export interface SegmentedOption {
  value: string;
  label: string;
  /** Optional. Rendered before the label; inherits the button's colour. */
  icon?: IconName;
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
    /**
     * Icon-only, sized to its content instead of stretching (CCEXT-87).
     *
     * The text label is still RENDERED — visually hidden by CSS, not removed —
     * so the accessible name is unchanged and a `title` carries it on hover.
     * Swapping it for an `aria-label` would have been the same pixels and a
     * worse tree, and it is the kind of substitution that quietly drops the
     * name when someone later edits one of the two places.
     */
    compact?: boolean;
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
    <div
      class="seg {{if @compact 'seg--compact'}}"
      role="group"
      aria-label={{@label}}
      ...attributes
    >
      {{#each @options key="value" as |option|}}
        <button
          type="button"
          class="seg__btn {{if (this.isActive option.value) 'is-on'}}"
          aria-pressed="{{if (this.isActive option.value) 'true' 'false'}}"
          title={{option.label}}
          {{on "click" (fn @onSelect option.value)}}
        >
          {{#if option.icon}}<Icon @name={{option.icon}} />{{/if}}
          <span class="seg__label">{{option.label}}</span>
        </button>
      {{/each}}
    </div>
  </template>
}
