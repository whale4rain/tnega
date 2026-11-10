/**
 * Try the v2 box layer (milestone 2) by hand, before the server can run an
 * agent in a box. Each part runs on its own:
 *
 *   pnpm try:boxes proxy            the egress proxy on this machine; try it with curl
 *   pnpm try:boxes setup [folder]   read a .tnega/environment.toml and run its setup here
 *   pnpm try:boxes template         build the box template on E2B (needs E2B_API_KEY)
 *   pnpm try:boxes box --template <name> [--keep]
 *                                   start, pause, resume and stop a real E2B microVM
 *   pnpm try:boxes gvisor [--template <name>] [--keep]
 *                                   check this host for gVisor boxes (no KVM needed), then
 *                                   start, pause, resume and stop one (as root)
 *
 * See docs/test/try-boxes.md for what each part shows and what to look for.
 */
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '../packages/core/src/index.js'
import { startEgressProxy, createRootCertificate, tokenPolicies } from '../packages/machine/egress-proxy/src/index.js'
import { approvalHash, ENVIRONMENT_FILE, parseEnvironment, runSetup } from '../packages/machine/environment/src/index.js'
import { MachineError, type BoxSpec } from '../packages/machine/machine/src/index.js'
import { buildBoxTemplate, E2BMachines } from '../packages/machine/machine-e2b/src/index.js'
import { GvisorMachines, probeGvisorHost } from '../packages/machine/machine-gvisor/src/index.js'
import { localExecutionProvider } from '../packages/process/process-local/src/index.js'

const OUT = resolve('.tnega-try')
const TOKEN = 'try-agent'

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function proxy(args: readonly string[]): Promise<void> {
  const port = Number(option(args, '--port') ?? 8899)
  const root = createRootCertificate('tnega try-out egress CA')
  const egress = await startEgressProxy({ host: '127.0.0.1', port }, {
    root,
    policy: tokenPolicies([[TOKEN, {
      name: 'try-box/agent',
      allow: ['example.com'],
      // A harmless header stands in for a key, so you can see it arrive.
      credentials: [{ host: 'httpbin.org', headers: { 'X-Tnega-Try': 'added-by-the-egress-proxy' } }],
    }]]),
    // Behind a company proxy, the egress proxy's own traffic goes through it.
    upstream: () => process.env.HTTPS_PROXY ?? process.env.https_proxy,
    noProxy: () => process.env.NO_PROXY ?? process.env.no_proxy,
    onDecision: decision => console.log(`  ${decision.allowed ? 'allowed' : 'blocked'} ${decision.host}:${decision.port} (${decision.reason})`),
  })
  await mkdir(OUT, { recursive: true })
  const ca = join(OUT, 'egress-ca.pem')
  await writeFile(ca, egress.caCertificate)
  const url = `http://box:${TOKEN}@127.0.0.1:${port}`
  console.log(`Egress proxy on 127.0.0.1:${port}. The box token is "${TOKEN}"; the CA is in ${ca}.

Try these in another terminal (Windows: use curl.exe):

  1. Allowed host, real certificate:
     curl -sS -o /dev/null -w "%{http_code}\\n" -x ${url} https://example.com
     -> 200
  2. Host not on the list:
     curl -sS -x ${url} https://github.com
     -> curl reports the proxy answered 403
  3. Host with a key: the proxy opens the TLS and adds the header
     curl -sS -x ${url} --cacert "${ca}" https://httpbin.org/headers
     -> the JSON shows "X-Tnega-Try": "added-by-the-egress-proxy"
  4. Same host without trusting the proxy's CA:
     curl -sS -x ${url} https://httpbin.org/headers
     -> certificate error: only a box with the CA can use keyed hosts
  5. No token, or a wrong one:
     curl -sS -x http://127.0.0.1:${port} https://example.com
     -> 403 as well: the proxy does not know this client

Each request is logged below. Ctrl+C to stop.`)
  await new Promise<void>(done => process.once('SIGINT', () => done()))
  await egress.close()
}

const SAMPLE = `version = 1

[setup]
# Works in sh, cmd and PowerShell. The secret is printed on purpose: it must come out hidden.
script = "node -e \\"console.log('setup sees TRY_TOKEN=' + process.env.TRY_TOKEN)\\""
secrets = ["TRY_TOKEN"]

[network]
allow = ["example.com"]

[[network.credentials]]
host = "api.github.com"
header = "Authorization"
value = "Bearer \${GITHUB_TOKEN}"
`

async function setup(args: readonly string[]): Promise<void> {
  const folder = args[0]
  let text = SAMPLE
  let cwd = process.cwd()
  if (folder) {
    cwd = resolve(folder)
    text = await readFile(join(cwd, ENVIRONMENT_FILE), 'utf8')
    console.log(`Read ${join(cwd, ENVIRONMENT_FILE)}`)
  } else {
    console.log(`No folder given; using this sample ${ENVIRONMENT_FILE}:\n\n${SAMPLE}`)
  }
  const environment = parseEnvironment(text)
  console.log('Parsed:', JSON.stringify(environment, null, 2))
  console.log(`Approval hash: ${approvalHash(environment)} (changes when the setup, secrets, hosts, keys or template change)`)
  if (!environment.setup) {
    console.log('No [setup] section, so nothing to run.')
    return
  }
  const secrets: Record<string, string> = {}
  for (const name of environment.setup.secrets) {
    const value = process.env[name]
    if (value) {
      secrets[name] = value
    } else {
      secrets[name] = `try-${randomBytes(6).toString('hex')}`
      console.log(`${name} is not set here; using the made-up value ${secrets[name]} so you can check it gets hidden.`)
    }
  }
  console.log('\nRunning the setup script on this machine (in a box it runs through the daemon):\n')
  const result = await runSetup(localExecutionProvider, {
    cwd,
    script: environment.setup.script,
    secrets,
    onOutput: chunk => process.stdout.write(chunk),
  })
  console.log(`\nExit code ${result.exitCode}. Secret values above should read [secret].`)
}

const DEFAULT_API_URL = 'https://api.e2b.app'

async function template(args: readonly string[]): Promise<void> {
  const apiKey = process.env.E2B_API_KEY
  if (!apiKey) {
    console.log('Needs E2B_API_KEY in the environment (from the E2B dashboard).')
    process.exitCode = 1
    return
  }
  const directory = resolve('deploy/e2b/template')
  if (!(await readdir(directory)).some(file => /^tnega-.*\.tgz$/u.test(file))) {
    console.log('No packed tnega in deploy/e2b/template yet; building and packing it (a few minutes)...')
    execSync('pnpm build', { stdio: 'inherit' })
    execSync(`pnpm pack --pack-destination "${directory}"`, { stdio: 'inherit' })
  }
  const name = option(args, '--name') ?? 'tnega-box'
  console.log(`Building template ${name} on E2B (the first build takes several minutes)...`)
  const info = await buildBoxTemplate({ apiUrl: option(args, '--api-url') ?? DEFAULT_API_URL, apiKey, name, directory })
  console.log(`\nBuilt template ${info.name} (id ${info.templateId}). Next: pnpm try:boxes box --template ${info.name}`)
}

async function box(args: readonly string[]): Promise<void> {
  const apiKey = process.env.E2B_API_KEY
  const template = option(args, '--template')
  if (!apiKey || !template) {
    console.log('Needs E2B_API_KEY in the environment and --template <name> (built from deploy/e2b/template).')
    process.exitCode = 1
    return
  }
  const machines = new E2BMachines(new Context(), {
    apiUrl: option(args, '--api-url') ?? DEFAULT_API_URL,
    apiKey,
    timeoutSeconds: 600,
  })
  const key = `try-${Date.now()}`
  const spec: BoxSpec = {
    template,
    // A documentation address: nothing answers, so the daemon in the box keeps retrying. The box only has to exist.
    daemon: { serverUrl: 'wss://192.0.2.1/daemon', token: randomBytes(16).toString('hex') },
    workspacePath: '/workspace',
    network: { mode: 'none' },
    isolation: 'microvm',
    specHash: 'try-1',
    labels: { purpose: 'tnega-try' },
  }
  const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now()
    const value = await run()
    console.log(`${label.padEnd(34)} ${String(value ?? 'ok').padEnd(24)} ${Date.now() - started} ms`)
    return value
  }
  const { ref } = await step('start a new box and its daemon', () => machines.start(key, spec))
  console.log(`  sandbox id ${ref}`)
  await step('status', () => machines.status(ref))
  await step('start again (finds the same box)', async () => (await machines.start(key, spec)).ref)
  await step('pause', () => machines.pause(ref))
  await step('status', () => machines.status(ref))
  await step('start again (resumes it)', async () => (await machines.start(key, spec)).ref)
  await step('status', () => machines.status(ref))
  try {
    await machines.start(key, { ...spec, specHash: 'try-2' })
    console.log('start with a changed environment    NOT refused: this is a bug')
  } catch (error) {
    const code = error instanceof MachineError ? error.code : String(error)
    console.log(`start with a changed environment    refused with ${code}`)
  }
  if (args.includes('--keep')) {
    console.log(`
The box is still running. Look inside with:
  e2b sandbox connect ${ref}
Then try:
  ps aux | grep "tnega daemon"        the daemon is running, as root
  tail /var/log/tnega-daemon.log      it keeps retrying: there is no server to dial yet
  env | grep TNEGA                    empty: the box's own environment has no daemon token
  curl -m 5 https://example.com       fails: no DNS
  curl -m 5 http://1.1.1.1            fails: the firewall allows only the server address
Stop it afterwards with: e2b sandbox kill ${ref}`)
    return
  }
  await step('stop', () => machines.stop(ref))
  await step('status', () => machines.status(ref))
}

/**
 * The same lifecycle on gVisor, for a host without KVM (issue #85). First the
 * host check: it says what is missing instead of starting anything.
 */
async function gvisor(args: readonly string[]): Promise<void> {
  const probe = await probeGvisorHost()
  console.log(`/dev/kvm                           ${probe.kvm ? 'present: microVM boxes (E2B) could run here' : 'absent: no microVMs on this host'}`)
  for (const problem of probe.problems) console.log(`missing                            ${problem}`)
  if (!probe.ready) {
    console.log('This host cannot run gVisor boxes yet. See packages/machine/machine-gvisor/README.md.')
    process.exitCode = 1
    return
  }
  console.log('gVisor boxes                       ready')
  const machines = new GvisorMachines(new Context(), {})
  const key = `try-${Date.now()}`
  const spec: BoxSpec = {
    template: option(args, '--template') ?? 'tnega-box',
    // A documentation address: nothing answers, so the daemon keeps retrying. The box only has to exist.
    daemon: { serverUrl: 'ws://192.0.2.1:4555/daemon', token: randomBytes(16).toString('hex') },
    workspacePath: '/workspace',
    network: { mode: 'none' },
    isolation: 'gvisor',
    specHash: 'try-1',
    labels: { purpose: 'tnega-try' },
  }
  const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now()
    const value = await run()
    console.log(`${label.padEnd(34)} ${String(value ?? 'ok').padEnd(24)} ${Date.now() - started} ms`)
    return value
  }
  const { ref } = await step('start a new box and its daemon', () => machines.start(key, spec))
  await step('status', () => machines.status(ref))
  await step('start again (finds the same box)', async () => (await machines.start(key, spec)).ref)
  await step('pause (checkpoint, or cold)', () => machines.pause(ref))
  await step('status', () => machines.status(ref))
  await step('start again (restores it)', async () => (await machines.start(key, spec)).ref)
  try {
    await machines.start(`${key}-vm`, { ...spec, isolation: 'microvm' })
    console.log('a microVM box                      NOT refused: this is a bug')
  } catch (error) {
    console.log(`a microVM box                      refused with ${error instanceof MachineError ? error.code : String(error)}`)
  }
  if (args.includes('--keep')) {
    console.log(`
The box is still running. Look inside with:
  runsc --root /run/tnega-runsc exec ${ref} sh
Then try:
  uname -a                            a 4.19 gVisor kernel, not the host's
  ls /home                            empty: the host's /home is not in the box
  curl -m 5 http://1.1.1.1            fails: the host rule allows only the server address
Stop it afterwards with: pnpm try:boxes gvisor-stop ${ref}`)
    return
  }
  await step('stop', () => machines.stop(ref))
  await step('status', () => machines.status(ref))
}

async function gvisorStop(args: readonly string[]): Promise<void> {
  const ref = args[0]
  if (!ref) {
    console.log('Usage: pnpm try:boxes gvisor-stop <box id>')
    process.exitCode = 1
    return
  }
  await new GvisorMachines(new Context(), {}).stop(ref)
}

const [command, ...rest] = process.argv.slice(2)
const commands: Record<string, (args: readonly string[]) => Promise<void>> = { proxy, setup, template, box, gvisor, 'gvisor-stop': gvisorStop }
const run = command ? commands[command] : undefined
if (!run) {
  console.log('Usage: pnpm try:boxes proxy | setup [folder] | template [--name <name>] | box --template <name> [--keep] | gvisor [--template <name>] [--keep]\nSee docs/test/try-boxes.md.')
  process.exitCode = 1
} else {
  await run(rest)
}
