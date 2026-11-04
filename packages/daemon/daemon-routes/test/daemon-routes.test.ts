import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { webServer } from '@tnega/web-kit'
import { daemonRoutes } from '../src/index.js'

const MACHINE_ROUTES: Array<[string, string]> = [
  ['GET', '/api/files/tree'],
  ['GET', '/api/files/text'],
  ['POST', '/api/files/upload'],
  ['POST', '/api/folder-picker'],
  ['GET', '/api/sandbox/setup'],
  ['GET', '/api/computer/setup'],
  ['GET', '/api/browser/state'],
  ['POST', '/api/terminals'],
]

describe('daemon routes', () => {
  it('serves the machine-side routes and takes them all away on dispose', async () => {
    const root = new Context()
    await root.plugin(webServer)
    const web = root.get('webServer')
    const fiber = root.plugin(daemonRoutes, {})
    await fiber
    for (const [method, path] of MACHINE_ROUTES) {
      expect(web.match(method, path).kind, `${method} ${path}`).toBe('route')
    }
    expect(root.get('fs', false)).toBeDefined()
    await fiber.dispose()
    for (const [method, path] of MACHINE_ROUTES) {
      expect(web.match(method, path).kind, `${method} ${path}`).toBe('not-found')
    }
    expect(root.get('fs', false)).toBeUndefined()
  })
})
