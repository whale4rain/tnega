// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerHint } from './ComputerHint'

const missing = {
  driver: 'missing',
  install: { command: 'irm https://cua.ai/driver/install.ps1 | iex', url: 'https://cua.ai/docs/cua-driver' },
}

function stubSetup(body: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn(async () => ok
    ? new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('not found', { status: 404 })))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('ComputerHint', () => {
  it('names the install command when the driver is missing', async () => {
    stubSetup(missing)
    render(createElement(ComputerHint, { enabled: true }))
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).toContain('cua-driver is not installed')
    expect(text).toContain('irm https://cua.ai/driver/install.ps1 | iex')
    expect(text).toContain('About cua-driver')
  })

  it('also points at the Settings switch when computer use is off', async () => {
    stubSetup(missing)
    render(createElement(ComputerHint, { enabled: false }))
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByRole('status').textContent ?? '').toContain('turn Computer use on under Settings')
  })

  it('stays hidden once the driver is installed, or when the server has no such route', async () => {
    stubSetup({ ...missing, driver: 'installed' })
    const { container } = render(createElement(ComputerHint, { enabled: true }))
    await waitFor(() => expect(container.querySelector('.notice')).toBeNull())

    cleanup()
    stubSetup({}, false)
    const second = render(createElement(ComputerHint, { enabled: true }))
    await waitFor(() => expect(second.container.querySelector('.notice')).toBeNull())
  })
})
