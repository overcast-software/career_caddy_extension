/**
 * The signal ladder's pure layer — what counts as evidence.
 *
 * The problem: you are standing on an application FORM, on an ATS, at a URL
 * that appears nowhere in your library. `jobs.ashbyhq.com/rescale/…/application`
 * is not the job description you saved from LinkedIn. The by-link lookup
 * returns nothing, and it is right to. So the post has to be inferred from
 * circumstantial evidence, and these are the predicates that judge it.
 *
 * Six tiers, FIRST MATCH WINS (see state/ladder.ts for the ordering):
 *
 *   T1  the tab that opened this one
 *   T2  your other open tabs
 *   T3  the referrer
 *   T4  an id token shared between this URL and a post's link
 *   T5  the page title
 *   T6  the recently-viewed trail — TENTATIVE, never accepted silently
 *
 * NOTE ON CCEXT-32: that ticket proposes replacing first-tier-wins with
 * aggregated evidence scoring. It is still open (Todo), so this ports the
 * shipped behaviour — first match wins — rather than the proposal. Do not
 * conflate them: aggregating is a real design change with its own failure
 * modes, and it deserves to be made deliberately rather than smuggled in
 * during a port.
 *
 * Everything here is pure so the evidence rules can be tested directly. They
 * are the part where a mistake is expensive: a wrong match does not fail
 * loudly, it attaches your application to somebody else's posting.
 */

/**
 * A token long enough to be an identifier rather than a word.
 *
 * 16+ chars of [A-Za-z0-9_-]. Short values are far more likely to be a page
 * number, a locale or a boolean than a job id, and a false id-token match is
 * one of the few ways this system can confidently produce a wrong answer.
 */
const ID_TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;

/** At most this many id tokens are worth pursuing; each costs a lookup. */
const MAX_ID_TOKENS = 3;

/** Host, www-stripped and lowercased. `null` when the URL will not parse. */
export function bareHost(url: string | null | undefined): string | null {
  try {
    return new URL(url ?? '').hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Origin, or null. Used to dedupe open-tab candidates. */
export function originOf(url: string | null | undefined): string | null {
  try {
    return new URL(url ?? '').origin;
  } catch {
    return null;
  }
}

/**
 * Candidate id tokens from a URL's query params and fragment.
 *
 * The fragment matters and is easy to forget: single-page ATS flows carry the
 * job id in `#/apply?jobId=…` or as a bare `#token`, where no query parser
 * will find it. Both its params and its bare segments are scanned.
 */
export function collectIdTokens(tabUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(tabUrl);
  } catch {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const consider = (val: string | undefined): void => {
    if (out.length >= MAX_ID_TOKENS) return;
    if (val && ID_TOKEN_RE.test(val) && !seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  };

  for (const [, val] of parsed.searchParams) consider(val);

  const frag = parsed.hash ? parsed.hash.replace(/^#/, '') : '';
  if (frag) {
    const qIdx = frag.indexOf('?');
    if (qIdx >= 0) {
      for (const [, val] of new URLSearchParams(frag.slice(qIdx + 1))) consider(val);
    }
    for (const part of frag.split(/[/?&=#]/)) consider(part);
  }
  return out;
}

/**
 * How many leading path segments two URLs share — the tiebreak when several
 * candidates sit on the same origin.
 */
export function pathPrefixScore(a: string, b: string): number {
  try {
    const pa = new URL(a).pathname.split('/').filter(Boolean);
    const pb = new URL(b).pathname.split('/').filter(Boolean);
    let n = 0;
    while (n < pa.length && n < pb.length && pa[n] === pb[n]) n++;
    return n;
  } catch {
    return 0;
  }
}

/** Lowercase, punctuation to space, whitespace collapsed. */
export function normalizeTitle(t: string | null | undefined): string {
  return (t ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Containment, or >= 80% shared tokens against the SHORTER title.
 *
 * Deliberately conservative. Titles are the weakest tier that can still
 * produce a confident answer, and "Senior Cloud Security Engineer" vs
 * "Cloud Security Engineer" being treated as the same job is the kind of
 * near-miss that attaches an application to the wrong posting.
 */
export function titlesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;

  const sa = new Set(na.split(' '));
  const sb = new Set(nb.split(' '));
  let shared = 0;
  for (const tok of sa) if (sb.has(tok)) shared++;
  // Against the SHORTER set, so a long title cannot dilute a real match.
  const denom = Math.min(sa.size, sb.size) || 1;
  return shared / denom >= 0.8;
}

/**
 * The subset of a JobPost the evidence rules actually look at.
 *
 * The verifiers below are generic over `T extends Candidate` rather than
 * taking `Candidate` directly, so they hand BACK whatever they were given. A
 * caller passing full JobPosts gets full JobPosts out; the rules still only
 * read these four fields. Taking `Candidate` flatly would silently narrow the
 * result and force a cast at every call site — which is a cast that can be
 * wrong, whereas this cannot.
 */
export interface Candidate {
  id: string;
  title?: string | null;
  link?: string | null;
  applyUrl?: string | null;
}

/**
 * When an origin-only referrer is in play, a candidate must agree with it.
 *
 * A referrer without a path cannot itself identify a post, but it still says
 * which SITE you came from — and that is enough to disqualify candidates from
 * elsewhere. This is what keeps the fuzzy tiers (id token, title) honest: they
 * search broadly, and this narrows the result to somewhere you actually were.
 *
 * No constraint means no opinion, so an absent referrer returns true rather
 * than rejecting everything.
 */
export function hostAgrees(found: Candidate, constraintHost: string | null): boolean {
  if (!constraintHost) return true;
  const linkHost = found.link ? bareHost(found.link) : null;
  const applyHost = found.applyUrl ? bareHost(found.applyUrl) : null;
  return linkHost === constraintHost || applyHost === constraintHost;
}

/**
 * The more job-title-looking of an h1 and an og:title.
 *
 * og:title wins when the h1 is missing, very short, or a bare section name —
 * an ATS whose h1 is literally "Apply" would otherwise search for "Apply".
 */
export function pickPageTitle(
  h1: string | null | undefined,
  ogTitle: string | null | undefined,
): string | null {
  const h = (h1 ?? '').trim();
  const og = (ogTitle ?? '').trim();
  const generic = !h || h.length < 4 || /^(jobs?|careers?|apply)$/i.test(h);
  if (og && generic) return og;
  return h || og || null;
}

/**
 * T4 verification: a searched row only counts if its link ACTUALLY contains
 * the token, and it agrees with any referrer constraint.
 *
 * The search is a `filter[query]` across title/description/company/link, so it
 * happily returns rows that merely mention the token somewhere. Re-checking
 * the link is what turns a search hit into evidence.
 *
 * Returns a single candidate ONLY when exactly one survives. Ambiguity is not
 * a weak answer here, it is no answer — two plausible posts means the ladder
 * has not identified anything, and picking one would be a coin flip presented
 * as a fact.
 */
export function verifyByToken<T extends Candidate>(
  rows: T[],
  token: string,
  constraintHost: string | null,
): T | null {
  const verified = rows.filter(
    (r) => r && r.id && r.link && r.link.includes(token) && hostAgrees(r, constraintHost),
  );
  return verified.length === 1 ? (verified[0] ?? null) : null;
}

/** T5 verification. Same exactly-one rule, for the same reason. */
export function verifyByTitle<T extends Candidate>(
  rows: T[],
  pageTitle: string,
  constraintHost: string | null,
): T | null {
  const matches = rows.filter(
    (r) => r && r.id && titlesMatch(r.title, pageTitle) && hostAgrees(r, constraintHost),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * T6: pick from the recently-viewed trail — CROSS-ORIGIN ONLY.
 *
 * The trail models the apply-flow signature: you viewed a posting on site A,
 * you are now on ATS site B. A candidate whose link host equals the CURRENT
 * host means you are still browsing that same portal, where a lookup miss just
 * means "a different job on the same site" — and offering the last one you
 * looked at is the single-origin-portal trap.
 *
 * That is not hypothetical. Toptal hosts every job on one origin, and this
 * misfired live on /portal/eligible-jobs (2026-07-08) — the same failure
 * family as the origin-match suggestion reverted in 1.8.3.
 *
 * Always TENTATIVE. T6 is a suggestion from circumstantial evidence and must
 * be confirmed by a human before anything is written.
 */
export function pickFromTrail<T extends Candidate>(
  viewed: T[],
  tabUrl: string,
  constraintHost: string | null,
): T | null {
  const tabHost = bareHost(tabUrl);
  const crossOrigin = viewed.filter((v) => bareHost(v.link) !== tabHost);
  if (!crossOrigin.length) return null;

  if (constraintHost) {
    const hostMatch = crossOrigin.find((v) => bareHost(v.link) === constraintHost);
    if (hostMatch) return hostMatch;
  }
  return crossOrigin[0] ?? null;
}
