import { describe, it, expect } from 'vitest';
import { parseGolfMessage } from '../messages.ts';

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
