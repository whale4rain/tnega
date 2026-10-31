import { defineConfig } from 'vitest/config'

/**
 * Everything in one pass: the code layer and the host layer together.
 *
 * Two callers: `pnpm test -- --全量 <files>`, where the caller named the files,
 * and the release gate (`scripts/release-ci.mjs`), which must see the package
 * artifact tests in the same report as the rest of the suite. The gate is what
 * keeps the timeouts here honest: they match the default configuration, so
 * running everything cannot be more lenient than running the code layer alone.
 */
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // Same budget as `vitest.config.ts`. A test that needs longer says so on the
    // test itself, which is how the release gate has always been run.
    testTimeout: 20_000,
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
