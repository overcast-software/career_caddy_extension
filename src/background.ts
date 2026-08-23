// MV3 background. Not persistent on either browser: Chrome terminates the
// service worker after a short idle, Firefox does the same to its event page.
// Anything time-based must therefore go through chrome.alarms, which survives
// termination and wakes the worker back up — setInterval does not.

/**
 * `declare const` describes a value that exists but is not defined HERE — it
 * is substituted at build time by Vite's `define`. TypeScript needs to be told
 * it exists and what type it has; the compiler emits nothing for this line.
 */
declare const __TARGET__: 'chrome' | 'firefox';

// The toolbar icon opens the panel directly. There is no popup.
//
// These are build-time branches, not runtime ones. `chrome.sidePanel?.…` with
// optional chaining would be SAFE on Firefox — it would never throw — but
// web-ext lint still sees the static reference and reports UNSUPPORTED_API,
// which an AMO reviewer then has to read and dismiss. Because __TARGET__ is
// substituted with a literal, Rollup drops the whole dead branch and the
// warning goes with it.
if (__TARGET__ === 'chrome') {
  // Chrome handles the click here rather than via
  // setPanelBehavior({openPanelOnActionClick: true}), so that both targets
  // share one shape and `onClicked` is ours to extend.
  //
  // BE CLEAR ABOUT WHAT THIS DOES NOT BUY. Handling the click does NOT give
  // the panel page access. Measured 2026-08-22 on a live Greenhouse posting:
  // `activeTab` was held, and `executeScript` still failed with "Cannot
  // access contents of url …". Chrome deliberately never extends activeTab
  // to a side panel — crbug.com/1453437, the reasoning being that a
  // persistently-shown panel makes it "not as evident to the user that they
  // invoke the extension". That is by design, not a defect to wait out.
  //
  // Page access therefore comes from a real granted host permission; see
  // state/access.ts. Firefox needs none of it, which is why the gate is
  // capability-detected rather than branched on target.
  //
  // `onClicked` hands us the tab, so there is no async lookup before
  // `open()` and the user gesture is still live — awaiting a tabs.query
  // first would spend it and Chrome would reject the call.
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    void chrome.sidePanel?.open({ tabId: tab.id }).catch(() => {
      /* Chrome older than 114 */
    });
  });
} else {
  // Firefox has no equivalent switch, so we handle the click ourselves.
  // `onClicked` only fires when there is no default_popup — same precondition
  // as Chrome's, arrived at from the opposite direction.
  //
  // The gesture requirement is satisfied: onClicked IS the user gesture, and
  // we call toggle() synchronously inside it rather than awaiting anything
  // first. Firefox also contributes its own sidebar button from
  // `sidebar_action`, so this is a second door to the same room.
  chrome.action.onClicked.addListener(() => {
    void globalThis.browser?.sidebarAction?.toggle();
  });
}

// ---------------------------------------------------------------------------
// Watching a scrape after the panel closes.
//
// This is the ONE job that genuinely needs a background worker now. While the
// panel is open it polls for itself — it persists across navigation and blur,
// which is the whole reason for the rewrite. The worker exists for the case
// the panel cannot cover: you send a page, close the panel, and want to be
// told when the post is ready.
//
// Everything here is chrome.alarms, never setInterval. Both browsers terminate
// an idle MV3 worker; an interval dies with it and takes the watch with it,
// silently. An alarm survives termination and wakes the worker back up.
// ---------------------------------------------------------------------------

const POLL_PERIOD_MIN = 0.5;
/** ~10 minutes. A scrape that has not finished by then is not going to. */
const MAX_POLLS = 20;
const ALARM_PREFIX = 'cc-scrape-poll-';
const LINKS_KEY = 'ccNotifyLinks';

const ORIGIN = 'https://careercaddy.online';
const TERMINAL = new Set(['completed', 'failed', 'error', 'cancelled']);

interface WatchCtx {
  scrapeId: string;
  url: string;
  polls: number;
}

/**
 * The notification's destination, remembered in storage rather than in a
 * closure: the worker is very likely DEAD between creating the notification
 * and the user clicking it, so a closure would not exist to consult. This is
 * the whole reason the mapping is persisted at all.
 */
async function rememberLink(id: string, url: string): Promise<void> {
  try {
    const saved = await chrome.storage.session.get([LINKS_KEY]);
    const links = (saved[LINKS_KEY] ?? {}) as Record<string, string>;
    links[id] = url;
    await chrome.storage.session.set({ [LINKS_KEY]: links });
  } catch {
    /* the notification still shows; it just will not navigate */
  }
}

async function notify(title: string, message: string, url: string | null): Promise<void> {
  try {
    const id = await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title,
      message,
    });
    if (url && id) await rememberLink(id, url);
  } catch {
    /* notifications can be disabled at the OS level; not an error */
  }
}

chrome.notifications.onClicked.addListener((id) => {
  void (async () => {
    try {
      const saved = await chrome.storage.session.get([LINKS_KEY]);
      const links = (saved[LINKS_KEY] ?? {}) as Record<string, string>;
      const url = links[id];
      if (!url) return;
      delete links[id];
      await chrome.storage.session.set({ [LINKS_KEY]: links });
      await chrome.tabs.create({ url });
      await chrome.notifications.clear(id);
    } catch {
      /* nothing useful to do */
    }
  })();
});

/**
 * As deep as the ids in hand allow (CCEXT-40).
 *
 * A notification that names a specific result and then lands on a LIST makes
 * the user hunt for the thing it just told them about — and this link is the
 * one they actually click, because the notification exists precisely because
 * the panel was closed.
 */
function jobPostUrl(jobPostId: string | null, scoreId: string | null): string | null {
  if (!jobPostId) return null;
  const base = `${ORIGIN}/job-posts/${jobPostId}`;
  return scoreId ? `${base}/scores/${scoreId}` : base;
}

/** The panel asks for a watch; it does NOT hand over the credential. */
chrome.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string; scrapeId?: string; url?: string } | null;
  if (!m || m.type !== 'cc-watch-scrape' || !m.scrapeId) return false;
  const ctx: WatchCtx = { scrapeId: String(m.scrapeId), url: m.url ?? '', polls: 0 };
  void chrome.storage.session
    .set({ [ALARM_PREFIX + ctx.scrapeId]: ctx })
    .then(() =>
      chrome.alarms.create(ALARM_PREFIX + ctx.scrapeId, {
        periodInMinutes: POLL_PERIOD_MIN,
        delayInMinutes: POLL_PERIOD_MIN,
      }),
    )
    .catch(() => {});
  return false;
});

async function stopWatch(scrapeId: string): Promise<void> {
  try {
    await chrome.alarms.clear(ALARM_PREFIX + scrapeId);
    await chrome.storage.session.remove([ALARM_PREFIX + scrapeId]);
  } catch {
    /* nothing to clean */
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  void pollOnce(alarm.name.slice(ALARM_PREFIX.length));
});

async function pollOnce(scrapeId: string): Promise<void> {
  const key = ALARM_PREFIX + scrapeId;

  let ctx: WatchCtx | undefined;
  let apiKey: string | undefined;
  try {
    const session = await chrome.storage.session.get([key]);
    ctx = session[key] as WatchCtx | undefined;
    // Read the credential from storage rather than accepting it in the
    // message that started the watch. Both sides can read the same store, so
    // putting a long-lived API key into a message payload buys nothing and
    // puts it somewhere it does not need to be.
    const local = await chrome.storage.local.get(['ccApiKey']);
    apiKey = local['ccApiKey'] as string | undefined;
  } catch {
    return;
  }

  // Disconnected mid-watch: stop rather than poll unauthenticated forever.
  if (!ctx || !apiKey) {
    await stopWatch(scrapeId);
    return;
  }

  ctx.polls += 1;
  if (ctx.polls > MAX_POLLS) {
    await stopWatch(scrapeId);
    return; // Deliberately silent. "Still working" is not worth an OS alert.
  }
  try {
    await chrome.storage.session.set({ [key]: ctx });
  } catch {
    /* the count is best-effort; MAX_POLLS is a backstop, not a contract */
  }

  let status: string | undefined;
  let jobPostId: string | null = null;
  try {
    const resp = await fetch(
      `${ORIGIN}/api/v1/scrapes/${scrapeId}/?include=job-post`,
      {
        headers: {
          Accept: 'application/vnd.api+json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
    if (!resp.ok) {
      // A single bad response is not terminal — the next alarm retries. Only
      // an auth failure is worth abandoning, since it will not fix itself.
      if (resp.status === 401 || resp.status === 403) await stopWatch(scrapeId);
      return;
    }
    const body = (await resp.json()) as {
      data?: {
        attributes?: { status?: string };
        relationships?: { 'job-post'?: { data?: { id?: string } | null } };
      };
    };
    status = body.data?.attributes?.status;
    const rel = body.data?.relationships?.['job-post']?.data;
    jobPostId = rel?.id ? String(rel.id) : null;
  } catch {
    return; // network blip; the next alarm retries
  }

  if (!status || !TERMINAL.has(status)) return;

  await stopWatch(scrapeId);

  const host = hostOf(ctx.url);
  if (status !== 'completed') {
    await notify(
      'Career Caddy',
      host ? `Couldn't parse the posting from ${host}.` : "Couldn't parse that posting.",
      null,
    );
    return;
  }

  await notify(
    'Career Caddy',
    host ? `Added the posting from ${host}.` : 'Added the posting.',
    jobPostUrl(jobPostId, null),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
