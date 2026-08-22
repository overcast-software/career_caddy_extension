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
