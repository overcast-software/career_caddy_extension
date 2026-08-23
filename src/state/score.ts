import { tracked } from '@glimmer/tracking';
import { request } from '../lib/api.ts';
import type { JsonApiDoc } from '../lib/api.ts';
import { session } from './session.ts';
import { trackedPost } from './tracked.ts';

/**
 * Score a job post, and watch it land.
 *
 * THE PANEL CHANGES THIS FEATURE. The legacy extension handed the score id to
 * the background worker and walked away, with the reason stated outright in
 * its own comment: *"The popup is about to close, so this must be the
 * background's job, not a poll in here."* A panel does not close. It can poll
 * and render the result arriving, which is strictly better than a
 * fire-and-forget plus an OS notification minutes later.
 *
 * The worker's role does not vanish — it is what covers the panel being shut
 * mid-score — but it stops being the ONLY way to find out. That handoff lands
 * with the rest of the worker port (CCEXT-48).
 */

const TERMINAL = new Set(['completed', 'failed']);
const POLL_MS = 2500;
/** ~2 minutes. Past that, say so rather than spin forever. */
const MAX_POLLS = 48;

export type ScoreState = 'idle' | 'starting' | 'scoring' | 'done' | 'failed';

interface ScoreAttrs {
  status?: string;
  score?: number | null;
}

class ScoreRunner {
  @tracked state: ScoreState = 'idle';
  @tracked message = '';
  @tracked scoreId: string | null = null;

  /** Supersedes an older run so a stale poll cannot write over a newer one. */
  private ticket = 0;

  get isBusy(): boolean {
    return this.state === 'starting' || this.state === 'scoring';
  }

  /**
   * Offer scoring only when there is no score AND none is in flight.
   *
   * A pending score blocks re-scoring — including one started by another user,
   * mirroring the api's cross-user `top_score` behaviour. A completed score is
   * already on the badge, so a button would add nothing.
   */
  get canScore(): boolean {
    const post = trackedPost.post;
    if (!post || this.isBusy) return false;
    return post.topScore === null && !post.hasPendingScore;
  }

  reset(): void {
    this.ticket++;
    this.state = 'idle';
    this.message = '';
    this.scoreId = null;
  }

  start = (): void => {
    void this.run();
  };

  private async run(): Promise<void> {
    const post = trackedPost.post;
    if (!post || !session.apiKey) return;

    const mine = ++this.ticket;
    this.state = 'starting';
    this.message = 'Starting score…';

    const created = await request<JsonApiDoc<ScoreAttrs>>('/api/v1/scores/', {
      method: 'POST',
      token: session.apiKey,
      timeoutMs: 15000,
      body: {
        data: {
          type: 'score',
          relationships: {
            'job-post': { data: { type: 'job-post', id: String(post.id) } },
          },
        },
      },
    });

    if (mine !== this.ticket) return;

    if (!created.ok) {
      this.state = 'failed';
      this.message = created.error;
      return;
    }

    const id = created.data?.data?.id;
    if (!id) {
      this.state = 'failed';
      this.message = 'Career Caddy did not return a score id.';
      return;
    }

    this.scoreId = String(id);
    this.state = 'scoring';
    this.message = 'Scoring…';
    await this.poll(mine);
  }

  private async poll(mine: number): Promise<void> {
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await sleep(POLL_MS);
      if (mine !== this.ticket) return; // superseded

      const resp = await request<JsonApiDoc<ScoreAttrs>>(
        `/api/v1/scores/${this.scoreId}/`,
        { token: session.apiKey, timeoutMs: 10000 },
      );
      if (mine !== this.ticket) return;

      // A transient failure is not a terminal one — keep polling until the
      // cap rather than reporting a network blip as a failed score.
      if (!resp.ok) continue;

      const attrs = resp.data?.data?.attributes ?? {};
      const status = attrs.status ?? '';
      if (!TERMINAL.has(status)) continue;

      if (status === 'failed') {
        this.state = 'failed';
        this.message = 'Scoring failed — try again from Career Caddy.';
        return;
      }

      this.state = 'done';
      this.message = '';
      // Re-read the post so the badge picks up top_score from the source of
      // truth rather than us second-guessing it from the score payload.
      await trackedPost.refresh();
      return;
    }

    this.state = 'idle';
    this.message = 'Still scoring — check Career Caddy in a minute.';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const scoreRunner = new ScoreRunner();
