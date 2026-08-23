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

Client half: **complete** — grepped from `src/`, not recalled.
Server half: **the ingestion trace has landed and is verified below.** The
endpoint-by-endpoint and blast-radius passes are still running.

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
> **Verdict: PENDING** — needs the server half. If the api reads both, this is
> UNDOCUMENTED and belongs in a comment. If it reads only one, one path has
> been silently dropping hints since it was written.

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
> **Verdict: PENDING** — may be deliberate. Matters for the ladder's T4.

### Applications

| | |
|---|---|
| `GET /api/v1/job-posts/:id/job-applications/` | owner-scoped dedupe, before ever creating one |
| `POST /api/v1/job-applications/` (JSON:API) | track — sends only the job-post relationship; `company_id` is inherited server-side |
| `POST /api/v1/job-applications/` (**flat** + `match_context`) | CC-135 — staff-gated; sends NO job-post, the matcher backfills it |
| `GET /api/v1/job-applications/:id?include=job-post,company` | CC-135 outcome poll — reads `match_context.status/confidence/rationale` |

> ### ⚠ DIVERGENCE 5 — one endpoint, two body shapes
>
> Track sends a JSON:API envelope; CC-135 sends a flat body. Both are said to
> be accepted. **Verdict: PENDING** — if true it is UNDOCUMENTED and worth a
> comment at both call sites, because it looks like a bug to any reader.

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

> **Verdict: PENDING** — that terminal set was written from the statuses seen
> in a live listing, not from the server's own enum. If the server can emit a
> terminal status outside it, the worker polls 20 times and gives up silently.
> **Find the authoritative status list.**

---

## Open questions for the server half

1. Does extension-direct read `extraction_hints.*`, or only the top-level form
   `from-text` uses? (Divergence 1)
2. What is the authoritative Scrape status enum?
3. Does `POST /job-applications/` genuinely accept both body shapes?
4. What is the synchronous "Phase B consume" path in
   `test_scrape_extension_direct.py`, and when does it create a JobPost without
   an LLM parse?
5. Why do only 3 of 100 recent posts have an `apply_url`? Which routes write it?
