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

/**
 * ── THE WORKER TALKING BACK ────────────────────────────────────────────────
 *
 * The background worker watches a scrape after the panel has stopped caring,
 * and until CCEXT-96 that channel ran one way only: the panel asked for a
 * watch, and the worker answered the OPERATING SYSTEM. So the panel sat on
 * "Parsing and scoring it." while a notification for the finished score was
 * already on screen — Doug, 2026-08-25: *"I even got a notification that it
 * saved it I got a score, but firefox didn't update."*
 *
 * These announcements are the return path. They are advisory: everything they
 * report can also be re-derived by asking the api, and the panel does exactly
 * that on boot and on navigation. What they buy is the case neither of those
 * covers — the tab sitting still while the work finishes elsewhere.
 *
 * TWO PROPERTIES THE CALLERS DEPEND ON.
 *
 * `url` is here so a listener can PAGE-SCOPE itself. The panel outlives pages,
 * so an announcement about the Toptal posting can easily arrive while the user
 * is looking at Greenhouse, and rendering it there is the CCEXT-33 failure —
 * one page's result narrated under another page's heading.
 *
 * EVERY terminal exit announces, including the ones that give up. That is not
 * completeness for its own sake: the send button now stays disabled while a
 * watch is outstanding, so a worker path that ends without announcing leaves a
 * dead button for the life of the page. Silence is no longer free.
 */
export type WorkerPhase =
  /** The post exists; a score has been started and is being watched. */
  | 'scoring'
  /** Terminal and good. The post is in the library, score included if asked. */
  | 'done'
  /** Terminal and bad — the posting could not be parsed. No JobPost. */
  | 'failed'
  /** The worker stopped watching without an answer: polls exhausted, the
   *  credential went away, or the api refused it. The work may STILL be
   *  running server-side, so this is "we stopped looking", not "it failed". */
  | 'gave-up';

export interface WorkerAnnouncement {
  /** The page the watch was started for. Compare before rendering. */
  url: string;
  phase: WorkerPhase;
  /** Present once the post exists — from `scoring` onward, and on `done`. */
  jobPostId: string | null;
}

const PHASES = new Set<string>(['scoring', 'done', 'failed', 'gave-up']);

/**
 * A `cc-scrape-progress` message, or null.
 *
 * Same discipline as `parseGolfMessage` above and for a weaker reason: this
 * one arrives over `runtime.sendMessage`, which only same-extension contexts
 * can reach, so it is not the hostile-input case. It is parsed anyway because
 * an unvalidated `as` cast is how a future refactor renames a field and gets
 * `undefined` at the far end instead of a build error — and the panel's
 * reaction to a malformed announcement should be to ignore it, not to render
 * "undefined".
 */
export function parseWorkerAnnouncement(raw: unknown): WorkerAnnouncement | null {
  if (!raw || typeof raw !== 'object') return null;
  const msg = raw as { type?: unknown; url?: unknown; phase?: unknown; jobPostId?: unknown };
  if (msg.type !== 'cc-scrape-progress') return null;
  if (typeof msg.phase !== 'string' || !PHASES.has(msg.phase)) return null;
  // A missing url is allowed through as ''. It cannot match any real page, so
  // a page-scoped listener ignores it while a page-agnostic one (the
  // workbench's "re-ask everything") still gets to act — which is the right
  // split for a watch whose origin url was never recorded.
  const url = typeof msg.url === 'string' ? msg.url : '';
  const jobPostId = typeof msg.jobPostId === 'string' && msg.jobPostId ? msg.jobPostId : null;
  return { url, phase: msg.phase as WorkerPhase, jobPostId };
}
