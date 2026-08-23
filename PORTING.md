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
| Ported | 76 | |
| **Not yet ported** | **40** | |

Excluding the 55 the framework deletes, that is **76 of 116 real functions
done — 66%.**

Of the 40 left, **20 are the answer desk** (CCEXT-45), deliberately deferred
behind "functionality and form convergence first". The other 20 are spread
across the four sections below and counted per-section there — the ✅ marks are
the source of this table, so recount them rather than trusting the number.

## Not yet ported, by subsystem

### Answer desk — 20 functions (phase 2, CCEXT-45, known and deliberate)
`answerReuseVerdict` `autoDeliverAnswer` `ccResolveFieldInPage`
`ccWriteFieldInPage` `insertAnswerIntoField` `requestAiAnswer`
`pollAnswerUntilTerminal` `findExistingAnswer` `mintQuestion`
`handleAnswerSelected` `primeAnswerSelection` `resolveSelectionTarget`
`setAnswerFieldTarget` `maybeRestoreAnswer` `maybeResumeAnswer`
`saveAnswerResult` `clearAnswerPending` `copyAnswerToClipboard` `answerSleep`
`handleAskAgent`

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

**Remaining:** `renderProposedPost` `createFromProposed` `handleEnrich`
`pushEnrichTrace` `handleRecheck` `resolveProfileId` `refreshStaffFlag`
(`refreshStaffFlag` is effectively covered by `state/me.ts`'s `isStaff`).

⚠ `handleEnrich` is a **no-op stub that reports success** in the legacy too
(CCEXT-11). Port the honest version or omit it; do not port the lie.

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
