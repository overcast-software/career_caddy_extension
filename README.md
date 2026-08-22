# career-caddy-sender (3.x) — Glimmer rewrite

The Career Caddy browser extension, rewritten so its entire UI is **Glimmer
components** — no Ember `Application`, no router, no resolver, no dependency
injection. Chrome/Edge + Firefox, MV3.

Design and rationale: [`GLIMMER-REWRITE.md`](./GLIMMER-REWRITE.md).

This is a submodule of [career_caddy](https://github.com/overcast-software/career_caddy),
mounted at `extension/`. The shipping **2.x** extension still lives in the
`frontend` submodule at `frontend/public/extensions/career-caddy-sender/` and
is untouched by this repo — it remains what users have installed until 3.x
replaces it.

## Build

```bash
npm install
npm run build            # both targets
npm run build:chrome     # → dist/chrome
npm run build:firefox    # → dist/firefox
```

Each build ends with `scripts/csp-gate.mjs`, which fails the build if `eval` or
`new Function` reaches the output. That is not a style rule: MV3 permits only
`'none'`, `'self'` and `'wasm-unsafe-eval'` in `script-src`, so a build
containing either is **rejected at install time**. `ember-source` is clean
apart from `@ember/template-compiler`, which nothing should import — templates
are compiled to wire format at build time.

## Load it

**Chrome/Edge** — `chrome://extensions` → enable *Developer mode* → *Load
unpacked* → select `extension/dist/chrome`.

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on*
→ select `extension/dist/firefox/manifest.json`.

Then: click the toolbar icon → **Open the workbench** → the panel docks to the
side of the window. Click into the page, type in a form, switch tabs. The
uptime counter never resets and the draft stays put — that is the whole
architectural argument, made visible.

## Layout

```
manifest.mjs          one source, two manifests (Chrome side_panel vs Firefox sidebar_action)
vite.config.mjs       ember-source resolver + build-time template compilation
scripts/csp-gate.mjs  the MV3 install-time guard
popup.html            "send this page" — a 320px box, destroyed on blur
panel.html            the workbench — full window height, survives clicks
src/
  popup.ts panel.ts   two renderComponent calls; no app object in either
  components/*.gts    template + class in one file
  lib/panel.ts        the sidePanel / sidebarAction adapter
  background.ts       MV3 worker (non-persistent — use chrome.alarms, not setInterval)
public/icons/         copied verbatim into dist by Vite
```

## Toolchain notes

- **`ember-source` 7.x is required**, not the 6.6 that `frontend/` pins.
  `renderComponent` (RFC #1099) does not exist before 7.x — 6.6's
  `@ember/renderer` exports only `renderSettled`.
- **`@glimmer/component` is a separate npm package** and imports *from*
  ember-source. Everything else under `@ember/*` and `@glimmer/*` resolves into
  `ember-source/dist/prod/packages/` via the resolver in `vite.config.mjs`.
- **Do not `npm install @glimmer/tracking` separately.** It must resolve to
  ember-source's copy; two copies of the validator means reactivity breaks
  silently, which is the worst way for it to break.
- **Templates are not type-checked yet.** Plain `tsc` cannot parse `.gts` —
  `<template>` is not TypeScript syntax. Glint (`@glint/core` +
  `@glint/environment-ember-template-imports`) is what makes a component
  `Signature` checked at the call site rather than merely documented. Worth
  adding early.

## Status

Verified: builds clean on both targets, CSP gate passes, both surfaces render
in Chrome, component composition and `@tracked` reactivity work, and the
Chrome/Firefox manifests contain only their own keys.

**Not yet verified: running as a loaded unpacked extension.** Everything above
was driven over `http://` from a static server, so the real
`chrome-extension://` CSP and the `chrome.sidePanel.open()` call have not been
exercised. That is the next thing to do, and it needs a human at the
`chrome://extensions` page.
