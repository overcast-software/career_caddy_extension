import { describe, it, expect } from 'vitest';
import { fieldRows, summarise, FIELD_ORDER } from '../proposed-post.ts';
import type { FieldOutcomes } from '../proposed-post.ts';

const NONE: FieldOutcomes = { configured: [], matched: [], missed: [], invalid: [] };

const outcomes = (over: Partial<FieldOutcomes>): FieldOutcomes => ({ ...NONE, ...over });

describe('fieldRows', () => {
  it('lists every canonical field even when nothing is configured', () => {
    const rows = fieldRows(NONE, {});
    expect(rows.map((r) => r.field)).toEqual([...FIELD_ORDER]);
    expect(rows.every((r) => r.verdict === 'absent')).toBe(true);
  });

  it('keeps the canonical reading order rather than sorting', () => {
    const rows = fieldRows(outcomes({ configured: ['description', 'title'] }), {});
    expect(rows[0]?.field).toBe('title');
    expect(rows.at(-1)?.field).toBe('description');
  });

  it('appends a bespoke configured field after the canonical set', () => {
    const rows = fieldRows(
      outcomes({ configured: ['title', 'req_id'], matched: ['req_id'] }),
      { req_id: 'R-4417' },
    );
    expect(rows.at(-1)).toEqual({ field: 'req_id', verdict: 'matched', value: 'R-4417' });
  });

  it('carries the matched value, and only for matched rows', () => {
    const rows = fieldRows(
      outcomes({ configured: ['title', 'salary'], matched: ['title'], missed: ['salary'] }),
      { title: 'Staff Engineer', salary: 'ignored' },
    );
    const byName = Object.fromEntries(rows.map((r) => [r.field, r]));
    expect(byName['title']).toEqual({ field: 'title', verdict: 'matched', value: 'Staff Engineer' });
    // A missed row must not surface a stale value even if one is handed in.
    expect(byName['salary']).toEqual({ field: 'salary', verdict: 'missed', value: null });
  });

  /**
   * The distinction the whole module exists for. Merged into "no match" these
   * two send a staff user hunting a DOM for a selector that never ran.
   */
  it('separates an invalid selector from a stale one', () => {
    const rows = fieldRows(
      outcomes({
        configured: ['title', 'company_name'],
        missed: ['title'],
        invalid: ['company_name'],
      }),
      {},
    );
    const byName = Object.fromEntries(rows.map((r) => [r.field, r]));
    expect(byName['title']?.verdict).toBe('missed');
    expect(byName['company_name']?.verdict).toBe('invalid');
  });

  it('prefers the specific verdict when a field is both configured and invalid', () => {
    const rows = fieldRows(outcomes({ configured: ['title'], invalid: ['title'] }), {});
    expect(rows.find((r) => r.field === 'title')?.verdict).toBe('invalid');
  });

  it('treats configured-but-unreported as missed, not absent', () => {
    // The page read can come back empty; "configured" still holds, and
    // reporting it as absent would blame the profile for the page.
    const rows = fieldRows(outcomes({ configured: ['location'] }), {});
    expect(rows.find((r) => r.field === 'location')?.verdict).toBe('missed');
  });
});

describe('summarise', () => {
  it('says so plainly when the host configures nothing', () => {
    expect(summarise(fieldRows(NONE, {}))).toBe(
      'No job_data selectors configured for this host.',
    );
  });

  it('counts matches against configured fields, not against the canonical set', () => {
    const rows = fieldRows(
      outcomes({ configured: ['title', 'company_name'], matched: ['title'], missed: ['company_name'] }),
      { title: 'x' },
    );
    expect(summarise(rows)).toBe('1/2 selectors matched');
  });

  it('calls out invalid selectors, because they are the actionable ones', () => {
    const rows = fieldRows(
      outcomes({
        configured: ['title', 'company_name', 'salary'],
        matched: ['title'],
        missed: ['salary'],
        invalid: ['company_name'],
      }),
      { title: 'x' },
    );
    expect(summarise(rows)).toBe('1/3 selectors matched · 1 invalid');
  });
});
