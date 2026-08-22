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
  // One line, no click handler: Chrome wires the action button to the panel
  // itself. It only works because the manifest declares no default_popup —
  // a popup would win and this would silently do nothing.
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {
        // Chrome older than 114. The icon will do nothing; acceptable, since
        // the manifest's minimum is well above that.
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
