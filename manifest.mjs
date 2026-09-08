// One source of truth, two manifests.
//
// Chrome and Firefox disagree about sidebars in a way that cannot be papered
// over: Chrome uses the `side_panel` key plus a `sidePanel` PERMISSION, and
// Firefox uses `sidebar_action` with no permission at all. Shipping a single
// manifest containing both means every Chrome review sees an unknown
// `sidebar_action` key and every Firefox review sees an unknown `sidePanel`
// permission. Reviewers read warnings. So we emit the right one per target
// instead of emitting a superset and hoping nobody looks.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PKG_VERSION = require('./package.json').version;

/**
 * ONE version, not two. package.json is the source of truth and the manifest
 * follows it -- `npm version` bumps package.json, and a hand-maintained copy
 * here would drift silently, surfacing at store-upload time when the store
 * rejects a version it has already seen.
 *
 * EXCEPT during local development, where the patch is replaced by a build
 * counter so `chrome://extensions` visibly changes on every reload. That card
 * is where "did my code update?" actually gets asked, and the manifest version
 * is the only thing on it. A stable version there has already cost one
 * debugging cycle, reading a live fix as a failed reload.
 *
 * CI is excluded: a store build must be reproducible, and it cannot depend on
 * an untracked counter sitting on one laptop. `CI=true` is set by GitHub
 * Actions automatically, so this needs no thought at release time.
 */
function resolveVersion() {
  if (process.env['CI'] || process.env['CC_RELEASE']) return PKG_VERSION;
  try {
    const n = parseInt(
      readFileSync(new URL('./.build-no', import.meta.url), 'utf8').trim(),
      10,
    );
    if (!Number.isFinite(n)) return PKG_VERSION;
    const [major, minor] = PKG_VERSION.split('.');
    return `${major}.${minor}.${n}`;
  } catch {
    return PKG_VERSION;
  }
}

const VERSION = resolveVersion();

const ICONS = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

const SHARED = {
  manifest_version: 3,
  // DISPLAY NAME ONLY. "Sender" described a popup whose whole job was one
  // button; the panel sends, tracks, scores, matches applications, answers
  // form questions and holds quick copy, so the old name advertised the
  // smallest of six things it does (CCEXT-100).
  //
  // THREE IDENTIFIERS DELIBERATELY KEEP THE OLD SPELLING, and none of them is
  // an oversight — Doug's call, 2026-08-25: "keep the slug, just rename the
  // display title."
  //
  //   - the gecko `id` below. It IS the add-on's identity to Firefox; change
  //     it and AMO treats the upload as a different add-on entirely.
  //   - the AMO listing slug, addons.mozilla.org/…/career-caddy-sender/. It
  //     does not follow the display name and every existing link dies with it.
  //   - package.json's npm-safe `name`, which is what the built artifact
  //     filenames and RELEASING.md are written against.
  //
  // So the user-visible string moves and nothing addressable does.
  name: 'Career Caddy',
  version: VERSION,
  description:
    'Send the active job posting to Career Caddy, and answer application questions with your own career data.',
  // activeTab + scripting is the whole story for reading the page: activeTab
  // grants host access only when the user invokes the action, which is why no
  // broad host permission is needed. Adding one triggers re-consent on update.
  permissions: ['activeTab', 'scripting', 'storage', 'notifications', 'alarms'],

  // Carried over from 2.3.0. Dropping it silently disabled the signal
  // ladder's T1 (opener tab) and T2 (open-tabs scan) tiers with no way for
  // the user to re-enable them. Optional, so it costs nothing at install.
  optional_permissions: ['tabs'],

  // ─── THE activeTab PROBLEM ───────────────────────────────────────────────
  // `activeTab` grants host access to ONE tab, at the moment the user invokes
  // the action, and the grant is REVOKED when that tab navigates. That is
  // sufficient for a popup, which dies almost immediately anyway.
  //
  // A side panel is the opposite: it is open for minutes, across tab switches
  // and navigations, and every capability worth having goes through
  // scripting.executeScript into whatever tab the user is now looking at. So
  // the grant this extension has relied on since 1.x expires under exactly the
  // conditions the panel exists to create — and it fails LATE and in disguise,
  // reading as "the selectors didn't match this site".
  //
  // Re-clicking the action does not renew it either: with
  // openPanelOnActionClick the click toggles the panel shut.
  //
  // The fix is a durable per-origin grant the user opts into from inside the
  // panel, via permissions.request({origins:[...]}). Optional, so the install
  // screen stays clean and nobody is asked for <all_urls> up front.
  //
  // Declared now so the phase-0 matrix can actually test the "with a granted
  // origin" row. Whether the panel ASKS for it is a UX decision that the
  // matrix result should drive — see RELEASING.md / GLIMMER-REWRITE.md.
  optional_host_permissions: ['https://*/*'],

  host_permissions: ['https://careercaddy.online/*'],
  icons: ICONS,
  // NO default_popup. Declaring one makes the toolbar icon open the popup and
  // nothing else -- on Chrome it even overrides openPanelOnActionClick. With
  // it absent the click reaches background.js, which opens the panel.
  //
  // This is the whole extension now: one surface, always the panel. The
  // earlier popup-plus-panel split made "open the workbench" a step you had to
  // take before doing anything, which is a toll booth in front of the feature.
  action: {
    default_title: 'Career Caddy',
    default_icon: ICONS,
  },
};

/** @param {'chrome' | 'firefox'} target */
export function buildManifest(target) {
  if (target === 'firefox') {
    return {
      ...SHARED,
      // Firefox's sidebar needs no permission — declaring the panel IS the
      // request. It also opens by default on install, which Chrome's does not.
      sidebar_action: {
        default_panel: 'panel.html',
        default_title: 'Career Caddy',
        default_icon: ICONS,
      },
      // MV3 on Firefox is an event page, not a service worker.
      background: { scripts: ['background.js'], type: 'module' },
      browser_specific_settings: {
        gecko: {
          id: 'career-caddy-sender@careercaddy.online',
          // 140, not 128. `data_collection_permissions` landed in Firefox 140
          // (142 on Android), and web-ext lint flags the mismatch: declaring a
          // key your stated minimum cannot understand means users on 128-139
          // silently get no data-collection disclosure at all. The 2.x
          // manifest carries this same mismatch -- it is inherited, not new.
          strict_min_version: '140.0',
          data_collection_permissions: {
            required: ['websiteContent', 'personallyIdentifyingInfo', 'authenticationInfo'],
          },
        },
      },
    };
  }

  return {
    ...SHARED,
    permissions: [...SHARED.permissions, 'sidePanel'],
    side_panel: { default_path: 'panel.html' },
    background: { service_worker: 'background.js', type: 'module' },
  };
}
