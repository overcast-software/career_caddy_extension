import { tracked } from '@glimmer/tracking';

/**
 * Tabs or accordion — and the ability to change your mind cheaply.
 *
 * The legacy extension had three tabs (Posts | Applications | Staff) for one
 * reason: a 320×600 popup had no room for anything else. The panel has the
 * full window height, which makes stacked collapsible sections viable and
 * arguably better — under tabs, checking which job post you are attached to
 * means LEAVING the answer box you are typing in, which is backwards for the
 * surface whose whole purpose is that box.
 *
 * Rather than guess, this makes the choice a runtime toggle over the same
 * components. Switching layout is a container swap, not a rewrite.
 */
export type LayoutMode = 'accordion' | 'tabs';

const STORAGE_KEY = 'ccLayoutMode';
const QC_EXPANDED_KEY = 'ccQuickCopyExpanded';
const ANSWER_LIST_KEY = 'ccAnswerListExpanded';

/**
 * `@tracked` is not a component feature — it works on any class. That single
 * fact is what makes "no dependency injection" survivable here: long-lived
 * reactive state can be a module-scoped singleton that components simply
 * import, with no owner, no container, and no service registry.
 *
 * Keep this list SHORT. Module singletons are global state; they are the right
 * answer for a handful of genuinely app-wide concerns (layout, theme, session,
 * current page) and the wrong answer for everything else, which should be
 * passed as `@args` so the data flow stays visible in the template.
 */
class LayoutState {
  /**
   * Accordion is the default because it is the layout the panel's shape
   * actually argues for; tabs are here to be compared against, not to be
   * quietly preferred.
   */
  @tracked mode: LayoutMode = 'accordion';

  /** Accordion: any number open. A Set, so membership is the open state. */
  @tracked openIds: ReadonlySet<string> = new Set(['page']);

  /** Tabs: exactly one active. */
  @tracked activeId = 'page';

  /**
   * `loaded` exists so the UI can avoid a flash of the wrong layout. Reading
   * storage is async, and rendering the default first and correcting a tick
   * later is visible.
   */
  @tracked loaded = false;

  /**
   * Quick copy: an icon bar, or full rows? (CCEXT-38)
   *
   * COLLAPSED IS THE DEFAULT, and the reason is subtle enough that the legacy
   * wrote it down: storage is read asynchronously, so a slow read can only
   * ever settle INTO the taller state, never flash out of it. Defaulting to
   * expanded would make the panel visibly shrink on every open.
   *
   * A device preference, like `mode` — it lives on the excluded side of
   * USER_SCOPED_STORAGE_KEYS, because collapsing a card is not user data and
   * signing out should not undo it.
   */
  @tracked quickCopyExpanded = false;

  /**
   * The answer desk's question picker: a dropdown, or every question as rows?
   *
   * Doug asked for both — *"a dropdown of questions and an alternate with a
   * list of all the questions"* — so they are two views of ONE list with
   * exactly one on screen, the same shape as quickCopyExpanded above.
   *
   * COLLAPSED (the `<select>`) IS THE DEFAULT, for the identical reason: the
   * storage read is async, so a slow read can only settle INTO the taller
   * state, never flash out of it. Defaulting to the list would make the panel
   * visibly shrink on every open.
   */
  @tracked answerListExpanded = false;

  async load(): Promise<void> {
    try {
      const saved = await chrome.storage.local.get([
        STORAGE_KEY,
        QC_EXPANDED_KEY,
        ANSWER_LIST_KEY,
      ]);
      const mode = saved[STORAGE_KEY];
      if (mode === 'tabs' || mode === 'accordion') this.mode = mode;
      if (saved[QC_EXPANDED_KEY] === true) this.quickCopyExpanded = true;
      if (saved[ANSWER_LIST_KEY] === true) this.answerListExpanded = true;
    } catch {
      // Storage unavailable (e.g. rendered outside an extension context).
      // The default is fine; this is a preference, not data.
    }
    this.loaded = true;
  }

  setMode(mode: LayoutMode): void {
    this.mode = mode;
    // Carry the user's place across the switch rather than resetting it.
    // Going accordion -> tabs collapses "several open" into "the first open
    // one is active"; tabs -> accordion opens the tab you were looking at.
    if (mode === 'tabs') {
      const first = [...this.openIds][0];
      if (first) this.activeId = first;
    } else {
      this.openIds = new Set([this.activeId]);
    }
    this.persist(mode);
  }

  /**
   * `.catch()` is NOT sufficient here, and that is worth understanding.
   *
   * If `chrome.storage` is undefined — which it is on any non-extension page,
   * including the static server used for development — then
   * `chrome.storage.local` throws a TypeError *synchronously*, while
   * evaluating the expression. There is no promise yet, so there is nothing
   * for `.catch()` to attach to and the error escapes into the click handler.
   *
   * A guard that only handles the async failure and not the synchronous one
   * looks defensive and isn't. try/catch covers both.
   */
  private persist(mode: LayoutMode): void {
    try {
      // Deliberately not awaited: a preference write must never make the UI
      // wait, and if it fails the only cost is that the choice is forgotten.
      void chrome.storage.local.set({ [STORAGE_KEY]: mode }).catch(() => {});
    } catch {
      /* no extension storage here; the layout still switched. */
    }
  }

  toggleQuickCopy(): void {
    this.quickCopyExpanded = !this.quickCopyExpanded;
    try {
      void chrome.storage.local
        .set({ [QC_EXPANDED_KEY]: this.quickCopyExpanded })
        .catch(() => {});
    } catch {
      /* no extension storage here; the card still toggled. */
    }
  }

  toggleAnswerList(): void {
    this.answerListExpanded = !this.answerListExpanded;
    try {
      void chrome.storage.local
        .set({ [ANSWER_LIST_KEY]: this.answerListExpanded })
        .catch(() => {});
    } catch {
      /* no extension storage here; the view still switched. */
    }
  }

  toggle(id: string): void {
    if (this.mode === 'tabs') {
      this.activeId = id;
      return;
    }
    // A NEW Set, not .add()/.delete(). Autotracking fires when the PROPERTY is
    // reassigned; mutating the existing Set in place changes no property, so
    // nothing would re-render. Same rule as reassigning an array.
    const next = new Set(this.openIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.openIds = next;
  }

  isVisible(id: string): boolean {
    return this.mode === 'tabs' ? this.activeId === id : this.openIds.has(id);
  }
}

/**
 * ONE instance, imported directly by whoever needs it. This is the whole DI
 * story: `import { layout } from '../state/layout.ts'`.
 */
export const layout = new LayoutState();

/**
 * `ccLayoutMode` is a DEVICE preference, not user data — it belongs with
 * ccTheme/ccPalette in the list that sign-out deliberately does NOT clear.
 * Wiping it on disconnect would reset someone's layout as a side effect of
 * logging out, which is a regression dressed as tidiness. The legacy
 * extension learned this the hard way; see USER_SCOPED_STORAGE_KEYS.
 */
export const LAYOUT_STORAGE_KEY = STORAGE_KEY;

/** Same reasoning as LAYOUT_STORAGE_KEY: device preference, never wiped. */
export const QUICK_COPY_EXPANDED_KEY = QC_EXPANDED_KEY;

/**
 * Same again. Note what this is NOT: `ccAnswerDrafts` holds the answers
 * themselves and IS user data, so it sits in USER_SCOPED_STORAGE_KEYS and is
 * wiped on disconnect. Which VIEW you prefer is not.
 */
export const ANSWER_LIST_EXPANDED_KEY = ANSWER_LIST_KEY;
