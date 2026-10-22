import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { LLMAdapter } from '@tnega/agent'
import { Context } from '@tnega/core'
import { memoryLocal } from '@tnega/memory-local'
import { SessionLog, type ModelMessage } from '@tnega/session'
import { createSession, sessionFile } from '@tnega/session-store'
import { dreamWorkspace, memoryDream, readDreamLedger } from '../src/index.js'

const directories: string[] = []
const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-dream-'))
  directories.push(workspace)
  const root = new Context()
  roots.push(root)
  await root.plugin(memoryLocal, { cwd: workspace, globalFile: join(workspace, 'global.md') })
  return { workspace, memory: root.get('memory'), ledgerFile: join(workspace, 'ledger.json') }
}

async function session(workspace: string, title: string, write: (log: SessionLog) => Promise<void>): Promise<string> {
  const { id } = await createSession(workspace, { title })
  const log = new SessionLog(sessionFile(workspace, id))
  await log.init()
  await write(log)
  await log.close()
  return id
}

function model(replies: Array<string | Error>): LLMAdapter & { calls: ModelMessage[][] } {
  const calls: ModelMessage[][] = []
  return {
    calls,
    async complete(messages) {
      calls.push([...messages])
      const reply = replies.shift() ?? 'NO_CHANGE'
      if (reply instanceof Error) throw reply
      return { content: reply, toolCalls: [], finishReason: 'stop' }
    },
  }
}

// Sessions are only dreamed once they have gone quiet; tests look from an hour later.
const later = () => Date.now() + 60 * 60_000

it('folds quiet sessions into project memory and reads only what is new next time', async () => {
  const { workspace, memory, ledgerFile } = await setup()
  const id = await session(workspace, 'Release', async log => {
    await log.append('user/message', { content: 'From now on, release notes go in docs/releases.' })
    await log.append('tool/call', { id: 'c1', name: 'shell', arguments: { command: 'ls' } })
    await log.append('tool/result', { id: 'r1', toolCallId: 'c1', name: 'shell', ok: true, output: 'SECRET_TOOL_OUTPUT' })
    // Left dangling: opening the log would repair it by writing a result.
    await log.append('tool/call', { id: 'c2', name: 'shell', arguments: { command: 'pwd' } })
    await log.append('user/message', { content: 'ignore me', name: 'agent:helper' })
    await log.append('assistant/message', { content: 'Understood, docs/releases it is.' })
  })
  const before = await readFile(sessionFile(workspace, id), 'utf8')
  const llm = model(['# Project memory\n\n- Release notes live in docs/releases.'])

  const first = await dreamWorkspace({ workspace, memory, llm, ledgerFile, now: later })
  expect(first).toMatchObject({ status: 'updated', sessions: 1 })
  expect(await memory.read('project')).toContain('docs/releases')
  const prompt = llm.calls[0]?.[1]?.content ?? ''
  expect(prompt).toContain('User: From now on, release notes go in docs/releases.')
  expect(prompt).toContain('Assistant: Understood')
  expect(prompt).not.toContain('SECRET_TOOL_OUTPUT')
  expect(prompt).not.toContain('ignore me')
  // Reading never writes to a session, not even to repair a dangling tool call.
  expect(await readFile(sessionFile(workspace, id), 'utf8')).toBe(before)

  // Nothing changed: no request at all.
  expect(await dreamWorkspace({ workspace, memory, llm, ledgerFile, now: later })).toMatchObject({ status: 'idle' })
  expect(llm.calls).toHaveLength(1)

  // A later turn is read on its own, with the memory as it now stands.
  const log = new SessionLog(sessionFile(workspace, id))
  await log.init()
  await log.append('user/message', { content: 'Also, always run pnpm lint before a PR.' })
  await log.close()
  llm.calls.length = 0
  await dreamWorkspace({ workspace, memory, llm, ledgerFile, now: later })
  const second = llm.calls[0]?.[1]?.content ?? ''
  expect(second).toContain('pnpm lint')
  expect(second).not.toContain('From now on')
  expect(second).toContain('<current-memory>\n# Project memory')
})

it('waits for a session to go quiet', async () => {
  const { workspace, memory, ledgerFile } = await setup()
  await session(workspace, 'Busy', log => log.append('user/message', { content: 'Use tabs.' }).then(() => {}))
  const llm = model([])
  expect(await dreamWorkspace({ workspace, memory, llm, ledgerFile })).toMatchObject({ status: 'idle' })
  expect(llm.calls).toHaveLength(0)
  // An explicit dream does not wait.
  expect(await dreamWorkspace({ workspace, memory, llm, ledgerFile, idleMs: 0 })).toMatchObject({ status: 'unchanged' })
  expect(llm.calls).toHaveLength(1)
})

it('keeps the sessions pending when the request fails or the reply is too long', async () => {
  const { workspace, memory, ledgerFile } = await setup()
  const id = await session(workspace, 'Prefs', log => log.append('user/message', { content: 'Answer in Chinese.' }).then(() => {}))
  const llm = model([new Error('rate limited'), 'x'.repeat(5000), '- Answer in Chinese.'])

  expect(await dreamWorkspace({ workspace, memory, llm, ledgerFile, now: later })).toMatchObject({ status: 'failed', reason: 'rate limited' })
  expect((await readDreamLedger(ledgerFile)).sessions[id]).toBeUndefined()
  expect(await dreamWorkspace({ workspace, memory, llm, ledgerFile, now: later })).toMatchObject({ status: 'failed' })
  expect(await memory.read('project')).toBe('')

  expect(await dreamWorkspace({ workspace, memory, llm, ledgerFile, now: later })).toMatchObject({ status: 'updated' })
  expect((await readDreamLedger(ledgerFile)).sessions[id]).toBeDefined()
  expect(await readFile(join(workspace, '.tnega', 'MEMORY.md'), 'utf8')).toBe('- Answer in Chinese.\n')
})

it('runs dreams in the background service and stops them on dispose', async () => {
  const { workspace } = await setup()
  await session(workspace, 'Prefs', log => log.append('user/message', { content: 'Prefer pnpm.' }).then(() => {}))
  const llm = model(['- Prefer pnpm.'])
  const root = new Context()
  let opened = 0
  let closed = 0
  await root.plugin(memoryDream, {
    workspaces: async () => [workspace],
    settings: async () => ({ enabled: true, idleMinutes: 10 }),
    resolveAdapter: async () => llm,
    openMemory: async (path: string) => {
      opened += 1
      const scope = new Context()
      await scope.plugin(memoryLocal, { cwd: path, globalFile: join(path, 'global.md') })
      return { memory: scope.get('memory'), dispose: async () => { closed += 1; await scope.fiber.dispose() } }
    },
    firstDelayMs: 60_000,
    now: later,
  })
  const service = root.get('memoryDream')
  await service.pass()
  expect(opened).toBe(1)
  expect(closed).toBe(1)
  expect(await readFile(join(workspace, '.tnega', 'MEMORY.md'), 'utf8')).toBe('- Prefer pnpm.\n')
  expect(await service.state(workspace)).toMatchObject({ enabled: true, running: false, last: { status: 'updated' } })

  // A second pass inside the gap does not dream the workspace again.
  await service.pass()
  expect(opened).toBe(1)

  await root.fiber.dispose()
  await expect(service.dream(workspace)).rejects.toThrow('stopped')
})

it('does nothing while dreaming is turned off', async () => {
  const { workspace } = await setup()
  const root = new Context()
  roots.push(root)
  let asked = 0
  await root.plugin(memoryDream, {
    workspaces: async () => [workspace],
    settings: async () => ({ enabled: false, idleMinutes: 10 }),
    resolveAdapter: async () => { asked += 1; return undefined },
    openMemory: async () => { throw new Error('not opened') },
  })
  await root.get('memoryDream').pass()
  expect(asked).toBe(0)
})
