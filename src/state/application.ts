import { tracked } from '@glimmer/tracking';
import { createApplication, findExistingApplication } from '../data/applications.ts';
import { page } from './page.ts';
import { session } from './session.ts';
import { errorLog } from './errors.ts';
import { trackedPost } from './tracked.ts';

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
