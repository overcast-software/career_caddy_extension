import { tracked } from '@glimmer/tracking';
import { ccGrabPayload, ccCountUnreachableFrames } from '../injected/grab-payload.ts';
import type { PagePayload } from '../injected/grab-payload.ts';
import { ccGrabHints } from '../injected/grab-hints.ts';
import type { HintSelectors, RawHints } from '../injected/grab-hints.ts';
import { SELF_HOSTS } from '../lib/api.ts';

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
    this.tabId = tab?.id;
    this.url = tab?.url ?? '';
    this.title = tab?.title ?? '';
    try {
      this.isCareerCaddy = SELF_HOSTS.has(new URL(this.url).hostname.toLowerCase());
    } catch {
      this.isCareerCaddy = false;
    }
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
