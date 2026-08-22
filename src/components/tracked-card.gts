import Component from '@glimmer/component';
import { FRONTEND_ORIGIN } from '../lib/api.ts';
import { trackedPost } from '../state/tracked.ts';

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

  get postUrl(): string {
    return `${FRONTEND_ORIGIN}/job-posts/${trackedPost.post?.id}`;
  }

  /** Rendered as a percentage; the api stores 0–1. */
  get scoreLabel(): string {
    const s = trackedPost.post?.topScore;
    if (typeof s !== 'number') return '';
    return s <= 1 ? `${Math.round(s * 100)}%` : String(Math.round(s));
  }

  <template>
    {{#if this.tracked.isKnown}}
      <div class="tp">
        <div class="tp__head">
          <span class="tp__badge">In your library</span>
          {{#if this.scoreLabel}}
            <span class="tp__score">{{this.scoreLabel}}</span>
          {{else if this.tracked.post.hasPendingScore}}
            <span class="tp__score tp__score--pending">scoring…</span>
          {{/if}}
        </div>

        <p class="tp__title">{{this.tracked.post.title}}</p>
        {{#if this.tracked.post.company}}
          <p class="tp__company">{{this.tracked.post.company}}</p>
        {{/if}}

        <a class="tp__link" href={{this.postUrl}} target="_blank" rel="noopener">
          Open in Career Caddy →
        </a>

        {{#if this.tracked.needsRefresh}}
          {{! The api says this post never finished extracting, so sending it
              again is the useful action rather than a duplicate. }}
          <p class="tp__warn">
            This one didn't finish extracting — sending it again will refresh it.
          </p>
        {{/if}}
      </div>
    {{else if (isLooking this.tracked.state)}}
      <p class="tp__looking">Checking your library…</p>
    {{/if}}
  </template>
}

function isLooking(state: string): boolean {
  return state === 'looking';
}
