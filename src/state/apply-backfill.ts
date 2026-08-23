import { setApplyUrl } from '../data/posts.ts';
import { isAuthWall, wouldReplaceApplyUrl } from '../domain/job-post.ts';
import { collectHints } from './hints.ts';
import { page } from './page.ts';
import { session } from './session.ts';
import { trackedPost } from './tracked.ts';

/**
 * Passive apply-URL backfill — CCEXT-51, the half that needs no stash.
 *
 * When you land on a page whose job post is already in the library but has NO
 * apply_url, and the page exposes an apply button, quietly record it.
 *
 * WHY THIS IS WORTH DOING: measured on prod 2026-08-23, only 3 of the 100
 * most recently created posts have an apply_url at all. It is what dedupe uses
 * to recognise the same job reached from two boards, and the only durable
 * record of where an application actually went — ApplicationCard already
 * prefers it over the current tab for tracking_url and almost never finds one.
 *
 * SAFE TO DO WITHOUT ASKING, and the guard is the reason. This only ever
 * FILLS AN EMPTY FIELD. `wouldReplaceApplyUrl` is the same predicate the link
 * picker uses to demand a second click, and if it returns true this bails —
 * so the silent path can never overwrite a value a human chose. Anything
 * destructive stays behind the picker's explicit confirm.
 *
 * Silent throughout, deliberately: it is a background improvement to data the
 * user did not ask about. A failure means the field stays empty, which is
 * where it already was.
 */

class ApplyBackfill {
  private ticket = 0;
  /** Posts already attempted this session — one try each, not one per render. */
  private attempted = new Set<string>();

  reset(): void {
    this.ticket++;
  }

  async maybeBackfill(): Promise<void> {
    const mine = ++this.ticket;
    const post = trackedPost.post;
    const url = page.url;

    if (!session.apiKey || !post || !url) return;
    // Already has one — nothing to fill, and filling is all this does.
    if (post.applyUrl) return;
    if (this.attempted.has(post.id)) return;
    this.attempted.add(post.id);

    const hints = await collectHints(url);
    if (mine !== this.ticket) return;
    if (!hints.applyUrl) return;

    // Never record a sign-in page as where an application goes. Older posts in
    // the library carry `linkedin.com/signup/cold-join?…` for exactly this
    // reason — something captured the wall a logged-out visitor was bounced to.
    // This path writes without asking, so it is the one that most needs the
    // guard; the link picker deliberately does not use it, because there a
    // human is looking at the page.
    if (isAuthWall(hints.applyUrl)) return;

    // Belt and braces. post.applyUrl was null above, so this cannot be true —
    // but it is the one predicate that stands between a silent write and
    // destroying a human's choice, and it costs nothing to ask twice.
    if (wouldReplaceApplyUrl(post, hints.applyUrl)) return;

    const ok = await setApplyUrl(session.apiKey, post.id, hints.applyUrl);
    if (mine !== this.ticket || !ok) return;

    // Reflect it locally so the panel agrees with the server without a
    // refetch. A 403 is expected and normal here — filter[link] returns
    // cross-user posts, and PATCH is staff-or-owner — which is exactly why
    // setApplyUrl returns a boolean rather than throwing.
    trackedPost.post = { ...post, applyUrl: hints.applyUrl };
  }
}

export const applyBackfill = new ApplyBackfill();

/** Its own page reset, per the rule each page-scoped module carries. */
page.onChange(() => applyBackfill.reset());
