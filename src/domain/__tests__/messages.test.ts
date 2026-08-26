import { describe, it, expect } from 'vitest';
import { parseGolfMessage, parseWorkerAnnouncement } from '../messages.ts';

describe('parseGolfMessage', () => {
  it('accepts a well-formed select', () => {
    expect(parseGolfMessage({ type: 'cc-golf-select', token: 'cc-ab12cd34-x9' })).toEqual({
      token: 'cc-ab12cd34-x9',
    });
  });

  it('rejects junk of every shape', () => {
    // A port to a page carries whatever that page's JS decides to send. None
    // of these may reach a lookup.
    for (const raw of [null, undefined, 0, '', 'cc-golf-select', [], {}]) {
      expect(parseGolfMessage(raw)).toBeNull();
    }
  });

  it('rejects a well-formed message of the WRONG type', () => {
    // The type check is not decoration: a page could send its own
    // `{type:'click', token:…}` and a looser parser would act on it.
    expect(parseGolfMessage({ type: 'cc-answer-insert', token: 'cc-abc123' })).toBeNull();
  });

  it('rejects a non-string token', () => {
    expect(parseGolfMessage({ type: 'cc-golf-select', token: 42 })).toBeNull();
    expect(parseGolfMessage({ type: 'cc-golf-select', token: { evil: true } })).toBeNull();
    expect(parseGolfMessage({ type: 'cc-golf-select' })).toBeNull();
  });

  it('rejects an empty token and a megabyte of junk', () => {
    expect(parseGolfMessage({ type: 'cc-golf-select', token: '' })).toBeNull();
    expect(parseGolfMessage({ type: 'cc-golf-select', token: 'x'.repeat(200000) })).toBeNull();
  });

  it('does NOT decide whether the token means anything', () => {
    // Deliberate: shape is this function's job, identity is a lookup against
    // the panel's own scan results. An unknown token parses fine and then
    // resolves to no entry, which is what makes the stale-click message
    // reachable.
    expect(parseGolfMessage({ type: 'cc-golf-select', token: 'never-scanned' })).toEqual({
      token: 'never-scanned',
    });
  });
});

describe('parseWorkerAnnouncement', () => {
  const url = 'https://talent.toptal.com/portal/job/abc';

  it('accepts each of the four phases', () => {
    for (const phase of ['scoring', 'done', 'failed', 'gave-up'] as const) {
      expect(
        parseWorkerAnnouncement({ type: 'cc-scrape-progress', url, phase, jobPostId: 'GRUakIUbqm' }),
      ).toEqual({ url, phase, jobPostId: 'GRUakIUbqm' });
    }
  });

  it('rejects junk and the wrong type', () => {
    for (const raw of [null, undefined, 0, '', [], {}, { type: 'cc-golf-select', phase: 'done' }]) {
      expect(parseWorkerAnnouncement(raw)).toBeNull();
    }
  });

  it('rejects a phase it does not know', () => {
    // The whole point of the allow-list. A renamed phase must fail here rather
    // than reach the send card as an unhandled string and fall through to the
    // `done` branch, which would clear a watch that is still running.
    expect(
      parseWorkerAnnouncement({ type: 'cc-scrape-progress', url, phase: 'parsing' }),
    ).toBeNull();
    expect(parseWorkerAnnouncement({ type: 'cc-scrape-progress', url, phase: 42 })).toBeNull();
    expect(parseWorkerAnnouncement({ type: 'cc-scrape-progress', url })).toBeNull();
  });

  it('normalises a missing url to the empty string rather than refusing', () => {
    // A watch whose origin url was never recorded still has something worth
    // saying. '' matches no real page, so the page-scoped listener ignores it
    // while the workbench's page-agnostic one still re-derives.
    expect(parseWorkerAnnouncement({ type: 'cc-scrape-progress', phase: 'done' })).toEqual({
      url: '',
      phase: 'done',
      jobPostId: null,
    });
  });

  it('normalises a missing or empty jobPostId to null', () => {
    // `failed` and `gave-up` genuinely have no post, and '' must not survive
    // into a URL builder as `/job-posts//`.
    expect(
      parseWorkerAnnouncement({ type: 'cc-scrape-progress', url, phase: 'failed', jobPostId: '' }),
    ).toEqual({ url, phase: 'failed', jobPostId: null });
    expect(
      parseWorkerAnnouncement({ type: 'cc-scrape-progress', url, phase: 'gave-up', jobPostId: 7 }),
    ).toEqual({ url, phase: 'gave-up', jobPostId: null });
  });
});
