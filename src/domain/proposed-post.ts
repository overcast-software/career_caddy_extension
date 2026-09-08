/**
 * The staff selector validator: what each job_data field did on this page.
 *
 * PORTED FROM `renderProposedPost` (legacy popup.js:1425), minus its DOM. The
 * legacy built the row list and the `<div>`s in one 150-line function; the
 * ordering and the per-field verdict are the only parts with any rules in
 * them, so they live here where they are testable and the component does
 * nothing but render what this returns.
 *
 * ## Why the verdict has four states and not two
 *
 * "No value" is the least useful thing this panel could say, because the four
 * causes want four different actions:
 *
 * | verdict | meaning | what a staff user does |
 * |---|---|---|
 * | `matched` | selector ran, found text | nothing |
 * | `missed` | selector ran, page had nothing | the selector is STALE — re-derive it |
 * | `invalid` | selector THREW — not valid CSS3 | fix the profile; it never ran |
 * | `absent` | no selector configured at all | author one |
 *
 * `invalid` is the one that earns its place. Per-host profiles are edited by
 * an offline enhancer pass, and a Playwright selector pasted into one —
 * `:has-text()`, `>>`, `text=` — is not CSS, so `querySelector` rejects the
 * whole string. Reported as "no match on this page" it sends someone hunting
 * a DOM for a selector the browser refused to run.
 */

export type FieldVerdict = 'matched' | 'missed' | 'invalid' | 'absent';

/**
 * The per-field selector outcome, as the page reported it.
 *
 * Declared HERE rather than in `state/hints.ts` so the dependency runs the
 * way the seams do — `state/` may import `domain/`, never the reverse. A
 * type-only import would compile either way, which is precisely why the
 * direction has to be a rule rather than a preference.
 */
export interface FieldOutcomes {
  /** Configured in the profile, in profile order. */
  configured: string[];
  matched: string[];
  missed: string[];
  invalid: string[];
}

export interface FieldRow {
  field: string;
  verdict: FieldVerdict;
  /** The matched text, for `matched` rows only. */
  value: string | null;
}

/**
 * Canonical order for the validation list.
 *
 * Read from the legacy verbatim (`PROPOSED_FIELD_ORDER`, popup.js:359) rather
 * than re-derived: it is the order of a job post as a person reads one, and
 * re-sorting it alphabetically would be a gratuitous difference between two
 * surfaces describing the same row.
 */
export const FIELD_ORDER = [
  'title',
  'company_name',
  'location',
  'salary',
  'posted_date',
  'description',
] as const;

/**
 * Canonical fields first, then anything the profile configures outside the
 * set — appended rather than dropped, because a host with a bespoke field is
 * exactly the case a staff user opened this panel to look at.
 *
 * Every canonical field appears even when nothing configures it. An absent
 * `company_name` is information: it is why a send arrives with no company.
 */
export function fieldRows(
  outcomes: FieldOutcomes,
  values: Record<string, string>,
): FieldRow[] {
  const matched = new Set(outcomes.matched);
  const missed = new Set(outcomes.missed);
  const invalid = new Set(outcomes.invalid);
  const configured = new Set(outcomes.configured);

  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of FIELD_ORDER) {
    names.push(name);
    seen.add(name);
  }
  for (const name of outcomes.configured) {
    if (!seen.has(name)) {
      names.push(name);
      seen.add(name);
    }
  }

  return names.map((field) => {
    // Order matters: a field can be configured AND invalid, and the specific
    // verdict is the useful one. `absent` is the fallback, never a winner.
    let verdict: FieldVerdict = 'absent';
    if (invalid.has(field)) verdict = 'invalid';
    else if (matched.has(field)) verdict = 'matched';
    else if (missed.has(field)) verdict = 'missed';
    else if (configured.has(field)) verdict = 'missed';

    return {
      field,
      verdict,
      value: verdict === 'matched' ? (values[field] ?? null) : null,
    };
  });
}

/** One line summarising the list, so the section header carries the answer. */
export function summarise(rows: FieldRow[]): string {
  const configured = rows.filter((r) => r.verdict !== 'absent');
  if (configured.length === 0) return 'No job_data selectors configured for this host.';

  const ok = configured.filter((r) => r.verdict === 'matched').length;
  const bad = configured.filter((r) => r.verdict === 'invalid').length;
  const tail = bad > 0 ? ` · ${bad} invalid` : '';
  return `${ok}/${configured.length} selectors matched${tail}`;
}
