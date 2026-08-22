#!/usr/bin/env node
// Increment the dev build number.
//
// WHY: during development the manifest version is stable across many builds,
// so chrome://extensions shows the same number before and after a reload and
// "did my code actually update?" is unanswerable AT THE MOMENT YOU RELOAD.
// That is not hypothetical — it cost a debugging cycle: a fix WAS live, the
// version looked identical, and the result was read as a failed reload.
//
// The panel header carries a git SHA + clock stamp, but you only see that
// AFTER opening the panel. The card on chrome://extensions is where the
// question actually gets asked, and only the manifest version appears there.
//
// So `.build-no` (gitignored) drives the patch: 2.0.<n>. It is bumped ONCE
// per `npm run build`, deliberately not inside build:chrome / build:firefox,
// so both targets carry the SAME number rather than differing by one.
//
// CI never uses this — see manifest.mjs. Store builds carry the exact
// package.json version, because a reproducible build cannot depend on an
// untracked counter on one laptop.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = join(import.meta.dirname, '..', '.build-no');

let current = 0;
try {
  current = parseInt(readFileSync(file, 'utf8').trim(), 10) || 0;
} catch {
  current = 0;
}

// Chrome caps each version component at 65535. Wrapping is fine — the point
// is "it changed", not "it counts forever".
const next = (current + 1) % 65535;
writeFileSync(file, `${next}\n`);
console.log(`build #${next}`);
