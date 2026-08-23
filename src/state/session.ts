import { tracked } from '@glimmer/tracking';
import { request, FRONTEND_ORIGIN, SELF_HOSTS } from '../lib/api.ts';
import type { JsonApiDoc } from '../lib/api.ts';

/**
 * Who you are, and the credential everything else uses.
 *
 * The handshake never asks for a password. It reads the SPA's existing session
 * out of an open careercaddy.online tab, exchanges it for a long-lived `jh_*`
 * API key, and stores only that. Disconnect revokes the key server-side, so a
 * shared machine can be cleaned up from either end.
 */

/**
 * Exported so no module invents its own key string. A raw literal elsewhere
 * silently escapes USER_SCOPED_STORAGE_KEYS below, which is the exact leak
 * that list exists to prevent — state/me.ts did precisely that on its first
 * draft and cached one account's snippets past a disconnect.
 */
export const KEYS = {
  apiKey: 'ccApiKey',
  keyId: 'ccKeyId',
  me: 'ccMe',
  meCache: 'ccMeCache',
  matchApps: 'ccMatchApps',
  trackedPages: 'ccTrackedPages',
  appChecks: 'ccAppChecks',
} as const;

/**
 * Keys wiped on disconnect. This is a `const` array whose element type is
 * checked against the storage-key union, so ADDING a user-scoped key without
 * adding it here is a compile error rather than a silent leak of the previous
 * user's data. The legacy extension's comment records that forgetting this
 * list "was the default"; the type makes forgetting impossible.
 *
 * Device preferences are deliberately absent — ccTheme, ccPalette,
 * ccLayoutMode, ccQuickCopyExpanded. Clearing those on sign-out would reset
 * someone's theme, layout and card state as a side effect of logging out,
 * which is a regression, not tidiness.
 */
export const USER_SCOPED_STORAGE_KEYS: readonly string[] = [
  KEYS.apiKey,
  KEYS.keyId,
  KEYS.me,
  KEYS.meCache,
  'ccExtensionSelectorCache',
  KEYS.trackedPages,
  KEYS.appChecks,
  'ccSentPages',
  KEYS.matchApps,
  'ccAnswerDrafts',
];

export interface Me {
  username: string;
  email: string;
  isStaff: boolean;
}

export type ConnectState = 'unknown' | 'connected' | 'disconnected' | 'connecting';

class SessionState {
  @tracked state: ConnectState = 'unknown';
  @tracked apiKey: string | null = null;
  @tracked keyId: string | null = null;
  @tracked me: Me | null = null;
  @tracked message = '';

  get isConnected(): boolean {
    return this.state === 'connected' && !!this.apiKey;
  }

  /** Read a previously minted key. Called once when the panel opens. */
  async load(): Promise<void> {
    try {
      const saved = await chrome.storage.local.get([KEYS.apiKey, KEYS.keyId, KEYS.me]);
      this.apiKey = (saved[KEYS.apiKey] as string) ?? null;
      this.keyId = (saved[KEYS.keyId] as string) ?? null;
      this.me = (saved[KEYS.me] as Me) ?? null;
      this.state = this.apiKey ? 'connected' : 'disconnected';
    } catch {
      this.state = 'disconnected';
    }
    if (this.isConnected && !this.me) void this.refreshMe();
  }

  /**
   * Connect without a password: find an open Career Caddy tab, read the SPA's
   * ember-simple-auth session out of its localStorage, refresh the access
   * token, and exchange it for an API key.
   *
   * Reading another tab's localStorage requires host access to that tab —
   * which `host_permissions: ["https://careercaddy.online/*"]` grants, and is
   * also why `tabs.query` can see those URLs without the `tabs` permission.
   */
  async connect(): Promise<void> {
    this.state = 'connecting';
    this.message = 'Looking for an open Career Caddy tab…';

    const session = await readSpaSession();
    if (!session?.access) {
      this.state = 'disconnected';
      this.message =
        'No signed-in Career Caddy tab found. Open one, sign in, then connect.';
      return;
    }

    // Refresh proactively: the token cached in localStorage may have expired
    // since that tab last used it. The endpoint is idempotent and cheap.
    let access = session.access;
    if (session.refresh) {
      const refreshed = await request<{ access?: string }>('/api/v1/token/refresh/', {
        method: 'POST',
        plainJson: true,
        body: { refresh: session.refresh },
      });
      if (refreshed.ok && refreshed.data?.access) access = refreshed.data.access;
    }

    this.message = 'Creating an API key…';
    const today = new Date().toISOString().slice(0, 10);
    const minted = await request<JsonApiDoc<{ key?: string }>>('/api/v1/api-keys/', {
      method: 'POST',
      token: access,
      body: {
        data: {
          type: 'api-keys',
          attributes: {
            name: `Career Caddy Sender — ${today}`,
            scopes: ['read', 'write'],
          },
        },
      },
    });

    if (!minted.ok) {
      this.state = 'disconnected';
      this.message = minted.error;
      return;
    }

    const key = minted.data?.data?.attributes?.key;
    const id = minted.data?.data?.id;
    if (!key || !id) {
      this.state = 'disconnected';
      this.message = 'Career Caddy returned a malformed API key.';
      return;
    }

    this.apiKey = key;
    this.keyId = id;
    this.state = 'connected';
    this.message = '';
    await safeSet({ [KEYS.apiKey]: key, [KEYS.keyId]: id });
    await this.refreshMe();
  }

  async refreshMe(): Promise<void> {
    if (!this.apiKey) return;
    const resp = await request<JsonApiDoc<Record<string, unknown>>>('/api/v1/me/', {
      token: this.apiKey,
    });
    if (!resp.ok) {
      // A 401 here means the key was revoked from the other end.
      if (resp.status === 401 || resp.status === 403) await this.forget();
      return;
    }
    const attrs = resp.data?.data?.attributes ?? {};
    this.me = {
      username: String(attrs['username'] ?? ''),
      email: String(attrs['email'] ?? ''),
      isStaff: attrs['is_staff'] === true,
    };
    await safeSet({ [KEYS.me]: this.me });
  }

  /** Revoke server-side, then clear locally. Safe on a shared machine. */
  async disconnect(): Promise<void> {
    if (this.apiKey && this.keyId) {
      // Best effort: if the key is already gone, clearing locally is still right.
      await request(`/api/v1/api-keys/${this.keyId}/revoke/`, {
        method: 'POST',
        token: this.apiKey,
      });
    }
    await this.forget();
  }

  private async forget(): Promise<void> {
    this.apiKey = null;
    this.keyId = null;
    this.me = null;
    this.state = 'disconnected';
    try {
      await chrome.storage.local.remove([...USER_SCOPED_STORAGE_KEYS]);
    } catch {
      /* nothing to clear outside an extension context */
    }
  }

  /** Open the SPA's login page so the SSO read has something to find. */
  openSignIn(): void {
    try {
      void chrome.tabs.create({ url: `${FRONTEND_ORIGIN}/login` });
    } catch {
      /* not in an extension context */
    }
  }
}

interface SpaSession {
  access: string | null;
  refresh: string | null;
  username: string | null;
}

/**
 * INJECTED into a Career Caddy tab. Must stay self-contained — it is
 * serialized and evaluated in the page, so it cannot close over anything in
 * this module. See scripts/injected-gate.mjs.
 */
function readEmberSession(): SpaSession | null {
  const raw = window.localStorage.getItem('ember_simple_auth-session');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const authed = parsed?.authenticated || {};
    return {
      access: authed.access || null,
      refresh: authed.refresh || null,
      username: parsed?.username || null,
    };
  } catch {
    return null;
  }
}

async function readSpaSession(): Promise<SpaSession | null> {
  try {
    const tabs = await chrome.tabs.query({});
    const spa = tabs.find((t) => {
      if (!t.url) return false;
      try {
        return SELF_HOSTS.has(new URL(t.url).hostname.toLowerCase());
      } catch {
        return false;
      }
    });
    if (!spa?.id) return null;
    const [hit] = await chrome.scripting.executeScript({
      target: { tabId: spa.id },
      func: readEmberSession,
    });
    return (hit?.result as SpaSession) ?? null;
  } catch {
    return null;
  }
}

/** chrome.storage throws synchronously when absent — see layout.ts persist(). */
async function safeSet(items: Record<string, unknown>): Promise<void> {
  try {
    await chrome.storage.local.set(items);
  } catch {
    /* not in an extension context */
  }
}

export const session = new SessionState();
