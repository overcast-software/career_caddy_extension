import { request } from '../lib/api.ts';
import type { JsonApiListDoc } from '../lib/api.ts';
import { toJobPost } from '../domain/job-post.ts';
import type { JobPost, JobPostAttrs } from '../domain/job-post.ts';

/**
 * Search your own job posts.
 *
 * `filter[query]` is a real server-side filter, not a client-side narrowing of
 * a page of results — it spans title, description, company name and link
 * (api/job_hunting/api/views/jobs.py:465). Searching client-side would only
 * ever match within the first `page[size]` rows, which looks like "no results"
 * for anything older than the last ten posts.
 */

/**
 * `null` means "the request failed", which is NOT the same as an empty array
 * meaning "nothing matched". The picker says different things for each, and
 * collapsing them tells a user their library is empty when the network blipped.
 */
export async function searchPosts(
  apiKey: string,
  query = '',
  limit = 10,
): Promise<JobPost[] | null> {
  const params = new URLSearchParams({
    sort: '-created_at',
    'page[size]': String(limit),
    include: 'company',
  });
  if (query) params.set('filter[query]', query);

  const resp = await request<JsonApiListDoc<JobPostAttrs>>(
    `/api/v1/job-posts/?${params.toString()}`,
    { token: apiKey, timeoutMs: 8000 },
  );

  if (!resp.ok) return null;
  const rows = resp.data?.data ?? [];
  const included = resp.data?.included ?? [];
  return rows.map((row) => toJobPost(row, included));
}

/**
 * Is there a post with exactly this link?
 *
 * The ladder's T1/T2/T3 all ask this about a URL that is NOT the current page
 * — an opener tab, another open tab, a referrer — which is why it lives here
 * rather than staying inline in state/tracked.ts, where it only ever asked
 * about `page.url`.
 */
export async function lookupByLink(
  apiKey: string,
  url: string,
): Promise<JobPost | null> {
  const path =
    `/api/v1/job-posts/?filter%5Blink%5D=${encodeURIComponent(url)}` +
    `&include=company&page%5Bsize%5D=1`;
  const resp = await request<JsonApiListDoc<JobPostAttrs>>(path, {
    token: apiKey,
    timeoutMs: 8000,
  });
  if (!resp.ok) return null;
  const item = resp.data?.data?.[0];
  return item ? toJobPost(item, resp.data?.included ?? []) : null;
}

/**
 * Point an existing post at this page as its apply URL.
 *
 * Returns whether the SERVER took it. The caller must not report success on
 * `false`: the legacy's honest failure path ("linked on this device only") is
 * the whole reason this returns a boolean rather than throwing — a link that
 * exists only in one browser's storage will not resolve anywhere else, and
 * silently pretending otherwise is how a user loses an application.
 */
export async function setApplyUrl(
  apiKey: string,
  postId: string,
  applyUrl: string,
): Promise<boolean> {
  const resp = await request(`/api/v1/job-posts/${postId}`, {
    token: apiKey,
    method: 'PATCH',
    body: {
      data: {
        type: 'job-post',
        id: String(postId),
        attributes: { apply_url: applyUrl },
      },
    },
    timeoutMs: 8000,
  });
  return resp.ok;
}
