import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { FRONTEND_ORIGIN } from '../lib/api.ts';
import { matchApp } from '../state/match-app.ts';
import { ladder } from '../state/ladder.ts';

/**
 * CC-135 — "I applied here; find the posting for me."
 *
 * The last resort, shown only when the ladder produced nothing AND you are
 * staff. If there is a ladder offer, answering it is cheaper and more certain;
 * showing both would invite picking the worse one.
 *
 * The button says what it DOES, in order: it records the application first and
 * searches second. That order is the feature — you did apply, and that fact
 * should not wait on a matcher.
 */
export default class MatchAppCard extends Component {
  get match(): typeof matchApp {
    return matchApp;
  }

  /** Suppressed while a ladder offer is unanswered — one question at a time. */
  get show(): boolean {
    return matchApp.canAsk && !ladder.hasOffer;
  }

  get postUrl(): string {
    return `${FRONTEND_ORIGIN}/job-posts/${matchApp.found?.id}`;
  }

  /** Stored 0–1; a bare "0.82" reads as a rating out of ten. */
  get confidenceLabel(): string {
    const c = matchApp.confidence;
    if (typeof c !== 'number') return '';
    return c <= 1 ? `${Math.round(c * 100)}%` : String(Math.round(c));
  }

  ask = (): void => void matchApp.ask();
  accept = (): void => matchApp.accept();

  <template>
    {{#if this.show}}
      <button type="button" class="ma__ask" {{on "click" this.ask}}>
        I applied here — find the posting
      </button>
      <p class="ma__hint">
        Records the application now, then asks Career Caddy which posting it was.
      </p>
    {{/if}}

    {{#if this.match.isBusy}}
      <p class="ma__status">{{this.match.status}}</p>
    {{/if}}

    {{#if (is this.match.state "matched")}}
      <div class="ma">
        <div class="ma__head">
          <span class="ma__badge">Career Caddy found it</span>
          {{#if this.confidenceLabel}}
            {{! Shown because it is a MACHINE's answer to a question you could
                not answer yourself — you are entitled to know how sure it is. }}
            <span class="ma__conf">{{this.confidenceLabel}} sure</span>
          {{/if}}
        </div>
        <p class="ma__title">{{this.match.found.title}}</p>
        {{#if this.match.found.company}}
          <p class="ma__company">{{this.match.found.company}}</p>
        {{/if}}
        {{#if this.match.rationale}}
          <p class="ma__why">{{this.match.rationale}}</p>
        {{/if}}
        <a class="ma__link" href={{this.postUrl}} target="_blank" rel="noopener">
          View job post →
        </a>
        <button type="button" class="ma__accept" {{on "click" this.accept}}>
          Use this post
        </button>
      </div>
    {{else if (is this.match.state "nomatch")}}
      {{! The application still exists. Say so, or this reads as total failure. }}
      <p class="ma__status">
        {{this.match.status}} Your application was still recorded.
      </p>
    {{else if (is this.match.state "error")}}
      <p class="ma__status is-err">{{this.match.status}}</p>
    {{/if}}
  </template>
}

function is(state: string, want: string): boolean {
  return state === want;
}
