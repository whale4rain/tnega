import { defineConfig } from 'vitest/config'

// 全量 with an explicit file filter: the caller already named the files, so this
// is one run over the code layer and the host layer together. See
// `vitest.layers.ts` for which files the host layer is.
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      'test/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.tsx',
      'apps/**/test/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    // `.worktrees/` holds other checkouts of this repository, whose tests are
    // their own; running them would test a different tree.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
  },
})
