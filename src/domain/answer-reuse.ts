import type { PageQuestion } from './answer-desk.ts';

/**
 * When may an answer be placed in the form WITHOUT being read first?
 *
 * CCEXT-34's question, and the panel makes it harder rather than easier.
 *
 * Saved answers are matched on question TEXT, and question text repeats across
 * employers — "Tell us about a project you're proud of" is identical
 * everywhere. So the answer that comes back may have been written for someone
 * else. Auto-insert is what makes that dangerous: without it the user reads the
 * answer before using it; with it, another company's name lands in this
 * company's form and gets submitted.
 *
 * **THE PANEL INVERTS THE OLD SAFETY MARGIN.** In the popup, navigating away
 * destroyed everything, so an armed auto-insert could not outlive the page it
 * was armed on. Nothing resets in a panel. Auto-insert plus a surface that
 * survives tab switches is strictly more dangerous than auto-insert plus one
 * that dies on blur, so the checks here get stronger, not weaker — and they are
 * one pure function with tests rather than a sequence of `if`s spread across a
 * component.
 *
 * PROVENANCE, NOT TEXT-SCANNING. Comparing the answer's own company to the
 * current one is exact. Scanning the prose for company names would flag "a
 * golden opportunity" and — worse — would flag the user's OWN employers, which
 * are exactly what a good answer is supposed to name ("At Uber I automated
 * vulnerability testing"). Mentioning where you worked is the point; mentioning
 * where you applied last week is the bug.
 */

export interface ReuseSource {
  /** The company the saved answer was written for, if the api told us. */
  sourceCompanyId: string | null;
  sourceCompany: string | null;
}

export type ReuseReason =
  | 'same-company'
  | 'unknown-provenance'
  | 'different-company'
  | 'unknown-current-company';

export interface ReuseVerdict {
  ok: boolean;
  reason: ReuseReason;
  /** Always present. Even the safe outcomes have something worth saying. */
  note: string;
}

export function answerReuseVerdict(
  source: ReuseSource,
  hereCompanyId: string | null,
): ReuseVerdict {
  const from = source.sourceCompanyId;
  const fromName = source.sourceCompany;
  const here = hereCompanyId;

  if (from && here && String(from) === String(here)) {
    return { ok: true, reason: 'same-company', note: '' };
  }

  if (from && here) {
    return {
      ok: false,
      reason: 'different-company',
      note: fromName
        ? `That saved answer was written for ${fromName}. Read it before using it here — Insert when you're happy.`
        : 'That saved answer was written for a different company. Read it before using it here — Insert when you\'re happy.',
    };
  }

  if (from) {
    // It was written for someone specific and we cannot tell where we are.
    return {
      ok: false,
      reason: 'unknown-current-company',
      note: fromName
        ? `That saved answer was written for ${fromName}, and this page isn't matched to a job post. Check it fits before inserting.`
        : 'That saved answer was written for a specific company. Check it fits before inserting.',
    };
  }

  // No provenance recorded — most answers predate company attribution. Placing
  // it is still the streamlined behaviour, but say it is reused so a
  // company-specific line is visible rather than silent.
  return {
    ok: true,
    reason: 'unknown-provenance',
    note: 'Reused a saved answer — worth a read before you submit.',
  };
}

export interface AutoInsertInput {
  source: ReuseSource;
  hereCompanyId: string | null;
  /** The answer text as it stands. */
  content: string;
  /** The URL this draft belongs to. */
  draftUrl: string;
  /** The URL the panel is looking at RIGHT NOW. */
  pageUrl: string;
  /** The live scanned field, or null when the question is no longer on screen. */
  field: PageQuestion | null;
  /** The token we last auto-delivered into, so one field is not written twice. */
  deliveredToken: string | null;
}

export type AutoInsertRefusal =
  | 'empty'
  | 'page-changed'
  | 'no-field'
  | 'not-writable'
  | 'field-has-text'
  | 'already-delivered'
  | ReuseReason;

/**
 * A discriminated union again, for the same reason `ResolvedField` is one: the
 * only way to obtain a token is to be told yes. The caller cannot write into
 * the page off the back of a refusal, because a refusal has no token to write
 * with.
 */
export type AutoInsertDecision =
  | { insert: true; token: string; note: string }
  | { insert: false; reason: AutoInsertRefusal; note: string };

/**
 * Should this answer be placed automatically?
 *
 * Only ever for an answer we ALREADY HAD — a saved match or a restored draft.
 * A freshly generated answer is never auto-placed: the user should read what
 * the model wrote before it lands in something they are about to submit.
 * That distinction lives at the call site, because it is about where the text
 * came from, which this function cannot see.
 */
export function autoInsertDecision(input: AutoInsertInput): AutoInsertDecision {
  const value = input.content.trim();
  if (!value) return { insert: false, reason: 'empty', note: '' };

  // PAGE-SCOPE FIRST, before anything about companies or fields. This is the
  // check the popup never needed: it died on blur, so an armed insert could
  // not straddle a navigation. Here it can, and the URL is the only thing that
  // says otherwise.
  if (input.draftUrl !== input.pageUrl) {
    return {
      insert: false,
      reason: 'page-changed',
      note: 'That draft belongs to a different page.',
    };
  }

  if (!input.field) {
    return {
      insert: false,
      reason: 'no-field',
      note: 'That question is no longer on the page — copy the answer instead.',
    };
  }

  // The type system already refuses a write to a choice control; this is the
  // same rule stated as a message, so the user learns WHY nothing happened
  // rather than watching a button do nothing.
  if (input.field.kind !== 'text') {
    return {
      insert: false,
      reason: 'not-writable',
      note: `That is a ${input.field.control} — copy the answer and pick an option yourself.`,
    };
  }

  // NEVER overwrite something already in the field. It may be your own typing,
  // or an edit you made to a previous insert — silently replacing either is
  // unforgivable in a form you are about to submit. A non-empty field means
  // Insert stays a deliberate click.
  if (input.field.existing) {
    return {
      insert: false,
      reason: 'field-has-text',
      note: 'That field already has text — Insert to replace it.',
    };
  }

  if (input.deliveredToken === input.field.token) {
    return { insert: false, reason: 'already-delivered', note: '' };
  }

  const verdict = answerReuseVerdict(input.source, input.hereCompanyId);
  if (!verdict.ok) {
    return { insert: false, reason: verdict.reason, note: verdict.note };
  }

  return { insert: true, token: input.field.token, note: verdict.note };
}
