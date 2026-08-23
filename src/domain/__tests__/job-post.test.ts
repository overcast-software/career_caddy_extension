import { describe, it, expect } from 'vitest';
import { isAuthWall, toJobPost, wouldReplaceApplyUrl } from '../job-post.ts';

describe('toJobPost', () => {
  it('resolves the company from the sideload by (type, id)', () => {
    const post = toJobPost(
      {
        id: '1',
        type: 'job-post',
        attributes: { title: 'Staff Engineer' },
        relationships: { company: { data: { id: '7', type: 'company' } } },
      },
      [
        { id: '9', type: 'company', attributes: { name: 'Wrong Co' } },
        { id: '7', type: 'company', attributes: { name: 'Right Co' } },
      ],
    );
    expect(post.company).toBe('Right Co');
    expect(post.companyId).toBe('7');
  });

  it('accepts the plural type name too', () => {
    // The api's serializers are not consistent about singular vs plural, and
    // a mismatch silently blanks the company rather than failing loudly.
    const post = toJobPost(
      {
        id: '1',
        type: 'job-post',
        attributes: {},
        relationships: { company: { data: { id: '7', type: 'companies' } } },
      },
      [{ id: '7', type: 'companies', attributes: { name: 'Plural Co' } }],
    );
    expect(post.company).toBe('Plural Co');
  });

  it('defaults complete to TRUE when absent, FALSE only when explicit', () => {
    // An older api that does not send `complete` must not make every post look
    // incomplete. Only an explicit false means incomplete.
    expect(toJobPost({ id: '1', type: 'job-post', attributes: {} }).complete).toBe(true);
    expect(
      toJobPost({ id: '1', type: 'job-post', attributes: { complete: false } }).complete,
    ).toBe(false);
  });

  it('reports a pending score from any user', () => {
    const post = toJobPost({ id: '1', type: 'job-post', attributes: {} }, [
      { id: '3', type: 'score', attributes: { status: 'pending' } },
    ]);
    expect(post.hasPendingScore).toBe(true);
  });

  it('survives a missing company sideload without inventing one', () => {
    const post = toJobPost(
      {
        id: '1',
        type: 'job-post',
        attributes: { title: 'X' },
        relationships: { company: { data: { id: '7', type: 'company' } } },
      },
      [],
    );
    expect(post.company).toBeNull();
    expect(post.companyId).toBe('7');
  });
});

describe('wouldReplaceApplyUrl', () => {
  const post = (applyUrl: string | null) =>
    toJobPost({ id: '1', type: 'job-post', attributes: { apply_url: applyUrl } });

  it('is false when the post has no apply link yet', () => {
    expect(wouldReplaceApplyUrl(post(null), 'https://a.com/job')).toBe(false);
  });

  it('is false when linking the same URL again', () => {
    // Re-linking the page it already points at destroys nothing, so it must
    // not demand a second click — that would train people to double-click
    // through the warning that matters.
    expect(wouldReplaceApplyUrl(post('https://a.com/job'), 'https://a.com/job')).toBe(false);
  });

  it('is true when a DIFFERENT apply link would be overwritten', () => {
    expect(wouldReplaceApplyUrl(post('https://a.com/job'), 'https://b.com/job')).toBe(true);
  });
});

describe('isAuthWall', () => {
  it('catches the shape already sitting in the library', () => {
    // Not hypothetical. Older posts carry this as their apply_url — LinkedIn
    // bounced a logged-out visitor to a wall and something recorded the wall.
    expect(isAuthWall('https://www.linkedin.com/signup/cold-join?session_redirect=%2Fjobs')).toBe(
      true,
    );
    expect(isAuthWall('https://www.linkedin.com/authwall?trk=bf&original_referer=')).toBe(true);
  });

  it('catches an auth word inside a compound segment', () => {
    // /checkpoint/lg/login-submit — the segment is not equal to "login", which
    // is why segments are split on - and _ before matching.
    expect(isAuthWall('https://www.linkedin.com/checkpoint/lg/login-submit')).toBe(true);
    expect(isAuthWall('https://x.com/user_login/next')).toBe(true);
  });

  it('catches hosts that only ever serve a sign-in', () => {
    expect(isAuthWall('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    expect(isAuthWall('https://login.microsoftonline.com/common/oauth2/authorize')).toBe(true);
    expect(isAuthWall('https://tenant.auth0.com/authorize')).toBe(true);
  });

  it('leaves real apply URLs alone', () => {
    expect(isAuthWall('https://boards.greenhouse.io/acme/jobs/123/apply')).toBe(false);
    expect(isAuthWall('https://jobs.ashbyhq.com/rescale/abc/application')).toBe(false);
    expect(isAuthWall('https://acme.com/careers/senior-engineer')).toBe(false);
  });

  it('does not treat an unparseable string as a wall', () => {
    // It is not a usable apply URL either, but callers reject that on their own
    // terms — this predicate answers only the question it is named for.
    expect(isAuthWall('not a url')).toBe(false);
    expect(isAuthWall(null)).toBe(false);
    expect(isAuthWall(undefined)).toBe(false);
  });

  it('accepts a known false positive rather than risk the reverse', () => {
    // A company whose slug starts with an auth word trips this. The trade is
    // deliberate: a false positive leaves the field empty, where it already
    // was, and the link picker can still set it by hand. A false negative
    // writes a sign-in page into the field dedupe relies on.
    expect(isAuthWall('https://ats.com/companies/signup-inc/jobs/1')).toBe(true);
  });
});
