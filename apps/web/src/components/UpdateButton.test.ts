// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDesktopUpdates, type UpdateState } from '../lib/desktop-updates'
import { UpdateButton, UpdateSettings } from './UpdateButton'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness() {
  const updates = useDesktopUpdates()
  return createElement('div', null, createElement(UpdateButton, { updates }), createElement(UpdateSettings, { updates }))
}

function stubBridge(initial: UpdateState) {
  let emit: (state: unknown) => void = () => {}
  const bridge = {
    state: vi.fn(async () => initial),
    check: vi.fn(async () => ({ status: 'idle', version: initial.version, checkedAt: 1 })),
    install: vi.fn(async () => {}),
    setChannel: vi.fn(async (channel: string) => ({ status: 'idle', version: initial.version, channel })),
    onState: vi.fn((listener: (state: unknown) => void) => { emit = listener; return () => {} }),
  }
  vi.stubGlobal('tnegaDesktop', { updates: bridge })
  return { bridge, emit: (state: unknown) => act(() => emit(state)) }
}

it('renders nothing outside the desktop app', () => {
  const view = render(createElement(Harness))
  expect(view.container.textContent).toBe('')
})

it('shows download progress, then restarts into the downloaded release', async () => {
  const { bridge, emit } = stubBridge({ status: 'idle', version: '0.4.5' })
  const view = render(createElement(Harness))
  expect(await view.findByText('Tnega 0.4.5')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Check for updates' }))
  expect(bridge.check).toHaveBeenCalledOnce()

  emit({ status: 'downloading', version: '0.4.5', next: '0.4.6', percent: 37 })
  expect(view.getByRole('status').textContent).toBe('37%')

  emit({ status: 'ready', version: '0.4.5', next: '0.4.6' })
  fireEvent.click(view.getByRole('button', { name: 'Update' }))
  expect(bridge.install).toHaveBeenCalledOnce()
  expect(view.getByText('Version 0.4.6 is ready. Restart to update.')).toBeTruthy()
})

it('ignores malformed states from the bridge', async () => {
  const { emit } = stubBridge({ status: 'idle', version: '0.4.5' })
  const view = render(createElement(Harness))
  await view.findByText('Tnega 0.4.5')
  emit({ status: 'exploded' })
  expect(view.getByText('Tnega 0.4.5')).toBeTruthy()
})

it('selects preview updates and disables switching during a download', async () => {
  const { emit } = stubBridge({ status: 'idle', version: '0.4.6' })
  const view = render(createElement(Harness))
  const selector = await view.findByRole('combobox', { name: 'Update channel' })
  expect(Reflect.get(selector, 'value')).toBe('stable')
  fireEvent.change(selector, { target: { value: 'preview' } })
  await vi.waitFor(() => expect(Reflect.get(selector, 'value')).toBe('preview'))
  emit({ status: 'downloading', version: '0.4.6', next: '0.4.7-beta.1', percent: 5, channel: 'preview' })
  expect(Reflect.get(selector, 'disabled')).toBe(true)
})
