import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { SecretStore, type SecretEntry, type SecretInfo } from '@tnega/secrets'
import { tools, type ToolStagePayload, type ToolsService } from '@tnega/tools'
import { toolSecrets } from '../src/index.js'

const VALUE = 'sk-live-0123456789abcdef'

class FakeStore extends SecretStore {
  values = new Map<string, string>()
  override async set(name: string, value: string): Promise<SecretInfo> { this.values.set(name, value); return { name, remembered: false } }
  override async remove(name: string) { return this.values.delete(name) }
  override async list() { return [...this.values.keys()].map(name => ({ name, remembered: false })) }
  override async entries(): Promise<SecretEntry[]> { return [...this.values].map(([name, value]) => ({ name, value })) }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(tools)
  await ctx.plugin({ name: 'fake-secrets', apply: (child: Context) => { new FakeStore(child) } })
  // A post-execute policy mounted earlier, like spill writing output to disk.
  const seenByLaterPolicy: unknown[] = []
  ctx.on('tools/post-execute', async (payload: ToolStagePayload, next: () => unknown) => {
    seenByLaterPolicy.push(payload.result.output)
    return next()
  })
  const fiber = ctx.plugin(toolSecrets)
  await fiber
  await ctx.secrets.set('API_KEY', VALUE)
  const registry: ToolsService = ctx.get('tools')
  return { ctx, registry, seenByLaterPolicy, fiber }
}

it('masks values in output and errors before any other post-execute policy sees them', async () => {
  const { registry, seenByLaterPolicy } = await setup()
  registry.register({
    schema: { name: 'leaky', description: 'prints', parameters: { type: 'object', properties: {} } },
    execute: async () => ({ stdout: `key is ${VALUE}`, exitCode: 0 }),
  })
  registry.register({
    schema: { name: 'failing', description: 'fails', parameters: { type: 'object', properties: {} } },
    execute: async () => { throw new Error(`bad key ${VALUE}`) },
  })
  const ok = await registry.execute('leaky', {})
  expect(ok.output).toEqual({ stdout: 'key is [secret: API_KEY]', exitCode: 0 })
  expect(seenByLaterPolicy[0]).toEqual({ stdout: 'key is [secret: API_KEY]', exitCode: 0 })
  const failed = await registry.execute('failing', {})
  expect(failed.ok).toBe(false)
  expect(failed.error?.message).toBe('bad key [secret: API_KEY]')
  expect(JSON.stringify(failed)).not.toContain(VALUE)
})

it('masks live progress, even a value split across pieces', async () => {
  const { registry } = await setup()
  registry.register({
    schema: { name: 'streamer', description: 'streams', parameters: { type: 'object', properties: {} } },
    execute: async (_input, options) => {
      options.progress?.(`out ${VALUE.slice(0, 10)}`)
      options.progress?.(`${VALUE.slice(10)} done`)
      return 'ok'
    },
  })
  const shown: string[] = []
  await registry.execute('streamer', {}, { progress: output => shown.push(output) })
  expect(shown.join('')).toBe('out [secret: API_KEY] done')
})

it('masks a value a command got even if the secret is gone by the time the result comes back', async () => {
  const { ctx, registry } = await setup()
  const late = 'late-key-0123456789'
  registry.register({
    schema: { name: 'latecomer', description: 'gets a key mid-call', parameters: { type: 'object', properties: {} } },
    execute: async () => {
      // The user enters a key while this call runs, a command gets it, and it
      // is removed before the result comes back.
      await ctx.secrets.set('LATE_KEY', late)
      ctx.secrets.noteInjected([{ name: 'LATE_KEY', value: late }])
      await ctx.secrets.remove('LATE_KEY')
      return `printed ${late}`
    },
  })
  expect((await registry.execute('latecomer', {})).output).toBe('printed [secret: LATE_KEY]')
})

it('masks progress from a value handed to a command after the call started', async () => {
  const { ctx, registry } = await setup()
  const late = 'late-value-0123456789'
  registry.register({
    schema: { name: 'late', description: 'streams', parameters: { type: 'object', properties: {} } },
    execute: async (_input, options) => {
      // What execution-secrets does when a command starts with a key typed mid-call.
      ctx.secrets.noteInjected([{ name: 'LATE_KEY', value: late }])
      options.progress?.(`got ${late.slice(0, 8)}`)
      options.progress?.(`${late.slice(8)}!`)
      return 'ok'
    },
  })
  const shown: string[] = []
  await registry.execute('late', {}, { progress: output => shown.push(output) })
  expect(shown.join('')).toBe('got [secret: LATE_KEY]!')
})

it('stops masking once disposed', async () => {
  const { registry, fiber } = await setup()
  registry.register({
    schema: { name: 'leaky', description: 'prints', parameters: { type: 'object', properties: {} } },
    execute: async () => VALUE,
  })
  await fiber.dispose()
  expect((await registry.execute('leaky', {})).output).toBe(VALUE)
})
