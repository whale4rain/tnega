// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { BackgroundJobs } from './BackgroundJobs'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows jobs after the foreground run, stops one and retains its result', async () => {
  let stopped = false
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const url = new URL(path, 'http://localhost')
    expect(url.searchParams.get('workspace')).toBe('/work')
    const job = { id: 'job1', kind: 'tool', label: 'Long tests', status: stopped ? 'killed' : 'running', startedAt: 1, reported: false }
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ job_id: 'job1', action: 'stop' })
      stopped = true
      return Response.json({ job: { ...job, status: 'stopping' } })
    }
    return Response.json(url.searchParams.has('job_id') ? { job, output: 'Partial test result' } : { jobs: [job] })
  })
  const view = render(createElement(BackgroundJobs, { workspace: '/work', sessionId: 'session' }))
  fireEvent.click(await view.findByRole('button', { name: /Background tasks/ }))
  expect(await view.findByText('Long tests')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Stop Long tests' }))
  await waitFor(() => expect(view.queryByRole('button', { name: 'Stop Long tests' })).toBeNull())
  fireEvent.click(view.getByRole('button', { name: 'Output Long tests' }))
  expect(await view.findByText('Partial test result')).toBeTruthy()
  expect(view.getByText('Stopped')).toBeTruthy()
})

it('clears the previous session while loading another session', async () => {
  vi.stubGlobal('fetch', async (path: string) => Response.json({ jobs: path.includes('/first/')
    ? [{ id: 'job1', kind: 'tool', label: 'First work', status: 'running', startedAt: 1, reported: false }] : [] }))
  const view = render(createElement(BackgroundJobs, { workspace: '/work', sessionId: 'first' }))
  fireEvent.click(await view.findByRole('button', { name: /Background tasks/ }))
  expect(await view.findByText('First work')).toBeTruthy()
  view.rerender(createElement(BackgroundJobs, { workspace: '/work', sessionId: 'second' }))
  await waitFor(() => expect(view.queryByText('First work')).toBeNull())
})
