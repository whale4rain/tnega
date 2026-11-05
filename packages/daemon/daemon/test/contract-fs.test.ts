/**
 * Contract: the file tool suites, run again with `ctx.fs` served by a daemon
 * over the in-process transport. Every test of `@tnega/tool-fs` must pass
 * unchanged when the files are on the other side of the protocol.
 */
import { afterAll, expect, vi } from 'vitest'
import type { Context } from '@tnega/core'

vi.mock('@tnega/fs-local', async () => {
  const actual = await vi.importActual<typeof import('@tnega/fs-local')>('@tnega/fs-local')
  return {
    ...actual,
    // The loopback imports the daemon, which imports this module: load it only once mocked.
    fsLocal: {
      name: 'fs-local',
      async apply(ctx: Context) {
        const { loopbackFsLocal } = await import('./loopback.js')
        loopbackFsLocal.apply(ctx)
      },
    },
  }
})

afterAll(async () => {
  const { closeLoopbacks } = await import('./loopback.js')
  // The suite really went through the protocol.
  expect(await closeLoopbacks()).toBeGreaterThan(0)
})

await import('../../../fs/tool-fs/test/fs-tools.test.js')
await import('../../../fs/tool-fs/test/read-budget.test.js')
