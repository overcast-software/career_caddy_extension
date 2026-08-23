import { tracked } from '@glimmer/tracking';
import { ccGrabPayload, ccCountUnreachableFrames } from '../injected/grab-payload.ts';
import type { PagePayload } from '../injected/grab-payload.ts';
import { ccGrabHints } from '../injected/grab-hints.ts';
import { ccGrabLadderSignals } from '../injected/grab-ladder-signals.ts';
import { ccGrabExcerpt } from '../injected/grab-excerpt.ts';
import {
  CC_FIELD_ATTR,
  CC_GOLF_ATTR,
  ccResolveFieldInPage,
  ccWriteFieldInPage,
} from '../injected/resolve-field.ts';
import { GOLF_PORT, ccDecorateQuestions } from '../injected/decorate-questions.ts';
import type {
  ScanResult,
  SelectionResult,
  WriteOutcome,
} from '../injected/resolve-field.ts';
import type { LadderSignals } from '../injected/grab-ladder-signals.ts';
import type { HintSelectors, RawHints } from '../injected/grab-hints.ts';
import type { PageQuestion } from '../domain/answer-desk.ts';
import { SELF_HOSTS } from '../lib/api.ts';

// The mark's size and its stylesheet both moved into the painter
// (`src/injected/decorate-questions.ts`) when the mark stopped being a
// pseudo-element. Size is now derived per field from its height rather than
// being one constant, and the rules live in a constructed CSSStyleSheet inside
// each mark's shadow root — so there is nothing left for this module to hold
// and, notably, no `removeCSS` string that has to stay byte-identical to the
// `insertCSS` one.

// The `[data-cc-golf]::after` stylesheet that stood here is deleted, not
// moved. It could not have worked against a field: `input` and `textarea` are
// REPLACED elements with no internal content model, so they never box
// generated content. It was written for a LABEL anchor, and the label anchor
// is what CCEXT-57 retired.

/** What capture() returns: the merged page plus how it was assembled. */
export interface CapturedPage extends PagePayload {
  /** Frames that contributed text. 1 means the top frame only. */
  frames: number;
}

/**
 * Which page the panel is looking at.
 *
 * This has NO analogue in the legacy extension, and it is not a port — it is
 * new work the side panel makes necessary. A popup asked `tabs.query` once and
 * died; a panel outlives tab switches, navigations and window focus changes,
 * so it has to follow along.
 *
 * The sequence guard matters more than it looks. Every lookup here is async,
 * so without it a slow response for tab A can land after you have already
 * switched to tab B and render B's panel with A's data. The legacy codebase
 * grew that guard three separate times in three different places
 * (`linkJobRenderSeq`, and three `if (activeTab !== …) return` checks) because
 * it was never owned in one spot. It is owned here.
 */
class PageState {
  @tracked url = '';
  @tracked title = '';
  @tracked tabId: number | undefined;
  @tracked isCareerCaddy = false;
  /** Cross-origin frames we cannot read — an embedded ATS form lives here. */
  @tracked blockedFrames = 0;

  /** Monotonic; a response whose ticket is stale is dropped, not rendered. */
  private ticket = 0;
  private started = false;
  private subscribers: (() => void)[] = [];

  /**
   * Notify on every settled page change.
   *
   * A callback list rather than `page` importing what it needs to update:
   * `access` already imports `page`, so the reverse would be a cycle. This
   * keeps the dependency pointing one way and leaves the wiring visible at
   * the call site instead of buried in a module's import list.
   */
  onChange(fn: () => void): void {
    this.subscribers.push(fn);
  }

  get host(): string {
    try {
      return new URL(this.url).hostname;
    } catch {
      return '';
    }
  }

  /** Begin following the active tab. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    try {
      chrome.tabs.onActivated.addListener(() => void this.refresh());
      // Both branches are needed. `status: 'complete'` covers ordinary loads;
      // a bare `changeInfo.url` covers SPA navigation, which many ATSes use to
      // move between application steps WITHOUT a page load. Listening only for
      // 'complete' means the panel silently describes the previous step.
      chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
        if (changeInfo.status === 'complete' || changeInfo.url) void this.refresh();
      });
      chrome.windows.onFocusChanged.addListener(() => void this.refresh());
    } catch {
      /* not in an extension context */
    }
  }

  async refresh(): Promise<void> {
    const mine = ++this.ticket;
    let tab: chrome.tabs.Tab | undefined;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      return;
    }
    if (mine !== this.ticket) return; // superseded while we awaited

    // What subscribers are told is "the PAGE CHANGED", so only say it when it
    // did. refresh() runs on focus changes too — including the focus change
    // from clicking into the side panel itself — and firing then made
    // "navigate away" handlers run while the user was standing still.
    //
    // The symptom was precise and awful: press Send, the status flashes and
    // vanishes, nothing happens. Clicking the button moved focus, focus
    // triggered refresh, refresh told SendCard the page had changed, SendCard
    // cleared its status and bumped its staleness ticket, and the send it had
    // just started aborted itself as belonging to a previous page. A guard
    // against stale results was silently cancelling live ones.
    const previousUrl = this.url;

    this.tabId = tab?.id;
    this.url = tab?.url ?? '';
    this.title = tab?.title ?? '';
    try {
      this.isCareerCaddy = SELF_HOSTS.has(new URL(this.url).hostname.toLowerCase());
    } catch {
      this.isCareerCaddy = false;
    }
    // Same URL means the same page, however we got here. Tracked properties
    // above are still updated every time — title can change under a stable
    // URL — but a NOTIFICATION means navigation, and nothing else.
    if (this.url === previousUrl) return;

    for (const fn of this.subscribers) {
      try {
        fn();
      } catch {
        /* a bad subscriber must not stop the others */
      }
    }
  }

  /**
   * Read the active tab's text. Returns null when the page cannot be read —
   * which is a permission outcome, not an error, so the caller can say so.
   *
   * `allFrames: true` IS THE WHOLE FEATURE, not a refinement.
   *
   * ATS listings routinely put the actual job body in a same-origin subframe
   * — greenhouse boards, worksourcewa's GetJob.aspx, Lever overlays. Reading
   * only the top frame returns whatever chrome the outer document happens to
   * carry. Measured 2026-08-22 on a real Greenhouse posting: the top frame
   * yielded "Get new jobs like this in your inbox / We'll email you when Block
   * posts a job like this one…" — the signup footer — and the server
   * (correctly) reported "Extraction failed". The page looked fine on screen
   * and the capture was junk, which is the worst combination.
   *
   * results[0] is the top frame and ITS url is the canonical link; subframe
   * text is appended after a visible separator so the parse agent gets a
   * structural hint rather than one undifferentiated blob.
   *
   * Cross-origin subframes are still invisible — that is a permission
   * boundary, and countBlockedFrames() exists to say so rather than let it
   * read as an empty page.
   */
  async capture(): Promise<CapturedPage | null> {
    await this.refresh();
    if (this.tabId === undefined) return null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: this.tabId, allFrames: true },
        func: ccGrabPayload,
      });
      if (!results?.length) return null;
      const top = results[0]?.result as PagePayload | undefined;
      if (!top) return null;
      const parts = results
        .map((r) => (r.result as PagePayload | undefined)?.text)
        .filter((t): t is string => !!t && !!t.trim());
      return {
        url: top.url,
        title: top.title,
        text: parts.join('\n\n--- frame ---\n\n'),
        frames: parts.length,
      };
    } catch {
      return null;
    }
  }

  /**
   * Run a per-host selector map against the page.
   *
   * The selectors go in through `args` — never a closure. That is the
   * executeScript boundary, and scripts/injected-gate.mjs fails the build if
   * it is crossed.
   *
   * Top frame only, unlike capture(). Selectors are written against the page
   * the profile was authored for; running them across every frame invites a
   * match in someone else's embedded widget, and a wrong apply_url is worse
   * than none because it poisons dedupe.
   */
  async grabHints(selectors: HintSelectors): Promise<RawHints | null> {
    if (this.tabId === undefined) return null;
    try {
      const [hit] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: ccGrabHints,
        args: [selectors],
      });
      return (hit?.result as RawHints) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Referrer, h1 and og:title — the signals the ladder's later tiers need.
   *
   * Top frame only: the referrer of an embedded widget is the page embedding
   * it, which says nothing about how the USER arrived. Best-effort throughout;
   * a restricted page returns nulls rather than failing the ladder, because
   * the earlier tiers may still have an answer.
   */
  async grabLadderSignals(): Promise<LadderSignals> {
    const empty: LadderSignals = { referrer: null, h1: null, ogTitle: null };
    if (this.tabId === undefined) return empty;
    try {
      const [hit] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: ccGrabLadderSignals,
      });
      return (hit?.result as LadderSignals) ?? empty;
    } catch {
      return empty;
    }
  }

  /**
   * The top frame's visible text, for the CC-135 match context.
   *
   * TOP FRAME ONLY, and deliberately NOT capture(). The excerpt is a matching
   * HINT, not the multi-frame capture the send path needs — capture() joins
   * every reachable frame, which is heavier than the matcher wants and mixes
   * in embedded-widget text that makes the page harder to identify, not
   * easier. The legacy split these for exactly that reason and I had
   * collapsed them.
   */
  async grabExcerpt(max: number): Promise<string> {
    if (this.tabId === undefined) return '';
    try {
      const [hit] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: ccGrabExcerpt,
      });
      const text = hit?.result;
      return typeof text === 'string' ? text.slice(0, max) : '';
    } catch {
      return '';
    }
  }

  /**
   * Every labelled form field on the page, in every frame we can reach.
   *
   * `allFrames: true` for the same reason capture() needs it: the classic
   * Greenhouse setup is an ATS form embedded in company.com/careers, and
   * reading only the top frame finds no questions at all on exactly the pages
   * this feature exists for. Cross-origin frames stay invisible — that is a
   * permission boundary, and countBlockedFrames() is how the panel says so
   * instead of letting it read as "this form has no questions".
   *
   * `frameId` rides along because the WRITE has to go back into the same frame
   * the field came from.
   *
   * OCCURRENCE IS RECOUNTED HERE, ACROSS FRAMES. The injected scanner counts
   * within its own frame, so two frames each holding a "Why?" box would both
   * report occurrence 0 and collide on one draft key. Frames are merged in
   * frameId order (0 is always the top frame) and the count re-derived over the
   * merged list, so the key is unique across the whole page.
   */
  async scanQuestions(): Promise<PageQuestion[]> {
    if (this.tabId === undefined) return [];
    // The resolver serves both ladders, so its declared return type is the
    // union of both. `executeScript` cannot know which mode we asked for — it
    // just hands back whatever the function returned — so this is the one
    // place the two shapes are told apart, by a narrow rather than by an `as`
    // at every read.
    let results: chrome.scripting.InjectionResult<ScanResult | SelectionResult>[];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: this.tabId, allFrames: true },
        func: ccResolveFieldInPage,
        // Through `args`, never a closure — see scripts/injected-gate.mjs.
        args: [CC_FIELD_ATTR, 'scan', CC_GOLF_ATTR],
      });
    } catch {
      return [];
    }

    const ordered = [...results].sort((a, b) => (a.frameId ?? 0) - (b.frameId ?? 0));
    const merged: PageQuestion[] = [];
    const counts = new Map<string, number>();
    for (const frame of ordered) {
      const scan = frame.result;
      if (!scan || !('fields' in scan)) continue;
      for (const field of scan.fields) {
        const seen = counts.get(field.label) ?? 0;
        counts.set(field.label, seen + 1);
        merged.push({ ...field, occurrence: seen, frameId: frame.frameId ?? 0 });
      }
    }
    return merged;
  }

  /**
   * Write into a previously stamped field, in the frame it was stamped in.
   *
   * The token is the only handle — it is the sole thing that survives the
   * round trip out of the page and back. `gone` means the page re-rendered and
   * dropped the stamp, which must NOT be retried blind: whatever now occupies
   * that position is not the field the user chose.
   */
  async writeField(
    frameId: number,
    token: string,
    value: string,
  ): Promise<WriteOutcome> {
    if (this.tabId === undefined) return { ok: false, reason: 'gone' };
    try {
      const [hit] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId, frameIds: [frameId] },
        func: ccWriteFieldInPage,
        args: [CC_FIELD_ATTR, token, value],
      });
      return hit?.result ?? { ok: false, reason: 'gone' };
    } catch {
      return { ok: false, reason: 'gone' };
    }
  }

  /**
   * The golfer marks: paint them, and hand back the port that keeps them alive.
   *
   * TWO STEPS, AND THE ORDER MATTERS.
   *
   *   1. `executeScript` — paints the marks and starts LISTENING for a port.
   *      It must run before step 2 or the connect finds no listener and is
   *      dropped.
   *   2. `tabs.connect` — the panel dials the tab it already chose.
   *
   * There used to be an `insertCSS` step ahead of both, because the mark was a
   * `[data-cc-golf]::after` pseudo-element. That is gone: `input` and
   * `textarea` are REPLACED elements and cannot render `::before`/`::after` at
   * all, so anchoring to the field and using a pseudo-element are mutually
   * exclusive. The mark is now a real element in a closed shadow root, and its
   * rules ride in a constructed `CSSStyleSheet` via `adoptedStyleSheets` —
   * which is likewise not subject to the page's `style-src`, so the CSP
   * argument survives the change intact.
   *
   * THE PANEL DECIDES WHAT GETS PAINTED. `tokens` is the merged, prose-only
   * list; the painter resolves each against `data-cc-field` and does no
   * classification of its own. That keeps question identity in one place
   * (CCEXT-59) and avoids a second field classifier, which is the exact
   * failure CCEXT-30 was filed for.
   *
   * `allFrames` is deliberately absent from `insertCSS`/`executeScript` here in
   * MVP: `tabs.connect` addresses ONE frame, so painting frames we cannot then
   * wire up would produce marks that do nothing. Frame 0 only, and the panel
   * list covers the rest.
   */
  async decorateQuestions(tokens: string[]): Promise<chrome.runtime.Port | null> {
    const tabId = this.tabId;
    if (tabId === undefined) return null;
    if (tokens.length === 0) return null;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: ccDecorateQuestions,
        // GOLF_PORT rides in `args` rather than being read from module scope
        // inside the painter — see the note at its use site. This is the only
        // copy of the name; the connect below uses the same const.
        args: [CC_FIELD_ATTR, tokens, GOLF_PORT],
      });
      return chrome.tabs.connect(tabId, { name: GOLF_PORT, frameId: 0 });
    } catch {
      // No host permission, a restricted page, or the tab went away. The panel
      // list is the complete fallback, so this is not worth interrupting for.
      return null;
    }
  }

  /**
   * Remove the styling from a tab.
   *
   * Takes an explicit `tabId` because the common caller is a NAVIGATION or a
   * tab switch, by which time `this.tabId` is the new tab and the marks need
   * cleaning off the old one. Passing the current tab here is how CCEXT-56's
   * orphaned icons happen.
   *
   * NOW A NO-OP, DELIBERATELY KEPT. Teardown is entirely page-side: the
   * painter's `onDisconnect` removes its own wrappers, its observers and its
   * listeners, and dropping the port is what triggers it. There is no longer
   * any extension-injected CSS to take back, because the mark's rules live in
   * a constructed stylesheet inside a shadow root that goes away with the
   * wrapper.
   *
   * The method stays because the CALL SITE is still correct and still subtle:
   * it takes an explicit `tabId` because the common caller is a navigation or
   * a tab switch, by which time `this.tabId` is the NEW tab and the marks that
   * need cleaning are on the old one. Passing the current tab here is how
   * CCEXT-56's orphaned icons happen. Deleting the method would invite someone
   * to re-derive that, and get it wrong.
   */
  async undecorateQuestions(tabId: number): Promise<void> {
    void tabId;
  }

  async countBlockedFrames(): Promise<number> {
    if (this.tabId === undefined) return 0;
    try {
      const [hit] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: ccCountUnreachableFrames,
      });
      this.blockedFrames = typeof hit?.result === 'number' ? hit.result : 0;
    } catch {
      this.blockedFrames = 0;
    }
    return this.blockedFrames;
  }
}

export const page = new PageState();
