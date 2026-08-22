/**
 * Host-permission plumbing.
 *
 * WHY THIS EXISTS: Chrome never grants `activeTab` to a side panel. That is
 * deliberate, not a bug — the Chrome team's reasoning is that unlike a popup,
 * a persistently-shown panel makes it "not as evident to the user that they
 * invoke the extension" (crbug.com/1453437). The docs list exactly four
 * gestures that grant activeTab — action, context menu, keyboard shortcut,
 * omnibox — and side panels appear in none of them.
 *
 * So the panel cannot borrow access the way the old popup did. It has to hold
 * a real, granted host permission, which is not activeTab and is not subject
 * to any of the above.
 *
 * Firefox's sidebar is more permissive and needs none of this — it was
 * measured reading a *different* tab than the one the sidebar was opened
 * from, which activeTab should not even allow. So this is capability-detected
 * rather than branched on browser: ask "can I read this page?", and only offer
 * to fix it when the answer is no.
 */

/**
 * The origin pattern to request for a URL — `https://host/*`.
 *
 * Per-origin, deliberately. A broad `https://*&#47;*` would be one prompt
 * forever, but the whole point of asking is that the user can say yes to a job
 * board and never be asked about their bank. Returns null for anything not
 * http(s): chrome://, about:, file:// and the like cannot be granted and must
 * not be offered.
 */
export function originPatternFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

export async function hasOrigin(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * MUST be called synchronously from a click handler.
 *
 * `permissions.request` needs a live user gesture. The first `await` spends
 * it, and the call is then rejected with "may only be called from a user
 * gesture" — which reads as a permissions bug and is actually a timing one.
 * Same trap as `sidePanel.open`. So: resolve the pattern BEFORE the click,
 * and let the handler do nothing but call this.
 */
export function requestOrigin(pattern: string): Promise<boolean> {
  try {
    return chrome.permissions.request({ origins: [pattern] });
  } catch {
    return Promise.resolve(false);
  }
}

export async function removeOrigin(pattern: string): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    return false;
  }
}
