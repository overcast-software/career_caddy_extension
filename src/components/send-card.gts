import Component from '@glimmer/component';
import type Owner from '@ember/owner';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import { request, FRONTEND_ORIGIN } from '../lib/api.ts';
import { session } from '../state/session.ts';
import { page } from '../state/page.ts';
import { collectHints } from '../state/hints.ts';
import type { PageHints } from '../state/hints.ts';
import { errorLog } from '../state/errors.ts';
import { access } from '../state/access.ts';
import { trackedPost } from '../state/tracked.ts';
import { worker } from '../state/worker.ts';
import type { WorkerAnnouncement } from '../domain/messages.ts';
import { planSend } from '../domain/send-gate.ts';

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
  /**
   * `watching` is the state this card spent eleven versions without, and its
   * absence was visible: `ok` was doing double duty as "the request succeeded"
   * and "we are done", and only the first was ever true. The POST returns 202
   * — parse, extraction and scoring all happen afterwards — so the button
   * re-enabled and read "Send this page" again while the line beneath it said
   * "Parsing and scoring it." Doug, 2026-08-25: *"when i send the page, I want
   * the button to reflect that it's working."* The two disagreed and the
   * button was the louder of them (CCEXT-97).
   *
   *   busy      local capture plus the HTTP round trip. We are doing the work.
   *   watching  accepted; the server is working and the background worker is
   *             watching for us. Nothing to do but wait.
   *   ok        genuinely finished, one way or another.
   */
  @tracked kind: 'idle' | 'busy' | 'watching' | 'ok' | 'error' = 'idle';
  /** Which half of the server-side work is outstanding, for the label. */
  @tracked watchPhase: 'parsing' | 'scoring' = 'parsing';
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
    // The worker's return path (CCEXT-96). This is also the ONLY way out of
    // `watching`, which is why every terminal exit in background.ts announces
    // — including the ones that give up. The `page.onChange` reset above is
    // the backstop for an announcement that never arrives at all (a panel
    // opened after the work finished, a worker that died with its alarm).
    worker.onAnnounce((a) => this.applyAnnouncement(a));
  }

  get page(): typeof page {
    return page;
  }

  get session(): typeof session {
    return session;
  }

  /**
   * "Do not click me again." Covers `watching` as well as `busy`, so the
   * button stays disabled for the whole of the work rather than for the
   * fraction of it that happens over HTTP.
   */
  get isBusy(): boolean {
    return this.kind === 'busy' || this.kind === 'watching';
  }

  /** What the disabled button says it is doing. Never shown when idle. */
  get busyLabel(): string {
    if (this.kind === 'busy') return 'Sending…';
    return this.watchPhase === 'scoring' ? 'Scoring…' : 'Parsing…';
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
    // Disconnected, the library was never consulted — `trackedPost.refresh()`
    // returns before it asks. "Send this page to Career Caddy" is an OFFER,
    // and an offer implies a check happened. Doug, 2026-08-25: *"the verbage
    // suggested it didn't know"* — it did not know, and it had not looked.
    // Say the second thing (CCEXT-92).
    if (!this.session.isConnected) return 'Connect to check your library';
    return this.isResend ? 'Complete this post' : 'Send this page to Career Caddy';
  }

  get sendLabel(): string {
    if (this.isBusy) return this.busyLabel;
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
  /**
   * Delegates to state/hints.ts — shared with the apply-url backfill so the
   * two cannot drift. The only component-local part is surfacing
   * closedEvidence, which is a display concern.
   *
   * DELIBERATELY NOT named collectHints. A method whose body calls an import
   * of the same name resolves to the import today and recurses the moment
   * someone "tidies" it to `this.collectHints(...)`. That is not
   * hypothetical: fail() in this very file was rewritten into a call to
   * itself and blew the stack on every error path for eleven versions.
   */
  private async hintsForPage(url: string): Promise<PageHints> {
    const hints = await collectHints(url);
    this.closedEvidence = hints.closedEvidence;
    return hints;
  }

  /** Page-scoped state only. `autoScore` is a preference and survives. */
  private resetForNewPage(): void {
    this.ticket++;
    this.status = '';
    this.kind = 'idle';
    this.watchPhase = 'parsing';
    this.scrapeId = null;
    this.closedEvidence = null;
  }

  /**
   * The worker finished (or stopped) — react, if it was talking about us.
   *
   * TWO GUARDS, AND BOTH ARE LOAD-BEARING.
   *
   * The url check is CCEXT-33: the panel outlives pages, so an announcement
   * about the Toptal posting arrives just as happily while the user is looking
   * at Greenhouse. Writing "Added to Career Caddy." under a page that was
   * never sent is precisely the class of bug the ticket exists for.
   *
   * The `watching` check keeps this from resurrecting a card that has already
   * moved on. A re-send starts a second watch, and the first watch's late
   * announcement must not overwrite the second one's status — the ticket
   * counter guards the network, and this guards the message channel.
   */
  private applyAnnouncement(a: WorkerAnnouncement): void {
    if (a.url !== page.url) return;
    if (this.kind !== 'watching') return;

    if (a.phase === 'scoring') {
      // Still watching, just further along. The button label follows.
      this.watchPhase = 'scoring';
      this.status = 'Added to Career Caddy. Scoring it…';
      return;
    }

    if (a.phase === 'failed') {
      this.fail("Career Caddy couldn't parse that posting. Try re-sending, or open the posting's own page.");
      return;
    }

    if (a.phase === 'gave-up') {
      // NOT an error. The work may well still be running server-side; the
      // worker just stopped watching it. Saying "failed" here would be a
      // claim we cannot support, and the honest version is also the useful
      // one — it tells the user where to look.
      this.kind = 'ok';
      this.status = 'Still working on it. Check Career Caddy in a minute.';
      return;
    }

    // done. The tracked card is about to take over — `trackedPost.refresh()`
    // is running in the workbench off the same announcement. Keep a short
    // status rather than clearing it, because that refresh can legitimately
    // come back empty (a post whose stored link does not match this page,
    // CC-247) and an empty card would then look like nothing happened.
    this.kind = 'ok';
    this.status = 'Added to Career Caddy.';
  }

  /**
   * Fail loudly in two places at once: inline, where the user is looking, and
   * in the log, where they can still read it a minute later. Every error path
   * goes through here so none can silently record only half.
   */
  private fail(message: string): void {
    // Write the fields directly. This method is the ONE place allowed to,
    // and it must not go through any helper — an earlier regex refactor
    // rewrote this body into `this.fail(message)`, because it contained the
    // exact two-line pattern the regex was collapsing. Every failure then
    // blew the stack, and the error log this exists to feed recorded nothing.
    this.kind = 'error';
    this.status = message;
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
    const hints = await this.hintsForPage(payload.url);
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
    this.watchPhase = 'parsing';

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
    //
    // AWAITED, AND ITS RESULT DECIDES THE STATE. This used to be fire-and-
    // forget, which was fine when the card went straight to `ok` — a lost
    // handoff cost a notification nobody was waiting for. It is not fine now:
    // `watching` disables the button and the ONLY thing that lifts it is an
    // announcement from this watch. Assume the handoff worked and a rejected
    // sendMessage leaves a dead control until the user navigates away. So the
    // card only enters `watching` once the worker has actually taken the job.
    let watched = false;
    if (this.scrapeId) {
      try {
        const ack = (await chrome.runtime.sendMessage({
          type: 'cc-watch-scrape',
          scrapeId: this.scrapeId,
          url: payload.url,
          // The fast path has no server-side auto_score — that flag only
          // exists on /scrapes/from-text/. The worker starts the score once
          // the post exists, which is also what makes it survive the panel
          // being closed.
          autoScore: this.autoScore,
        })) as { watching?: boolean } | undefined;
        // The worker acks synchronously (background.ts). Require the ack
        // rather than treating "did not throw" as success: a resolved-with-
        // undefined is what you get when nothing handled the message, and
        // that is precisely the case this guard exists for.
        watched = ack?.watching === true;
      } catch {
        /* no worker (e.g. rendered outside an extension context) */
      }
    }
    if (stale()) return;

    // 202, not 200. The server has ACCEPTED the page; parse, extraction and
    // scoring are all ahead of us, and `watching` says so rather than letting
    // `ok` mean both "the request succeeded" and "we are done" (CCEXT-97).
    // Without a watch there is nothing to wait FOR here, so `ok` is honest.
    this.kind = watched ? 'watching' : 'ok';
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
        >{{if this.isBusy this.busyLabel "Re-send to refresh"}}</button>
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
