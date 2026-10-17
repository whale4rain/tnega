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
  it('mounts the sandbox, search, spill and office slice with builtin tools', async () => {
    const ctx = await mount({ permission: 'read-only' })
    try {
      expect(toolNames(ctx)).toEqual(expect.arrayContaining([
        'read_file', 'glob', 'grep', 'office_read',
      ]))
      expect(ctx.get('search', false)).toBeDefined()
      expect(ctx.get('spillStore', false)).toBeDefined()
      expect(ctx.get('sandbox', false)).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
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
      expect(names).toContain('office_read')
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
