import { describe, it, expect } from 'vitest';
import {
  CARRY_DRAFT_IN_PROMPT,
  DRAFT_TTL_MS,
  PENDING_MAX_AGE_MS,
  addInstruction,
  buildEntries,
  composeInjectedPrompt,
  draftScopeFor,
  extractAnswerRefs,
  isResumable,
  keyOf,
  newDraft,
  pruneStore,
  questionKey,
  removeInstruction,
  type AnswerDraft,
  type DraftStore,
  type PageQuestion,
} from '../answer-desk.ts';

const NOW = 1_700_000_000_000;
const SELF_HOSTS = new Set(['careercaddy.online', 'www.careercaddy.online']);

function textField(over: Partial<PageQuestion> = {}): PageQuestion {
  return {
    kind: 'text',
    token: 'cc-abc123-x',
    control: 'textarea',
    existing: '',
    how: 'its label',
    weak: false,
    label: 'Why do you want to work here?',
    occurrence: 0,
    frameId: 0,
    ...over,
  } as PageQuestion;
}

function choiceField(over: Partial<PageQuestion> = {}): PageQuestion {
  return {
    kind: 'choice',
    token: null,
    control: 'select',
    options: ['Yes', 'No'],
    how: 'its label',
    weak: false,
    label: 'Are you authorized to work in the US?',
    occurrence: 0,
    frameId: 0,
    ...over,
  } as PageQuestion;
}

function draft(over: Partial<AnswerDraft> = {}): AnswerDraft {
  return {
    ...newDraft(textField(), NOW),
    ...over,
  };
}

describe('draftScopeFor', () => {
  it('drops the query — `?step=2` is a position in one form, not a new page', () => {
    // The bug this fixes: Greenhouse, Lever, Ashby and Workday all step
    // through an application with a query param. Keying on the raw URL means
    // your drafts vanish at step 2 and the LRU fills with 20 copies of one
    // form. state/tracked.ts records the identical fix for adoptions.
    expect(draftScopeFor('https://ats.example/acme/apply?step=2')).toEqual(
      draftScopeFor('https://ats.example/acme/apply'),
    );
  });

  it('drops the fragment — SPA ATSes step with `#/section/`', () => {
    expect(draftScopeFor('https://ats.example/acme/apply#/section/3')).toEqual(
      draftScopeFor('https://ats.example/acme/apply'),
    );
  });

  it('drops a tracking tag that differs between two arrivals at one posting', () => {
    expect(draftScopeFor('https://ats.example/acme/apply?gh_src=abc')).toEqual(
      draftScopeFor('https://ats.example/acme/apply?gh_src=zzz'),
    );
  });

  it('treats a trailing slash as the same page', () => {
    expect(draftScopeFor('https://ats.example/acme/apply/')).toEqual(
      draftScopeFor('https://ats.example/acme/apply'),
    );
  });

  it('keeps DISTINCT paths distinct — this must not over-merge', () => {
    // The failure in the other direction is worse: two different jobs on one
    // ATS sharing a draft store would offer Acme's answer on Globex's form.
    expect(draftScopeFor('https://ats.example/acme/apply')).not.toEqual(
      draftScopeFor('https://ats.example/globex/apply'),
    );
  });

  it('keeps distinct ORIGINS distinct, including scheme and port', () => {
    expect(draftScopeFor('https://a.example/f')).not.toEqual(
      draftScopeFor('https://b.example/f'),
    );
    expect(draftScopeFor('https://a.example/f')).not.toEqual(
      draftScopeFor('http://a.example/f'),
    );
  });

  it('returns empty for an unparseable URL', () => {
    // Callers treat '' as "no scope" rather than as a scope that matches every
    // other unparseable URL — see the autoInsertDecision test for that half.
    expect(draftScopeFor('not a url')).toBe('');
    expect(draftScopeFor('')).toBe('');
  });
});

describe('questionKey', () => {
  it('is the label and the occurrence, NOT the token', () => {
    // The whole point: tokens are regenerated on every scan and die on reload.
    // A draft keyed on one detaches exactly when the page re-renders, which is
    // when you most want it back.
    const first = textField({ token: 'cc-one-a' });
    const rescanned = textField({ token: 'cc-two-b' });
    expect(keyOf(first)).toEqual(keyOf(rescanned));
  });

  it('does NOT dedupe identical labels', () => {
    // A form with two "Why?" boxes is asking two questions and wants two
    // answers. Collapsing them would give one question two names and lose one.
    expect(questionKey('Why?', 0)).not.toEqual(questionKey('Why?', 1));
  });

  it('survives whitespace and case churn from a re-render', () => {
    expect(questionKey('  Why   do you\nwant this? ', 0)).toEqual(
      questionKey('why do you want this?', 0),
    );
  });

  it('caps a runaway label so storage cannot be blown up by one field', () => {
    // The scanner's ancestor walk can return up to 300 chars of surrounding
    // block text. Two 300-char labels differing only past 200 collide — which
    // is acceptable, because at that length they are the same block of text.
    const long = 'x'.repeat(400);
    expect(questionKey(long, 0).length).toBeLessThan(220);
  });
});

describe('buildEntries', () => {
  it('pairs each field with its draft, and leaves untouched ones null', () => {
    const answered = textField({ label: 'A' });
    const untouched = textField({ label: 'B' });
    const drafts = { [keyOf(answered)]: draft({ content: 'written' }) };

    const entries = buildEntries([answered, untouched], drafts);
    expect(entries[0]?.draft?.content).toBe('written');
    expect(entries[1]?.draft).toBeNull();
  });

  it('INCLUDES choice controls rather than filtering them out', () => {
    // Classified and reported, never filtered. A Yes/No dropdown you cannot
    // see is a question you think the scanner missed. What protects it is that
    // it carries no token, not that it is hidden.
    const entries = buildEntries([choiceField()], {});
    expect(entries).toHaveLength(1);
    expect(entries[0]?.field.kind).toBe('choice');
    expect(entries[0]?.field.token).toBeNull();
  });

  it('re-attaches a draft after a rescan gave the field a new token', () => {
    const before = textField({ token: 'cc-old' });
    const drafts = { [keyOf(before)]: draft({ content: 'kept' }) };
    const after = textField({ token: 'cc-new', existing: 'kept' });

    expect(buildEntries([after], drafts)[0]?.draft?.content).toBe('kept');
  });
});

describe('addInstruction / removeInstruction', () => {
  it('accumulates — the earlier instruction stays in force', () => {
    let stack = addInstruction([], 'This is a Toptal form, third person');
    stack = addInstruction(stack, 'Highlight my time at evendent.io');
    expect(stack).toEqual([
      'This is a Toptal form, third person',
      'Highlight my time at evendent.io',
    ]);
  });

  it('ignores blank input rather than making an empty chip', () => {
    expect(addInstruction(['a'], '   ')).toEqual(['a']);
  });

  it('drops a repeat — saying it twice does not make the model obey twice', () => {
    expect(addInstruction(['Be concise'], 'be CONCISE')).toEqual(['Be concise']);
  });

  it('removes by index, and a bad index is a no-op not a throw', () => {
    expect(removeInstruction(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(removeInstruction(['a'], 5)).toEqual(['a']);
    expect(removeInstruction(['a'], -1)).toEqual(['a']);
  });
});

describe('extractAnswerRefs', () => {
  it('finds an answer id in a Career Caddy URL', () => {
    const text = 'more like https://careercaddy.online/answers/Ab3xY9kQ2m please';
    expect(extractAnswerRefs(text, SELF_HOSTS)).toEqual(['Ab3xY9kQ2m']);
  });

  it('accepts a deeper path — the ticket writes it as /.../answers/<id>', () => {
    const text = 'https://careercaddy.online/questions/7/answers/zz11yy22';
    expect(extractAnswerRefs(text, SELF_HOSTS)).toEqual(['zz11yy22']);
  });

  it('refuses a lookalike host', () => {
    // Host checked with `new URL`, not spelled out in a regex — "careercaddy
    // .online but not evilcareercaddy.online" is not a thing to write by hand.
    const text = 'https://evilcareercaddy.online/answers/pwned';
    expect(extractAnswerRefs(text, SELF_HOSTS)).toEqual([]);
  });

  it('dedupes and ignores unparseable junk', () => {
    const id = 'Dup1234x';
    const text =
      `https://careercaddy.online/answers/${id} and ` +
      `https://careercaddy.online/answers/${id} and http:// nonsense`;
    expect(extractAnswerRefs(text, SELF_HOSTS)).toEqual([id]);
  });

  it('finds nothing in text with no URL at all', () => {
    expect(extractAnswerRefs('just make it shorter', SELF_HOSTS)).toEqual([]);
  });
});

describe('composeInjectedPrompt', () => {
  it('is null when there is nothing to say', () => {
    // An empty string would render an empty PRIORITY section in the api's
    // prompt — i.e. tell the model its highest-priority directive is blank.
    expect(
      composeInjectedPrompt({ instructions: [], draft: '', references: [] }),
    ).toBeNull();
  });

  it('carries the previous draft on a refine turn', () => {
    // THE LOAD-BEARING ONE. Each generation is a fresh Answer row; the model
    // is not in a conversation and has no memory of what it wrote. Without the
    // draft in the prompt, "make it shorter" is an instruction about nothing.
    const prompt = composeInjectedPrompt({
      instructions: ['Make it shorter'],
      draft: 'A long-winded first attempt.',
      references: [],
    });
    expect(prompt).toContain('A long-winded first attempt.');
    expect(prompt).toContain('Make it shorter');
  });

  it('lists every instruction, oldest first, all still in force', () => {
    const prompt = composeInjectedPrompt({
      instructions: ['Third person', 'Name evendent.io'],
      draft: 'draft text',
      references: [],
    });
    expect(prompt).toContain('- Third person');
    expect(prompt).toContain('- Name evendent.io');
    expect(prompt!.indexOf('Third person')).toBeLessThan(prompt!.indexOf('evendent.io'));
  });

  it('inlines a referenced answer with the question it answered', () => {
    // The prompt's Q&A history carries only FAVORITED answers, so an
    // unfavorited one is otherwise invisible to the model. Pasting the URL is
    // how you hand it over.
    const prompt = composeInjectedPrompt({
      instructions: ['more like this one'],
      draft: 'current',
      references: [
        { id: 'a1', question: 'Tell us about a project', content: 'The good answer.' },
      ],
    });
    expect(prompt).toContain('Tell us about a project');
    expect(prompt).toContain('The good answer.');
  });

  it('emits the revise directive ONLY when a draft exists', () => {
    // A first generation must not be told to "revise the draft below" — there
    // is no draft, and the directive would be an instruction about nothing.
    const first = composeInjectedPrompt({
      instructions: ['Third person'],
      draft: '',
      references: [],
    });
    expect(first).not.toContain('Revise the draft');

    const refine = composeInjectedPrompt({
      instructions: ['Third person'],
      draft: 'the first attempt',
      references: [],
    });
    expect(refine).toContain('Revise the draft');
  });

  it('carries the draft only while CARRY_DRAFT_IN_PROMPT is on', () => {
    // The constant is the whole migration seam. When the api grows a proper
    // "previous answer, revise this" section, flipping it to false is the
    // change — and this test is what says so out loud rather than leaving the
    // flag looking decorative.
    const prompt = composeInjectedPrompt({
      instructions: ['shorter'],
      draft: 'the first attempt',
      references: [],
    });
    if (CARRY_DRAFT_IN_PROMPT) {
      expect(prompt).toContain('the first attempt');
    } else {
      expect(prompt).not.toContain('the first attempt');
      expect(prompt).toContain('shorter');
    }
  });

  it('adds no heading of its own around the instructions', () => {
    // The api already wraps the whole string in "## User Instructions
    // (PRIORITY …)". A second frame would just be more scaffolding to read.
    const prompt = composeInjectedPrompt({
      instructions: ['Be brief'],
      draft: '',
      references: [],
    });
    expect(prompt).not.toContain('##');
  });
});

describe('pruneStore', () => {
  it('drops drafts past the TTL and keeps live ones', () => {
    const store: DraftStore = {
      'https://a.example/form': { k: draft({ at: NOW - 1000 }) },
      'https://b.example/form': { k: draft({ at: NOW - DRAFT_TTL_MS - 1 }) },
    };
    expect(Object.keys(pruneStore(store, NOW))).toEqual(['https://a.example/form']);
  });

  it('caps pages by their NEWEST draft, not their oldest', () => {
    // Keying the LRU on the oldest draft would evict the form you are working
    // on the moment one of its questions went cold.
    const store: DraftStore = {
      old: { k: draft({ at: NOW - 5000 }) },
      active: { cold: draft({ at: NOW - 9000 }), warm: draft({ at: NOW - 10 }) },
    };
    expect(Object.keys(pruneStore(store, NOW, DRAFT_TTL_MS, 1))).toEqual(['active']);
  });

  it('returns empty for absent or malformed storage', () => {
    expect(pruneStore(undefined, NOW)).toEqual({});
    expect(pruneStore('nonsense', NOW)).toEqual({});
    expect(pruneStore({ url: { k: { at: 'yesterday' } } }, NOW)).toEqual({});
  });

  it('keeps two pages apart — nesting IS the page scoping', () => {
    const stripe = { [questionKey('Why?', 0)]: draft({ content: 'for Stripe' }) };
    const toptal = { [questionKey('Why?', 0)]: draft({ content: 'for Toptal' }) };
    const pruned = pruneStore(
      { 'https://stripe.example/f': stripe, 'https://toptal.example/f': toptal },
      NOW,
    );
    expect(pruned['https://stripe.example/f']?.[questionKey('Why?', 0)]?.content).toBe(
      'for Stripe',
    );
    expect(pruned['https://toptal.example/f']?.[questionKey('Why?', 0)]?.content).toBe(
      'for Toptal',
    );
  });
});

describe('isResumable', () => {
  it('is false with nothing in flight', () => {
    expect(isResumable(draft({ pendingAnswerId: null }), NOW)).toBe(false);
  });

  it('resumes a young generation and abandons an old one', () => {
    const young = draft({ pendingAnswerId: 'a', pendingSince: NOW - 1000 });
    const old = draft({ pendingAnswerId: 'a', pendingSince: NOW - PENDING_MAX_AGE_MS - 1 });
    expect(isResumable(young, NOW)).toBe(true);
    expect(isResumable(old, NOW)).toBe(false);
  });

  it('measures from pendingSince, not from last touched', () => {
    // `at` moves every time a status line is written, which would quietly
    // extend the resume window every time the panel said anything.
    const chatty = draft({
      pendingAnswerId: 'a',
      pendingSince: NOW - PENDING_MAX_AGE_MS - 1,
      at: NOW,
    });
    expect(isResumable(chatty, NOW)).toBe(false);
  });
});
