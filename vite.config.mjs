import { defineConfig } from 'vite';
import { templateTag } from '@embroider/vite';
import { transformAsync } from '@babel/core';
import { createRequire } from 'node:module';
import templateCompilation from 'babel-plugin-ember-template-compilation';
import decoratorTransforms from 'decorator-transforms';
import typescript from '@babel/plugin-transform-typescript';
import { buildManifest } from './manifest.mjs';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// ember-source ships every @ember/* and @glimmer/* package under
// dist/{dev,prod}/packages/, exposed only through the subpath export "./*".
// Inside a real Ember app, Embroider's resolver maps the bare specifiers to
// those paths. We are deliberately NOT an Ember app -- no Application, no
// router, no resolver -- so we do that one job ourselves.
//
// This ~20 lines is the entire cost of running Glimmer standalone.
// ---------------------------------------------------------------------------
function emberSourceResolver({ dev = false } = {}) {
  const flavour = dev ? 'dev' : 'prod';
  const root = require.resolve('ember-source/package.json').replace(/package\.json$/, '');
  return {
    name: 'ember-source-resolver',
    enforce: 'pre',
    resolveId(source) {
      // @glimmer/component is its own npm package (it is the component
      // manager, and it imports FROM ember-source). Everything else under
      // @ember/* and @glimmer/* lives inside ember-source itself.
      if (source === '@glimmer/component') return null;
      const m = /^(@ember|@glimmer)\/(.+)$/.exec(source);
      if (!m) return null;
      return `${root}dist/${flavour}/packages/${m[1]}/${m[2]}/index.js`;
    },
  };
}

// ---------------------------------------------------------------------------
// THE LOAD-BEARING LINE IS `targetFormat: 'wire'`.
//
// It compiles every <template> to Glimmer's wire format AT BUILD TIME. The
// alternative -- shipping @ember/template-compiler and compiling in the
// browser -- uses new Function(), which MV3 forbids outright. Not "warns
// about": Chrome refuses to install the extension. scripts/csp-gate.mjs
// enforces this on the built output so it can never regress silently.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// `enforce: 'pre'` IS LOAD-BEARING. Do not change it to 'post'.
//
// Vite hands .ts files to esbuild, which implements TC39 STANDARD decorators
// and calls a decorator as `tracked(undefined, context)`. `@glimmer/tracking`'s
// `tracked` is a LEGACY decorator expecting `(target, key, descriptor)`, so it
// receives `undefined` as its target and stores it as a WeakMap key. The whole
// module then dies at evaluation with:
//
//     Uncaught TypeError: Invalid value used as weak map key
//
// …and because that happens during module evaluation, the panel renders
// NOTHING, with an empty #root and no error from any code you wrote. It looks
// exactly like "the extension didn't load".
//
// .gts files hid this: content-tag rewrites them before esbuild sees them, so
// they reached decorator-transforms correctly while plain .ts files did not —
// two different decorator protocols in one bundle, only one of them right.
//
// Running 'pre' means babel strips the types, compiles the templates and
// lowers the decorators FIRST; esbuild then only ever sees plain JS with no
// decorators left to misinterpret.
// ---------------------------------------------------------------------------
function glimmerBabel() {
  return {
    name: 'glimmer-babel',
    enforce: 'pre',
    async transform(code, id) {
      if (id.includes('node_modules')) return null;
      if (!/\.(gts|gjs|ts|js)($|\?)/.test(id)) return null;
      const out = await transformAsync(code, {
        // Babel keys some behaviour off the extension, and it does not know
        // .gts/.gjs -- by this point content-tag has already turned them into
        // ordinary TS/JS, so we tell Babel what they now are.
        filename: id.replace(/\.gts($|\?)/, '.ts$1').replace(/\.gjs($|\?)/, '.js$1'),
        babelrc: false,
        configFile: false,
        plugins: [
          [typescript, { allowDeclareFields: true }],
          [templateCompilation, { targetFormat: 'wire' }],
          [decoratorTransforms, { runtime: { import: 'decorator-transforms/runtime' } }],
        ],
      });
      return out ? { code: out.code, map: out.map } : null;
    },
  };
}

/** Emit the per-target manifest.json alongside the bundle. */
function emitManifest(target) {
  return {
    name: 'emit-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(buildManifest(target), null, 2) + '\n',
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const target = mode === 'firefox' ? 'firefox' : 'chrome';
  return {
    plugins: [emberSourceResolver(), templateTag(), glimmerBabel(), emitManifest(target)],
    // Substituted as a literal before bundling, so `if (__TARGET__ === 'chrome')`
    // becomes `if ('firefox' === 'chrome')` and Rollup deletes the branch. This
    // is how Chrome-only API calls stay OUT of the Firefox bundle entirely,
    // rather than being guarded at runtime -- a runtime guard is safe but still
    // trips web-ext lint's UNSUPPORTED_API, which an AMO reviewer has to read.
    define: { __TARGET__: JSON.stringify(target) },
    build: {
      outDir: `dist/${target}`,
      emptyOutDir: true,
      // Two entries, and neither is an index.html — an extension has no SPA
      // shell and no router. The panel is the only UI surface; background.ts
      // is a separate runtime with no DOM at all.
      rollupOptions: {
        input: {
          panel: 'panel.html',
          background: 'src/background.ts',
        },
        output: {
          // A service worker must be at a predictable path, and manifest.json
          // names it literally -- so it cannot carry a content hash.
          entryFileNames: (chunk) =>
            chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        },
      },
    },
  };
});
