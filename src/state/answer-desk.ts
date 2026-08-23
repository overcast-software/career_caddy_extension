import { tracked } from '@glimmer/tracking';
import {
  findSavedAnswer,
  mintQuestion,
  readAnswer,
  readQuestionText,
  requestAnswer,
} from '../data/answers.ts';
import {
  addInstruction,
  buildEntries,
  composeInjectedPrompt,
  draftScopeFor,
  extractAnswerRefs,
  isResumable,
  keyOf,
  newDraft,
  pruneStore,
  removeInstruction,
} from '../domain/answer-desk.ts';
import type {
  AnswerDraft,
  AnswerReference,
  DeskEntry,
  DraftStore,
  PageQuestion,
} from '../domain/answer-desk.ts';
import { autoInsertDecision } from '../domain/answer-reuse.ts';
import { SELF_HOSTS } from '../lib/api.ts';
import { application } from './application.ts';
import { errorLog } from './errors.ts';
import { page } from './page.ts';
import { session, KEYS } from './session.ts';
import { trackedPost } from './tracked.ts';

/**
 * The answer desk.
 *
 * **This is why the side panel exists.** A real application form asks several
 * questions; you fire one off, flip to the next while it generates, and come
 * back to refine the first. That is not a workflow a popup can host — it dies
 * the moment you click into the page to read the next question.
 *
 * ── PER-QUESTION FROM THE START ────────────────────────────────────────────
 *
 * The legacy answer card had ONE of everything: one `answerPolling` boolean,
 * one `answerFieldTarget`, one `ccAnswerPending` + one `ccAnswerResult`. Here
 * every one of those is per-question, and it was built that way rather than
 * grown that way — a singular version would have had to be taken apart again,
 * and the halfway state (one draft, several fields) is worse than either end.
 *
 * ── THE PARALLELISM IS ALMOST FREE ─────────────────────────────────────────
 *
 * `POST /answers/` returns 202 and a server-side job does the work, so the poll
 * is a NOTIFICATION, not a driver. Nothing depends on the panel watching. Fire
 * N, remember N ids, reconcile when you next look. A poll that stops because
 * you navigated away has not cancelled anything; the answer still lands, and
 * `reconcile()` picks it up when you come back.
 *
 * ── PAGE SCOPING IS THE HARD PART, AND IT GOT HARDER ───────────────────────
 *
 * See domain/answer-desk.ts for why the store nests under a page SCOPE. The
 * short version: in a popup, navigating away reset this by accident. Nothing
 * resets in a panel, so the scope is the only thing between question 3 of the
 * Stripe form and the textarea on the Toptal form you just switched to.
 *
 * Scope is `origin + pathname` — deliberately looser than the raw URL, because
 * every ATS worth supporting steps through an application with `?step=` or
 * `#/section/`, and a raw-URL key loses your drafts at step 2.
 */

const STORE_KEY: string = KEYS.answerDrafts;

/** Same cadence as state/score.ts and the legacy answer poll. */
const POLL_MS = 2500;
/** ~2 minutes, then say so rather than spin forever. */
const MAX_POLLS = 48;
/** Storage is a safety net here, not the architecture — batch the writes. */
const PERSIST_DEBOUNCE_MS = 400;

export type ScanState = 'idle' | 'scanning' | 'done' | 'blocked';

class AnswerDesk {
  /** Questions found on the page, in document order. Choice controls included. */
  @tracked fields: PageQuestion[] = [];
  @tracked scanState: ScanState = 'idle';
  @tracked scanNote = '';
  /** The question currently open in the editor. */
  @tracked selectedKey: string | null = null;

  /**
   * Drafts FOR THE CURRENT PAGE ONLY.
   *
   * The full store is nested by URL on disk; this is the one page's slice,
   * swapped wholesale on navigation. Nothing here can be another page's.
   */
  @tracked drafts: Record<string, AnswerDraft> = {};

  /**
   * The SCOPE `drafts` belongs to — origin + pathname, not the raw URL.
   *
   * Every write and every staleness check re-derives from this, so a Workday
   * `?step=2` keeps its drafts and its in-flight generations instead of
   * abandoning both at the page you were halfway through.
   */
  private scope = '';
  /** Tokens already auto-delivered, so one field is never written twice. */
  private delivered = new Map<string, string>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;

  get entries(): DeskEntry[] {
    return buildEntries(this.fields, this.drafts);
  }

  get selected(): DeskEntry | null {
    return this.entries.find((e) => e.key === this.selectedKey) ?? null;
  }

  /** How many questions are generating right now — the parallelism, visible. */
  get generatingCount(): number {
    return Object.values(this.drafts).filter((d) => d.status === 'generating').length;
  }

  // ── page lifecycle ───────────────────────────────────────────────────────

  /**
   * Swap to this page's drafts and pick up anything that finished while we
   * were elsewhere.
   *
   * Deliberately does NOT scan. Scanning costs a scripting call on every
   * navigation, and the standing rule is no extra page reads for convenience —
   * the user asks for the question list by opening the desk.
   */
  async onPageChange(): Promise<void> {
    // Write the OUTGOING page's drafts before touching anything. Persistence
    // is debounced, so a navigation inside that window would otherwise write
    // the old page's drafts under the new page's URL — the exact
    // cross-contamination the nesting exists to prevent.
    await this.flushPersist();

    const url = page.url;
    const scope = draftScopeFor(url);

    // Cleared even when the SCOPE is unchanged. A step change within one form
    // is still a new DOM: every token was regenerated, so the stamps we hold
    // are dead and the delivered-token guard is about fields that no longer
    // exist. The drafts survive; the page-side handles do not.
    this.fields = [];
    this.selectedKey = null;
    this.scanState = 'idle';
    this.scanNote = '';
    this.delivered.clear();

    const drafts = await this.readPage(scope);
    if (page.url !== url) return; // superseded while we read

    // `scope` and `drafts` are assigned together, with no await between them.
    // Anything that reads one and then the other must never see a pair from
    // two different pages.
    this.scope = scope;
    this.drafts = drafts;
    void this.reconcile();
  }

  /** Find the questions. The one deliberate page read this surface makes. */
  async scan(): Promise<void> {
    const startedUrl = page.url;
    this.scanState = 'scanning';
    this.scanNote = '';

    const fields = await page.scanQuestions();
    if (startedUrl !== page.url) return; // superseded by a navigation

    this.fields = fields;
    this.scanState = fields.length ? 'done' : 'blocked';

    if (!fields.length) {
      // CCEXT-41: a cross-origin frame is a PERMISSION BOUNDARY, not a mistake
      // the user can correct by trying harder. Saying "no questions found"
      // when the truth is "this form is somewhere I am not allowed to look" is
      // the worst possible diagnostic — it reads as "you did it wrong".
      const blocked = await page.countBlockedFrames();
      this.scanNote =
        blocked > 0
          ? "This form is inside an embedded frame the extension can't read. Generate the answer here and copy it across."
          : 'No labelled questions found on this page.';
      return;
    }

    // Keep the same question selected if it is still on the page. It will be:
    // the key is the label, so a re-render that regenerated every token still
    // produces the same key — which is the whole reason the key is not the
    // token. Only if the question genuinely went away do we move.
    const keys = new Set(fields.map(keyOf));
    if (!this.selectedKey || !keys.has(this.selectedKey)) {
      // Open on something answerable. A form whose first control is a Yes/No
      // dropdown would otherwise greet you with the one question this surface
      // cannot help with.
      const firstWritable = fields.find((f) => f.kind === 'text');
      this.selectedKey = keyOf(firstWritable ?? fields[0]!);
    }
  }

  select = (key: string): void => {
    this.selectedKey = key;
  };

  // ── editing ──────────────────────────────────────────────────────────────

  /** The one input's text, for one question. */
  setInput(key: string, value: string): void {
    this.mutate(key, (draft) => ({ ...draft, input: value }));
  }

  /** The answer textarea. We insert what is in the box, not what came back. */
  setContent(key: string, value: string): void {
    this.mutate(key, (draft) => ({ ...draft, content: value }));
  }

  dropInstruction(key: string, index: number): void {
    this.mutate(key, (draft) => ({
      ...draft,
      instructions: removeInstruction(draft.instructions, index),
    }));
  }

  // ── generating ───────────────────────────────────────────────────────────

  /**
   * Answer this question, or refine the answer already here.
   *
   * ONE ACTION, TWO IDENTITIES, and the difference is whether a draft already
   * has content. Before an answer, the input is a prompt box and this is
   * "Answer". After one, the input is a refine box and this is "Refine". The
   * instruction stack accumulates either way — that is what makes "this is a
   * Toptal form, third person" stay in force when you later say "highlight my
   * time at evendent.io".
   */
  async run(key: string): Promise<void> {
    // Two values, deliberately. `startedScope` decides whether this run is
    // still relevant (a step change is not a new page). `startedUrl` is the raw
    // URL handed to autoInsertDecision, which scopes it itself — passing an
    // already-scoped value there would hide which comparison is being made.
    const startedUrl = page.url;
    const startedScope = draftScopeFor(startedUrl);
    if (!session.apiKey) {
      this.mutate(key, (d) => ({ ...d, status: 'failed', note: 'Not connected.' }));
      return;
    }

    const entry = this.entries.find((e) => e.key === key);
    if (!entry) return;

    // Commit whatever is in the input as an instruction first, so a refine
    // typed and immediately submitted is not lost.
    this.mutate(key, (draft) => ({
      ...draft,
      instructions: addInstruction(draft.instructions, draft.input),
      input: '',
      status: 'generating',
      note: '',
    }));

    const draft = this.drafts[key];
    if (!draft) return;

    // A first answer gets the free lookup: you may already have written this
    // one. A refine never does — the whole request is "give me a different
    // one", and handing back the same saved answer is the opposite of that.
    if (!draft.content && !draft.instructions.length) {
      const saved = await findSavedAnswer(session.apiKey, draft.label);
      if (this.stale(key, startedScope)) return;
      if (saved?.content) {
        this.mutate(key, (d) => ({
          ...d,
          answerId: saved.id,
          content: saved.content,
          sourceCompanyId: saved.sourceCompanyId,
          sourceCompany: saved.sourceCompany,
          status: 'ready',
          note: 'Matched a saved answer.',
        }));
        await this.maybeAutoInsert(key, startedUrl);
        return;
      }
    }

    const questionId = draft.questionId ?? (await this.mint(key, draft.label));
    if (this.stale(key, startedScope)) return;
    if (!questionId) {
      this.fail(key, 'Could not create the question.');
      return;
    }

    const references = await this.resolveReferences(draft.instructions);
    if (this.stale(key, startedScope)) return;

    const injected = composeInjectedPrompt({
      instructions: draft.instructions,
      draft: draft.content,
      references,
    });

    const started = await requestAnswer(session.apiKey, questionId, {
      injectedPrompt: injected,
      // Named now, sent never — `requestAnswer` drops it until the api has a
      // field for it. This is the seam that makes adopting the real revise
      // contract a one-line change there rather than a change here.
      reviseAnswerId: draft.answerId,
    });
    if (this.stale(key, startedScope)) return;
    if (!started.ok) {
      this.fail(key, started.error);
      return;
    }

    this.mutate(key, (d) => ({
      ...d,
      pendingAnswerId: started.answerId,
      pendingSince: Date.now(),
    }));
    await this.poll(key, started.answerId, startedScope);
  }

  /**
   * Pick up generations that finished while the panel was looking elsewhere.
   *
   * This is the reconcile-on-open half of "the poll is a notification". A
   * generation whose poll stopped is not cancelled — the server finished it
   * regardless, and the id was written down.
   */
  async reconcile(): Promise<void> {
    if (!session.apiKey) return;
    const startedScope = draftScopeFor(page.url);
    const now = Date.now();

    for (const [key, draft] of Object.entries(this.drafts)) {
      if (!draft.pendingAnswerId) continue;
      if (!isResumable(draft, now)) {
        // Abandoned rather than resumed: past ten minutes an unfinished
        // generation is more likely to be a dead job than a slow one, and a
        // spinner that never resolves is worse than an honest stop.
        this.mutate(key, (d) => ({
          ...d,
          pendingAnswerId: null,
          pendingSince: null,
          status: d.content ? 'ready' : 'idle',
          note: d.content ? d.note : 'That generation was abandoned — try again.',
        }));
        continue;
      }
      void this.poll(key, draft.pendingAnswerId, startedScope);
    }
  }

  // ── delivery ─────────────────────────────────────────────────────────────

  /**
   * Write the answer into the page.
   *
   * Takes a key rather than a field, and re-reads the live entry, because the
   * page may have re-rendered since the picker was drawn. The type system
   * refuses a write to a choice control; this narrows to the text arm to
   * satisfy it, which is the narrowing doing its job rather than ceremony.
   */
  async insert(key: string, successNote = 'Inserted into the page.'): Promise<void> {
    const entry = this.entries.find((e) => e.key === key);
    const draft = this.drafts[key];
    if (!entry || !draft) return;

    const value = draft.content.trim();
    if (!value) return;

    if (entry.field.kind !== 'text') {
      this.note(key, `That is a ${entry.field.control} — copy the answer instead.`);
      return;
    }

    const outcome = await page.writeField(entry.field.frameId, entry.field.token, value);
    if (outcome.ok) {
      this.note(key, successNote);
      return;
    }

    // The page dropped our stamp. Rescanning is the honest recovery — writing
    // into whatever now occupies that position is how an answer lands in
    // someone else's box.
    this.note(key, 'The field moved — rescan, then Insert.');
    this.scanState = 'idle';
  }

  async copy(key: string): Promise<void> {
    const draft = this.drafts[key];
    if (!draft?.content) return;
    try {
      await navigator.clipboard.writeText(draft.content);
      this.note(key, 'Copied.');
    } catch {
      // Clipboard writes need a focused document; a panel that has lost focus
      // fails here, and silently doing nothing would read as a dead button.
      this.note(key, "Copy failed — the panel needs focus. Select the text instead.");
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async mint(key: string, label: string): Promise<string | null> {
    if (!session.apiKey) return null;
    const post = trackedPost.post;
    const id = await mintQuestion(session.apiKey, label, {
      jobPostId: post?.id ?? null,
      // Already known: ApplicationCard's dedupe lookup runs on render, so the
      // application id is in hand. Asking the server again would be an extra
      // round trip for a fact we have.
      applicationId: application.appId,
      companyId: post?.companyId ?? null,
    });
    if (id) this.mutate(key, (d) => ({ ...d, questionId: id }));
    return id;
  }

  /**
   * Fetch any answers the instructions referenced by URL.
   *
   * Two GETs per reference, because `AnswerViewSet.retrieve` ignores
   * `?include=question` — see data/answers.ts. The question text is worth the
   * second call: an answer with no question attached reads to the model as a
   * paragraph with no purpose.
   */
  private async resolveReferences(instructions: string[]): Promise<AnswerReference[]> {
    if (!session.apiKey) return [];
    const ids = extractAnswerRefs(instructions.join('\n'), SELF_HOSTS);
    const out: AnswerReference[] = [];
    for (const id of ids) {
      const answer = await readAnswer(session.apiKey, id);
      if (!answer?.content) continue;
      const question = answer.questionId
        ? await readQuestionText(session.apiKey, answer.questionId)
        : null;
      out.push({ id, question, content: answer.content });
    }
    return out;
  }

  /**
   * Watch one answer land.
   *
   * The guard is the draft itself: if this key's `pendingAnswerId` is no longer
   * ours, a newer request superseded us; if the URL moved, we are watching for
   * a page nobody is looking at. Either way stop rendering — but leave the id
   * in storage, because the generation is still running and `reconcile()` is
   * how it comes home.
   */
  private async poll(key: string, answerId: string, startedScope: string): Promise<void> {
    if (!session.apiKey) return;

    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await sleep(POLL_MS);
      if (this.stale(key, startedScope)) return;
      if (this.drafts[key]?.pendingAnswerId !== answerId) return;

      const snapshot = await readAnswer(session.apiKey, answerId);
      if (this.stale(key, startedScope)) return;
      if (this.drafts[key]?.pendingAnswerId !== answerId) return;

      // A transient failure is not a terminal one — keep polling to the cap
      // rather than reporting a network blip as a failed answer.
      if (!snapshot) continue;

      if (snapshot.status === 'completed') {
        this.mutate(key, (d) => ({
          ...d,
          pendingAnswerId: null,
          pendingSince: null,
          // The row this text came from, so the NEXT refine can name it by
          // reference once the api can take one.
          answerId: snapshot.id,
          content: snapshot.content,
          status: 'ready',
          // A FRESH generation is never auto-inserted, so there is nothing to
          // say about placement — only that it is here and yours to read.
          note: 'Generated — read it, then Insert.',
          // Its provenance is this session, not a saved answer's.
          sourceCompanyId: null,
          sourceCompany: null,
        }));
        return;
      }

      if (snapshot.status === 'failed') {
        this.fail(key, 'Answer generation failed — try again.');
        return;
      }
    }

    // Hit the cap without a terminal state. The id stays, so reconcile() will
    // pick it up rather than the work being lost.
    this.note(key, 'Still generating — it will appear when you come back.');
  }

  /**
   * Place a REUSED answer without making the user ask for it.
   *
   * Only ever for an answer we already had. A freshly generated one is never
   * placed automatically: the user should read what the model wrote before it
   * lands in something they are about to submit. Every other condition —
   * page, field, existing text, company provenance — is decided by one pure
   * function so it can be tested rather than trusted.
   */
  private async maybeAutoInsert(key: string, startedUrl: string): Promise<void> {
    const entry = this.entries.find((e) => e.key === key) ?? null;
    const draft = this.drafts[key];
    if (!draft) return;

    const decision = autoInsertDecision({
      source: {
        sourceCompanyId: draft.sourceCompanyId,
        sourceCompany: draft.sourceCompany,
      },
      hereCompanyId: trackedPost.post?.companyId ?? null,
      content: draft.content,
      draftUrl: startedUrl,
      pageUrl: page.url,
      field: entry?.field ?? null,
      deliveredToken: this.delivered.get(key) ?? null,
    });

    if (!decision.insert) {
      if (decision.note) this.note(key, decision.note);
      return;
    }

    this.delivered.set(key, decision.token);
    // The reuse note wins over "Inserted": CCEXT-34's whole point is that a
    // possibly company-specific line must not land SILENTLY. Placement is
    // automatic; visibility is the guard.
    await this.insert(
      key,
      decision.note || 'Your saved answer is in the form — Refine for a new one.',
    );
  }

  /**
   * Has this draft been superseded, or the page moved out from under it?
   *
   * Scope, not raw URL — a Workday step change must not abandon a generation
   * that is already running for a question still on screen. Both the live page
   * AND `this.scope` are checked because `onPageChange` awaits storage between
   * learning the new URL and adopting it; during that window the two disagree,
   * and this is the guard that must not be fooled by either half.
   */
  private stale(key: string, startedScope: string): boolean {
    return (
      startedScope !== draftScopeFor(page.url) ||
      startedScope !== this.scope ||
      !this.drafts[key]
    );
  }

  private fail(key: string, message: string): void {
    this.mutate(key, (d) => ({
      ...d,
      pendingAnswerId: null,
      pendingSince: null,
      status: 'failed',
      note: message,
    }));
    errorLog.record('answer', message, page.host);
  }

  private note(key: string, message: string): void {
    this.mutate(key, (d) => ({ ...d, note: message }));
  }

  /**
   * The single write path for a draft.
   *
   * Every change goes through here, so there is one place that creates a
   * missing draft, stamps `at`, replaces the map (autotracking fires on
   * reassignment, not mutation) and schedules the persist. A direct
   * `this.drafts[key].x = y` would do none of those and would not re-render.
   */
  private mutate(key: string, change: (draft: AnswerDraft) => AnswerDraft): void {
    const field = this.fields.find((f) => keyOf(f) === key);
    const existing = this.drafts[key] ?? (field ? newDraft(field, Date.now()) : null);
    if (!existing) return;
    const next = { ...change(existing), at: Date.now() };
    this.drafts = { ...this.drafts, [key]: next };
    this.schedulePersist();
  }

  private schedulePersist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => void this.persist(), PERSIST_DEBOUNCE_MS);
  }

  /** Write now, cancelling any pending debounce. Used before a page swap. */
  private async flushPersist(): Promise<void> {
    if (this.persistTimer === undefined) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.persistTimer = undefined;
    const scope = this.scope;
    if (!scope) return;
    try {
      const saved = await chrome.storage.local.get([STORE_KEY]);
      const store = pruneStore(saved[STORE_KEY], Date.now());
      store[scope] = this.drafts;
      await chrome.storage.local.set({ [STORE_KEY]: pruneStore(store, Date.now()) });
    } catch {
      /* the drafts still stand for this session; only their persistence is lost */
    }
  }

  private async readPage(scope: string): Promise<Record<string, AnswerDraft>> {
    if (!scope) return {};
    try {
      const saved = await chrome.storage.local.get([STORE_KEY]);
      const store: DraftStore = pruneStore(saved[STORE_KEY], Date.now());
      return store[scope] ?? {};
    } catch {
      return {};
    }
  }

  /** Called once when the panel boots, so a reload lands on its own drafts. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.onPageChange();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const answerDesk = new AnswerDesk();

/**
 * Registered here rather than in the workbench, per CCEXT-43's rule: a
 * page-scoped module owns its own reset. Centralising that knowledge in the
 * workbench is how one gets forgotten — and a forgotten reset on THIS module
 * is an answer written for one employer offered into another's form.
 */
page.onChange(() => void answerDesk.onPageChange());
