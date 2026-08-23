import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { linkPicker } from '../state/link-picker.ts';
import { trackedPost } from '../state/tracked.ts';
import type { JobPost } from '../domain/job-post.ts';

/**
 * "This page belongs to a post I already have."
 *
 * The escape hatch for when automatic matching cannot work: you are on the
 * company's own careers site, but your library has the same job from LinkedIn.
 * Two URLs, one job, and nothing but you can tell them apart.
 *
 * Note what is NOT here compared with the legacy: no `replaceChildren`, no
 * `linkJobEmptyRow` DOM factory, no manual re-render on toggle. `{{#each}}`
 * over a `@tracked` array covers all three. The sequence guard that survived
 * lives in state/link-picker.ts with a comment about why — it guards the fetch
 * race, which reactivity has nothing to say about.
 */
export default class LinkCard extends Component {
  get picker(): typeof linkPicker {
    return linkPicker;
  }

  get tracked(): typeof trackedPost {
    return trackedPost;
  }

  /**
   * The page is already in the library, so this picker would REPOINT an
   * existing link rather than create one.
   *
   * Demoted with a caption, not hidden. Hiding a card because the app thinks
   * it already has the answer is the mistake Send made — "I should have been
   * granted an opportunity to use ext sender" — and the app's answer is
   * exactly what a user reaches for this to correct.
   */
  get alreadyKnown(): boolean {
    return trackedPost.isKnown;
  }

  onInput = (event: Event): void => {
    linkPicker.search((event.target as HTMLInputElement).value.trim());
  };

  /**
   * Opening the section loads; closing resets. Loading on open rather than on
   * panel start means a user who never asks to link never pays for the search.
   */
  onToggle = (event: Event): void => {
    if ((event.target as HTMLDetailsElement).open) {
      void linkPicker.load();
    } else {
      linkPicker.reset();
    }
  };

  link = (post: JobPost): void => {
    void linkPicker.link(post);
  };

  <template>
    {{#if this.picker.canLink}}
    <details class="lp" {{on "toggle" this.onToggle}}>
      <summary class="lp__summary">
        {{#if this.alreadyKnown}}
          Link this page to a different job post
        {{else}}
          Link this page to a job post
        {{/if}}
      </summary>

      {{#if this.alreadyKnown}}
        <p class="lp__note">
          This page is already linked to
          “{{this.tracked.post.title}}”. Picking another post repoints it.
        </p>
      {{/if}}

      <input
        type="search"
        class="lp__search"
        placeholder="Search your posts…"
        value={{this.picker.query}}
        {{on "input" this.onInput}}
      />

      {{#if this.picker.status}}
        <p class="lp__status {{errorClass this.picker.statusIsError}}">
          {{this.picker.status}}
        </p>
      {{/if}}

      {{#if (isSearching this.picker.state this.picker.resultsAreCurrent)}}
        {{! Also covers the gap between a keystroke and its fetch, when the
            rows on screen still answer the PREVIOUS query. }}
        <p class="lp__empty">Searching…</p>
      {{else if (is this.picker.state "empty")}}
        {{! Deliberately different words for "your search matched nothing" and
            "you have no posts" — the first is a hint to retype, the second is
            not, and one message for both sends people looking for a bug. }}
        <p class="lp__empty">
          {{#if this.picker.query}}
            No posts match that search.
          {{else}}
            No tracked jobs yet.
          {{/if}}
        </p>
      {{else if (is this.picker.state "ready")}}
        <ul class="lp__list">
          {{#each this.picker.results key="id" as |post|}}
            <li class="lp__row">
              <button
                type="button"
                class="lp__pick {{confirmClass (this.picker.needsConfirm post)}}"
                disabled={{isLinking this.picker.linkingId post.id}}
                {{on "click" (pick this.link post)}}
              >
                <span class="lp__title">{{post.title}}</span>
                {{#if post.company}}
                  <span class="lp__company">{{post.company}}</span>
                {{/if}}
                {{#if (this.picker.needsConfirm post)}}
                  <span class="lp__warn">has an apply link — click twice</span>
                {{/if}}
              </button>
            </li>
          {{/each}}
        </ul>
      {{/if}}
    </details>
    {{/if}}
  </template>
}

function is(state: string, want: string): boolean {
  return state === want;
}

/** Searching, OR showing rows that answer a query the user has moved past. */
function isSearching(state: string, resultsAreCurrent: boolean): boolean {
  return state === 'loading' || (state === 'ready' && !resultsAreCurrent);
}

function errorClass(isError: boolean): string {
  return isError ? 'is-err' : '';
}

function confirmClass(needsConfirm: boolean): string {
  return needsConfirm ? 'lp__pick--confirm' : '';
}

function isLinking(linkingId: string | null, id: string): boolean {
  return linkingId === id;
}

/**
 * Bind a post to the click handler — a plain function returning a closure,
 * which is all `{{fn}}` does.
 *
 * `{{fn}}` may well work here; it BUILDS fine, and it is a compiler keyword
 * rather than an owner-resolved helper, so it probably does not need the
 * container. But "builds fine" is worth nothing in this codebase: yielded
 * contextual components also built fine and then threw
 * `Cannot read properties of null (reading 'manager')` at render, under this
 * same owner-less `renderComponent`. A render-time failure here blanks the
 * panel with a clean console — the single most expensive failure mode this
 * project has, and one no gate catches.
 *
 * So this stays a closure until something actually exercises `{{fn}}` in a
 * browser. Cheap to keep, cheap to delete once we know.
 */
function pick(fn: (post: JobPost) => void, post: JobPost): () => void {
  return () => fn(post);
}
