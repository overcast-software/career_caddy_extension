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
import { resolveActiveId, tabLabel } from '../domain/sections.ts';
import type { SectionSpec } from '../domain/sections.ts';
import { layout } from '../state/layout.ts';

export type { SectionSpec } from '../domain/sections.ts';

export interface SectionSetSignature {
  Args: { sections: SectionSpec[] };
  Element: HTMLDivElement;
}

/**
 * In tabs mode, the tab bar. The sections themselves render their own chrome
 * (or not) depending on the mode.
 *
 * The caller's markup is identical for both layouts, which is the whole point:
 * choosing between them is a container decision, not a rewrite of the content.
 *
 * The layout SWITCH used to live here, above the tabs. It moved to Diagnostics
 * (CCEXT-87) — it is an A/B control for deciding accordion-vs-tabs, not a
 * setting, and it was spending the top of every tab to say so.
 */
export default class SectionSet extends Component<SectionSetSignature> {
  get isTabs(): boolean {
    return layout.mode === 'tabs';
  }

  /**
   * Resolved against the sections actually on screen, not read from `layout`.
   * A persisted `activeId` can name a section this user cannot see.
   */
  get activeId(): string {
    return resolveActiveId(this.args.sections, layout.activeId);
  }

  isActive = (id: string): boolean => this.activeId === id;
  select = (id: string): void => layout.toggle(id);
  label = (spec: SectionSpec): string => tabLabel(spec);

  <template>
    <div class="sset" ...attributes>
      {{#if this.isTabs}}
        <div class="sset__tabs" role="tablist">
          {{#each @sections key="id" as |spec|}}
            <button
              type="button"
              role="tab"
              class="sset__tab {{if (this.isActive spec.id) 'is-active'}}"
              aria-selected="{{if (this.isActive spec.id) 'true' 'false'}}"
              title={{spec.title}}
              {{on "click" (fn this.select spec.id)}}
            >{{this.label spec}}</button>
          {{/each}}
        </div>
      {{/if}}
    </div>
  </template>
}
