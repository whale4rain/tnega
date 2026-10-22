import { describe, expect, it } from 'vitest'
import type { SandboxSetup } from '@tnega/client/types'
import { showsMxcHint } from './sandbox-hint'

const install = { command: 'npm install -g @microsoft/mxc-sdk', url: 'https://www.npmjs.com/package/@microsoft/mxc-sdk' }
const setup = (mxc: SandboxSetup['mxc']): SandboxSetup => ({ mxc, install })

describe('showsMxcHint', () => {
  it('shows only when Windows could use MXC but its executor is missing', () => {
    expect(showsMxcHint(setup('missing'), 'show')).toBe(true)
    expect(showsMxcHint(setup('installed'), 'show')).toBe(false)
    expect(showsMxcHint(setup('unsupported'), 'show')).toBe(false)
    expect(showsMxcHint(setup('disabled'), 'show')).toBe(false)
  })

  it('stays hidden after it is dismissed, and before the setup has loaded', () => {
    expect(showsMxcHint(setup('missing'), 'dismissed')).toBe(false)
    expect(showsMxcHint(undefined, 'show')).toBe(false)
  })
})
