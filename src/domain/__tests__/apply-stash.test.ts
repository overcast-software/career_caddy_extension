import { describe, it, expect } from 'vitest';
import {
  APPLY_STASH_MAX,
  APPLY_STASH_TTL_MS,
  addToStash,
  clearForPost,
  isConfident,
  pickStashMatch,
  pruneStash,
  type ApplyStashEntry,
} from '../apply-stash.ts';

const NOW = 1_700_000_000_000;

function entry(over: Partial<ApplyStashEntry> = {}): ApplyStashEntry {
  return {
    jobPostId: '1',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    title: 'Backend Engineer',
    company: 'Acme',
    companyId: 'c1',
    link: 'https://acme.com/careers/123',
    ts: NOW,
    ...over,
  };
}

describe('pruneStash', () => {
  it('keeps a live entry and drops an expired one', () => {
    const live = entry({ jobPostId: 'live', ts: NOW - 1000 });
    const dead = entry({ jobPostId: 'dead', ts: NOW - APPLY_STASH_TTL_MS - 1 });
    expect(pruneStash([live, dead], NOW).map((r) => r.jobPostId)).toEqual(['live']);
  });

  it('drops malformed rows rather than trusting stored shape', () => {
    // chrome.storage round-trips whatever was written, including by an older
    // version of this extension. A missing applyUrl would make the origin key
    // undefined and silently match every page.
    const raw = [null, {}, { applyUrl: 'x' }, { jobPostId: '1' }, entry()];
    expect(pruneStash(raw, NOW)).toHaveLength(1);
  });

  it('returns empty for a non-array, which is what absent storage looks like', () => {
    expect(pruneStash(undefined, NOW)).toEqual([]);
    expect(pruneStash('nonsense', NOW)).toEqual([]);
  });
});

describe('addToStash', () => {
  it('puts the newest first', () => {
    const a = entry({ jobPostId: 'a', applyUrl: 'https://a.com/x' });
    const b = entry({ jobPostId: 'b', applyUrl: 'https://b.com/x' });
    expect(addToStash([a], b).map((r) => r.jobPostId)).toEqual(['b', 'a']);
  });

  it('keeps ONE entry per origin, not per URL', () => {
    // The legacy's reason, verbatim: ATS apply URLs redirect and append steps.
    // Keying on the exact URL would remember /apply and /apply/step-2 as two
    // separate intentions when they are one.
    const first = entry({ jobPostId: 'old', applyUrl: 'https://ats.com/acme/apply' });
    const later = entry({ jobPostId: 'new', applyUrl: 'https://ats.com/acme/apply/step-2' });
    const out = addToStash([first], later);
    expect(out).toHaveLength(1);
    expect(out[0]!.jobPostId).toBe('new');
  });

  it('caps at APPLY_STASH_MAX, dropping the oldest', () => {
    let list: ApplyStashEntry[] = [];
    for (let i = 0; i < APPLY_STASH_MAX + 3; i++) {
      list = addToStash(list, entry({ jobPostId: `p${i}`, applyUrl: `https://s${i}.com/x` }));
    }
    expect(list).toHaveLength(APPLY_STASH_MAX);
    expect(list[0]!.jobPostId).toBe(`p${APPLY_STASH_MAX + 2}`);
  });
});

describe('clearForPost', () => {
  it('removes every entry for the post, comparing as strings', () => {
    // Post ids are 10-char NanoIDs, but a stale cache entry could hold a number
    // from an older build. String comparison is what the legacy did.
    const list = [entry({ jobPostId: '7' }), entry({ jobPostId: '8', applyUrl: 'https://b.com/x' })];
    expect(clearForPost(list, 7 as unknown as string).map((r) => r.jobPostId)).toEqual(['8']);
  });

  it('is a no-op when the post is not stashed', () => {
    const list = [entry()];
    expect(clearForPost(list, 'absent')).toHaveLength(1);
  });
});

describe('pickStashMatch', () => {
  it('finds the entry whose apply URL shares this page origin', () => {
    const list = [
      entry({ jobPostId: 'elsewhere', applyUrl: 'https://other.com/apply' }),
      entry({ jobPostId: 'here', applyUrl: 'https://ats.com/acme/jobs/1' }),
    ];
    expect(pickStashMatch(list, 'https://ats.com/acme/jobs/1/apply')?.entry.jobPostId).toBe('here');
  });

  it('prefers the LONGER shared path when one ATS holds several tracked posts', () => {
    // The case that matters: you tracked two jobs, both on Greenhouse, and now
    // you are standing on one of them. Recency alone would pick the wrong one
    // half the time.
    const older = entry({
      jobPostId: 'acme',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/111',
      ts: NOW - 60_000,
    });
    const newer = entry({
      jobPostId: 'globex',
      applyUrl: 'https://boards.greenhouse.io/globex/jobs/222',
      ts: NOW,
    });
    const hit = pickStashMatch([newer, older], 'https://boards.greenhouse.io/acme/jobs/111/apply');
    expect(hit?.entry.jobPostId).toBe('acme');
    expect(hit?.score).toBe(3);
  });

  it('falls back to recency when the path cannot distinguish them', () => {
    const old = entry({ jobPostId: 'old', applyUrl: 'https://ats.com/a', ts: NOW - 60_000 });
    const fresh = entry({ jobPostId: 'fresh', applyUrl: 'https://ats.com/b', ts: NOW });
    expect(pickStashMatch([old, fresh], 'https://ats.com/z')?.entry.jobPostId).toBe('fresh');
  });

  it('returns null for a different origin, and for an unparseable page URL', () => {
    expect(pickStashMatch([entry()], 'https://unrelated.com/x')).toBeNull();
    expect(pickStashMatch([entry()], 'not a url')).toBeNull();
    expect(pickStashMatch([], 'https://ats.com/x')).toBeNull();
  });
});

describe('isConfident — the single-origin-portal guard', () => {
  it('is confident when the employer path segment agrees', () => {
    const hit = pickStashMatch(
      [entry({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/123' })],
      'https://boards.greenhouse.io/acme/jobs/123/apply',
    );
    expect(isConfident(hit!)).toBe(true);
  });

  it('is NOT confident on a bare origin match — the Toptal shape', () => {
    // Same failure family as the T6 misfire on toptal.com/portal/eligible-jobs
    // (2026-07-08). Every job on a shared ATS lives on one origin, so "same
    // origin" on its own says almost nothing. The offer is still made — the
    // user may well be applying to the job they tracked — but it is phrased as
    // a question rather than asserted as a fact.
    const hit = pickStashMatch(
      [entry({ applyUrl: 'https://boards.greenhouse.io/acme/jobs/123' })],
      'https://boards.greenhouse.io/globex/jobs/999',
    );
    expect(hit).not.toBeNull();
    expect(isConfident(hit!)).toBe(false);
  });
});
