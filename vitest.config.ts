import { defineConfig } from 'vitest/config'
import { ignoredByDefault } from './vitest.layers.js'

// The code layer: deterministic, host-independent. `pnpm test -- --全量`
// switches to `vitest.full.config.ts`, which adds the host layer.
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // Some end-to-end server tests spawn processes and exceed the 5s default.
    testTimeout: 20_000,
    include: [
      'test/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.tsx',
      'apps/**/test/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    exclude: ignoredByDefault,
  },
})
