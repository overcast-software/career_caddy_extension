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
1.2.0 through 2.3.0 was a local test marker that never left a laptop.

**There is no installed user base.** That removes the constraint that usually
dominates extension release planning, and it is worth being explicit about
what it does and does not change:

- **Gone:** any concern about disrupting existing installs. Permission changes
  do not cost you a re-consent wave, because there is nobody to re-consent.
  Do not sequence work around avoiding one.
- **Gone:** pressure to preserve behaviour for compatibility. 3.x can break
  anything 2.x did.
- **Still applies:** the stores enforce **monotonically increasing versions**,
  and a version number is burned once submitted — even by a rejected
  submission. That is a store rule about their own records, not about users,
  so bump on every resubmission regardless.

So version numbers here are bookkeeping for two review queues, not a promise to
anyone. Spend them freely.

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

### Both: permissions are still a review question, just not a user one

`sidePanel` is new since 1.1.x, and an `optional_host_permissions` entry has
been added for the `activeTab` problem (see `manifest.mjs`). With no installed
base there is no re-consent wave to plan around — but **reviewers still read
the permission list**, and a broad host permission is the single thing most
likely to turn an automated review into a manual one.

That is now the *only* argument against simply declaring
`host_permissions: ["<all_urls>"]` and being done with the `activeTab`
expiry problem. It remains a good argument, for two reasons that outlive the
user count:

1. Review friction and time-to-publish, on both stores.
2. The product's own claim — the listing says it reads job postings and talks
   to your own instance. A blanket grant makes that claim weaker than the
   optional per-origin flow does, whether or not anyone is currently checking.

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
