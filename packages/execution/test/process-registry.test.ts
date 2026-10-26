import { expect, it } from 'vitest'
import { ProcessRegistry } from '../src/processes.js'

it('exposes live process output and retains stopped output', async () => {
  const registry = new ProcessRegistry()
  let code: number | null | undefined
  let text = '\u001b[32mready http://localhost:4321/\u001b[0m\n'
  let finish: (code: number | null) => void = () => {}
  const exited = new Promise<number | null>(resolve => { finish = resolve })
  const entry = registry.add('npm run dev', '/work', {
    pid: 123, output: () => text, exitCode: () => code, exited,
    kill: async () => { code = null; finish(null) },
  })
  expect(registry.list()).toMatchObject([{ id: entry.id, command: 'npm run dev', status: 'running', urls: ['http://localhost:4321/'] }])
  expect(registry.read(entry.id)?.output).toContain('ready')
  text += 'next line\n'
  expect(registry.read(entry.id)?.output).toContain('next line')
  expect(await registry.stop(entry.id)).toMatchObject({ status: 'killed' })
  expect(registry.read(entry.id)?.output).toContain('next line')
  expect(await registry.stop('unknown')).toBeUndefined()
})
