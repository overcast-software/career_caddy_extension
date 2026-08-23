import { loadSelectors, REFERRER_HOSTS, CLOSED_PHRASES } from '../data/selectors.ts';
import { decodeApplyUrl } from '../domain/decoders.ts';
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
  /** The host's ScrapeProfile id, for the staff sharpen request. Free here. */
  profileId: string | null;
}

const EMPTY: PageHints = {
  applyUrl: null,
  canonicalLinkHint: null,
  referrerUrl: null,
  structuredPrefill: {},
  closedEvidence: null,
  knownGood: false,
  tier: null,
  profileId: null,
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
    profileId: bundle?.profileId ?? null,
  };
}
