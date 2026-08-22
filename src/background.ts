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
  // DO NOT go back to setPanelBehavior({openPanelOnActionClick: true}).
  //
  // It looks like the tidier option — one line, no click handler, Chrome
  // wires the button to the panel for you — and it silently costs the
  // extension all page access.
  //
  // `activeTab` is granted when the user INVOKES THE EXTENSION'S ACTION. With
  // openPanelOnActionClick, Chrome consumes the click itself to open a panel;
  // `action.onClicked` never fires, the action is never invoked as far as
  // Chrome is concerned, and no grant is issued. Measured 2026-08-22: every
  // executeScript failed with "Cannot access contents of the page", and
  // tabs.query could not even return a URL — `tab.url` came back undefined,
  // because without host access Chrome will not tell you where a tab is.
  //
  // Firefox was green on the identical build for exactly this reason: its
  // path goes through our own onClicked handler below, so the action really
  // is invoked.
  //
  // So Chrome handles the click too. `onClicked` hands us the tab, so there
  // is no async lookup before `open()` and the user gesture is still live —
  // awaiting a tabs.query first would spend it and Chrome would reject the
  // call.
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
