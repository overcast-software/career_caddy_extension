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
