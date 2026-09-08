import { loadSelectors, REFERRER_HOSTS, CLOSED_PHRASES } from '../data/selectors.ts';
import { decodeApplyUrl } from '../domain/decoders.ts';
import type { FieldOutcomes } from '../domain/proposed-post.ts';
import { page } from './page.ts';
import { session } from './session.ts';

/**
 * Per-host page hints: the apply link, the canonical link, the referrer, and
 * whatever the profile's field selectors matched.
 *
 * EXTRACTED from send-card so it has more than one caller without being
 * written twice. Two copies of a rule is how this codebase produced two
 * JobPost mappers that could disagree about the same row, and two
 * closed-phrase lists that can drift. The send path and the apply-url
 * backfill now ask the same question the same way.
 */

export interface PageHints {
  /** DECODED — the registry runs panel-side; the page returns a raw href. */
  applyUrl: string | null;
  canonicalLinkHint: string | null;
  referrerUrl: string | null;
  structuredPrefill: Record<string, string>;
  /** Verbatim phrase saying the posting is closed, or null. */
  closedEvidence: string | null;
  /** Server's per-domain verdict. Annotation only — never branches a send. */
  knownGood: boolean;
  tier: string | null;
  /** Why not known-good, one clause each. Empty when it is. */
  reasons: string[];
  /** The host's ScrapeProfile id, for the staff sharpen request. Free here. */
  profileId: string | null;
  /**
   * Per-field selector outcome, for the staff validator.
   *
   * `structuredPrefill` carries the values that matched and nothing else, so
   * it cannot answer the question a staff user is actually asking: is this
   * field missing because nobody configured a selector, or because the
   * selector is stale, or because it is not valid CSS? Those want three
   * different fixes. `ccGrabHints` has always returned the breakdown — the
   * panel had been discarding it here.
   */
  fields: FieldOutcomes;
}

const EMPTY: PageHints = {
  applyUrl: null,
  canonicalLinkHint: null,
  referrerUrl: null,
  structuredPrefill: {},
  closedEvidence: null,
  knownGood: false,
  tier: null,
  reasons: [],
  profileId: null,
  fields: { configured: [], matched: [], missed: [], invalid: [] },
};

/**
 * Best-effort throughout. Every failure returns the empty shape rather than
 * throwing: hints IMPROVE a send, they never gate one, and a host with no
 * profile is the normal case rather than an error.
 */
export async function collectHints(url: string): Promise<PageHints> {
  if (!session.apiKey) return EMPTY;

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return EMPTY;
  }

  const bundle = await loadSelectors(host, session.apiKey);
  const raw = await page.grabHints({
    applyButtonSelectors: bundle?.applyButtonSelectors ?? [],
    canonicalLinkSelectors: bundle?.canonicalLinkSelectors ?? [],
    jobDataSelectors: bundle?.jobDataSelectors ?? {},
    referrerHosts: REFERRER_HOSTS,
    closedPhrases: CLOSED_PHRASES,
  });
  if (!raw) return EMPTY;

  // Decoding happens HERE, not in the injected function: the decoder registry
  // is module scope and cannot cross the executeScript boundary. The page
  // hands back a raw href; the panel resolves it.
  return {
    applyUrl: raw.applyHref ? decodeApplyUrl(bundle?.applyUrlDecoder, raw.applyHref, url) : null,
    canonicalLinkHint: raw.canonicalLink,
    referrerUrl: raw.referrerUrl,
    structuredPrefill: raw.structuredPrefill,
    closedEvidence: raw.closedEvidence,
    knownGood: bundle?.knownGood ?? false,
    tier: bundle?.tier ?? null,
    reasons: bundle?.reasons ?? [],
    profileId: bundle?.profileId ?? null,
    fields: {
      // From the BUNDLE, not the page: "configured" is a fact about the
      // profile and must be known even when the injected read returned
      // nothing at all.
      configured: Object.keys(bundle?.jobDataSelectors ?? {}),
      matched: raw.matched,
      missed: raw.missed,
      invalid: raw.invalid,
    },
  };
}
