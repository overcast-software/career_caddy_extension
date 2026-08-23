import { tracked } from '@glimmer/tracking';
import { createApplication, findExistingApplication } from '../data/applications.ts';
import { page } from './page.ts';
import { session, KEYS } from './session.ts';
import { errorLog } from './errors.ts';
import { trackedPost } from './tracked.ts';
import { stashPendingApply } from './apply-stash.ts';

/**
 * "I applied to this one."
 *
 * Scoped to the job post currently matched to this page, which means it is
 * scoped to the PAGE — and the panel outlives pages. Everything here resets on
 * navigation for the same reason SendCard now does: in the popup the component
 * died and state reset by accident; here nothing dies, so a stale "Already
 * tracked" would otherwise sit under a posting you have never applied to.
 */

export type TrackState = 'idle' | 'checking' | 'tracking' | 'tracked' | 'error';

/**
 * Dedupe-on-render, cached.
 *
 * The legacy checks for an existing application when the card RENDERS, not
 * when you click Track — so a post you already applied to says "Already
 * tracked" up front instead of making you press a button to find out. Pressing
 * a button to be told you should not have pressed it is a bad way to learn a
 * fact the panel could have shown you.
 *
 * Two cached outcomes, and the negative one matters as much as the positive:
 * an `appId` means one exists; a timestamp means we CONFIRMED there is none.
 * Without the negative, every render of an untracked post re-asks the server.
 *
 * KEYED BY POST ID, not by URL as the legacy did. "Does an application exist
 * for this post" is a fact about the POST — the same post reached from a
 * LinkedIn link and from an ATS form has one answer, and keying on the page
 * would ask twice and could answer differently.
 */
const CHECK_KEY: string = KEYS.appChecks;
/** 10 minutes, matching the legacy's STASH_FRESH_MS. */
const CHECK_FRESH_MS = 10 * 60 * 1000;
const CHECK_MAX = 50;

interface CheckEntry {
  /** The application, or null for "confirmed none". */
  appId: string | null;
  at: number;
}

async function readCheck(postId: string): Promise<CheckEntry | null> {
  try {
    const saved = await chrome.storage.local.get([CHECK_KEY]);
    const all = (saved[CHECK_KEY] ?? {}) as Record<string, CheckEntry>;
    const entry = all[postId];
    if (!entry) return null;
    // A POSITIVE result never goes stale — an application does not un-exist.
    // Only the negative is time-boxed, because one can appear at any moment.
    if (entry.appId) return entry;
    return Date.now() - entry.at < CHECK_FRESH_MS ? entry : null;
  } catch {
    return null;
  }
}

async function writeCheck(postId: string, appId: string | null): Promise<void> {
  try {
    const saved = await chrome.storage.local.get([CHECK_KEY]);
    const all = (saved[CHECK_KEY] ?? {}) as Record<string, CheckEntry>;
    all[postId] = { appId, at: Date.now() };
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CHECK_MAX);
    await chrome.storage.local.set({ [CHECK_KEY]: Object.fromEntries(kept) });
  } catch {
    /* the check still ran; only its caching is lost */
  }
}

class ApplicationState {
  @tracked state: TrackState = 'idle';
  @tracked appId: string | null = null;
  @tracked status = '';

  private ticket = 0;

  get isBusy(): boolean {
    return this.state === 'checking' || this.state === 'tracking';
  }

  /** Reachable only when a post is matched — there is nothing to apply to otherwise. */
  get canTrack(): boolean {
    return trackedPost.isKnown && !this.isBusy && this.state !== 'tracked';
  }

  reset(): void {
    this.ticket++;
    this.state = 'idle';
    this.appId = null;
    this.status = '';
  }

  /**
   * Ask, on render, whether this post already has an application.
   *
   * Cheap by design: a cached answer costs nothing, and a confirmed-absent
   * answer stands for 10 minutes. Silent on failure — not knowing is exactly
   * the state the Track button already represents, so there is nothing to say.
   */
  async refreshFor(postId: string): Promise<void> {
    const mine = ++this.ticket;
    if (!session.apiKey) return;

    const cached = await readCheck(postId);
    if (mine !== this.ticket) return;
    if (cached?.appId) {
      this.appId = cached.appId;
      this.state = 'tracked';
      this.status = 'Already tracked';
      return;
    }
    if (cached) return; // confirmed none, recently — the Track button stands

    const existing = await findExistingApplication(session.apiKey, postId);
    if (mine !== this.ticket) return;
    if (!existing.ok) return;

    if (existing.appId) {
      this.appId = existing.appId;
      this.state = 'tracked';
      this.status = 'Already tracked';
    }
    await writeCheck(postId, existing.appId);
  }

  async track(): Promise<void> {
    const mine = ++this.ticket;
    const stale = (): boolean => mine !== this.ticket;

    const post = trackedPost.post;
    if (!post) return;
    if (!session.apiKey) {
      this.state = 'error';
      this.status = 'Not connected.';
      return;
    }

    // Dedupe FIRST. This is the only button that mints a row, and clicking it
    // twice must not produce two applications for one job.
    this.state = 'checking';
    this.status = 'Checking…';
    const existing = await findExistingApplication(session.apiKey, post.id);
    if (stale()) return;

    if (!existing.ok) {
      // NOT knowing whether one exists is a reason to stop, not a reason to
      // make another. Falling through here is precisely how a duplicate is
      // minted, and a duplicate application is not something the user can
      // easily see or undo from this panel.
      this.state = 'error';
      this.status = existing.error;
      errorLog.record('track', existing.error, page.host);
      return;
    }

    if (existing.appId) {
      this.state = 'tracked';
      this.appId = existing.appId;
      this.status = 'Already tracked';
      await writeCheck(post.id, existing.appId);
      return;
    }

    // tracking_url = the post's apply_url if it has one, else the page you are
    // standing on. The apply_url is the better record: it is where the
    // application actually goes, whereas the current tab may be the job
    // description rather than the form.
    const trackingUrl = post.applyUrl || page.url || null;

    this.state = 'tracking';
    this.status = 'Tracking…';
    const created = await createApplication(session.apiKey, post.id, trackingUrl);
    if (stale()) return;

    if (!created.ok) {
      this.state = 'error';
      this.status = created.error;
      errorLog.record('track', created.error, page.host);
      return;
    }

    this.state = 'tracked';
    this.appId = created.appId;
    this.status = 'Tracked';
    await writeCheck(post.id, created.appId);

    // Remember the intention. Tracking does NOT open the apply page — the
    // application is recorded in place — so if you walk to the ATS yourself
    // later, nothing on that page connects it back to this post. The stash is
    // what lets the ladder recognise it (see domain/apply-stash.ts).
    //
    // Only meaningful when the post has an apply_url, which is why this feature
    // has barely ever fired: the send path dropped it. That is now being fixed
    // on both sides (api #253, and state/apply-backfill.ts here).
    stashPendingApply(post);
  }
}

export const application = new ApplicationState();

/**
 * Registered here rather than in the workbench so the subscription lives with
 * the state it resets. The workbench should not have to know which modules are
 * page-scoped — that knowledge belongs to each module, and centralising it is
 * how one gets forgotten.
 */
page.onChange(() => application.reset());
