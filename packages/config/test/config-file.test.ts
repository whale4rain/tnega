import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { availableModels, ModelRouteError, parseModelRouteInput, parseSandboxConfig, readSystemConfig, removeModelRoute, SystemConfigError, systemConfigProblem, updateSystemConfig, upsertModelRoute } from '../src/index.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function configFile(text?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-config-'))
  dirs.push(dir)
  const file = join(dir, 'config.json')
  if (text !== undefined) await writeFile(file, text, 'utf8')
  return file
}

describe('system config file', () => {
  it('keeps a whole screenshot budget for computer use and drops anything else', async () => {
    const file = await configFile(JSON.stringify({ computerUse: true, computerMaxScreenshots: 40 }))
    expect((await readSystemConfig(file)).computerMaxScreenshots).toBe(40)
    for (const bad of [-1, 2.5, '40']) {
      await writeFile(file, JSON.stringify({ computerMaxScreenshots: bad }))
      expect((await readSystemConfig(file)).computerMaxScreenshots).toBeUndefined()
    }
  })

  it('persists memory limits and disables extraction for an invalid budget file setting', async () => {
    const file = await configFile()
    await updateSystemConfig({ memoryDream: { enabled: false, modelId: 'economical', idleMinutes: 30 } }, file)
    expect((await readSystemConfig(file)).memoryDream).toEqual({ enabled: false, modelId: 'economical', idleMinutes: 30 })
    await writeFile(file, JSON.stringify({ memoryDream: { idleMinutes: 0 } }))
    expect((await readSystemConfig(file)).memoryDream).toEqual({ enabled: false })
    await updateSystemConfig({ projectMemory: { enabled: true, maxCallsPerDay: 2, coldModelId: 'economical' } }, file)
    expect((await readSystemConfig(file)).projectMemory).toEqual({ enabled: true, maxCallsPerDay: 2, coldModelId: 'economical' })
    await writeFile(file, JSON.stringify({ projectMemory: { maxCallsPerDay: -1 } }))
    expect((await readSystemConfig(file)).projectMemory).toEqual({ enabled: false })
  })
  it('persists command network rules, keeps unreadable ones so the sandbox refuses them, and clears them', async () => {
    const file = await configFile()
    await updateSystemConfig({ sandbox: { network: { mode: 'allowlist', allowedDomains: ['*.github.com', 'pypi.org:443'], deniedDomains: ['gist.github.com'] } } }, file)
    expect((await readSystemConfig(file)).sandbox).toEqual({
      network: { mode: 'allowlist', allowedDomains: ['*.github.com', 'pypi.org:443'], deniedDomains: ['gist.github.com'] },
    })
    // Dropping a bad blocked entry would widen the network, so entries stay as written.
    await writeFile(file, JSON.stringify({ sandbox: { network: { mode: 'allowlist', allowedDomains: ['ok.dev'], deniedDomains: ['http://bad', 3] } } }))
    expect((await readSystemConfig(file)).sandbox).toEqual({ network: { mode: 'allowlist', allowedDomains: ['ok.dev'], deniedDomains: ['http://bad', '3'] } })
    await updateSystemConfig({ sandbox: undefined }, file)
    expect((await readSystemConfig(file)).sandbox).toBeUndefined()
    // An unreadable mode fails closed.
    expect(parseSandboxConfig({ network: { mode: 'wide' } })).toEqual({ network: { mode: 'off' } })
    // A blocked list that is not a list stays as one entry the sandbox refuses.
    expect(parseSandboxConfig({ network: { mode: 'allowlist', deniedDomains: 'evil.dev' } }))
      .toEqual({ network: { mode: 'allowlist', deniedDomains: ['"evil.dev"'] } })
  })
  it('never saves over a file it could not parse', async () => {
    const broken = `{
  "apiKey": "sk-keep-me",
  "workspaces": ["D:/ws"],
}
`
    const file = await configFile(broken)

    expect(await readSystemConfig(file)).toEqual({})
    expect(await systemConfigProblem(file)).toMatch(/JSON/i)
    await expect(updateSystemConfig({ workspaces: ['D:/other'] }, file)).rejects.toBeInstanceOf(SystemConfigError)
    expect(await readFile(file, 'utf8')).toBe(broken)
  })

  it('still creates and updates a valid or missing file', async () => {
    const file = await configFile()
    expect(await systemConfigProblem(file)).toBeUndefined()
    await updateSystemConfig({ model: 'deepseek-flash', vision: true }, file)
    await updateSystemConfig({ workspaces: ['D:/ws'] }, file)
    expect(await readSystemConfig(file)).toEqual({ model: 'deepseek-flash', vision: true, workspaces: ['D:/ws'] })
  })
})

describe('chat model routes', () => {
  it('offers the model\'s own effort levels to a saved route that lists none, and keeps a listed set', () => {
    const config = {
      models: [
        { id: 'deepseek-flash', model: 'deepseek-flash', protocol: 'openai' as const, baseUrl: 'https://api.deepseek.com', apiKey: 'sk' },
        { id: 'pinned', model: 'deepseek-v4-pro', protocol: 'openai' as const, baseUrl: 'https://api.deepseek.com', apiKey: 'sk', reasoningEfforts: ['high' as const] },
        { id: 'plain', model: 'qwen3-coder', protocol: 'openai' as const, baseUrl: 'https://example.test/v1', apiKey: 'sk' },
      ],
    }
    expect(availableModels(config, {}).map(model => [model.id, model.reasoningEfforts])).toEqual([
      ['deepseek-flash', ['low', 'high']],
      ['pinned', ['high']],
      ['plain', []],
    ])
  })

  it('registers several models, keeps a saved key when the form leaves it blank, and removes one', async () => {
    const file = await configFile(JSON.stringify({ model: 'deepseek-flash', apiKey: 'sk-default' }))
    await upsertModelRoute('deepseek-flash', parseModelRouteInput({ name: 'DeepSeek Flash', model: 'deepseek-flash', protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds' }), file)
    await upsertModelRoute('sonnet', parseModelRouteInput({ name: 'Sonnet', model: 'claude-sonnet-5-5', protocol: 'anthropic', apiKey: 'sk-ant', contextWindow: 200000 }), file)
    // Editing without a key keeps the stored one.
    await upsertModelRoute('sonnet', parseModelRouteInput({ name: 'Sonnet 5.5', model: 'claude-sonnet-5-5', apiKey: '' }), file)

    let config = await readSystemConfig(file)
    expect(config.models?.map(route => route.id)).toEqual(['deepseek-flash', 'sonnet'])
    expect(config.models?.[1]).toMatchObject({ name: 'Sonnet 5.5', apiKey: 'sk-ant', protocol: 'anthropic', contextWindow: 200000 })
    expect(availableModels(config, {}).map(model => [model.id, model.apiKeySet])).toEqual([['deepseek-flash', true], ['sonnet', true]])

    await updateSystemConfig({ model: 'sonnet' }, file)
    config = await removeModelRoute('sonnet', file)
    expect(config.models?.map(route => route.id)).toEqual(['deepseek-flash'])
    expect(config.model).toBeUndefined()
    await expect(removeModelRoute('sonnet', file)).rejects.toBeInstanceOf(ModelRouteError)
  })

  it('rejects routes it could not call', () => {
    expect(() => parseModelRouteInput({ model: '' })).toThrow(ModelRouteError)
    expect(() => parseModelRouteInput({ model: 'x', baseUrl: 'ftp://host' })).toThrow(ModelRouteError)
    expect(() => parseModelRouteInput({ model: 'x', protocol: 'grpc' })).toThrow(ModelRouteError)
  })
})

describe('the first extra model', () => {
  it('keeps the single configured route as a registered model and as the default', async () => {
    const file = await configFile(JSON.stringify({ model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', protocol: 'openai', apiKey: 'sk-ds' }))
    const config = await upsertModelRoute('sonnet', parseModelRouteInput({ model: 'claude-sonnet-5-5', protocol: 'anthropic', apiKey: 'sk-ant' }), file)
    expect(config.models?.map(route => route.id)).toEqual(['deepseek-flash', 'sonnet'])
    expect(config.models?.[0]).toMatchObject({ model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', protocol: 'openai', apiKey: 'sk-ds' })
    expect(config.model).toBe('deepseek-flash')
  })
})
