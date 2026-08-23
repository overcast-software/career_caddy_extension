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
| Ported | 45 | |
| **Not yet ported** | **71** | |

Excluding the 55 the framework deletes, that is **45 of 116 real functions
done — 39%.**

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

### Apply attribution — 9 functions
`maybeOfferApplyAttribution` `confirmApplyAttribution` `backfillApplyUrlFor`
`maybeBackfillApplyUrl` `findFreshApplyStash` `loadApplyStash` `saveApplyStash`
`stashPendingApply` `clearApplyStashForJobPost`

Notices you followed an apply link from a known post to an ATS, and offers to
backfill the post's `apply_url` with where you actually landed. Explains why
only 3 of the 100 most recent posts have an `apply_url` at all.

### Staff / proposed post / dev-hints — 10 functions
`renderProposedPost` `createFromProposed` `populateDevHints` `_setDevHint`
`handleEnrich` `pushEnrichTrace` `handleRecheck` `profileLookupNote`
`resolveProfileId` `refreshStaffFlag`

Note `handleEnrich` is a **no-op stub that reports success** in the legacy too
(CCEXT-11). Port the honest version or omit it; do not port the lie.

### Page stash / viewed posts — 10 functions
`readPageStash` `writePageStash` `removePageStash` `stashTrackedPage`
`pushViewedPost` `loadViewedPosts` `importPaletteFromActiveTab`
`readSpaSession` `grabPageExcerpt` `pickPageTitle`

Some of this is genuinely obsolete: the stash existed so a popup that dies on
blur could remember across a re-open. A panel does not need it. **Decide per
function whether the panel makes it unnecessary — and record the decision, so
"dropped deliberately" stays distinguishable from "forgotten".**

## Tickets

| Subsystem | Ticket | Functions |
|---|---|---|
| Signal ladder / match application | **CCEXT-50** | 22 |
| Apply attribution | **CCEXT-51** | 9 |
| Page stash / viewed posts (triage) | **CCEXT-52** | 10 |
| Answer desk | CCEXT-45 | 20 |
| Staff / proposed / dev-hints | CCEXT-49 | 10 |

Epic: **CCEXT-43**.

## How to work this list

1. Read the legacy function. Not the name — the body and its comments, which
   carry incident history (`jp 1532`, `CC-122`, `CCEXT-30`).
2. Port, or mark deliberately dropped **with the reason**.
3. Pure logic goes to `src/domain/` with tests. That is what makes it
   checkable rather than merely present.
4. Tick it here in the same commit.

An unticked line is unported. A line ticked "dropped" needs a reason beside it.
