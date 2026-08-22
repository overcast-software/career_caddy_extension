import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { session } from '../state/session.ts';

/**
 * Connect / connected / disconnect.
 *
 * No password is ever asked for or handled. The flow reads the session out of
 * an already-signed-in Career Caddy tab and exchanges it for a revocable API
 * key — which is also why the failure message points at opening such a tab
 * rather than at credentials.
 */
export default class ConnectCard extends Component {
  get session(): typeof session {
    return session;
  }

  get isBusy(): boolean {
    return session.state === 'connecting';
  }

  connect = (): void => {
    void session.connect();
  };

  disconnect = (): void => {
    void session.disconnect();
  };

  signIn = (): void => session.openSignIn();

  <template>
    {{#if this.session.isConnected}}
      <div class="conn conn--ok">
        <span class="conn__who">
          {{#if this.session.me.username}}
            Connected as <strong>{{this.session.me.username}}</strong>
            {{#if this.session.me.isStaff}}<span class="conn__staff">staff</span>{{/if}}
          {{else}}
            Connected
          {{/if}}
        </span>
        <button type="button" class="conn__link" {{on "click" this.disconnect}}>
          Disconnect
        </button>
      </div>
    {{else if (eq this.session.state "unknown")}}
      <p class="conn__hint">Checking your connection…</p>
    {{else}}
      <div class="conn">
        <button
          type="button"
          class="conn__btn"
          disabled={{this.isBusy}}
          {{on "click" this.connect}}
        >{{if this.isBusy "Connecting…" "Connect to Career Caddy"}}</button>
        <button type="button" class="conn__link" {{on "click" this.signIn}}>
          Open sign-in
        </button>
      </div>
      <p class="conn__hint">
        Reads the session from an open Career Caddy tab and creates a revocable
        API key. Your password is never involved.
      </p>
    {{/if}}

    {{#if this.session.message}}
      <p class="conn__msg">{{this.session.message}}</p>
    {{/if}}
  </template>
}

/**
 * Strict mode has no global helper resolver, so even `eq` must be in scope.
 * A plain function IS a helper in modern Glimmer — no `helper()` wrapper, no
 * registration. This one is local because it is used once.
 */
function eq(a: unknown, b: unknown): boolean {
  return a === b;
}
