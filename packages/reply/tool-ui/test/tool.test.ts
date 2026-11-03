import { expect, it } from 'vitest'
import { Context } from '@tnega/core'
import { tools, type ToolsService } from '@tnega/tools'
import { toolUi } from '../src/index.js'

it('shows a form, ends the turn when it waits for the person and unregisters on dispose', async () => {
  const root = new Context()
  await root.plugin(tools)
  const registry: ToolsService = root.get('tools')
  const plugin = root.plugin(toolUi)
  await plugin
  const form = await registry.execute('show_ui', {
    components: [
      { id: 'root', component: 'Column', children: ['q', 'go'] },
      { id: 'q', component: 'TextField', label: 'Name', path: '/name' },
      { id: 'go', component: 'Button', label: 'Send', action: 'submit' },
    ],
  }, { callId: 'call-1' })
  expect(form).toMatchObject({ ok: true, concludesTurn: true, output: { shown: true, surface: 'call-1', components: 3 } })

  const card = await registry.execute('show_ui', { components: [{ id: 'root', component: 'Text', text: 'Done' }] }, { callId: 'call-2' })
  expect(card.ok).toBe(true)
  expect(card.concludesTurn).toBeUndefined()

  const broken = await registry.execute('show_ui', { components: [{ id: 'root', component: 'Column', children: ['gone'] }] }, {})
  expect(broken).toMatchObject({ ok: false, error: { message: expect.stringMatching(/unknown component "gone"/) } })

  await plugin.dispose()
  expect(registry.list().some(tool => tool.schema.name === 'show_ui')).toBe(false)
})
