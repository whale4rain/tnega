import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { tools } from '@tnega/tools'

import { hasOfficeFiles, officeCapability } from '../src/index.js'

/**
 * Office tools are loaded when the capability mounts, not when this barrel is
 * imported, so the check that decides whether to mount it has to keep working.
 */
it('mounts the office tools on demand, and only for a workspace that has office files', async () => {
  const withFiles = await mkdtemp(join(tmpdir(), 'tnega-office-yes-'))
  const without = await mkdtemp(join(tmpdir(), 'tnega-office-no-'))
  try {
    await writeFile(join(withFiles, 'report.xlsx'), '')
    await writeFile(join(without, 'notes.txt'), '')

    expect(await hasOfficeFiles(withFiles)).toBe(true)
    expect(await hasOfficeFiles(without)).toBe(false)

    const ctx = new Context()
    await ctx.plugin(tools)
    await ctx.plugin(officeCapability, { workspace: withFiles })
    const names = (ctx.get('tools') as unknown as { list(): Array<{ schema: { name: string } }> })
      .list().map(tool => tool.schema.name)
    expect(names).toContain('office_read')
    expect(names).toContain('office_inspect')
    await ctx.fiber.dispose()
  } finally {
    await rm(withFiles, { recursive: true, force: true })
    await rm(without, { recursive: true, force: true })
  }
})
