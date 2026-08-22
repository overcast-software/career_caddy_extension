// Opening a sidebar, on two browsers that disagree about what a sidebar is.
//
//   Chrome/Edge : chrome.sidePanel.open({ tabId })   — needs the `sidePanel` permission
//   Firefox     : browser.sidebarAction.open()       — needs no permission
//
// Both require a user gesture: you may only call them synchronously inside a
// real click handler. Await something first and the browser refuses, because
// by then it can no longer prove a human asked.

/**
 * `declare global` reaches OUT of this file and adds to the global scope.
 *
 * This is needed because a file with any `import`/`export` is a *module*, and
 * a module has its own scope — so writing `interface Window {}` in here would
 * just declare a local type that happens to be called Window. `declare global`
 * says "no, really, the global one".
 */
declare global {
  /**
   * `var`, not `let`/`const` — this is the one place TypeScript still requires
   * `var`, because it is how a global binding is modelled.
   *
   * `| undefined` is the honest type: on Chrome this identifier genuinely does
   * not exist. Saying so forces every read to be guarded, which is the whole
   * point of writing this file in TypeScript rather than JavaScript.
   */
  // eslint-disable-next-line no-var
  var browser: FirefoxApi | undefined;
}

/**
 * @types/chrome describes `chrome`, but nothing on npm describes Firefox's
 * `sidebarAction` in a way we'd want to depend on. So we describe the slice we
 * actually call — three methods — and no more.
 *
 * The `?` on `sidebarAction` matters: Firefox itself may expose `browser`
 * without a sidebar (e.g. Firefox for Android). Optional means the compiler
 * will not let us call it without checking.
 */
interface FirefoxApi {
  sidebarAction?: {
    open(): Promise<void>;
    close(): Promise<void>;
    toggle(): Promise<void>;
  };
}

/**
 * A *discriminated union*. Every member has an `ok` property with a literal
 * type (`true` or `false`), and TypeScript uses that one field to work out
 * which shape you're holding:
 *
 *     const r = await openPanel(id);
 *     if (r.ok) r.host;    // ✓ compiler knows `host` exists here
 *     else      r.reason;  // ✓ and `reason` exists here
 *     r.reason;            // ✗ error — might be the ok:true shape
 *
 * This is the idiomatic alternative to throwing, and to returning
 * `{ ok, host?, reason? }` where every field is optional and nothing is
 * guaranteed. Here the *type* encodes "you get a host or a reason, never
 * both, never neither".
 */
export type PanelResult =
  | { ok: true; host: 'chrome' | 'firefox' }
  | { ok: false; reason: string };

/** Which sidebar implementation, if any, this browser has. */
export type PanelHost = 'chrome' | 'firefox' | 'unsupported';

export function detectPanelHost(): PanelHost {
  if (globalThis.chrome?.sidePanel) return 'chrome';
  if (globalThis.browser?.sidebarAction) return 'firefox';
  return 'unsupported';
}

/**
 * Open the side panel for a tab.
 *
 * Note what this does NOT do: it does not `switch (detectPanelHost())`. A
 * string returned from another function tells the compiler nothing about
 * whether `browser.sidebarAction` exists right now — the string and the object
 * are unrelated as far as the type system is concerned, and you would end up
 * writing `browser!.sidebarAction!.open()` with two non-null assertions,
 * i.e. two places where you have overruled the compiler and taken
 * responsibility yourself.
 *
 * Checking the object you are about to call *narrows* it instead: inside the
 * `if`, `sidePanel` is no longer `X | undefined`, it is `X`. Same runtime
 * behaviour, no assertions, and the compiler is still helping you.
 */
export async function openPanel(tabId: number): Promise<PanelResult> {
  const sidePanel = globalThis.chrome?.sidePanel;
  if (sidePanel) {
    try {
      await sidePanel.open({ tabId });
      return { ok: true, host: 'chrome' };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  }

  const sidebarAction = globalThis.browser?.sidebarAction;
  if (sidebarAction) {
    try {
      await sidebarAction.open();
      return { ok: true, host: 'firefox' };
    } catch (error) {
      return { ok: false, reason: describe(error) };
    }
  }

  return {
    ok: false,
    reason: 'This browser has no side panel. Chrome 114+ or Firefox 128+ is needed.',
  };
}

/**
 * `catch (error)` gives you `unknown`, not `Error` — because JavaScript lets
 * you throw literally anything (`throw 42` is legal). `unknown` is the safe
 * top type: you may hold it, but you must prove what it is before using it.
 * That proof is this function.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
