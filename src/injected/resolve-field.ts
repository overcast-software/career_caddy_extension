/**
 * INJECTED. The page's form fields, and how to write into one.
 *
 * Read the rules at the top of grab-payload.ts first — they all apply. The one
 * that shapes this file most: **nothing may close over module scope.** The
 * attribute name arrives through `args`, never as a closure over the constant
 * declared below.
 *
 * ── ONE CLASSIFIER, TWO DIRECTIONS ─────────────────────────────────────────
 *
 * `ccResolveFieldInPage` runs the label ladder either way round, chosen by
 * `mode`:
 *
 *   'selection' — the user highlighted a question. Walk FORWARD from the
 *                 highlight to the control that question labels. This is
 *                 CCEXT-26 M1, byte-for-byte the behaviour that shipped.
 *   'scan'      — nobody highlighted anything. Enumerate every field and walk
 *                 each one BACKWARD to its label. This is CCEXT-26 M2, and it
 *                 is what fills the answer desk's question picker.
 *
 * **They share one function on purpose, and this is load-bearing.**
 * `executeScript` serializes a SINGLE function into the page, so a separate
 * injected scanner would need its own copy of `fieldKind()`. A forked
 * classifier is precisely the failure CCEXT-30 was filed for: one copy learns
 * that a Rippling radio is a choice control and the other does not, and an
 * essay lands in a Yes/No box. Two copies of a rule is how they disagree.
 *
 * The panel enters through 'scan' — the picker replaced highlighting as the
 * way you choose a question. 'selection' is retained rather than deleted
 * because deleting it is what would later tempt someone to write the second
 * scanner. It is one branch of one function, not a second implementation.
 */

/**
 * The attribute a resolved field is stamped with, so a later write can find
 * it again. Passed in through `args` at every call site — the injected
 * functions below must never read this binding, because the page has no such
 * binding. scripts/injected-gate.mjs fails the build if one does.
 */
export const CC_FIELD_ATTR = 'data-cc-field';

/** What a writable control turned out to be. Shown, so "input" warns you. */
export type TextControl = 'input' | 'textarea' | 'contenteditable';

/**
 * What a constrained control turned out to be.
 *
 * Four members, closed. Anything the classifier calls a choice that is not a
 * select, radio or checkbox is combobox-shaped by construction — `role`,
 * `aria-haspopup`, `aria-autocomplete` or a `<datalist>` — so normalising the
 * tail to 'combobox' keeps this union honest instead of widening it to
 * `string` to accommodate whatever tag name happened to be underneath.
 */
export type ChoiceControl = 'select' | 'radio' | 'checkbox' | 'combobox';

/**
 * CCEXT-30, EXPRESSED IN THE TYPE SYSTEM.
 *
 * The bug that ticket was filed for is an answer written into a control that
 * cannot hold free text. Every guard against it used to be a runtime `if`
 * somebody had to remember. Here the two outcomes are different shapes:
 *
 *   - a text field HAS a token, so it can be written to;
 *   - a choice field's token is `null`, permanently and by construction —
 *     the scanner never stamps one.
 *
 * `kind` is the *discriminant*: TypeScript narrows the whole object from it,
 * so inside `if (field.kind === 'text')` the compiler knows `token` is a
 * `string`. The write path takes `TextField`, which means handing it a
 * dropdown is a compile error rather than a support ticket.
 */
export type ResolvedField =
  | {
      kind: 'text';
      /** Stamped onto the element. The write path's only handle on it. */
      token: string;
      control: TextControl;
      /** Up to 200 chars of what is already in there. Never overwrite blind. */
      existing: string;
      /** Which rung of the ladder matched — shown so a wrong guess is visible. */
      how: string;
      /** The label came from a placeholder or a `name`. A guess, and says so. */
      weak: boolean;
    }
  | {
      kind: 'choice';
      /** Not "no token yet". There will never be one. */
      token: null;
      control: ChoiceControl;
      /** Up to 8, so the picker can say "dropdown: Yes / No". */
      options: string[];
      how: string;
      weak: boolean;
    };

/** The only arm the write path accepts. See `ccWriteFieldInPage`. */
export type TextField = Extract<ResolvedField, { kind: 'text' }>;

/**
 * A field plus the question it answers.
 *
 * `&` on a union distributes across its members, so this is still a
 * discriminated union — `kind` narrows it exactly as `ResolvedField` does.
 *
 * `occurrence` is what stops two "Why do you want to work here?" boxes from
 * collapsing into one entry. They are two questions; a form that asks the
 * same thing twice wants two answers.
 */
export type ScannedField = ResolvedField & { label: string; occurrence: number };

/** The scanned arm the write path accepts. */
export type ScannedTextField = Extract<ScannedField, { kind: 'text' }>;

export interface ScanResult {
  fields: ScannedField[];
  /** Fields past the cap. Reported rather than silently truncated. */
  dropped: number;
}

/**
 * Selection mode's answer.
 *
 * `null` means nothing was highlighted. `unmatched` means text WAS highlighted
 * and no control could be found for it — a different fact, and one worth
 * saying out loud, because "highlight something" is unhelpful advice to
 * someone who just did.
 */
export type SelectionResult =
  | ({ text: string } & ResolvedField)
  | { kind: 'unmatched'; text: string }
  | null;

/**
 * Everything the ladders read off an element, whether or not this particular
 * element has it. `HTMLElement` already carries `closest`, `getAttribute`,
 * `style`, `focus` and `isContentEditable`; the optional members below are the
 * ones that live on specific subclasses, and marking them optional is what
 * lets one walk handle inputs, selects and plain divs without a cast per rung.
 */
type FieldEl = HTMLElement & {
  disabled?: boolean;
  type?: string;
  name?: string;
  value?: string;
  readOnly?: boolean;
  options?: ArrayLike<{ label?: string; text?: string }>;
};

export function ccResolveFieldInPage(
  attr: string,
  mode: 'scan' | 'selection',
): ScanResult | SelectionResult {
  const scanning = mode === 'scan';

  // Scan for CHOICE controls too, not just writable ones. Skipping them
  // silently is what made the ladder walk past a Yes/No dropdown and grab an
  // unrelated text input further up the tree. A choice control must be able to
  // WIN the match so we can say "this is a dropdown" instead of guessing.
  const WRITABLE = 'input, textarea, [contenteditable="true"], [contenteditable=""]';
  const FIELDS = WRITABLE + ', select, [role="combobox"], [role="listbox"]';

  // CCEXT-38: 'password' is in this list deliberately. Nothing tells the
  // extension it is on a job application — the panel follows whatever tab is
  // active — so without this a credential field on any site classifies as a
  // writable text input. An extension that can enumerate and write to password
  // fields is a thing you do not want to own, and the store filing says it
  // only reads job postings.
  //
  // CCEXT-26 M2 turned this from belt-and-braces into the actual guard. Under
  // 'selection' the only door was a deliberate highlight and nobody highlights
  // their password box; 'scan' walks every field on the page unprompted, so
  // this list is now the ONLY thing standing between the panel and a login
  // form. Do not trim it.
  const SKIP_TYPES = ['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password'];
  const CHOICE_TYPES = ['checkbox', 'radio'];

  // The shared helpers, as ONE OBJECT LITERAL of methods rather than nested
  // functions — and that is a build constraint, not a style choice.
  //
  // `esbuild: { keepNames: true }` rewrites every named function (including
  // an arrow assigned to a const) into `__name(fn, "original")`. Inside an
  // injected function that helper is a module-scope reference the page does
  // not have, so the whole thing throws on injection. Object-literal methods
  // are the one form esbuild leaves alone. scripts/injected-gate.mjs caught
  // this the first time it was written the obvious way.
  const h = {
    // null = not a field at all. 'choice' = a constrained-value control that
    // free text cannot be written into. 'text' = writable.
    fieldKind(el: FieldEl | null): 'text' | 'choice' | null {
      if (!el || el.disabled) return null;
      const tag = el.tagName;
      const type = (el.type || '').toLowerCase();
      if (tag === 'INPUT' && SKIP_TYPES.indexOf(type) !== -1) return null;

      // CLASSIFY CHOICE CONTROLS *BEFORE* THE VISIBILITY CHECK. Custom-styled
      // radios and checkboxes are routinely rendered 0x0 (or opacity:0) with a
      // styled span painted on top — Rippling's ATS does exactly this. If the
      // size check ran first they'd come back null, meaning "not a field", and
      // the ancestor walk would step straight over the question and match an
      // unrelated textarea further up the tree. That is not a cosmetic miss:
      // it is how an answer to a Yes/No question gets offered into someone
      // else's essay box. A hidden choice control still answers the question
      // "can free text go here?" — and the answer is still no.
      if (tag === 'SELECT') return 'choice';
      if (tag === 'INPUT' && CHOICE_TYPES.indexOf(type) !== -1) return 'choice';
      // Custom comboboxes (react-select, Workday, Ashby, Rippling) render a
      // real <input> or a div[role=combobox] but only accept values from a
      // popup listbox — typing free text into one either does nothing or
      // leaves the form in an invalid state.
      const role = el.getAttribute('role') || '';
      if (role === 'combobox' || role === 'listbox') return 'choice';
      if (el.getAttribute('aria-haspopup') === 'listbox') return 'choice';
      if (el.getAttribute('aria-autocomplete') === 'list') return 'choice';
      if (el.getAttribute('list')) return 'choice'; // <datalist>
      if (el.closest('[role="combobox"], [role="listbox"]')) return 'choice';

      // From here down we're deciding whether free text can actually be typed,
      // so an invisible or read-only control genuinely is not a candidate.
      if (el.readOnly) return null;
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r && r.width === 0 && r.height === 0) return null;

      if (tag === 'INPUT' || tag === 'TEXTAREA') return 'text';
      if (el.isContentEditable) return 'text';
      return null;
    },

    usable(el: FieldEl | null): boolean {
      return h.fieldKind(el) !== null;
    },

    asElement(node: Node | null): FieldEl | null {
      if (!node) return null;
      return (node.nodeType === 1 ? node : node.parentElement) as FieldEl | null;
    },

    tidy(s: string | null | undefined): string {
      return String(s || '')
        .replace(/\s+/g, ' ')
        .trim();
    },

    textOf(node: Element | null): string {
      return node ? h.tidy(node.textContent) : '';
    },

    // A control's own text is not part of its label. Without this subtraction a
    // wrapping-label radio reads as "Yes", i.e. the ANSWER gets recorded as the
    // question — and the whole feature answers the wrong thing.
    textMinus(container: Element | null, strip: string[]): string {
      let whole = h.textOf(container);
      if (!whole) return '';
      for (let i = 0; i < strip.length; i++) {
        const s = h.tidy(strip[i]);
        if (s && whole.indexOf(s) !== -1) whole = whole.split(s).join(' ');
      }
      return h.tidy(whole);
    },

    groupSiblings(field: FieldEl): FieldEl[] {
      if (!field.name) return [field];
      try {
        const found = document.querySelectorAll(
          field.tagName.toLowerCase() + '[name="' + CSS.escape(field.name) + '"]',
        );
        const out: FieldEl[] = [];
        for (let i = 0; i < found.length; i++) out.push(found[i] as FieldEl);
        return out.length ? out : [field];
      } catch {
        return [field];
      }
    },

    // What KIND of constrained control this is, and what it will accept. Shared
    // by both modes — the selection branch's choice report and the scan's
    // per-row "— dropdown: Yes / No" come from the same read.
    describeChoice(field: FieldEl): {
      control: ChoiceControl;
      options: string[];
    } {
      const options: string[] = [];
      const fieldType = (field.type || '').toLowerCase();

      if (field.tagName === 'SELECT' && field.options) {
        const opts = field.options;
        for (let i = 0; i < opts.length && i < 8; i++) {
          const opt = opts[i];
          const label = h.tidy(opt ? opt.label || opt.text : '');
          if (label) options.push(label);
        }
        return { control: 'select', options };
      }

      if (fieldType === 'radio' || fieldType === 'checkbox') {
        // Radio groups carry the human-readable choices on the `value` of each
        // sibling sharing the group name — which is where the real answer is
        // (e.g. "Yes - I currently live in the Bellevue/Seattle area"), not on
        // any label element. Fall back to the aria-labelledby target's text.
        const sibs = h.groupSiblings(field);
        for (let i = 0; i < sibs.length && i < 8; i++) {
          const sib = sibs[i];
          if (!sib) continue;
          let v = h.tidy(sib.value);
          if (!v || v === 'on') {
            const lid = sib.getAttribute('aria-labelledby');
            v = h.textOf(lid ? document.getElementById(lid) : null);
          }
          if (v && options.indexOf(v) === -1) options.push(v);
        }
        return { control: fieldType === 'radio' ? 'radio' : 'checkbox', options };
      }

      // Everything else fieldKind() called a choice got there through role,
      // aria-haspopup, aria-autocomplete, a datalist, or a combobox ancestor.
      // All of those are combobox-shaped, so saying so keeps ChoiceControl a
      // closed set instead of leaking whatever tag name happened to be there.
      return { control: 'combobox', options };
    },

    stamp(field: FieldEl): string {
      const token =
        'cc-' +
        Math.random().toString(36).slice(2, 10) +
        '-' +
        Math.floor(performance.now()).toString(36);
      field.setAttribute(attr, token);
      return token;
    },

    readExisting(field: FieldEl): string {
      const raw = field.isContentEditable ? field.textContent || '' : field.value || '';
      return raw.trim().slice(0, 200);
    },

    clearStamps(): void {
      const stale = document.querySelectorAll('[' + attr + ']');
      for (let i = 0; i < stale.length; i++) stale[i]!.removeAttribute(attr);
    },

    textControlOf(field: FieldEl): TextControl {
      if (field.isContentEditable) return 'contenteditable';
      return field.tagName === 'TEXTAREA' ? 'textarea' : 'input';
    },

    // --- scan mode: field -> its label, the ladder run backwards -------------
    //
    // `startAt` and `strip` exist for radio/checkbox GROUPS: the question is
    // carried by whatever wraps the whole group, and the option texts inside it
    // are noise that has to come out.
    describeLabel(
      el: FieldEl,
      startAt: Element | null,
      strip: string[],
    ): { label: string; how: string; weak: boolean } | null {
      // 1. label[for="X"] — the explicit, unambiguous case.
      if (el.id) {
        let lab: Element | null = null;
        try {
          lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        } catch {
          lab = null;
        }
        const t = h.textOf(lab);
        if (t) return { label: t, how: 'its label', weak: false };
      }

      // 2. A wrapping <label>.
      const wrap = el.closest('label');
      if (wrap) {
        const t = h.textMinus(wrap, [h.textOf(el)].concat(strip));
        if (t) return { label: t, how: 'the wrapping label', weak: false };
      }

      // 3. aria-labelledby, forwards this time — the field names its own label.
      const ids = el.getAttribute('aria-labelledby') || '';
      if (ids) {
        const parts: string[] = [];
        const list = ids.split(/\s+/);
        for (let i = 0; i < list.length; i++) {
          const t = h.textOf(document.getElementById(list[i] || ''));
          if (t) parts.push(t);
        }
        if (parts.length) {
          return { label: parts.join(' '), how: 'aria-labelledby', weak: false };
        }
      }

      // 4. aria-label.
      const aria = h.tidy(el.getAttribute('aria-label'));
      if (aria) return { label: aria, how: 'aria-label', weak: false };

      // 5. A <fieldset>'s <legend>. This is how a well-built radio group states
      //    its question, so it has to beat the ancestor walk below — which would
      //    otherwise return the nearest option text.
      const fs = el.closest('fieldset');
      if (fs) {
        const t = h.textOf(fs.querySelector('legend'));
        if (t) return { label: t, how: 'the fieldset legend', weak: false };
      }

      // 6. Walk up. CAPPED at 6, the same cap and the same reason as the forward
      //    ladder: uncapped, the nearest text to a field eventually becomes the
      //    page header and every field on the form reports the same "label".
      //    The length ceiling is the other half of that — once a container is
      //    this big it is the form, not the question, and so is everything above
      //    it, which is why this breaks instead of continuing.
      let n: Element | null = startAt || el.parentElement;
      for (let i = 0; n && i < 6; i++, n = n.parentElement) {
        const t = h.textMinus(n, [h.textOf(el)].concat(strip));
        if (t && t.length > 300) break;
        if (t) return { label: t, how: 'the surrounding block', weak: false };
      }

      // 7. Last resort, and flagged as such. A placeholder is a hint and a name
      //    is a developer's identifier; neither is a question the user asked to
      //    have answered, so the UI says we guessed.
      const ph = h.tidy(el.getAttribute('placeholder'));
      if (ph) return { label: ph, how: 'its placeholder', weak: true };
      const nm = h.tidy(el.getAttribute('name'));
      if (nm) return { label: nm, how: 'its field name', weak: true };
      return null;
    },

    // The tightest ancestor that contains every member of a radio/checkbox
    // group — where the group's question lives.
    groupRoot(el: FieldEl, sibs: FieldEl[]): Element | null {
      let n: Element | null = el.parentElement;
      for (let i = 0; n && i < 6; i++, n = n.parentElement) {
        let all = true;
        for (let j = 0; j < sibs.length; j++) {
          const sib = sibs[j];
          if (sib && !n.contains(sib)) {
            all = false;
            break;
          }
        }
        if (all) return n;
      }
      return null;
    },
  };

  if (scanning) {
    // N live stamps now, not one — but still a clean slate per scan, so a
    // token from a previous scan can never be written into.
    h.clearStamps();

    const out: ScannedField[] = [];
    const seenGroups: Record<string, boolean> = {};
    const counts: Record<string, number> = {};
    const all = document.querySelectorAll(FIELDS);
    for (let i = 0; i < all.length; i++) {
      const el = all[i] as FieldEl;
      const kind = h.fieldKind(el);
      if (!kind) continue;

      // A radio or checkbox GROUP is ONE question, not one per option.
      // Listing every radio separately would fill the picker with "Yes",
      // "No", "Yes", "No" and bury the actual questions.
      const type = (el.type || '').toLowerCase();
      let startAt: Element | null = null;
      let strip: string[] = [];
      if ((type === 'radio' || type === 'checkbox') && el.name) {
        const gkey = el.tagName + '|' + el.name;
        if (seenGroups[gkey]) continue;
        seenGroups[gkey] = true;
        const sibs = h.groupSiblings(el);
        startAt = h.groupRoot(el, sibs);
        for (let j = 0; j < sibs.length && j < 12; j++) {
          const v = h.tidy(sibs[j] ? sibs[j]!.value : '');
          if (v && v !== 'on') strip.push(v);
        }
      }

      const choice = kind === 'choice' ? h.describeChoice(el) : null;
      if (choice && choice.options.length) strip = strip.concat(choice.options);

      const lab = h.describeLabel(el, startAt, strip);
      // An unlabelled box is not a question. Offering it would mean offering
      // to answer something we cannot name.
      if (!lab || !lab.label) continue;

      const occurrence = counts[lab.label] || 0;
      counts[lab.label] = occurrence + 1;

      if (choice) {
        // A choice control is never stamped. THAT is what makes it impossible
        // for Insert to fire on a Yes/No dropdown — not a check somewhere
        // else that a later edit could forget.
        out.push({
          kind: 'choice',
          token: null,
          control: choice.control,
          options: choice.options,
          how: lab.how,
          weak: lab.weak,
          label: lab.label,
          occurrence,
        });
      } else {
        out.push({
          kind: 'text',
          token: h.stamp(el),
          control: h.textControlOf(el),
          existing: h.readExisting(el),
          how: lab.how,
          weak: lab.weak,
          label: lab.label,
          occurrence,
        });
      }
    }

    const CAP = 40;
    const dropped = out.length > CAP ? out.length - CAP : 0;
    return { fields: dropped ? out.slice(0, CAP) : out, dropped };
  }

  // --- selection mode: unchanged from CCEXT-26 M1 --------------------------
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const text = String(sel.toString() || '').trim();
  if (!text) return null;

  const range = sel.getRangeAt(0);
  const anchor = h.asElement(sel.anchorNode) || h.asElement(range.commonAncestorContainer);
  if (!anchor || !anchor.closest) return { kind: 'unmatched', text };

  let field: FieldEl | null = null;
  let how = '';

  // 1. The selection sits inside <label for="X">.
  const labelFor = anchor.closest('label[for]');
  if (labelFor) {
    const target = document.getElementById(labelFor.getAttribute('for') || '') as FieldEl | null;
    if (h.usable(target)) {
      field = target;
      how = 'its label';
    }
  }

  // 2. A wrapping <label> that contains the control.
  if (!field) {
    const wrap = anchor.closest('label');
    if (wrap) {
      const target = wrap.querySelector(FIELDS) as FieldEl | null;
      if (h.usable(target)) {
        field = target;
        how = 'the wrapping label';
      }
    }
  }

  // 3. aria-labelledby, resolved backwards from the selected element's id.
  if (!field) {
    let n: Element | null = anchor;
    for (let i = 0; n && i < 6; i++, n = n.parentElement) {
      if (!n.id) continue;
      let target: FieldEl | null = null;
      try {
        target = document.querySelector(
          '[aria-labelledby~="' + CSS.escape(n.id) + '"]',
        ) as FieldEl | null;
      } catch {
        target = null;
      }
      if (h.usable(target)) {
        field = target;
        how = 'aria-labelledby';
        break;
      }
    }
  }

  // 4. Walk up from the selection. CAPPED at 6 levels on purpose — a match
  //    found near the document root is almost always the site's search box,
  //    not the question's answer field.
  if (!field) {
    let n: Element | null = h.asElement(range.commonAncestorContainer);
    for (let i = 0; n && i < 6 && !field; i++, n = n.parentElement) {
      const candidates = n.querySelectorAll ? n.querySelectorAll(FIELDS) : [];
      for (let j = 0; j < candidates.length; j++) {
        const candidate = candidates[j] as FieldEl;
        if (h.usable(candidate)) {
          field = candidate;
          how = 'the surrounding block';
          break;
        }
      }
    }
  }

  // 5. Last resort: the next control after the selection.
  if (!field) {
    const all = document.querySelectorAll(FIELDS);
    for (let i = 0; i < all.length; i++) {
      const c = all[i] as FieldEl;
      if (!h.usable(c)) continue;
      const rel = anchor.compareDocumentPosition(c);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) {
        field = c;
        how = 'the next field on the page';
        break;
      }
    }
  }

  if (!field) return { kind: 'unmatched', text };

  // A constrained-value control (select, radio/checkbox, custom combobox)
  // CANNOT take free text. Report it as such and stamp NOTHING — the caller
  // hides Insert and says why. Returning a token here is how text ends up in
  // the wrong box, and falling through to "keep looking" is how the ladder
  // walks past a Yes/No dropdown onto an unrelated input.
  if (h.fieldKind(field) === 'choice') {
    const choice = h.describeChoice(field);
    return {
      text,
      kind: 'choice',
      token: null,
      control: choice.control,
      options: choice.options,
      how,
      weak: false,
    };
  }

  // One live stamp at a time — clear any leftovers from an earlier resolve.
  h.clearStamps();
  return {
    text,
    kind: 'text',
    token: h.stamp(field),
    control: h.textControlOf(field),
    existing: h.readExisting(field),
    how,
    weak: false,
  };
}

/** What a write attempt did. `gone` means the page dropped our stamp. */
export type WriteOutcome = { ok: true } | { ok: false; reason: 'gone' };

/**
 * INJECTED. Writes `value` into the stamped control.
 *
 * THE GOTCHA: on a React/Vue-controlled form a plain `el.value = x` updates
 * the DOM but NOT the framework's internal state, so the value is reverted on
 * the next re-render or dropped on submit — it looks like it worked and
 * didn't. Going through the native prototype setter and then dispatching
 * bubbling input/change events is what makes the framework actually see it.
 *
 * `contenteditable` takes a different path for the same reason:
 * `execCommand('insertText')` is deprecated but it emits real
 * beforeinput/input events, which is what rich-text editors listen for.
 */
export function ccWriteFieldInPage(
  attr: string,
  token: string,
  value: string,
): WriteOutcome {
  const el = document.querySelector('[' + attr + '="' + token + '"]') as
    | (HTMLElement & { value?: string })
    | null;
  if (!el) return { ok: false, reason: 'gone' };

  try {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    el.scrollIntoView();
  }
  try {
    el.focus({ preventScroll: true });
  } catch {
    try {
      el.focus();
    } catch {
      /* not focusable — the write below can still succeed */
    }
  }

  if (el.isContentEditable) {
    let wrote = false;
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      if (s) {
        s.removeAllRanges();
        s.addRange(r);
      }
      wrote = document.execCommand('insertText', false, value);
    } catch {
      wrote = false;
    }
    if (!wrote) {
      el.textContent = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Flash the field so the user SEES where it landed. This moment is the
  // feature — without it the insert is indistinguishable from a paste.
  const prevOutline = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = '2px solid #16a34a';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    el.style.outline = prevOutline;
    el.style.outlineOffset = prevOffset;
  }, 1400);

  return { ok: true };
}
