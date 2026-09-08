# career-caddy-sender (2.x) — Glimmer rewrite

The Career Caddy browser extension, rewritten so its entire UI is **Glimmer
components** — no Ember `Application`, no router, no resolver, no dependency
injection. Chrome/Edge + Firefox, MV3.

Design and rationale: [`GLIMMER-REWRITE.md`](./GLIMMER-REWRITE.md).

This is a submodule of [career_caddy](https://github.com/overcast-software/career_caddy),
mounted at `extension/`. The **legacy** extension — vanilla JS, popup-based —
was removed from the `frontend` submodule on 2026-08-22 (frontend `95aad96`,
*"drop the extension, it lives in career_caddy_extension now"*), so
`frontend/public/extensions/` is empty at HEAD. To read the legacy source,
which `PORTING.md` still cites by line number, go through git:

```bash
git -C ../frontend show 95aad96^:public/extensions/career-caddy-sender/popup.js
```

That commit's parent is the **authoritative** copy — 6,564 lines. A ~1,100-line
stale copy exists in an old worktree and has already cost one session; check
the line count before trusting a copy.

> **The display name is "Career Caddy"** (CCEXT-100). Three identifiers keep
> the old slug deliberately: the gecko id `career-caddy-sender@careercaddy.online`
> (change it and AMO treats the upload as a different add-on), the AMO listing
> slug, and this package's npm `name`.

> **A note on version numbers, because they collide.** The legacy extension
> published **1.1.0** (Chrome) and **1.1.1** (Firefox) in May 2026 and nothing
> since; its local build markers nonetheless ran up to *2.3.0*, none of which
> ever left a laptop. This rewrite starts at **2.0.0** — a major bump over what
> was actually published, chosen to mark the rewrite rather than to clear those
> throwaway markers. So a number here can be *lower* than a legacy number and
> still be newer. The two lines live in different repos with different
> extension IDs, so nothing resolves them against each other; only the stores'
> view matters, and the stores have only ever seen 1.1.x.

## Build

```bash
npm install
npm run build            # both targets
npm run build:chrome     # → dist/chrome
npm run build:firefox    # → dist/firefox
```

```bash
npm test                 # vitest over src/domain (193 tests)
npm run typecheck        # glint — templates included
```

**A build runs four gates, not one.** In order:

| gate | what it refuses |
|---|---|
| `gate:layering` | a value import in `injected/`, impurity in `domain/`, a component touching `chrome.*`/`fetch`, `world: 'MAIN'` |
| `typecheck` (glint) | type errors, **including inside `<template>`** |
| `gate` (`csp-gate.mjs`) | `eval` / `new Function` in the output — per target |
| `gate:injected` | an injected `ccXxx` function referencing module scope in the **built, minified** output — per target |

The CSP one is not a style rule: MV3 permits only `'none'`, `'self'` and
`'wasm-unsafe-eval'` in `script-src`, so a build containing either is
**rejected at install time** — the failure mode is "nobody can install it".
`ember-source` is clean apart from `@ember/template-compiler`, which nothing
should import; templates are compiled to wire format at build time.

The injected gate exists because this repo added a bundler to code whose
correctness depends on the absence of one. `esbuild`'s `keepNames` rewrites a
named function into `__name(fn, "original")` — a module-scope reference the
page does not have — so the whole function throws on injection. The legacy
extension was structurally immune to that, having had no build step.

## Load it

**Chrome/Edge** — `chrome://extensions` → enable *Developer mode* → *Load
unpacked* → select `extension/dist/chrome`.

**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on*
→ select `extension/dist/firefox/manifest.json`.

Then click the toolbar icon — the panel docks to the side of the window. Click
into the page, type in a form, switch tabs. The uptime counter never resets and
the draft stays put; that is the whole architectural argument, made visible.

## One surface, not two

There is **no popup**. An earlier revision had one for "send this page" and a
panel for everything else, which made *open the workbench* a toll booth in
front of the feature. The toolbar icon opens the panel directly:

- **Chrome** — `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`,
  set once on install.
- **Firefox** — `action.onClicked` → `sidebarAction.toggle()`. Firefox also
  contributes its own sidebar button, so there are two doors to the same room.

Both depend on the manifest declaring **no `default_popup`**. A popup would win
and the panel would never open.

## Layout

The directories are **layers**, and `scripts/layering-gate.mjs` fails the build
on them rather than merely describing them. Read that file first; it is ~130
lines and it is the architecture.

```
manifest.mjs          one source, two manifests (Chrome side_panel vs Firefox sidebar_action)
vite.config.mjs       ember-source resolver + build-time template compilation
scripts/              the four gates (layering, csp, injected) + the build-no bump
panel.html            the only UI surface — full window height, survives clicks
src/
  panel.ts            the whole bootstrap: one renderComponent call, no app object
  background.ts       MV3 worker (non-persistent — use chrome.alarms, not setInterval)
  injected/           SEAM: serialized into the page by executeScript. import TYPE only.
  platform/           where a COMPONENT's chrome.* access is wrapped
  domain/             PURE — no chrome, no DOM, no fetch. The only layer with tests.
  data/               the only place fetch / the api client appears
  state/              the only place storage is written; where the behaviour lives
  components/*.gts    render only. template + class in one file.
  lib/api.ts          the HTTP client — one place, not ~28 header triples
  types/webext.d.ts   ambient types for what @types/chrome does not cover
public/icons/         copied verbatim into dist by Vite
```

`domain/`'s purity is load-bearing rather than tidy: vitest runs it with
`environment: node` and no browser shims, so an impure module there does not
fail a style rule — it fails to run.

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
- **Templates ARE type-checked**, by Glint (`@glint/core` +
  `@glint/environment-ember-template-imports`), wired into `npm run build` as
  `typecheck` and green. Plain `tsc` cannot parse `.gts` — `<template>` is not
  TypeScript syntax — so without Glint a component `Signature` is documentation
  rather than a check.

## Status

**The port is code-complete** — 115 of the legacy's 116 real functions are
resolved, with one (`importPaletteFromActiveTab`) deferred by choice. Per-
function detail, including what was deliberately dropped and why, is in
[`PORTING.md`](./PORTING.md); the api boundary is in
[`CONTRACTS.md`](./CONTRACTS.md).

Green: four gates on both targets, glint clean, 193 domain tests.

**Firefox has been exercised end to end** as a loaded add-on — sidebar →
panel → `executeScript` → painting into a live third-party page (confirmed
2026-08-25, once CCEXT-95 fixed an `adoptedStyleSheets` Xray throw that meant
nothing was drawn at all).

**Chrome has not.** `chrome.sidePanel.open()` and the real
`chrome-extension://` CSP have never run under an unpacked Chrome load —
everything else was driven over `http://` from a static server. Two further
items are gates-green and unit-tested but have never run for real:

- the background-worker → panel announcement channel (CCEXT-96/97), against an
  actual send with the panel open;
- CCEXT-45's acceptance criteria — generate, refine twice, insert into a
  React-backed textarea on a real Greenhouse form.

Each needs a human at a browser, and none of it is a code task.
