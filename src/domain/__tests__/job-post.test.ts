import { describe, it, expect } from 'vitest';
import { toJobPost, wouldReplaceApplyUrl } from '../job-post.ts';

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
