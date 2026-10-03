import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect, vi } from 'vitest'
import { startWebServer } from '../src/server.js'
it('creates and installs skills through slash endpoints while enforcing write permission', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tnega-skills-web-'))
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  vi.stubEnv('TNEGA_HOME', home)
  const server = await startWebServer({ port: 0, browser: false, configFile: join(home, 'config.json') })
  try {
    const query = `?workspace=${encodeURIComponent(workspace)}`
    const api = (path: string, method: string, body: unknown) => fetch(`${server.url}${path}${query}`, {
      method, headers: { 'content-type': 'application/json', 'x-tnega-client': '1' }, body: JSON.stringify(body),
    })
    const created = await api('/api/sessions', 'POST', { agentType: 'coding' }).then(response => response.json()) as { session: { id: string } }
    const path = `/api/sessions/${created.session.id}`
    const denied = await api(`${path}/coding/slash`, 'POST', { name: '/skills', args: ['create', 'example', 'Use when testing examples.'] })
    expect(denied.status).toBe(403)
    await expect(readFile(join(home, 'skills', 'example', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await api(path, 'PATCH', { permission: 'workspace-write' })).status).toBe(200)
    const saved = await api(`${path}/coding/slash`, 'POST', { name: '/skills', args: ['create', 'example', 'Use when testing examples.'] })
    expect(saved.status).toBe(200)
    expect(await readFile(join(home, 'skills', 'example', 'SKILL.md'), 'utf8')).toContain('name: example')
    await writeFile(join(workspace, 'SKILL.md'), '---\nname: imported\ndescription: Use when testing imports.\n---\n# Imported\n')
    const imported = await api(`${path}/coding/slash`, 'POST', { name: '/skills', args: ['install', 'SKILL.md'] })
    expect(imported.status).toBe(200)
    const listed = await api(`${path}/coding/slash`, 'POST', { name: '/skills', args: [] }).then(response => response.json()) as { result: { value: { skills: Array<{ name: string }> } } }
    expect(listed.result.value.skills.map(skill => skill.name)).toContain('imported')
  } finally { await server.close(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) }
}, 25_000)
