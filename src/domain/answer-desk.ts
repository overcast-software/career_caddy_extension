import type { ScannedField } from '../injected/resolve-field.ts';

/**
 * The answer desk's rules, with no browser under them.
 *
 * A real application form asks several questions. You fire one off, move to the
 * next while it generates, and come back to refine the first — so **each
 * question keeps its own draft and its own instruction stack.** Everything in
 * this file is the arithmetic of that: how a draft is identified, how it
 * survives a rescan, and what the model is actually told on a refine turn.
 *
 * It is pure so those rules can be tested without a page, a tab or a server.
 * The I/O is state/answer-desk.ts; the HTTP is data/answers.ts.
 */

/**
 * A question on the page, as the panel holds it.
 *
 * `ScannedField` is what the injected scanner returned; `frameId` is which
 * frame returned it. The write has to go back into the SAME frame the field
 * came from — ATS forms are routinely embedded (Greenhouse especially) and the
 * top frame has no such field — so the two travel together from here on.
 */
export type PageQuestion = ScannedField & { frameId: number };

export type DraftStatus = 'idle' | 'generating' | 'ready' | 'failed';

/** One question's state: what we asked, what came back, what to try next. */
export interface AnswerDraft {
  /** The scanned label, verbatim. What the Question was minted with. */
  label: string;
  occurrence: number;
  /**
   * The server-side Question. Minted once and REUSED for every later turn:
   * one Question with many Answers is the shape the api already has
   * (`Answer.question`, `related_name="answers"`), and it is what makes
   * favouriting the good one meaningful. Minting a second Question with
   * identical content would scatter the history instead of building it.
   */
  questionId: string | null;
  /** The Answer we are waiting on, if any. `POST /answers/` returns 202. */
  pendingAnswerId: string | null;
  /**
   * The last COMPLETED Answer's id — the row `content` came from.
   *
   * Carried so a refine can name what it is revising by reference rather than
   * by quoting it. Nothing sends this yet; see `CARRY_DRAFT_IN_PROMPT` and
   * `requestAnswer`'s `reviseAnswerId`.
   */
  answerId: string | null;
  /**
   * When that generation was requested.
   *
   * Separate from `at` on purpose. `at` is "last touched" and moves every time
   * a status line is written, which would quietly extend the resume window
   * every time the panel said anything. This one only moves when a generation
   * actually starts, so `isResumable` measures what it claims to.
   */
  pendingSince: number | null;
  /** The answer on screen. User-editable — we insert what is in the box. */
  content: string;
  /**
   * Refine instructions, oldest first, ALL still in force. "This is a Toptal
   * form, third person" stays in effect when you later say "highlight my time
   * at evendent.io". Rendered as removable chips, which is the only way to
   * take one back out.
   */
  instructions: string[];
  /**
   * What is in the one input right now, typed but not yet committed to a chip.
   *
   * Per-question, and persisted, because "switch to the next question while
   * this one generates, then come back" is the feature — and coming back to a
   * half-typed refine that has been thrown away is the popup behaviour this
   * whole surface exists to stop.
   */
  input: string;
  /** CCEXT-34 provenance: which company a REUSED answer was written for. */
  sourceCompanyId: string | null;
  sourceCompany: string | null;
  status: DraftStatus;
  /** The last thing worth telling the user about this question. */
  note: string;
  /** Last touched. Drives both the TTL and the page LRU. */
  at: number;
}

/**
 * url -> questionKey -> draft.
 *
 * **PAGE-SCOPING IS THE SHAPE, NOT A CHECK.** CCEXT-43's hardest-won lesson is
 * that the popup did correctness work for free: it died on blur, so page-scoped
 * state reset by accident. Nothing resets in a panel, which makes the URL the
 * only thing standing between question 3 of the Stripe form and the textarea on
 * the Toptal form you just switched to.
 *
 * A runtime `if (draft.url === page.url)` would be one edit away from being
 * forgotten. Nesting under the URL means there is no lookup that can return
 * another page's draft — the wrong answer is not reachable rather than merely
 * rejected.
 */
export type DraftStore = Record<string, Record<string, AnswerDraft>>;

/**
 * 24 hours. An application form is something you leave and come back to, and
 * per-URL nesting already prevents a stale draft from surfacing anywhere it
 * does not belong — so the TTL is only guarding storage growth, not
 * correctness, and can afford to be generous.
 */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** Pages remembered, newest first. Same order of magnitude as the tracked stash. */
export const DRAFT_MAX_PAGES = 20;

/**
 * How long a generation may stay resumable. Past this, a `pendingAnswerId` is
 * treated as abandoned rather than resumed — the legacy's
 * ANSWER_PENDING_MAX_AGE_MS, unchanged.
 */
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The page a draft belongs to: **origin + pathname, nothing else.**
 *
 * Keying on the raw URL was wrong and would have failed on every ATS that
 * matters. Greenhouse, Lever, Ashby and Workday all step through an
 * application with `?step=`, `?gh_src=` or `#/section/`, so a raw-URL key means
 * your drafts vanish at step 2 and the LRU fills with twenty copies of one
 * form — twenty pages of a twenty-page budget, spent on a single application.
 *
 * This is the same too-tight page-scoping `state/tracked.ts` already records
 * fixing for adoptions: *"take one step through an Ashby form and the adoption
 * is gone."* Same mistake, same shape, one rung down.
 *
 * The query string is dropped rather than normalised because no part of it is
 * identity here. `?step=2` is a position within one form, and `?gh_src=` is a
 * tracking tag that differs between two arrivals at the same posting.
 *
 * Returns `''` for anything unparseable, and callers treat that as "no scope"
 * rather than as a scope that matches other unparseable URLs — see
 * `autoInsertDecision`, which refuses on it.
 */
export function draftScopeFor(url: string): string {
  try {
    const parsed = new URL(url);
    // A trailing slash is not a different page. `/apply` and `/apply/` are one
    // form, and an ATS will happily serve both.
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * A draft's identity: **the label and which occurrence of it this is.**
 *
 * NOT the `data-cc-field` token. Tokens are regenerated on every scan and die
 * on reload, so keying on one means a draft detaches the moment the page
 * re-renders — which is exactly when you most want it back. Labels survive
 * both, so a draft re-attaches after a rescan and after an F5.
 *
 * Identical labels are NOT deduped. A form with two "Why?" boxes is asking two
 * questions and wants two answers; `occurrence` is what keeps them apart, and
 * it is stable because the scanner counts in document order.
 *
 * Lowercased and whitespace-collapsed so a trivial re-render cannot orphan a
 * draft. Two questions that differ only in capitalisation are the same
 * question; two that differ in wording get different keys, which is correct —
 * the question changed.
 */
export function questionKey(label: string, occurrence: number): string {
  const normalized = label.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200);
  return `${occurrence}|${normalized}`;
}

/** The key for a field the scanner just returned. */
export function keyOf(field: PageQuestion): string {
  return questionKey(field.label, field.occurrence);
}

/** One row of the desk: a question found on the page, plus what we know about it. */
export interface DeskEntry {
  key: string;
  field: PageQuestion;
  /** null until the question has been touched. */
  draft: AnswerDraft | null;
}

/**
 * Pair every scanned field with its draft.
 *
 * Choice controls are INCLUDED. They are classified and reported, never
 * filtered — a Yes/No dropdown you cannot see is a question you think the
 * scanner missed. What protects them is that they carry no token, so the write
 * path cannot accept one (see `ResolvedField`), not that they are hidden.
 */
export function buildEntries(
  fields: PageQuestion[],
  drafts: Record<string, AnswerDraft>,
): DeskEntry[] {
  return fields.map((field) => {
    const key = keyOf(field);
    return { key, field, draft: drafts[key] ?? null };
  });
}

/**
 * Which questions get an in-page golfer mark.
 *
 * PROSE ONLY (CCEXT-54). `kind: 'text'` is not "prose" — `fieldKind()` ends
 * `if (tag === 'INPUT' || tag === 'TEXTAREA') return 'text'`, so it covers
 * First name, Email, Phone, LinkedIn and Website too. On a stock Greenhouse
 * form that would be about six wrong marks for every right one. `control`
 * already draws the line and its own comment says so.
 *
 * `anchored` IS DELIBERATELY NOT CONSULTED, and that changed with the move to
 * a field anchor. It reported whether the scanner managed to stamp a LABEL,
 * and so it refused anchorless rungs (`aria-label`, placeholder, field name),
 * anchors inside a `<label>`, and anchors shared by two fields. None of those
 * are properties of a field: the field is exact, always present, never shared
 * and never a guess, because it already carries `data-cc-field` in order to be
 * written into.
 *
 * Leaving the clause in would have been the quiet failure — everything still
 * builds, the marks just never appear on weak-labelled questions, which is the
 * extra coverage the redirect was supposed to BUY. The panel still flags those
 * rows as having a guessed label; that is a display concern, not a paint one.
 *
 * Pure, so the rule is testable without a page.
 */
export function decorationItems(entries: DeskEntry[]): DeskEntry[] {
  return entries.filter(
    (e) =>
      e.field.kind === 'text' &&
      (e.field.control === 'textarea' || e.field.control === 'contenteditable'),
  );
}

/** A blank draft for a question that has not been asked yet. */
export function newDraft(field: PageQuestion, now: number): AnswerDraft {
  return {
    label: field.label,
    occurrence: field.occurrence,
    questionId: null,
    pendingAnswerId: null,
    pendingSince: null,
    answerId: null,
    content: '',
    instructions: [],
    input: '',
    sourceCompanyId: null,
    sourceCompany: null,
    status: 'idle',
    note: '',
    at: now,
  };
}

/**
 * Add an instruction to the stack.
 *
 * Trimmed, and a repeat of one already in force is dropped: sending the same
 * directive twice does not make the model obey it twice, and a duplicate chip
 * reads as a bug. Empty input is a no-op rather than an empty chip.
 */
export function addInstruction(instructions: string[], next: string): string[] {
  const trimmed = next.trim();
  if (!trimmed) return instructions;
  if (instructions.some((i) => i.toLowerCase() === trimmed.toLowerCase())) {
    return instructions;
  }
  return [...instructions, trimmed];
}

/** Remove one instruction by index. Out-of-range is a no-op, not a throw. */
export function removeInstruction(instructions: string[], index: number): string[] {
  if (index < 0 || index >= instructions.length) return instructions;
  return instructions.filter((_, i) => i !== index);
}

/** An answer referenced by URL in a refine instruction, once fetched. */
export interface AnswerReference {
  id: string;
  /** Needs a SECOND GET — `AnswerViewSet.retrieve` ignores `?include=question`. */
  question: string | null;
  content: string;
}

/**
 * Answer ids referenced by a Career Caddy URL in the text.
 *
 * WHY THIS EXISTS: the answer prompt's Q&A history carries only FAVORITED
 * answers. An answer you liked but did not favourite is invisible to the model,
 * so "make it more like <url>" would otherwise be an instruction about
 * something the model cannot see. Pasting the URL is how you hand it over.
 *
 * The host set is passed in rather than hardcoded — `SELF_HOSTS` in lib/api.ts
 * is the one definition of "this is us", and a second copy here is how the two
 * would eventually disagree about `www.`.
 *
 * Ids are the api's 10-char NanoIDs (CC-77), but the pattern is deliberately
 * loose about length: an id shape is the server's business, and a too-strict
 * client regex would silently ignore a URL the user pasted correctly.
 */
export function extractAnswerRefs(
  text: string,
  selfHosts: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  // Match a URL-ish run, then verify the host properly with `new URL` rather
  // than trying to spell "careercaddy.online but not evilcareercaddy.online"
  // in a regex.
  const candidates = text.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  for (const candidate of candidates) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (!selfHosts.has(parsed.hostname.toLowerCase())) continue;
    const hit = /\/answers\/([A-Za-z0-9_-]{4,64})/.exec(parsed.pathname);
    const id = hit?.[1];
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Does the refine turn carry the previous draft inside `injected_prompt`?
 *
 * **THIS IS A WORKAROUND FOR A SERVER GAP, AND IT IS NAMED SO IT CAN BE
 * DELETED IN ONE LINE.**
 *
 * `AnswerService.load_context_for_question` builds the Q&A history from
 * `question__created_by_id=user.id, favorite=True` and then
 * `.exclude(id=question.id)`. So the draft being revised is excluded twice —
 * once for being this question's, once for not being favourited — and the
 * section it would otherwise land in is labelled
 * `"## Q&A History (for reference style and tone only — do NOT answer these)"`.
 *
 * The consequence is not subtle: without this, the model never sees the text it
 * is being asked to revise, so "make it shorter" is an instruction with no
 * antecedent and it regenerates from scratch instead.
 *
 * The cost of the workaround is real and worth stating: the draft rides under a
 * heading that calls it an instruction, and it is re-sent in full every turn.
 * When the api grows a proper "here is the previous answer, revise it" section,
 * flip this to `false` and pass `reviseAnswerId` instead — `requestAnswer`
 * already takes it.
 */
export const CARRY_DRAFT_IN_PROMPT = true;

export interface PromptParts {
  /** The instruction stack, oldest first. All of it stays in force. */
  instructions: string[];
  /** The answer currently on screen. Empty on a first generation. */
  draft: string;
  /** Answers the instructions referenced by URL, already fetched. */
  references: AnswerReference[];
}

/**
 * Build the `injected_prompt` the api prepends as a PRIORITY override.
 *
 * **THE REFINE TURN CARRIES ITS OWN CONTEXT, and it has to.** Each generation
 * is a fresh Answer row against the same Question — the model is not in a
 * conversation and has no memory of what it wrote thirty seconds ago. The
 * previous draft reaches it only because this function puts it there. Without
 * that, "make it shorter" is an instruction about nothing.
 *
 * No heading of our own for the instructions themselves: the api already wraps
 * this whole string in `## User Instructions (PRIORITY — these override the
 * default behavior…)`. Adding a second frame around it would just make the
 * model read one more layer of scaffolding.
 *
 * Returns `null` when there is nothing to say — a first generation with no
 * extra instructions. Sending an empty string instead would render an empty
 * PRIORITY section, i.e. tell the model that its highest-priority directive is
 * blank.
 */
export function composeInjectedPrompt(parts: PromptParts): string | null {
  const instructions = parts.instructions.map((i) => i.trim()).filter(Boolean);
  // The one place the workaround is switched. With it off, a refine sends its
  // instructions and nothing else, and the server is expected to supply the
  // draft from `reviseAnswerId`.
  const draft = CARRY_DRAFT_IN_PROMPT ? parts.draft.trim() : '';
  if (!instructions.length && !draft && !parts.references.length) return null;

  const sections: string[] = [];

  if (draft) {
    sections.push(
      'Revise the draft answer below. Apply every instruction; they accumulate ' +
        'and all remain in force. Return ONLY the revised answer — no preamble, ' +
        'no explanation of what you changed.',
    );
  }

  if (instructions.length) {
    sections.push(
      'Instructions (oldest first, all still in force):\n' +
        instructions.map((i) => `- ${i}`).join('\n'),
    );
  }

  if (draft) {
    sections.push(`Current draft:\n${draft}`);
  }

  for (const ref of parts.references) {
    const heading = ref.question
      ? `Referenced answer (to "${ref.question}"):`
      : 'Referenced answer:';
    sections.push(`${heading}\n${ref.content}`);
  }

  return sections.join('\n\n');
}

/**
 * Drop expired drafts and cap the number of pages remembered.
 *
 * Filtered on READ as well as pruned on write, matching state/viewed.ts and
 * domain/apply-stash.ts: a write that fails to prune must not be able to
 * resurrect an expired draft, and read-time filtering makes expiry a property
 * of the rule rather than of whether some earlier write happened to run.
 *
 * A page's recency is its NEWEST draft. Keying the LRU on the oldest would
 * evict the form you are working on the moment one of its questions went cold.
 */
export function pruneStore(
  raw: unknown,
  now: number,
  ttlMs: number = DRAFT_TTL_MS,
  maxPages: number = DRAFT_MAX_PAGES,
): DraftStore {
  if (!raw || typeof raw !== 'object') return {};
  const store = raw as DraftStore;

  const pages: { url: string; drafts: Record<string, AnswerDraft>; at: number }[] = [];
  for (const url of Object.keys(store)) {
    const page = store[url];
    if (!page || typeof page !== 'object') continue;

    const kept: Record<string, AnswerDraft> = {};
    let newest = 0;
    for (const key of Object.keys(page)) {
      const draft = page[key];
      if (!draft || typeof draft.at !== 'number') continue;
      if (now - draft.at > ttlMs) continue;
      kept[key] = draft;
      if (draft.at > newest) newest = draft.at;
    }
    if (Object.keys(kept).length) pages.push({ url, drafts: kept, at: newest });
  }

  pages.sort((a, b) => b.at - a.at);
  const out: DraftStore = {};
  for (const page of pages.slice(0, maxPages)) out[page.url] = page.drafts;
  return out;
}

/**
 * Is this in-flight generation still worth resuming?
 *
 * Reconcile-on-open, not a driver: `POST /answers/` returns 202 and a
 * server-side job does the work, so the poll is a NOTIFICATION. Firing N
 * generations and reconciling them when the panel comes back is therefore
 * nearly free, which is what makes answering several questions at once
 * practical rather than merely possible.
 */
export function isResumable(draft: AnswerDraft, now: number): boolean {
  if (!draft.pendingAnswerId) return false;
  // A draft written before this field existed has no start time. Resume it
  // rather than stranding an in-flight answer over a schema detail.
  if (draft.pendingSince === null) return true;
  return now - draft.pendingSince <= PENDING_MAX_AGE_MS;
}
