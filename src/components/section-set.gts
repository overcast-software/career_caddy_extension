import Component from '@glimmer/component';
import { on } from '@ember/modifier';
// Strict-mode templates (which .gts always are) have no global resolver, so
// anything referenced must be in scope. `fn` and `hash` are importable from
// @ember/helper.
//
// `component` is NOT — it is a built-in template KEYWORD, always in scope and
// exported by no module. Importing it fails the build with "component is not
// exported by @ember/helper", which reads like a missing dependency and is
// precisely the opposite.
import { fn } from '@ember/helper';
import type { SectionSpec } from './section.gts';
import { layout } from '../state/layout.ts';
import type { LayoutMode } from '../state/layout.ts';

export type { SectionSpec } from './section.gts';

export interface SectionSetSignature {
  Args: { sections: SectionSpec[] };
  Element: HTMLDivElement;
}

/**
 * Renders the layout switch and, in tabs mode, the tab bar. The sections
 * themselves render their own chrome (or not) depending on the mode.
 *
 * The caller's markup is identical for both layouts, which is the whole point:
 * choosing between them is a container decision, not a rewrite of the content.
 */
export default class SectionSet extends Component<SectionSetSignature> {
  get isTabs(): boolean {
    return layout.mode === 'tabs';
  }

  isActive = (id: string): boolean => layout.activeId === id;
  select = (id: string): void => layout.toggle(id);
  setMode = (mode: LayoutMode): void => layout.setMode(mode);

  <template>
    <div class="sset" ...attributes>
      {{! Temporary, while the IA is decided by use rather than by argument.
          Once one layout clearly wins, delete the switch and the loser. }}
      <div class="sset__switch" role="group" aria-label="Layout">
        <button
          type="button"
          class="sset__switch-btn {{unless this.isTabs 'is-on'}}"
          {{on "click" (fn this.setMode "accordion")}}
        >Accordion</button>
        <button
          type="button"
          class="sset__switch-btn {{if this.isTabs 'is-on'}}"
          {{on "click" (fn this.setMode "tabs")}}
        >Tabs</button>
      </div>

      {{#if this.isTabs}}
        <div class="sset__tabs" role="tablist">
          {{#each @sections key="id" as |spec|}}
            <button
              type="button"
              role="tab"
              class="sset__tab {{if (this.isActive spec.id) 'is-active'}}"
              aria-selected="{{if (this.isActive spec.id) 'true' 'false'}}"
              {{on "click" (fn this.select spec.id)}}
            >{{spec.title}}</button>
          {{/each}}
        </div>
      {{/if}}
    </div>
  </template>
}
