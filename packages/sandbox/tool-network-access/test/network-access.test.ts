import { describe, expect, it } from 'vitest'
import type { SandboxNetworkRequest } from '@tnega/sandbox'
import { NETWORK_ACCESS_TOOL, NetworkGrants, createNetworkAccessTool, withGrants } from '../src/index.js'

const ALLOWLIST: SandboxNetworkRequest = { mode: 'allowlist', allowedDomains: ['github.com'], deniedDomains: ['gist.github.com'] }

function tool(network: SandboxNetworkRequest | undefined, remembered: string[][] = [], grants = new NetworkGrants()) {
  return {
    grants,
    remembered,
    run: (input: unknown, approved = true) => createNetworkAccessTool({
      grants,
      network: async () => network,
      remember: async domains => { remembered.push([...domains]) },
    }).execute(input, approved ? { approvedElevation: true } : {}),
  }
}

describe('request_network_access', () => {
  it('grants approved domains for the session and merges them into an allowlist', async () => {
    const { run, grants } = tool(ALLOWLIST)
    expect(await run({ domains: ['PyPI.org', '*.pythonhosted.org'], reason: 'pip install' })).toEqual({
      granted: ['pypi.org', '*.pythonhosted.org'], remembered: false,
      note: 'Allowed pypi.org, *.pythonhosted.org for this session on every port. Re-run the command.',
    })
    expect(await withGrants(ALLOWLIST, grants)).toEqual({ ...ALLOWLIST, allowedDomains: ['github.com', 'pypi.org', '*.pythonhosted.org'] })
  })

  it('keeps a grant on one port when the request names it, and says so', async () => {
    const { run, grants } = tool(ALLOWLIST)
    expect(await run({ domains: ['pypi.org:443'], reason: 'pip install' })).toMatchObject({
      granted: ['pypi.org:443'],
      note: 'Allowed pypi.org:443 for this session. Re-run the command.',
    })
    // "不写端口"= 所有端口，所以这里要明说；:443 则不言自明。
    expect(await run({ domains: ['files.pythonhosted.org:*'], reason: 'wheels' })).toMatchObject({
      granted: ['files.pythonhosted.org:*'],
      note: 'Allowed files.pythonhosted.org:* for this session on every port. Re-run the command.',
    })
    expect(await withGrants(ALLOWLIST, grants)).toEqual({
      ...ALLOWLIST,
      allowedDomains: ['github.com', 'pypi.org:443', 'files.pythonhosted.org:*'],
    })
  })

  it('saves to Settings only when asked to remember', async () => {
    const { run, remembered } = tool(ALLOWLIST)
    expect(await run({ domains: ['pypi.org'], reason: 'pip', remember: true })).toMatchObject({
      remembered: true, note: 'Allowed pypi.org for this and later sessions on every port. Re-run the command.',
    })
    expect(remembered).toEqual([['pypi.org']])
  })

  it('grants nothing without approval', async () => {
    const { run, grants } = tool(ALLOWLIST)
    expect(await run({ domains: ['pypi.org'], reason: 'pip' }, false)).toMatchObject({ granted: [] })
    expect(await grants.list()).toEqual([])
  })

  it('keeps the blocked list and an off network in the person\'s hands', async () => {
    expect(await tool(ALLOWLIST).run({ domains: ['gist.github.com', 'pypi.org'], reason: 'x' }))
      .toMatchObject({ granted: ['pypi.org'], stillBlocked: ['gist.github.com'] })
    const off = tool({ mode: 'off' })
    expect(await off.run({ domains: ['pypi.org'], reason: 'x' })).toMatchObject({ granted: [] })
    expect(await withGrants({ mode: 'off' }, off.grants)).toEqual({ mode: 'off' })
    expect(await tool(undefined).run({ domains: ['pypi.org'], reason: 'x' })).toMatchObject({ granted: [], note: expect.stringMatching(/open/) })
  })

  it('refuses "*" and things that are not domains', async () => {
    const { run } = tool(ALLOWLIST)
    await expect(run({ domains: ['*'], reason: 'x' })).rejects.toThrow(/"\*" is never granted/)
    await expect(run({ domains: ['https://pypi.org/simple'], reason: 'x' })).rejects.toThrow(/not a domain/)
    await expect(run({ domains: [], reason: 'x' })).rejects.toThrow(/non-empty/)
  })

  it('rebuilds earlier grants from the Session after a restart', async () => {
    const grants = new NetworkGrants(() => ({
      read: async () => [
        { type: 'tool/result', payload: { name: NETWORK_ACCESS_TOOL, ok: true, output: { granted: ['pypi.org', 'not a domain', '*', '*:443'] } } },
        { type: 'tool/result', payload: { name: NETWORK_ACCESS_TOOL, ok: false, output: { granted: ['evil.test'] } } },
        { type: 'tool/result', payload: { name: 'shell', ok: true, output: { granted: ['other.test'] } } },
      ],
    }))
    expect(await grants.list()).toEqual(['pypi.org'])
  })

  it('reads the Session once it is mounted, and again after a failed read', async () => {
    const mounted: { log?: { read: () => Promise<Array<{ type: string; payload: unknown }>> } } = {}
    let fail = true
    const grants = new NetworkGrants(() => mounted.log)
    expect(await grants.list()).toEqual([])
    mounted.log = {
      read: async () => {
        if (fail) throw new Error('disk busy')
        return [{ type: 'tool/result', payload: { name: NETWORK_ACCESS_TOOL, ok: true, output: { granted: ['pypi.org'] } } }]
      },
    }
    await expect(grants.list()).rejects.toThrow('disk busy')
    fail = false
    expect(await grants.list()).toEqual(['pypi.org'])
  })

  it('keeps the session grant when saving to Settings fails', async () => {
    const grants = new NetworkGrants()
    const result = await createNetworkAccessTool({
      grants,
      network: async () => ALLOWLIST,
      remember: async () => { throw new Error('read-only config') },
    }).execute({ domains: ['pypi.org'], reason: 'pip', remember: true }, { approvedElevation: true })
    expect(result).toMatchObject({ granted: ['pypi.org'], remembered: false, note: expect.stringMatching(/Saving them to Settings failed/) })
    expect(await grants.list()).toEqual(['pypi.org'])
  })
})
