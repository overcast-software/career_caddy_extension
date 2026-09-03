import { tracked } from '@glimmer/tracking';
import { lookupByLink, searchPosts, setApplyUrl } from '../data/posts.ts';
import { classifyUrl } from '../domain/url-policy.ts';
import type { JobPost } from '../domain/job-post.ts';
import { isAuthWall, wouldReplaceApplyUrl } from '../domain/job-post.ts';
import {
  bareHost,
  collectIdTokens,
  originOf,
  pickFromTrail,
  pickPageTitle,
  verifyByTitle,
  verifyByToken,
} from '../domain/ladder.ts';
import { page } from './page.ts';
import { session } from './session.ts';
import { trackedPost } from './tracked.ts';
import { loadViewed } from './viewed.ts';
import { clearStashForPost, findStashMatch, postFromStash } from './apply-stash.ts';
import { isConfident } from '../domain/apply-stash.ts';

/**
 * Which job post does THIS page belong to, when its URL matches nothing?
 *
 * Runs when the by-link lookup comes back empty — which is the normal case on
 * an application form, because forms live at different URLs than the
 * descriptions they belong to. FIRST MATCH WINS, cheapest and most certain
 * first: T0 stash · T1 opener · T2 open tabs · T3 referrer · T4 id token ·
 * T5 title · T5b stash (origin-only) · T6 viewed trail.
 *
 * T0/T5b are the SAME evidence at two strengths, which is why the apply stash
 * appears twice. A stash entry whose path agrees with this page is the
 * strongest thing the ladder has — you said so yourself — while a bare origin
 * match on a shared ATS is among the weakest. Running it once at either
 * position would be wrong in one direction or the other.
 *
 * The evidence rules are in domain/ladder.ts and are unit-tested. This file is
 * the ORDERING and the I/O: which tier runs when, what it costs, and when to
 * stop. Keeping those apart is what makes the rules testable at all — the
 * legacy had both in one 164-line function.
 *
 * FIRST-TIER-WINS IS THE SHIPPED BEHAVIOUR, deliberately. CCEXT-32 proposes
 * replacing it with aggregated scoring and is still open. Aggregating has its
 * own failure modes and should be decided on its merits, not smuggled in
 * during a port.
 */

/** Bounds server round-trips. The legacy's value; do not raise it casually. */
const MAX_LOOKUPS = 8;
/** Open tabs examined per run, after origin-deduping. */
const MAX_TAB_CANDIDATES = 6;

export type LadderState = 'idle' | 'running' | 'offer' | 'none';

class LadderRunner {
  @tracked state: LadderState = 'idle';
  @tracked found: JobPost | null = null;
  /**
   * T6 answers are circumstantial — "you were looking at this a moment ago",
   * not "this is the post". A tentative offer must be phrased as a question
   * and must never be acted on without a human saying yes.
   */
  @tracked tentative = false;
  @tracked tier = '';

  private ticket = 0;

  get hasOffer(): boolean {
    return this.state === 'offer' && !!this.found;
  }

  reset(): void {
    this.ticket++;
    this.state = 'idle';
    this.found = null;
    this.tentative = false;
    this.tier = '';
  }

  /**
   * Only worth running when the page is otherwise unidentified. If the
   * by-link lookup already found the post, the ladder can only disagree with
   * something more certain than itself.
   */
  get shouldRun(): boolean {
    return (
      !!session.apiKey &&
      !trackedPost.isKnown &&
      trackedPost.state !== 'looking' &&
      classifyUrl(page.url).ok
    );
  }

  async run(): Promise<void> {
    if (!this.shouldRun) return;
    const mine = ++this.ticket;
    const stale = (): boolean => mine !== this.ticket;
    const apiKey = session.apiKey;
    if (!apiKey) return;

    this.state = 'running';

    // One budget across every tier. Each tier spends from it, so a page with
    // many open tabs cannot starve the cheaper-but-later title tier.
    let budget = MAX_LOOKUPS;
    const lookup = async (url: string): Promise<JobPost | null> => {
      if (budget <= 0) return null;
      budget -= 1;
      return lookupByLink(apiKey, url);
    };
    const search = async (query: string): Promise<JobPost[] | null> => {
      if (budget <= 0) return null;
      budget -= 1;
      return searchPosts(apiKey, query, 10);
    };

    const settle = (found: JobPost, tier: string, tentative = false): void => {
      this.found = found;
      this.tier = tier;
      this.tentative = tentative;
      this.state = 'offer';
    };

    try {
      // --- T0: an application you explicitly tracked ----------------------
      // The only tier backed by a USER ACTION rather than an inference: you
      // pressed Track on a post whose apply link points at this site. It runs
      // first because it is both the most direct and the only free tier — a
      // local storage read, no server round-trip, no permission needed.
      //
      // Accepted here ONLY when the paths agree. A bare origin match on a
      // multi-tenant ATS says almost nothing (see isConfident), so it is held
      // back to T5b instead of being allowed to beat the verified tiers below.
      const stashHit = await findStashMatch(page.url);
      if (stale()) return;
      if (stashHit && isConfident(stashHit)) {
        return settle(postFromStash(stashHit.entry), 'an application you tracked');
      }

      const tabsGranted = await this.hasTabs();
      if (stale()) return;
      const tabId = page.tabId;

      // --- T1: the tab that opened this one ------------------------------
      // An apply form is usually opened FROM the listing, so the opener is
      // the single strongest cheap signal available.
      if (tabsGranted && tabId !== undefined) {
        const opener = await this.openerUrl(tabId);
        if (stale()) return;
        if (opener && classifyUrl(opener).ok) {
          const hit = await lookup(opener);
          if (stale()) return;
          if (hit) return settle(hit, 'opener tab');
        }
      }

      // --- T2: your other open tabs --------------------------------------
      // Deduped by origin and capped, because a browser with forty tabs open
      // would otherwise spend the whole budget here and reach no further.
      if (tabsGranted) {
        for (const url of await this.tabCandidates(tabId)) {
          if (stale()) return;
          const hit = await lookup(url);
          if (stale()) return;
          if (hit) return settle(hit, 'an open tab');
        }
      }

      // Read once, used by T3 and T5.
      const signals = await page.grabLadderSignals();
      if (stale()) return;

      // --- T3: the referrer ----------------------------------------------
      // A referrer WITH A PATH can identify a post by itself. An origin-only
      // referrer cannot — but it still says which site you came from, and
      // that constrains the fuzzy tiers below.
      let constraintHost: string | null = null;
      if (signals.referrer && classifyUrl(signals.referrer).ok) {
        let hasPath = false;
        try {
          const p = new URL(signals.referrer).pathname;
          hasPath = !!p && p !== '/';
        } catch {
          hasPath = false;
        }
        if (hasPath) {
          const hit = await lookup(signals.referrer);
          if (stale()) return;
          if (hit) return settle(hit, 'the page you came from');
        }
        constraintHost = bareHost(signals.referrer);
      }

      // --- T4: an id token shared with a post's link ----------------------
      for (const token of collectIdTokens(page.url)) {
        const rows = await search(token);
        if (stale()) return;
        if (!rows) continue;
        // No constraintHost: see verifyByToken's note. A verified token match
        // is direct evidence, and the referrer can only reject true ones.
        const hit = verifyByToken(rows, token);
        if (hit) return settle(hit, 'a matching job id');
      }

      // --- T5: the page title --------------------------------------------
      const title = pickPageTitle(signals.h1, signals.ogTitle);
      if (title) {
        const rows = await search(title);
        if (stale()) return;
        if (rows) {
          const hit = verifyByTitle(rows, title, constraintHost);
          if (hit) return settle(hit, 'a matching title');
        }
      }

      // --- T5b: the stash again, origin-only — TENTATIVE -------------------
      // Held back from T0 because the paths disagreed. Still worth offering:
      // you tracked an application on this ATS within the last six hours, and
      // that is a better guess than nothing. It outranks T6 because a tracked
      // application is something you DID, where the viewed trail is only
      // something you looked at.
      if (stashHit) {
        return settle(postFromStash(stashHit.entry), 'an application you tracked', true);
      }

      // --- T6: the recently-viewed trail — TENTATIVE ----------------------
      // Live as of the CCEXT-52 triage. The trail is state/viewed.ts; the
      // rule that reads it (pickFromTrail — CROSS-ORIGIN ONLY, per the Toptal
      // single-origin-portal misfire) is in domain/ladder.ts and tested.
      const trail = await this.viewedTrail();
      if (stale()) return;
      if (trail.length) {
        const pick = pickFromTrail(trail, page.url, constraintHost);
        if (pick) return settle(pick, 'recently viewed', true);
      }

      this.state = 'none';
    } catch {
      // Never throw out of the ladder. It is an enhancement over "we don't
      // know", and failing loudly would replace a useful panel with an error.
      if (!stale()) this.state = 'none';
    }
  }

  /** Accept the offer: adopt it as this page's post, and tell the server. */
  accept(): void {
    if (!this.found) return;
    const post = this.found;
    const url = page.url;
    // The stash exists to reconnect a tracked application to its apply page.
    // Once you have confirmed the connection, its job is done — leaving the
    // entry behind would keep re-offering a post already adopted here, and
    // would still be doing it on the next unrelated job at the same ATS.
    void clearStashForPost(post.id);
    trackedPost.adopt(post);
    // Fire-and-forget, exactly like clearStashForPost above: the local
    // adoption is what the user sees, and it must not wait on a round trip.
    void this.persistAdoption(post, url);
    this.reset();
  }

  /**
   * Persist "this page belongs to that post" as the post's apply_url.
   *
   * A human has just looked at a page and confirmed which post it belongs to.
   * That is the highest-quality identity signal this system can obtain — and
   * until now it went only into `chrome.storage.local` via trackedPost.adopt,
   * under a 7-day TTL, and expired without ever reaching the server. The link
   * picker, which is the SAME assertion made through a different button,
   * has always persisted it (link-picker.ts). This closes that asymmetry.
   *
   * `apply_url` is the right home: it is already what the picker writes, and
   * the api reads it as a dedupe signal (find_apply_url_matches, and the
   * `apply_hint` duplicate-candidate signal). So a human's answer improves the
   * server's future PROPOSALS without making any write path guess more.
   *
   * FILL, NEVER REPLACE — for confident and tentative offers alike.
   * `wouldReplaceApplyUrl` is the only predicate standing between this and
   * destroying a choice someone already made, and an apply URL is often the
   * only record of where an application actually went. Replacing one
   * deliberately is the link picker's job, where a two-click confirm and a
   * human reading the page already exist; duplicating that flow here would be
   * a second way to do the same destructive thing. The value is in the empty
   * case anyway — see apply-backfill.ts, which measured 3 of the 100 most
   * recent posts as having an apply_url at all.
   */
  private async persistAdoption(post: JobPost, url: string): Promise<void> {
    if (!session.apiKey || !url) return;
    // Never record a sign-in page as where an application goes. Same guard,
    // same reason as apply-backfill: LinkedIn bounces a logged-out visitor to
    // a wall, and posts in the library already carry captured walls as their
    // apply_url. Accepting an offer is a click on an OFFER, not on the URL —
    // the human is confirming WHICH POST, not vouching for the address bar.
    if (isAuthWall(url)) return;
    if (wouldReplaceApplyUrl(post, url)) return;

    const ok = await setApplyUrl(session.apiKey, post.id, url);
    if (!ok) return;

    // Reflect it locally so the panel agrees with the server without a
    // refetch. A 403 is expected and normal — filter[link] returns cross-user
    // posts and PATCH is staff-or-owner — which is why setApplyUrl returns a
    // boolean rather than throwing, and why a failure is silent here: the
    // adoption above already succeeded and is what the user was promised.
    if (trackedPost.post?.id === post.id) {
      trackedPost.post = { ...post, applyUrl: url };
    }
  }

  dismiss(): void {
    this.reset();
    this.state = 'none';
  }

  private async hasTabs(): Promise<boolean> {
    try {
      return await chrome.permissions.contains({ permissions: ['tabs'] });
    } catch {
      return false;
    }
  }

  private async openerUrl(tabId: number): Promise<string | null> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.openerTabId === undefined) return null;
      const opener = await chrome.tabs.get(tab.openerTabId);
      return opener.url ?? null;
    } catch {
      return null; // opener closed, or restricted
    }
  }

  private async tabCandidates(selfId: number | undefined): Promise<string[]> {
    let tabs: chrome.tabs.Tab[] = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      return [];
    }

    // Same-window tabs first: the job you are applying to is far more likely
    // to be beside this one than in a window you left open yesterday.
    const currentWindow = tabs.find((t) => t.id === selfId)?.windowId;
    tabs.sort((a, b) => {
      const aw = a.windowId === currentWindow ? 0 : 1;
      const bw = b.windowId === currentWindow ? 0 : 1;
      return aw - bw;
    });

    const out: string[] = [];
    const seenOrigins = new Set<string>();
    for (const t of tabs) {
      if (!t.url || t.id === selfId) continue;
      // classifyUrl excludes Career Caddy itself and non-http(s), so the
      // panel does not try to match the app against the app.
      if (!classifyUrl(t.url).ok) continue;
      const origin = originOf(t.url);
      if (origin && seenOrigins.has(origin)) continue;
      if (origin) seenOrigins.add(origin);
      out.push(t.url);
      if (out.length >= MAX_TAB_CANDIDATES) break;
    }
    return out;
  }

  /** T6's data: recently-viewed posts, newest first, TTL-filtered on read. */
  private async viewedTrail(): Promise<JobPost[]> {
    return loadViewed();
  }
}

export const ladder = new LadderRunner();

/**
 * Its own reset, per the epic rule: which modules are page-scoped is knowledge
 * that belongs to each module. A ladder result describes one page, and an
 * offer surviving a navigation would propose the previous page's post for this
 * one.
 */
page.onChange(() => ladder.reset());
