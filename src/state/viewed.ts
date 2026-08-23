import { KEYS } from './session.ts';
import type { JobPost } from '../domain/job-post.ts';

/**
 * The recently-viewed job posts — the ladder's T6 trail.
 *
 * "You looked at this posting a moment ago, and now you are on an ATS form."
 * That is the apply-flow signature, and it is the last tier the ladder tries
 * before giving up.
 *
 * PORTED, not dropped — and my first guess in CCEXT-52 was that the page-stash
 * cluster was popup scaffolding. It is not. This survives the popup→panel move
 * for the same reason state/tracked.ts's adoption memory does: the panel
 * removes the need to survive being DESTROYED, it does not remove the need to
 * remember something across a navigation the user made minutes ago.
 *
 * Newest first, deduped by id, capped at 5, 30-minute TTL — all four from the
 * legacy, and the TTL is the load-bearing one. A trail without expiry would
 * offer a post you looked at this morning as the answer to an application form
 * you opened this afternoon.
 */

const KEY: string = KEYS.viewedPosts;
const MAX = 5;
const TTL_MS = 30 * 60 * 1000;

/** Only the fields the ladder's evidence rules read. */
interface ViewedEntry {
  id: string;
  title: string | null;
  company: string | null;
  companyId: string | null;
  link: string | null;
  applyUrl: string | null;
  ts: number;
}

/** Fire-and-forget: a missed write costs one weaker T6, never a failed action. */
export function rememberViewed(post: JobPost): void {
  void (async () => {
    try {
      const saved = await chrome.storage.local.get([KEY]);
      const list = Array.isArray(saved[KEY]) ? (saved[KEY] as ViewedEntry[]) : [];
      const entry: ViewedEntry = {
        id: String(post.id),
        title: post.title ?? null,
        company: post.company ?? null,
        companyId: post.companyId ?? null,
        link: post.link ?? null,
        applyUrl: post.applyUrl ?? null,
        ts: Date.now(),
      };
      // Dedupe by id and re-add at the front, so re-viewing refreshes both the
      // position and the timestamp rather than accumulating duplicates.
      const next = [entry, ...list.filter((r) => String(r.id) !== entry.id)];
      await chrome.storage.local.set({ [KEY]: next.slice(0, MAX) });
    } catch {
      /* best-effort cache */
    }
  })();
}

/** Live entries, newest first. Expired ones are filtered on READ, not on write. */
export async function loadViewed(): Promise<JobPost[]> {
  try {
    const saved = await chrome.storage.local.get([KEY]);
    const raw = saved[KEY];
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    return (raw as ViewedEntry[])
      .filter((r) => r && r.id && r.ts && now - r.ts <= TTL_MS)
      .map((r) => ({
        id: r.id,
        title: r.title ?? '(untitled)',
        company: r.company,
        companyId: r.companyId,
        applyUrl: r.applyUrl,
        link: r.link,
        topScore: null,
        hasPendingScore: false,
        // Unknown from a trail entry, and `true` is the safe default — the
        // same rule domain/job-post.ts applies, so an old cache entry cannot
        // make a complete post look incomplete.
        complete: true,
      }));
  } catch {
    return [];
  }
}
