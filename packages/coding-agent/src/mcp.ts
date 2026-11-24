import { readFile } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { PipedProcess, PipedProcessLauncher } from '@tnega/process'
import type { ToolDefinition } from '@tnega/tools'

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  stderr?: 'inherit' | 'pipe' | 'ignore'
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

export interface McpSurvey {
  name: string
  status: 'connected' | 'failed'
  toolCount: number
  error?: string
}

export interface McpRuntime {
  surveys: McpSurvey[]
  tools: ToolDefinition[]
  dispose(): Promise<void>
}

/**
 * Where MCP servers start. By default on this machine, from
 * `<cwd>/.tnega/mcp.json`. A run in a box passes the box's launcher and a
 * reader for the box's own `mcp.json`, so the servers run beside the files.
 */
export interface McpLaunchOptions {
  /** The workspace on that machine: servers start here unless their config names a folder. */
  cwd: string
  launch: PipedProcessLauncher
  readConfig: () => Promise<McpConfig>
}

interface ActiveConnection {
  client: Client
  transport: Transport
}

/**
 * MCP's stdio framing (one JSON-RPC message per line) over a
 * {@link PipedProcess} on another machine.
 */
export class PipedProcessTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly buffer = new ReadBuffer()
  private process: PipedProcess | undefined
  private closed = false

  constructor(
    private readonly launch: PipedProcessLauncher,
    private readonly request: Parameters<PipedProcessLauncher>[0],
    private readonly onStderr?: (data: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.process) throw new Error('PipedProcessTransport already started')
    this.process = await this.launch(this.request, {
      onStdout: data => {
        this.buffer.append(Buffer.from(data, 'utf8'))
        for (;;) {
          let message: JSONRPCMessage | null
          try {
            message = this.buffer.readMessage()
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)))
            continue
          }
          if (message === null) break
          this.onmessage?.(message)
        }
      },
      ...(this.onStderr ? { onStderr: this.onStderr } : {}),
      onExit: () => this.finish(),
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.process || this.closed) throw new Error('mcp server is not running')
    await this.process.write(serializeMessage(message))
  }

  async close(): Promise<void> {
    const process = this.process
    this.finish()
    await process?.close()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.buffer.clear()
    this.onclose?.()
  }
}

/** Where a workspace keeps its MCP servers, relative to the workspace. */
export const MCP_CONFIG_FILE = '.tnega/mcp.json'

/** The text of an `mcp.json`; anything but an object reads as no servers. */
export function parseMcpConfig(text: string): McpConfig {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as McpConfig
}

export async function loadMcpConfig(cwd: string): Promise<McpConfig> {
  const file = join(resolve(cwd), '.tnega', 'mcp.json')
  try {
    return parseMcpConfig(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export async function connectMcpServers(
  cwd: string,
  onTool?: (server: string, tool: ToolDefinition) => void,
  remote?: McpLaunchOptions,
): Promise<McpRuntime> {
  const config = remote ? await remote.readConfig() : await loadMcpConfig(cwd)
  const servers = Object.entries(config.mcpServers ?? {})
  const surveys: McpSurvey[] = []
  const tools: ToolDefinition[] = []
  const active = new Set<ActiveConnection>()

  const closeActive = async (): Promise<void> => {
    for (const connection of [...active]) {
      active.delete(connection)
      await connection.transport.close().catch(() => undefined)
      await connection.client.close().catch(() => undefined)
    }
  }

  for (const [name, serverConfig] of servers) {
    const survey: McpSurvey = { name, status: 'connected', toolCount: 0 }
    try {
      const mcpClient = new Client({
        name: `tnega-coding-${name}`,
        version: '0.1.0',
      })
      const mcpTransport: Transport = remote
        ? new PipedProcessTransport(remote.launch, {
          argv: [serverConfig.command, ...serverConfig.args ?? []],
          // The box is Linux whatever this host is: join with '/', never this host's separator.
          cwd: serverConfig.cwd ? posix.resolve(remote.cwd, serverConfig.cwd) : remote.cwd,
          ...(serverConfig.env ? { env: serverConfig.env } : {}),
        }, serverConfig.stderr === 'inherit' || serverConfig.stderr === undefined ? data => process.stderr.write(data) : undefined)
        : new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args ?? [],
          ...(serverConfig.env ? { env: serverConfig.env } : {}),
          ...(serverConfig.cwd ? { cwd: resolve(cwd, serverConfig.cwd) } : {}),
          stderr: serverConfig.stderr ?? 'inherit',
        })
      await mcpClient.connect(mcpTransport)
      const connection: ActiveConnection = { client: mcpClient, transport: mcpTransport }
      active.add(connection)
      const listed = await mcpClient.listTools()
      for (const mcpTool of listed.tools) {
        const schema: ToolDefinition['schema'] = {
          name: `mcp__${name}__${mcpTool.name}`,
          description: mcpTool.description
            ? `MCP ${name}: ${mcpTool.description}`
            : `MCP tool ${mcpTool.name} from server ${name}`,
        }
        if (mcpTool.inputSchema?.properties) {
          schema.parameters = mcpTool.inputSchema as unknown as NonNullable<
            ToolDefinition['schema']['parameters']
          >
        }
        const tool: ToolDefinition = {
          schema,
          execute: async (input, options) => {
            if (!active.has(connection)) {
              throw new Error(`mcp server closed: ${name}`)
            }
            // The signal makes the client send notifications/cancelled and stop waiting.
            const result = await mcpClient.callTool({
              name: mcpTool.name,
              arguments: input as Record<string, unknown>,
            }, undefined, options.signal ? { signal: options.signal } : undefined)
            const parts: string[] = []
            const blocks = result.content as Array<Record<string, unknown>>
            for (const block of blocks) {
              if (typeof block.text === 'string') {
                parts.push(block.text)
              } else if (block.type === 'resource' && typeof block.resource === 'object') {
                parts.push(JSON.stringify(block.resource))
              } else if (block.type === 'image') {
                parts.push('[image result]')
              } else {
                parts.push(JSON.stringify(block))
              }
            }
            return {
              content: parts.join('\n'),
              ...(result.isError === true ? { isError: true } : {}),
            }
          },
        }
        tools.push(tool)
        survey.toolCount += 1
        onTool?.(name, tool)
      }
    } catch (error) {
      await closeActive()
      survey.status = 'failed'
      survey.error = error instanceof Error ? error.message : String(error)
    }
    surveys.push(survey)
  }
  return {
    surveys,
    tools,
    dispose: closeActive,
  }
}
