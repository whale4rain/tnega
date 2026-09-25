import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // Rendering the Astryx shell and chat components under jsdom costs a few
    // seconds on the first test of a file, which the 5s default does not
    // reliably cover.
    testTimeout: 20_000,
    include: [
      'test/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
  },
})
