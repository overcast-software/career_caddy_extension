#!/usr/bin/env node
// Enforce the module seams, so they stay real rather than aspirational.
//
// The layout this checks:
//
//   injected/   the executeScript boundary. Serialized into the user's page,
//               so it may import TYPES only — a value import becomes a
//               module-scope reference that does not exist there.
//   platform/   the only place chrome.* / browser.* is named.
//   domain/     pure. No chrome, no DOM, no fetch. This is what makes it
//               testable, and vitest.config.mjs depends on it staying true.
//   data/       the only place fetch / RequestManager appears.
//   state/      the only place storage is written.
//   components/ never fetch, never touch chrome.*, never touch storage.
//
// Written as greps rather than a lint plugin on purpose: three rules that
// anyone can read and change beat a config nobody understands. The moment a
// rule needs an exception, that exception should be visible here.
//
// Usage: node scripts/layering-gate.mjs

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..', 'src');

async function* files(dir, ext = ['.ts', '.gts']) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path, ext);
    else if (ext.some((e) => entry.name.endsWith(e))) yield path;
  }
}

const violations = [];
const note = (file, line, rule, detail) =>
  violations.push({ file: relative(root, file), line, rule, detail });

for await (const file of files(root)) {
  const rel = relative(root, file);
  const source = await readFile(file, 'utf8');
  const lines = source.split('\n');

  lines.forEach((text, i) => {
    const n = i + 1;
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(text);

    // 1. injected/ may import TYPES only.
    //
    // A value import survives bundling as a module-scope reference, and the
    // page has no such binding. injected-gate.mjs catches the consequence in
    // the built output; this catches the cause in the source, where the fix
    // is obvious.
    if (rel.startsWith('injected/') && /^\s*import\s/.test(text)) {
      if (!/^\s*import\s+type\s/.test(text)) {
        note(file, n, 'injected/ imports a VALUE', text.trim());
      }
    }

    // 2. domain/ is pure — no chrome, no DOM, no network.
    //
    // Not tidiness: vitest runs domain/ with `environment: node` and no
    // browser shims at all. A domain module that reaches for `document` does
    // not fail a rule, it fails to run.
    if (rel.startsWith('domain/') && !isComment) {
      if (/\bchrome\./.test(text)) note(file, n, 'domain/ touches chrome.*', text.trim());
      if (/\bfetch\s*\(/.test(text)) note(file, n, 'domain/ calls fetch', text.trim());
      if (/\bdocument\.|window\./.test(text)) {
        note(file, n, 'domain/ touches the DOM', text.trim());
      }
    }

    // 3. components/ render. They do not fetch, store, or call browser APIs —
    //    those belong to state/ and data/, which components read through.
    if (rel.startsWith('components/') && !isComment) {
      if (/\bfetch\s*\(/.test(text)) note(file, n, 'component calls fetch', text.trim());
      if (/chrome\.storage/.test(text)) {
        note(file, n, 'component touches storage', text.trim());
      }
    }
  });
}

if (violations.length) {
  console.error('✗ layering-gate\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.rule}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    'These seams are what keep domain/ testable and injected/ serializable.\n' +
      'If a rule genuinely needs an exception, add it to this file so the\n' +
      'exception is visible rather than implied.',
  );
  process.exit(1);
}

console.log('✓ layering-gate: seams intact');
