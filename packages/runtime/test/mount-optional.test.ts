import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { Context } from '@tnega/core'

import { mountOptional } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * A capability that cannot load must not take the rest of the scope with it,
 * and must not disappear quietly: both halves are the point.
 */
it('keeps the scope alive when a capability fails, and says why', async () => {
  const ctx = new Context()
  ctx.provide('tools', {})
  const said: string[] = []
  ctx.logger.exporter({ export: message => said.push(String(message.args?.[0] ?? message)) })
  const toStderr = vi.spyOn(console, 'error').mockImplementation(() => {})

  const mounted: string[] = []
  const broken = {
    name: 'capability:broken',
    inject: ['tools'],
    async apply() { throw new Error('exceljs failed to initialise') },
  }
  const healthy = { name: 'capability:healthy', inject: ['tools'], async apply() { mounted.push('healthy') } }

  const failed = await mountOptional(ctx, 'office', () => ctx.plugin(broken, {})).then(
    () => false,
    () => true,
  )
  // The failure is contained: the caller carries on.
  expect(failed).toBe(false)

  await mountOptional(ctx, 'healthy', () => ctx.plugin(healthy, {}))
  expect(mounted).toEqual(['healthy'])

  // And it is not silent: the reason reaches the host's stderr and the logger.
  const stderr = toStderr.mock.calls.map(call => call.join(' ')).join('\n')
  expect(stderr).toContain('capability office is unavailable')
  expect(stderr).toContain('exceljs failed to initialise')
  expect(said.join('\n')).toContain('exceljs failed to initialise')

  await ctx.fiber.dispose()
})

it('mounts what works without reporting anything', async () => {
  const ctx = new Context()
  ctx.provide('tools', {})
  const toStderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  const mounted: string[] = []
  const healthy = { name: 'capability:healthy', inject: ['tools'], async apply() { mounted.push('healthy') } }
  await mountOptional(ctx, 'healthy', () => ctx.plugin(healthy, {}))
  expect(mounted).toEqual(['healthy'])
  expect(toStderr).not.toHaveBeenCalled()
  await ctx.fiber.dispose()
})

it('leaves nothing of the failed capability behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-mount-optional-'))
  dirs.push(dir)
  await writeFile(join(dir, 'keep.txt'), 'kept\n', 'utf8')
  const ctx = new Context()
  ctx.provide('tools', {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  const broken = {
    name: 'capability:broken',
    inject: ['tools'],
    async apply(fiberCtx: Context) {
      // Register something, then fail: the fiber must roll it back.
      fiberCtx.provide('halfRegistered', {})
      throw new Error('boom')
    },
  }
  await mountOptional(ctx, 'broken', () => ctx.plugin(broken, {}))
  expect(ctx.get('halfRegistered')).toBeUndefined()
  await ctx.fiber.dispose()
})
