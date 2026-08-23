import type { CapturedPage } from '../state/page.ts';

/**
 * Which endpoint a send goes to, and what body it carries.
 *
 * Pure — no chrome, no DOM, no fetch — so the CC-176 decision is finally
 * testable rather than buried in a 60-line click handler.
 *
 * ## The rule, and why it is a rule
 *
 * **If we captured page text, the send goes extension-direct. Always.**
 *
 * `/scrapes/from-text/` creates a `source_mode=browser`, `status=pending`
 * scrape that waits for a Camoufox runner to go and load the page itself. On
 * an auth-walled posting — LinkedIn, Toptal — that runner can never load the
 * logged-in page, so the scrape hangs forever and no JobPost is ever created.
 * Doug, on CC-176: *"the extension gives the scrape all the info it needs.
 * this is not a camoufox workflow."*
 *
 * The bug that rule replaced is instructive: the gate used to be
 * `useDirectPost = curatedComplete`, so a page whose per-host selectors
 * happened to miss title/company dropped to the browser path — meaning the
 * sites that most needed the extension (logged-in ones) were exactly the ones
 * it handed to a runner that could not reach them.
 *
 * So title and company are an OPTIMISATION, not a gate. When the selectors
 * matched, they ride along and save the server a re-extraction; when they did
 * not, they are OMITTED so the server LLM-extracts from the description
 * instead of persisting a blank title (api CC-122). Their absence must never
 * downgrade the request.
 *
 * `known_good` does not branch the path either. It annotates the decision for
 * debugging and nothing more.
 *
 * from-text survives only for the degenerate case: a page with no text at all.
 */

export interface PageHints {
  applyUrl?: string | null;
  canonicalLinkHint?: string | null;
  referrerUrl?: string | null;
  structuredPrefill?: Record<string, string> | null;
  /** Server's per-domain verdict. Debug annotation only — never a branch. */
  knownGood?: boolean;
  tier?: string | null;
}

export interface DirectSend {
  kind: 'extension-direct';
  path: '/api/v1/scrapes/';
  plainJson: false;
  body: unknown;
}

export interface FromTextSend {
  kind: 'from-text';
  path: '/api/v1/scrapes/from-text/';
  plainJson: true;
  body: unknown;
}

export type SendPlan = DirectSend | FromTextSend;

/** Everything the gate considered, so a surprising choice can be explained. */
export interface SendDecision {
  plan: SendPlan;
  hasCapturedText: boolean;
  /** Selectors got BOTH title and company — the best case, not a gate. */
  curatedComplete: boolean;
  knownGood: boolean;
  tier: string | null;
}

export function planSend(
  page: CapturedPage,
  hints: PageHints,
  options: { autoScore: boolean },
): SendDecision {
  const prefill = hints.structuredPrefill ?? {};
  const title = (prefill['title'] ?? '').trim();
  const company = (prefill['company_name'] ?? '').trim();
  const location = (prefill['location'] ?? '').trim();
  const description = page.text.trim();

  const hasCapturedText = description.length > 0;
  const curatedComplete = title.length > 0 && company.length > 0 && hasCapturedText;

  const decision = {
    hasCapturedText,
    curatedComplete,
    knownGood: hints.knownGood === true,
    tier: hints.tier ?? null,
  };

  if (!hasCapturedText) {
    // The degenerate tail: an empty-body page. Nothing to hand the server, so
    // a browser-tier scrape is the only option left.
    return {
      ...decision,
      plan: {
        kind: 'from-text',
        path: '/api/v1/scrapes/from-text/',
        plainJson: true,
        body: {
          text: page.text,
          link: page.url,
          source: 'extension',
          auto_score: options.autoScore,
          apply_url: hints.applyUrl ?? undefined,
          canonical_link_hint: hints.canonicalLinkHint ?? undefined,
          referrer_url: hints.referrerUrl ?? undefined,
          structured_prefill: hints.structuredPrefill ?? undefined,
        },
      },
    };
  }

  const captured: Record<string, unknown> = { description };
  // Omitted, not blanked, when the selectors missed — see CC-122.
  if (title) captured['title'] = title;
  if (company) captured['company'] = company;
  if (location) captured['location'] = location;
  if (hints.applyUrl) captured['apply_url'] = hints.applyUrl;

  const extractionHints: Record<string, unknown> = {};
  if (hints.canonicalLinkHint) extractionHints['canonical_link_hint'] = hints.canonicalLinkHint;
  if (hints.referrerUrl) extractionHints['referrer_url'] = hints.referrerUrl;
  if (hints.structuredPrefill) extractionHints['structured_prefill'] = hints.structuredPrefill;
  if (Object.keys(extractionHints).length > 0) {
    captured['extraction_hints'] = extractionHints;
  }

  return {
    ...decision,
    plan: {
      kind: 'extension-direct',
      path: '/api/v1/scrapes/',
      plainJson: false,
      body: {
        data: {
          type: 'scrape',
          attributes: {
            url: page.url,
            link: page.url,
            source_mode: 'extension-direct',
            captured_payload: captured,
          },
        },
      },
    },
  };
}
