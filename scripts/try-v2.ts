/**
 * Run the v2 pieces together on this machine, for real: a `tnega daemon`
 * child process over WebSocket, an agent on DeepSeek whose files, commands
 * and browser live on that daemon, a Session kept by the JSONL store with its
 * images in the blob store, a terminal on the daemon, and a reconnect.
 *
 *   pnpm try:v2                       everything; needs DEEPSEEK_API_KEY (or a proxy that adds it)
 *   pnpm try:v2 --no-browser          skip the daemon's browser
 *   pnpm try:v2 --sandbox <mode>      the agent's command sandbox (default workspace-write)
 *
 * Each check prints ok or FAIL; the script exits 1 when any check failed.
 * See docs/test/try-v2.md for what each check covers.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { blobsLocal } from '../packages/blobs/blobs-local/src/index.js'
import { Context } from '../packages/core/src/index.js'
import { TransportBase, acceptDaemon, type DaemonLink, type Transport } from '../packages/daemon/protocol/src/index.js'
import { terminalRemote } from '../packages/daemon/terminal-remote/src/index.js'
import type { PermissionMode } from '../packages/approval-host/src/index.js'
import { createLlmAdapter } from '../packages/llm/src/index.js'
import { configureNetwork } from '../packages/process/process-local/src/index.js'
import { createAgentRuntime } from '../packages/runtime/src/index.js'
import { SessionLog, type ImageAttachment, type SessionEvent } from '../packages/session/src/index.js'
import { sessionFile, sessionStoreJsonl } from '../packages/session-store/session-store-jsonl/src/index.js'

const args = process.argv.slice(2)
const withBrowser = !args.includes('--no-browser')
const sandboxIndex = args.indexOf('--sandbox')
const sandbox = (sandboxIndex >= 0 ? args[sandboxIndex + 1] : 'workspace-write') as PermissionMode
const TOKEN = randomBytes(12).toString('hex')

let failures = 0
/** A check this machine cannot run, said plainly instead of counted as passed. */
function skip(name: string, why: string): void {
  console.log(`skip ${name} - ${why}`)
}

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}

/** A real 32x32 PNG, so the image is bytes a model and a browser would accept. */
function png(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(32, 0)
  header.writeUInt32BE(32, 4)
  header.set([8, 2, 0, 0, 0], 8)
  // A random colour each run, so the blob is new every time.
  const [r, g, b] = randomBytes(3)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(32 * 3).map((_, i) => [r!, g!, b!][i % 3]!)])
  const pixels = Buffer.concat(Array.from({ length: 32 }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * The runtime's end of one daemon WebSocket: just enough of RFC 6455 for text
 * frames, so this script needs no WebSocket server package.
 */
class ServerSocketTransport extends TransportBase implements Transport {
  private buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []

  constructor(private readonly socket: Duplex) {
    super()
    socket.on('data', (chunk: Buffer) => this.read(chunk))
    socket.on('close', () => this.markClosed('closed'))
    socket.on('error', () => this.markClosed('socket error'))
  }

  /** Answer the upgrade request; the socket then carries frames. */
  static accept(key: string, socket: Duplex): ServerSocketTransport {
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    return new ServerSocketTransport(socket)
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 2) return
      const fin = (this.buffer[0]! & 0x80) !== 0
      const opcode = this.buffer[0]! & 0x0f
      const masked = (this.buffer[1]! & 0x80) !== 0
      let length = this.buffer[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskOffset = offset
      if (masked) offset += 4
      if (this.buffer.length < offset + length) return
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= this.buffer[maskOffset + (i % 4)]!
      this.buffer = this.buffer.subarray(offset + length)
      if (opcode === 0x8) { this.close('closed by the daemon'); return }
      if (opcode === 0x9) { this.frame(0xa, payload); continue }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload)
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8')
          this.fragments = []
          this.deliver(text)
        }
      }
    }
  }

  private frame(opcode: number, payload: Buffer): void {
    const head = payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536
        ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b })()])
    this.socket.write(Buffer.concat([head, payload]))
  }

  send(message: string): void {
    if (this.closed) throw new Error('transport is closed')
    this.frame(0x1, Buffer.from(message, 'utf8'))
  }

  close(reason?: string): void {
    if (!this.markClosed(reason)) return
    this.frame(0x8, Buffer.from([0x03, 0xe8]))
    this.socket.end()
  }

  /** Drop the connection the way a network would: no close handshake. */
  drop(): void {
    this.socket.destroy()
  }
}

async function waitFor<T>(what: string, get: () => T | undefined | Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = await get()
    if (value !== undefined) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(done => setTimeout(done, 200))
  }
}

function imagesOf(events: readonly SessionEvent[]): ImageAttachment[] {
  return events.flatMap(event => event.type === 'user/message' || event.type === 'tool/result' ? event.payload.attachments ?? [] : [])
}

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'tnega-try-v2-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'tnega-try-v2-ws-'))
  process.env.TNEGA_HOME = home
  const cleanups: Array<() => Promise<void> | void> = [() => rm(home, { recursive: true, force: true }), () => rm(workspace, { recursive: true, force: true })]
  let daemon: ChildProcess | undefined
  try {
    // 1. A runtime that accepts daemons, and a real `tnega daemon` dialling it.
    const http = createServer()
    const links: Array<{ link: DaemonLink; transport: ServerSocketTransport }> = []
    http.on('upgrade', (request, socket, head) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }
      const key = request.headers['sec-websocket-key']
      if (typeof key !== 'string') {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      if (head.length) socket.unshift(head)
      const transport = ServerSocketTransport.accept(key, socket)
      acceptDaemon(transport).then(link => links.push({ link, transport }), (error: unknown) => console.log('handshake refused:', error))
    })
    await new Promise<void>(done => http.listen(0, '127.0.0.1', done))
    const address = http.address()
    const port = typeof address === 'object' && address ? address.port : 0
    cleanups.push(() => new Promise<void>(done => {
      // Upgraded sockets are not the server's to close; drop them first.
      for (const { transport } of links) transport.drop()
      http.close(() => done())
    }))
    const repo = resolve(import.meta.dirname, '..')
    daemon = spawn('pnpm', ['--silent', 'tnega', 'daemon', '--server', `ws://localhost:${port}`, '--workspace', workspace, ...(withBrowser ? ['--browser'] : [])], {
      cwd: repo,
      env: { ...process.env, TNEGA_DAEMON_TOKEN: TOKEN, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' },
      stdio: ['ignore', 'inherit', 'pipe'],
    })
    let daemonLog = ''
    daemon.stderr?.on('data', chunk => { daemonLog += String(chunk); process.stderr.write(`  [daemon] ${String(chunk)}`) })
    const first = await waitFor('the daemon to connect', () => links[0], 60_000)
    check('daemon connects over WebSocket and completes the handshake', first.link.workspaces.some(item => item.path === workspace),
      `device ${first.link.deviceId}, protocol ${first.link.protocolVersion}, services ${(first.link.capabilities.services ?? []).join(', ')}`)

    const probe = await Promise.race([
      first.link.call('fs/list', { workspaceId: first.link.workspaces[0]!.id, path: '.' }),
      new Promise(done => setTimeout(() => done('no answer in 10 s'), 10_000)),
    ]).catch((error: unknown) => error)
    console.log('  probe fs/list:', JSON.stringify(probe))
    if (withBrowser) {
      const { browserRemote } = await import('../packages/daemon/browser-remote/src/index.js')
      const probeCtx = new Context()
      const mounted = await Promise.race([
        probeCtx.plugin(browserRemote, { link: first.link }).then(async fiber => { await fiber.dispose(); return 'mounted' }),
        new Promise(done => setTimeout(() => done('no answer in 20 s'), 20_000)),
      ]).catch((error: unknown) => String(error))
      console.log('  probe browser watch:', mounted)
    }

    // 2. The state layer: blobs and the JSONL store on the runtime's machine.
    const root = new Context()
    await root.plugin(blobsLocal)
    const storeFiber = await root.plugin(sessionStoreJsonl)
    cleanups.push(() => storeFiber.dispose())
    const store = root.get('sessionStore')
    const { id } = await store.create(workspace, { title: 'try v2' })

    // 3. An agent on DeepSeek whose files and commands are on the daemon.
    const llm = createLlmAdapter({
      apiKey: process.env.DEEPSEEK_API_KEY ?? 'sk-added-by-proxy',
      baseUrl: 'https://api.deepseek.com',
      model: process.env.TNEGA_TRY_MODEL ?? 'deepseek-chat',
    })
    // The LLM call goes out through this machine's proxy, as `tnega run` sends it.
    configureNetwork({})
    console.log('  creating the agent runtime on the daemon')
    const runtime = await createAgentRuntime({
      cwd: workspace,
      sessionFile: store.backend(workspace, id),
      llm,
      allowShell: true,
      sandboxMode: sandbox,
      machine: { link: first.link },
    })
    try {
      const image: ImageAttachment = { type: 'image', mediaType: 'image/png', data: png().toString('base64'), name: 'swatch.png' }
      await writeFile(join(workspace, 'page.html'), '<!doctype html><title>v2 page</title><h1 id="mark">daemon browser ok</h1>')
      const loop = runtime.root.get('agentLoop')
      const prompt = [
        'This is an automated test. Use your tools, then answer in one line.',
        '1. Write a file named hello.txt containing exactly: v2 ok',
        '2. Run the shell command: cat hello.txt && pwd',
        '3. List the files in the workspace.',
        ...(withBrowser ? [`4. Open file://${join(workspace, 'page.html')} in the browser and read the heading text.`] : []),
        'Finish with the word DONE and the heading text if you read one.',
      ].join('\n')
      console.log('  running the agent (DeepSeek)')
      const ticker = setInterval(() => {
        const log = SessionLog.live(store.backend(workspace, id))
        void log?.read().then(events => {
          const last = events.at(-1)
          console.log(`  ... ${events.length} events, last ${last?.type} ${last?.type === 'tool/call' ? last.payload.name : ''}`)
        })
      }, 5000)
      cleanups.push(() => clearInterval(ticker))
      const run = await loop({ text: prompt, attachments: [image] }, { maxSteps: 20 })
      const live = SessionLog.live(store.backend(workspace, id))
      const liveEvents = live ? await live.read() : []
      const liveMessages = live ? await live.deriveMessages() : []
      const tools = liveEvents.flatMap(event => event.type === 'tool/result' ? [`${event.payload.name}${event.payload.ok ? '' : ' (failed)'}`] : [])
      check('the agent ran on DeepSeek and used tools', tools.length > 0, `tools: ${tools.join(', ') || 'none'}; answer: ${JSON.stringify(run.output ?? '').slice(0, 160)}`)
      const written = await readFile(join(workspace, 'hello.txt'), 'utf8').catch(() => undefined)
      check('write_file on the daemon wrote into the daemon workspace', written?.trim() === 'v2 ok', JSON.stringify(written))
      const shell = liveEvents.find(event => event.type === 'tool/result' && event.payload.name === 'shell')
      const shellText = shell?.type === 'tool/result' ? JSON.stringify(shell.payload.output ?? shell.payload.error) : ''
      if (shellText.includes('SandboxUnavailable')) {
        // Fail closed is the contract: no sandbox mechanism here means no command, not an unconfined one.
        skip(`shell on the daemon under the ${sandbox} sandbox`, 'this host has no usable sandbox, and the daemon refused the command (fails closed)')
      } else {
        check(`shell on the daemon ran under the ${sandbox} sandbox`, shell?.type === 'tool/result' && shell.payload.ok && shellText.includes('v2 ok'), shellText.slice(0, 200))
      }
      if (withBrowser) {
        const browser = liveEvents.filter(event => event.type === 'tool/result' && event.payload.name.startsWith('browser_'))
        check('the agent drove the daemon\'s browser', browser.length > 0 && JSON.stringify(browser).includes('daemon browser ok'), `${browser.length} browser calls`)
      }
      await runtime.dispose()

      // 4. The Session as stored: format 11, the image in the blob store, a replay equal to the live run.
      const text = await readFile(sessionFile(workspace, id), 'utf8')
      check('the Session log is format 11', text.includes('"formatVersion":11'))
      check('the image bytes are not in the log, only their hash', !text.includes(image.data) && /"blob":"[0-9a-f]{64}"/u.test(text))
      const blobFiles = await readdir(join(home, 'blobs'), { recursive: true }).catch(() => [])
      check('the blob store holds the image', blobFiles.some(name => /[0-9a-f]{64}$/u.test(String(name))), `${blobFiles.length} entries`)
      const replay = new SessionLog(store.backend(workspace, id))
      await replay.init()
      const same = JSON.stringify(await replay.deriveMessages()) === JSON.stringify(liveMessages)
      check('a replay derives the same model messages as the live run', same && liveMessages.length > 0, `${liveMessages.length} messages`)
      check('the replay has the image bytes back', imagesOf(await replay.read()).some(item => item.data === image.data))
      await replay.close()
      const snapshot = await store.snapshot(workspace, id)
      check('a client snapshot carries the image', imagesOf(snapshot.events).some(item => item.data === image.data))
      const summary = await store.summary(workspace, id)
      check('the summary counts the events', summary.eventCount === liveEvents.length, `${summary.eventCount} events`)
      const hits = await store.search(workspace, 'hello.txt')
      check('search finds the Session by its text', hits.some(hit => hit.id === id))
    } finally {
      await runtime.dispose().catch(() => undefined)
    }

    // 5. A terminal on the daemon.
    const terminals = new Context()
    const terminalFiber = await terminals.plugin(terminalRemote, { link: first.link })
    const term = terminals.get('terminals')
    const info = await term.create(first.link.workspaces[0]!.path)
    let output = ''
    const seen: string[] = []
    const detach = await term.attach(info.id, event => {
      seen.push(event.type)
      if (event.type === 'data') output += event.data
    }, reason => seen.push(`end: ${reason}`))
    await term.write(info.id, 'echo term-$((40+2))\n')
    await waitFor('terminal output', () => output.includes('term-42') ? true : undefined, 15_000).catch(() => undefined)
    check('a terminal on the daemon runs a command', output.includes('term-42'), `${info.id}; events ${seen.slice(0, 6).join(', ')}; output ${JSON.stringify(output.slice(-120))}`)
    detach()
    await term.close(info.id)
    await terminalFiber.dispose()

    // 6. A dropped connection: the daemon dials again and serves calls.
    first.transport.drop()
    const second = await waitFor('the daemon to reconnect', () => links[1], 60_000).catch(() => undefined)
    const listed = second ? await second.link.call('fs/list', { workspaceId: second.link.workspaces[0]!.id, path: '.' }).catch((error: unknown) => error) : undefined
    check('the daemon reconnects after a dropped connection and answers', second !== undefined && !(listed instanceof Error), JSON.stringify(listed).slice(0, 120))
    if (daemonLog.includes('Error')) console.log('  (the daemon wrote errors above)')
  } finally {
    daemon?.kill('SIGTERM')
    await new Promise(done => setTimeout(done, 500))
    for (const cleanup of cleanups.reverse()) await cleanup()
  }
}

main().then(() => {
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
}, (error: unknown) => {
  console.error(error)
  process.exit(1)
})
