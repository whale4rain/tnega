import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { SessionLog, session, type ModelAttachment, type ModelMessage } from '@tnega/session'
import { tools, withAttachments, type ToolsService } from '@tnega/tools'

import { agent, type AgentLoop, type LLMAdapter, type LLMCompletion } from '../src/index.js'

const SCREEN: ModelAttachment = { type: 'image', mediaType: 'image/png', data: 'c2NyZWVu' }
const SHOT: ModelAttachment = { type: 'image', mediaType: 'image/jpeg', data: 'c2hvdA==' }

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-attachments-'))
  dirs.push(dir)
  return join(dir, name)
}

function scriptedLLM(sequence: LLMCompletion[]): { adapter: LLMAdapter; calls: ModelMessage[][] } {
  const calls: ModelMessage[][] = []
  return {
    calls,
    adapter: {
      async complete(messages) {
        calls.push(structuredClone([...messages]))
        return sequence[Math.min(calls.length - 1, sequence.length - 1)]!
      },
    },
  }
}

describe('message attachments', () => {
  it('persists user and tool images and replays them into the next request', async () => {
    const file = await tempFile('images.jsonl')
    const root = new Context()
    await root.plugin(session, { file })
    await root.plugin(tools)
    ;(root.get('tools') as ToolsService).register({
      schema: { name: 'screenshot', description: 'capture the page' },
      execute: () => withAttachments({ width: 1280, height: 800 }, [SHOT]),
    })
    const { adapter, calls } = scriptedLLM([
      { toolCalls: [{ id: 'call_1', name: 'screenshot', arguments: {} }], finishReason: 'tool_calls' },
      { content: 'the button is misaligned', finishReason: 'stop' },
    ])
    await root.plugin(agent, { llm: adapter })

    const loop = root.get('agentLoop') as AgentLoop
    const result = await loop({ text: 'compare with this mock', attachments: [SCREEN] })

    expect(result.output).toBe('the button is misaligned')
    expect(calls[0]!.at(-1)).toEqual({ role: 'user', content: 'compare with this mock', attachments: [SCREEN] })
    const toolMessage = calls[1]!.find(message => message.role === 'tool')
    expect(toolMessage?.attachments).toEqual([SHOT])
    expect(toolMessage?.content).toBe('{"width":1280,"height":800}')

    const log = root.get('session') as SessionLog
    const events = await log.read()
    const user = events.find(event => event.type === 'user/message')
    const toolResult = events.find(event => event.type === 'tool/result')
    expect(user?.payload).toMatchObject({ attachments: [SCREEN] })
    expect(toolResult?.payload).toMatchObject({ output: { width: 1280, height: 800 }, attachments: [SHOT] })

    // A fresh reader of the durable log derives the same model-visible images.
    await log.flush()
    const reader = new Context()
    await reader.plugin(session, { file })
    const derived = await (reader.get('session') as SessionLog).deriveMessages()
    expect(derived.find(message => message.role === 'user')?.attachments).toEqual([SCREEN])
    expect(derived.find(message => message.role === 'tool')?.attachments).toEqual([SHOT])
  })
})
