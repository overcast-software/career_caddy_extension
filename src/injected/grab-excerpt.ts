/**
 * INJECTED. The top frame's visible text.
 *
 * Read the rules at the top of grab-payload.ts first — they all apply.
 *
 * Separate from ccGrabPayload on purpose. That one runs with `allFrames: true`
 * and joins everything reachable, because the SEND path needs the whole
 * posting even when it lives in an iframe. This is a matching HINT: the top
 * frame is the page the user is looking at, and mixing in embedded-widget text
 * makes a page harder to identify rather than easier.
 */
export function ccGrabExcerpt(): string {
  try {
    return document.body ? document.body.innerText : '';
  } catch {
    return '';
  }
}
