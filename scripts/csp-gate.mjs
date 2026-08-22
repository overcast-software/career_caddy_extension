#!/usr/bin/env node
// MV3 permits only 'none', 'self' and 'wasm-unsafe-eval' in script-src. You
// cannot add 'unsafe-eval' -- Chrome rejects the extension at INSTALL time, so
// the failure mode is "nobody can install it", not "one feature misbehaves".
//
// ember-source is clean except for @ember/template-compiler, which is built
// around new Function(). Nothing should ever import it: templates are compiled
// to wire format at build time (see vite.config.mjs). This gate proves that
// held, on the actual bytes we ship, every build.
//
// Usage: node scripts/csp-gate.mjs <chrome|firefox>

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const target = process.argv[2] || 'chrome';
const dir = join(import.meta.dirname, '..', 'dist', target);

// `new Function(` is unambiguous. For eval we require a non-word, non-dot
// character before it so we do not flag `foo.eval` or `someEvaluator(`.
const BANNED = /new\s+Function\s*\(|[^.\w]eval\s*\(/;

async function* jsFiles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* jsFiles(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

let failed = false;
let checked = 0;

for await (const file of jsFiles(dir)) {
  checked++;
  const source = await readFile(file, 'utf8');
  const match = BANNED.exec(source);
  if (!match) continue;
  failed = true;
  const line = source.slice(0, match.index).split('\n').length;
  console.error(`✗ ${file}:${line} — ${match[0].trim()}`);
  console.error(`  ${source.slice(Math.max(0, match.index - 60), match.index + 60).replace(/\n/g, ' ')}`);
}

if (failed) {
  console.error(
    '\nMV3 forbids unsafe-eval. This build would be REJECTED AT INSTALL TIME.\n' +
      'Almost certainly something now imports @ember/template-compiler —\n' +
      'check for a runtime `precompileTemplate` or a stray `hbs` import.',
  );
  process.exit(1);
}

console.log(`✓ csp-gate (${target}): ${checked} files, no eval / new Function`);
