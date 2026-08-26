# Porting inventory — legacy popup.js/background.js → Glimmer

**Why this file exists.** The rewrite was being driven from memory: read the
legacy when a feature came to mind, write the new version, discover the gap
when someone tested. Every gap found by testing so far — `auto_score` silently
dropped on the fast path, the quick-copy collapse, `allFrames: true`,
`optional_permissions: ["tabs"]`, the worker's score chain — was a place that
recall failed. Coverage bounded by memory is not coverage.

This is the checklist instead. Source of truth is frontend commit `95aad96^`
(the commit that removed the extension after it moved to its own repo):
`public/extensions/career-caddy-sender/{popup.js,background.js}` — **6,564 +
675 lines, 171 top-level functions.**

> Earlier work in this rewrite was done against a 5,468-line copy found in a
> git worktree. That copy is ~1,100 lines stale. Do not use it.

## Coverage

| | Count | |
|---|---|---|
| DOM plumbing — genuinely deleted by Glimmer | 55 | `show*`/`hide*`/`render*`/`reset*Card`/`setStatus` — `{{#if}}` and `{{#each}}` replace these outright |
| Ported | 94 | |
| Dropped with a reason | 2 | both in the answer desk; see below |
| **Not yet ported** | **20** | |

Excluding the 55 the framework deletes, that is **94 of 116 real functions
resolved — 81%.**

The remaining 20 are spread across the sections below and counted per-section
there — the ✅ marks are the source of this table, so recount them rather than
trusting the number.

## Not yet ported, by subsystem

### Answer desk — 20 functions (phase 2, CCEXT-45, **DONE**)

**The classifier, `injected/resolve-field.ts`:**
`ccResolveFieldInPage` ✅ — BOTH ladders in ONE function, as the WIP commit
`5c0886f` (frontend, branch `feature/ccext-form-question-dropdown-refine`)
established. `'selection'` walks a highlight forward to its control;
`'scan'` enumerates every field and walks each one backward to its label.
They share `fieldKind()` because `executeScript` serializes a SINGLE function,
so a second injected scanner would need its own copy — and a forked classifier
is exactly the failure CCEXT-30 was filed for. `ccWriteFieldInPage` ✅ —
native prototype setter + bubbling `input`/`change`, `execCommand('insertText')`
for contenteditable.

**A build trap found while porting, and it is general.** `esbuild:
{ keepNames: true }` rewrites every named function — declaration, named
expression, AND arrow assigned to a const — into `__name(fn, "original")`.
Inside an injected function that helper is a module-scope reference the page
does not have, so the whole function throws on injection. `injected-gate.mjs`
caught it (`references module scope: l`). Object-literal methods are the one
form esbuild leaves alone, measured against esbuild directly rather than
guessed, so shared helpers live in a `const h = { … }`. The rule is now
written down in `injected/grab-payload.ts`'s header, which is where the other
injected files are told to look. No earlier injected function had nested
helpers, which is why this had never fired.

**CCEXT-30 is now expressed in the type system.** `ResolvedField` is a
discriminated union: the text arm HAS a token, the choice arm's is `null` by
construction because the scanner never stamps one. The write path takes the
text arm, so handing it a dropdown is a compile error rather than a support
ticket.

**The pure rules, `domain/answer-desk.ts` + `domain/answer-reuse.ts` (41 tests):**
`answerReuseVerdict` ✅ `autoDeliverAnswer` ✅ (as `autoInsertDecision`, a
second discriminated union — a refusal carries no token, so the caller
*cannot* write off the back of one).

**The HTTP, `data/answers.ts`:**
`findExistingAnswer` ✅ (as `findSavedAnswer`) `mintQuestion` ✅
`requestAiAnswer` ✅ (as `requestAnswer`, and it now sends `injected_prompt` —
the api has accepted it all along, from four nesting levels; the extension had
simply never sent one. **No api change was needed.**)

**The orchestration, `state/answer-desk.ts` + `components/answer-desk.gts`:**
`handleAnswerSelected` ✅ (as `run()` — one action with two identities,
Answer before a draft exists and Refine after) `pollAnswerUntilTerminal` ✅
`insertAnswerIntoField` ✅ `maybeResumeAnswer` ✅ (as `reconcile()`)
`maybeRestoreAnswer` ✅ (restoration is now structural: drafts are keyed by
label + occurrence, so a rescan re-attaches them without anything asking)
`saveAnswerResult` ✅ `clearAnswerPending` ✅ `copyAnswerToClipboard` ✅
`answerSleep` ✅ `resolveSelectionTarget` ✅ (as `page.scanQuestions()`,
which also re-derives `occurrence` ACROSS frames — the injected scanner counts
within its own frame, so two frames each holding a "Why?" box would collide on
one draft key).

**Keyed on label + occurrence, never on the `data-cc-field` token.** Tokens are
regenerated on every scan and die on reload, so a draft keyed on one detaches
exactly when the page re-renders — which is when you most want it back.
Identical labels are NOT deduped: a form with two "Why?" boxes is asking two
questions.

**Page-scoping is the SHAPE, not a check.** The store is `url -> key -> draft`,
so there is no lookup that can return another page's draft. CCEXT-43's lesson
was that the popup did this correctness work for free by dying on blur;
a runtime `if (draft.url === page.url)` would be one edit away from being
forgotten, and the thing it guards is an answer written for one employer
landing in another's form.

**Dropped, with reasons:**

| Function | Verdict | Reason |
|---|---|---|
| `primeAnswerSelection` | **DROP (superseded)** | Its whole job was to read the page selection on tab-open and echo it, because the popup died the moment you clicked into the page to highlight anything. The picker is CCEXT-26 M2 replacing that entry point, and re-reading the selection on every open would be a page read for convenience — declined on Doug's standing rule. |
| `setAnswerFieldTarget` | **DROP (superseded)** | The singular `answerFieldTarget` it maintained does not exist here; targets are per-entry, which is the ticket's own legacy→here table. |

**Reclassified:** `handleAskAgent` was filed under the answer desk and is not
part of it — it is the CC-135 match-application click handler, already ported
as `state/match-app.ts` + `components/match-app-card.gts` under CCEXT-50.

**Deliberately NOT built: a transcript.** Doug's comment on CCEXT-45 reopened
refine-in-place vs. an accumulating transcript, on the grounds that the panel
has the vertical space for one. It stays refine-in-place for now, and the
reason it is safe to defer is that **the turn history already exists
server-side**: `Answer.question` is a FK with `related_name="answers"` and
`ordering = ["-created_at"]`, so every generate and every refine is another row
against the same Question. There is no client-side transcript to invent, and
switching to one later is a change to `components/answer-desk.gts` with no data
to migrate.

**Not verified by running it.** The gates, the type checker and the domain
tests are green; nothing here has been exercised against a real Greenhouse
form in a loaded extension. The acceptance criteria in CCEXT-45 are a
human-at-the-browser check and remain open.

### Signal ladder / match application — 22 functions (CCEXT-50, IN PROGRESS)

**Done — pure layer, `domain/ladder.ts`, 33 tests:**
`bareHost` ✅ `originOf` ✅ `collectIdTokens` ✅ `pathPrefixScore` ✅
`normalizeTitle` ✅ `titlesMatch` ✅ `hostAgrees` ✅ `pickPageTitle` ✅
(plus `verifyByToken` / `verifyByTitle` / `pickFromTrail`, extracted from
`runSignalLadder`'s inline filters so the verification rules are testable)

**Correction made while porting:** this ladder is **first-tier-wins**, not
aggregated scoring. CCEXT-32 proposes aggregation and is still Todo — a
proposal, not shipped behaviour. Building from the ticket instead of the
source would have produced a system that never existed, labelled a port.

**Done — orchestration + UI:**
`runSignalLadder` ✅ (`state/ladder.ts`, T1–T5 live, T6 seam)
`grabLadderSignals` ✅ (`injected/grab-ladder-signals.ts`, injected-gate covers it)
`maybeOfferFromLadder` ✅ `renderLadderOffer` ✅ `confirmLadderOffer` ✅
(`components/ladder-offer.gts`)

**T6 blocked on CCEXT-52** — the viewed-post trail has no data source until
that triage lands. `pickFromTrail` is written and tested; the seam returns [].
Bounded and honest: T6 never fires, so the ladder says "no match" where it
would have guessed. Fewer answers, no wrong ones.

**Remaining:**
`runSignalLadder` `grabLadderSignals` `maybeOfferFromLadder`
`renderLadderOffer` `confirmLadderOffer` `postMatchApplication`
`pollMatchApplicationOnce` `pollMatchAppOnce` `armMatchAppBackground`
`startMatchAppPolling` `stopMatchAppPolling` `maybeResumeMatchApplication`
`markMatchAppStashResult` `renderMatchResult` `collectIdTokens`
`pathPrefixScore` `hostAgrees` `titlesMatch` `normalizeTitle`
`buildJpFromIncluded` `refreshApplicationState` `rememberApplicationState`

The largest single gap, and it was missed entirely when scoping. This is how
the legacy answers "which job post does this application form belong to?" when
the URL does not match anything — evidence scoring across id tokens, path
prefixes, host agreement and title similarity. CCEXT-32 replaced a
first-tier-wins ladder with aggregated scoring. The `match-result-*` and
`ladder-offer-*` element ids are only its UI.

### Apply attribution — 9 functions (CCEXT-51, **DONE**)

**Done — the passive half, `state/apply-backfill.ts`:**
`maybeBackfillApplyUrl` ✅ — lands on a tracked page whose post has no
apply_url, reads the page's apply button, PATCHes it. Safe to run silently
because it ONLY fills an empty field: it re-checks `wouldReplaceApplyUrl`, the
same predicate the link picker uses to demand a second click, so the silent
path can never overwrite a value a human chose.

Also extracted `state/hints.ts` on the way — hint collection had been private
to SendCard, and the backfill needed the same question asked the same way. Two
copies of a rule is how this repo got two JobPost mappers that could disagree.

**Done — the active half, `domain/apply-stash.ts` + `state/apply-stash.ts`:**
`loadApplyStash` ✅ `saveApplyStash` ✅ `stashPendingApply` ✅
`clearApplyStashForJobPost` ✅ `findFreshApplyStash` ✅ (14 tests)
`backfillApplyUrlFor` ✅ — already covered by `state/apply-backfill.ts`.

Constants read from the legacy, not invented: `APPLY_STASH_MAX = 5`,
`APPLY_STASH_TTL_MS = 6h`, deduped by **origin** (not by URL) so one entry
survives per ATS you bounced through.

**`maybeOfferApplyAttribution` / `confirmApplyAttribution` are ported as a
LADDER TIER, not as a card** — the one deliberate shape change in this cluster.

The legacy needed its own card because the popup had no ladder when this was
written and no other surface could ask "which post is this?". The panel does,
and the stash is a textbook answer to exactly that question — so it enters as
`T0` (paths agree) and `T5b` (origin-only, tentative) and comes out through the
existing `<LadderOffer>`. Accepting adopts the post; `ApplicationCard`'s dedupe
lookup then surfaces the already-tracked application on its own, which is what
the legacy card was hand-rolling.

Same evidence at two positions is not hedging. A stash hit whose path agrees is
the strongest signal the ladder has — you *said* so. A bare origin match on a
shared ATS is among the weakest, and is the same shape as the Toptal misfire
`pickFromTrail` refuses outright. Running it once at either end would be wrong
in one direction or the other.

**Why this cluster was nearly dead code, and why it is worth having now:**
`stashPendingApply` fires only when the post has an `apply_url` — true for ~3
of the 100 most recent posts, because the extension-direct send path drops
`captured_payload.apply_url` entirely. api #253 and `state/apply-backfill.ts`
both close that. The stash is about to start firing for the first time.

**Original notes:**
`maybeOfferApplyAttribution` `confirmApplyAttribution` `backfillApplyUrlFor`
`maybeBackfillApplyUrl` `findFreshApplyStash` `loadApplyStash` `saveApplyStash`
`stashPendingApply` `clearApplyStashForJobPost`

Notices you followed an apply link from a known post to an ATS, and offers to
backfill the post's `apply_url` with where you actually landed. Explains why
only 3 of the 100 most recent posts have an `apply_url` at all.

### Staff / proposed post / dev-hints — 10 functions (CCEXT-49, **PARTIAL**)

**Done:** `populateDevHints` ✅ + `_setDevHint` ✅ + `profileLookupNote` ✅ —
`components/dev-hints.gts` and `domain/profile-note.ts` (5 tests).

`profileLookupNote` is the valuable half and it is pure, so it is tested. It
refuses to collapse three different outcomes into "no profile": a genuine 404
(confirmed absent, actionable — go author one), a THROTTLE or outage (not an
absence at all — wait), and a profile that EXISTS with empty selector arrays.
That last one is jobright.ai, and finding it took a curl against prod because
the panel had no way to say it.

Read on demand, not per navigation — it costs a scripting call, and the
standing rule is no extra page reads for convenience.

**Done:** `handleEnrich` ✅ `resolveProfileId` ✅ `refreshStaffFlag` ✅
(the last is `state/me.ts`'s `isStaff`).

`resolveProfileId` costs **nothing** — `extension-selectors` already returns the
profile as `data.id`, and the panel had been throwing it away. It is now carried
on `SelectorBundle.profileId`, so the sharpen action re-requests nothing.

**`handleEnrich` — ported honestly, which meant changing what it says.**
CCEXT-11 said the button was a no-op reporting success; I checked whether that
is still true rather than trusting it, and it is. `lib/tasks.py`'s
`sharpen_scrape_profile` appends a `[sharpen-request <iso>]` line to
`extraction_hints`, logs *"request recorded; awaiting enhancer pass"*, and
returns `status: "requested"`. The rewriting sits behind a comment reading
`# ENHANCER INTEGRATION POINT` and runs out-of-process, operator-driven.

**The api was never the liar** — it says "requested" and means it. The lie was
entirely presentational. `SharpenResult` therefore has no `sharpened` case to
render, so the honest wording is not a thing anyone has to remember to write.

**`pushEnrichTrace` — NOT PORTED, and it is the server that retired it.**
`meta.job_id` is now permanently `null`; the view says so in as many words —
the sharpen-status lookup is *"vestigial (retired with django_q in CC-208); the
live frontend does not poll it"*. Porting the poll loop would have queried a
dead endpoint forever and rendered the silence as progress. Found by reading
the endpoint, which is the whole argument for `CONTRACTS.md`.

**Remaining:** `renderProposedPost` `createFromProposed` `handleRecheck`

**Original notes:**
`renderProposedPost` `createFromProposed` `populateDevHints` `_setDevHint`
`handleEnrich` `pushEnrichTrace` `handleRecheck` `profileLookupNote`
`resolveProfileId` `refreshStaffFlag`

Note `handleEnrich` is a **no-op stub that reports success** in the legacy too
(CCEXT-11). Port the honest version or omit it; do not port the lie.

### Page stash / viewed posts — 10 functions (CCEXT-52, **TRIAGE COMPLETE**)

Every function has a verdict. My opening guess — that this cluster was popup
scaffolding kept alive only because the popup died on blur — was **wrong for
seven of the ten**. The panel removes the need to survive being DESTROYED. It
does not remove the need to remember something the user did minutes ago, and
that is what most of this cluster is actually for.

| Function | Verdict | Reason |
|---|---|---|
| `readPageStash` | **PORT** ✅ | in `state/tracked.ts` |
| `writePageStash` | **PORT** ✅ | in `state/tracked.ts` |
| `stashTrackedPage` | **PORT** ✅ | Proven by failure: accepting a ladder offer says "this form belongs to that post", nothing about the URL changes, so the next `refresh()` overwrote it with `none`. One step through an Ashby form lost the adoption. |
| `removePageStash` | **DROP (superseded)** | The 7-day TTL and the 50-entry cap leave it with no caller once adoption is the only writer. |
| `pickPageTitle` | **PORT** ✅ | in `domain/ladder.ts`, unit-tested — T5's og:title-vs-h1 rule. |
| `readSpaSession` | **PORT** ✅ | already in `state/session.ts:239`, same shape: scans ALL tabs for a Career Caddy tab, not just the active one. Connecting must not require standing on the app. |
| `pushViewedPost` | **PORT** ✅ | `state/viewed.ts`. Recorded whenever a post becomes this page's, by lookup or adoption. |
| `loadViewedPosts` | **PORT** ✅ | `state/viewed.ts`. **This unblocked T6**, which had been a seam returning `[]`. |
| `grabPageExcerpt` | **PORT** ✅ | `injected/grab-excerpt.ts` — and porting it CORRECTED my code (see below). |
| `importPaletteFromActiveTab` | **PORT — deferred** | Genuine feature, not scaffolding: syncs the web app's colour palette so the two surfaces match. Deliberately does NOT import light/dark mode — the panel's own toggle stays authoritative, so a site-side switch cannot override the user's choice. Not urgent; the panel already themes itself. |

**The excerpt was the useful find.** `state/match-app.ts` was calling
`page.capture()` — the full multi-frame send capture — and slicing it to 2000
chars for the CC-135 match context. Two things wrong, both fixed:

- **Top frame only.** The legacy split these deliberately: the excerpt is a
  matching *hint*, and joining every reachable frame mixes in embedded-widget
  text that makes a page harder to identify, not easier.
- **8000, not 2000.** That is the server's `MATCH_TEXT_EXCERPT_MAX`
  (`models/job_application.py:41`), which truncates anything longer. My 2000
  threw away three quarters of the context the matcher is allowed to see — on
  the tier that most needs it.

## How to work this list

1. Read the legacy function. Not the name — the body and its comments, which
   carry incident history (`jp 1532`, `CC-122`, `CCEXT-30`).
2. Port, or mark deliberately dropped **with the reason**.
3. Pure logic goes to `src/domain/` with tests. That is what makes it
   checkable rather than merely present.
4. Tick it here in the same commit.

An unticked line is unported. A line ticked "dropped" needs a reason beside it.
