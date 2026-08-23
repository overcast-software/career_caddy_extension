import { tracked } from '@glimmer/tracking';
import { createMatchApplication, pollMatchApplication } from '../data/match-application.ts';
import type { JobPost } from '../domain/job-post.ts';
import { errorLog } from './errors.ts';
import { me } from './me.ts';
import { page } from './page.ts';
import { session, KEYS } from './session.ts';
import { trackedPost } from './tracked.ts';

/**
 * CC-135 — "I applied here; find the posting for me."
 *
 * Offered only when the ladder found NOTHING, and only to staff (the api gates
 * it; the UI gates too, so the button is absent rather than present-and-
 * rejected).
 *
 * The order matters and is the point: the application is created FIRST. That
 * you applied is a fact you know now, and it should not be held hostage to a
 * matcher working out which posting it was. The job post is backfilled async;
 * a match that never lands leaves you with a tracked application and no post,
 * which is strictly better than losing the record of having applied.
 */

/** From the registry, so disconnect wipes it. A literal here compiles
 *  fine and leaves one account's match state for the next one. */
const STASH_KEY: string = KEYS.matchApps;
/** 30 minutes: long enough to close the panel and come back, short enough
 *  that a stale entry cannot claim a page you have since moved on from. */
const STASH_TTL_MS = 30 * 60 * 1000;
const STASH_MAX = 10;
const POLL_INTERVAL_MS = 2500;
/** ~60s of panel-side polling before the stash takes over. */
const POLL_MAX = 24;
/**
 * 8000, matching the server's MATCH_TEXT_EXCERPT_MAX
 * (models/job_application.py:41) — which TRUNCATES anything longer. Sending
 * more is wasted bytes; sending the 2000 I originally hardcoded threw away
 * three quarters of the context the matcher is allowed to see, on the tier
 * that most needs it.
 */
const EXCERPT_MAX = 8000;

export type MatchState = 'idle' | 'creating' | 'matching' | 'matched' | 'nomatch' | 'error';

interface StashEntry {
  jaId: string;
  at: number;
}

class MatchAppRunner {
  @tracked state: MatchState = 'idle';
  @tracked status = '';
  @tracked found: JobPost | null = null;
  @tracked confidence: number | null = null;
  @tracked rationale = '';
  @tracked jaId: string | null = null;

  private ticket = 0;
  private timer: number | undefined;

  get isBusy(): boolean {
    return this.state === 'creating' || this.state === 'matching';
  }

  /**
   * Offered only where nothing else worked. If the ladder produced an offer,
   * answering that is cheaper and more certain than asking the server to
   * search — and showing both invites the user to pick the worse one.
   */
  get canAsk(): boolean {
    return (
      me.isStaff && !!session.apiKey && !trackedPost.isKnown && this.state === 'idle'
    );
  }

  reset(): void {
    this.ticket++;
    window.clearTimeout(this.timer);
    this.state = 'idle';
    this.status = '';
    this.found = null;
    this.confidence = null;
    this.rationale = '';
    this.jaId = null;
  }

  /**
   * On arriving at a page, surface a result that landed while we were away.
   *
   * The stash is keyed by URL, so this asks "did I already start a match for
   * THIS page?" — and the answer being yes is why closing the panel mid-match
   * does not lose the outcome.
   */
  async resume(): Promise<void> {
    if (!session.apiKey || !page.url) return;
    const entry = await this.readStash(page.url);
    if (!entry) return;
    this.jaId = entry.jaId;
    this.state = 'matching';
    this.status = 'Career Caddy is still looking for this posting…';
    void this.pollUntilDone(entry.jaId, 0);
  }

  async ask(): Promise<void> {
    const mine = ++this.ticket;
    const stale = (): boolean => mine !== this.ticket;
    const apiKey = session.apiKey;
    const url = page.url;
    if (!apiKey || !url) return;

    this.state = 'creating';
    this.status = 'Recording the application…';

    // Best-effort context. A missing signal weakens the match; it does not
    // block it, because the application still needs to exist either way.
    const signals = await page.grabLadderSignals();
    if (stale()) return;
    // Top-frame excerpt, not a full capture — see page.grabExcerpt.
    const excerpt = await page.grabExcerpt(EXCERPT_MAX);
    if (stale()) return;

    const created = await createMatchApplication(apiKey, {
      trackingUrl: url,
      referrer: signals.referrer ?? '',
      pageTitle: signals.ogTitle || signals.h1 || page.title || '',
      excerpt,
    });
    if (stale()) return;

    if (!created.ok) {
      this.state = 'error';
      this.status = created.error;
      errorLog.record('match', created.error, page.host);
      return;
    }

    this.jaId = created.jaId;
    this.state = 'matching';
    this.status = 'Application recorded. Career Caddy is finding the posting…';
    await this.writeStash(url, created.jaId);
    void this.pollUntilDone(created.jaId, 0);
  }

  private async pollUntilDone(jaId: string, attempt: number): Promise<void> {
    const mine = this.ticket;
    if (attempt >= POLL_MAX) {
      // Not an error, and deliberately not a failure message: the matcher is
      // still running server-side. The stash means the next visit to this page
      // picks the answer up.
      this.status = 'Still looking — it will be here when you come back.';
      return;
    }

    const apiKey = session.apiKey;
    if (!apiKey) return;
    const outcome = await pollMatchApplication(apiKey, jaId);
    if (mine !== this.ticket) return;

    // null is "could not read", not "failed" — retry rather than abandon.
    if (outcome && outcome.found) {
      this.found = outcome.found;
      this.confidence = outcome.confidence;
      this.rationale = outcome.rationale;
      this.state = 'matched';
      this.status = '';
      await this.clearStash(page.url);
      return;
    }
    // `done` is the terminal status, with or without a pick.
    //
    // This waited for `'no_match'`, WHICH THE API NEVER EMITS. The matcher
    // reports `pending` / `done` / `failed` (models/job_application.py:43-45),
    // and a real "searched, found nothing" is `done` with a null job_post and
    // rationale "no candidates". So that outcome fell through this branch,
    // kept polling, and timed out saying "Still looking — it will be here when
    // you come back" when the answer had already arrived and was "no".
    //
    // The `found` check above handles `done` WITH a pick, so reaching here on
    // `done` means the search finished empty.
    if (outcome && (outcome.status === 'failed' || outcome.status === 'done')) {
      this.state = 'nomatch';
      this.status =
        outcome.status === 'failed'
          ? 'Career Caddy could not run the search.'
          : 'Career Caddy could not identify the posting.';
      this.rationale = outcome.rationale;
      await this.clearStash(page.url);
      return;
    }

    this.timer = window.setTimeout(() => {
      void this.pollUntilDone(jaId, attempt + 1);
    }, POLL_INTERVAL_MS);
  }

  /** Adopt the matched post as this page's. */
  accept(): void {
    if (!this.found) return;
    trackedPost.adopt(this.found);
    this.reset();
  }

  // --- stash ------------------------------------------------------------
  // Keyed by URL and bounded on BOTH sides: a TTL so a stale entry cannot
  // claim a page you have moved on from, and a size cap so a long session
  // cannot grow it without limit.

  private async readStash(url: string): Promise<StashEntry | null> {
    try {
      const saved = await chrome.storage.local.get([STASH_KEY]);
      const all = (saved[STASH_KEY] ?? {}) as Record<string, StashEntry>;
      const entry = all[url];
      if (!entry) return null;
      if (Date.now() - entry.at > STASH_TTL_MS) return null;
      return entry;
    } catch {
      return null;
    }
  }

  private async writeStash(url: string, jaId: string): Promise<void> {
    try {
      const saved = await chrome.storage.local.get([STASH_KEY]);
      const all = (saved[STASH_KEY] ?? {}) as Record<string, StashEntry>;
      all[url] = { jaId, at: Date.now() };
      const entries = Object.entries(all)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, STASH_MAX);
      await chrome.storage.local.set({ [STASH_KEY]: Object.fromEntries(entries) });
    } catch {
      /* the match still runs; only the resume-on-return is lost */
    }
  }

  private async clearStash(url: string): Promise<void> {
    try {
      const saved = await chrome.storage.local.get([STASH_KEY]);
      const all = (saved[STASH_KEY] ?? {}) as Record<string, StashEntry>;
      delete all[url];
      await chrome.storage.local.set({ [STASH_KEY]: all });
    } catch {
      /* nothing to do */
    }
  }
}

export const matchApp = new MatchAppRunner();

/** Its own page reset, then look for a result left over from last time. */
page.onChange(() => {
  matchApp.reset();
  void matchApp.resume();
});
