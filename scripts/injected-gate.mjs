#!/usr/bin/env node
// Prove that every injected function is still self-contained.
//
// `chrome.scripting.executeScript({func})` STRINGIFIES the function and
// evaluates it inside the user's page. The page has none of this project's
// modules, so a body that references anything from module scope — a Babel
// helper, a hoisted const, a shared regex, an import — throws a ReferenceError
// IN THE PAGE'S CONSOLE, which nobody is looking at. Frequently it just
// returns undefined and the feature quietly does nothing.
//
// The legacy extension is structurally immune because it has NO BUILD STEP.
// This one adds a bundler to code whose correctness depends on the absence of
// one, and the build layer has already silently changed semantics here once
// (esbuild applied TC39 decorators to .ts while .gts got legacy ones — blank
// panel, clean console). So this is checked mechanically rather than by
// discipline.
//
// Usage: node scripts/injected-gate.mjs <chrome|firefox>

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'acorn';

const target = process.argv[2] || 'chrome';
const dir = join(import.meta.dirname, '..', 'dist', target);

// Injected functions are named `ccXxx` by convention. The convention is not
// cosmetic: it is the only way to find them again in a MINIFIED bundle, which
// is the artifact we actually ship and therefore the only one worth checking.
//
// esbuild's keepNames does not preserve the identifier — it mangles the
// declaration to `function Tw(){…}` and appends a registration call
// `l(Tw, "ccGrabPayload")` carrying the original name as a STRING. So the
// gate reads that registration to map mangled -> original, then inspects the
// declaration.
//
// Free-identifier checking still works under mangling, and for a pleasing
// reason: real globals (`document`, `location`) are never renamed, while a
// module-scope reference IS — so a leak shows up as a short mangled name that
// cannot possibly be in PAGE_GLOBALS.
const INJECTED_NAME = /^cc[A-Z]/;

// Globals a page genuinely provides. Anything outside this list is either a
// bundler artefact or a module reference, and both are bugs here.
const PAGE_GLOBALS = new Set([
  'document', 'window', 'location', 'navigator', 'performance', 'console',
  'CSS', 'Node', 'Event', 'URL', 'URLSearchParams', 'Math', 'JSON', 'Date',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Promise', 'Error', 'TypeError', 'Infinity', 'NaN',
  'undefined', 'globalThis', 'parseInt', 'parseFloat', 'isNaN', 'setTimeout',
  'clearTimeout', 'getComputedStyle', 'MutationObserver',
  // The golfer painter's change detection (ccDecorateQuestions). All five are
  // page globals in both targets; they are listed because the gate's default
  // is refusal, not because they are unusual.
  //
  // ResizeObserver is the load-bearing one and the reason it is not enough to
  // copy keepassxc-browser: a <textarea> has a native resize grabber, and a
  // drag on it fires NO window resize and NO scroll. They have no
  // ResizeObserver anywhere because they only ever decorate <input>.
  //
  // CSSStyleSheet is constructed rather than declared as a <style> element
  // deliberately — adoptedStyleSheets is not subject to the page's style-src,
  // so a strict-CSP ATS cannot blank the marks (CCEXT-58).
  'requestAnimationFrame', 'cancelAnimationFrame',
  'ResizeObserver', 'IntersectionObserver', 'CSSStyleSheet',
  // ISOLATED-WORLD AMBIENT, and the only entry here that is not a page global.
  //
  // `executeScript({func})` runs in the extension's isolated world, which the
  // page cannot see but which DOES carry `chrome.runtime` — that is how
  // ccDecorateQuestions accepts a port from the panel. In the MAIN world there
  // is no `chrome`, so this allowance is only sound while nothing sets
  // `world: 'MAIN'`.
  //
  // scripts/layering-gate.mjs forbids that. Note the pairing is a CONVENTION,
  // not a construction: that gate reads `src/` and this one reads `dist/`, so
  // neither can enforce the other. If you ever add `world: 'MAIN'`, remove
  // this entry in the same commit.
  'chrome',
  'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'HTMLAnchorElement', 'HTMLLabelElement', 'Element', 'NodeList',
]);

async function* jsFiles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* jsFiles(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

/** Collect every identifier a function body reads but does not itself bind. */
function freeIdentifiers(fnNode) {
  const bound = new Set();
  const read = new Set();

  const bind = (pat) => {
    if (!pat) return;
    switch (pat.type) {
      case 'Identifier': bound.add(pat.name); break;
      case 'ObjectPattern': pat.properties.forEach((p) => bind(p.value ?? p.argument)); break;
      case 'ArrayPattern': pat.elements.forEach(bind); break;
      case 'AssignmentPattern': bind(pat.left); break;
      case 'RestElement': bind(pat.argument); break;
    }
  };

  fnNode.params?.forEach(bind);

  const walk = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'VariableDeclarator': bind(node.id); break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
        if (node.id) bound.add(node.id.name);
        node.params?.forEach(bind);
        break;
      case 'ArrowFunctionExpression': node.params?.forEach(bind); break;
      case 'ClassDeclaration': if (node.id) bound.add(node.id.name); break;
      case 'CatchClause': bind(node.param); break;
      case 'Identifier': {
        // Skip non-reference positions: `a.b`, `{b: 1}`, labels.
        const isMemberProp =
          parent?.type === 'MemberExpression' && parent.property === node && !parent.computed;
        const isKey = parent?.type === 'Property' && parent.key === node && !parent.computed;
        if (!isMemberProp && !isKey) read.add(node.name);
        break;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => walk(c, node));
      else if (child && typeof child.type === 'string') walk(child, node);
    }
  };

  walk(fnNode.body, fnNode);
  return [...read].filter((name) => !bound.has(name));
}

let checked = 0;
let failed = false;

for await (const file of jsFiles(dir)) {
  const source = await readFile(file, 'utf8');
  let ast;
  try {
    ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (error) {
    console.error(`✗ ${file}: could not parse — ${error.message}`);
    failed = true;
    continue;
  }

  // Pass 1: every function declaration/expression, by whatever name it has.
  const byName = new Map();
  // Pass 1b: keepNames registrations — `helper(Mangled, "ccOriginal")`.
  const renamed = new Map();

  const collect = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (
      (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') &&
      node.id?.name
    ) {
      byName.set(node.id.name, node);
    }
    if (
      node.type === 'CallExpression' &&
      node.arguments?.length === 2 &&
      node.arguments[0]?.type === 'Identifier' &&
      node.arguments[1]?.type === 'Literal' &&
      typeof node.arguments[1].value === 'string' &&
      INJECTED_NAME.test(node.arguments[1].value)
    ) {
      renamed.set(node.arguments[0].name, node.arguments[1].value);
    }
    for (const key of Object.keys(node)) {
      if (key === 'type') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(collect);
      else if (child && typeof child.type === 'string') collect(child);
    }
  };
  collect(ast);

  // Pass 2: anything named ccXxx outright, plus anything registered as one.
  const targets = new Map();
  for (const [name, node] of byName) {
    if (INJECTED_NAME.test(name)) targets.set(name, node);
  }
  for (const [mangled, original] of renamed) {
    const node = byName.get(mangled);
    if (node) targets.set(original, node);
  }

  for (const [name, node] of targets) {
    checked++;
    const leaks = freeIdentifiers(node).filter((id) => !PAGE_GLOBALS.has(id));
    if (leaks.length) {
      failed = true;
      console.error(`✗ ${name} (${file}) references module scope: ${leaks.join(', ')}`);
    }
  }
}

if (failed) {
  console.error(
    '\nAn injected function is not self-contained. When executeScript\n' +
      'stringifies it, the page will have no such binding — you get a\n' +
      'ReferenceError in the PAGE console, or a silent undefined result.\n' +
      'Pass the value through `args` instead of closing over it.',
  );
  process.exit(1);
}

if (checked === 0) {
  console.error('✗ injected-gate found no cc* functions — the naming convention broke, so this gate is checking nothing.');
  process.exit(1);
}

console.log(`✓ injected-gate (${target}): ${checked} injected fns, all self-contained`);
