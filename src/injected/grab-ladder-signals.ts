/**
 * INJECTED. Reads the three signals the ladder's later tiers need.
 *
 * Read the rules at the top of grab-payload.ts first — they all apply. Nothing
 * here may close over module scope; everything it needs is on `document`.
 *
 * ---
 *
 * THE REFERRER HERE IS UNGATED, and that is a deliberate difference from
 * grab-hints.ts, which filters the referrer against REFERRER_HOSTS. The two
 * are not the same field used twice:
 *
 *   grab-hints        the referrer is RECORDED on the job post, so it is
 *                     allowlisted — storing "gmail.com" or a search page
 *                     tells you nothing about where a job came from and
 *                     pollutes dedupe.
 *
 *   grab-ladder       the referrer is used to MATCH, never stored. Any
 *                     referrer is a signal: the whole question is "which page
 *                     sent me to this form", and constraining that to known
 *                     boards would discard exactly the company-careers-site
 *                     case the ladder exists for.
 *
 * Conflating them would either pollute stored data or blind the matcher.
 */

export interface LadderSignals {
  /** Full referrer URL, unfiltered. Null when there is none. */
  referrer: string | null;
  h1: string | null;
  ogTitle: string | null;
}

export function ccGrabLadderSignals(): LadderSignals {
  const out: LadderSignals = { referrer: null, h1: null, ogTitle: null };

  try {
    out.referrer = document.referrer || null;
  } catch {
    /* some embedding contexts throw on referrer */
  }

  try {
    const h1El = document.querySelector('h1');
    if (h1El) {
      // innerText first: it respects display rules, so a visually-hidden
      // heading does not win over the one the user can actually see.
      // textContent is the fallback for engines where innerText is absent.
      const text = (h1El as HTMLElement).innerText || h1El.textContent || '';
      out.h1 = text.trim() || null;
    }
  } catch {
    /* no h1 */
  }

  try {
    const ogEl = document.querySelector('meta[property="og:title"]');
    if (ogEl) out.ogTitle = ogEl.getAttribute('content');
  } catch {
    /* no og:title */
  }

  return out;
}
