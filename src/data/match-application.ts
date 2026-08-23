import { request } from '../lib/api.ts';
import { jobPostFromIncluded } from '../domain/job-post.ts';
import type { JobPost } from '../domain/job-post.ts';
import type { JsonApiResource } from '../lib/api.ts';

/**
 * CC-135 — ask Career Caddy to find the job post, when the ladder could not.
 *
 * The last resort, and a different KIND of answer from the ladder's. The
 * ladder infers from evidence the browser already has, for free. This creates
 * the application immediately — you DID apply, that fact is not in doubt — and
 * hands the server a match_context to work out which posting it was, async.
 *
 * Deliberately no job-post relationship is sent. The server's matcher fills
 * it; sending a guess would be asking it to agree with us rather than to look.
 *
 * **Staff-gated by the api.** The UI should also gate on `me.isStaff` so the
 * button is absent rather than present-and-rejected.
 */

export type CreateMatchResult =
  | { ok: true; jaId: string }
  | { ok: false; error: string };

export async function createMatchApplication(
  apiKey: string,
  opts: { trackingUrl: string; referrer: string; pageTitle: string; excerpt: string },
): Promise<CreateMatchResult> {
  // Flat body, not a JSON:API envelope — the api accepts either, and the
  // match_context trigger is documented against the flat shape.
  const resp = await request<{ data?: { id?: string } }>('/api/v1/job-applications/', {
    token: apiKey,
    method: 'POST',
    body: {
      tracking_url: opts.trackingUrl,
      status: 'Applied',
      match_context: {
        referrer: opts.referrer || '',
        page_title: opts.pageTitle || '',
        text_excerpt: opts.excerpt || '',
      },
    },
    timeoutMs: 12000,
  });

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: 'Not entitled — staff only.' };
    }
    return { ok: false, error: resp.error };
  }
  const jaId = resp.data?.data?.id;
  return jaId
    ? { ok: true, jaId: String(jaId) }
    : { ok: false, error: 'No application id returned.' };
}

export interface MatchOutcome {
  /** The matcher's own status, from match_context. Null while it has not run. */
  status: string | null;
  confidence: number | null;
  rationale: string;
  found: JobPost | null;
}

interface JaAttrs {
  match_context?: {
    status?: string;
    confidence?: number;
    rationale?: string;
  } | null;
}

/**
 * `null` means "could not read it" — a transport or parse failure, so the
 * poller should simply try again. A terminal *failure* is expressed as a
 * status, not as null; conflating the two would abandon a run over one blip.
 */
export async function pollMatchApplication(
  apiKey: string,
  jaId: string,
): Promise<MatchOutcome | null> {
  const resp = await request<{
    data?: {
      attributes?: JaAttrs;
      relationships?: { 'job-post'?: { data?: { id?: string } | null } };
    };
    included?: JsonApiResource[];
  }>(`/api/v1/job-applications/${jaId}/?include=job-post,company`, {
    token: apiKey,
    timeoutMs: 8000,
  });

  if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
    // Gone or forbidden will not improve with retries — terminal.
    return { status: 'failed', confidence: null, rationale: '', found: null };
  }
  if (!resp.ok) return null;

  const attrs = resp.data?.data?.attributes ?? {};
  const ctx = attrs.match_context && typeof attrs.match_context === 'object' ? attrs.match_context : {};
  const jpId = resp.data?.data?.relationships?.['job-post']?.data?.id ?? null;

  return {
    status: ctx.status ?? null,
    confidence: typeof ctx.confidence === 'number' ? ctx.confidence : null,
    rationale: ctx.rationale ?? '',
    found: jpId ? jobPostFromIncluded(String(jpId), resp.data?.included ?? []) : null,
  };
}
