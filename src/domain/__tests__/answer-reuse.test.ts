import { describe, it, expect } from 'vitest';
import { answerReuseVerdict, autoInsertDecision } from '../answer-reuse.ts';
import type { AutoInsertInput } from '../answer-reuse.ts';
import type { PageQuestion } from '../answer-desk.ts';

const PAGE = 'https://boards.greenhouse.io/acme/jobs/1/apply';

function textField(over: Partial<PageQuestion> = {}): PageQuestion {
  return {
    kind: 'text',
    token: 'cc-tok-1',
    control: 'textarea',
    existing: '',
    how: 'its label',
    weak: false,
    label: 'Why here?',
    occurrence: 0,
    frameId: 0,
    ...over,
  } as PageQuestion;
}

function choiceField(): PageQuestion {
  return {
    kind: 'choice',
    token: null,
    control: 'select',
    options: ['Yes', 'No'],
    how: 'its label',
    weak: false,
    label: 'Authorized to work?',
    occurrence: 0,
    frameId: 0,
  } as PageQuestion;
}

function input(over: Partial<AutoInsertInput> = {}): AutoInsertInput {
  return {
    source: { sourceCompanyId: null, sourceCompany: null },
    hereCompanyId: null,
    content: 'A saved answer.',
    draftUrl: PAGE,
    pageUrl: PAGE,
    field: textField(),
    deliveredToken: null,
    ...over,
  };
}

describe('answerReuseVerdict', () => {
  it('allows an answer written for the company you are applying to', () => {
    const v = answerReuseVerdict(
      { sourceCompanyId: 'c1', sourceCompany: 'Acme' },
      'c1',
    );
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('same-company');
  });

  it('refuses one written for a DIFFERENT company, and names it', () => {
    // Question text repeats across employers, so the answer that comes back
    // may have been written for someone else. Auto-insert is what makes that
    // dangerous — another company's name landing in this company's form.
    const v = answerReuseVerdict(
      { sourceCompanyId: 'c1', sourceCompany: 'Stripe' },
      'c2',
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('different-company');
    expect(v.note).toContain('Stripe');
  });

  it('refuses when the answer has a company and this page has none', () => {
    const v = answerReuseVerdict(
      { sourceCompanyId: 'c1', sourceCompany: 'Stripe' },
      null,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unknown-current-company');
  });

  it('allows an answer with no provenance, but says it is reused', () => {
    // Most answers predate company attribution. Placing it is still the
    // streamlined behaviour; visibility is what stops it being silent.
    const v = answerReuseVerdict({ sourceCompanyId: null, sourceCompany: null }, 'c2');
    expect(v.ok).toBe(true);
    expect(v.note).not.toBe('');
  });
});

describe('autoInsertDecision', () => {
  it('inserts, and hands back the token that makes the write possible', () => {
    const decision = autoInsertDecision(input());
    expect(decision.insert).toBe(true);
    if (decision.insert) expect(decision.token).toBe('cc-tok-1');
  });

  it('REFUSES ACROSS A NAVIGATION — the check the popup never needed', () => {
    // In the popup, navigating away destroyed everything, so an armed insert
    // could not straddle a navigation. Nothing resets in a panel, and the URL
    // is the only thing that says otherwise.
    const decision = autoInsertDecision(
      input({ pageUrl: 'https://jobs.lever.co/other/apply' }),
    );
    expect(decision.insert).toBe(false);
    if (!decision.insert) expect(decision.reason).toBe('page-changed');
  });

  it('checks the page BEFORE anything else', () => {
    // Ordering matters: a same-company answer on the wrong page must still be
    // refused, and must be refused for the right reason.
    const decision = autoInsertDecision(
      input({
        pageUrl: 'https://elsewhere.example/',
        source: { sourceCompanyId: 'c1', sourceCompany: 'Acme' },
        hereCompanyId: 'c1',
      }),
    );
    expect(decision.insert).toBe(false);
    if (!decision.insert) expect(decision.reason).toBe('page-changed');
  });

  it('never fires on a choice control', () => {
    const decision = autoInsertDecision(input({ field: choiceField() }));
    expect(decision.insert).toBe(false);
    if (!decision.insert) expect(decision.reason).toBe('not-writable');
  });

  it('never overwrites text already in the field', () => {
    // It may be your own typing, or an edit to a previous insert. Silently
    // replacing either is unforgivable in a form you are about to submit.
    const decision = autoInsertDecision(
      input({ field: textField({ existing: 'half a paragraph I wrote' }) }),
    );
    expect(decision.insert).toBe(false);
    if (!decision.insert) expect(decision.reason).toBe('field-has-text');
  });

  it('does not write the same field twice', () => {
    const decision = autoInsertDecision(input({ deliveredToken: 'cc-tok-1' }));
    expect(decision.insert).toBe(false);
    if (!decision.insert) expect(decision.reason).toBe('already-delivered');
  });

  it('refuses when the question is no longer on the page', () => {
    const decision = autoInsertDecision(input({ field: null }));
    expect(decision.insert).toBe(false);
    if (!decision.insert) expect(decision.reason).toBe('no-field');
  });

  it('refuses an answer written for another company', () => {
    const decision = autoInsertDecision(
      input({
        source: { sourceCompanyId: 'c1', sourceCompany: 'Stripe' },
        hereCompanyId: 'c2',
      }),
    );
    expect(decision.insert).toBe(false);
    if (!decision.insert) {
      expect(decision.reason).toBe('different-company');
      expect(decision.note).toContain('Stripe');
    }
  });

  it('does nothing with an empty answer', () => {
    const decision = autoInsertDecision(input({ content: '   ' }));
    expect(decision.insert).toBe(false);
    if (!decision.insert) expect(decision.reason).toBe('empty');
  });
});
