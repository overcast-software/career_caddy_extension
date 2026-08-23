import { request } from '../lib/api.ts';
import type { JsonApiListDoc } from '../lib/api.ts';

/**
 * Job applications: find an existing one, or create it.
 *
 * The dedupe lookup is not an optimisation — it is the whole safety mechanism.
 * "Track application" is the one button here that MINTS a row, and a user who
 * clicks it twice (or opens the panel on two tabs of the same posting) must
 * not end up with two applications for one job. So the create path is always
 * preceded by the lookup, and a lookup FAILURE blocks the create rather than
 * falling through to it: not knowing whether one exists is a reason to stop,
 * not a reason to make another.
 */

/**
 * Owner-scoped: the api returns only YOUR applications for that post, so a
 * colleague's application on a shared post does not read as yours.
 *
 * Three outcomes, deliberately distinct — `appId` (one exists), `null` (none
 * exists), or `error` (we could not find out). Collapsing the third into the
 * second is exactly how a duplicate gets minted.
 */
export type ExistingLookup =
  | { ok: true; appId: string | null }
  | { ok: false; error: string };

export async function findExistingApplication(
  apiKey: string,
  jobPostId: string,
): Promise<ExistingLookup> {
  const resp = await request<JsonApiListDoc<unknown>>(
    `/api/v1/job-posts/${jobPostId}/job-applications/`,
    { token: apiKey, timeoutMs: 8000 },
  );
  if (!resp.ok) return { ok: false, error: 'Could not reach Career Caddy.' };
  const first = resp.data?.data?.[0];
  return { ok: true, appId: first ? String(first.id) : null };
}

export type CreateResult =
  | { ok: true; appId: string | null }
  | { ok: false; error: string };

/**
 * `company_id` is inherited from the job post SERVER-side
 * (JobApplicationViewSet.pre_save_payload), so only the job-post relationship
 * is sent. Sending a company too would let a client disagree with the post
 * about which company it belongs to, and the server would have to pick.
 */
export async function createApplication(
  apiKey: string,
  jobPostId: string,
  trackingUrl: string | null,
): Promise<CreateResult> {
  const resp = await request<{ data?: { id?: string } }>('/api/v1/job-applications/', {
    token: apiKey,
    method: 'POST',
    body: {
      data: {
        type: 'job-application',
        attributes: {
          status: 'Applied',
          applied_at: new Date().toISOString(),
          tracking_url: trackingUrl || null,
        },
        relationships: {
          'job-post': { data: { type: 'job-post', id: String(jobPostId) } },
        },
      },
    },
    timeoutMs: 12000,
  });

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: 'Session expired — reconnect required.' };
    }
    return { ok: false, error: resp.error };
  }
  return { ok: true, appId: resp.data?.data?.id ? String(resp.data.data.id) : null };
}
