import Component from '@glimmer/component';
import type Owner from '@ember/owner';
import { on } from '@ember/modifier';
import Icon from './icon.gts';
import { FRONTEND_ORIGIN } from '../lib/api.ts';
import { application } from '../state/application.ts';
import { trackedPost } from '../state/tracked.ts';
import { ladder } from '../state/ladder.ts';
import { page } from '../state/page.ts';

/**
 * Track an application against the job post matched to this page.
 *
 * Creates the JobApplication IN PLACE and confirms inline — it never opens a
 * tab. The legacy is explicit about this and it is worth preserving: you are
 * mid-application on someone's careers site, and being thrown into a new tab
 * to confirm a bookkeeping action loses your place in the form you were
 * filling.
 *
 * When no post is matched, this says so and points at the Send surface rather
 * than showing a disabled button. "Track application" with nothing to track is
 * a dead control, and a dead control reads as a bug.
 */
export default class ApplicationCard extends Component {
  constructor(owner: Owner, args: object) {
    super(owner, args);
    // On open and on every navigation: if a post is known for this page, ask
    // once whether it already has an application. Cached, so revisiting a page
    // costs nothing.
    void this.check();
    page.onChange(() => void this.check());
  }

  private check(): void {
    const id = trackedPost.post?.id;
    if (id) void application.refreshFor(id);
  }

  get app(): typeof application {
    return application;
  }

  get tracked(): typeof trackedPost {
    return trackedPost;
  }

  /**
   * An unanswered offer is not the same as "nothing here".
   *
   * The empty state tells you to go and send the page. While an offer is on
   * screen that instruction is wrong AND contradicts the card directly above
   * it, which is naming a post. The offer is the shorter path, so the empty
   * state waits until it has been answered.
   */
  get showEmpty(): boolean {
    return !trackedPost.isKnown && !ladder.hasOffer;
  }

  get postUrl(): string {
    return `${FRONTEND_ORIGIN}/job-posts/${trackedPost.post?.id}`;
  }

  /**
   * Nested under the post when we know it, flat when we do not. The api
   * accepts both; the nested form is the one that shows the application in
   * the context of its post, which is what you want when you click through.
   */
  get appUrl(): string {
    const postId = trackedPost.post?.id;
    const appId = application.appId;
    if (!appId) return '';
    return postId
      ? `${FRONTEND_ORIGIN}/job-posts/${postId}/job-applications/${appId}`
      : `${FRONTEND_ORIGIN}/job-applications/${appId}`;
  }

  /** The api stores 0–1; a bare "0.82" reads as a rating out of ten. */
  get scoreLabel(): string {
    const s = trackedPost.post?.topScore;
    if (typeof s !== 'number') return '';
    return s <= 1 ? `${Math.round(s * 100)}%` : String(Math.round(s));
  }

  track = (): void => {
    void application.track();
  };

  <template>
    {{#if this.tracked.isKnown}}
      <div class="ac">
        <div class="ac__head">
          {{! CCEXT-89: the same words and the same badge as <TrackedCard>.
              This card used to say "Matched post" in accent purple while that
              one said "In your library" in green — for THE SAME POST, one tab
              apart. "Matched" also described how we found it, which is our
              problem and not the reader's. }}
          <span class="ac__badge">In your library</span>
          {{#if this.scoreLabel}}
            <span class="ac__score">{{this.scoreLabel}}</span>
          {{/if}}
        </div>

        <p class="ac__title">{{this.tracked.post.title}}</p>
        {{#if this.tracked.post.company}}
          <p class="ac__company">{{this.tracked.post.company}}</p>
        {{/if}}

        {{!-- CCEXT-36: the card proposes a post you must judge — give a way to
            actually look at it before acting on it. --}}
        <a class="ac__link" href={{this.postUrl}} target="_blank" rel="noopener">
          View job post →
        </a>

        {{#if this.app.canTrack}}
          <button type="button" class="ac__btn" {{on "click" this.track}}>
            Track application
          </button>
        {{/if}}

        {{#if this.app.status}}
          {{! CCEXT-89: "Already tracked" sat as bare prose between two links
              and read as a DISABLED LINK — something that ought to be
              clickable and is not. It is a status, so it is marked as one: a
              check for the settled case, the error colour for the other. }}
          <p class="ac__status {{errClass this.app.state}}">
            {{#unless (isErr this.app.state)}}<Icon @name="check" />{{/unless}}
            {{this.app.status}}
          </p>
        {{/if}}

        {{#if this.appUrl}}
          <a class="ac__link" href={{this.appUrl}} target="_blank" rel="noopener">
            View application →
          </a>
        {{/if}}
      </div>
    {{else if this.showEmpty}}
      <p class="ac__empty">
        No job post is linked to this page yet. Send it from
        <strong>This page</strong> first — then track your application here.
      </p>
    {{/if}}
  </template>
}

function errClass(state: string): string {
  return isErr(state) ? 'is-err' : '';
}

function isErr(state: string): boolean {
  return state === 'error';
}
