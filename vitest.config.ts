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
      // agenda-web page renderers are plain .mjs (no build step); their tests
      // live beside them and import only the pure render fns, never serve.mjs
      // (which starts an HTTPS server on import).
      'tools/agenda-page/*.test.mjs',
      // container/agent-runner is a separate TS build (its own tsconfig,
      // compiled by container/build.sh) with no test runner of its own. Its
      // pure (fs/stdin/query-free) modules — e.g. mcp-servers.ts — are unit
      // tested beside them; the repo's vitest can run these directly since
      // they have no runtime dependency on the container image.
      'container/agent-runner/src/**/*.test.ts',
      // Container git hooks are plain .mjs run inside the agent image; their
      // pure logic (coauthor.mjs) is unit-tested beside them.
      'container/hooks/*.test.mjs',
    ],
  },
});
