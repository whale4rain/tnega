import { describe, expect, it } from 'vitest'
import type { ComputerSetup } from '@tnega/client/types'
import { showsComputerHint } from './computer-hint'

const install = { command: 'irm https://cua.ai/driver/install.ps1 | iex', url: 'https://cua.ai/docs/cua-driver' }
const setup = (driver: ComputerSetup['driver']): ComputerSetup => ({ driver, install })

describe('showsComputerHint', () => {
  it('appears only when the driver is missing and was not dismissed', () => {
    expect(showsComputerHint(setup('missing'), 'show')).toBe(true)
    expect(showsComputerHint(setup('missing'), 'dismissed')).toBe(false)
  })

  it('stays away once the driver is installed', () => {
    expect(showsComputerHint(setup('installed'), 'show')).toBe(false)
  })

  it('stays away when the server has no such route, which an older one does not', () => {
    expect(showsComputerHint(undefined, 'show')).toBe(false)
  })
})
