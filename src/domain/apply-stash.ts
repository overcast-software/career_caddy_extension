import { originOf, pathPrefixScore } from './ladder.ts';

/**
 * The apply stash — "I tracked an application for that post, and its apply link
 * points at this site."
 *
 * WHAT THE LEGACY ACTUALLY DID, before deciding what to keep. `stashPendingApply`
 * has exactly one caller (`trackApplication`), and it fires only when the post
 * carries an `apply_url`:
 *
 *   > Create-in-place: the JobApplication is recorded and confirmed inline. We
 *   > do NOT open the apply page in a new tab. When the post carries an
 *   > apply_url we still stash the source post for attribution, so if the user
 *   > navigates to that apply page themselves the popup can resurface this
 *   > application.
 *
 * So this is a RECOVERY mechanism, not a capture one. It exists because a popup
 * is destroyed the moment you click away, and the thread between "I tracked
 * this" and "I am now on the form" had nowhere else to live.
 *
 * IT IS STILL WORTH PORTING, and the reason is not the popup. The panel's
 * ladder already reconnects the common case — you reach the ATS from the
 * posting, so T3 sees the referrer. What the ladder cannot do is remember an
 * intention across a gap with no signal in it: you track the application, close
 * the tab, and open the ATS an hour later from your email. No opener, no open
 * tab, no referrer, and an ATS form's title matches nothing. The stash is the
 * only tier that still knows, and it knows because you TOLD it.
 *
 * WHY IT HAS BARELY EVER FIRED: it is gated on the post having an `apply_url`,
 * and roughly 3 of the 100 most recent posts have one — because the send path
 * silently drops `captured_payload.apply_url` (see claudex
 * `arch-extension-direct-send-path-what-it-drops`). api #253 and this repo's
 * passive backfill both close that, so the stash is about to start firing for
 * the first time. That is a reason to get its rules right now, not later.
 *
 * These functions are pure so the rules can be tested without storage. The I/O
 * is state/apply-stash.ts.
 */

/** Entries per stash. The legacy's value. */
export const APPLY_STASH_MAX = 5;
/** 6 hours. Long enough to leave and come back, short enough to not haunt you. */
export const APPLY_STASH_TTL_MS = 6 * 60 * 60 * 1000;

export interface ApplyStashEntry {
  jobPostId: string;
  /** The post's apply_url at the time of tracking — the match key's source. */
  applyUrl: string;
  /** Carried so a hit costs zero server round-trips, as state/viewed.ts does. */
  title: string | null;
  company: string | null;
  companyId: string | null;
  link: string | null;
  ts: number;
}

/**
 * Live entries only.
 *
 * Filtered on READ rather than pruned on write, matching state/viewed.ts: a
 * write that fails to prune must not be able to resurrect an expired entry, and
 * read-time filtering makes expiry a property of the rule instead of a property
 * of whether some earlier write happened to run.
 */
export function pruneStash(
  raw: unknown,
  now: number,
  ttlMs: number = APPLY_STASH_TTL_MS,
): ApplyStashEntry[] {
  if (!Array.isArray(raw)) return [];
  return (raw as ApplyStashEntry[]).filter(
    (r) => !!r && !!r.applyUrl && !!r.jobPostId && !!r.ts && now - r.ts <= ttlMs,
  );
}

/**
 * Add an entry, newest first, ONE PER ORIGIN, capped.
 *
 * Origin — not exact URL — is the dedupe key, and the legacy's comment says why:
 * "ATS apply URLs redirect/append steps". You land on `/apply`, the form pushes
 * you to `/apply/step-2`, and keying on the exact URL would store both as
 * separate memories of the same intention.
 */
export function addToStash(
  list: ApplyStashEntry[],
  entry: ApplyStashEntry,
  max: number = APPLY_STASH_MAX,
): ApplyStashEntry[] {
  const origin = originOf(entry.applyUrl);
  const others = list.filter((r) => originOf(r.applyUrl) !== origin);
  return [entry, ...others].slice(0, max);
}

/** Drop every entry for a post — called once its application is resurfaced. */
export function clearForPost(
  list: ApplyStashEntry[],
  jobPostId: string,
): ApplyStashEntry[] {
  return list.filter((r) => String(r.jobPostId) !== String(jobPostId));
}

export interface StashMatch {
  entry: ApplyStashEntry;
  /**
   * How much of the stashed apply path this page actually shares.
   *
   * Zero means the origin matched and nothing else did — see `isConfident`.
   */
  score: number;
}

/**
 * The best live stash entry for the page you are on, or null.
 *
 * Longest shared path prefix first, then most recent. Both halves matter: the
 * prefix is what distinguishes two jobs on the same ATS, and recency is the
 * tiebreak when the prefix cannot tell them apart.
 */
export function pickStashMatch(
  list: ApplyStashEntry[],
  tabUrl: string,
): StashMatch | null {
  const origin = originOf(tabUrl);
  if (!origin) return null;

  const sameOrigin = list.filter((r) => originOf(r.applyUrl) === origin);
  if (!sameOrigin.length) return null;

  const scored = sameOrigin.map((entry) => ({
    entry,
    score: pathPrefixScore(entry.applyUrl, tabUrl),
  }));
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.entry.ts - a.entry.ts));
  return scored[0] ?? null;
}

/**
 * Is this match strong enough to state, or only strong enough to ask?
 *
 * THIS IS THE RULE THE LEGACY DID NOT HAVE, and it exists because of a failure
 * the ladder already paid for once. Greenhouse, Lever, Ashby and Workday host
 * thousands of unrelated jobs on ONE origin. An origin match on such a host
 * carries almost no information — it is the same shape as the Toptal
 * single-origin-portal misfire that `pickFromTrail` refuses outright (T6,
 * 2026-07-08): a lookup miss on a shared portal means "a different job on the
 * same site", and answering with the last one you touched is confidently wrong.
 *
 * A shared path prefix is what turns "same ATS" into "same employer's board" —
 * `greenhouse.io/acme/jobs/123` vs `/acme/jobs/123/apply` shares `acme`, and
 * that is real evidence. Zero shared segments is not, so it is offered as a
 * question rather than asserted.
 *
 * The legacy got away without this because its stash always rendered a card
 * with a button — every offer was implicitly a question. In the ladder the flag
 * has to be explicit, because the ladder is allowed to sound certain.
 */
export function isConfident(match: StashMatch): boolean {
  return match.score > 0;
}
