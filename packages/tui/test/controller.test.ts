import { afterEach, describe, expect, it } from 'vitest'
import { TuiController } from '../src/controller.js'
import { deferred, fakeServer, until } from './fake-server.js'

let controller: TuiController | undefined
afterEach(() => controller?.dispose())

function setup() {
  const server = fakeServer()
  controller = new TuiController(server.client, '/w', { flushMs: 1, questionPollMs: 50 })
  return { server, controller }
}

describe('TuiController', () => {
  it('registers the folder and lists its sessions, newest first', async () => {
    const { server, controller } = setup()
    server.state.sessions = [
      { ...server.state.sessions[0]!, id: 'old', updatedAt: 1 },
      { ...server.state.sessions[0]!, id: 'new', updatedAt: 9 },
    ]
    await controller.start()
    expect(server.calls.some(call => call.method === 'POST' && call.path === '/api/workspaces')).toBe(true)
    expect(controller.state.sessions.map(session => session.id)).toEqual(['new', 'old'])
    expect(controller.model).toEqual({ id: 'deepseek-chat', name: 'DeepSeek Chat' })
  })

  it('creates a session with the draft settings on the first send and streams the reply', async () => {
    const { server, controller } = setup()
    await controller.start()
    await controller.changeSettings({ permission: 'workspace-write', model: 'deepseek-reasoner' })
    const release = deferred()
    server.state.release = release.promise
    server.state.run = [
      { type: 'message_start', id: 'm1' },
      { type: 'message_delta', id: 'm1', delta: '你好' },
    ]
    expect(await controller.send('hi')).toBe(true)
    const patch = server.calls.find(call => call.method === 'PATCH')
    expect(patch?.body).toMatchObject({ approvalMode: 'manual', permission: 'workspace-write', model: 'deepseek-reasoner' })
    await until(() => controller.state.entries.at(-1)?.kind === 'agent'
      && JSON.stringify(controller.state.entries.at(-1)).includes('你好'))
    expect(controller.state.running).toBe(true)
    expect(controller.state.entries[0]).toMatchObject({ kind: 'user', text: 'hi' })

    release.resolve()
    await until(() => !controller.state.running)
    // The durable log has the final word once the run ends.
    expect(server.calls.filter(call => call.method === 'GET' && call.path === '/api/sessions/s2').length).toBeGreaterThan(0)
    expect(controller.state.finishedAt).toBeDefined()
  })

  it('steers a running agent instead of starting another run', async () => {
    const { server, controller } = setup()
    await controller.start()
    const release = deferred()
    server.state.release = release.promise
    await controller.send('first')
    await until(() => controller.state.running)
    await controller.send('also check tests')
    expect(server.calls.find(call => call.path.endsWith('/steer'))?.body).toMatchObject({ prompt: 'also check tests' })
    expect(server.calls.filter(call => call.path.endsWith('/runs'))).toHaveLength(1)
    release.resolve()
    await until(() => !controller.state.running)
  })

  it('stops a running agent through the server', async () => {
    const { server, controller } = setup()
    await controller.start()
    const release = deferred()
    server.state.release = release.promise
    await controller.send('long task')
    await until(() => controller.state.running)
    await controller.stop()
    expect(server.calls.some(call => call.method === 'POST' && call.path.endsWith('/stop'))).toBe(true)
    release.resolve()
    await until(() => !controller.state.running)
  })

  it('queues approvals from the stream and answers them', async () => {
    const { server, controller } = setup()
    await controller.start()
    const release = deferred()
    server.state.release = release.promise
    server.state.run = [{ type: 'approval/request', id: 'a1', tool: 'shell', input: '{"command":"rm -rf build"}' }]
    await controller.send('clean up')
    await until(() => controller.state.approvals.length === 1)
    await controller.approve(controller.state.approvals[0]!, false)
    expect(controller.state.approvals).toEqual([])
    expect(server.calls.find(call => call.path.endsWith('/approvals/a1'))?.body).toEqual({ allow: false })
    release.resolve()
    await until(() => !controller.state.running)
  })

  it('switches modes and models with client commands, and refuses unknown models', async () => {
    const { controller } = setup()
    await controller.start()
    await controller.openSession('s1')
    expect(await controller.send('/plan')).toBe(true)
    expect(controller.settings.mode).toBe('plan')
    expect(await controller.send('/model DeepSeek Reasoner')).toBe(true)
    expect(controller.settings.model).toBe('deepseek-reasoner')
    expect(await controller.send('/model gpt-9')).toBe(false)
    expect(controller.state.notice).toEqual({ tone: 'error', text: 'No model called "gpt-9".' })
  })

  it('offers the coding agent’s own commands for completion', async () => {
    const { controller } = setup()
    await controller.start()
    await controller.openSession('s1')
    await until(() => controller.state.serverCommands.length > 0)
    expect(controller.commands.map(command => command.name)).toContain('/review')
  })

  it('reports a failed run and keeps the transcript', async () => {
    const { server, controller } = setup()
    await controller.start()
    server.state.runStatus = 500
    await controller.send('hello')
    await until(() => !controller.state.running && controller.state.notice?.tone === 'error')
    expect(controller.state.notice?.text).toBe('busy')
    expect(controller.state.finishedAt).toBeUndefined()
  })

  it('bumps the transcript epoch when another session opens', async () => {
    const { controller } = setup()
    await controller.start()
    const before = controller.state.epoch
    await controller.openSession('s1')
    expect(controller.state.epoch).toBe(before + 1)
    controller.newSession()
    expect(controller.state.session).toBeUndefined()
    expect(controller.state.epoch).toBe(before + 2)
  })
})
