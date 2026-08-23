import { describe, it, expect } from 'vitest';
import { planSend } from '../send-gate.ts';
import type { CapturedPage } from '../../state/page.ts';

const page = (text: string): CapturedPage => ({
  url: 'https://linkedin.com/jobs/view/123',
  title: 'Software Engineer',
  text,
  frames: 1,
});

describe('CC-176: captured text always goes extension-direct', () => {
  it('uses extension-direct when there is page text', () => {
    const { plan } = planSend(page('a real job description'), {}, { autoScore: true });
    expect(plan.kind).toBe('extension-direct');
    expect(plan.path).toBe('/api/v1/scrapes/');
  });

  it('THE REGRESSION GUARD: missing title/company must NOT downgrade to the browser tier', () => {
    // This is the bug CC-176 fixed. The gate used to be
    // `useDirectPost = curatedComplete`, so a page whose per-host selectors
    // missed title/company fell to /scrapes/from-text/ — which waits for a
    // Camoufox runner that can never load an auth-walled page. The sites that
    // most needed the extension were precisely the ones it abandoned.
    const { plan, curatedComplete } = planSend(
      page('description only, selectors matched nothing'),
      { structuredPrefill: {} },
      { autoScore: true },
    );
    expect(curatedComplete).toBe(false);
    expect(plan.kind).toBe('extension-direct');
  });

  it('known_good does not branch the path — it only annotates', () => {
    const good = planSend(page('text'), { knownGood: true }, { autoScore: true });
    const bad = planSend(page('text'), { knownGood: false }, { autoScore: true });
    expect(good.plan.kind).toBe(bad.plan.kind);
    expect(good.knownGood).toBe(true);
    expect(bad.knownGood).toBe(false);
  });

  it('falls back to from-text ONLY for a page with no text at all', () => {
    const { plan } = planSend(page('   '), {}, { autoScore: true });
    expect(plan.kind).toBe('from-text');
    expect(plan.plainJson).toBe(true);
  });
});

describe('captured_payload shape', () => {
  const body = (hints = {}) =>
    (planSend(page('a description'), hints, { autoScore: true }).plan.body as {
      data: { attributes: { captured_payload: Record<string, unknown> } };
    }).data.attributes.captured_payload;

  it('OMITS title/company when selectors missed, rather than sending blanks', () => {
    // api CC-122: a blank title would be PERSISTED as the job's title.
    // Omitting it tells the server to LLM-extract from the description.
    const captured = body({ structuredPrefill: { title: '', company_name: '' } });
    expect(captured).not.toHaveProperty('title');
    expect(captured).not.toHaveProperty('company');
    expect(captured['description']).toBe('a description');
  });

  it('includes title/company when the selectors did match', () => {
    const captured = body({
      structuredPrefill: { title: 'Staff Engineer', company_name: 'Siemens' },
    });
    expect(captured['title']).toBe('Staff Engineer');
    expect(captured['company']).toBe('Siemens');
  });

  it('nests dedupe hints under extraction_hints', () => {
    const captured = body({
      canonicalLinkHint: 'https://example.com/job/1',
      referrerUrl: 'https://linkedin.com',
    });
    expect(captured['extraction_hints']).toMatchObject({
      canonical_link_hint: 'https://example.com/job/1',
      referrer_url: 'https://linkedin.com',
    });
  });

  it('puts apply_url on captured_payload, not extraction_hints', () => {
    const captured = body({ applyUrl: 'https://apply.example.com' });
    expect(captured['apply_url']).toBe('https://apply.example.com');
  });
});
