/**
 * INJECTED. Paints the golfer marks, keeps them on their fields, and tears
 * them down.
 *
 * Read the rules at the top of grab-payload.ts first — all four apply, and
 * rule 4 (no nested named functions) is why the helpers here are an object
 * literal.
 *
 * ── THE MARK IS A REAL ELEMENT, ANCHORED TO THE FIELD ─────────────────────
 *
 * One wrapper `<div>` per mark: `all: unset`, `position: absolute`, a CLOSED
 * shadow root, appended to the tail of `document.body`. This is
 * keepassxc-browser's pattern (`content/icon.js` `createWrapper()`), read from
 * source rather than recalled.
 *
 * The body tail is the point. Inserting a node BETWEEN a page's own siblings
 * is what crashes React (facebook/react#11538) and what a flex `gap` or a
 * `:nth-child()` rule notices; appending after everything is outside `#root` /
 * `#__next` in essentially every SPA, which is why KeePassXC ships this on
 * React sites at scale. Layout neutrality is then structural, not measured: an
 * absolutely positioned element at the body tail changes no other box.
 *
 * We anchor to the FIELD, never the label. The field is exact, always present,
 * never shared and never a guess — it already carries `data-cc-field` because
 * the answer gets written into it. Every anchoring failure in CCEXT-57 came
 * from the label being inferred by a 7-rung ladder.
 *
 * ── WHY KEEPASSXC'S GEOMETRY DOES NOT SURVIVE THE MOVE TO A TEXTAREA ──────
 *
 * They never decorate one: `observer-helper.js` `getInputs()` is
 * `querySelectorAll('input')` and its `inputTypes` list has no textarea. So
 * their positioning is tuned for a single-line box, and it is tuned in one
 * specific way that does not generalise (`icon-handler.js`):
 *
 *     calculateIconOffset = floor(field.offsetHeight / 2 - size / 2 - 1)
 *     top  = rect.top  + scrollTop + offset + 1
 *     left = rect.left + scrollLeft + field.offsetWidth - size - offset
 *
 * ONE offset, derived from the field's HEIGHT, used on BOTH axes. On a 34px
 * input with a 24px icon that is 4 — vertically centred, inset 4px from the
 * right, and it looks native. On a 150px textarea it is 62: the mark lands 62px
 * below the top edge, floating in the middle of the prose, and 62px in from the
 * right. It degrades in proportion to how tall the field is, which is exactly
 * what a textarea is.
 *
 * So: a CONSTANT inset, and the corner is chosen to be the least troublesome
 * one rather than the prettiest.
 *
 * ── WHERE IT GOES, AND WHY IT LEAVES ──────────────────────────────────────
 *
 * THE MARK DISAPPEARS THE MOMENT THE FIELD HAS TEXT (Doug). That is worth
 * stating first because it removes an entire class of problem: the mark can
 * never sit on top of the user's own writing, which is the complaint
 * Grammarly's "Grammarly overlaps my text or text area" support page exists to
 * answer. It is also semantically right — the golfer means "this question is
 * unanswered", so the remaining marks are a to-do list, and clearing them is
 * the progress bar.
 *
 * That leaves only the field's own CHROME to avoid, and the four corners are
 * not equally safe:
 *
 *   bottom-right  the native resize grabber, in both Chrome and Firefox — a
 *                 mark here steals the drag. Also where character counters
 *                 conventionally sit.
 *   top-*         rich-text ATS fields put a formatting toolbar across the
 *                 top, so a mark there can cover a control the user needs.
 *   top-left      also where the first line of text and the placeholder start.
 *   bottom-left   empty in an empty prose field, no native affordance, no
 *                 convention competing for it.
 *
 * BOTTOM-LEFT. It is the only corner where being wrong is cosmetic rather than
 * stealing a click or a drag, and since the mark is gone once there is text,
 * "empty prose field" is the only state it is ever drawn in.
 *
 * This is one constant (`CORNER`) if a real ATS disagrees.
 *
 * ── AND THEIR CHANGE DETECTION IS SHORT BY EXACTLY THE TWO A TEXTAREA NEEDS ─
 *
 * `monitorIconPosition` listens to three things: window resize, window scroll,
 * and transitionend. For an `<input>` that is nearly enough. A textarea breaks
 * both of the first two:
 *
 *   1. The user DRAGS THE RESIZE GRABBER. The box changes with no window
 *      resize and no scroll. There is no `ResizeObserver` anywhere in
 *      keepassxc-browser — they never needed one. We observe every marked
 *      field.
 *
 *   2. NESTED SCROLL CONTAINERS. Plain `addEventListener('scroll')` on window
 *      does not see them, and Greenhouse/Ashby/Lever put application forms in
 *      scroll panels. Scroll does not bubble but it does propagate in the
 *      CAPTURE phase, so one capture listener on window catches every
 *      descendant scroller.
 *
 * Floating UI's `autoUpdate()` is the packaged version of exactly this union.
 * We cannot import it: `executeScript({func})` stringifies this function and
 * the page has none of our modules, which `scripts/injected-gate.mjs` proves
 * mechanically. So it is the specification, not a dependency.
 *
 * Do NOT copy their `setTimeout(…, 400)` "wait for possible DOM animations"
 * inside the IntersectionObserver callback — that is a visible 400ms lag on
 * every scroll-into-view.
 *
 * ── COORDINATES ───────────────────────────────────────────────────────────
 *
 * `getBoundingClientRect()` is viewport-relative; adding scroll offsets makes
 * it document-relative, which is what `position: absolute` on a body child
 * wants. That is also why plain page scrolling needs no repositioning at all —
 * the document coordinate does not change. Only a field moving RELATIVE to the
 * document does, which is the nested-scroller case above.
 *
 * The exception is a POSITIONED `<body>`, which becomes the containing block
 * and shifts every absolute child. KeePassXC corrects for this
 * (`getRelativeLeftPosition`) but reads `getComputedStyle(document.body)` and
 * the body rect ONCE at script load, and tests only for `relative` — so it is
 * stale if the page positions body later and blind to `absolute`/`fixed`/
 * `sticky`. We read it live and test against `static`, which costs one extra
 * rect per batch (not per mark).
 *
 * ── THE PANEL DECIDES WHAT GETS A MARK ────────────────────────────────────
 *
 * This function is handed a list of tokens and paints those. It does not
 * re-derive eligibility, because the panel already merged the frames and
 * applied the prose rule (`control === 'textarea' || 'contenteditable'`, never
 * `kind: 'text'` — CCEXT-54). Duplicating that here would be a second
 * classifier, which is the exact failure CCEXT-30 was filed for.
 */

/** What the page sends the panel when a mark is clicked. */
export interface GolfSelectMessage {
  type: 'cc-golf-select';
  /** The field's `data-cc-field` token — CCEXT-59, identity not a label key. */
  token: string;
}

/** The port name. The page refuses any other, so nothing else can drive it. */
export const GOLF_PORT = 'cc-golf';

interface GolfWindow extends Window {
  __ccGolfTeardown?: () => void;
}

/**
 * Paint a mark on each listed field and wait for the panel to connect.
 *
 * Always returns true: a previous install is torn down and replaced rather
 * than treated as a reason to bail (see the guard). The return value is not
 * read by the caller and is kept only so the injection result is not
 * `undefined`.
 *
 * `chrome` is available here because `executeScript` runs in the ISOLATED
 * world by default. `scripts/layering-gate.mjs` forbids `world: 'MAIN'`, which
 * is what keeps that true; see the note beside `'chrome'` in
 * `scripts/injected-gate.mjs`.
 */
export function ccDecorateQuestions(
  fieldAttr: string,
  tokens: string[],
  portName: string,
): boolean {
  const win = window as GolfWindow;

  // Idempotent: TEAR DOWN AND REPAINT, never bail.
  //
  // `executeScript` is one-shot but the panel can re-caddy at any time, and
  // painting twice would stack two marks per field — so a previous install has
  // to go. The obvious guard is `if (already) return false`, and it was wrong,
  // because the flag has exactly one clearing path (teardown) and teardown has
  // exactly one caller (a connected port's `onDisconnect`). A paint that never
  // gets a port therefore sets the flag FOREVER.
  //
  // That is reachable: `state/page.ts#decorateQuestions` injects, awaits, and
  // only then calls `chrome.tabs.connect`. If the panel is destroyed during
  // that round trip, or the connect throws, the marks are already painted and
  // no port ever arrives. Every later re-caddy then re-stamps the fields with
  // fresh tokens, hits this guard, paints nothing — and leaves the ORIGINAL
  // marks on screen, still tracking their fields, still clickable, posting
  // tokens that no longer resolve. The panel answers every click with "that
  // question is no longer on the page", which is a lie, and the only exit is
  // reloading the tab.
  //
  // Repainting is idempotent and strictly more correct, so there is no reason
  // to prefer the bail. It also makes the re-caddy ordering in
  // `state/answer-desk.ts#scan` moot: that path disconnects the port and does
  // not await the page-side teardown, so this call could otherwise race it.
  if (win.__ccGolfTeardown) win.__ccGolfTeardown();

  // Smallest and largest the mark may be drawn, and how far in from the
  // field's top-right corner. KeePassXC's clamp, with their height-derived
  // offset replaced by a constant — see the header.
  const MIN_PX = 14;
  const MAX_PX = 24;
  const INSET = 6;
  /** See the header. Change this one string if an ATS disagrees. */
  const CORNER = 'bottom-left';

  // `onScreen` is the IntersectionObserver's verdict, cached per mark.
  //
  // It is doing more work than "is it scrolled off". With a null root the
  // intersection rectangle is clipped by EVERY scrolling ancestor, so a field
  // inside a nested `overflow: hidden` panel reports not-intersecting without
  // us walking the ancestor chain ourselves. That recursive-clipping case is
  // the one Grammarly's engineering post names as the assumption their first
  // implementation got wrong, so it is worth taking for free.
  //
  // Starts false: nothing is painted until the observer has actually reported.
  const marks: { field: Element; wrapper: HTMLElement; box: HTMLElement; onScreen: boolean }[] = [];
  let port: chrome.runtime.Port | null = null;
  let frame = 0;

  const h = {
    /**
     * The mark's edge length for a given field.
     *
     * A textarea always maxes this out, which is correct and is why the size
     * is not the thing that needed fixing — the OFFSET was.
     */
    size(field: Element): number {
      const el = field as HTMLElement;
      return Math.max(Math.min(MAX_PX, el.offsetHeight - 4), MIN_PX);
    },

    /**
     * The document-coordinate origin to subtract, when `<body>` is positioned
     * and therefore acts as the containing block for our wrappers.
     *
     * Returns [0, 0] for the overwhelmingly common static case, so the maths
     * below is unconditional.
     */
    bodyOrigin(): [number, number] {
      const body = document.body;
      if (!body) return [0, 0];
      if (getComputedStyle(body).position === 'static') return [0, 0];
      const r = body.getBoundingClientRect();
      return [r.left + window.scrollX, r.top + window.scrollY];
    },

    /**
     * Is this field still worth a mark right now?
     *
     * Scan-time visibility is not enough: a multi-step ATS hides later steps,
     * and `fieldKind`'s 0x0 test runs once and uses `&&`, so a zero-WIDTH tall
     * field passes it. Re-checked on every reposition.
     */
    visible(field: Element, rect: DOMRect): boolean {
      if (rect.width < MIN_PX || rect.height < MIN_PX) return false;
      const style = getComputedStyle(field);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return true;
    },

    /**
     * Does the field already have content?
     *
     * A mark on an answered question is noise at best and covers the user's
     * own words at worst, so it goes away. Duck-typed rather than
     * `instanceof` — injected functions avoid it (see grab-payload.ts) — which
     * also happens to cover `<textarea>` and `contenteditable` in one test.
     *
     * Our own Insert path is picked up for free: `ccWriteFieldInPage` writes
     * through the native prototype setter and dispatches a bubbling `input`,
     * which is exactly what the listener below is waiting for. So inserting an
     * answer clears its golfer without anyone wiring that up.
     */
    hasText(field: Element): boolean {
      const value = 'value' in field ? (field as HTMLTextAreaElement).value : field.textContent;
      return typeof value === 'string' && value.trim().length > 0;
    },

    /** Place one mark against its field, or hide it if the field is gone. */
    place(
      mark: { field: Element; wrapper: HTMLElement; box: HTMLElement; onScreen: boolean },
      ox: number,
      oy: number,
    ): void {
      // Three ways a mark stops being legitimate, cheapest test first. The
      // node can be re-rendered away by the ATS, scrolled or clipped out of
      // view, or hidden by a step change — and a mark left floating over
      // whatever replaced its field is the failure mode users report to
      // Grammarly as "it overlaps my text".
      if (!mark.field.isConnected || !mark.onScreen || h.hasText(mark.field)) {
        mark.wrapper.style.setProperty('display', 'none');
        return;
      }
      const rect = mark.field.getBoundingClientRect();
      if (!h.visible(mark.field, rect)) {
        mark.wrapper.style.setProperty('display', 'none');
        return;
      }

      const size = h.size(mark.field);
      const top =
        CORNER === 'bottom-left'
          ? rect.top + window.scrollY - oy + rect.height - size - INSET
          : rect.top + window.scrollY - oy + INSET;
      const left =
        CORNER === 'bottom-left'
          ? rect.left + window.scrollX - ox + INSET
          : rect.left + window.scrollX - ox + rect.width - size - INSET;

      mark.wrapper.style.setProperty('display', 'block');
      mark.wrapper.style.setProperty('top', top + 'px');
      mark.wrapper.style.setProperty('left', left + 'px');
      mark.box.style.setProperty('width', size + 'px');
      mark.box.style.setProperty('height', size + 'px');
      mark.box.style.setProperty('line-height', size + 'px');
    },

    /**
     * Reposition everything, at most once per frame.
     *
     * Coalesced because scroll and resize both fire far faster than paint, and
     * `getBoundingClientRect()` forces synchronous layout — Grammarly measured
     * a naive 60Hz version at over 90% CPU.
     */
    schedule(): void {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const origin = h.bodyOrigin();
        for (let i = 0; i < marks.length; i++) h.place(marks[i]!, origin[0], origin[1]);
      });
    },

    // The three listeners live here rather than as `const onScroll = () => …`
    // for the reason spelled out in grab-payload.ts rule 4: `keepNames`
    // rewrites an arrow assigned to a const into `__name(fn, "onScroll")`, and
    // that helper is module scope the page does not have. An object literal of
    // methods is the one form esbuild leaves alone. They also need to be
    // stable references so `removeEventListener` can find them, which methods
    // on a const object are.
    onScroll(): void {
      h.schedule();
    },
    onResize(): void {
      h.schedule();
    },
    onInput(): void {
      h.schedule();
    },
  };

  // One constructed stylesheet, shared by every mark's shadow root.
  //
  // NOT a `<style>` element and NOT a style attribute: both are subject to the
  // page's `style-src`, and a strict-CSP ATS would blank the marks. A
  // constructed CSSStyleSheet via `adoptedStyleSheets` is not, which retires
  // the CSP question by construction rather than by measurement (CCEXT-58).
  //
  // Never write a bare `var(--x)` in here: custom properties DO inherit through
  // a shadow boundary, so a page defining `--accent-500` would repaint our mark.
  //
  // The text is a const because there are now TWO ways it can reach a shadow
  // root — see the fallback in the loop below — and they must not drift.
  const CSS_TEXT =
    ':host { all: initial; }' +
    '.b { display: block; box-sizing: border-box; text-align: center;' +
    ' font-size: 13px; cursor: pointer; user-select: none; opacity: 0.55;' +
    ' background: transparent; border: 0; padding: 0; color: inherit; }' +
    '.b:hover { opacity: 1; }' +
    '.b:active { opacity: 1; transform: scale(0.9); }';

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS_TEXT);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const field = document.querySelector('[' + fieldAttr + '="' + token + '"]');
    if (!field) continue;

    const wrapper = document.createElement('div');
    // `all: unset` resets `position` to static, so every geometry property has
    // to be set AFTER it. Same trap as `all: initial` on the host below.
    wrapper.style.setProperty('all', 'unset');
    wrapper.style.setProperty('position', 'absolute');
    wrapper.style.setProperty('display', 'none');
    wrapper.style.setProperty('top', '0');
    wrapper.style.setProperty('left', '0');
    wrapper.style.setProperty('z-index', '2147483000');

    const root = wrapper.attachShadow({ mode: 'closed' });

    // FIREFOX 152 AND EARLIER CANNOT TAKE THIS ASSIGNMENT, AND IT THROWS.
    //
    // `adoptedStyleSheets` is an ObservableArray, and until Firefox 153 an
    // extension content script could not write one through its Xray wrapper:
    //
    //     Error: Accessing from Xray wrapper is not supported.
    //
    // Mozilla bug 1751346, fixed in 153 (bug 1770592 is its duplicate and
    // documents the symptom). Reproduced on 152.0.6 with a minimal add-on
    // doing only these three lines — construction and `replaceSync` succeed,
    // the ASSIGNMENT is what fails.
    //
    // Unhandled, this is not a degraded mark; it is NO marks at all. The
    // failure lands on the first token, before any wrapper is appended, so the
    // whole painter unwinds and `state/page.ts#decorateQuestions` catches a
    // rejection it reasonably reads as "no host permission". Chrome is fine,
    // so it presents as the feature working on one browser and being invisible
    // on the other — which is exactly how it was reported (CCEXT-95).
    //
    // The fallback gives up the CCEXT-58 property, but far less than it looks:
    //
    //   - It only runs where the assignment throws, i.e. Firefox < 153, and
    //     Firefox exempts content-script-injected styles from the page's CSP
    //     by design (bug 1415352). Chrome keeps the constructed sheet.
    //   - Even if a `style-src` did blank it, only the mark's APPEARANCE is in
    //     here. Its geometry is set through CSSOM `style.setProperty` on the
    //     wrapper and the box, which `style-src` does not gate — so the worst
    //     case is an unstyled but correctly placed, still-clickable button,
    //     not the silent nothing we have today.
    //
    // Per-mark rather than probed once: a handful of marks means a handful of
    // caught throws, and that is cheaper than carrying a capability flag.
    try {
      root.adoptedStyleSheets = [sheet];
    } catch {
      const fallback = document.createElement('style');
      fallback.textContent = CSS_TEXT;
      root.append(fallback);
    }

    const box = document.createElement('button');
    // A typeless <button> inside a <form> defaults to submit. Shadow DOM
    // already breaks form ownership; set it anyway, because the cost of being
    // wrong is a half-filled job application sent to an employer.
    box.setAttribute('type', 'button');
    // The panel path is fully keyboard-operable, so this is a mouse
    // accelerator and says so: otherwise a 30-field Workday form gains 30 tab
    // stops, and the glyph can be absorbed into the field's accessible name
    // (CCEXT-72).
    box.setAttribute('tabindex', '-1');
    box.setAttribute('aria-hidden', 'true');
    box.className = 'b';
    // THE GOLFER, NOT THE FLAG. Doug's rule, and the two are a pair: "the
    // golfer marks where you swing, the flag marks what you are aiming at."
    // So the page mark is the golfer — a question you have not answered yet —
    // and `⛳` belongs to the panel, where question-picker.gts uses it on the
    // row you have currently selected. This shipped as `⛳` in both places,
    // which made the mark and the target the same symbol and quietly cost the
    // distinction its whole meaning.
    //
    // The VS16 is deliberate and matches `golfer` in quick-copy-card.gts:
    // without it the codepoint can render as monochrome text rather than as
    // the emoji.
    box.textContent = '🏌️';
    box.addEventListener('click', () => {
      if (!port) return;
      try {
        port.postMessage({ type: 'cc-golf-select', token });
      } catch {
        // The panel closed between the click and the post. Nothing to do — the
        // disconnect handler is about to strip the marks anyway.
      }
    });

    root.append(box);
    document.body.append(wrapper);
    marks.push({ field, wrapper, box, onScreen: false });
  }

  // ── keeping them there ──────────────────────────────────────────────────
  //
  // Capture phase so a scroll inside any nested container is caught; passive
  // because we never preventDefault and the browser should not wait to find
  // out.
  window.addEventListener('scroll', h.onScroll, { capture: true, passive: true });
  window.addEventListener('resize', h.onResize, { passive: true });

  // The mark leaves as soon as there is text. One delegated capture-phase
  // listener rather than one per field: `input` does not bubble from inside a
  // shadow root the page may have put the field in, capture reaches it anyway,
  // and teardown stays a single removeEventListener.
  //
  // `schedule()` re-evaluates every mark, which is deliberate. A per-field
  // listener would be marginally cheaper and would miss the case that matters
  // — an ATS clearing or repopulating several fields at once on a step change.
  document.addEventListener('input', h.onInput, { capture: true, passive: true });

  // The textarea grabber. This is the observer KeePassXC has no equivalent of,
  // and the one a prose field actually needs.
  const resizes = new ResizeObserver(() => h.schedule());
  for (let i = 0; i < marks.length; i++) resizes.observe(marks[i]!.field);

  // Show/hide as fields scroll in and out of view — and, per the note on
  // `onScreen`, as they are clipped by any scrolling ancestor.
  //
  // The entries are the whole point; an observer whose callback ignores them
  // is just a change notifier with extra steps. Note also what is NOT copied
  // from keepassxc-browser here: their `updateFromIntersectionObserver`
  // repositions inside a `setTimeout(…, 400)` to wait out DOM animations,
  // which would put a visible 400ms lag on every scroll-into-view.
  const visibility = new IntersectionObserver((entries) => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      for (let j = 0; j < marks.length; j++) {
        if (marks[j]!.field === entry.target) marks[j]!.onScreen = entry.isIntersecting;
      }
    }
    h.schedule();
  });
  for (let i = 0; i < marks.length; i++) visibility.observe(marks[i]!.field);

  h.schedule();

  win.__ccGolfTeardown = (): void => {
    window.removeEventListener('scroll', h.onScroll, { capture: true });
    window.removeEventListener('resize', h.onResize);
    document.removeEventListener('input', h.onInput, { capture: true });
    resizes.disconnect();
    visibility.disconnect();
    if (frame) cancelAnimationFrame(frame);
    for (let i = 0; i < marks.length; i++) marks[i]!.wrapper.remove();
    marks.length = 0;
    delete win.__ccGolfTeardown;
  };

  // PANEL-INITIATED (CCEXT-75). The page only ever accepts; it never dials.
  // A page-initiated `runtime.connect` is an unaddressed broadcast, so two
  // windows with the panel open would cross wires and one window's teardown
  // would strip the other's marks. Accepting a point-to-point port from a
  // panel that already chose `{tabId, frameId}` makes that structurally
  // impossible.
  chrome.runtime.onConnect.addListener((incoming) => {
    // `portName`, not the GOLF_PORT const three lines up the module. That
    // const is module scope, and `injected-gate.mjs` failed the build for it —
    // esbuild kept it as a live binding the page would not have. Everything
    // this function needs comes through `args`.
    if (incoming.name !== portName) return;
    port = incoming;
    incoming.onDisconnect.addListener(() => {
      port = null;
      // Doug's rule, literally: the marks live exactly as long as the panel.
      // Closing it — or navigating, or switching tab — drops the port, and
      // this is the whole of "just remove them on destroy".
      const teardown = win.__ccGolfTeardown;
      if (teardown) teardown();
    });
  });

  return true;
}
