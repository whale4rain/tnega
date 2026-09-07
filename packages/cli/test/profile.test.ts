import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { Plugin } from '@tnega/core'
import type { AgentLoop, LLMAdapter } from '@tnega/agent'

import {
  bootAgentRuntime,
  createAgentRuntime,
  generalAgentProfile,
  type AgentProfile,
} from '../src/index.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-profile-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('agent profile and boot', () => {
  it('merges profile options and overlay options with bundles first', () => {
    const profile: AgentProfile = {
      name: 'custom',
      options: { allowShell: true, builtinTools: false },
      bundles: [],
    }
    const options = bootAgentRuntime(
      { cwd: 'C:/work', sessionFile: 'C:/work/session.jsonl' },
      profile,
      { allowNetwork: true },
    )
    expect(options.cwd).toBe('C:/work')
    expect(options.sessionFile).toBe('C:/work/session.jsonl')
    expect(options.allowShell).toBe(true)
    expect(options.allowNetwork).toBe(true)
    expect(options.plugins).toEqual([])
  })

  it('boots a runtime from a profile with bundle plugins', async () => {
    const dir = await tempDir()
    const marker: Plugin = {
      name: 'marker',
      apply: (ctx) => {
        ctx.provide('bootMarker', { from: 'bundle' })
      },
    }
    const profile: AgentProfile = {
      name: 'bundled',
      bundles: [marker],
      options: { builtinTools: false },
    }
    const runtime = await createAgentRuntime({
      cwd: dir,
      sessionFile: join(dir, 'boot.jsonl'),
      profile,
      llm: {
        async complete() {
          return { content: 'ok', finishReason: 'stop' }
        },
      } satisfies LLMAdapter,
    })
    try {
      expect(runtime.root.get('bootMarker')).toEqual({ from: 'bundle' })
      const loop = runtime.root.get('agentLoop') as AgentLoop
      const result = await loop({ text: 'go' })
      expect(result.output).toBe('ok')
    } finally {
      await runtime.dispose()
    }
  })

  it('exposes the general profile with no bundles', () => {
    expect(generalAgentProfile.name).toBe('general')
    expect(generalAgentProfile.bundles).toEqual([])
  })
})
