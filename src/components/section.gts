import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { layout } from '../state/layout.ts';

/** One section's identity. Bodies arrive as blocks, not as data. */
export interface SectionSpec {
  id: string;
  title: string;
  /** One line shown while collapsed, so a shut section still tells you something. */
  summary?: string;
}

export interface SectionSignature {
  Args: {
    id: string;
    /** The same array <SectionSet> renders its tab bar from. */
    sections: SectionSpec[];
  };
  Blocks: { default: [] };
}

/**
 * One section. In accordion mode it draws its own clickable header; in tabs
 * mode the header lives in the tab bar above, so it renders only its body —
 * and only when it is the active tab.
 *
 * The caller writes the same markup either way. That is the point: switching
 * layout is a container decision, not a rewrite of the content.
 */
export default class Section extends Component<SectionSignature> {
  get spec(): SectionSpec | undefined {
    return this.args.sections.find((s) => s.id === this.args.id);
  }

  get title(): string {
    return this.spec?.title ?? this.args.id;
  }

  get summary(): string {
    return this.spec?.summary ?? '';
  }

  /**
   * Reading `layout.mode` / `layout.openIds` inside a getter is what
   * subscribes this component to them. Autotracking records the dependency at
   * the moment of the read — there is no subscribe call and nothing to tear
   * down, which is why a module-scoped singleton works here at all.
   */
  get isAccordion(): boolean {
    return layout.mode === 'accordion';
  }

  get isOpen(): boolean {
    return layout.isVisible(this.args.id);
  }

  toggle = (): void => layout.toggle(this.args.id);

  <template>
    {{#if this.isAccordion}}
      <section class="sec">
        <button
          type="button"
          class="sec__head {{if this.isOpen 'is-open'}}"
          aria-expanded="{{if this.isOpen 'true' 'false'}}"
          {{on "click" this.toggle}}
        >
          <span class="sec__chevron" aria-hidden="true">{{if this.isOpen "▾" "▸"}}</span>
          <span class="sec__title">{{this.title}}</span>
          {{#unless this.isOpen}}
            <span class="sec__summary">{{this.summary}}</span>
          {{/unless}}
        </button>
        {{#if this.isOpen}}
          <div class="sec__body">{{yield}}</div>
        {{/if}}
      </section>
    {{else if this.isOpen}}
      <div class="sec__body sec__body--tab">{{yield}}</div>
    {{/if}}
  </template>
}
