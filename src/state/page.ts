import { tracked } from '@glimmer/tracking';
import { ccGrabPayload, ccCountUnreachableFrames } from '../injected/grab-payload.ts';
import type { PagePayload } from '../injected/grab-payload.ts';
import { SELF_HOSTS } from '../lib/api.ts';

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
  }

  /**
   * Read the active tab's text. Returns null when the page cannot be read —
   * which is a permission outcome, not an error, so the caller can say so.
   */
  async capture(): Promise<PagePayload | null> {
    await this.refresh();
    if (this.tabId === undefined) return null;
    try {
      const [hit] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: ccGrabPayload,
      });
      return (hit?.result as PagePayload) ?? null;
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
