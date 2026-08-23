import { defineConfig } from 'vitest/config';

// Deliberately NOT the extension's vite.config.mjs.
//
// That config exists to compile .gts templates, lower decorators and resolve
// @ember/* into ember-source — none of which a domain/ test needs, and all of
// which would drag the Glimmer runtime into a test run that should be plain
// TypeScript.
//
// That constraint is the point rather than a workaround: src/domain/ is the
// layer with no chrome APIs, no DOM and no network, so its tests need no
// environment at all. If a test here ever DOES need the Glimmer pipeline,
// that is the signal the module escaped domain/ and belongs elsewhere.
export default defineConfig({
  test: {
    include: ['src/domain/**/*.test.ts'],
    environment: 'node',
  },
});
