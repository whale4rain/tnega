import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { ExecutionProvider, ProcessRequest, ShellRequest } from '@tnega/execution'
import { SecretStore, type SecretEntry, type SecretInfo } from '@tnega/secrets'
import { secretEnvExecution } from '../src/index.js'

class FakeStore extends SecretStore {
  values = new Map<string, string>()
  override async set(name: string, value: string): Promise<SecretInfo> { this.values.set(name, value); return { name, remembered: false } }
  override async remove(name: string) { return this.values.delete(name) }
  override async list() { return [...this.values.keys()].map(name => ({ name, remembered: false })) }
  override async entries(): Promise<SecretEntry[]> { return [...this.values].map(([name, value]) => ({ name, value })) }
}

function recorder() {
  const shells: ShellRequest[] = []
  const processes: ProcessRequest[] = []
  const inner: ExecutionProvider = {
    async runShell(request) { shells.push(request); return { exitCode: 0, stdout: '', stderr: '' } },
    async runProcess(request) { processes.push(request); return { exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false } },
    async fetchHttp() { throw new Error('unused') },
  }
  return { inner, shells, processes }
}

it('passes requests through untouched when no store is mounted', async () => {
  const { inner, shells } = recorder()
  const execution = secretEnvExecution(new Context(), inner)
  await execution.runShell({ command: 'true', cwd: '.' })
  expect(shells[0]).toEqual({ command: 'true', cwd: '.' })
  expect(execution.startShell).toBeUndefined()
})

it('adds the current secrets to every command, with the caller winning on a clash', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin({ name: 'fake-secrets', apply: (child: Context) => { new FakeStore(child) } })
  await fiber
  const { inner, shells, processes } = recorder()
  const execution = secretEnvExecution(ctx, inner)
  await execution.runShell({ command: 'a', cwd: '.' })
  expect(shells[0]?.env).toBeUndefined()
  // A key entered mid-turn reaches the next command.
  await ctx.secrets.set('API_KEY', 'value-1234')
  await execution.runShell({ command: 'b', cwd: '.' })
  await execution.runProcess({ argv: ['x'], cwd: '.', env: { API_KEY: 'mine', OTHER: '1' } })
  expect(shells[1]?.env).toEqual({ API_KEY: 'value-1234' })
  expect(processes[0]?.env).toEqual({ API_KEY: 'mine', OTHER: '1' })
  await fiber.dispose()
})
