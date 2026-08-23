/**
 * Anything arriving from a page is untrusted input. Parse it, do not trust it.
 *
 * The port is panel-initiated (`chrome.tabs.connect(tabId, {frameId})`), so the
 * OTHER end is already pinned to a tab the panel chose — there is no
 * `port.sender` to authenticate on the panel side and no way for a third party
 * to open this port. That is a strong guarantee and it is not the whole story:
 * the page at that address is still the employer's ATS, running its own
 * JavaScript, and it can post whatever it likes down a port it accepted.
 *
 * So the shape is validated here, and the panel separately re-checks that the
 * port still belongs to the tab it is looking at. What this function refuses is
 * a malformed or hostile payload; what it deliberately does NOT do is decide
 * whether the token means anything — that is a lookup against the panel's own
 * scan results, and a token it does not recognise resolves to nothing.
 */

export interface GolfSelect {
  token: string;
}

/**
 * A `cc-golf-select` message, or null.
 *
 * Null for every other outcome, including a well-formed message of the wrong
 * type. The caller cannot act on null, which is the point: there is one way
 * through and it requires a string token of plausible length.
 */
export function parseGolfMessage(raw: unknown): GolfSelect | null {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as { type?: unknown; token?: unknown };
  if (msg.type !== 'cc-golf-select') return null;
  if (typeof msg.token !== 'string') return null;

  const token = msg.token;
  // Tokens are minted by `h.stamp()` as `cc-<base36>-<base36>`. The bound is
  // deliberately loose — the exact shape is the scanner's business — but an
  // empty string or a megabyte of junk is not a token under any reading.
  if (token.length < 4 || token.length > 128) return null;
  return { token };
}
