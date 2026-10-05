import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isWindowsAclAvailable } from '../../sandbox/sandbox-windows-acl/src/ffi.js'
import { startWebServer } from '../src/server.js'

interface Approval { tool: string; input: string; via?: string }
interface Outcome {
  approvals: Approval[]
  transcript: string
  seenTools: string[][]
  output: string
  dispatches: unknown[]
}

/**
 * Run one CodeMode turn through the Web server: the model answers the first
 * request with `run_code(script)` and the second with "Checked.". Each
 * approval request is answered by `decide`.
 */
async function codeModeTurn(script: string, decide: (approval: Approval, index: number) => boolean, workspace: string): Promise<Outcome> {
  let requests = 0
  const seenTools: string[][] = []
  const llm = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += String(chunk) })
    req.on('end', () => {
      const body = JSON.parse(raw) as { tools?: Array<{ function: { name: string } }> }
      seenTools.push((body.tools ?? []).map(tool => tool.function.name))
      const first = ++requests === 1
      const delta = first
        ? { tool_calls: [{ index: 0, id: 'call-code', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code: script }) } }] }
        : { content: 'Checked.' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => llm.listen(0, '127.0.0.1', resolve))
  const address = llm.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const configFile = join(workspace, 'config.json')
  await writeFile(configFile, JSON.stringify({ apiKey: 'test', protocol: 'openai', model: 'mock', codeMode: true, baseUrl: `http://127.0.0.1:${address.port}/v1` }))
  const server = await startWebServer({ port: 0, configFile, browser: false })
  const url = (path: string) => `${server.url}${path}?workspace=${encodeURIComponent(workspace)}`
  const headers = { 'x-tnega-client': '1', 'content-type': 'application/json' }
  try {
    const created = await (await fetch(url('/api/sessions'), { method: 'POST', headers, body: JSON.stringify({}) })).json() as { session: { id: string } }
    const id = created.session.id
    expect((await fetch(url(`/api/sessions/${id}`), { method: 'PATCH', headers, body: JSON.stringify({ permission: 'workspace-write' }) })).status).toBe(200)

    const response = await fetch(url(`/api/sessions/${id}/runs`), { method: 'POST', headers, body: JSON.stringify({ prompt: 'Run the checks' }) })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const approvals: Approval[] = []
    let buffer = ''
    let transcript = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      transcript += chunk
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6)
        if (!data) continue
        const event = JSON.parse(data) as { type: string; id?: string; tool?: string; input?: string; via?: string }
        if (event.type !== 'approval/request') continue
        const approval = { tool: event.tool!, input: event.input!, ...(event.via ? { via: event.via } : {}) }
        approvals.push(approval)
        const decided = await fetch(url(`/api/sessions/${id}/approvals/${event.id}`), {
          method: 'POST', headers, body: JSON.stringify({ allow: decide(approval, approvals.length - 1) }),
        })
        expect(decided.status).toBe(200)
      }
    }
    const detail = await (await fetch(url(`/api/sessions/${id}`), { headers })).json() as { events: Array<{ type: string; payload: Record<string, unknown> }> }
    const result = detail.events.find(event => event.type === 'tool/result' && event.payload.name === 'run_code')
    return {
      approvals, transcript, seenTools,
      output: JSON.stringify(result?.payload.output ?? result?.payload.error),
      dispatches: detail.events.filter(event => event.type === 'meta' && event.payload.kind === 'ptc/dispatch').map(event => event.payload.ok),
    }
  } finally {
    await server.close()
    await new Promise<void>(resolve => llm.close(() => resolve()))
  }
}

/**
 * CodeMode end to end: the model only sees run_code, the script calls shell
 * through `tools`, and each shell call still meets the session's approval
 * rule (workspace-write asks a person) and runs through the same execution
 * boundary as a native call. A denial reaches the script as an exception it
 * can handle, and the outer run_code result carries both outcomes.
 */
it('asks for approval of each tool a CodeMode script calls and reports approved and denied calls', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-code-mode-approval-'))
  const script = [
    'const first = await tools.shell({ command: "node -e \\"console.log(6 * 7)\\"" })',
    'text("first: " + first.stdout.trim())',
    'try { await tools.shell({ command: "node -e \\"console.log(1)\\"" }) } catch (error) { text("second: " + String(error && error.message || error)) }',
    'return "finished"',
  ].join('\n')
  try {
    const outcome = await codeModeTurn(script, (_approval, index) => index === 0, workspace)
    expect(outcome.seenTools[0]).toEqual(['run_code'])
    expect(outcome.approvals.map(approval => approval.tool)).toEqual(['shell', 'shell'])
    // The approval card can say the call came from a script, since the model only called run_code.
    expect(outcome.approvals.map(approval => approval.via)).toEqual(['run_code', 'run_code'])
    expect(outcome.approvals[0]!.input).toContain('6 * 7')
    expect(outcome.transcript).toContain('Checked.')
    expect(outcome.output).toContain('first: 42')
    expect(outcome.output).toContain('second: ')
    expect(outcome.output).toContain('shell requires human approval in workspace-write mode')
    expect(outcome.dispatches).toEqual([true, false])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}, 60_000)

// Hosted runners lack the interactive console restricted processes need.
const sandboxReady = process.platform === 'win32' && !process.env.GITHUB_ACTIONS && await isWindowsAclAvailable()

/**
 * The sandbox keeps a CodeMode shell call inside the workspace like a native
 * one, and an approved `escalate: true` call from the script runs outside it.
 */
it.runIf(sandboxReady)('confines CodeMode shell calls to the workspace and lets an approved escalation out', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-code-mode-sandbox-'))
  const outside = await mkdtemp(join(tmpdir(), 'tnega-code-mode-outside-'))
  const target = join(outside, 'escaped.txt').replace(/\\/g, '/')
  const write = `node -e "require('fs').writeFileSync('${target}', 'x')"`
  const script = [
    `const confined = await tools.shell({ command: ${JSON.stringify(write)} })`,
    'text("confined: " + confined.exitCode)',
    `const escalated = await tools.shell({ command: ${JSON.stringify(write)}, escalate: true, justification: "write the report outside the workspace" })`,
    'text("escalated: " + escalated.exitCode)',
  ].join('\n')
  try {
    const outcome = await codeModeTurn(script, () => true, workspace)
    expect(outcome.approvals).toHaveLength(2)
    expect(outcome.approvals[1]!.input).toContain('"escalate":true')
    expect(outcome.output).toMatch(/confined: [1-9]/)
    expect(outcome.output).toContain('escalated: 0')
    expect(existsSync(target)).toBe(true)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}, 90_000)
