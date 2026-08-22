import { tracked } from '@glimmer/tracking';
import { hasOrigin, originPatternFor, requestOrigin } from '../platform/permissions.ts';
import { page } from './page.ts';

/**
 * Can the panel read the page it is looking at, and if not, can it ask?
 *
 * The product argument for per-origin, in Doug's words: *"if they open this
 * panel up they get to a place where it can genuinely help them, then they
 * will click yes. If they go to their gmail I would expect it not to work."*
 *
 * That is the whole design. The permission matches what a user already
 * assumes, and the moment to ask is on a page where the panel is visibly
 * useful — not at install, buried in a wall of consent nobody reads.
 *
 * So: never prompt unbidden. Detect, report honestly, offer a button.
 */

export type AccessState =
  | 'unknown'
  | 'granted'
  | 'needs-grant'
  /** We cannot even see which page this is, so we cannot ask for it. */
  | 'needs-tabs'
  /** chrome:// , about: , file:// — nothing grantable here. */
  | 'ungrantable';

class AccessTracker {
  @tracked state: AccessState = 'unknown';
  /** The `https://host/*` pattern for the current page, or null. */
  @tracked pattern: string | null = null;
  @tracked host = '';
  @tracked lastError = '';

  get needsGrant(): boolean {
    return this.state === 'needs-grant';
  }

  get needsTabs(): boolean {
    return this.state === 'needs-tabs';
  }

  get canRead(): boolean {
    return this.state === 'granted';
  }

  /**
   * Work out where we are and whether we may read it.
   *
   * `page.url` may be empty on Chrome precisely BECAUSE we lack access — the
   * browser will not name a tab you cannot touch. So fall back to the URL the
   * background worker captured during `action.onClicked`, which is the one
   * instant activeTab let it look. Without that fallback the panel cannot
   * offer a targeted grant and the user gets a second, pointless prompt.
   */
  async refresh(): Promise<void> {
    let url = page.url;
    if (!url) url = await this.lastActionUrl();

    const pattern = url ? originPatternFor(url) : null;
    this.pattern = pattern;
    try {
      this.host = url ? new URL(url).hostname : '';
    } catch {
      this.host = '';
    }

    if (!pattern) {
      // TWO very different reasons land here, and conflating them produced a
      // panel that said "nothing to read on this kind of page" while sitting
      // next to a Greenhouse posting.
      //
      //   url === ''  -> we cannot SEE the page. Chrome withholds tab.url
      //                  without host access, and the worker's action-click
      //                  stash did not reach us either. Fixable: the `tabs`
      //                  permission reveals URLs WITHOUT granting host
      //                  access, which is enough to then ask for the origin.
      //   url set     -> genuinely chrome:// / about: / file://. Nothing to
      //                  grant; saying so is the honest answer.
      this.state = url ? 'ungrantable' : 'needs-tabs';
      return;
    }

    // Probe for real rather than trusting a stored flag: the user can revoke
    // from chrome://extensions at any time and we would never hear about it.
    this.state = (await hasOrigin(pattern)) ? 'granted' : 'needs-grant';
  }

  /**
   * NOT async, and it awaits nothing before calling through.
   * `permissions.request` needs a live user gesture; the first await spends
   * it. `pattern` is resolved ahead of the click for exactly this reason.
   */
  grant = (): void => {
    const pattern = this.pattern;
    if (!pattern) return;
    this.lastError = '';
    void requestOrigin(pattern)
      .then(async (ok) => {
        if (!ok) {
          this.lastError = 'Not enabled — you can turn it on later from this panel.';
          return;
        }
        // A fresh grant means Chrome will now report this tab's URL, so
        // re-read the page before anything renders against stale state.
        await page.refresh();
        await this.refresh();
      })
      .catch(() => {
        this.lastError = 'The browser refused the permission request.';
      });
  };

  /**
   * Ask for `tabs`, which makes every tab's URL visible WITHOUT granting host
   * access to any of them. It is the escape from the chicken-and-egg: you
   * cannot request permission to a page you are not allowed to identify.
   *
   * Deliberately a separate, milder step than granting a site. Declared in
   * `optional_permissions` already, so this costs no install-time prompt.
   *
   * Not async — permissions.request needs the gesture unspent.
   */
  grantTabs = (): void => {
    void chrome.permissions
      .request({ permissions: ['tabs'] })
      .then(async (ok) => {
        if (!ok) {
          this.lastError = 'Without this, the panel cannot tell which page you are on.';
          return;
        }
        await page.refresh();
        await this.refresh();
      })
      .catch(() => {
        this.lastError = 'The browser refused the permission request.';
      });
  };

  private async lastActionUrl(): Promise<string> {
    try {
      const saved = await chrome.storage.session.get(['ccLastActionTab']);
      const entry = saved['ccLastActionTab'] as { tabId?: number; url?: string } | undefined;
      // Only trust it for the tab it was captured on. On any other tab it is
      // someone else's URL, and offering to enable the wrong site is worse
      // than offering nothing.
      if (entry?.url && entry.tabId === page.tabId) return entry.url;
      return '';
    } catch {
      return '';
    }
  }
}

export const access = new AccessTracker();
