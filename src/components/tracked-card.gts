import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { FRONTEND_ORIGIN } from '../lib/api.ts';
import { trackedPost } from '../state/tracked.ts';
import { scoreRunner } from '../state/score.ts';

/**
 * What Career Caddy already knows about this page.
 *
 * Shown instead of Send when the posting is already in the library. Offering
 * to send a page you already have is worse than doing nothing: it invites a
 * duplicate and hides the score you already earned.
 */
export default class TrackedCard extends Component {
  get tracked(): typeof trackedPost {
    return trackedPost;
  }

  get score(): typeof scoreRunner {
    return scoreRunner;
  }

  get postUrl(): string {
    return `${FRONTEND_ORIGIN}/job-posts/${trackedPost.post?.id}`;
  }

  get scoreUrl(): string {
    return `${FRONTEND_ORIGIN}/job-posts/${trackedPost.post?.id}/scores/${scoreRunner.scoreId}`;
  }

  /** The api stores 0–1; a bare "0.82" reads as a rating out of ten. */
  get scoreLabel(): string {
    const s = trackedPost.post?.topScore;
    if (typeof s !== 'number') return '';
    return s <= 1 ? `${Math.round(s * 100)}%` : String(Math.round(s));
  }

  /**
   * Someone else's score is already running. Distinct from OUR run: this one
   * we cannot narrate, because we have no score id to poll.
   */
  get otherScorePending(): boolean {
    return !!trackedPost.post?.hasPendingScore && !scoreRunner.isBusy;
  }

  startScore = (): void => scoreRunner.start();

  <template>
    {{#if this.tracked.isKnown}}
      <div class="tp">
        <div class="tp__head">
          <span class="tp__badge">In your library</span>
          {{#if this.scoreLabel}}
            <span class="tp__score">{{this.scoreLabel}}</span>
          {{else if this.otherScorePending}}
            <span class="tp__score tp__score--pending">scoring…</span>
          {{/if}}
        </div>

        <p class="tp__title">{{this.tracked.post.title}}</p>
        {{#if this.tracked.post.company}}
          <p class="tp__company">{{this.tracked.post.company}}</p>
        {{/if}}

        {{#if this.score.canScore}}
          <button type="button" class="tp__btn" {{on "click" this.startScore}}>
            Score this post
          </button>
        {{/if}}

        {{#if this.score.isBusy}}
          {{! The panel persists, so scoring is narrated here rather than
              handed to the worker and forgotten. }}
          <p class="tp__status">{{this.score.message}}</p>
        {{else if this.score.message}}
          <p class="tp__status">{{this.score.message}}</p>
        {{/if}}

        <div class="tp__links">
          <a class="tp__link" href={{this.postUrl}} target="_blank" rel="noopener">
            Open in Career Caddy →
          </a>
          {{#if this.score.scoreId}}
            <a class="tp__link" href={{this.scoreUrl}} target="_blank" rel="noopener">
              See the score →
            </a>
          {{/if}}
        </div>
      </div>
    {{else if (isLooking this.tracked.state)}}
      <p class="tp__looking">Checking your library…</p>
    {{/if}}
  </template>
}

function isLooking(state: string): boolean {
  return state === 'looking';
}
