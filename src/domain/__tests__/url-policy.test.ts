import { describe, it, expect } from 'vitest';
import { classifyUrl } from '../url-policy.ts';

/**
 * This module is the panel's fast-fail mirror of the api's own url_policy.
 * It had no tests until it started gating UI: the link picker is HIDDEN when
 * classifyUrl refuses, so a regression here does not merely allow a bad send —
 * it makes a whole card vanish or appear where it should not.
 */

const refused = (url: string) => {
  const v = classifyUrl(url);
  expect(v.ok, `expected ${url} to be refused`).toBe(false);
  return v.ok === false ? v.message : '';
};

describe('classifyUrl', () => {
  it('accepts an ordinary job posting', () => {
    expect(classifyUrl('https://boards.greenhouse.io/acme/jobs/1').ok).toBe(true);
    expect(classifyUrl('http://example.com/careers/42').ok).toBe(true);
  });

  it('refuses Career Caddy itself, with and without www', () => {
    // The page IS the library — there is nothing to ingest, and nothing to
    // link a post to. Both host spellings, because either one in the address
    // bar is the same site to the user.
    expect(refused('https://careercaddy.online/job-posts/rHeRo6qWCG')).toMatch(/Career Caddy/);
    expect(refused('https://www.careercaddy.online/job-posts/abc')).toMatch(/Career Caddy/);
  });

  it('does NOT refuse a lookalike host that merely contains the name', () => {
    // An exact-set membership test, not a substring match. `endsWith` or
    // `includes` here would refuse a legitimate posting on, say, a company
    // called careercaddy-recruiting.com.
    expect(classifyUrl('https://careercaddy.online.evil.com/x').ok).toBe(true);
    expect(classifyUrl('https://notcareercaddy.online/x').ok).toBe(true);
  });

  it('refuses non-http schemes, naming the scheme', () => {
    // chrome:// and file:// are where a panel spends a surprising amount of
    // its life — the extensions page itself, most of all.
    expect(refused('chrome://extensions')).toMatch(/chrome:/);
    expect(refused('file:///home/me/job.html')).toMatch(/file:/);
    expect(refused('about:blank')).toMatch(/about:/);
  });

  it('refuses private and internal hosts', () => {
    expect(refused('http://localhost:4200/job-posts/1')).toMatch(/private/);
    expect(refused('http://pibu.local/x')).toMatch(/private/);
    expect(refused('http://box.internal/x')).toMatch(/private/);
  });

  it('refuses an unparseable URL rather than throwing', () => {
    // page.url is '' before the first tab read; every caller must survive it.
    expect(refused('')).toMatch(/couldn't be parsed/i);
    expect(refused('not a url')).toMatch(/couldn't be parsed/i);
  });

  it('is case-insensitive about the host', () => {
    expect(refused('https://CareerCaddy.Online/job-posts/1')).toMatch(/Career Caddy/);
  });
});
