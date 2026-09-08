import { request } from '../lib/api.ts';
import type { JsonApiDoc, JsonApiListDoc, JsonApiResource } from '../lib/api.ts';

/**
 * Questions and answers over HTTP.
 *
 * Four calls make the answer desk work, and the order matters:
 *
 *   1. `findSavedAnswer`  — free. You may already have written this one.
 *   2. `mintQuestion`     — once per question, then reused for every turn.
 *   3. `requestAnswer`    — returns **202**; a server-side job does the work.
 *   4. `readAnswer`       — the poll. A NOTIFICATION, not a driver: nothing
 *                           depends on the panel being open for the answer to
 *                           finish, which is what makes firing several at once
 *                           nearly free.
 *
 * `injected_prompt` is the whole point of step 3 and the api has accepted it
 * all along — `AnswerViewSet.create` reads it from four nesting levels and
 * `ApplicationPromptBuilder` prepends it as a PRIORITY override. The extension
 * had simply never sent one. **No api change was needed for any of this.**
 */

interface AnswerAttrs {
  content?: string | null;
  status?: string | null;
  favorite?: boolean;
}

interface QuestionAttrs {
  content?: string | null;
}

/** A previously written answer, with the provenance CCEXT-34 needs. */
export interface SavedAnswer {
  id: string;
  content: string;
  /** Which company it was written for, when the api can tell us. */
  sourceCompanyId: string | null;
  sourceCompany: string | null;
}

/**
 * "Have I answered this before?"
 *
 * `filter[query]` matches the answer's content OR its question's content, so
 * the question text is the right thing to send. The api has no `favorite`
 * query param, so a favourite is preferred client-side; failing that, the most
 * recent answer that actually has content.
 *
 * CCEXT-34: carry the answer's PROVENANCE. Saved answers are matched on
 * question TEXT, and question text repeats across employers, so a reused answer
 * can name the wrong company. The included question already rides in this
 * response — reading its company relationship costs nothing.
 */
export async function findSavedAnswer(
  apiKey: string,
  questionText: string,
): Promise<SavedAnswer | null> {
  const path =
    `/api/v1/answers/?filter%5Bquery%5D=${encodeURIComponent(questionText)}` +
    `&include=question`;
  const resp = await request<JsonApiListDoc<AnswerAttrs>>(path, {
    token: apiKey,
    timeoutMs: 8000,
  });
  if (!resp.ok) return null;

  const rows = resp.data?.data ?? [];
  const withContent = rows.filter((r) => !!r.attributes?.content?.trim());
  const chosen = withContent.find((r) => r.attributes?.favorite === true) ?? withContent[0];
  if (!chosen) return null;

  const included = resp.data?.included ?? [];
  const questionRel = chosen.relationships?.['question']?.data ?? null;
  const question = questionRel
    ? included.find(
        (r) =>
          (r.type === 'question' || r.type === 'questions') &&
          String(r.id) === String(questionRel.id),
      )
    : undefined;
  const companyRel = question?.relationships?.['company']?.data ?? null;
  const company = companyRel
    ? included.find(
        (r) =>
          (r.type === 'company' || r.type === 'companies') &&
          String(r.id) === String(companyRel.id),
      )
    : undefined;

  return {
    id: String(chosen.id),
    content: String(chosen.attributes?.content ?? ''),
    sourceCompanyId: companyRel ? String(companyRel.id) : null,
    sourceCompany: (company?.attributes as { name?: string })?.name ?? null,
  };
}

/** Context to hang a new Question off. Every field is optional. */
export interface QuestionContext {
  jobPostId?: string | null;
  applicationId?: string | null;
  companyId?: string | null;
}

/**
 * Mint the Question. Once per question — every later turn is another Answer
 * against this same id.
 *
 * CCEXT-10: attaching the tracked JobPost (and its application) records the
 * question against the post AND feeds the job description into the answer
 * prompt. CCEXT-23: a post is CONTEXT, not a precondition — `Question.job_post`
 * is nullable and the relationship is simply omitted when there is no match,
 * because application forms usually live on a different URL than the posting.
 *
 * CCEXT-28: the company is attached DIRECTLY as well as via the post.
 * `AnswerService` resolves it from `question.company_id` OR `job_post.company_id`,
 * and the prompt renders name, display name and company notes — so a company is
 * worth having on the Question in its own right, and it then survives the post
 * relationship never being set or later being cleared.
 */
export async function mintQuestion(
  apiKey: string,
  content: string,
  context: QuestionContext = {},
): Promise<string | null> {
  const relationships: Record<string, { data: { type: string; id: string } }> = {};
  if (context.jobPostId) {
    relationships['job-post'] = {
      data: { type: 'job-post', id: String(context.jobPostId) },
    };
  }
  if (context.applicationId) {
    relationships['application'] = {
      data: { type: 'job-application', id: String(context.applicationId) },
    };
  }
  if (context.companyId) {
    relationships['company'] = {
      data: { type: 'company', id: String(context.companyId) },
    };
  }

  const data: Record<string, unknown> = { type: 'question', attributes: { content } };
  if (Object.keys(relationships).length) data['relationships'] = relationships;

  const resp = await request<JsonApiDoc<QuestionAttrs>>('/api/v1/questions/', {
    method: 'POST',
    token: apiKey,
    body: { data },
    timeoutMs: 12000,
  });
  return resp.ok && resp.data?.data?.id ? String(resp.data.data.id) : null;
}

export type RequestAnswerResult =
  | { ok: true; answerId: string }
  | { ok: false; error: string };

export interface RequestAnswerOptions {
  /** The PRIORITY override. Omitted when null. */
  injectedPrompt?: string | null;
  /**
   * The Answer this one revises.
   *
   * **Accepted here and deliberately NOT put on the wire yet** — the api has no
   * field for it, and sending an attribute the serializer ignores would look
   * like a working contract while changing nothing. It is in the signature now,
   * while there is exactly one call site, so that adopting the real contract is
   * a one-line diff in this function rather than a change that ripples back
   * through the state layer. See `CARRY_DRAFT_IN_PROMPT`.
   */
  reviseAnswerId?: string | null;
}

/**
 * Ask for an AI answer. Returns 202 and a pending Answer to poll.
 *
 * `injected_prompt` goes in `attributes` — the api reads it from there first.
 * It is omitted entirely when null rather than sent as an empty string, which
 * would render an empty PRIORITY section, i.e. tell the model its
 * highest-priority directive is blank.
 *
 * An options object rather than positional args, chosen while the call count is
 * one: the next parameter this grows is a server-side revise reference, and a
 * third boolean-ish positional would be unreadable at the call site.
 */
export async function requestAnswer(
  apiKey: string,
  questionId: string,
  options: RequestAnswerOptions = {},
): Promise<RequestAnswerResult> {
  const { injectedPrompt = null } = options;
  const attributes: Record<string, unknown> = { ai_assist: true };
  if (injectedPrompt) attributes['injected_prompt'] = injectedPrompt;
  // `options.reviseAnswerId` is intentionally unread — see the type above.

  const resp = await request<JsonApiDoc<AnswerAttrs>>('/api/v1/answers/', {
    method: 'POST',
    token: apiKey,
    body: {
      data: {
        type: 'answer',
        attributes,
        relationships: {
          question: { data: { type: 'question', id: String(questionId) } },
        },
      },
    },
    timeoutMs: 15000,
  });

  if (!resp.ok) return { ok: false, error: resp.error };
  const id = resp.data?.data?.id;
  if (!id) return { ok: false, error: 'Career Caddy did not return an answer id.' };
  return { ok: true, answerId: String(id) };
}

export interface AnswerSnapshot {
  id: string;
  status: string;
  content: string;
  questionId: string | null;
}

/**
 * Read one answer.
 *
 * Returns null on ANY failure, including a network blip — the caller keeps
 * polling until its cap rather than reporting a dropped packet as a failed
 * generation.
 */
export async function readAnswer(
  apiKey: string,
  answerId: string,
): Promise<AnswerSnapshot | null> {
  const resp = await request<JsonApiDoc<AnswerAttrs>>(`/api/v1/answers/${answerId}/`, {
    token: apiKey,
    timeoutMs: 10000,
  });
  if (!resp.ok || !resp.data?.data) return null;
  const row: JsonApiResource<AnswerAttrs> = resp.data.data;
  const questionRel = row.relationships?.['question']?.data ?? null;
  return {
    id: String(row.id),
    status: String(row.attributes?.status ?? ''),
    content: String(row.attributes?.content ?? ''),
    questionId: questionRel ? String(questionRel.id) : null,
  };
}

/**
 * The text of a question, by id.
 *
 * A SEPARATE CALL on purpose, and not an oversight: `AnswerViewSet.retrieve`
 * ignores `?include=question` outright (`questions.py:487-492` returns
 * `{"data": ser.to_resource(obj)}` with no `included` branch at all). Asking
 * for the sideload and reading nothing would look like an api bug forever;
 * asking twice is honest about what the endpoint does.
 */
export async function readQuestionText(
  apiKey: string,
  questionId: string,
): Promise<string | null> {
  const resp = await request<JsonApiDoc<QuestionAttrs>>(
    `/api/v1/questions/${questionId}/`,
    { token: apiKey, timeoutMs: 8000 },
  );
  if (!resp.ok) return null;
  const content = resp.data?.data?.attributes?.content;
  return content ? String(content) : null;
}
