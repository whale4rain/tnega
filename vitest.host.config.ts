import { defineConfig } from 'vitest/config'
import { hostTests } from './vitest.layers.js'

// The host layer on its own: real builds, provider keys, GUI and OS privileges.
// `pnpm test -- --全量` runs the code layer first and then this one.
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: hostTests,
    // `.worktrees/` holds other checkouts of this repository, whose tests are
    // their own; running them here would test a different tree.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**'],
    // One host test at a time: they compete for the CPU, the display and the
    // ports that a full build needs, and they are already the slow ones.
    fileParallelism: false,
  },
})
