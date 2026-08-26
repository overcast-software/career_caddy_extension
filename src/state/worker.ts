import { parseWorkerAnnouncement } from '../domain/messages.ts';
import type { WorkerAnnouncement } from '../domain/messages.ts';

/**
 * The panel's ear for the background worker.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The worker/panel channel used to run one way. `send-card` posted
 * `cc-watch-scrape` and the worker, on finishing, told the OPERATING SYSTEM.
 * Nothing told the panel. So with the tab sitting still, the only three things
 * that ever re-derived tracked state were panel boot, `page.onChange`, and a
 * score the PANEL itself had started — and a worker-started score is none of
 * them. The panel held "Parsing and scoring it." indefinitely while the
 * notification for the finished score was already on screen (CCEXT-96).
 *
 * ── WHY A STATE MODULE RATHER THAN A LISTENER AT EACH CALL SITE ────────────
 *
 * Two consumers need this and they need DIFFERENT things from it. The
 * workbench wants "something moved, re-ask everything". The send card wants
 * "is this MY page, and what phase is it in". Registering a raw
 * `runtime.onMessage` in each would mean two parse sites that can disagree,
 * two places to remember the page-scoping rule, and nothing testable.
 *
 * It is also the shape the rest of the panel already uses: `PageState` and
 * `SessionState` both own an observer list and hand out `onChange`. A third
 * "something changed, re-derive" mechanism with its own idiom is exactly what
 * CCEXT-96 said not to build.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * NOT a source of truth. Every announcement is a hint that the api has
 * something new to say; the api remains the authority and the listeners go
 * ask it. Nothing here caches a job post, a score, or a status, because a
 * cache would then have to be invalidated on navigation, on disconnect and on
 * the panel outliving the worker — three obligations bought for no gain.
 *
 * NOT guaranteed to arrive, either. The worker announces at every terminal
 * exit it has, but a panel opened AFTER the work finished was never a
 * recipient, and `runtime.sendMessage` with no listener simply rejects on the
 * sender's side. Anything that would strand the UI if an announcement went
 * missing needs its own way out — for the send card that is the
 * `page.onChange` reset it already registers.
 */
class WorkerState {
  private subscribers: ((a: WorkerAnnouncement) => void)[] = [];
  private started = false;

  /**
   * Register a listener. Idempotent to start, so callers do not have to
   * coordinate who boots it — the first `onAnnounce` wires the runtime
   * listener and the rest just queue up behind it.
   */
  onAnnounce(fn: (a: WorkerAnnouncement) => void): void {
    this.subscribers.push(fn);
    this.start();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    try {
      chrome.runtime.onMessage.addListener((raw: unknown) => {
        const announcement = parseWorkerAnnouncement(raw);
        if (!announcement) return false;
        // A subscriber that throws must not take the others with it, and must
        // not reject back down the message channel either — from the worker's
        // side a rejected sendMessage is indistinguishable from "no panel is
        // open", which is a fact it acts on.
        for (const fn of this.subscribers) {
          try {
            fn(announcement);
          } catch {
            /* one bad listener is not the others' problem */
          }
        }
        // Synchronous, no reply. Returning true here would promise the sender
        // a response that never comes and hold the channel open until the
        // panel closes.
        return false;
      });
    } catch {
      /* no extension runtime — rendered outside the panel, e.g. in a test */
    }
  }
}

export const worker = new WorkerState();
