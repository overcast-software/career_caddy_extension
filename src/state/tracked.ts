import { tracked } from '@glimmer/tracking';
import { request } from '../lib/api.ts';
import type { JsonApiListDoc } from '../lib/api.ts';
import { toJobPost } from '../domain/job-post.ts';
import type { JobPost, JobPostAttrs } from '../domain/job-post.ts';
import { classifyUrl } from '../domain/url-policy.ts';
import { page } from './page.ts';
import { session } from './session.ts';

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
