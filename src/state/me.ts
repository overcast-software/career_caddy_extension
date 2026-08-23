import { tracked } from '@glimmer/tracking';
import { request } from '../lib/api.ts';
import { composeQuickCopyItems } from '../domain/quick-copy.ts';
import type { MeAttrs, QuickCopyItem } from '../domain/quick-copy.ts';
import { session, KEYS } from './session.ts';

/**
 * Who you are: quick-copy snippets, and whether you are staff.
 *
 * One request serves both. The legacy fetched `/api/v1/me/` for the staff gate
 * and again for the quick-copy card; they are the same payload, and asking
 * twice meant the two could disagree about the same user within one session.
 *
 * Cached in `chrome.storage.local` and rendered from cache immediately on
 * open, then refreshed in the background. A panel that shows an empty
 * quick-copy list for 400ms every time you open it reads as "my snippets are
 * gone" — the one thing this surface must never suggest.
 */

/**
 * Named from the registry rather than written out, so it is covered by
 * USER_SCOPED_STORAGE_KEYS and wiped on disconnect. A literal here compiles
 * fine and leaks the previous account's snippets to the next one.
 */
const CACHE_KEY: string = KEYS.meCache;
/** Long: this is your own profile, and it changes when you change it. */
const TTL_MS = 24 * 60 * 60 * 1000;

interface Cached {
  fetchedAt: number;
  attrs: MeAttrs;
}

class MeState {
  @tracked attrs: MeAttrs | null = null;
  @tracked loading = false;
  /** Distinguishes "no snippets configured" from "not loaded yet". */
  @tracked loaded = false;

  get items(): QuickCopyItem[] {
    return composeQuickCopyItems(this.attrs);
  }

  get isStaff(): boolean {
    // `=== true`, so an api that omits the field degrades to NOT staff. The
    // fail-safe direction: staff tools stay hidden rather than appearing for
    // someone the server will refuse anyway.
    return this.attrs?.is_staff === true;
  }

  get firstName(): string {
    return (this.attrs?.first_name ?? '').trim();
  }

  async load(): Promise<void> {
    if (!session.apiKey) {
      this.attrs = null;
      this.loaded = false;
      return;
    }

    // Cache first, so the list is on screen before the network is consulted.
    try {
      const saved = await chrome.storage.local.get([CACHE_KEY]);
      const cached = saved[CACHE_KEY] as Cached | undefined;
      if (cached?.attrs && Date.now() - cached.fetchedAt < TTL_MS) {
        this.attrs = cached.attrs;
        this.loaded = true;
      }
    } catch {
      /* storage unavailable — fall through to the network */
    }

    this.loading = true;
    const resp = await request<{ data?: { attributes?: MeAttrs } }>('/api/v1/me/', {
      token: session.apiKey,
      timeoutMs: 8000,
    });
    this.loading = false;

    // A failed refresh must NOT clear a good cache. Your snippets vanishing
    // because the network blipped is worse than showing yesterday's copy of
    // data you wrote yourself.
    if (!resp.ok) return;

    const attrs = resp.data?.data?.attributes;
    if (!attrs) return;

    this.attrs = attrs;
    this.loaded = true;
    try {
      await chrome.storage.local.set({
        [CACHE_KEY]: { fetchedAt: Date.now(), attrs } satisfies Cached,
      });
    } catch {
      /* a missed cache write costs one refetch */
    }
  }

  /** On disconnect. Leaving another account's snippets cached is not okay. */
  async clear(): Promise<void> {
    this.attrs = null;
    this.loaded = false;
    try {
      await chrome.storage.local.remove([CACHE_KEY]);
    } catch {
      /* nothing to do */
    }
  }
}

export const me = new MeState();
