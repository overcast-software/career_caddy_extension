import { tracked } from '@glimmer/tracking';
import { request } from '../lib/api.ts';
import type { JsonApiListDoc } from '../lib/api.ts';
import { toJobPost } from '../domain/job-post.ts';
import type { JobPost, JobPostAttrs } from '../domain/job-post.ts';
import { classifyUrl } from '../domain/url-policy.ts';
import { page } from './page.ts';
import { session, KEYS } from './session.ts';

/**
 * "Do we already know this posting?"
 *
 * The behaviour Doug missed first: *"I thought it would discover that it knows
 * enough about it already like the old way."* Landing on a page already in
 * your library and being offered to send it again is worse than useless — it
 * invites a duplicate and hides the score you already have.
 *
 * So this runs on every page change and, when it finds a match, the panel
 * shows what it knows instead of what it could do.
 */

export type LookupState = 'idle' | 'looking' | 'found' | 'none';

/**
 * Pages you have told us about, remembered per URL.
 *
 * This is the legacy's `stashTrackedPage`, and it is NOT popup scaffolding —
 * it survives the port for a reason the panel does not remove. Accepting a
 * ladder offer says "this form belongs to that post". Nothing about the URL
 * changes when you say it, so the by-link lookup still finds nothing, and the
 * very next `refresh()` would overwrite the answer you just gave with 'none'.
 *
 * Measured, not theorised: accept an offer on a jobs.ashbyhq.com form, take
 * one step through the application, and the adoption is gone.
 *
 * 7 days, matching the legacy's TRACKED_STASH_TTL_MS. An application form is
 * something you come back to.
 */
const STASH_KEY: string = KEYS.trackedPages;
const STASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STASH_MAX = 50;

interface StashEntry {
  post: JobPost;
  at: number;
}

async function readStash(url: string): Promise<JobPost | null> {
  try {
    const saved = await chrome.storage.local.get([STASH_KEY]);
    const all = (saved[STASH_KEY] ?? {}) as Record<string, StashEntry>;
    const entry = all[url];
    if (!entry) return null;
    if (Date.now() - entry.at > STASH_TTL_MS) return null;
    return entry.post;
  } catch {
    return null;
  }
}

async function writeStash(url: string, post: JobPost): Promise<void> {
  try {
    const saved = await chrome.storage.local.get([STASH_KEY]);
    const all = (saved[STASH_KEY] ?? {}) as Record<string, StashEntry>;
    all[url] = { post, at: Date.now() };
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, STASH_MAX);
    await chrome.storage.local.set({ [STASH_KEY]: Object.fromEntries(kept) });
  } catch {
    /* the adoption still holds for this page; only its persistence is lost */
  }
}

class TrackedState {
  @tracked state: LookupState = 'idle';
  @tracked post: JobPost | null = null;

  /** Same guard as page.ts, for the same reason — a slow lookup for tab A
   *  must never render into tab B. */
  private ticket = 0;

  get isKnown(): boolean {
    return this.state === 'found' && !!this.post;
  }

  /** Known, but the api says it never finished extracting — offer a re-send. */
  get needsRefresh(): boolean {
    return this.isKnown && this.post?.complete === false;
  }

  async refresh(): Promise<void> {
    const mine = ++this.ticket;
    const url = page.url;

    // Cheap local refusals first: no key, no URL, or a URL the api would
    // reject anyway. classifyUrl mirrors the server's own policy so the panel
    // can decline immediately instead of after a round-trip.
    if (!session.apiKey || !url || !classifyUrl(url).ok) {
      this.state = 'idle';
      this.post = null;
      return;
    }

    this.state = 'looking';
    const path =
      `/api/v1/job-posts/?filter%5Blink%5D=${encodeURIComponent(url)}` +
      `&include=company,scores`;
    const resp = await request<JsonApiListDoc<JobPostAttrs>>(path, {
      token: session.apiKey,
      // Bounded so the page section cannot sit on a spinner forever. On
      // timeout we fall through to the Send UI, which is the safe default.
      timeoutMs: 8000,
    });

    if (mine !== this.ticket) return; // superseded while we awaited

    if (!resp.ok) {
      this.state = 'none';
      this.post = null;
      return;
    }

    const item = resp.data?.data?.[0];
    if (!item) {
      // The server does not know this URL — but the USER may have told us,
      // by accepting a ladder offer or linking the page by hand. Their answer
      // outranks the absence of a server record; the absence is exactly what
      // they were correcting.
      const remembered = await readStash(url);
      if (mine !== this.ticket) return;
      if (remembered) {
        this.post = remembered;
        this.state = 'found';
        return;
      }
      this.state = 'none';
      this.post = null;
      return;
    }

    this.post = toJobPost(item, resp.data.included ?? []);
    this.state = 'found';
  }

  /**
   * Accept a post the user linked by hand as the answer for this page.
   *
   * Bumps the ticket so an in-flight lookup for this same page cannot land
   * afterwards and overwrite a deliberate choice with a stale "none" — the
   * user's action beats the network, always.
   */
  adopt(post: JobPost): void {
    this.ticket++;
    this.post = post;
    this.state = 'found';
    // Remember it against THIS url, so the next refresh does not undo a
    // decision the user just made. The api cannot know about this link —
    // that is the whole reason they had to tell us.
    void writeStash(page.url, post);
  }

  clear(): void {
    this.ticket++;
    this.state = 'idle';
    this.post = null;
  }
}

export type { JobPost as TrackedPost } from '../domain/job-post.ts';

export const tracked_ = new TrackedState();
export { tracked_ as trackedPost };
