import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBoxdArgs } from '../src/boxd-command.js'
import { commandHelp } from '../src/help.js'
import { loadServerSettings } from '../src/server-command.js'

describe('tnega boxd', () => {
  it('needs a workspace root, so a server cannot mount any folder of the host', () => {
    expect(() => parseBoxdArgs([])).toThrow(/--workspace-root/)
  })

  it('needs an owner, and never root', () => {
    expect(() => parseBoxdArgs(['--workspace-root', '/srv'])).toThrow(/--owner/)
    expect(() => parseBoxdArgs(['--workspace-root', '/srv', '--owner', 'root'])).toThrow(/root/)
    expect(() => parseBoxdArgs(['--workspace-root', '/srv', '--owner', '0'])).toThrow(/root/)
  })

  it('reads the socket, group, roots and runsc settings', () => {
    const parsed = parseBoxdArgs(['--owner', 'tnega-server', '--workspace-root', 'members', '--workspace-root', '/srv/work', '--group', 'tnega-box', '--socket', '/run/x.sock', '--platform', 'ptrace', '--runsc', '/opt/runsc'])
    expect(parsed).toEqual({
      socket: resolve('/run/x.sock'),
      group: 'tnega-box',
      workspaceRoots: [resolve('members'), resolve('/srv/work')],
      owners: ['tnega-server'],
      config: { platform: 'ptrace', runsc: '/opt/runsc' },
    })
    expect(parseBoxdArgs(['--workspace-root', '/srv', '--owner', '1001']).socket).toBe(resolve('/run/tnega/boxd.sock'))
  })

  it('refuses unknown options and platforms', () => {
    expect(() => parseBoxdArgs(['--workspace-root', '/srv', '--owner', '1001', '--exec', 'sh'])).toThrow(/unknown option/)
    expect(() => parseBoxdArgs(['--workspace-root', '/srv', '--owner', '1001', '--platform', 'vm'])).toThrow(/--platform/)
    expect(() => parseBoxdArgs(['--workspace-root'])).toThrow(/needs a value/)
  })

  it('has help', () => {
    expect(commandHelp('boxd')).toContain('--workspace-root')
  })

  it('passes TNEGA_BOXD_SOCKET from server settings on to the boxes', async () => {
    const settings = await loadServerSettings('/nonexistent-tnega-dir', { DATABASE_URL: 'postgres://x', TNEGA_MASTER_KEY: 'k', TNEGA_BOXD_SOCKET: '/run/tnega/boxd.sock' })
    expect(settings.boxes.TNEGA_BOXD_SOCKET).toBe('/run/tnega/boxd.sock')
  })
})
