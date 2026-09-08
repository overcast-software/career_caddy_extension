/**
 * Which sections exist, and which one is showing.
 *
 * Small enough to have lived in the workbench, and deliberately does not:
 * "is this section visible?" is now answered in two places at once — the tab
 * bar and the section body — and the moment those two disagree the panel
 * renders nothing at all. One pure answer, imported twice, cannot disagree
 * with itself.
 *
 * Pure so the fallback below is testable. It fires on a state that is
 * genuinely hard to reach by hand (a persisted tab that is no longer
 * rendered), which is exactly the kind of rule that quietly rots when the only
 * way to check it is to reproduce it in a browser.
 */

export interface SectionSpec {
  id: string;
  /** The accordion header. Also the tab label, unless `short` overrides it. */
  title: string;
  /**
   * The tab label.
   *
   * Tabs and accordion headers have completely different budgets: the
   * accordion has the panel's full width, a tab has that width divided by
   * however many tabs there are. "This page" and "Answer desk" wrapped to two
   * lines while "Applications" did not, giving the strip uneven heights and a
   * ragged baseline (CCEXT-88). Rather than shorten the accordion's headers to
   * fit a constraint that is not theirs, a section may carry both.
   */
  short?: string;
  /** One line shown while collapsed, so a shut section still tells you something. */
  summary?: string;
  /**
   * Rendered only for a staff user.
   *
   * Doug, 2026-08-25: *"diagnostics is for me or super user anyway."* Gating
   * it is worth more than it looks — it takes a normal user from four tabs to
   * three, which is the difference between a strip that wraps and one that
   * does not.
   */
  staffOnly?: boolean;
}

/** Drop the sections this user is not entitled to see. */
export function visibleSections(
  sections: readonly SectionSpec[],
  isStaff: boolean,
): SectionSpec[] {
  return sections.filter((s) => !s.staffOnly || isStaff);
}

/**
 * The active tab, resolved against what is actually on screen.
 *
 * `layout.activeId` is persisted to `chrome.storage.local` and survives
 * everything — including losing staff, which un-renders the section it may be
 * pointing at. Nothing else would catch that: every section would ask "am I
 * the active one?", every section would correctly answer no, and the panel
 * would come up **blank** with no error anywhere. Falling back to the first
 * visible section turns an invisible dead end into a shrug.
 *
 * Returns `''` for an empty list rather than throwing. A panel with no
 * sections at all is a bug elsewhere, and crashing the render is a worse way
 * to report it than showing nothing.
 */
export function resolveActiveId(
  sections: readonly SectionSpec[],
  activeId: string,
): string {
  if (sections.some((s) => s.id === activeId)) return activeId;
  return sections[0]?.id ?? '';
}

/** What the tab strip prints. */
export function tabLabel(spec: SectionSpec): string {
  return spec.short ?? spec.title;
}
