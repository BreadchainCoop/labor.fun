import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      // Example-profile plugins are plain .mjs (no build step); their tests
      // live beside them in __tests__/ (which the plugin loader's
      // non-recursive directory scan ignores).
      'profiles/example/plugins/__tests__/*.test.mjs',
    ],
  },
});
