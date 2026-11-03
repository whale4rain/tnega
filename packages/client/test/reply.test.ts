import { expect, it } from 'vitest'
import { presentTool, replyItems, type Block, type ToolView } from '../src/index.js'

const call = (name: string, args: unknown, output: unknown, status: ToolView['status'] = 'ok'): ToolView => ({ callId: `${name}-${status}`, name, args, output, status })

it('collects what a turn handed over, including calls inside CodeMode, and skips failed ones', () => {
  const sent = call('send_file', { paths: ['a.png'] }, { sent: [{ path: 'a.png', name: 'a.png', size: 1, kind: 'image' }] })
  const form = call('show_ui', { components: [{ id: 'root', component: 'Text', text: 'Hi' }] }, { shown: true })
  const failed = call('show_ui', { components: [] }, undefined, 'error')
  const blocks: Block[] = [
    { kind: 'tool', id: '1', tool: { ...call('run_code', { code: '' }, {}), children: [sent] } },
    { kind: 'tool', id: '2', tool: form },
    { kind: 'tool', id: '3', tool: failed },
  ]
  expect(replyItems(blocks).map(item => item.kind)).toEqual(['files', 'ui'])
})

it('names reply steps by what they show', () => {
  expect(presentTool(call('send_file', { paths: ['a.png', 'b.pdf'] }, {}))).toMatchObject({ verb: 'Sent', target: 'a.png, b.pdf' })
  expect(presentTool(call('show_ui', { title: 'Pick a plan', components: [] }, {}))).toMatchObject({ verb: 'Showed a form', target: 'Pick a plan' })
})
