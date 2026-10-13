import { stripVTControlCharacters } from 'node:util'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from '../src/app.js'
import { TuiController } from '../src/controller.js'
import { deferred, fakeServer, until } from './fake-server.js'

let controller: TuiController | undefined
let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  controller?.dispose()
})

const strip = (text: string | undefined) => stripVTControlCharacters(text ?? '')

async function mount() {
  const server = fakeServer()
  controller = new TuiController(server.client, '/w', { flushMs: 1 })
  await controller.start()
  const app = render(<App controller={controller} webUrl="http://tnega.test" openUrl={() => false} />)
  unmount = app.unmount
  const type = async (text: string) => {
    app.stdin.write(text)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return { server, app, controller, type, frame: () => strip(app.lastFrame()) }
}

describe('App', () => {
  it('shows the folder, the composer and the weather on start', async () => {
    const { frame } = await mount()
    expect(frame()).toContain('/w')
    expect(frame()).toContain('Ask tnega to do something')
    expect(frame()).toContain('Ready')
    expect(frame()).toContain('DeepSeek Chat')
  })

  it('completes slash commands as you type', async () => {
    const { type, frame } = await mount()
    await type('/he')
    expect(frame()).toContain('/help')
    expect(frame()).toContain('Show keys and commands.')
  })

  it('picks a model from the completion list', async () => {
    const { type, frame, controller } = await mount()
    await type('/model Reas')
    await until(() => frame().includes('DeepSeek Reasoner'))
    // Enter takes the highlighted model, the next one sends the command.
    await type('\r')
    await type('\r')
    await until(() => controller.settings.model === 'deepseek-reasoner')
  })

  it('runs a command with nothing more to type straight from the list', async () => {
    const { type, frame } = await mount()
    await type('/sess')
    await type('\r')
    await until(() => frame().includes('Sessions in this folder'))
    expect(frame()).toContain('First')
    await type('\u001B')
    await until(() => frame().includes('Ask tnega to do something'))
  })

  it('takes the keyboard for an approval and answers it with y', async () => {
    const { server, type, frame, controller } = await mount()
    const release = deferred()
    server.state.release = release.promise
    server.state.run = [{ type: 'approval/request', id: 'a1', tool: 'shell', input: '{"command":"npm test"}' }]
    await type('run the tests')
    await type('\r')
    await until(() => frame().includes('Allow shell?'))
    expect(frame()).toContain('npm test')
    expect(frame()).toContain('Waiting for you')
    // A stray Enter must not approve.
    await type('\r')
    expect(server.calls.some(call => call.path.endsWith('/approvals/a1'))).toBe(false)
    await type('y')
    await until(() => server.calls.some(call => call.path.endsWith('/approvals/a1')))
    expect(server.calls.find(call => call.path.endsWith('/approvals/a1'))?.body).toEqual({ allow: true })
    release.resolve()
    await until(() => !controller.state.running)
  })
})
