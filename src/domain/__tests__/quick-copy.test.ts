import { describe, it, expect } from 'vitest';
import { composeQuickCopyItems, isLinkLike, previewOf } from '../quick-copy.ts';

describe('composeQuickCopyItems', () => {
  it('seeds LinkedIn and GitHub from their own fields, pinned and first', () => {
    const items = composeQuickCopyItems({
      linkedin: 'https://linkedin.com/in/x',
      github: 'https://github.com/x',
      links: [{ name: 'Other', value: 'v' }],
    });
    expect(items.map((i) => i.name)).toEqual(['LinkedIn', 'GitHub', 'Other']);
    expect(items[0]?.pinned).toBe(true);
    expect(items[1]?.icon).toBe('github');
  });

  it('reads the legacy {url, name} shape — which is what real profiles hold', () => {
    // Not hypothetical: a live profile's links are exactly this, with several
    // hundred characters of prose in `url`. Dropping the fallback would empty
    // the list for anyone who has ever used the old editor.
    const items = composeQuickCopyItems({
      links: [{ url: 'Toptal is the talent agency…', name: 'Toptal prompt' }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.value).toBe('Toptal is the talent agency…');
    expect(items[0]?.name).toBe('Toptal prompt');
    expect(items[0]?.icon).toBe('flag');
    expect(items[0]?.pinned).toBe(false);
  });

  it('prefers value over url when both are present', () => {
    const items = composeQuickCopyItems({ links: [{ value: 'new', url: 'old', name: 'n' }] });
    expect(items[0]?.value).toBe('new');
  });

  it('maps the web app’s older icon vocabulary instead of discarding it', () => {
    const items = composeQuickCopyItems({
      links: [
        { value: 'a', name: 'a', icon: 'globe' },
        { value: 'b', name: 'b', icon: 'text' },
        { value: 'c', name: 'c', icon: 'trophy' },
        { value: 'd', name: 'd', icon: 'nonsense' },
      ],
    });
    expect(items.map((i) => i.icon)).toEqual(['flag', 'golfer', 'trophy', 'flag']);
  });

  it('drops links entries carrying a brand icon so seeds are not duplicated', () => {
    const items = composeQuickCopyItems({
      linkedin: 'https://linkedin.com/in/x',
      links: [{ value: 'https://linkedin.com/in/x', name: 'LinkedIn', icon: 'linkedin' }],
    });
    expect(items).toHaveLength(1);
  });

  it('falls back to the value as the name when no name is stored', () => {
    const items = composeQuickCopyItems({ links: [{ url: 'bare-value' }] });
    expect(items[0]?.name).toBe('bare-value');
  });

  it('skips empty, whitespace-only and malformed entries', () => {
    const items = composeQuickCopyItems({
      links: [null, 'a string', { name: 'no value' }, { url: '   ' }, { value: 'kept' }],
    } as never);
    expect(items.map((i) => i.value)).toEqual(['kept']);
  });

  it('returns nothing for a missing or empty profile rather than throwing', () => {
    expect(composeQuickCopyItems(null)).toEqual([]);
    expect(composeQuickCopyItems({})).toEqual([]);
    expect(composeQuickCopyItems({ links: 'not an array' } as never)).toEqual([]);
  });
});

describe('previewOf', () => {
  it('collapses whitespace so multi-line prose reads as one line', () => {
    expect(previewOf('a\n\n  b\tc')).toBe('a b c');
  });

  it('truncates with an ellipsis, leaving the stored value untouched', () => {
    const long = 'x'.repeat(200);
    const preview = previewOf(long, 10);
    expect(preview).toHaveLength(10);
    expect(preview.endsWith('…')).toBe(true);
    expect(long).toHaveLength(200);
  });

  it('leaves a short value exactly as it is', () => {
    expect(previewOf('short')).toBe('short');
  });
});

describe('isLinkLike', () => {
  it('recognises a real URL', () => {
    expect(isLinkLike('https://linkedin.com/in/x')).toBe(true);
    expect(isLinkLike('  http://example.com/a?b=c  ')).toBe(true);
  });

  it('treats prose as prose, including prose that mentions a URL', () => {
    // The common case now: snippets "sprouted into common prompts".
    expect(isLinkLike('Toptal is the talent agency. The question is for…')).toBe(false);
    expect(isLinkLike('See https://example.com for details')).toBe(false);
  });

  it('treats a schemeless domain as prose, deliberately', () => {
    // Guessing wrong here adds an "open" button that navigates somewhere the
    // user never asked to go. Prose beginning with a domain is far more
    // common than a stored schemeless URL.
    expect(isLinkLike('example.com')).toBe(false);
    expect(isLinkLike('www.example.com/x')).toBe(false);
  });

  it('rejects other schemes rather than opening them', () => {
    expect(isLinkLike('javascript:alert(1)')).toBe(false);
    expect(isLinkLike('file:///etc/passwd')).toBe(false);
  });
});
