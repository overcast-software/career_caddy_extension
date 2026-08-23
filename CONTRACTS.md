# API contracts — what the extension sends, what the server honours

**Why this file exists.** The rewrite was being built against an api mapped
only where it had been tripped over. In one session, each of these arrived as a
surprise *after* a live test failed: `auto_score` silently ignored on the fast
path; `is_known_good` not deployed; `filter[...]` ignored by `ScrapeViewSet`;
`apply_url` present on 3 of 100 recent posts; `filter[link]` secretly matching
`apply_url` too.

`PORTING.md` fixed this for the legacy source. This is the same fix for the
server boundary: **coverage bounded by what you trip over is not coverage.**

Every divergence gets a verdict:

| Verdict | Meaning |
|---|---|
| **CLIENT WRONG** | the api works; the extension misuses it → fix the client |
| **API GAP** | the client is right; the server cannot express it → api change |
| **UNDOCUMENTED** | both fine, nobody wrote it down → this row IS the fix |

> **The api contract tests are the enforcement, not this file.** See
> `api/job_hunting/tests/test_scrape_extension_direct.py`,
> `test_scrape_from_text.py`, `test_scrape_profile_extension_selectors.py`,
> `test_job_application_match.py`, `test_job_post_filter_link_apply_url.py`.
> A row here that is not pinned by a test there will rot. When an api change
> lands, extend those tests in the same PR.

---

## Status

**COMPLETE.** Client half grepped from `src/`; server half traced through the
views and verified line by line. Every PENDING verdict below is resolved.

Read alongside:
- `architecture/arch-extension-direct-send-path-what-it-drops` in claudex, and
  its mermaid diagram at `flowcharts/extension-direct-pipeline.md`
- `architecture/arch-ingest-pipeline-extension-source-of-truth` — the trust
  ladder and dedupe. Its own flowchart predates extension-direct; this file
  and the one above cover what it does not.

---

## ⛔ THE HEADLINE — the fast path is a much thinner pipeline than assumed

CC-176 made **extension-direct the only route for any page with text**. That
route has a synchronous "Tier 0" branch that fires whenever `structured_prefill`
yields a title and a company — and on that branch the server does far less than
the browser tier. Verified by reading `views/scrapes.py:639-790`, not inferred:

| The extension sends / expects | On the Tier-0 fast path |
|---|---|
| `captured_payload.apply_url` | **NEVER READ.** `_parsed_job_data_from_payload` reads exactly four keys — title, company, description, location (`scrapes.py:680-689`). The only occurrence of `apply_url` in the whole 150-line consume path is inside a *docstring* at `:719`. |
| closed-posting detection | **DEAD.** `create_kwargs` (`:573-586`) never sets `job_content`, so `raw_source` is `""` in `process_evaluation` and BOTH legacy detection channels are guarded off (`job_post_extractor.py:726`, `:746`). |
| completeness review | **NEVER RUNS.** `_consume_extension_direct_payload` calls `process_evaluation` directly (`:764`); the reviewer's only two call sites are `parse_scrape` and `persist_extraction`. |
| `html` for selector discovery | **Never persisted** — breaks `inspect_scrape_html` and `find_selectors_for_text`. |
| tier ladder, JSON-LD, screenshots, `ResolveApplyUrl`, `UpdateProfile` learning | **None of it.** Extension-direct scrapes never reach `status='hold'`, so `claim_next` never claims them and the graph never sees them. |
| `scraped_at` | Null — the completion writes `save(update_fields=["status"])` (`:769`), bypassing the stamp in `pre_save_payload`. |

**This is the answer to "why do only 3 of 100 posts have an `apply_url`."**
There are five writers of that column and the fast path is none of them. The
route that DOES honour `apply_url` is `from-text` — which CC-176 made
unreachable for any page with text. The remaining few are almost certainly the
link picker, which is user-driven.

**Neither unmerged PR (api #250, agents #63) touches this path.** #250's
refusal validator never fires on Tier 0 because that branch already gates on
`title and company` before constructing `ParsedJobData`. #63 is browser-tier
only. The highest-volume route gains nothing from either.

---

## ⚠ GAP 0 — the staff gate, and what a Send actually costs the operator

`POST /api/v1/scrapes/` returns **403 "Scraping is staff-only during alpha."**
for any non-staff user (`views/scrapes.py:364-368`). That is the extension's
primary button, and it works today only because Doug is staff.

**The rationale, from Doug — recorded because I first got it wrong.** The gate
is not about a headed browser being an expensive resource. It is that
**scraping is fraught and can break terms of service**, and that a user-created
scrape becomes **a job the operator's automation has to run**. It is a
liability-and-workload gate, not a capacity one.

So the question is not "does this need a browser" but **"does a Send create
work for the operator, or expose them to ToS risk?"** Reviewed below.

### What a Send actually does — verified, not assumed

| Question | Answer |
|---|---|
| Is a Scrape row created at send time? | **Yes.** `Scrape.objects.create(...)` at `scrapes.py:587`, initially **`status='hold'`**, logged as such at `:589`. |
| What is in the payload? | **`document.body.innerText` and nothing else** (`injected/grab-payload.ts:32`). No HTML, no DOM, no outerHTML. The server never receives markup from this path. |
| Does the runner pick it up? | **Normally no.** `_consume_extension_direct_payload` fires at `:620` and moves the row to `completed` (`:768`) or `pending` (`:856`) synchronously, in the request. `claim_next` filters `status="hold"` (`:1447`), so neither terminal state is claimable. |
| Does anything get enqueued? | **Only on a Tier-0 miss**: `enqueue("parse_scrape", ...)` at `:872` — an api-side django-q2 LLM parse. That costs tokens on the api, **not** a browser session on the runner. |

### ⚠ But there IS an unguarded window, and it is worth knowing about

**`create()` is not transaction-wrapped** — no `@transaction.atomic` on
`scrapes.py:359`. So the row is committed at `status='hold'` on line 587 and
only leaves that state at line 620+.

Between those, the row is **visible to `claim_next` and claimable by a
runner**. If a runner polls in that window it sets `status='running'` and the
graph will go and browse the URL — which is exactly the outcome the gate
exists to prevent.

The window is milliseconds and the probability is low. But it is not zero, and
it is the only path by which a Send can become browser work. **Wrapping
`create()` in `transaction.atomic` — or creating the row directly in its
terminal state for extension-direct — closes it, and would make "a Send never
becomes a runner job" a guarantee rather than a race.**

### The ToS question — stated, not decided

The extension reads text from a page the user has already loaded, in their own
browser, under their own session. That is a different act from a headless
fetcher retrieving a page the user never visited. Whether that difference is
sufficient for the ToS concern is **Doug's call, not a technical finding**, and
this document does not assume it.

**Verdict: OPEN — a product decision, with the technical facts above.** Two
things follow regardless of how it is decided:

1. **If the gate is meant to stay for extension-direct**, the extension must
   check `me.isStaff` before offering Send and say why. Right now a non-staff
   user gets a bare 403 (and, until v2.0.58, a stack overflow).
2. **If extension-direct is meant to be open**, the gate needs to move below
   the `source_mode` read — it currently fires at `:364`, before `source_mode`
   is known at `:387`, so it cannot distinguish the two capabilities. The race
   window above should be closed in the same change.

---

## The client surface

Every path the extension calls. Nothing else talks to the server.

### Connect / identity

| | |
|---|---|
| `POST /api/v1/token/refresh/` | SSO handshake — reads the SPA's session from an open careercaddy.online tab |
| `POST /api/v1/api-keys/` | mints the long-lived `jh_*` key; only this is stored |
| `DELETE /api/v1/api-keys/:id` | revoke on disconnect, so a shared machine can be cleaned from either end |
| `GET /api/v1/me/` | one call serving BOTH quick copy and the staff gate — reads `linkedin`, `github`, `links`, `is_staff`, `first_name` |

### Send — the two plans

Chosen by `domain/send-gate.ts`. The gate is CC-176: captured text goes
extension-direct; only an empty-body page falls back to the browser tier.

**`POST /api/v1/scrapes/` — extension-direct (the fast path)**

```
data.attributes.url              page url
data.attributes.link             page url
data.attributes.source_mode      'extension-direct'
data.attributes.captured_payload {
  description                    required — the gate refuses without it
  title, company, location       OMITTED when unknown, never blanked (CC-122)
  apply_url                      decoded, when selectors found an apply button
  extraction_hints {
    canonical_link_hint
    referrer_url                 allowlisted hosts only
    structured_prefill           per-field selector results
  }
}
```

**`POST /api/v1/scrapes/from-text/` — browser tier**

```
text, link, source: 'extension', auto_score,
apply_url, canonical_link_hint, referrer_url, structured_prefill
```

> ### ⚠ DIVERGENCE 1 — the two plans send the same data in different shapes
>
> `from-text` sends `structured_prefill` / `canonical_link_hint` /
> `referrer_url` **top-level**. extension-direct nests them under
> `captured_payload.extraction_hints`. Same three fields, two shapes.
>
> **Verdict: BOTH SHAPES ARE READ — but not the same fields.**
>
> `from_text` reads all three top-level (`scrapes.py:1046-1057`).
> extension-direct reads `captured_payload.extraction_hints` at `:671` and
> `:822` — **but only `structured_prefill`.**
>
> So `canonical_link_hint` and `referrer_url` **are silently dropped on the
> fast path.** The extension builds them (`send-gate.ts:126-127`) and nothing
> reads them. That kills LinkedIn `og:url` canonicalization and the
> referrer→ATS click-through pairing — both real features with server support,
> inert in practice.
>
> **Verdict: API GAP.** Two shapes is survivable and worth a comment; two
> shapes where one silently drops two of three fields is a bug.

> ### ⚠ DIVERGENCE 2 — `auto_score` is sent on only one path
>
> `from-text` sends it. extension-direct does **not**, because the endpoint has
> no such field (`views/scrapes.py:1043` is inside the `from_text` action).
> Confirmed live: the checkbox did nothing for every send that took the fast
> path, which is nearly all of them.
>
> **Verdict: API GAP, worked around.** `background.ts` now starts the score
> itself once the scrape completes. Open question for phase 2: is the worker
> the right owner (it survives the panel closing) or should the api own it?
> **Check for double-scoring before changing anything.**

> ### ⚠ DIVERGENCE 3 — closed-posting evidence is detected and never sent
>
> `injected/grab-hints.ts` returns `closedEvidence` verbatim and `SendCard`
> displays it. It is in **neither** request body.
>
> **Verdict: API GAP. I previously called this correct and I was wrong.**
>
> I reasoned that the server detects closed state independently from
> `scrape.job_content` — the same text the extension sends — so there was
> nothing to wire. That holds for `from-text`. It is **false for
> extension-direct**, which is the only path a page with text takes.
>
> `create_kwargs` never sets `job_content` on that route (`scrapes.py:573-586`),
> so `raw_source` is empty in `process_evaluation` and both detection channels
> are guarded off (`job_post_extractor.py:726`, `:746`). `detected_posting_status`
> is also null, because only the graph writes it.
>
> **So closed-posting detection has been dead on the extension's real path
> since CC-176.** The panel shows the user "No longer accepting applications";
> the server records nothing. Fixing it means either sending the evidence, or
> having the server persist `job_content` on this route — the latter is
> probably right, since it also revives the description fallback at
> `job_post_extractor.py:666-672`.

### Lookup and search

| | |
|---|---|
| `GET /api/v1/job-posts/?filter[link]=…&include=company` | "do we know this page?" — also the ladder's T1/T2/T3 |
| `GET /api/v1/job-posts/?filter[query]=…&sort=-created_at&page[size]=10&include=company` | the link picker, and the ladder's T4/T5 |
| `PATCH /api/v1/job-posts/:id` | link picker writes `apply_url` |

> ### ✅ CAPABILITY I DID NOT KNOW THE CLIENT HAD
>
> **`filter[link]` also matches `apply_url`**, and canonicalizes tracking
> tokens so a url with a *different* token still matches
> (`test_job_post_filter_link_apply_url.py`). The by-link lookup is therefore
> considerably stronger than assumed, and the ladder may be doing work the
> server would have done.
>
> **Verdict: UNDOCUMENTED.** Action: re-examine whether ladder tiers are
> redundant given this.

> ### ⚠ DIVERGENCE 4 — `filter[query]` does not search `apply_url`
>
> It spans title / description / company name / company display_name / link
> (`views/jobs.py:465`). Not `apply_url`. Measured: searching for a token that
> appears only in an `apply_url` returns nothing.
>
> **Verdict: CONFIRMED, and correct as designed.** `filter[query]` spans
> title / description / company name / display_name / link
> (`jobs.py:462-471`). `filter[link]` is the one that also matches `apply_url`
> — `Q(link=x) | Q(apply_url=x) | Q(canonical_link=canon) | Q(apply_url=canon)`
> (`jobs.py:281-283`), indexed by `migrations/0130_jobpost_apply_url_hash_idx`.
>
> Two behaviours of `filter[link]` the extension depends on without saying so:
> it **bypasses the six-clause per-user visibility filter entirely**
> (`jobs.py:275`, deliberate, documented at `:250-258`) — so **cross-user posts
> come back** — and it is exempt from the default closed-post exclusion.

### Applications

| | |
|---|---|
| `GET /api/v1/job-posts/:id/job-applications/` | owner-scoped dedupe, before ever creating one |
| `POST /api/v1/job-applications/` (JSON:API) | track — sends only the job-post relationship; `company_id` is inherited server-side |
| `POST /api/v1/job-applications/` (**flat** + `match_context`) | CC-135 — staff-gated; sends NO job-post, the matcher backfills it |
| `GET /api/v1/job-applications/:id?include=job-post,company` | CC-135 outcome poll — reads `match_context.status/confidence/rationale` |

> ### ⚠ DIVERGENCE 5 — one endpoint, two body shapes
>
> Track sends a JSON:API envelope; CC-135 sends a flat body.
>
> **Verdict: CONFIRMED — both are genuinely accepted.** `jobs.py:2075-2077`:
> `attrs = (node.get("attributes") if node else None) or data`. The
> match-trigger branch fires only when one of `referrer`/`page_title`/
> `text_excerpt` is truthy (`:2079-2083`), is **staff-gated** (`:2128-2132`),
> and returns **202** rather than 201.
>
> Inside that branch only `tracking_url` and `status` are read from the body;
> `page_title` is truncated to 500 chars and `text_excerpt` to 8000
> (`models/job_application.py:41`). The server then OVERWRITES `match_context`
> with its own struct. Any `job-post` relationship sent is ignored.
>
> UNDOCUMENTED — worth a comment at both call sites, because it reads as a bug.

> ### ⛔ DIVERGENCE 7 — the extension waits for a status the api never emits
>
> `state/match-app.ts:163` treats the run as finished on
> `status === 'failed' || status === 'no_match'`.
>
> **`'no_match'` does not exist.** The server emits only `pending` / `done` /
> `failed` (`models/job_application.py:43-45`). A legitimate "searched, found
> nothing" outcome is **`done` with `job_post_id = None`** and
> `rationale = "no candidates"`.
>
> So that case falls through the poll loop and times out at `POLL_MAX` with
> *"Still looking — it will be here when you come back."* — when in fact the
> answer arrived and was "no". **Verdict: CLIENT WRONG.** Handle `done`:
> a pick means matched, no pick means no match.

### Scoring

| | |
|---|---|
| `POST /api/v1/scores/` | body is `data.relationships['job-post']` only |
| `GET /api/v1/scores/:id/` | polled by the panel AND by `background.ts` |

### Per-host selectors

`GET /api/v1/scrape-profiles/extension-selectors/?hostname=…`

Client reads `apply_button_selectors`, `canonical_link_selectors`,
`apply_url_decoder`, `job_data_selectors`, and — with `=== true`, fail-safe —
`is_known_good` / `readiness.tier`.

> ### ⚠ DIVERGENCE 6 — the client reads a shape prod does not serve
>
> Prod returns `known_good` / `tier` / `reasons` at the **top level**.
> `data.attributes` has no `is_known_good` and no `readiness`. The client reads
> the canonical location and degrades to "not known good" — fail-safe, so
> nothing breaks, but the staff readout is always wrong.
>
> The reshape exists as an **uncommitted change in the `api/` working tree**
> (+116 lines, zero deletions, backwards-compatible).
>
> **Verdict: API GAP, half-built by me.** Phase 2 action: land it as its own
> small PR, or revert and read the top-level form. It must not stay
> uncommitted.

### Background worker

`GET /api/v1/scrapes/:id?include=job-post` — polled on a `chrome.alarms`
cadence, terminal on `completed`/`failed`/`error`/`cancelled`.

> **Verdict: SAFE, BY LUCK — there is no authoritative enum to conform to.**
>
> `Scrape.status` is a bare `CharField` with **no `choices`**
> (`models/scrape.py:56`). Four lists disagree across the codebase: the seed
> migration (`0039`), `_SWEEPABLE_STATUSES` in `lib/tasks.py:992` (four of
> which are not in the seed), the frontend's `pollable.js:7`, and ours.
>
> The complete set the api actually emits is
> `hold · pending · running · extracting · updating_profile · completed · failed`.
> The worker's `error` and `cancelled` are **dead entries**; it misses nothing.
> `state/score.ts` correctly uses a *different* terminal set for Score, which
> is a separate vocabulary (`completed`/`failed`).

---

## Blast radius — what a proposed api change would break

Answered so the phase-2 fixes can be sequenced without guessing.

### Removing the deprecated top-level `known_good`/`tier`/`reasons`

**Breaks three api test assertions and nothing else.**

| Reader | Verdict |
|---|---|
| `api/.../tests/test_scrape_profile_known_good.py:256,257,280,281` | fix in the same PR |
| `api/.../tests/test_scrape_profile_extension_selectors.py:110-113` | fix in the same PR |
| the retired 2.x `popup.js` | **dead** — frontend dropped it at `95aad96`; survives only on unmerged branches |
| `automation` | **unaffected** — reads `is_known_good` off the FULL `/scrape-profiles/?filter[hostname]=` resource, which has emitted that name since PR #185 |
| `frontend` | **zero readers** — `app/models/scrape-profile.js` does not even declare the attrs |
| `agents` | writes `extension_selectors`, never reads readiness |
| the new extension | already reads the canonical location — starts working the moment this lands |

### Honouring `auto_score` on `POST /scrapes/`

**Real double-scoring risk. Do not default it on.**

Seven things can already start a score: `_auto_score_job_post` (only ever
called by `parse_scrape_job`, i.e. from-text), `POST /scores/`, the extension's
own background worker, the extension panel's manual button, the frontend's
`list.js:37` after a scrape, and the agents score poller.

Concretely, if the api starts scoring on this path: the worker ALSO scores
~30s later, `enqueue` has no dedup key, and `POST /scores/` **resets an
existing row to pending** (`scores.py:203-210`) — so the user watches a score
land, revert to pending, and land again, possibly with a different number. No
duplicate rows (a unique constraint holds); duplicate cost and visible
flapping.

Worse, `from_text` treats **absent as `True`** (`:1044`). Copying that default
into `create` would start scoring for every existing caller that omits the flag
— frontend (6 sites), agents MCP, `scrape_graph`, automation. Given the
documented seven-week cost incident in `automation/scripts/inbox_triage.py:398-418`,
**default `False` on `create`.**

**And if the api takes ownership, delete the worker's `beginScore` in the same
PR.** Two owners is the bug.

> Bonus finding: `Profile.auto_score` (`models/profile.py:35`) is **never read
> by any scoring decision** — only written and serialized. `score_poller.py`'s
> docstring claims the server enforces it. It does not. That field is an
> unwired per-user kill switch, and it is what the extension should seed its
> checkbox from instead of hardcoding `true` (`send-card.gts:35`).

---

## Smaller findings worth acting on

- **`POST /scores/` is not idempotent.** An existing `(job_post, resume, user)`
  Score is reset to pending and re-enqueued (`scores.py:203-217`), with no
  guard for one already pending.
- **A score of exactly `1` renders as `100%`.** Scores are integers 1–100
  (`scores.py:258`); `background.ts:319` hedges `value <= 1 ? value*100 : value`.
  Harmless in practice, wrong at the boundary.
- **`failure_reason` is returned and unread.** It is the operator-facing "why
  didn't my post appear" answer; the worker instead says a generic
  *"Couldn't parse the posting from {host}."* Reading it would make the
  extractor-refusal work (api #250) visible to the user.
- **`explanation` on a Score is unread** — the full LLM rationale, arguably the
  most useful field on the resource.
- **API keys never expire.** The extension does not send `expires_days`
  (`admin.py:266`), so the minted `jh_*` key is permanent.
- **`PATCH /job-posts/:id` is staff-OR-owner** (`jobs.py:983-985`). Since
  `filter[link]` returns cross-user posts, the link picker can legitimately
  receive a 403 — which is exactly why `setApplyUrl` returns a boolean.
- **`include` is silently ignored** on `/scores/` and `/scrape-profiles/`;
  **`sort` is silently ignored** on `/scores/`, `/scrape-profiles/`,
  `/questions/`, `/answers/`. No 400 — they just do nothing.
- **Dead code in `lib/api.ts`:** the `noContentType` option exists solely for
  `scrape-profiles/:id/sharpen/`, which the new extension never calls. Same for
  the `ccAnswerDrafts` storage key — a legacy leftover with no writer.

---

## What NOT to copy from the neighbours

- **`automation`'s `ApiClient._ok`** collapses any non-2xx into
  `error="<status> - <text>"`, destroying the structured error body. Downstream
  code has to *string-match* `"duplicate_job_post"` to recognise a 409
  (`inbox_triage.py:420-427`). Our `ApiResult<T>` keeps `status` separate and
  parses `errors[0].detail` — keep it that way.
- **There is no shared JSON:API util anywhere.** Frontend uses Ember Data;
  automation and agents each hand-roll. Nothing to conform to. The one pattern
  worth borrowing is `automation/src/client/models.py` — **validate at the
  model boundary, not at the call site.**
- **The OpenAPI schema is a route index, not a contract.** `drf-spectacular` is
  served at `/api/schema/` but no artifact is committed and CI never generates
  or diffs it. It documents 5 of the ~14 filters `JobPostViewSet` implements.

---

## Answers to the questions this file opened with

1. **Does extension-direct read `extraction_hints.*`?** Only
   `structured_prefill`. `canonical_link_hint` and `referrer_url` are dropped.
2. **What is the authoritative Scrape status enum?** There isn't one —
   `status` is a bare `CharField` with no `choices`, and four lists in the
   codebase disagree. Emitted set:
   `hold · pending · running · extracting · updating_profile · completed · failed`.
3. **Does `POST /job-applications/` accept both body shapes?** Yes —
   `attrs = node.get("attributes") or data`.
4. **What is the "Phase B consume" path?** `_consume_extension_direct_payload`
   (`scrapes.py:712`), synchronous and in-request. It creates the JobPost with
   no LLM whenever `structured_prefill` yields a title and a company.
5. **Why do only 3 of 100 posts have an `apply_url`?** Five writers exist and
   the fast path is none of them. The one route that honours `apply_url` is
   `from-text`, which CC-176 made unreachable. The surviving few are the
   user-driven link picker.

---

## The divergence ledger

Every finding, with its verdict, in priority order. This is the phase-2 work
list.

| # | Finding | Verdict | Fix lands in |
|---|---|---|---|
| **0** | `POST /scrapes/` is staff-only; the gate fires before `source_mode` is known | **OPEN — product decision** | api (+ client message either way) |
| **0b** | `create()` is not atomic; the row is briefly claimable at `'hold'` | **API GAP** | api |
| **H** | Tier-0 drops `apply_url`, never writes `job_content`, skips CompletenessReviewer, persists no `html` | **API GAP** | api |
| **1** | `canonical_link_hint` + `referrer_url` dropped on the fast path | **API GAP** | api |
| **2** | `auto_score` absent from `POST /scrapes/` | **API GAP, worked around** | decide owner first |
| **3** | closed evidence detected, never sent, and undetectable server-side on this path | **API GAP** | api (persist `job_content`) |
| **7** | client waits for `'no_match'`, a status the api never emits | **CLIENT WRONG** | extension |
| **6** | client reads `is_known_good`/`readiness`; prod serves top-level | **API GAP, half-built, UNCOMMITTED** | api — **do this first** |
| **4** | `filter[query]` does not search `apply_url` | **correct as designed** | — |
| **5** | two body shapes on `POST /job-applications/` | **UNDOCUMENTED** | comments |
| — | `filter[link]` bypasses per-user visibility | **UNDOCUMENTED** | comment |
| — | worker terminal set has two dead entries | **harmless** | — |

**Sequence.** #6 first — it is already written, backwards-compatible, and
sitting uncommitted in the `api/` working tree; leaving it there blocks
everything else. Then the headline cluster (H, 1, 3) as one api change, since
persisting `job_content` and reading the hints are the same edit. #7 is
client-only and can go any time. #0 waits on a decision.

**Every api change extends the contract tests named at the top of this file, in
the same PR.** That is what stops this document from rotting into fiction.
