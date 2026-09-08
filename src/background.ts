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
const SCORE_PREFIX = 'cc-score-poll-';
const LINKS_KEY = 'ccNotifyLinks';

const ORIGIN = 'https://careercaddy.online';
const TERMINAL = new Set(['completed', 'failed', 'error', 'cancelled']);

interface WatchCtx {
  scrapeId: string;
  url: string;
  polls: number;
  /**
   * Scoring is the worker's job on the fast path, not the server's.
   * `/scrapes/from-text/` accepts an `auto_score` flag; the extension-direct
   * POST to `/scrapes/` does NOT — it is not a parameter that endpoint has.
   * So the checkbox was silently doing nothing for every send that took the
   * fast path, which is every send with readable text. The worker closes that
   * by starting the score itself once the post exists.
   */
  autoScore: boolean;
}

interface ScoreCtx {
  scoreId: string;
  jobPostId: string;
  title: string;
  polls: number;
  /**
   * The page the whole chain started on, carried through from `WatchCtx` for
   * one reason: the panel has to know whether an announcement is about the tab
   * it is currently showing. Without it a score finishing for the Toptal
   * posting would clear the send status on whatever page the user had moved to
   * (CCEXT-33). Not used for anything else here.
   */
  url: string;
}

/**
 * Tell the panel, if one is listening.
 *
 * ── EVERY TERMINAL EXIT CALLS THIS, INCLUDING THE ONES THAT GIVE UP ────────
 *
 * That is a hard rule now rather than a nicety. The send button stays disabled
 * while a watch is outstanding (CCEXT-97), so a path that stops watching
 * without announcing does not merely fail to update the panel — it leaves a
 * dead control until the user navigates. Before CCEXT-96 the give-up paths
 * were deliberately silent, with the reasoning that "still working" is not
 * worth an OS alert. That reasoning still holds for `notify()`; it does not
 * hold here, because this costs the user nothing and its absence costs them a
 * button.
 *
 * ── WHY THE REJECTION IS SWALLOWED ─────────────────────────────────────────
 *
 * With no panel open there is no receiver and `sendMessage` rejects with
 * "Could not establish connection". That is the NORMAL case — the worker
 * exists precisely for when the panel is closed — so an unhandled rejection
 * here would fill the worker's console with noise on the happy path. It is
 * genuinely nothing to act on: the panel re-derives everything on boot.
 */
function announce(url: string, phase: string, jobPostId: string | null): void {
  try {
    void chrome.runtime
      .sendMessage({ type: 'cc-scrape-progress', url, phase, jobPostId })
      .catch(() => {});
  } catch {
    /* older shapes throw synchronously instead of rejecting */
  }
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

/**
 * The panel asks for a watch; it does NOT hand over the credential.
 *
 * ── THE ACK IS NOT COURTESY ────────────────────────────────────────────────
 *
 * `sendResponse` is called synchronously, and the panel waits for it. That is
 * load-bearing as of CCEXT-97: the send button now stays disabled until this
 * watch announces a result, so the panel has to know the watch actually
 * EXISTS before it commits to waiting on one. A handoff that quietly went
 * nowhere would otherwise leave a dead button until the user navigated.
 *
 * It is answered explicitly rather than left to resolve on its own because
 * the no-listener and listener-declined-to-answer cases are not reliably
 * distinguishable from the sender's side across both browsers. An explicit
 * ack removes the question instead of betting on it.
 *
 * Answered BEFORE the storage write, deliberately. The ack means "this worker
 * received it and is starting a watch", which is true at this point and is
 * what the panel is asking. Waiting for the alarm to be created would mean
 * returning true and holding the channel open, and a worker that is
 * terminated mid-write would then hang the panel rather than reject it.
 */
chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as
    | { type?: string; scrapeId?: string; url?: string; autoScore?: boolean }
    | null;
  if (!m || m.type !== 'cc-watch-scrape' || !m.scrapeId) return false;
  const ctx: WatchCtx = {
    scrapeId: String(m.scrapeId),
    url: m.url ?? '',
    polls: 0,
    autoScore: m.autoScore === true,
  };
  sendResponse({ watching: true });
  void chrome.storage.session
    .set({ [ALARM_PREFIX + ctx.scrapeId]: ctx })
    .then(() =>
      chrome.alarms.create(ALARM_PREFIX + ctx.scrapeId, {
        periodInMinutes: POLL_PERIOD_MIN,
        delayInMinutes: POLL_PERIOD_MIN,
      }),
    )
    .catch(() => {
      // The watch could not be armed after we said it would be. Tell the panel
      // so it stops waiting — this is the one path where the ack was honest
      // when sent and wrong a moment later.
      announce(ctx.url, 'gave-up', null);
    });
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
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    void pollOnce(alarm.name.slice(ALARM_PREFIX.length));
  } else if (alarm.name.startsWith(SCORE_PREFIX)) {
    void pollScore(alarm.name.slice(SCORE_PREFIX.length));
  }
});

async function apiKey(): Promise<string | undefined> {
  try {
    const local = await chrome.storage.local.get(['ccApiKey']);
    return local['ccApiKey'] as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start a score and begin watching it. Returns false if it could not start,
 * so the caller can fall back to announcing the post on its own rather than
 * leaving the user with no notification at all.
 */
async function beginScore(jobPostId: string, title: string, url: string): Promise<boolean> {
  const key = await apiKey();
  if (!key) return false;
  try {
    const resp = await fetch(`${ORIGIN}/api/v1/scores/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        data: {
          type: 'scores',
          relationships: {
            'job-post': { data: { type: 'job-posts', id: String(jobPostId) } },
          },
        },
      }),
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { data?: { id?: string } };
    const scoreId = body.data?.id ? String(body.data.id) : '';
    if (!scoreId) return false;

    const ctx: ScoreCtx = { scoreId, jobPostId, title, polls: 0, url };
    await chrome.storage.session.set({ [SCORE_PREFIX + scoreId]: ctx });
    await chrome.alarms.create(SCORE_PREFIX + scoreId, {
      periodInMinutes: POLL_PERIOD_MIN,
      delayInMinutes: POLL_PERIOD_MIN,
    });
    return true;
  } catch {
    return false;
  }
}

async function pollScore(scoreId: string): Promise<void> {
  const key = SCORE_PREFIX + scoreId;
  let ctx: ScoreCtx | undefined;
  try {
    const session = await chrome.storage.session.get([key]);
    ctx = session[key] as ScoreCtx | undefined;
  } catch {
    return;
  }
  const token = await apiKey();
  if (!ctx || !token) {
    await stopAlarm(key);
    // The POST already succeeded, so the post is in the library even though
    // the score is now unwatched — `done`, not `gave-up`, and the panel gets
    // to swap in the tracked card. With no ctx there is no url to scope it to;
    // '' still reaches the workbench's page-agnostic listener.
    announce(ctx?.url ?? '', 'done', ctx?.jobPostId ?? null);
    return;
  }

  ctx.polls += 1;
  if (ctx.polls > MAX_POLLS) {
    await stopAlarm(key);
    announce(ctx.url, 'done', ctx.jobPostId);
    return;
  }
  try {
    await chrome.storage.session.set({ [key]: ctx });
  } catch {
    /* best-effort */
  }

  let status: string | undefined;
  let value: number | null = null;
  try {
    const resp = await fetch(`${ORIGIN}/api/v1/scores/${scoreId}/`, {
      headers: {
        Accept: 'application/vnd.api+json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        await stopAlarm(key);
        announce(ctx.url, 'done', ctx.jobPostId);
      }
      return;
    }
    const body = (await resp.json()) as {
      data?: { attributes?: { status?: string; score?: number | null } };
    };
    status = body.data?.attributes?.status;
    const raw = body.data?.attributes?.score;
    value = typeof raw === 'number' ? raw : null;
  } catch {
    return;
  }

  if (status !== 'completed' && status !== 'failed') return;
  await stopAlarm(key);

  // Both outcomes are `done` from the panel's point of view, and deliberately
  // so: the JobPost exists either way, which is what the tracked card renders.
  // A failed SCORE is not a failed send, and collapsing the two would put an
  // error on a post that is sitting there perfectly fine.
  announce(ctx.url, 'done', ctx.jobPostId);

  // As deep as the ids allow — straight to THIS score, not the scores list.
  const url = jobPostUrl(ctx.jobPostId, scoreId);
  if (status === 'failed') {
    await notify('Career Caddy — added ✓ (score failed)', ctx.title, jobPostUrl(ctx.jobPostId, null));
    return;
  }
  const pct = value === null ? '' : ` ${value <= 1 ? Math.round(value * 100) : Math.round(value)}%`;
  await notify(`Career Caddy — scored${pct} ✓`, ctx.title, url);
}

async function stopAlarm(key: string): Promise<void> {
  try {
    await chrome.alarms.clear(key);
    await chrome.storage.session.remove([key]);
  } catch {
    /* nothing to clean */
  }
}

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
    announce(ctx?.url ?? '', 'gave-up', null);
    return;
  }

  ctx.polls += 1;
  if (ctx.polls > MAX_POLLS) {
    await stopWatch(scrapeId);
    // Still deliberately silent as far as the OS is concerned — "still
    // working" is not worth an alert. The PANEL is a different audience: it
    // has a disabled button waiting on this, and telling it we stopped
    // looking costs nothing and un-sticks the UI.
    announce(ctx.url, 'gave-up', null);
    return;
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
      if (resp.status === 401 || resp.status === 403) {
        await stopWatch(scrapeId);
        announce(ctx.url, 'gave-up', null);
      }
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
    announce(ctx.url, 'failed', null);
    await notify(
      'Career Caddy',
      host ? `Couldn't parse the posting from ${host}.` : "Couldn't parse that posting.",
      null,
    );
    return;
  }

  const title = host ? `Added the posting from ${host}.` : 'Added the posting.';

  // Two notifications, matching the rhythm the legacy established and the one
  // Doug expects: "added" now, "scored" when the score lands. If scoring
  // cannot start, say "added" and stop — silence would be worse.
  if (ctx.autoScore && jobPostId) {
    await notify('Career Caddy — added ✓', title, jobPostUrl(jobPostId, null));
    const started = await beginScore(jobPostId, title, ctx.url);
    // ANNOUNCED AFTER the attempt, not before, because the two outcomes are
    // different phases: a started score leaves the panel watching, a failed
    // start is the end of the line. Announcing `scoring` up front and then
    // having to retract it would put the panel through a state it was never
    // really in.
    announce(ctx.url, started ? 'scoring' : 'done', jobPostId);
    if (!started) {
      await notify('Career Caddy — added ✓ (could not start scoring)', title, jobPostUrl(jobPostId, null));
    }
    return;
  }

  announce(ctx.url, 'done', jobPostId);
  await notify('Career Caddy — added ✓', title, jobPostUrl(jobPostId, null));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
