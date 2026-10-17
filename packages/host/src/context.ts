import { DurableInbox, AgentRegistry, type LiveAgent } from '@tnega/agent'
import { Context } from '@tnega/core'
import { ChatGptLogin } from '@tnega/auth-chatgpt'
import type { PtcRuntimeQuickjsConfig } from '@tnega/ptc-runtime-quickjs'
import { PlaywrightBrowserHost } from '@tnega/browser-playwright'
import { ProcessRegistry, type ToolsService } from '@tnega/tools'
import { ApprovalBroker, type PermissionMode } from '@tnega/approval-host'
import { ProjectHost } from '@tnega/project-host'
import { TerminalManager } from '@tnega/terminal'
import type { HotPluginHost } from '@tnega/plugin-host'
import type { PluginWorkshop } from '@tnega/plugin-host'
import type { WebServerService } from '@tnega/web-kit'

export interface ResidentAgentEntry {
  root: Context
  agent: LiveAgent
  registry: AgentRegistry
  tools: ToolsService
  dispose: () => Promise<void>
  signature: string
}

export interface ProjectHostEntry {
  host: ProjectHost
  signature: string
}

export interface ServerContext {
  ptcRuntime?: PtcRuntimeQuickjsConfig
  chatgptLogin?: ChatGptLogin
  /** The host's fetch for the HTTP tools (see `WebServerOptions.fetch`). */
  hostFetch?: typeof fetch
  webRoot: string
  configFile?: string
  activeRuns: Map<string, AbortController>
  approvals: ApprovalBroker
  resident?: boolean
  residentAgents?: Map<string, ResidentAgentEntry>
  questionRoots?: Map<string, Context>
  questionInboxes?: Map<string, DurableInbox>
  /** Resident startup must persist its first prompt before accepting corrections. */
  steeringReady: Map<string, Promise<boolean>>
  residentCreation?: Map<string, Promise<ResidentAgentEntry>>
  projectHosts?: Map<string, ProjectHostEntry>
  projectPermission: PermissionMode
  browser?: PlaywrightBrowserHost
  /** Background processes per workspace; they outlive the runs that start them. */
  processes: Map<string, ProcessRegistry>
  hotPlugins?: HotPluginHost
  pluginWorkshop?: PluginWorkshop
  terminals: TerminalManager
  /** The named-route table requests are dispatched through. */
  web: WebServerService
}
