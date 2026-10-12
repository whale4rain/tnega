import type { FactRecord } from '@tnega/blackboard'
import { describe, expect, it } from 'vitest'
import { PullRequestStates, parseGhState, type PullRequestState } from '../src/project-pr-state.js'

function resource(id: string, git: Record<string, unknown>, uri = `https://github.com/o/r/pull/${id}`, updatedAt = 1): FactRecord {
  return {
    kind: 'resource', id, seq: 1, version: 1, author: `thread-${id}`, source: { agentId: `thread-${id}` },
    createdAt: 1, updatedAt, deleted: false, data: { title: `Pull request #${id}`, uri, git },
  }
}

describe('pull request states', () => {
  it('reads gh output', () => {
    expect(parseGhState('{"state":"OPEN","isDraft":false}')).toBe('open')
    expect(parseGhState('{"state":"OPEN","isDraft":true}')).toBe('draft')
    expect(parseGhState('{"state":"MERGED","isDraft":false}')).toBe('merged')
    expect(parseGhState('{"state":"CLOSED"}')).toBe('closed')
    expect(parseGhState('not json')).toBeUndefined()
  })

  it('answers with the recorded state first, then what the forge says, and stops asking once merged', async () => {
    let now = 0
    const asked: string[] = []
    const answers: Record<string, PullRequestState> = { 'https://github.com/o/r/pull/1': 'merged', 'https://github.com/o/r/pull/2': 'open' }
    const states = new PullRequestStates(async url => {
      asked.push(url)
      return answers[url]
    }, () => now)
    const resources = [
      resource('1', { kind: 'pull-request', status: 'opened', number: 1, repo: 'o/r', state: 'draft' }, undefined, 2),
      resource('2', { kind: 'pull-request', status: 'opened', number: 2 }),
      resource('3', { kind: 'pull-request', status: 'failed' }, ''),
      resource('4', { kind: 'push', status: 'pushed', branch: 'x' }),
    ]
    expect(states.summarize(resources)).toEqual([
      { url: 'https://github.com/o/r/pull/1', number: 1, repo: 'o/r', threadId: 'thread-1', state: 'draft' },
      { url: 'https://github.com/o/r/pull/2', number: 2, threadId: 'thread-2', state: 'open' },
    ])
    await states.idle()
    expect(states.summarize(resources).map(pr => pr.state)).toEqual(['merged', 'open'])
    const decorated = states.decorate(resources)
    expect(decorated[0]?.data).toMatchObject({ git: { state: 'merged', number: 1 } })
    expect(decorated[3]).toBe(resources[3])
    now += 120_000
    states.summarize(resources)
    await states.idle()
    expect(asked.filter(url => url.endsWith('/1'))).toHaveLength(1)
    expect(asked.filter(url => url.endsWith('/2'))).toHaveLength(2)
  })

  it('pauses lookups when gh has no answer', async () => {
    let calls = 0
    const states = new PullRequestStates(async () => {
      calls += 1
      return undefined
    }, () => 0)
    const resources = [resource('1', { kind: 'pull-request', status: 'opened' }), resource('2', { kind: 'pull-request', status: 'opened' })]
    states.summarize(resources.slice(0, 1))
    await states.idle()
    expect(states.summarize(resources).map(pr => pr.state)).toEqual(['open', 'open'])
    await states.idle()
    expect(calls).toBe(1)
  })
})
