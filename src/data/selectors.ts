import { request } from '../lib/api.ts';
import type { JsonApiDoc } from '../lib/api.ts';

/**
 * Per-host selector bundles, fetched from the api and cached.
 *
 * DELIBERATELY HAND-WRITTEN, and it must stay that way even after WarpDrive
 * lands. Its caching is a five-way policy branch — cache hit / 404 / non-200 /
 * network failure / ok — where each outcome has a *different* fallback and a
 * *different* decision about whether to cache. A 429 is not a 404: one means
 * "this host has no profile, stop asking", the other means "ask again in a
 * moment". No generic cache expresses that, and collapsing them would make a
 * throttled api look like a permanently unconfigured host.
 */

const CACHE_KEY = 'ccExtensionSelectorCache';
const TTL_MS = 60 * 60 * 1000; // 1h

export interface SelectorBundle {
  applyButtonSelectors: string[];
  canonicalLinkSelectors: string[];
  applyUrlDecoder: string | null;
  jobDataSelectors: Record<string, string>;
  /** Server's per-domain verdict. Annotation only — never branches the send. */
  knownGood: boolean;
  tier: string | null;
  /**
   * The ScrapeProfile's own id, which this endpoint already returns as
   * `data.id`. Carrying it here is what makes `resolveProfileId` free — the
   * staff sharpen action needs it and would otherwise re-request the profile
   * the panel has already fetched. Null for a baked fallback, which by
   * definition has no server row behind it.
   */
  profileId: string | null;
}

/** Why the last fetch went the way it did, so the UI can be honest about it. */
export interface FetchOutcome {
  host: string;
  ok: boolean;
  status: number;
  from: 'cache' | 'network' | 'baked';
}

let lastOutcome: FetchOutcome | null = null;
export function lastSelectorFetch(): FetchOutcome | null {
  return lastOutcome;
}

/**
 * Offline/no-profile fallback so a fresh install, an api outage, or a host the
 * api has never seen still gets the extraction that shipped with the build.
 *
 * LinkedIn's DOM ships hashed atomic class names that rotate every release —
 * the old `jobs-apply-button` class is long gone. Anchor to the accessibility
 * contract (`aria-label`) and the `safety/go` wrapper instead; both are stable
 * surfaces because LinkedIn's own tooling depends on them.
 */
const BAKED: Record<string, SelectorBundle> = {
  'linkedin.com': {
    applyButtonSelectors: [
      'a[aria-label="Apply on company website"][href]',
      'a[data-tracking-control-name*="apply"][href]',
    ],
    canonicalLinkSelectors: ['meta[property="og:url"]'],
    applyUrlDecoder: 'linkedin_safety_go',
    jobDataSelectors: {},
    knownGood: false,
    tier: null,
    profileId: null,
  },
};

/** Universal, not per-host: which referrers are worth recording at all. */
export const REFERRER_HOSTS = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
];

/**
 * Phrases meaning "this posting is closed".
 *
 * Universal rather than per-host: the wording is near-identical across boards,
 * and a closed posting is worth catching even on a host with no profile.
 * Matched case-insensitively; the matched text is returned VERBATIM so the
 * server can verify it against the captured page rather than trusting us.
 */
export const CLOSED_PHRASES = [
  'No longer accepting applications',
  'This job is no longer available',
  'Applications are closed',
  'This position has been filled',
  'no longer accepting applications',
];

export function normalizeHostname(host: string): string {
  if (!host) return '';
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

interface CacheEntry {
  fetchedAt: number;
  /** Either a bundle, or a recorded absence so we stop asking. */
  value: { selectors?: SelectorBundle; missing?: true };
}

async function readCache(host: string): Promise<CacheEntry['value'] | null> {
  try {
    const saved = await chrome.storage.local.get([CACHE_KEY]);
    const cache = (saved[CACHE_KEY] ?? {}) as Record<string, CacheEntry>;
    const entry = cache[host];
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > TTL_MS) return null;
    return entry.value;
  } catch {
    return null;
  }
}

async function writeCache(host: string, value: CacheEntry['value']): Promise<void> {
  try {
    const saved = await chrome.storage.local.get([CACHE_KEY]);
    const cache = (saved[CACHE_KEY] ?? {}) as Record<string, CacheEntry>;
    cache[host] = { fetchedAt: Date.now(), value };
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  } catch {
    /* storage unavailable — a missed cache write costs one refetch */
  }
}

interface SelectorAttrs {
  apply_button_selectors?: string[];
  canonical_link_selectors?: string[];
  apply_url_decoder?: string | null;
  job_data_selectors?: Record<string, string> | null;
  /** CANONICAL location as of the api's meta/attributes fix. */
  is_known_good?: boolean;
  readiness?: { known_good?: boolean; tier?: string | null } | null;
}

export async function loadSelectors(
  hostname: string,
  apiKey: string,
): Promise<SelectorBundle | null> {
  const host = normalizeHostname(hostname);
  if (!host) return null;

  const cached = await readCache(host);
  if (cached) {
    lastOutcome = {
      host,
      ok: !cached.missing,
      status: cached.missing ? 404 : 200,
      from: 'cache',
    };
    return cached.missing ? null : (cached.selectors ?? null);
  }

  const resp = await request<JsonApiDoc<SelectorAttrs>>(
    `/api/v1/scrape-profiles/extension-selectors/?hostname=${encodeURIComponent(host)}`,
    { token: apiKey, plainJson: true, timeoutMs: 8000 },
  );

  // Network failure: NOT a confirmed absence. Fall back to baked, and
  // deliberately do NOT cache — otherwise one flaky moment blanks this host
  // for an hour.
  if (!resp.ok && resp.status === 0) {
    lastOutcome = { host, ok: false, status: 0, from: 'baked' };
    return BAKED[host] ?? null;
  }

  // 404: the api genuinely has no profile. Cache the absence so every send
  // does not re-ask.
  if (!resp.ok && resp.status === 404) {
    lastOutcome = { host, ok: false, status: 404, from: 'network' };
    const baked = BAKED[host] ?? null;
    await writeCache(host, baked ? { selectors: baked } : { missing: true });
    return baked;
  }

  // 429 / 5xx: also not an absence. Same treatment as a network failure, and
  // the real status is recorded so the staff card can say "throttled" rather
  // than "no profile" — a distinction the legacy added on purpose.
  if (!resp.ok) {
    lastOutcome = { host, ok: false, status: resp.status, from: 'baked' };
    return BAKED[host] ?? null;
  }

  const attrs = resp.data?.data?.attributes;
  if (!attrs) {
    lastOutcome = { host, ok: false, status: resp.status, from: 'baked' };
    return BAKED[host] ?? null;
  }

  const bundle: SelectorBundle = {
    applyButtonSelectors: attrs.apply_button_selectors ?? [],
    canonicalLinkSelectors: attrs.canonical_link_selectors ?? [],
    applyUrlDecoder: attrs.apply_url_decoder ?? null,
    jobDataSelectors:
      attrs.job_data_selectors && typeof attrs.job_data_selectors === 'object'
        ? attrs.job_data_selectors
        : {},
    // `=== true`, not truthy. An api that has not deployed this field must
    // degrade to "not known good" rather than to "known good by accident" —
    // the fail-safe direction. Reads the canonical attributes location; the
    // deprecated top-level copies are going away with the 2.x cutover.
    knownGood: attrs.is_known_good === true || attrs.readiness?.known_good === true,
    tier: attrs.readiness?.tier ?? null,
    profileId: resp.data?.data?.id != null ? String(resp.data.data.id) : null,
  };

  lastOutcome = { host, ok: true, status: resp.status, from: 'network' };
  await writeCache(host, { selectors: bundle });
  return bundle;
}
