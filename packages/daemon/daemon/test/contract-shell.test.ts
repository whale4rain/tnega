/**
 * Contract: the builtin tool suite (files, `shell`, `http_get`), run again
 * with every command going through a daemon over the in-process transport.
 */
import { afterAll, expect, vi } from 'vitest'
import type { ExecutionProvider } from '@tnega/process'

vi.mock('@tnega/process-local', async () => {
  const actual = await vi.importActual<typeof import('@tnega/process-local')>('@tnega/process-local')
  // The loopback imports the daemon, which imports this module: load it on first use.
  let loopback: Promise<ExecutionProvider> | undefined
  const remote = (): Promise<ExecutionProvider> => loopback ??= import('./loopback.js')
    .then(module => module.loopbackExecution(actual.localExecutionProvider))
  const provider: ExecutionProvider = {
    runShell: async request => await (await remote()).runShell(request),
    runProcess: async request => await (await remote()).runProcess(request),
    fetchHttp: async request => await (await remote()).fetchHttp(request),
    startShell: async request => await (await remote()).startShell!(request),
    startProcess: async request => await (await remote()).startProcess!(request),
    describeShell: () => actual.localExecutionProvider.describeShell?.() ?? '',
  }
  return { ...actual, localExecutionProvider: provider }
})

afterAll(async () => {
  const { closeLoopbacks } = await import('./loopback.js')
  // The suite really went through the protocol.
  expect(await closeLoopbacks()).toBeGreaterThan(0)
})

await import('../../../runtime/test/builtins.test.js')
