import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@tnega/core'
import { describe, expect, it } from 'vitest'
import { runtimeCapabilities } from '@tnega/runtime'

async function mount(spec: Parameters<typeof runtimeCapabilities.apply>[1]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(runtimeCapabilities, { workspace: process.cwd(), ...spec })
  return ctx
}

function toolNames(ctx: Context): string[] {
  return ctx.get('tools').list().map(tool => tool.schema.name)
}

describe('runtime capabilities', () => {
  it('mounts the sandbox, search and spill slice with builtin tools', async () => {
    const ctx = await mount({ permission: 'read-only' })
    try {
      expect(toolNames(ctx)).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'glob', 'grep']))
      expect(ctx.get('search', false)).toBeDefined()
      expect(ctx.get('spillStore', false)).toBeDefined()
      expect(ctx.get('sandbox', false)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the utility tools out unless a preset asks for them', async () => {
    const ctx = await mount({ permission: 'read-only' })
    try {
      const names = toolNames(ctx)
      for (const name of ['echo', 'calculator', 'json', 'now']) expect(names).not.toContain(name)
    } finally {
      await ctx.fiber.dispose()
    }
    const project = await mount({ permission: 'read-only', preset: 'project' })
    try {
      // Routines and reports reason about dates, so the project shape keeps it.
      expect(toolNames(project)).toContain('now')
      expect(toolNames(project)).not.toContain('echo')
    } finally {
      await project.fiber.dispose()
    }
  })

  it('mounts the office tools only when the workspace holds one, or when told to', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'tnega-compose-empty-'))
    const withSheet = await mkdtemp(join(tmpdir(), 'tnega-compose-office-'))
    try {
      await writeFile(join(withSheet, 'report.xlsx'), Buffer.from([0x50, 0x4b, 3, 4]))
      const plain = await mount({ workspace: empty, permission: 'read-only' })
      try {
        expect(toolNames(plain)).not.toContain('office_read')
      } finally {
        await plain.fiber.dispose()
      }
      const detected = await mount({ workspace: withSheet, permission: 'read-only' })
      try {
        expect(toolNames(detected)).toContain('office_read')
      } finally {
        await detected.fiber.dispose()
      }
      const forced = await mount({ workspace: empty, permission: 'read-only', office: true })
      try {
        expect(toolNames(forced)).toContain('office_read')
      } finally {
        await forced.fiber.dispose()
      }
    } finally {
      await rm(empty, { recursive: true, force: true })
      await rm(withSheet, { recursive: true, force: true })
    }
  })

  it('mounts only the prompt surface when builtin tools are off', async () => {
    const ctx = await mount({ builtin: false })
    try {
      expect(toolNames(ctx)).toEqual([])
      expect(ctx.get('sandbox', false)).toBeUndefined()
      expect(ctx.get('search', false)).toBeUndefined()
      expect(ctx.get('spillStore', false)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('gates one capability without disturbing the others', async () => {
    const ctx = await mount({ permission: 'read-only', search: false })
    try {
      const names = toolNames(ctx)
      expect(names).not.toContain('glob')
      expect(names).not.toContain('grep')
      expect(names).toContain('read_file')
      expect(ctx.get('search', false)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('mounts memory and jobs only when asked', async () => {
    const plain = await mount({ permission: 'read-only' })
    try {
      expect(plain.get('memory', false)).toBeUndefined()
      expect(plain.get('jobs', false)).toBeUndefined()
      expect(toolNames(plain)).not.toContain('job_list')
    } finally {
      await plain.fiber.dispose()
    }
    const full = await mount({
      permission: 'read-only',
      memory: true,
      jobs: { resolveSession: () => undefined },
    })
    try {
      expect(full.get('memory', false)).toBeDefined()
      expect(full.get('jobs', false)).toBeDefined()
      expect(toolNames(full)).toContain('job_list')
    } finally {
      await full.fiber.dispose()
    }
  })
})
