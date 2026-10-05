// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../lib/api'
import type { ConfigSnapshot } from '../lib/types'
import { ChatGptSignIn } from './ChatGptSignIn'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('opens the ChatGPT sign-in page, waits for the account, then refreshes the models', async () => {
  let state: Awaited<ReturnType<typeof api.chatgptLogin>> = { status: 'signed-out' }
  vi.spyOn(api, 'chatgptLogin').mockImplementation(async () => state)
  vi.spyOn(api, 'startChatgptLogin').mockImplementation(async () => {
    state = { status: 'pending', url: 'https://auth.openai.com/oauth/authorize?x=1' }
    return { url: state.url }
  })
  const snapshot = { config: { models: [] } } as unknown as ConfigSnapshot
  vi.spyOn(api, 'config').mockResolvedValue(snapshot)
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const onChanged = vi.fn()
  const view = render(createElement(ChatGptSignIn, { onChanged }))
  fireEvent.click(await view.findByRole('button', { name: /Sign in with ChatGPT/ }))
  await waitFor(() => expect(open).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?x=1', '_blank', 'noopener'))
  expect(await view.findByText(/Finish signing in in your browser/)).toBeTruthy()
  state = { status: 'signed-in', email: 'me@example.com' }
  expect(await view.findByText(/Signed in to ChatGPT as me@example.com/, {}, { timeout: 4000 })).toBeTruthy()
  expect(onChanged).toHaveBeenCalledWith(snapshot)
})
