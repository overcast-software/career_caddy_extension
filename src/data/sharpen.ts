import { request } from '../lib/api.ts';

/**
 * Request a sharpen pass over this host's ScrapeProfile.
 *
 * PORTED HONESTLY, WHICH MEANT CHANGING WHAT IT SAYS. CCEXT-11 records that
 * the legacy's button was a no-op that reported success, and the api was read
 * to check whether that was still true. It is:
 * `lib/tasks.py::sharpen_scrape_profile` appends a `[sharpen-request <iso>]`
 * line to the profile's `extraction_hints`, logs
 * "request recorded; awaiting enhancer pass", and returns `status: "requested"`.
 * The selector rewriting sits behind a comment reading
 * `# ENHANCER INTEGRATION POINT`, and runs out-of-process as an operator-driven
 * agent.
 *
 * SO THE API WAS NEVER THE LIAR. It says "requested" and means it. The lie was
 * entirely in the presentation layer, which rendered that as success. Fixing it
 * costs one honest sentence, and this module exists so the sentence is
 * unavoidable: the result type has no "sharpened" case to render.
 *
 * TWO THINGS THE LEGACY DID THAT ARE NOT PORTED, because the server retired
 * them out from under it:
 *
 *  - **No polling.** `meta.job_id` is now always null. The view says so
 *    outright: the sharpen-status endpoint's lookup is "vestigial (retired
 *    with django_q in CC-208); the live frontend does not poll it". A poll
 *    loop here would query a dead endpoint forever and call it progress.
 *  - **No source-scrape hunting.** The endpoint finds the most recent
 *    completed scrape for the hostname itself, so the client sends nothing but
 *    the profile id.
 */

export type SharpenResult =
  /** 202 — the request is on the profile. Nothing has changed yet. */
  | { kind: 'recorded' }
  /**
   * 422 — no completed scrape for this host, and the enhancer needs a captured
   * page to read. Actionable, and the most likely outcome on a new host, which
   * is why it is a case of its own rather than a generic failure.
   */
  | { kind: 'no-capture' }
  /** 404 — no profile row for this host. */
  | { kind: 'no-profile' }
  /** 403 — staff-only, and this key is not staff. */
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

export async function requestSharpen(
  apiKey: string,
  profileId: string,
): Promise<SharpenResult> {
  const resp = await request(
    `/api/v1/scrape-profiles/${encodeURIComponent(profileId)}/sharpen/`,
    { token: apiKey, method: 'POST', plainJson: true, timeoutMs: 15000 },
  );

  if (resp.ok) return { kind: 'recorded' };
  if (resp.status === 422) return { kind: 'no-capture' };
  if (resp.status === 404) return { kind: 'no-profile' };
  if (resp.status === 403) return { kind: 'forbidden' };
  if (resp.status === 0) return { kind: 'error', message: 'Network unreachable' };
  return { kind: 'error', message: `Request failed (${resp.status})` };
}
