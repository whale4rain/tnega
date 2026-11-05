import { describe, expect, it } from 'vitest'
import { Context } from '@tnega/core'
import type { BoxSpec } from '@tnega/machine'
import { E2BMachines } from '../src/index.js'

/**
 * Against a real E2B runtime (self-hosted on a KVM host, or E2B's cloud).
 * Runs only when TNEGA_E2B_API_URL, TNEGA_E2B_API_KEY and TNEGA_E2B_TEMPLATE
 * (a template built from deploy/e2b/template) are set.
 */
const apiUrl = process.env.TNEGA_E2B_API_URL
const apiKey = process.env.TNEGA_E2B_API_KEY
const template = process.env.TNEGA_E2B_TEMPLATE

describe.skipIf(!apiUrl || !apiKey || !template)('E2B machines on a real runtime', () => {
  it('starts a box, pauses and resumes the same one, and stops it', async () => {
    const machines = new E2BMachines(new Context(), { apiUrl: apiUrl ?? '', apiKey: apiKey ?? '', timeoutSeconds: 300 })
    const key = `tnega-e2e-${Date.now()}`
    const spec: BoxSpec = {
      template: template ?? '',
      // Nothing listens here; the box only has to exist.
      daemon: { serverUrl: 'wss://tnega.invalid/daemon', token: 'e2e' },
      workspacePath: '/workspace',
      network: { mode: 'none' },
      isolation: 'microvm',
      specHash: 'e2e',
    }
    const { ref } = await machines.start(key, spec)
    try {
      expect(await machines.status(ref)).toBe('running')
      await machines.pause(ref)
      expect(await machines.status(ref)).toBe('paused')
      expect(await machines.start(key, spec)).toEqual({ ref })
      expect(await machines.status(ref)).toBe('running')
    } finally {
      await machines.stop(ref)
    }
    expect(await machines.status(ref)).toBe('missing')
  }, 180_000)
})
