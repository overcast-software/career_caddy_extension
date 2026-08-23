import { describe, it, expect } from 'vitest';
import { profileLookupNote } from '../profile-note.ts';

/**
 * The whole point is that "no profile" and "could not find out" must never
 * read the same. One is actionable, the other is a reason to wait.
 */
describe('profileLookupNote', () => {
  it('calls a 404 a CONFIRMED absence, and says when it is cached', () => {
    expect(profileLookupNote('x.com', { host: 'x.com', ok: false, status: 404, from: 'network' }, false))
      .toContain('confirmed absent)');
    expect(profileLookupNote('x.com', { host: 'x.com', ok: false, status: 404, from: 'cache' }, false))
      .toContain('cached');
  });

  it('distinguishes a profile with NO selectors from no profile at all', () => {
    // jobright.ai, 2026-08-23: a real row with empty selector arrays. Sends
    // from there capture no apply link, and nothing said why.
    const note = profileLookupNote('jobright.ai', { host: 'jobright.ai', ok: true, status: 200, from: 'network' }, false);
    expect(note).toContain('exists');
    expect(note).toContain('NO extension selectors');
    expect(note).not.toContain('404');
  });

  it('reports a healthy profile plainly', () => {
    expect(profileLookupNote('linkedin.com', { host: 'linkedin.com', ok: true, status: 200, from: 'network' }, true))
      .toBe('ScrapeProfile found for linkedin.com.');
  });

  it('REFUSES to call a throttle or an outage an absence', () => {
    for (const status of [429, 500, 503, 0]) {
      const note = profileLookupNote('x.com', { host: 'x.com', ok: false, status, from: 'baked' }, false);
      expect(note).toContain('NOT a confirmed absence');
      expect(note).not.toContain('No ScrapeProfile');
    }
  });

  it('says so when no lookup has happened, rather than implying absence', () => {
    expect(profileLookupNote('x.com', null, false)).toContain('has run');
  });
});
