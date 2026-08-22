# ccsender → Glimmer: architecture

**Status:** design, not started. Written 2026-08-22.
**Goal:** rewrite the extension's UI as Glimmer components — as a working,
shipped, public example of Glimmer used outside an Ember app.

The current `popup.js` is 6,564 lines of vanilla DOM manipulation and it is
*good* code — the comments in it are the best documentation this project has.
This is not a rescue. It is a rewrite for a different reason: to show the
community something that does not currently exist anywhere.

---

## 1. The thing you have to know first

**Standalone Glimmer is archived.** Verified against the repos, not a blog post:

| | |
|---|---|
| `glimmerjs/glimmer-vm` | **archived**, last push 2026-01-06 — merged into `emberjs/ember.js` |
| `glimmerjs/glimmer.js` (GlimmerX / standalone) | **archived**, untouched since Oct 2024 |
| `@glimmer/component` | still published (2.1.1, Apr 2026) — but bugs route to `emberjs/ember.js` |

So "Glimmer, not Ember" in 2026 is alive as a **programming model** and dead as
a **distribution**. You write pure Glimmer — `.gts` components, `@tracked`, no
Application, no router, no resolver, no DI, no ember-cli — but the npm package
that vendors the renderer is `ember-source`. There is no smaller thing to
install anymore.

**This changes the pitch, and the honest pitch is the stronger one.** "Look,
standalone Glimmer" invites "that's been archived since January." What nobody
has, and what this would be:

> A real, shipped, cross-browser MV3 extension whose entire UI is Glimmer
> components — no router, no dependency injection, no framework application
> object — with the reactivity and the data layer both working outside Ember.

---

## 2. Spike results — this is measured, not estimated

A working `.gts` component was built and run before this document was written.
Numbers are from that build.

| Check | Result | How |
|---|---|---|
| `.gts` (TypeScript + `<template>`) compiles under Vite | ✅ | build |
| `renderComponent` mounts with **no** Ember app, no owner | ✅ | headless + Chrome |
| `@args` flow in; getters compute | ✅ | rendered DOM |
| `@tracked` mutation **outside a user event** re-renders | ✅ `count` 0 → 42, `doubled` → 84 | headless, timer-driven |
| `{{on "click"}}` → real DOM event → runloop → re-render | ✅ `Clicks: 2 (doubled: 4)` | real Chrome, real clicks |
| Bundle | **168 kB raw / 54 kB gzip** | build |
| `eval` / `new Function` in output | **none** | grep |
| Runtime template compiler in output | **absent** | grep |

Both reactivity paths matter and they are different code paths: the timer case
proves autotracking schedules its own re-render with no event to ride on; the
click case proves the modifier + event + runloop path. Both work standalone.

54 kB gzip puts Glimmer between Vue 3 runtime-only (~22 kB) and React + ReactDOM
(~45 kB) — heavier than Vue, comparable to React, entirely acceptable for a
side panel. It is *not* nothing for a popup that must feel instant, which is one
reason the popup stays minimal (§4).

Spike lives at `scratchpad/glimmer-spike` (ephemeral — recreate from §5 if gone).

### The API that makes it work, and the version trap

```ts
import { renderComponent } from '@ember/renderer';

renderComponent(Counter, {
  into: document.getElementById('root')!,
  args: { start: 0, label: 'Clicks' },
});
```

`owner` is **optional**. No `Application`, no router, no resolver.

⚠️ **`renderComponent` does not exist in ember-source 6.6.0**, which is what
`frontend/` pins today. I checked both tarballs: 6.6.0's `@ember/renderer`
exports only `renderSettled`. It ships in **7.x**. The extension needs its own
`package.json` on `ember-source@^7.2` — which is fine, and is one more reason
the extension wants to be its own submodule.

---

## 3. The MV3 constraint that decides shippability

I grepped `ember-source@7.2.0`'s production dist:

- `@glimmer/*` runtime packages — **clean**, zero `eval` / `new Function`.
- `@ember/template-compiler/*` — **9 hits**, including `new Function()` at its core.

MV3 permits only `'none'`, `'self'`, `'wasm-unsafe-eval'` in `script-src`. You
cannot add `unsafe-eval`; Chrome rejects at install time. Therefore:

> **Compile templates at build time → clean. Let the runtime compiler in →
> the extension is uninstallable. Not degraded. Uninstallable.**

The saving grace is that this is a *grep-able invariant*, not a judgement call.
It becomes a build gate:

```bash
# fails the build if the runtime template compiler ever gets pulled in
! grep -qE "new Function|[^.\w]eval\s*\(" dist/assets/*.js
```

That gate is worth showing off in its own right — it is the concrete artifact of
"we understand our own bundle."

---

## 4. Surfaces: popup stays, side panel is new

**The popup is destroyed the moment it loses focus.** Look at what that has
already cost: CCEXT-29 exists only because of it. `ccAnswerPending` /
`ccAnswerResult` with TTLs and URL-scoping exist only because of it. The entire
§3 of the parked dropdown/refine plan — per-question draft store, LRU of pages,
reconcile-on-open — is machinery for fighting the popup lifecycle.

A component framework's value proposition is *durable reactive state*. If the UI
is torn down every few seconds you serialize everything to storage anyway, and
Glimmer becomes a nicer render layer over state management you still hand-rolled.

**So: `chrome.sidePanel` (Chrome/Edge) + `sidebar_action` (Firefox).** Both are
stable; there is no single cross-browser API, so a small adapter is required.
The panel survives clicking into the page and survives tab navigation.

| Surface | Job | Why |
|---|---|---|
| **Popup** | "Send this page" | One click. Blur-destruction genuinely does not matter for a 2-second interaction. Keep it lean — it is the latency-sensitive path. |
| **Side panel** | The answering workbench | State lives for minutes. Question picker, drafts, refine loop, insert-into-field. |

Same components, two `renderComponent` calls, two HTML entry points. *That* is a
good demo on its own: one component tree, two extension hosts, no app object in
either.

**Persistence stays regardless.** A panel can still be closed. The difference is
it stops happening every few seconds, so persistence becomes a safety net
instead of the primary architecture.

```jsonc
// chrome
"side_panel": { "default_path": "panel.html" },
"permissions": ["activeTab", "scripting", "storage", "notifications", "alarms", "sidePanel"]

// firefox
"sidebar_action": { "default_panel": "panel.html", "default_title": "Career Caddy" }
```

---

## 5. Build

Self-contained, so the eventual `git subtree split` into its own submodule is a
clean move. **Nothing reaches up into `frontend/`.**

```
career-caddy-sender/
  package.json          ember-source ^7.2, @glimmer/component, @warp-drive/*
  vite.config.mjs
  tsconfig.json
  manifest.json
  popup.html  panel.html
  src/
    popup.ts            renderComponent(<SendCard/>)
    panel.ts            renderComponent(<Workbench/>)
    components/*.gts
    lib/                page scan, field write, storage
    data/               WarpDrive request handlers
  background.ts
  dist/                 ← what gets zipped
```

### The whole Vite config (proven — this is the spike's, verbatim)

```js
import { defineConfig } from 'vite';
import { templateTag } from '@embroider/vite';
import { transformAsync } from '@babel/core';
import { createRequire } from 'node:module';
import templateCompilation from 'babel-plugin-ember-template-compilation';
import decoratorTransforms from 'decorator-transforms';
import typescript from '@babel/plugin-transform-typescript';

const require = createRequire(import.meta.url);

// ember-source ships every @ember/* and @glimmer/* package under
// dist/{dev,prod}/packages/, exposed only as the subpath export "./*".
// In an Ember app, Embroider's resolver maps the bare specifiers. We are not
// an Ember app, so we do that one job ourselves. This ~20 lines is the ONLY
// glue required to run Glimmer standalone.
function emberSourceResolver({ dev = false } = {}) {
  const flavour = dev ? 'dev' : 'prod';
  const root = require.resolve('ember-source/package.json').replace(/package\.json$/, '');
  return {
    name: 'ember-source-resolver',
    enforce: 'pre',
    resolveId(source) {
      if (source === '@glimmer/component') return null; // its own npm package
      const m = /^(@ember|@glimmer)\/(.+)$/.exec(source);
      if (!m) return null;
      return `${root}dist/${flavour}/packages/${m[1]}/${m[2]}/index.js`;
    },
  };
}

function glimmerBabel() {
  return {
    name: 'glimmer-babel',
    enforce: 'post',
    async transform(code, id) {
      if (id.includes('node_modules')) return null;
      if (!/\.(gts|gjs|ts|js)($|\?)/.test(id)) return null;
      const out = await transformAsync(code, {
        filename: id.replace(/\.gts($|\?)/, '.ts$1').replace(/\.gjs($|\?)/, '.js$1'),
        babelrc: false,
        configFile: false,
        plugins: [
          [typescript, { allowDeclareFields: true }],
          [templateCompilation, { targetFormat: 'wire' }], // ← AOT. never runtime.
          [decoratorTransforms, { runtime: { import: 'decorator-transforms/runtime' } }],
        ],
      });
      return out ? { code: out.code, map: out.map } : null;
    },
  };
}

export default defineConfig({
  plugins: [emberSourceResolver(), templateTag(), glimmerBabel()],
  build: { outDir: 'dist', rollupOptions: { input: { popup: 'popup.html', panel: 'panel.html' } } },
});
```

Order matters: `templateTag()` (content-tag) turns `<template>` into
`template()` calls → babel strips TS, compiles templates to **wire format**, and
lowers decorators → Rollup bundles.

Confirmed working on Babel 8 with these plugin versions.

---

## 6. Glimmer for a Vue 3 developer

| Vue 3 | Glimmer | Note |
|---|---|---|
| SFC `<template>` + `<script setup>` | `.gts` — template and class in one file | |
| `ref` / `reactive` | `@tracked` | Both autotracking. Glimmer's is pull-based; no `.value` unwrapping. |
| `computed` | a plain getter | Memoized by the same dependency graph. No special syntax. |
| props | `@args` | One-way and **genuinely immutable** — no `v-model` escape hatch. |
| VDOM + compiler hints | **no VDOM at all** | Templates compile to bytecode for a register VM. |

That last row is the real story. Vue got fast by making the VDOM smarter;
Glimmer's bet was to not have one. Someone who likes Vue's reactivity and
dislikes React's re-render-the-world model is exactly the audience.

### What TypeScript buys here, concretely

You picked `.gts` to learn TS. The single highest-value TS construct in Glimmer
is the **component signature** — it types the *template*, not just the class:

```ts
interface FieldPickerSignature {
  // Args: what a caller may pass with @. Excess or missing args are errors.
  Args: {
    fields: ScannedField[];
    selected: string | null;
    onSelect: (slug: string) => void;
  };
  // Element: what ...attributes lands on. Makes `<FieldPicker class="x" />`
  // type-check, and stops you splatting attributes onto a component that has
  // nowhere to put them.
  Element: HTMLSelectElement;
  // Blocks: named blocks the caller may pass, and what each yields back.
  Blocks: { default: [field: ScannedField] };
}

export default class FieldPicker extends Component<FieldPickerSignature> {
  // this.args is typed from Args. this.args.fields is ScannedField[],
  // and it is readonly -- assigning to it is a compile error, which is the
  // one-way data flow rule enforced by the type system rather than by
  // convention.
}
```

Vue's `defineProps<T>()` is the near-equivalent; Glimmer goes further by typing
blocks and the splattributes target too.

**Working agreement:** TS code gets explained as it is written — what each
annotation buys, why a type is shaped that way, what breaks without it.

---

## 7. Data: WarpDrive from the start

The extension currently makes **~28 bare `fetch()` calls** with the same
`Content-Type` / `Accept` / `Authorization` JSON:API header triple copy-pasted
inline, and no cache.

WarpDrive (`@warp-drive/core` 5.8.2, `@warp-drive/json-api`) is the
framework-agnostic successor to Ember Data — signals-based, and explicitly
supports Vue, Svelte, Solid and others alongside Ember. So "Glimmer UI +
WarpDrive data, neither requiring an Ember app" is a much larger claim than
either alone.

```ts
const manager = new RequestManager()
  .use([AuthHandler, new CacheHandler(), Fetch]);
// AuthHandler injects `Authorization: Bearer ${jh_key}` + the JSON:API headers
// in ONE place instead of 28.
```

**Risk, stated plainly:** this is a second substantial dependency in a
bundle-size-sensitive surface, and its size is *not yet measured*. The 54 kB
figure above is Glimmer alone. **Measure WarpDrive's delta before building on
it** — same method as §2. If it lands badly, the popup can ship without it and
the panel can carry it; they are separate entry points and Rollup will split
them.

---

## 8. Store review — the real costs

**Firefox / AMO is where this costs you.** Mozilla requires reviewable source
**plus reproducible build instructions** for any transpiled, minified, or
bundled extension, with dependencies either vendored or installed only from
official package managers. The extension is vanilla JS with no build step today
— that is precisely why AMO submission has been cheap. A bundler makes source
submission permanent and adds a review round-trip whenever the build changes.
Not a blocker. A standing tax, and it lands on Firefox, not Chrome.

**Chrome** is comparatively relaxed about bundles; the risk is a large opaque
bundle drawing a slower manual review.

**Both:** adding `sidePanel` (Chrome) / `sidebar_action` (Firefox) is a
permission change and will re-prompt existing users. Batch it with the rewrite
rather than spending the re-consent twice.

**What the repo loses:** `frontend/CLAUDE.md` documents the extension as
excluded from prettier and eslint with no test suite, gated by `node --check` +
sideload. A build step replaces that with real lint, real tests and real type
checking — a clear win — but every doc describing the release ritual changes
with it (`CLAUDE.md`, `CONTRIBUTING.md`, `README.md`, the extension `README.md`).

---

## 9. Weekend sequence

Ordered so the riskiest unknown dies first and there is a working artifact at
every stop.

1. **Measure WarpDrive's bundle delta.** 30 min, same method as §2. It is the
   one number that can still change the design. Do it before anything else.
2. **Scaffold** `package.json` / `vite.config.mjs` / `tsconfig.json` and get
   `popup.html` rendering one trivial `.gts` component. Add the CSP grep gate to
   the build script immediately — not later.
3. **Port the leaf components first**, bottom-up: status line, chips,
   quick-copy bar, the answer card. Leaves have no state to untangle.
4. **Port the page-interaction lib** (`ccResolveFieldInPage`, the writer,
   `countUnreachableFrames`) essentially **as-is**. It is injected via
   `executeScript` and must stay a self-contained function that survives
   serialization — it cannot become a component and should not try. Add types
   at the boundary only.
5. **Add `panel.html`** + the sidePanel/sidebar_action adapter. Move the
   workbench there.
6. **WarpDrive request layer**, replacing the 28 fetches.
7. **Re-land the parked dropdown/refine feature** on the new architecture — it
   gets dramatically smaller, since most of its complexity was popup-lifecycle
   defence.

Then: `git subtree split` into its own submodule.

---

## 10. Open risks

- **WarpDrive bundle size — unmeasured.** Step 1 above.
- **`decorator-transforms` + Babel 8 + these plugin versions** worked in the
  spike, but that is a fresh combination. Pin exact versions.
- **`@glimmer/component` requires ember-source internals at runtime**
  (`@ember/component`, `@ember/owner`, `@ember/runloop`). Fine — but it means
  the "no Ember" claim is about the *app*, not the *packages*. Say it that way
  publicly or someone will correct you, and they will be right.
- **Dual-copy hazard:** `@glimmer/tracking` must resolve to ember-source's copy,
  not a second one, or reactivity breaks silently. The resolver in §5 handles
  this; do not "fix" it by npm-installing `@glimmer/tracking` separately.
- **Firefox's `sidebar_action` lifecycle differs from Chrome's `sidePanel`** —
  budget real time for the adapter, and test on both before submitting.
- **The spike is verified as a web page, NOT as a loaded MV3 extension.** It was
  driven in real Chrome — mount, args, getters, tracked re-render and a real
  `{{on "click"}}` all confirmed — but served over `http://` from a static
  server. The bundle is *statically* proven free of `eval`/`new Function`, which
  is the thing MV3 rejects; it has not yet been run under an actual extension
  page's `script-src 'self'`. **First task of step 2: drop a minimal
  `manifest.json` next to the built `popup.html`, load it unpacked, and confirm
  it renders with a clean console.** That closes the last gap between "should
  install" and "installs".
