import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools } from '@tnega/tools'
import { projectClock } from '../src/clock.js'

it('mounts now, which returns the current time and goes away with its plugin', async () => {
  const root = new Context()
  await root.plugin(tools)
  const fiber = await root.plugin(projectClock)
  const registry = root.get('tools')
  const before = Date.now()
  const result = await registry.execute('now', {})
  expect(result.ok).toBe(true)
  const stamp = Date.parse(String(result.output))
  expect(stamp).toBeGreaterThanOrEqual(before - 1000)
  expect(stamp).toBeLessThanOrEqual(Date.now() + 1000)
  await fiber.dispose()
  expect(registry.has('now')).toBe(false)
})
