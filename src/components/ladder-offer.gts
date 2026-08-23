import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { FRONTEND_ORIGIN } from '../lib/api.ts';
import { ladder } from '../state/ladder.ts';

/**
 * "Is this the job you're applying to?"
 *
 * Shown when the ladder identified a post for a page whose URL matches
 * nothing — the normal case on an application form, which lives at a
 * different URL than the description it belongs to.
 *
 * ALWAYS AN OFFER, never an automatic adoption, and the tentative case says
 * so in different words. A wrong match does not fail loudly: it attaches your
 * application to somebody else's posting, where you would find it weeks later
 * with no way to tell how it got there. So the post is named, linked, and
 * waits to be judged.
 */
export default class LadderOffer extends Component {
  get ladder(): typeof ladder {
    return ladder;
  }

  get postUrl(): string {
    return `${FRONTEND_ORIGIN}/job-posts/${ladder.found?.id}`;
  }

  accept = (): void => ladder.accept();
  dismiss = (): void => ladder.dismiss();

  <template>
    {{#if this.ladder.hasOffer}}
      <div class="lo {{tentativeClass this.ladder.tentative}}">
        <p class="lo__ask">
          {{#if this.ladder.tentative}}
            {{!-- Weaker evidence, weaker claim. T6 knows only that you were
                looking at this a moment ago. --}}
            Were you applying to this one?
          {{else}}
            Is this the job you're applying to?
          {{/if}}
        </p>

        <p class="lo__title">{{this.ladder.found.title}}</p>
        {{#if this.ladder.found.company}}
          <p class="lo__company">{{this.ladder.found.company}}</p>
        {{/if}}

        {{!-- Named AND linked: the offer asks you to judge it, so it has to
            be inspectable before you answer (CCEXT-36). --}}
        <a class="lo__link" href={{this.postUrl}} target="_blank" rel="noopener">
          View job post →
        </a>

        <p class="lo__why">Matched by {{this.ladder.tier}}.</p>

        <div class="lo__actions">
          <button type="button" class="lo__btn lo__btn--yes" {{on "click" this.accept}}>
            Yes, that's it
          </button>
          <button type="button" class="lo__btn" {{on "click" this.dismiss}}>
            No
          </button>
        </div>
      </div>
    {{/if}}
  </template>
}

function tentativeClass(tentative: boolean): string {
  return tentative ? 'lo--tentative' : '';
}
