import { describe, it, expect } from 'vitest';
import {
  bareHost,
  collectIdTokens,
  hostAgrees,
  normalizeTitle,
  originOf,
  pathPrefixScore,
  pickFromTrail,
  pickPageTitle,
  titlesMatch,
  verifyByTitle,
  verifyByToken,
} from '../ladder.ts';

/**
 * These encode what counts as evidence that an application form belongs to a
 * particular job post. They are the highest-value tests in the extension: a
 * wrong match does not fail loudly, it silently attaches your application to
 * somebody else's posting. Most of the cases below are therefore NEGATIVE.
 */

describe('collectIdTokens', () => {
  it('takes long identifier-shaped query values', () => {
    const t = collectIdTokens('https://ats.example.com/apply?gh_jid=a1b2c3d4e5f6g7h8i9');
    expect(t).toEqual(['a1b2c3d4e5f6g7h8i9']);
  });

  it('ignores short values — they are page numbers and locales, not job ids', () => {
    // A false id-token match is one of the few ways this can confidently
    // produce a WRONG answer, so the bar is deliberately high.
    expect(collectIdTokens('https://x.com/a?page=2&lang=en&sort=desc')).toEqual([]);
  });

  it('scans the fragment — SPA flows hide the id where no query parser looks', () => {
    expect(collectIdTokens('https://x.com/#/apply?jobId=ZZZZZZZZZZZZZZZZZZ')).toEqual([
      'ZZZZZZZZZZZZZZZZZZ',
    ]);
    expect(collectIdTokens('https://x.com/#abcdefghijklmnopqrst')).toEqual([
      'abcdefghijklmnopqrst',
    ]);
  });

  it('dedupes and caps at three — each token costs a server lookup', () => {
    const dup = 'aaaaaaaaaaaaaaaaaa';
    expect(collectIdTokens(`https://x.com/?a=${dup}&b=${dup}`)).toEqual([dup]);
    const many = 'https://x.com/?a=aaaaaaaaaaaaaaaaaa&b=bbbbbbbbbbbbbbbbbb&c=cccccccccccccccccc&d=dddddddddddddddddd';
    expect(collectIdTokens(many)).toHaveLength(3);
  });

  it('returns nothing for an unparseable URL rather than throwing', () => {
    expect(collectIdTokens('not a url')).toEqual([]);
  });
});

describe('titlesMatch', () => {
  it('matches on containment', () => {
    expect(titlesMatch('Senior Backend Engineer', 'senior backend engineer')).toBe(true);
    expect(titlesMatch('Backend Engineer', 'Backend Engineer (Remote)')).toBe(true);
  });

  it('ignores punctuation and case differences', () => {
    expect(titlesMatch('Full-Stack Developer', 'Full Stack Developer')).toBe(true);
  });

  it('REJECTS a plausible near-miss — this is the expensive failure', () => {
    // Real pair from the library: these are different jobs at different
    // companies, and treating them as one attaches an application to the
    // wrong posting.
    expect(titlesMatch('Senior Cloud Security Engineer', 'Cloud Support Engineer')).toBe(false);
    expect(titlesMatch('Backend Engineer', 'Frontend Engineer')).toBe(false);
  });

  it('scores against the SHORTER title so a long one cannot dilute a match', () => {
    expect(titlesMatch('Engineer', 'Engineer, Platform, Infrastructure and Tooling')).toBe(true);
  });

  it('is false when either side is empty', () => {
    expect(titlesMatch('', 'Engineer')).toBe(false);
    expect(titlesMatch(null, undefined)).toBe(false);
  });
});

describe('hostAgrees', () => {
  const post = { id: '1', link: 'https://www.linkedin.com/jobs/view/1', applyUrl: null };

  it('has no opinion when there is no constraint', () => {
    // An absent referrer must not reject everything.
    expect(hostAgrees(post, null)).toBe(true);
  });

  it('accepts a candidate whose link host matches, www-insensitively', () => {
    expect(hostAgrees(post, 'linkedin.com')).toBe(true);
  });

  it('accepts a match on applyUrl when the link disagrees', () => {
    expect(
      hostAgrees({ id: '1', link: 'https://a.com/x', applyUrl: 'https://b.com/y' }, 'b.com'),
    ).toBe(true);
  });

  it('rejects a candidate from somewhere you were not', () => {
    expect(hostAgrees(post, 'greenhouse.io')).toBe(false);
  });
});

describe('verifyByToken', () => {
  const tok = 'a1b2c3d4e5f6g7h8i9';

  it('requires the link to ACTUALLY contain the token', () => {
    // filter[query] also searches description/company, so a search hit alone
    // is not evidence — the link re-check is what makes it one.
    const rows = [{ id: '1', link: 'https://x.com/jobs/other' }];
    expect(verifyByToken(rows, tok, null)).toBeNull();
  });

  it('accepts exactly one verified row', () => {
    const rows = [
      { id: '1', link: `https://x.com/jobs/${tok}` },
      { id: '2', link: 'https://x.com/jobs/nope' },
    ];
    expect(verifyByToken(rows, tok, null)?.id).toBe('1');
  });

  it('returns NOTHING when two rows verify — ambiguity is not a weak answer', () => {
    // Two plausible posts means the ladder identified nothing. Picking one
    // would be a coin flip presented as a fact.
    const rows = [
      { id: '1', link: `https://x.com/a/${tok}` },
      { id: '2', link: `https://x.com/b/${tok}` },
    ];
    expect(verifyByToken(rows, tok, null)).toBeNull();
  });

  it('applies the referrer constraint', () => {
    const rows = [{ id: '1', link: `https://x.com/jobs/${tok}` }];
    expect(verifyByToken(rows, tok, 'y.com')).toBeNull();
    expect(verifyByToken(rows, tok, 'x.com')?.id).toBe('1');
  });
});

describe('verifyByTitle', () => {
  it('accepts exactly one title match', () => {
    const rows = [
      { id: '1', title: 'Backend Engineer', link: 'https://x.com/1' },
      { id: '2', title: 'Designer', link: 'https://x.com/2' },
    ];
    expect(verifyByTitle(rows, 'Backend Engineer', null)?.id).toBe('1');
  });

  it('returns nothing when several posts share a title', () => {
    // Common in reality: the same role open at several companies.
    const rows = [
      { id: '1', title: 'Backend Engineer', link: 'https://a.com/1' },
      { id: '2', title: 'Backend Engineer', link: 'https://b.com/2' },
    ];
    expect(verifyByTitle(rows, 'Backend Engineer', null)).toBeNull();
  });

  it('uses the referrer host to break what would otherwise be ambiguous', () => {
    const rows = [
      { id: '1', title: 'Backend Engineer', link: 'https://a.com/1' },
      { id: '2', title: 'Backend Engineer', link: 'https://b.com/2' },
    ];
    expect(verifyByTitle(rows, 'Backend Engineer', 'b.com')?.id).toBe('2');
  });
});

describe('pickPageTitle', () => {
  it('prefers og:title when the h1 is a bare section name', () => {
    // An ATS whose h1 is literally "Apply" would otherwise search for "Apply".
    expect(pickPageTitle('Apply', 'Senior Backend Engineer at Acme')).toBe(
      'Senior Backend Engineer at Acme',
    );
    expect(pickPageTitle('Jobs', 'Backend Engineer')).toBe('Backend Engineer');
  });

  it('prefers og:title when the h1 is too short to be a title', () => {
    expect(pickPageTitle('SE', 'Software Engineer')).toBe('Software Engineer');
  });

  it('keeps a real h1', () => {
    expect(pickPageTitle('Senior Platform Engineer', 'Acme Careers')).toBe(
      'Senior Platform Engineer',
    );
  });

  it('falls back either way, and to null when both are empty', () => {
    expect(pickPageTitle('', 'og only')).toBe('og only');
    expect(pickPageTitle('h1 only', '')).toBe('h1 only');
    expect(pickPageTitle(null, undefined)).toBeNull();
  });
});

describe('pickFromTrail (T6)', () => {
  const viewed = [
    { id: '1', link: 'https://linkedin.com/jobs/view/1' },
    { id: '2', link: 'https://greenhouse.io/jobs/2' },
  ];

  it('offers the most recent cross-origin post', () => {
    expect(pickFromTrail(viewed, 'https://jobs.ashbyhq.com/x/apply', null)?.id).toBe('1');
  });

  it('prefers one whose host matches the referrer', () => {
    expect(pickFromTrail(viewed, 'https://jobs.ashbyhq.com/x', 'greenhouse.io')?.id).toBe('2');
  });

  it('REFUSES a same-origin candidate — the single-origin-portal trap', () => {
    // Toptal hosts every job on one origin. Misfired live on
    // /portal/eligible-jobs (2026-07-08): a lookup miss there just means "a
    // different job on the same site", and offering the last one viewed is
    // confidently wrong. Same failure family as the origin-match suggestion
    // reverted in 1.8.3.
    const sameOrigin = [{ id: '9', link: 'https://toptal.com/portal/jobs/9' }];
    expect(pickFromTrail(sameOrigin, 'https://toptal.com/portal/eligible-jobs', null)).toBeNull();
  });

  it('returns nothing for an empty trail', () => {
    expect(pickFromTrail([], 'https://x.com/', null)).toBeNull();
  });
});

describe('url helpers', () => {
  it('bareHost strips www and lowercases; null on garbage', () => {
    expect(bareHost('https://WWW.Example.com/x')).toBe('example.com');
    expect(bareHost('nonsense')).toBeNull();
    expect(bareHost(null)).toBeNull();
  });

  it('originOf dedupes open-tab candidates by site', () => {
    expect(originOf('https://x.com/a')).toBe('https://x.com');
    expect(originOf('bad')).toBeNull();
  });

  it('pathPrefixScore counts shared leading segments', () => {
    expect(pathPrefixScore('https://x.com/a/b/c', 'https://x.com/a/b/d')).toBe(2);
    expect(pathPrefixScore('https://x.com/a', 'https://x.com/z')).toBe(0);
    expect(pathPrefixScore('bad', 'https://x.com/a')).toBe(0);
  });
});

describe('normalizeTitle', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeTitle('  Senior   Back-End Engineer (Remote!)  ')).toBe(
      'senior back end engineer remote',
    );
  });
});
