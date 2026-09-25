import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'test/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
  },
})
