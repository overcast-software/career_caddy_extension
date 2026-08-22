// Ambient types for the WebExtension APIs that @types/chrome does not cover.
//
// A `.d.ts` file is declarations only — no runtime code is emitted from it, and
// nothing imports it. TypeScript picks it up because tsconfig's `include`
// covers src/**, and the declarations below then apply across the whole
// project.

/**
 * `declare global` reaches OUT and adds to the global scope.
 *
 * A file containing any top-level `import`/`export` is a *module*, and a module
 * has its own scope — so `interface Window {}` written plainly in a module
 * declares a local type that merely happens to be called Window. `declare
 * global` says "no, really, the global one". This file has no imports, so it is
 * already a script rather than a module, but the block is kept explicit because
 * the moment anyone adds an import here the meaning would silently change.
 */
declare global {
  /**
   * Firefox exposes the WebExtension API as `browser` with promise-returning
   * methods. Chrome does not have this global at all.
   *
   * `var`, not `let`/`const` — this is the one place TypeScript still requires
   * `var`, because it is how a global binding is modelled.
   *
   * `| undefined` is the honest type: on Chrome this identifier genuinely does
   * not exist. Saying so forces every read to be guarded, which is the entire
   * reason to write cross-browser extension code in TypeScript rather than
   * JavaScript — the compiler will not let you forget which browser you are on.
   */
  // eslint-disable-next-line no-var
  var browser: FirefoxApi | undefined;
}

/**
 * Only the slice we actually call. Describing more would be inventing a
 * contract we have not tested.
 *
 * The `?` on `sidebarAction` matters: Firefox for Android exposes `browser`
 * but has no sidebar at all. Optional means the compiler requires a check
 * before the call — `globalThis.browser?.sidebarAction?.toggle()` is not
 * defensive habit, it is the type being enforced.
 */
interface FirefoxApi {
  sidebarAction?: {
    open(): Promise<void>;
    close(): Promise<void>;
    toggle(): Promise<void>;
  };
}

export {};
