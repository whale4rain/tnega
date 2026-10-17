import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { HttpError, errorMessage, sendError, writeSse } from '@tnega/web-kit'
import { defaultWebRoot, handleStatic } from './static.js'
import type { PtcRuntimeQuickjsConfig } from '@tnega/ptc-runtime-quickjs'
import { installBuiltinSkills } from '@tnega/coding-agent'
import { launchPageSource, PlaywrightBrowserHost } from '@tnega/browser-playwright'
import { configureSystemShell } from '@tnega/execution'
import { ApprovalBroker, type PermissionMode } from '@tnega/approval-host'
import { TerminalManager } from '@tnega/terminal'
import { createHotPluginHost, type HotPluginEvent } from '@tnega/plugin-host'
import { createPluginWorkshop } from '@tnega/plugin-host'
import { readSystemConfig, SystemConfigError } from '@tnega/config'
import { fileRoutes } from '@tnega/workspace-files'
import { terminalRoutes } from '@tnega/terminal'
import { Context } from '@tnega/core'
import type { ResidentAgentEntry, ProjectHostEntry, ServerContext } from './context.js'
import { applyNetwork, handleApi, registerApiRoutes, rejectsApiRequest } from './routes.js'
import { webServer } from '@tnega/web-kit'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080

export interface WebServerOptions {
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
    ...(options.ptcRuntime ? { ptcRuntime: options.ptcRuntime } : {}),
    ...(configFile ? { configFile } : {}),
    ...(browser ? { browser } : {}),
    ...(hotPlugins ? { hotPlugins } : {}),
    ...(pluginWorkshop ? { pluginWorkshop } : {}),
    processes: new Map(),
    terminals: new TerminalManager(),
    web,
  }

  await root.plugin(fileRoutes)
  await root.plugin(terminalRoutes, { terminals: context.terminals })
  registerApiRoutes(context.web, context)
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
      await root.fiber.dispose()
      const entries = [...residentAgents.values()]
      residentAgents.clear()
      await Promise.all(entries.map(entry => entry.dispose()))
      const hosts = [...projectHosts.values()]
      projectHosts.clear()
      await Promise.all(hosts.map(entry => entry.host.dispose()))
      context.terminals.dispose()
      await context.chatgptLogin?.stop()
      await hotPlugins?.close()
      await pluginWorkshop?.close()
      await ownedBrowser?.close()
      const registries = [...context.processes.values()]
      context.processes.clear()
      await Promise.all(registries.map(registry => registry.dispose()))
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

/** The Workbench terminal endpoints; see `terminals.ts`. */

