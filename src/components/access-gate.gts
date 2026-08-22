import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { access } from '../state/access.ts';

/**
 * Shown only when the panel cannot read the current page.
 *
 * Deliberately NOT a modal, a nag, or an auto-prompt. On a job posting the
 * panel is visibly useful and the ask makes sense; on your bank, it should sit
 * there saying it cannot read the page and leave you alone. That asymmetry is
 * the feature — a user who expects it not to work on Gmail is holding the
 * correct model, and we should not argue with them.
 */
export default class AccessGate extends Component {
  get access(): typeof access {
    return access;
  }

  /** Straight through: permissions.request needs the gesture unspent. */
  enable = (): void => access.grant();
  enableTabs = (): void => access.grantTabs();

  <template>
    {{#if this.access.needsTabs}}
      {{! The chicken-and-egg, stated plainly. Chrome withholds a tab's URL
          without host access, so the panel cannot name the site it would ask
          about. `tabs` reveals URLs WITHOUT granting access to any of them —
          a strictly milder step, and the only way to reach the per-site ask. }}
      <div class="gate">
        <p class="gate__ask">Career Caddy can't tell which page you're on.</p>
        <button type="button" class="gate__btn" {{on "click" this.enableTabs}}>
          Let it see the current page address
        </button>
        <p class="gate__why">
          This reveals the address only. Reading a page is a separate,
          per-site permission you'll be asked for next.
        </p>
        {{#if this.access.lastError}}
          <p class="gate__err">{{this.access.lastError}}</p>
        {{/if}}
      </div>

    {{else if this.access.needsGrant}}
      <div class="gate">
        <p class="gate__ask">
          Career Caddy can't read
          <strong>{{this.access.host}}</strong>
          yet.
        </p>
        <button type="button" class="gate__btn" {{on "click" this.enable}}>
          Enable on {{this.access.host}}
        </button>
        <p class="gate__why">
          Site by site, so it only ever reads the job boards you say yes to.
          You can revoke it any time from the browser's extensions page.
        </p>
        {{#if this.access.lastError}}
          <p class="gate__err">{{this.access.lastError}}</p>
        {{/if}}
      </div>

    {{else if (isUngrantable this.access.state)}}
      <p class="gate__note">
        Nothing to read on this kind of page — open a job posting.
      </p>
    {{/if}}
  </template>
}

/** A plain function is a helper in modern Glimmer. Local, used once. */
function isUngrantable(state: string): boolean {
  return state === 'ungrantable';
}
