import { tracked } from '@glimmer/tracking';
import { searchPosts, setApplyUrl } from '../data/posts.ts';
import { wouldReplaceApplyUrl } from '../domain/job-post.ts';
import type { JobPost } from '../domain/job-post.ts';
import { classifyUrl } from '../domain/url-policy.ts';
import { page } from './page.ts';
import { session } from './session.ts';
import { errorLog } from './errors.ts';
import { trackedPost } from './tracked.ts';

/**
 * "Link this page to a job post I already have."
 *
 * For the case the by-link lookup cannot cover: you found the posting on the
 * company's own site, but your library has it from LinkedIn. Same job, two
 * URLs, and nothing automatic will connect them — so you point at it yourself.
 *
 * ---
 *
 * WHAT REACTIVITY DOES AND DOES NOT REMOVE — worth reading, because this is
 * the honest version of "Glimmer deletes your bookkeeping".
 *
 * The legacy had `linkJobRenderSeq`, bumped on every keystroke and re-checked
 * after every await, guarding a manual `replaceChildren`. Half of that job
 * genuinely disappears here: `{{#each this.results}}` means there is no
 * imperative render to arrive late, so the DOM can no longer be written by a
 * stale continuation.
 *
 * The other half does NOT disappear, and pretending otherwise would ship a
 * bug. Two in-flight *fetches* still race: type "goo", then "google", and if
 * the first response is slower it lands second and overwrites the results with
 * matches for a query the user has already moved past. Autotracking has no
 * opinion about which assignment is newer — it just renders the last one.
 *
 * So `ticket` survives, guarding the ASSIGNMENT rather than the RENDER. Same
 * technique, half the surface, and the remaining half is the half that was
 * always about data rather than DOM.
 */

export type PickerState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

class LinkPickerState {
  @tracked state: PickerState = 'idle';
  @tracked results: JobPost[] = [];
  /**
   * The query `results` were fetched FOR.
   *
   * Rows render only when this equals the live query, which makes "results
   * that do not match the box" structurally impossible rather than merely
   * unlikely. The ticket guard already stops a stale RESPONSE from being
   * assigned; this stops a stale ASSIGNMENT from being displayed — a
   * different failure, and the one actually seen: the box read "ticktok"
   * while the list still showed matches for "tick".
   */
  @tracked resultsQuery: string | null = null;
  @tracked query = '';
  @tracked status = '';
  @tracked statusIsError = false;
  @tracked linkingId: string | null = null;

  /**
   * The post whose apply link a second click would replace. Not a boolean:
   * arming the confirm for one row must not arm it for every row, and the
   * legacy tracked exactly this as `pendingOverwriteId`.
   */
  @tracked pendingOverwriteId: string | null = null;

  private ticket = 0;
  private debounceTimer: number | null = null;

  /**
   * Can this page be linked to anything at all?
   *
   * The same predicate `link()` enforces, so the UI agrees with the behaviour
   * instead of offering an action guaranteed to refuse. On Career Caddy itself
   * there is nothing to link — the page IS the library — and the same is true
   * of `chrome://`, `file://` and private hosts.
   *
   * Hidden rather than disabled-with-a-reason: SendCard already says "You're
   * on Career Caddy itself" right above this, and repeating it in a second
   * card reads as two problems instead of one fact.
   */
  get canLink(): boolean {
    return classifyUrl(page.url).ok;
  }

  /** Debounce, so typing "software engineer" is one search and not seventeen. */
  search(query: string): void {
    this.query = query;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      void this.load(query);
    }, 250);
  }

  async load(query = this.query): Promise<void> {
    const mine = ++this.ticket;

    // A new search invalidates an armed confirm. Otherwise the second click
    // that was meant for one post could land on a different post that happens
    // to occupy the same row after the list changes underneath it.
    this.pendingOverwriteId = null;
    this.status = '';

    if (!session.apiKey) {
      this.state = 'error';
      this.status = 'Not connected.';
      this.statusIsError = true;
      return;
    }

    this.state = 'loading';
    const posts = await searchPosts(session.apiKey, query);
    if (mine !== this.ticket) return; // superseded by a newer keystroke

    if (!posts) {
      this.state = 'error';
      this.status = "Couldn't load your posts — try again.";
      this.statusIsError = true;
      errorLog.record('link', this.status, page.host);
      return;
    }

    this.results = posts;
    this.resultsQuery = query;
    this.state = posts.length ? 'ready' : 'empty';
  }

  /**
   * Do the rows on screen actually answer the query in the box?
   *
   * False while a keystroke is outstanding — the debounce window, the fetch,
   * or anything that leaves the two out of step. Showing rows during that gap
   * is what made a search for "ticktok" display a Labcorp job matching an
   * earlier "tick": every individual step was correct, and the composition
   * still lied.
   */
  get resultsAreCurrent(): boolean {
    return this.resultsQuery === this.query;
  }

  /** True when a click on this row would need a second click to confirm. */
  needsConfirm(post: JobPost): boolean {
    return wouldReplaceApplyUrl(post, page.url) && this.pendingOverwriteId !== post.id;
  }

  async link(post: JobPost): Promise<void> {
    const url = page.url;

    const verdict = classifyUrl(url);
    if (!verdict.ok) {
      this.status = verdict.message;
      this.statusIsError = true;
      return;
    }

    // Replacing an apply link that is already set and different takes two
    // clicks. The first one warns instead of silently clobbering it — this is
    // the only destructive thing the picker can do, and an apply URL is often
    // the only record of where an application actually went.
    if (this.needsConfirm(post)) {
      this.pendingOverwriteId = post.id;
      this.status = 'That post already has an apply link — click again to replace it.';
      this.statusIsError = true;
      return;
    }

    this.pendingOverwriteId = null;
    this.linkingId = post.id;
    this.status = 'Linking…';
    this.statusIsError = false;

    const ok = session.apiKey ? await setApplyUrl(session.apiKey, post.id, url) : false;
    this.linkingId = null;

    if (!ok) {
      // Honest: the server did not take it. The legacy said "linked on this
      // device only" because it still had a local stash to fall back on. This
      // rewrite has no such stash, so there is nothing to soften — the link
      // did not happen, and saying so is the whole point.
      this.status = "Couldn't save the apply link — nothing was linked.";
      this.statusIsError = true;
      errorLog.record('link', this.status, page.host);
      return;
    }

    this.status = '';

    // Adopt the post we just linked, so the panel immediately shows what it
    // knows about this page rather than making the user reload to see it.
    trackedPost.adopt({ ...post, applyUrl: url });
  }

  /** Drop an armed overwrite-confirm without disturbing the results. */
  disarm(): void {
    this.pendingOverwriteId = null;
    if (this.statusIsError) this.status = '';
  }

  reset(): void {
    this.ticket++;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.state = 'idle';
    this.results = [];
    this.resultsQuery = null;
    this.query = '';
    this.status = '';
    this.pendingOverwriteId = null;
  }
}

export const linkPicker = new LinkPickerState();
