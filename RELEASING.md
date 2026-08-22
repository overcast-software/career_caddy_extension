# Releasing

Two stores, two review regimes, one build. This is the whole process.

## The pipeline

| Trigger | Workflow | Does |
|---|---|---|
| PR / push | `ci.yml` | build both targets, CSP gate, `web-ext lint`, manifest-shape assertions, upload unpacked builds as artifacts |
| tag `v*` | `release.yml` | build, package, **source archive**, GitHub Release |
| manual | `publish.yml` | submit to CWS and/or AMO — opted into per store |

Cutting a release never touches a store. That separation is deliberate: a tag
is reversible, a store submission is not, and it starts a review clock you
cannot cancel.

## Cutting a release

```bash
npm version minor        # bumps package.json; the manifest reads it
git push && git push --tags
```

`manifest.mjs` derives its version from `package.json`, so there is one number,
not two. `release.yml` asserts the tag matches it and fails loudly if not —
shipping `v3.1.0` containing `3.0.0` gets rejected by the store as a version it
has already seen, which is a confusing error to receive an hour later.

Then run **Publish** from the Actions tab, ticking the stores you want.

## Version policy

Published today: **Chrome 1.1.0, Firefox 1.1.1** (May 2026). Everything from
1.2.0 through 2.3.0 was a local test marker that never left a laptop. So 3.0.0
is the first submission in over a year, and both stores will treat it as a
major change rather than an update.

A version must be **strictly higher** than what the store already has, and a
version can never be reused — not even after a rejection. Bump on every
resubmission.

## Secrets

Stored as GitHub **environment** secrets (`chrome-web-store` and `amo`), not
repo secrets, so an environment protection rule can require an approval before
either job runs.

**Chrome Web Store** — `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`,
`CWS_EXTENSION_ID`. OAuth client with the `chromewebstore` scope.

> ⚠️ **A CWS refresh token dies after ~6 months without use.** This extension
> releases infrequently, which means the token will be expired precisely when
> you next need it. If the token exchange fails, re-mint it — do not debug the
> 400.

**AMO** — `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`, from the AMO developer hub API
credentials page.

## What the reviewers see, and what they will ask

### Firefox / AMO — the stricter of the two

AMO requires **reviewable source plus reproducible build instructions** for any
bundled or minified extension. `release.yml` produces `*-source.zip` via
`git archive`, and `publish.yml` attaches it with `web-ext sign
--upload-source-code`. The build instructions are the *Build* section of
`README.md`; keep it accurate, because a reviewer will run it.

**Expect these lint warnings. They are not bugs and they do not block review —
but a reviewer will stop on them, so have the answer ready:**

- **3 × `UNSAFE_VAR_ASSIGNMENT` — `insertAdjacentHTML`.** Inside ember-source's
  Glimmer runtime (its `SafeString` path), not our code. Tree-shaking cannot
  drop it because the path is reachable in principle, even though no template
  in this extension uses triple-curly interpolation. **No user-controlled HTML
  flows through it.** Worth stating in the submission notes unprompted.
- **1 × `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`.** Firefox for Android
  has no `sidebar_action` at all, so this is a desktop-only extension. Declare
  that on the AMO listing rather than trying to fix it in the manifest.

`strict_min_version` is **140.0**, because `data_collection_permissions` needs
Firefox 140 (142 on Android). Lowering it re-introduces a real bug: users below
140 would get no data-collection disclosure. The 2.x manifest still has that
mismatch.

Signing is asynchronous and listed submissions are **never** auto-approved.
`--approval-timeout 0` makes the job return once submitted; watch the dashboard
for the verdict.

### Chrome Web Store

More relaxed about bundles, but the risk is that a large opaque bundle draws a
slower **manual** review. `cws-justifications.txt` (currently in the 2.x
`store-assets/`) must be true of the shipped code — it is the document a
reviewer checks permissions against.

Permission justifications, current as of 3.0.0:

| Permission | Why |
|---|---|
| `activeTab` | read the job posting on the tab the user invoked the extension on |
| `scripting` | run the extraction/field-resolution functions in that tab |
| `storage` | the API key and per-host selector cache |
| `notifications` | tell the user when a scrape or score finishes |
| `alarms` | poll for those results after the worker is evicted |
| `sidePanel` | the extension's only UI surface |
| `host_permissions: careercaddy.online` | the user's own instance — the only server contacted |

### Both: 3.0.0 changes permissions

`sidePanel` is new since the published 1.1.x. **Existing users will be prompted
to re-consent on update**, and some fraction never will. This is a one-time
cost; spend it once by batching any other permission change into this release
rather than shipping a second prompt later.

## Before you submit

- [ ] Loaded unpacked in **both** browsers and clicked through
- [ ] Panel survives clicking into a page, typing, switching tabs
- [ ] `npm run build` clean — CSP gate passes on both targets
- [ ] `npx web-ext lint --source-dir dist/firefox` — **0 errors**
- [ ] Version bumped, and higher than what each store already lists
- [ ] Store listing copy and screenshots reflect the panel, not the popup
- [ ] `cws-justifications.txt` is true of *this* build
- [ ] Source archive builds the shipped artifact when a reviewer follows README

## If a review is rejected

Fix, **bump the version again** (a rejected version number is burned), and
resubmit. Rejection reasons arrive by email to the developer account, not in
the workflow logs.
