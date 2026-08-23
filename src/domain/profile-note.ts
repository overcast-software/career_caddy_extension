import type { FetchOutcome } from '../data/selectors.ts';

/**
 * Turn the last selector-lookup outcome into an HONEST sentence.
 *
 * The distinction this exists to preserve: a genuine 404 ("this host has no
 * profile, stop asking") versus a MASKED failure — a 429, a 5xx, a dead
 * network — that merely LOOKS like absence. Collapsing them produces the
 * single most misleading line a staff tool can show, because "no profile" is
 * actionable (go author one) and "throttled" is not (wait).
 *
 * There is a third case that reads as absence and is not: a profile that
 * EXISTS but has no extension selectors configured. That is jobright.ai as of
 * 2026-08-23 — a real row with empty apply_button_selectors and
 * canonical_link_selectors, which is why sends from there capture no apply
 * link. It took a curl against prod to discover; this sentence is so nobody
 * has to do that again.
 */
export function profileLookupNote(
  host: string,
  outcome: FetchOutcome | null,
  hasSelectors: boolean,
): string {
  const label = host || 'this host';
  if (!outcome) return `No profile lookup has run for ${label} yet.`;

  if (outcome.status === 404) {
    const cached = outcome.from === 'cache' ? ', cached' : '';
    return `No ScrapeProfile for ${label} — the api returned 404 (confirmed absent${cached}).`;
  }
  if (outcome.ok) {
    return hasSelectors
      ? `ScrapeProfile found for ${label}.`
      : `A ScrapeProfile exists for ${label}, but it has NO extension selectors configured.`;
  }
  if (outcome.status === 429) {
    return `Profile lookup was THROTTLED (429) — this is NOT a confirmed absence. Re-check once the limit clears.`;
  }
  if (outcome.status === 0) {
    return `Profile lookup could not reach the api — NOT a confirmed absence. Re-check.`;
  }
  return `Profile lookup failed (HTTP ${outcome.status}) — NOT a confirmed absence. Re-check.`;
}
