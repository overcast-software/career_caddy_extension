import { describe, it, expect } from 'vitest';
import { resolveActiveId, tabLabel, visibleSections } from '../sections.ts';
import type { SectionSpec } from '../sections.ts';

const ALL: SectionSpec[] = [
  { id: 'page', title: 'This page', short: 'Page' },
  { id: 'applications', title: 'Applications', short: 'Apply' },
  { id: 'answers', title: 'Answer desk', short: 'Answers' },
  { id: 'diagnostics', title: 'Diagnostics', short: 'Debug', staffOnly: true },
];

describe('visibleSections', () => {
  it('hides a staff-only section from a normal user', () => {
    // The whole reason this exists: three tabs fit, four wrap.
    expect(visibleSections(ALL, false).map((s) => s.id)).toEqual([
      'page',
      'applications',
      'answers',
    ]);
  });

  it('shows everything to staff', () => {
    expect(visibleSections(ALL, true)).toHaveLength(4);
  });

  it('leaves an unmarked section alone regardless of staff', () => {
    const open: SectionSpec[] = [{ id: 'page', title: 'This page' }];
    expect(visibleSections(open, false)).toHaveLength(1);
    expect(visibleSections(open, true)).toHaveLength(1);
  });
});

describe('resolveActiveId', () => {
  it('keeps an active id that is on screen', () => {
    expect(resolveActiveId(ALL, 'answers')).toBe('answers');
  });

  it('FALLS BACK when the persisted tab is no longer rendered', () => {
    // The failure this prevents is invisible: activeId survives in
    // chrome.storage.local, staff is lost, and every remaining section
    // correctly answers "not me" — so the panel comes up BLANK with nothing
    // logged anywhere. Reproducing it by hand means revoking staff on a live
    // profile, which is exactly why it is tested here instead.
    expect(resolveActiveId(visibleSections(ALL, false), 'diagnostics')).toBe('page');
  });

  it('falls back for an id that never existed', () => {
    expect(resolveActiveId(ALL, 'nonsense')).toBe('page');
  });

  it('returns empty for no sections rather than throwing', () => {
    // A sectionless panel is a bug elsewhere; crashing the render is a worse
    // way to report it than showing nothing.
    expect(resolveActiveId([], 'page')).toBe('');
  });
});

describe('tabLabel', () => {
  it('prefers the short form, which is why the strip stops wrapping', () => {
    expect(tabLabel({ id: 'answers', title: 'Answer desk', short: 'Answers' })).toBe(
      'Answers',
    );
  });

  it('falls back to the full title when no short form is given', () => {
    // The accordion has the panel's full width and wants the long name, so a
    // section is allowed to carry only one label.
    expect(tabLabel({ id: 'page', title: 'This page' })).toBe('This page');
  });
});
