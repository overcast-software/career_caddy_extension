import Component from '@glimmer/component';
import type Owner from '@ember/owner';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import { request, FRONTEND_ORIGIN } from '../lib/api.ts';
import { session } from '../state/session.ts';
import { page } from '../state/page.ts';
import { errorLog } from '../state/errors.ts';
import { access } from '../state/access.ts';
import { trackedPost } from '../state/tracked.ts';
import { planSend } from '../domain/send-gate.ts';
import { loadSelectors, REFERRER_HOSTS, CLOSED_PHRASES } from '../data/selectors.ts';
import { decodeApplyUrl } from '../domain/decoders.ts';

/**
 * "Send this page" — the extension's most-used action.
 *
 * This is the from-text path only for now: capture the page's visible text and
 * POST it, letting the server parse it. The legacy extension also has an
 * extension-direct fast path that uses per-host CSS selectors to extract
 * title/company/description client-side and skip the server's browser tier —
 * that is a later phase, and its absence costs latency, not correctness.
 */
/**
 * Below this, a "successful" capture is almost certainly page chrome rather
 * than a job posting. Deliberately generous — a terse posting is possible,
 * and a false warning is cheaper than a silent bad send.
 */
const MIN_USEFUL_CHARS = 400;

export default class SendCard extends Component {
  @tracked status = '';
  @tracked kind: 'idle' | 'busy' | 'ok' | 'error' = 'idle';
  @tracked scrapeId: string | null = null;
  @tracked autoScore = true;
  /**
   * The verbatim phrase that says this posting is closed, or null. Verbatim
   * rather than a boolean so it is evidence the server can re-verify against
   * the captured text, mirroring the scrape graph's own closed_evidence rule.
   */
  @tracked closedEvidence: string | null = null;

  /**
   * Everything above except `autoScore` describes ONE page, and the panel
   * outlives pages. Without this guard the Fluidstack posting's "no longer
   * accepting applications", its "sent 10,059 characters", and its
   * "open it in Career Caddy" link all followed the user to jobright.ai and
   * described a page they had never sent.
   *
   * A ticket rather than a flag, because a send in flight when the tab moves
   * must not write its result into the new page either — the response arrives
   * long after the navigation and has no idea it is stale.
   */
  private ticket = 0;

  constructor(owner: Owner, args: object) {
    super(owner, args);
    page.onChange(() => this.resetForNewPage());
  }

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

  /**
   * Known and nominally complete — so Send is DEMOTED, not removed.
   *
   * Removing it was a mistake. `complete` is a plain database column
   * defaulting to TRUE, only flipped by "Mark incomplete", scrape-graph or
   * the CompletenessReviewer. So a post nobody has ever reviewed reads as
   * complete no matter how thin it actually is — Doug hit exactly this on a
   * LinkedIn post whose Career Caddy detail page was empty: *"the details
   * page was not filled out, I should have been granted an opportunity to
   * use ext sender."*
   *
   * The flag says "nothing has flagged this", not "this is good". Treating
   * it as the latter took away the one action that fixes it. The tracked
   * card still leads; re-sending is available underneath, quietly.
   */
  get isDemoted(): boolean {
    return trackedPost.isKnown && !trackedPost.needsRefresh;
  }

  get tracked(): typeof trackedPost {
    return trackedPost;
  }

  /**
   * RESEND MODE. A JobPost exists at this URL but the api flags it
   * incomplete — a cc_auto email-stub, a user flag, or the
   * CompletenessReviewer rejecting an earlier scrape.
   *
   * The legacy extension treats this as a distinct MODE rather than a
   * caption, and it is right to: the heading, a banner and the button label
   * all change, so the user can see they are REFRESHING an existing post
   * rather than creating a second one. Sending here is the useful action,
   * which is exactly why it must not look like the ordinary one.
   */
  get isResend(): boolean {
    return trackedPost.needsRefresh;
  }

  get heading(): string {
    return this.isResend ? 'Complete this post' : 'Send this page to Career Caddy';
  }

  get sendLabel(): string {
    if (this.isBusy) return 'Sending…';
    return this.isResend ? 'Resend to complete' : 'Send this page';
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

  /**
   * Best-effort. Every step here is allowed to fail without blocking a send:
   * a missing profile, a stale selector or a throttled api all degrade to
   * "send the description and let the server extract", which is exactly what
   * happened before selectors existed.
   */
  private async collectHints(url: string): Promise<Record<string, unknown>> {
    if (!session.apiKey) return {};
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return {};
    }

    const bundle = await loadSelectors(host, session.apiKey);
    const raw = await page.grabHints({
      applyButtonSelectors: bundle?.applyButtonSelectors ?? [],
      canonicalLinkSelectors: bundle?.canonicalLinkSelectors ?? [],
      jobDataSelectors: bundle?.jobDataSelectors ?? {},
      // Universal, not per-host — worth running even where no profile exists.
      referrerHosts: REFERRER_HOSTS,
      closedPhrases: CLOSED_PHRASES,
    });
    if (!raw) return {};

    // Decoding happens HERE, not in the injected function: the decoder
    // registry is module scope and cannot cross the executeScript boundary.
    // The page hands back a raw href; the panel resolves it.
    const applyUrl = raw.applyHref
      ? decodeApplyUrl(bundle?.applyUrlDecoder, raw.applyHref, url)
      : null;

    this.closedEvidence = raw.closedEvidence;

    return {
      applyUrl,
      canonicalLinkHint: raw.canonicalLink,
      referrerUrl: raw.referrerUrl,
      structuredPrefill: raw.structuredPrefill,
      knownGood: bundle?.knownGood ?? false,
      tier: bundle?.tier ?? null,
    };
  }

  /** Page-scoped state only. `autoScore` is a preference and survives. */
  private resetForNewPage(): void {
    this.ticket++;
    this.status = '';
    this.kind = 'idle';
    this.scrapeId = null;
    this.closedEvidence = null;
  }

  /**
   * Fail loudly in two places at once: inline, where the user is looking, and
   * in the log, where they can still read it a minute later. Every error path
   * goes through here so none can silently record only half.
   */
  private fail(message: string): void {
    this.fail(message);
    errorLog.record('send', message, page.host);
  }

  private async doSend(): Promise<void> {
    const mine = ++this.ticket;
    /** True once the tab has moved on; every write below checks it. */
    const stale = (): boolean => mine !== this.ticket;

    if (!session.apiKey) {
      this.fail('Connect to Career Caddy first.');
      return;
    }

    this.kind = 'busy';
    this.scrapeId = null;
    this.status = 'Reading the page…';

    const payload = await page.capture();
    if (stale()) return;
    if (!payload) {
      // THREE different causes, three different fixes. Collapsing them into
      // one message is how someone ends up debugging cross-origin iframes
      // when the actual answer is a permission they never granted.
      await access.refresh();
      if (stale()) return;
      if (access.needsGrant) {
        this.fail(`Enable Career Caddy on ${access.host} first — the button is just above.`);
        return;
      }
      const blocked = await page.countBlockedFrames();
      if (stale()) return;
      this.fail(
        blocked
          ? `Could not read this tab. ${blocked} embedded frame(s) are cross-origin, so the posting may live somewhere the extension cannot reach.`
          : 'Could not read this tab. Reload the page and try again.',
      );
      return;
    }

    if (!payload.text.trim()) {
      this.fail('This page has no readable text to send.');
      return;
    }

    // A capture that is technically non-empty but far too small is the
    // failure that actually happens, and it does not announce itself: the
    // page looks fine on screen, the send succeeds, and the server reports
    // "Extraction failed" minutes later. Measured on a Greenhouse posting
    // whose top frame yielded only the email-signup footer. Say the size out
    // loud so a bad capture is obvious BEFORE it is sent.
    const chars = payload.text.trim().length;
    if (chars < MIN_USEFUL_CHARS) {
      const blocked = await page.countBlockedFrames();
      if (stale()) return;
      this.fail(
        `Only ${chars} characters readable here` +
        (blocked
          ? `, and ${blocked} frame(s) are cross-origin — the posting is probably inside one the extension can't reach.`
          : ` — that's too little to be the job posting. Try the posting's own page rather than a listing or search result.`),
      );
      return;
    }

    this.status = 'Sending to Career Caddy…';

    // CC-176 lives in domain/send-gate.ts, pure and testable. The rule it
    // encodes: captured text ALWAYS goes extension-direct, because
    // /scrapes/from-text/ creates a browser-tier scrape that waits for a
    // Camoufox runner — and on an auth-walled posting that runner can never
    // load the logged-in page, so the scrape hangs forever with no JobPost.
    // Per-host selectors: extract title/company/apply_url client-side so the
    // server does not have to re-derive what the page already stated. Their
    // ABSENCE never changes the path — see the CC-176 note above.
    const hints = await this.collectHints(payload.url);
    if (stale()) return;
    const decision = planSend(payload, hints, { autoScore: this.autoScore });
    console.debug('[cc] send gate', decision);

    const resp = await request<{ data?: { id?: string }; id?: string }>(
      decision.plan.path,
      {
        method: 'POST',
        plainJson: decision.plan.plainJson,
        token: session.apiKey,
        body: decision.plan.body,
      },
    );

    // The send completed, but for WHICH page? If the tab moved while this was
    // in flight, the result belongs to a page the panel is no longer showing.
    // The scrape is still real and still processing server-side — it just
    // must not be narrated here, under a different posting's heading.
    if (stale()) return;

    if (!resp.ok) {
      this.fail(resp.error);
      return;
    }

    this.scrapeId = String(resp.data?.data?.id ?? resp.data?.id ?? '') || null;
    this.kind = 'ok';

    // Hand the scrape to the worker to watch.
    //
    // No duplication with what this card shows: the panel reports "sent", the
    // worker reports "done". They are different facts arriving at different
    // times, and the second one is the one you are not sitting here for —
    // which is the entire reason the worker exists now that the panel can
    // otherwise poll for itself.
    //
    // The credential deliberately does NOT ride along; the worker reads it
    // from the same storage this panel wrote it to.
    if (this.scrapeId) {
      try {
        void chrome.runtime.sendMessage({
          type: 'cc-watch-scrape',
          scrapeId: this.scrapeId,
          url: payload.url,
          // The fast path has no server-side auto_score — that flag only
          // exists on /scrapes/from-text/. The worker starts the score once
          // the post exists, which is also what makes it survive the panel
          // being closed.
          autoScore: this.autoScore,
        });
      } catch {
        /* no worker (e.g. rendered outside an extension context) */
      }
    }
    const from = payload.frames > 1 ? ` from ${payload.frames} frames` : '';
    // Naming the path matters while the fast path is new: "browser tier" is
    // the one that can hang on an auth-walled page, and seeing it in the
    // status is how you catch the gate choosing wrong.
    const via = decision.plan.kind === 'extension-direct' ? '' : ' via the browser tier';
    this.status =
      `Sent ${chars.toLocaleString()} characters${from}${via}. ` +
      (this.autoScore ? 'Parsing and scoring it.' : 'Parsing it.');
  }

  <template>
    <p class="wb__url" title={{this.page.url}}>{{this.page.host}}</p>

    {{#if this.isOnCareerCaddy}}
      <p class="wb__hint">
        You're on Career Caddy itself — nothing to send from here.
      </p>
    {{else if this.isDemoted}}
      {{! TrackedCard leads. Re-sending stays reachable but out of the way —
          a thin-but-unflagged post is exactly the case that needs it. }}
      <details class="send__again">
        <summary class="send__again-toggle">Send this page again</summary>
        <p class="send__again-why">
          Refreshes the post from what's on screen now. Useful when the
          details in Career Caddy look thin or the posting has changed.
        </p>
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
          class="send__btn send__btn--quiet"
          disabled={{this.isBusy}}
          {{on "click" this.send}}
        >{{if this.isBusy "Sending…" "Re-send to refresh"}}</button>
        {{#if this.status}}
          <p class="send__status send__status--{{this.kind}}">{{this.status}}</p>
        {{/if}}
      </details>
    {{else}}
      <p class="send__heading">{{this.heading}}</p>

      {{#if this.isResend}}
        <div class="send__incomplete">
          <div class="send__incomplete-tag">Existing post · incomplete</div>
          <div class="send__incomplete-title">{{this.tracked.post.title}}</div>
          <div class="send__incomplete-company">{{this.tracked.post.company}}</div>
        </div>
      {{/if}}

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
      >{{this.sendLabel}}</button>
    {{/if}}

    {{#if this.closedEvidence}}
      <p class="send__closed">
        This posting says: “{{this.closedEvidence}}”
      </p>
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
