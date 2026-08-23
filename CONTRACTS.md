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
Server half: **in progress** — three Explore agents are tracing the views,
the ingestion pipeline, and the other consumers.

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
> **Verdict: probably CORRECT, needs confirming.** The server runs
> `detect_posting_status()` on `scrape.job_content` — the same text the
> extension sends — so it reaches its own verdict without trusting a client
> claim. If so this is UNDOCUMENTED, and the client-side detection is a local
> preview. Note the phrase lists are duplicated (`data/selectors.ts`
> `CLOSED_PHRASES` vs `text_signals._CLOSED_PHRASES`) and can drift.

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
