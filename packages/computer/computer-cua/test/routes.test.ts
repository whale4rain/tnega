import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { webServer } from '@tnega/web-kit'
import { computerSetupRoutes, DRIVER_INSTALL_COMMAND, type ComputerSetup } from '../src/index.js'

const temps: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A file that passes the executable check, standing in for the real binary. */
async function driverFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-cua-setup-'))
  temps.push(dir)
  const file = join(dir, process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver')
  await writeFile(file, '')
  await chmod(file, 0o755)
  return file
}

/** Mount the route behind a real HTTP server, the way the host serves it. */
async function ask(configured?: string): Promise<ComputerSetup> {
  const ctx = new Context()
  await ctx.plugin(webServer)
  const fiber = await ctx.plugin(computerSetupRoutes, configured ? { driverPath: configured } : {})
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const match = ctx.webServer.match(req.method ?? 'GET', url.pathname)
    if (match.kind !== 'route') throw new Error(`no route for ${url.pathname}: ${match.kind}`)
    void match.handler(req, res, url)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/computer/setup`)
    expect(response.status).toBe(200)
    return await response.json() as ComputerSetup
  } finally {
    await fiber.dispose()
  }
}

describe('computer setup route', () => {
  it('reports the configured driver as installed, with the path it found', async () => {
    const file = await driverFile()
    const body = await ask(file)
    expect(body.driver).toBe('installed')
    expect(body.path).toBe(file)
    expect(body.install.command).toBe(DRIVER_INSTALL_COMMAND)
  })

  it('reports a missing driver and the command that installs it', async () => {
    const body = await ask(join(tmpdir(), 'tnega-no-such-driver-anywhere'))
    expect(body.driver).toBe('missing')
    expect(body.path).toBeUndefined()
    expect(body.install.command).toContain('cua.ai/driver/install')
    expect(body.install.url).toContain('cua.ai')
  })

  it('answers from the filesystem alone, without starting the driver', async () => {
    // The fixture is empty, so a probe that started it would fail differently;
    // this only has to not hang and not need a working binary.
    const body = await ask(join(tmpdir(), 'tnega-definitely-absent', 'cua-driver.exe'))
    expect(body.driver).toBe('missing')
  })
})
