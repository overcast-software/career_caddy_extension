import type { JsonApiResource } from '../lib/api.ts';

/**
 * The JSON:API → JobPost mapping, in one place.
 *
 * Lives in domain/ because it is pure — a resource plus its sideloads in, a
 * plain object out — which makes it unit-testable, and because it now has two
 * callers that must agree: the by-link lookup (state/tracked.ts) and the
 * search picker (data/posts.ts). When they disagreed in the legacy extension
 * the picker showed a post as incomplete that the tracked card showed as
 * complete, from the same row.
 */

export interface JobPost {
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

export interface JobPostAttrs {
  title?: string;
  apply_url?: string | null;
  link?: string | null;
  top_score?: number | null;
  complete?: boolean;
}

export function toJobPost(
  item: JsonApiResource<JobPostAttrs>,
  included: JsonApiResource[] = [],
): JobPost {
  const attrs = item.attributes ?? {};
  const companyRel = item.relationships?.['company']?.data ?? null;

  // JSON:API sideloads arrive in a flat `included` array, so the relationship
  // is resolved by (type, id) rather than by position. Both singular and
  // plural type names are accepted because the api's serializers are not
  // consistent about it and a mismatch here silently blanks the company name.
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

/**
 * Find a job post in a JSON:API `included` array and map it.
 *
 * The legacy carried a second mapper (`buildJpFromIncluded`) for this, which
 * is how the by-link lookup and the match result could disagree about the same
 * row. Same mapping, one lookup in front of it — so there is one definition of
 * what a JobPost is, not three.
 */
export function jobPostFromIncluded(
  jobPostId: string,
  included: JsonApiResource[],
): JobPost | null {
  const jp = included.find(
    (r) =>
      (r.type === 'job-post' || r.type === 'job-posts') &&
      String(r.id) === String(jobPostId),
  );
  return jp ? toJobPost(jp as JsonApiResource<JobPostAttrs>, included) : null;
}

/**
 * Would linking this page to `post` destroy an apply link it already has?
 *
 * Pulled out of the click handler and given a name because it is the one
 * genuinely destructive thing the picker can do. The legacy guarded it with a
 * two-click confirm; keeping the predicate separate means the confirm flow can
 * change without the question changing.
 */
export function wouldReplaceApplyUrl(post: JobPost, candidateUrl: string): boolean {
  return !!post.applyUrl && post.applyUrl !== candidateUrl;
}

/**
 * Auth-wall path words. Matched against `-`/`_`-split path segments, so
 * `/checkpoint/lg/login-submit` is caught by `login`.
 */
const AUTH_WORDS = new Set([
  'login',
  'signin',
  'logon',
  'signup',
  'register',
  'registration',
  'authwall',
  'checkpoint',
  'authenticate',
  'unauthorized',
]);

/** Hosts that only ever serve a sign-in, whatever the path says. */
const AUTH_HOSTS = ['accounts.google.com', 'login.microsoftonline.com', 'auth0.com'];

/**
 * Is this URL a login/signup wall rather than somewhere an application goes?
 *
 * REAL DAMAGE, NOT A HYPOTHETICAL: older posts in the library carry
 * `linkedin.com/signup/cold-join?…` as their `apply_url` — a captured signup
 * redirect. LinkedIn bounces a logged-out visitor to a wall, something recorded
 * the wall, and the post now claims that is where you apply.
 *
 * THE ASYMMETRY IS WHY THIS LEANS TOWARD REJECTING. A false positive means the
 * field stays empty — exactly where it already was, and the link picker can
 * still set it by hand. A false negative writes a wall into a field that feeds
 * dedupe and is the only durable record of where an application went. Those
 * costs are nowhere near equal, so an over-eager guard is the right kind of
 * wrong. `signup-inc` in a path would trip this; that is an acceptable trade.
 *
 * Deliberately NOT applied to the link picker. There a human is looking at the
 * page and choosing the link, and overriding that would be the tool telling
 * someone they cannot see what is in front of them. This guards the SILENT
 * path, where nobody is watching.
 */
export function isAuthWall(url: string | null | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '');
  } catch {
    // Unparseable is not a wall, but it is not a usable apply URL either. The
    // callers reject it on their own terms; this predicate answers only the
    // question it is named for.
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (AUTH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;

  return parsed.pathname
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .flatMap((segment) => segment.split(/[-_]/))
    .some((token) => AUTH_WORDS.has(token));
}
