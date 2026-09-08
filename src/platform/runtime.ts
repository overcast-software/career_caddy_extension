/**
 * The extension runtime, as two questions a component is allowed to ask.
 *
 * WHY THIS EXISTS: `components/` render. The layering gate says so, and until
 * now it said so while three components reached straight for `chrome.*` —
 * the gate's own header claimed "never touch chrome.*" while rule 4 only
 * checked `chrome.storage`. A gate that asserts more than it enforces is the
 * same defect CCEXT-49 named for the sharpen button: do not carry a lie across
 * the rewrite.
 *
 * Both calls here are wrapped rather than re-exported, because both have a
 * failure mode that a component should not have to remember:
 *
 * - `getManifest()` throws when there is no extension context at all, which is
 *   the case in the vitest/static-server harness the panel is developed
 *   against. A build string is decoration; it must never be the reason the
 *   header fails to render.
 *
 * - `sendMessage()` REJECTS when nothing is listening. That is the ordinary
 *   case, not an exceptional one — no worker is registered when the panel is
 *   rendered outside an extension context — so it is an outcome to return,
 *   not an error to raise.
 *
 * `injected/` is deliberately not served from here. Those functions are
 * serialized across the `executeScript` boundary and may import types only, so
 * a shared runtime helper is exactly the module-scope reference that makes them
 * throw in the page. See `injected/grab-payload.ts`'s header.
 */

/**
 * The running build's version string, or `'?'`.
 *
 * Locally this is `manifest.mjs`'s build counter rather than package.json's
 * version, so the header visibly changes on reload — a stable version there
 * once cost a debugging cycle, reading a live fix as a failed reload.
 */
export function manifestVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '?';
  }
}

/**
 * Hand a message to the background worker and return its ack.
 *
 * Resolves to `undefined` when there is no receiver — which is NOT the same as
 * a worker that received the message and declined it, and callers that care
 * must check the ack's shape rather than its presence. `send-card` does
 * exactly that: a resolved-with-undefined is what you get when nothing handled
 * the message, and treating "did not throw" as success is what left the send
 * button dead until the user navigated away.
 */
export async function sendToWorker<T>(message: unknown): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T | undefined;
  } catch {
    return undefined;
  }
}
