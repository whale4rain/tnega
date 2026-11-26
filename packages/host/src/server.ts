import { accountsCapability, BOX_WORKSPACE, GITHUB_TOKEN_SECRET, boxLinkMachine, boxMachine, boxWorkbench, controlCapability, memberLoginOf, daemonDoorCapability, machinesCapability, openSecretVault, stateCapability, stateSpecFromEnv, type AccountsCapabilitySpec, type MachinesCapabilitySpec, type StateCapabilitySpec } from '@tnega/runtime'
import { githubApiForge, githubApiLookup, hasProjectState, prepareThreadClone, threadCloneDir, threadCloneOwner, knownProjectWorkspaces, projectRoutineWakes } from '@tnega/project-host'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readdir } from 'node:fs/promises'
import { HttpError, errorMessage, sendError, writeSse } from '@tnega/web-kit'
import { defaultWebRoot, handleStatic } from './static.js'
import type { PtcRuntimeQuickjsConfig } from '@tnega/ptc-runtime-quickjs'
import { installBuiltinSkills } from '@tnega/coding-agent'
import { launchPageSource, PlaywrightBrowserHost } from '@tnega/browser-playwright'
import { configureSystemShell } from '@tnega/process-local'
import { ApprovalBroker, type PermissionMode } from '@tnega/approval-host'
import { createHotPluginHost, type HotPluginEvent } from '@tnega/plugin-host'
import { createPluginWorkshop } from '@tnega/plugin-host'
import { effectiveApiKey, effectiveLlmConfig, MEMORY_DREAM_DEFAULTS, readSystemConfig, SystemConfigError, upsertModelRoute } from '@tnega/config'
import { memoryDream, memoryDreamRoutes } from '@tnega/memory-dream'
import { SqliteSessionIndex } from '@tnega/session-search-sqlite'
import { memoryLocal } from '@tnega/memory-local'
import { defaultWorkspace } from '@tnega/home'
import { dedupe } from '@tnega/web-kit'
import { adapterFromConfig, compactionAdapter, resolveSessionLlm } from './support.js'
import { chatgptRoutes } from '@tnega/auth-chatgpt'
import { usageRoutes } from '@tnega/usage'
import { contextInsightsRoutes } from '@tnega/context-insights'
import { sideChatRoutes, type SideChatModelRequest } from '@tnega/side-chat'
import { secretRoutes, type SecretVault } from '@tnega/secrets-local'
import { workspacePromptRoutes } from '@tnega/workspace-prompt'
import { pluginRoutes } from '@tnega/plugin-host'
import { projectApi } from '@tnega/project-http'
import { daemonRoutes } from '@tnega/daemon-routes'
import { Context } from '@tnega/core'
import type { ResidentAgentEntry, ProjectHostEntry, ServerContext } from './context.js'
import { CHATGPT_DEFAULT_MODEL, applyNetwork, handleApi, projectHostFor, registerApiRoutes, rejectsApiRequest } from './routes.js'
import { webServer, type WebServerService } from '@tnega/web-kit'
import { FileServeError, type FileRoutesConfig } from '@tnega/workspace-files'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080

/** Whether a workspace is the folder or inside it (members' folders on a server). */
function insideFolder(folder: string): (workspace: string) => boolean {
  const root = resolve(folder)
  return workspace => {
    const rel = relative(root, resolve(workspace))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
}

export interface WebServerOptions {
  /** Where Sessions are kept; default from the environment (`stateSpecFromEnv`). */
  state?: StateCapabilitySpec
  /**
   * Ask everyone to sign in (`tnega server start`): accounts on the same
   * Postgres as the Sessions. Off in local mode.
   */
  accounts?: AccountsCapabilitySpec
  /**
   * Run each signed-in person's sessions in a box of their own (needs
   * `accounts`): the Provider, the daemon door and the box pool.
   */
  machines?: MachinesCapabilitySpec
  /** Runtime assets for hosts which bundle the server away from its worker/WASM. */
  ptcRuntime?: PtcRuntimeQuickjsConfig
  port?: number
  host?: string
  webRoot?: string
  configFile?: string
  /** Run auto sessions through resident durable-inbox agents. Defaults to true. */
  resident?: boolean
  /**
   * Project 作用域的授权上限。Project 里的每个 Thread 只能比它更窄；默认
   * `workspace-write`：仓库内的读写直接放行，shell 与越界访问逐个请求用户批准。
   */
  projectPermission?: PermissionMode
  /**
   * The page the agent's `browser_*` tools drive. The desktop app passes its
   * embedded view; by default the server launches the system Edge / Chrome on
   * first use (see `browser` in System Config). `false` disables the tools.
   */
  browser?: PlaywrightBrowserHost | false
  /**
   * Fetch for the HTTP tools when no proxy is configured. The desktop app
   * passes Electron's, which follows the system proxy settings.
   */
  fetch?: typeof fetch
  /**
   * Profile file whose plugins are mounted into every agent runtime and reloaded
   * in place when the profile or a local plugin module changes. Off by default;
   * `tnega web` and the desktop app pass `defaultHotProfile()`.
   */
  profile?: string
  /**
   * Plugin dev mode: the agent gets `plugin_*` tools that write plugins into
   * this directory and patch them into the running agent (see `plugin-dev.ts`).
   * `true` uses `defaultPluginDevDir()`. Off by default; `TNEGA_PLUGIN_DEV=1`
   * turns it on when the host passes nothing.
   */
  pluginDev?: string | boolean
}

/** A folder's remembered GitHub key, read when needed so a key saved later counts. */
function githubToken(vault: SecretVault, workspace: string): () => Promise<string | undefined> {
  return async () => (await vault.remembered(workspace))[GITHUB_TOKEN_SECRET]
}

/**
 * Folders that may have projects: those a Project host noted, the app's
 * folders, the scratch folder and, on a server, members' folders two levels
 * down (`<members>/<login>/<folder>`), for projects from before the notes.
 */
async function projectFolders(configFile: string | undefined, membersRoot: string | undefined): Promise<string[]> {
  const folders = [...await knownProjectWorkspaces(), ...((await readSystemConfig(configFile)).workspaces ?? []), defaultWorkspace()]
  if (membersRoot) {
    const children = async (path: string): Promise<string[]> => {
      try {
        return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name))
      } catch {
        return []
      }
    }
    for (const member of await children(membersRoot)) folders.push(member, ...await children(member))
  }
  return dedupe(folders.map(folder => resolve(folder)))
}

/**
 * Project threads in boxes: each thread of a member's project gets its own
 * box in that member's account, reached through a link that holds a lease
 * only while calls run, so the box pauses while the thread waits.
 */
function threadBoxes(root: Context, membersRoot: string): NonNullable<ServerContext['projectThreadMachines']> {
  const pool = root.get('machinePool')
  const accounts = root.get('accounts')
  return workspace => {
    const login = memberLoginOf(membersRoot, workspace)
    if (!login) return undefined
    const accountOf = async (): Promise<string | undefined> => (await accounts.findAccount(login))?.id
    return {
      open: async thread => {
        const accountId = await accountOf()
        if (!accountId) return undefined
        // The box mounts the thread's own clone, never the member's folder: threads share work
        // through pull requests and artifacts, not files. A folder outside git is mounted as it is.
        const folder = await prepareThreadClone(workspace, thread.id) ?? workspace
        const link = await pool.leasedLink({ accountId, workspace: folder, scope: `thread:${thread.id}` })
        const workspaceId = link.workspaces.find(entry => entry.path === BOX_WORKSPACE)?.id ?? link.workspaces[0]?.id
        if (!workspaceId) {
          link.close()
          throw new Error(`the box for thread ${thread.id} serves no workspace`)
        }
        return {
          machine: boxLinkMachine(link, folder, () => pool.proxiedSecrets(folder)),
          cwd: BOX_WORKSPACE,
          close: () => link.close(),
          // git and gh for the thread's branch run in its box: the box is the sandbox, keys come from the egress proxy.
          run: async (command, args, cwd, signal) => {
            const result = await link.call('process/run', {
              workspaceId, cwd, argv: [command, ...args], timeoutMs: 120_000,
              sandbox: { mode: 'bypass', sessionId: thread.id },
            }, signal ? { signal } : {})
            if (result.exitCode !== 0) throw new Error(`${command} ${args[0] ?? ''} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`)
            return result.stdout.trim()
          },
        }
      },
      forget: async threadIds => {
        const accountId = await accountOf()
        if (!accountId) return
        for (const id of threadIds) {
          // Its clone's box, and a box from before clones that mounted the folder.
          await pool.stopScope({ accountId, workspace: threadCloneDir(workspace, id), scope: `thread:${id}` })
          await pool.stopScope({ accountId, workspace, scope: `thread:${id}` })
        }
      },
    }
  }
}

/**
 * The Workbench on a server whose boxes keep their own volume: the signed-in
 * person's box for the workspace, while it runs. Looking never starts or
 * wakes a box (the Workbench asks every few seconds); a box that sleeps
 * answers 503 until the next run wakes it. Someone not signed in (no account)
 * sees this host's folder.
 */
function boxFiles(root: Context, web: WebServerService): NonNullable<FileRoutesConfig['machine']> {
  const pool = root.get('machinePool')
  return async (workspace, req) => {
    const accountId = web.attributes(req).principal?.accountId
    if (!accountId) return undefined
    const lease = await pool.peek({ accountId, workspace })
    if (!lease) throw new FileServeError('your box for this folder is not running; its files show here while a run works in it', 503)
    return boxWorkbench(lease)
  }
}

/** Runs in boxes: a lease on the person's box for the workspace, ended when the run ends. */
function boxRuns(root: Context): NonNullable<ServerContext['machineFor']> {
  const pool = root.get('machinePool')
  const ids = new WeakMap<object, number>()
  let next = 0
  return async ({ workspace, sessionId, accountId, signal }) => {
    const lease = await pool.acquire({ accountId, workspace, sessionId, ...(signal ? { signal } : {}) })
    let id = ids.get(lease.link)
    if (id === undefined) ids.set(lease.link, id = ++next)
    return {
      machine: boxMachine(lease, workspace, () => pool.proxiedSecrets(workspace)),
      cwd: lease.workspacePath,
      identity: `${lease.machineId}:${id}`,
      release: lease.release,
    }
  }
}

export interface WebServer {
  url: string
  port: number
  close: () => Promise<void>
}

export async function startWebServer(
  options: WebServerOptions = {},
): Promise<WebServer> {
  await installBuiltinSkills()
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const webRoot = options.webRoot ?? defaultWebRoot()
  const configFile = options.configFile
  const startConfig = await readSystemConfig(configFile)
  configureSystemShell(startConfig.shell)
  applyNetwork(startConfig, options.fetch)
  const activeRuns = new Map<string, AbortController>()
  const approvals = new ApprovalBroker()
  const residentAgents = new Map<string, ResidentAgentEntry>()
  const projectHosts = new Map<string, ProjectHostEntry>()
  let actualPort = port
  // Nothing starts until the agent first uses the browser.
  const ownedBrowser = options.browser === undefined
    ? new PlaywrightBrowserHost(launchPageSource({ headless: true, ...(await readSystemConfig(configFile)).browser }))
    : undefined
  const browser = options.browser === false ? undefined : options.browser ?? ownedBrowser
  const hotPlugins = options.profile
    ? await createHotPluginHost(options.profile, { onEvent: logHotPluginEvent })
    : undefined
  const pluginDev = options.pluginDev ?? process.env.TNEGA_PLUGIN_DEV === '1'
  const pluginWorkshop = pluginDev
    ? await createPluginWorkshop(...(typeof pluginDev === 'string' ? [pluginDev] : []))
    : undefined
  const root = new Context()
  await root.plugin(webServer)
  // On a server, sign-in comes first: its guard sees every request.
  if (options.accounts) await root.plugin(accountsCapability, options.accounts)
  if (options.machines && !options.accounts) throw new Error('boxes need sign-in: pass accounts with machines')
  // Daemons dial in with a daemon token: people's own machines, and boxes.
  if (options.accounts) {
    const listen = options.machines?.gatewayListen
    await root.plugin(daemonDoorCapability, listen ? { listen } : {})
  }
  // Image bytes under the tnega home; Sessions in JSONL files there, or on
  // Postgres when TNEGA_SESSION_STORE=postgres and DATABASE_URL say so.
  const state = options.state ?? stateSpecFromEnv()
  // Remembered secrets go with the state: sealed in Postgres with a master key, else the owner-only file.
  const secretVault = await openSecretVault(state)
  if (options.machines) {
    // The egress proxy adds a box's keys from its folder's remembered secrets (GITHUB_TOKEN included).
    await root.plugin(machinesCapability, {
      ...options.machines,
      pool: { rememberedSecrets: (workspace: string) => secretVault.vault.remembered(threadCloneOwner(workspace) ?? workspace), ...options.machines.pool },
    })
    // A key saved or removed while a box runs reaches its proxy now, not at the next resume.
    const pool = root.get('machinePool')
    root.fiber.effect(() => secretVault.vault.onRememberedChange(() => {
      void pool.refreshPolicies().catch((error: unknown) => console.warn('[tnega] could not refresh box keys:', error))
    }), 'refresh box keys')
  }
  await root.plugin(stateCapability, state)
  // Effects and schedules live with the state: on Postgres, routines run with no window open.
  await root.plugin(controlCapability, state)
  // One session index per host, in the tnega home; it opens on the first search.
  const sessionIndex = new SqliteSessionIndex({ sessions: root.get('sessionStore') })
  const web = root.get('webServer')
  const context: ServerContext = {
    ...(options.fetch ? { hostFetch: options.fetch } : {}),
    webRoot,
    activeRuns,
    approvals,
    resident: options.resident !== false,
    residentAgents,
    projectHosts,
    questionRoots: new Map(),
    questionInboxes: new Map(),
    steeringReady: new Map(),
    residentCreation: new Map(),
    projectPermission: options.projectPermission ?? 'workspace-write',
    // A member's folder: the sandbox stays on, whatever the Session asks for.
    ...(options.accounts ? { sandboxRequired: insideFolder(options.accounts.membersRoot) } : {}),
    ...(options.machines ? { machineFor: boxRuns(root) } : {}),
    ...(options.machines && options.accounts ? { projectThreadMachines: threadBoxes(root, options.accounts.membersRoot) } : {}),
    // Nobody watches a server's Project threads and routines: their turns have limits.
    ...(options.accounts ? { unattended: {} } : {}),
    // Pull request states come from GitHub's API with the member's GITHUB_TOKEN, never the server's own gh login.
    // Threads open them the same way, so a box needs only git (its push gets the key from the egress proxy).
    ...(options.accounts ? {
      pullRequestLookup: (workspace: string) => githubApiLookup({ token: githubToken(secretVault.vault, workspace) }),
      pullRequestForge: (workspace: string) => githubApiForge({ token: githubToken(secretVault.vault, workspace) }),
    } : {}),
    ...(options.ptcRuntime ? { ptcRuntime: options.ptcRuntime } : {}),
    ...(configFile ? { configFile } : {}),
    ...(browser ? { browser } : {}),
    ...(hotPlugins ? { hotPlugins } : {}),
    ...(pluginWorkshop ? { pluginWorkshop } : {}),
    processes: new Map(),
    sessionIndex,
    secrets: secretVault.vault,
    web,
    sessions: root.get('sessionStore'),
    // On Postgres, Project Thread logs are rows too, not files on the server's disk.
    ...(state.sessions.kind === 'postgres' ? { projectThreadLogs: root.get('sessionStore') } : {}),
    ...(root.get('effects', false) ? { effects: root.get('effects') } : {}),
  }

  // Files, terminals, browser view and setup hints act on this machine: the
  // in-process daemon's routes serve them.
  await root.plugin(daemonRoutes, {
    browser: () => browser,
    // A box with its own volume (E2B) holds the work: the Workbench reads the signed-in person's box.
    ...(options.machines && !root.get('machinePool').mountsHostWorkspace ? { files: { machine: boxFiles(root, web) } } : {}),
    ...(startConfig.computerDriverPath ? { computerDriverPath: startConfig.computerDriverPath } : {}),
  })
  await root.plugin(projectApi, { host: (workspace: string) => projectHostFor(context, workspace) })
  if (context.effects) {
    const membersRoot = options.accounts?.membersRoot
    await root.plugin(projectRoutineWakes, {
      host: (workspace: string) => projectHostFor(context, workspace),
      // At start: schedule routines and wake working projects in every folder that has projects.
      workspaces: async () => (await projectFolders(configFile, membersRoot)).filter(hasProjectState),
      onError: (workspace: string, error: unknown) => console.warn(`[tnega] could not reconcile projects in ${workspace}:`, error),
    })
  }
  await root.plugin(usageRoutes, { configFile })
  await root.plugin(contextInsightsRoutes, { configFile })
  // /btw and the temporary chat: answered by the session's model (or the one picked), never saved.
  await root.plugin(sideChatRoutes, {
    resolveAdapter: async ({ workspace, session, model }: SideChatModelRequest) => {
      const summary = session ? await context.sessions.summary(workspace, session) : undefined
      const { effective, apiKey } = resolveSessionLlm(await readSystemConfig(configFile), model ?? summary?.model, model ? undefined : summary?.reasoningEffort)
      if (!apiKey && effective.auth !== 'chatgpt') throw new HttpError(400, 'API key is not configured')
      return adapterFromConfig(effective, apiKey ?? '')
    },
  })
  await root.plugin(workspacePromptRoutes)
  if (context.secrets) await root.plugin(secretRoutes, { vault: context.secrets })
  await root.plugin(pluginRoutes, {
    profile: () => context.hotPlugins,
    workshop: () => context.pluginWorkshop,
  })
  await root.plugin(chatgptRoutes, {
    onSignedIn: async () => {
      const config = await readSystemConfig(configFile)
      if (!config.models?.some(route => route.auth === 'chatgpt')) {
        await upsertModelRoute(
          'chatgpt',
          { model: CHATGPT_DEFAULT_MODEL, name: `ChatGPT · ${CHATGPT_DEFAULT_MODEL}`, auth: 'chatgpt' },
          configFile,
        )
      }
    },
  })
  // Dreaming: quiet sessions are folded into their workspace's project memory
  // in the background. Composition picks the memory provider and the model.
  await root.plugin(memoryDream, {
    workspaces: async () => dedupe([...((await readSystemConfig(configFile)).workspaces ?? []), defaultWorkspace()]),
    settings: async () => {
      const dream = { ...MEMORY_DREAM_DEFAULTS, ...(await readSystemConfig(configFile)).memoryDream }
      return { enabled: dream.enabled, idleMinutes: dream.idleMinutes }
    },
    resolveAdapter: async () => {
      const config = await readSystemConfig(configFile)
      const routeId = config.memoryDream?.modelId || undefined
      if (routeId && !config.models?.some(route => route.id === routeId)) return undefined
      const effective = effectiveLlmConfig(config, process.env, routeId)
      const apiKey = effectiveApiKey(config, process.env, routeId)
      return apiKey || effective.auth === 'chatgpt' ? compactionAdapter(effective, apiKey ?? '') : undefined
    },
    openMemory: async (workspace: string) => {
      const scope = new Context()
      await scope.plugin(memoryLocal, { cwd: workspace })
      return { memory: scope.get('memory'), dispose: () => scope.fiber.dispose() }
    },
  })
  await root.plugin(memoryDreamRoutes)
  registerApiRoutes(context.web)
  context.web.register({
    kind: 'prefix',
    method: '*',
    path: '/api/',
    handler: (req, res, url) => handleApi(req, res, url, context),
  })
  context.web.registerFallback((req, res, url) => handleStatic(req, res, url.pathname, webRoot))

  const server = createServer((req, res) => {
    void handleRequest(req, res, context)
  })
  // WebSocket upgrades go to whichever plugin registered the path (a daemon dialling in).
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = context.web.upgrade(pathname)
    if (!handler) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    handler(req, socket, head)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen)
      const address = server.address()
      if (address && typeof address === 'object') actualPort = address.port
      resolveListen()
    })
  })

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose())
      })
      // The index reads through the store: close it before the store goes.
      await sessionIndex.close()
      await root.fiber.dispose()
      const entries = [...residentAgents.values()]
      residentAgents.clear()
      await Promise.all(entries.map(entry => entry.dispose()))
      const hosts = [...projectHosts.values()]
      projectHosts.clear()
      await Promise.all(hosts.map(entry => entry.host.dispose()))
      await hotPlugins?.close()
      await pluginWorkshop?.close()
      await ownedBrowser?.close()
      const registries = [...context.processes.values()]
      context.processes.clear()
      await Promise.all(registries.map(registry => registry.dispose()))
      await secretVault.close()
    },
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: ServerContext,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/api/') && rejectsApiRequest(req, res)) return
    // Plugins check requests here (sign-in on a server) before any route runs.
    if (await context.web.guard(req, res, url)) return
    const match = context.web.match(req.method ?? 'GET', url.pathname)
    if (match.kind === 'route' || match.kind === 'fallback') {
      await match.handler(req, res, url)
      return
    }
    if (match.kind === 'method-not-allowed') {
      res.writeHead(405, { allow: match.allow.join(', ') })
      res.end()
      return
    }
    sendError(res, 404, 'not found')
  } catch (error) {
    if (error instanceof SystemConfigError) {
      sendError(res, 409, error.message)
      return
    }
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }
    if (!res.headersSent && !res.destroyed) {
      sendError(res, 500, errorMessage(error))
    } else if (!res.destroyed) {
      writeSse(res, { type: 'error', message: errorMessage(error) })
      res.end()
    }
  }
}

/**
 * 每个 workspace 一个 Project Host。模型、密钥或 Project 授权变了就换一个：运行中的
 * Thread 用的是装配时的配置，换配置等于换一个作用域，而不是让半个 Project 用旧模型。
 */

/** The proxy the environment sets for the HTTP tools, without any credentials in it. */

/** Point the HTTP tools at the configured proxy and allowed hosts, keeping the host's fetch. */

/**
 * The agent browser as seen by the web UI: a live screencast plus the user's
 * own input, navigation and history commands. Opening the stream starts the
 * browser if the agent has not yet.
 */

function logHotPluginEvent(event: HotPluginEvent): void {
  // console rather than raw stderr: the TUI reroutes console output above its frame.
  if (event.type === 'loaded') {
    if (event.generation > 1) console.error(`[tnega] plugins reloaded (generation ${event.generation}, ${event.plugins} plugin(s))`)
  } else {
    console.error(`[tnega] plugin reload failed: ${errorMessage(event.error)}`)
  }
}


