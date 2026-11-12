import { describe, expect, it } from 'vitest'
import { ApprovalBroker } from '@tnega/approval-host'
import type { SystemConfig } from '@tnega/config'
import { Context } from '@tnega/core'
import { sessionStoreJsonl } from '@tnega/session-store-jsonl'
import type { DaemonLink } from '@tnega/daemon-protocol'
import { residentSignature, type ResidentRunRequest } from '../src/runs.js'
import { permissionNotice, sessionModelRoute } from '../src/support.js'

const stores = new Context()
await stores.plugin(sessionStoreJsonl)
const sessions = stores.get('sessionStore')

const request: ResidentRunRequest = {
  config: {} as SystemConfig,
  prompt: '',
  permission: 'workspace-write',
  sessionId: 'session',
  approvals: new ApprovalBroker(),
  agentType: 'coding',
  goalMode: false,
  effective: {
    apiKeySet: true,
    modelId: 'model',
    baseUrl: 'https://llm.invalid',
    model: 'model',
    vision: false,
  },
  apiKey: 'key',
  route: sessionModelRoute(sessions, undefined, 'workspace', 'session'),
  sessions,
}

describe('residentSignature', () => {
  it('keeps a runtime while nothing it snapshotted changed', () => {
    expect(residentSignature(request)).toBe(residentSignature({ ...request }))
  })

  it('rebuilds when the permission level changes', () => {
    // subagentLocal snapshots the level and allowShell at construction, so a
    // reused runtime would keep spawning subagents with the old level.
    for (const permission of ['read-only', 'bypass'] as const) {
      expect(residentSignature({ ...request, permission })).not.toBe(residentSignature(request))
    }
  })

  it('rebuilds when any other snapshot input changes', () => {
    expect(residentSignature({ ...request, agentType: 'general' })).not.toBe(residentSignature(request))
    expect(residentSignature({ ...request, apiKey: 'other' })).not.toBe(residentSignature(request))
    expect(residentSignature({ ...request, effective: { ...request.effective, model: 'other' } }))
      .not.toBe(residentSignature(request))
  })
})

describe('residentSignature with boxes', () => {
  it('rebuilds on a box, and again when the box came back on a new connection', () => {
    const link: DaemonLink = {
      deviceId: 'd',
      protocolVersion: 2,
      capabilities: { fs: true, process: true, http: true, platform: 'linux' },
      workspaces: [],
      closed: false,
      call: () => Promise.reject(new Error('not used')),
      onNotification: () => () => undefined,
      onClose: () => () => undefined,
      close: () => undefined,
    }
    const box = (identity: string) => ({
      machine: { link },
      cwd: '/workspace',
      identity,
      release: () => undefined,
    })
    const onBox = residentSignature({ ...request, box: box('m1:1') })
    expect(onBox).not.toBe(residentSignature(request))
    expect(residentSignature({ ...request, box: box('m1:1') })).toBe(onBox)
    expect(residentSignature({ ...request, box: box('m1:2') })).not.toBe(onBox)
  })
})

describe('permissionNotice', () => {
  it('names the level the session now runs with', () => {
    expect(permissionNotice('read-only', 'D:\\work')).toContain('read-only')
    expect(permissionNotice('workspace-write', 'D:\\work')).toContain('workspace-write')
    expect(permissionNotice('bypass', 'D:\\work')).toContain('full access')
  })

  it('tells the model where it may write, and only when writes are allowed', () => {
    expect(permissionNotice('workspace-write', 'D:\\work')).toContain('D:\\work')
    expect(permissionNotice('read-only', 'D:\\work')).not.toContain('D:\\work')
  })
})
