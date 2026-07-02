import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      // Smithers sidecar (not part of the src build; runs on Bun in prod).
      // Its unit tests import only dependency-free modules (model-router,
      // container-agent), so the repo's vitest can run them.
      'orchestration/**/*.test.ts',
      // Example-profile plugins are plain .mjs (no build step); their tests
      // live beside them in __tests__/ (which the plugin loader's
      // non-recursive directory scan ignores).
      'profiles/example/plugins/__tests__/*.test.mjs',
      // kb-ui is a plain .mjs Express app; its pure helpers (e.g. roster.mjs)
      // are unit-tested beside them. The test files import only the helpers,
      // never server.mjs (which starts a server on import).
      'kb-ui/**/*.test.mjs',
    ],
  },
});
