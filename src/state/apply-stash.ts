import { KEYS } from './session.ts';
import {
  addToStash,
  clearForPost,
  pickStashMatch,
  pruneStash,
  type ApplyStashEntry,
  type StashMatch,
} from '../domain/apply-stash.ts';
import type { JobPost } from '../domain/job-post.ts';

/**
 * Storage for the apply stash. The rules are in domain/apply-stash.ts and are
 * tested; this file is only chrome.storage I/O and the JobPost reconstruction.
 *
 * Every read prunes, so an expired entry can never reach a caller even if the
 * write that should have dropped it never ran.
 */

const KEY: string = KEYS.pendingApplies;

async function load(): Promise<ApplyStashEntry[]> {
  try {
    const saved = await chrome.storage.local.get([KEY]);
    return pruneStash(saved[KEY], Date.now());
  } catch {
    return [];
  }
}

async function save(list: ApplyStashEntry[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: list });
  } catch {
    /* best-effort cache */
  }
}

/**
 * Remember that an application was tracked against this post, so the panel can
 * still recognise the post's apply page later.
 *
 * Fire-and-forget on purpose: a failed write costs one weaker ladder tier, and
 * must never turn a successful track into a visible error.
 */
export function stashPendingApply(post: JobPost): void {
  if (!post.applyUrl) return;
  void (async () => {
    const entry: ApplyStashEntry = {
      jobPostId: String(post.id),
      applyUrl: post.applyUrl!,
      title: post.title ?? null,
      company: post.company ?? null,
      companyId: post.companyId ?? null,
      link: post.link ?? null,
      ts: Date.now(),
    };
    await save(addToStash(await load(), entry));
  })();
}

/** Forget a post once its application has been resurfaced — the job is done. */
export async function clearStashForPost(jobPostId: string): Promise<void> {
  const list = await load();
  const next = clearForPost(list, jobPostId);
  if (next.length !== list.length) await save(next);
}

/** The best live entry for this page, with its path-agreement score. */
export async function findStashMatch(tabUrl: string): Promise<StashMatch | null> {
  return pickStashMatch(await load(), tabUrl);
}

/**
 * Rebuild a JobPost from a stash entry.
 *
 * Same trade as state/viewed.ts: carrying the display fields makes a hit cost
 * zero server round-trips. `complete` defaults true for the same reason it does
 * there — a cache entry must not be able to make a complete post look
 * incomplete.
 */
export function postFromStash(entry: ApplyStashEntry): JobPost {
  return {
    id: entry.jobPostId,
    title: entry.title ?? '(untitled)',
    company: entry.company,
    companyId: entry.companyId,
    applyUrl: entry.applyUrl,
    link: entry.link,
    topScore: null,
    hasPendingScore: false,
    complete: true,
  };
}
