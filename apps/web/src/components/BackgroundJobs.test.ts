// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { BackgroundJobs } from './BackgroundJobs'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows workspace processes with logs, local URLs and direct stop controls', async () => {
  let stopped = false
  let reads = 0
  const openBrowser = vi.fn()
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path.includes('/jobs')) return Response.json({ jobs: [] })
    if (path.includes('/api/browser/navigate')) {
      expect(JSON.parse(String(init?.body))).toEqual({ url: 'http://localhost:4321/' })
      return Response.json({})
    }
    const process = { id: 'p1', command: 'npm run dev', cwd: '/work', startedAt: 1, status: stopped ? 'killed' : 'running', urls: ['http://localhost:4321/'] }
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ process_id: 'p1', action: 'stop' })
      stopped = true
      return Response.json({ process: { ...process, status: 'killed' } })
    }
    return Response.json(path.includes('process_id=') ? { process, output: ++reads === 1 ? 'server ready' : 'server ready\nrequest served' } : { processes: [process] })
  })
  const view = render(createElement(BackgroundJobs, { workspace: '/work', sessionId: 'session', onOpenBrowser: openBrowser }))
  fireEvent.click(await view.findByRole('button', { name: /Background tasks/ }))
  expect(await view.findByText('npm run dev')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'http://localhost:4321/' }))
  expect(openBrowser).toHaveBeenCalledWith('http://localhost:4321/')
  fireEvent.click(view.getByRole('button', { name: /Background tasks/ }))
  fireEvent.click(view.getByRole('button', { name: 'Output npm run dev' }))
  expect(await view.findByText('server ready')).toBeTruthy()
  await waitFor(() => expect(view.getByText(/request served/)).toBeTruthy(), { timeout: 3500 })
  fireEvent.click(view.getByRole('button', { name: 'Stop npm run dev' }))
  expect(await view.findByText('Stopped')).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Stop npm run dev' })).toBeNull()
})

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
