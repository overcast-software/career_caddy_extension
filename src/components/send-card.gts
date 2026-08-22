import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import { request, FRONTEND_ORIGIN } from '../lib/api.ts';
import { session } from '../state/session.ts';
import { page } from '../state/page.ts';
import { access } from '../state/access.ts';

/**
 * "Send this page" — the extension's most-used action.
 *
 * This is the from-text path only for now: capture the page's visible text and
 * POST it, letting the server parse it. The legacy extension also has an
 * extension-direct fast path that uses per-host CSS selectors to extract
 * title/company/description client-side and skip the server's browser tier —
 * that is a later phase, and its absence costs latency, not correctness.
 */
export default class SendCard extends Component {
  @tracked status = '';
  @tracked kind: 'idle' | 'busy' | 'ok' | 'error' = 'idle';
  @tracked scrapeId: string | null = null;
  @tracked autoScore = true;

  get page(): typeof page {
    return page;
  }

  get session(): typeof session {
    return session;
  }

  get isBusy(): boolean {
    return this.kind === 'busy';
  }

  /** Sending a Career Caddy page to Career Caddy is never what you meant. */
  get isOnCareerCaddy(): boolean {
    return page.isCareerCaddy;
  }

  get scrapeUrl(): string {
    return `${FRONTEND_ORIGIN}/scrapes/${this.scrapeId}`;
  }

  toggleAutoScore = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.autoScore = target.checked;
  };

  send = (): void => {
    void this.doSend();
  };

  private async doSend(): Promise<void> {
    if (!session.apiKey) {
      this.kind = 'error';
      this.status = 'Connect to Career Caddy first.';
      return;
    }

    this.kind = 'busy';
    this.scrapeId = null;
    this.status = 'Reading the page…';

    const payload = await page.capture();
    if (!payload) {
      // THREE different causes, three different fixes. Collapsing them into
      // one message is how someone ends up debugging cross-origin iframes
      // when the actual answer is a permission they never granted.
      await access.refresh();
      if (access.needsGrant) {
        this.kind = 'error';
        this.status = `Enable Career Caddy on ${access.host} first — the button is just above.`;
        return;
      }
      const blocked = await page.countBlockedFrames();
      this.kind = 'error';
      this.status = blocked
        ? `Could not read this tab. ${blocked} embedded frame(s) are cross-origin, so the posting may live somewhere the extension cannot reach.`
        : 'Could not read this tab. Reload the page and try again.';
      return;
    }

    if (!payload.text.trim()) {
      this.kind = 'error';
      this.status = 'This page has no readable text to send.';
      return;
    }

    this.status = 'Sending to Career Caddy…';
    // from-text is one of the api's deliberately RPC-shaped endpoints: plain
    // JSON, not JSON:API. `plainJson` is how that is stated rather than
    // discovered.
    const resp = await request<{ data?: { id?: string }; id?: string }>(
      '/api/v1/scrapes/from-text/',
      {
        method: 'POST',
        plainJson: true,
        token: session.apiKey,
        body: {
          text: payload.text,
          link: payload.url,
          source: 'extension',
          auto_score: this.autoScore,
        },
      },
    );

    if (!resp.ok) {
      this.kind = 'error';
      this.status = resp.error;
      return;
    }

    this.scrapeId = String(resp.data?.data?.id ?? resp.data?.id ?? '') || null;
    this.kind = 'ok';
    this.status = this.autoScore
      ? 'Sent. Career Caddy is parsing and scoring it.'
      : 'Sent. Career Caddy is parsing it.';
  }

  <template>
    <p class="wb__url" title={{this.page.url}}>{{this.page.host}}</p>

    {{#if this.isOnCareerCaddy}}
      <p class="wb__hint">
        You're on Career Caddy itself — nothing to send from here.
      </p>
    {{else}}
      <label class="send__opt">
        <input
          type="checkbox"
          checked={{this.autoScore}}
          {{on "change" this.toggleAutoScore}}
        />
        Score it after parsing
      </label>

      <button
        type="button"
        class="send__btn"
        disabled={{this.isBusy}}
        {{on "click" this.send}}
      >{{if this.isBusy "Sending…" "Send this page"}}</button>
    {{/if}}

    {{#if this.status}}
      <p class="send__status send__status--{{this.kind}}">{{this.status}}</p>
    {{/if}}

    {{#if this.scrapeId}}
      <a class="send__link" href={{this.scrapeUrl}} target="_blank" rel="noopener">
        Open it in Career Caddy →
      </a>
    {{/if}}
  </template>
}
