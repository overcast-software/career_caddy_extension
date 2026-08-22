// One source of truth, two manifests.
//
// Chrome and Firefox disagree about sidebars in a way that cannot be papered
// over: Chrome uses the `side_panel` key plus a `sidePanel` PERMISSION, and
// Firefox uses `sidebar_action` with no permission at all. Shipping a single
// manifest containing both means every Chrome review sees an unknown
// `sidebar_action` key and every Firefox review sees an unknown `sidePanel`
// permission. Reviewers read warnings. So we emit the right one per target
// instead of emitting a superset and hoping nobody looks.

const VERSION = '3.0.0';

const ICONS = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

const SHARED = {
  manifest_version: 3,
  name: 'Career Caddy Sender',
  version: VERSION,
  description:
    'Send the active job posting to Career Caddy, and answer application questions with your own career data.',
  // activeTab + scripting is the whole story for reading the page: activeTab
  // grants host access only when the user invokes the action, which is why no
  // broad host permission is needed. Adding one triggers re-consent on update.
  permissions: ['activeTab', 'scripting', 'storage', 'notifications', 'alarms'],
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
