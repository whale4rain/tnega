import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // Some end-to-end server tests spawn processes and exceed the 5s default.
    testTimeout: 20_000,
    include: [
      'test/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
  },
})
