import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startWebServer } from '../src/server.js'

const cleanup: Array<() => Promise<void>> = []
async function drainCleanup(): Promise<void> {
  // Detach the stack before awaiting: one failed cleanup must not leak old
  // closers into the next test or prevent the remaining resources from closing.
  const closers = cleanup.splice(0).reverse()
  const errors: unknown[] = []
  for (const close of closers) {
    try { await close() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Question fixture cleanup failed')
}

afterEach(drainCleanup)

it('drains failed cleanup once without reusing old server closers', async () => {
  let closes = 0
  cleanup.push(async () => { closes += 1 })
  cleanup.push(async () => { throw new Error('fixture locked') })
  await expect(drainCleanup()).rejects.toThrow()
  expect(closes).toBe(1)
  expect(cleanup).toHaveLength(0)
  await expect(drainCleanup()).resolves.toBeUndefined()
  expect(closes).toBe(1)
})

async function setup(mode: 'blocking' | 'nonblocking', resident = true, delayReply = false) {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-question-web-'))
  cleanup.push(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const requests: Array<{ messages: Array<{ role: string; content?: string }> }> = []
  const llm = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      if (body.includes('Name this Session from the first user intent.')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '风格选择' }, finish_reason: 'stop' }] }))
        return
      }
      requests.push(JSON.parse(body))
      const question = requests.length === 1
      const delta = question ? {
        tool_calls: [{ index: 0, id: 'ask-1', type: 'function', function: {
          name: 'ask_user_question', arguments: JSON.stringify({ mode, questions: [{ id: 'style', question: '哪个风格？', options: [{ label: '简洁' }] }] }),
        } }],
      } : { content: '已完成' }
      const respond = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: question ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
      }
      if (!question && delayReply) setTimeout(respond, 200)
      else respond()
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => llm.close(error => error ? reject(error) : resolve())))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('mock address unavailable')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', model: 'mock-model', protocol: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1` }))
  const server = await startWebServer({ port: 0, configFile, resident })
  cleanup.push(server.close)
  const call = (path: string, body?: unknown) => fetch(`${server.url}${path}?workspace=${encodeURIComponent(workspace)}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'x-tnega-client': '1', 'content-type': 'application/json' },
  })
  const created = await (await call('/api/sessions', {})).json() as { session: { id: string } }
  const id = created.session.id
  return { requests, call, id }
}

async function pending(call: (path: string, body?: unknown) => Promise<Response>, id: string) {
  for (let attempts = 0; attempts < 80; attempts++) {
    const response = await call(`/api/sessions/${id}/questions`)
    const result = await response.json() as { questions: Array<{ requestId: string }> }
    if (result.questions[0]) return result.questions[0].requestId
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('question not opened')
}

it('waits for a blocking answer and returns it through the original tool result', async () => {
  const { call, id, requests } = await setup('blocking')
  const stream = await call(`/api/sessions/${id}/runs`, { prompt: '请提问' })
  const done = stream.text()
  const requestId = await pending(call, id)
  expect(requests).toHaveLength(1)
  const answered = await call(`/api/sessions/${id}/questions/${requestId}`, { answers: [{ questionId: 'style', selected: ['简洁'], text: '保留细节' }] })
  expect(answered.status).toBe(200)
  expect(await answered.json()).toMatchObject({ accepted: true, resumeQueued: false })
  expect(await done).toContain('已完成')
  expect(requests).toHaveLength(2)
  expect(requests[1]?.messages.filter(message => message.role === 'tool').at(-1)?.content).toContain('保留细节')
  expect(requests[1]?.messages.filter(message => message.role === 'user')).toHaveLength(1)
  expect((await call(`/api/sessions/${id}/questions/${requestId}`, { answers: [{ questionId: 'style', text: '重复' }] })).status).toBe(409)
})

it('durably steers a late nonblocking answer and drains it without a blank user message', async () => {
  const { call, id, requests } = await setup('nonblocking')
  await (await call(`/api/sessions/${id}/runs`, { prompt: '请提问并继续' })).text()
  const requestId = await pending(call, id)
  const result = await call(`/api/sessions/${id}/questions/${requestId}`, { answers: [{ questionId: 'style', text: '我想要详细解释' }] })
  expect(await result.json()).toMatchObject({ accepted: true, resumeQueued: true })
  await (await call(`/api/sessions/${id}/runs`, { resumeQueued: true })).text()
  expect(requests.at(-1)?.messages.some(message => message.role === 'user' && message.content?.includes('我想要详细解释'))).toBe(true)
  expect(requests.at(-1)?.messages.some(message => message.role === 'user' && message.content === '')).toBe(false)
  const created = await (await call('/api/sessions', {})).json() as { session: { id: string } }
  expect((await call(`/api/sessions/${created.session.id}/questions/${requestId}`, { answers: [] })).status).toBe(409)
})

it('admits only one simultaneous late answer when restoring a per-run session', async () => {
  const { call, id, requests } = await setup('nonblocking', false)
  await (await call(`/api/sessions/${id}/runs`, { prompt: '请提问并继续' })).text()
  const requestId = await pending(call, id)
  const responses = await Promise.all(['first', 'second'].map(text => call(`/api/sessions/${id}/questions/${requestId}`, {
    answers: [{ questionId: 'style', text }],
  })))
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  await (await call(`/api/sessions/${id}/runs`, { resumeQueued: true })).text()
  const answers = requests.at(-1)?.messages.filter(message => message.role === 'user' && message.content?.includes('User answered nonblocking request'))
  expect(answers).toHaveLength(1)
})

it.each([true, false])('consumes nonblocking answers during an active run (resident=%s)', async resident => {
  const { call, id, requests } = await setup('nonblocking', resident, true)
  const stream = await call(`/api/sessions/${id}/runs`, { prompt: '请提问并继续' })
  const done = stream.text()
  const requestId = await pending(call, id)
  const response = await call(`/api/sessions/${id}/questions/${requestId}`, { answers: [{ questionId: 'style', text: '运行中补充意见' }] })
  expect(response.status).toBe(200)
  await done
  expect(requests.at(-1)?.messages.some(message => message.role === 'user' && message.content?.includes('运行中补充意见'))).toBe(true)
})
