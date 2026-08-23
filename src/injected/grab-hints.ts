/**
 * INJECTED. Runs a per-host selector map against the live page.
 *
 * Read the rules at the top of grab-payload.ts first — they all apply. The one
 * that shapes this file most: **nothing may close over module scope.** Every
 * selector, every host list, every flag arrives through `args`.
 *
 * That is why this returns RAW hrefs and does no decoding. The DECODERS
 * registry lives in domain/decoders.ts and stays there: the panel decodes what
 * this returns. Reaching for it here would be the exact failure
 * scripts/injected-gate.mjs exists to catch — and the legacy extension makes
 * the same split for the same reason.
 */

/** Passed in from the panel; mirrors the api's extension-selectors shape. */
export interface HintSelectors {
  applyButtonSelectors: string[];
  canonicalLinkSelectors: string[];
  /** field name -> CSS selector, e.g. { title: 'h1', company_name: '.co' } */
  jobDataSelectors: Record<string, string>;
  /** Hosts whose referrer is worth recording; everything else is noise. */
  referrerHosts: string[];
  /** Phrases meaning "this posting is closed", matched case-insensitively. */
  closedPhrases: string[];
}

export interface RawHints {
  /** UNDECODED. The panel applies the named decoder. */
  applyHref: string | null;
  canonicalLink: string | null;
  referrerUrl: string | null;
  structuredPrefill: Record<string, string>;
  /** Which configured fields actually matched — for the staff validator. */
  matched: string[];
  missed: string[];
  /** The phrase that matched, verbatim, or null. Evidence, not a boolean. */
  closedEvidence: string | null;
}

export function ccGrabHints(selectors: HintSelectors): RawHints {
  const out: RawHints = {
    applyHref: null,
    canonicalLink: null,
    referrerUrl: null,
    structuredPrefill: {},
    matched: [],
    missed: [],
    closedEvidence: null,
  };

  // --- apply button: first selector that yields an href wins -------------
  for (const selector of selectors.applyButtonSelectors || []) {
    try {
      const el = document.querySelector(selector);
      const href = el ? el.getAttribute('href') : null;
      if (href) {
        out.applyHref = href;
        break;
      }
    } catch {
      // A malformed selector from a stale profile must not abort the whole
      // capture — skip it and keep going.
    }
  }

  // --- canonical link: usually <meta property="og:url"> ------------------
  for (const selector of selectors.canonicalLinkSelectors || []) {
    try {
      const el = document.querySelector(selector);
      if (!el) continue;
      const value = el.getAttribute('content') || el.getAttribute('href');
      if (value) {
        out.canonicalLink = value;
        break;
      }
    } catch {
      /* skip a bad selector */
    }
  }

  // --- referrer, but only from hosts worth recording ---------------------
  // An allowlist rather than everything: a referrer of "gmail.com" or a
  // search page tells you nothing about where the job came from, and storing
  // it pollutes dedupe.
  try {
    const ref = document.referrer;
    if (ref) {
      const host = new URL(ref).hostname.toLowerCase();
      const wanted = (selectors.referrerHosts || []).some(
        (h) => host === h || host.endsWith('.' + h),
      );
      if (wanted) out.referrerUrl = ref;
    }
  } catch {
    /* unparseable referrer */
  }

  // --- structured prefill: per-field selectors ---------------------------
  const fields = selectors.jobDataSelectors || {};
  for (const field of Object.keys(fields)) {
    const selector = fields[field];
    if (!selector) continue;
    try {
      const el = document.querySelector(selector);
      const text = el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      if (text) {
        out.structuredPrefill[field] = text;
        out.matched.push(field);
      } else {
        // Configured but empty is DIFFERENT from not configured, and the
        // staff validator needs to tell them apart: an empty match means the
        // selector is stale, which is actionable.
        out.missed.push(field);
      }
    } catch {
      out.missed.push(field);
    }
  }

  // --- closed-posting evidence -------------------------------------------
  // Returns the matched phrase VERBATIM, not a boolean, so the server can
  // verify it against the captured text rather than trusting a client-side
  // claim. That mirrors the graph's own closed_evidence validator.
  try {
    const body = document.body ? document.body.innerText : '';
    const haystack = body.toLowerCase();
    for (const phrase of selectors.closedPhrases || []) {
      const needle = phrase.toLowerCase();
      const at = haystack.indexOf(needle);
      if (at !== -1) {
        out.closedEvidence = body.slice(at, at + phrase.length);
        break;
      }
    }
  } catch {
    /* no body */
  }

  return out;
}
