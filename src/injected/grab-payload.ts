/**
 * INJECTED FUNCTIONS.
 *
 * Everything in this file is serialized by `chrome.scripting.executeScript`
 * and evaluated inside the USER'S PAGE, not the panel. Three consequences,
 * all of them absolute:
 *
 *   1. NO closing over module scope. A bundler is free to rewrite a function
 *      body to reference a hoisted helper or an import, and the page has no
 *      such binding — you get a ReferenceError in the PAGE's console, which
 *      you are not looking at. Pass everything through `args`.
 *   2. NO imports. Type-only imports are fine; they are erased.
 *   3. Only JSON crosses back. A DOM node cannot, which is why the field
 *      resolver stamps an attribute and the writer re-finds it by that stamp.
 *   4. NO NESTED NAMED FUNCTIONS. This one is a build-layer trap and it is not
 *      obvious: `esbuild: { keepNames: true }` in vite.config.mjs rewrites
 *      every named function — declaration, named expression, AND arrow
 *      assigned to a const — into `__name(fn, "original")`. Inside an injected
 *      function that `__name` helper is a module-scope reference the page does
 *      not have, so the whole function throws on injection. Measured, not
 *      assumed: an **object literal of methods** (`const h = { tidy(s) {…} }`)
 *      is the one form esbuild leaves alone, so shared helpers go there. See
 *      resolve-field.ts, which is the only injected function big enough to
 *      need any, and scripts/injected-gate.mjs, which caught this.
 *
 * The legacy extension was structurally immune to (1) and (4) because it had
 * no build step. This one is not, which is why the rules are written here
 * rather than assumed.
 */

export interface PagePayload {
  url: string;
  title: string;
  text: string;
}

/** Injected. The whole page as text, plus its URL. */
export function ccGrabPayload(): PagePayload {
  return {
    url: location.href,
    title: document.title || '',
    text: document.body ? document.body.innerText : '',
  };
}

/**
 * Injected. Counts cross-origin iframes.
 *
 * `allFrames: true` reaches same-origin subframes only, so an embedded ATS
 * form (Greenhouse inside company.com/careers is the classic) is invisible.
 * Knowing HOW MANY frames were unreadable is what lets the UI say "this form
 * is somewhere I'm not allowed to look" instead of "nothing found" — the same
 * words for a permission boundary and for user error is the worst possible
 * diagnostic.
 */
export function ccCountUnreachableFrames(): number {
  let blocked = 0;
  const frames = document.querySelectorAll('iframe');
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame) continue;
    try {
      // Cross-origin frames throw here rather than returning null in some
      // engines, so both paths have to count as blocked — that IS the signal.
      if (!frame.contentDocument) blocked++;
    } catch {
      blocked++;
    }
  }
  return blocked;
}
