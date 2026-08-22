// MV3 background. Not persistent on either browser: Chrome terminates the
// service worker after a short idle, Firefox does the same to its event page.
// Anything time-based must therefore go through chrome.alarms, which survives
// termination and wakes the worker back up — setInterval does not.
//
// Deliberately near-empty for this slice. The scrape/score/match polling from
// the 2.x extension lands here next.

/**
 * `declare const` describes a value that exists but is not defined HERE — it
 * is substituted at build time by Vite's `define`. TypeScript needs to be told
 * it exists and what type it has; the compiler emits nothing for this line.
 */
declare const __TARGET__: 'chrome' | 'firefox';

// Chrome only: make the toolbar icon open the popup (the default), NOT the
// panel. We want the popup for "send this page" and the panel opened
// deliberately from it.
//
// This is a build-time branch, not a runtime one. `chrome.sidePanel?.…` with
// optional chaining would be SAFE on Firefox -- it would never throw -- but
// web-ext lint still sees the static reference and reports UNSUPPORTED_API,
// which an AMO reviewer then has to read and dismiss. Because __TARGET__ is
// substituted with a literal, Rollup drops this whole block from the Firefox
// bundle and the warning disappears along with the code.
if (__TARGET__ === 'chrome') {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {
      // Chrome older than 114. Nothing to configure.
    });
  });
}
