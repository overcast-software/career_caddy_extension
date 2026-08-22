import { tracked } from '@glimmer/tracking';
import { request } from '../lib/api.ts';
import type { JsonApiListDoc, JsonApiResource } from '../lib/api.ts';
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

export interface TrackedPost {
  id: string;
  title: string;
  company: string | null;
  companyId: string | null;
  applyUrl: string | null;
  link: string | null;
  topScore: number | null;
  /** A score is already running; do not offer to start another. */
  hasPendingScore: boolean;
  /**
   * The api's own judgement that this post is fully extracted. Defaults TRUE
   * when absent so an older api never produces a spurious "incomplete"
   * caption; when explicitly false, offer Send so the user can refresh it.
   */
  complete: boolean;
}

export type LookupState = 'idle' | 'looking' | 'found' | 'none';

interface JobPostAttrs {
  title?: string;
  apply_url?: string | null;
  link?: string | null;
  top_score?: number | null;
  complete?: boolean;
}

class TrackedState {
  @tracked state: LookupState = 'idle';
  @tracked post: TrackedPost | null = null;

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

    this.post = toPost(item, resp.data.included ?? []);
    this.state = 'found';
  }

  clear(): void {
    this.ticket++;
    this.state = 'idle';
    this.post = null;
  }
}

function toPost(
  item: JsonApiResource<JobPostAttrs>,
  included: JsonApiResource[],
): TrackedPost {
  const attrs = item.attributes ?? {};
  const companyRel = item.relationships?.['company']?.data ?? null;

  const companyResource = companyRel
    ? included.find(
        (r) =>
          (r.type === 'company' || r.type === 'companies') &&
          String(r.id) === String(companyRel.id),
      )
    : undefined;

  // A score still running anywhere on this post — including one started by
  // another user — means "do not offer to score again", mirroring the api's
  // cross-user top_score behaviour.
  const hasPendingScore = included.some(
    (r) =>
      (r.type === 'score' || r.type === 'scores') &&
      (r.attributes as { status?: string })?.status === 'pending',
  );

  return {
    id: item.id,
    title: attrs.title ?? '(untitled)',
    company: (companyResource?.attributes as { name?: string })?.name ?? null,
    companyId: companyRel ? String(companyRel.id) : null,
    applyUrl: attrs.apply_url ?? null,
    link: attrs.link ?? null,
    topScore: typeof attrs.top_score === 'number' ? attrs.top_score : null,
    hasPendingScore,
    complete: attrs.complete === false ? false : true,
  };
}

export const tracked_ = new TrackedState();
export { tracked_ as trackedPost };
