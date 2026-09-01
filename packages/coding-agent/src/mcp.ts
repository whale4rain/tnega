import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
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

interface ActiveConnection {
  client: Client
  transport: StdioClientTransport
}

export async function loadMcpConfig(cwd: string): Promise<McpConfig> {
  const file = join(resolve(cwd), '.tnega', 'mcp.json')
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as McpConfig
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export async function connectMcpServers(
  cwd: string,
  onTool?: (server: string, tool: ToolDefinition) => void,
): Promise<McpRuntime> {
  const config = await loadMcpConfig(cwd)
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
      const mcpTransport = new StdioClientTransport({
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
          execute: async (input) => {
            if (!active.has(connection)) {
              throw new Error(`mcp server closed: ${name}`)
            }
            const result = await mcpClient.callTool({
              name: mcpTool.name,
              arguments: input as Record<string, unknown>,
            })
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
