import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** What one cua-driver tool call returned, reduced to what the Provider reads. */
export interface DriverResult {
  isError: boolean
  text: string
  image?: { mediaType: string; data: string }
  structured: Record<string, unknown>
}

/** A connection to one `cua-driver mcp` process. Tests pass a fake. */
export interface DriverConnection {
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult>
  close(): Promise<void>
}

export type DriverConnector = (driverPath: string) => Promise<DriverConnection>

export const DRIVER_INSTALL_HINT = process.platform === 'win32'
  ? 'Install cua-driver in PowerShell: irm https://cua.ai/driver/install.ps1 | iex'
  : 'Install cua-driver: /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"'

const BINARY = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'

/** Where the official installers put the binary, after any explicit choice. */
export function driverCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromPath = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, BINARY))
  const installed = process.platform === 'win32'
    ? env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Cua', 'cua-driver', 'bin', BINARY)] : []
    : [join(homedir(), '.local', 'bin', BINARY)]
  return [...fromPath, ...installed]
}

/**
 * The driver binary to run: the configured path, then `TNEGA_CUA_DRIVER`,
 * then PATH and the installer's default folder. `undefined` when none exists.
 */
export async function findDriver(configured?: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const explicit = configured ?? env.TNEGA_CUA_DRIVER
  if (explicit) return await executable(explicit) ? explicit : undefined
  for (const candidate of driverCandidates(env)) {
    if (await executable(candidate)) return candidate
  }
  return undefined
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an MCP `tools/call` result without trusting its shape. */
export function readResult(raw: unknown): DriverResult {
  const record = isRecord(raw) ? raw : {}
  const content = Array.isArray(record.content) ? record.content : []
  const texts: string[] = []
  let image: DriverResult['image']
  for (const item of content) {
    if (!isRecord(item)) continue
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
    if (item.type === 'image' && typeof item.data === 'string' && !image) {
      image = { mediaType: typeof item.mimeType === 'string' ? item.mimeType : 'image/png', data: item.data }
    }
  }
  return {
    isError: record.isError === true,
    text: texts.join('\n'),
    ...(image ? { image } : {}),
    structured: isRecord(record.structuredContent) ? record.structuredContent : {},
  }
}

/**
 * Telemetry is on by default upstream. This variable turns it off for the
 * driver process tnega starts, without changing the user's saved choice.
 */
export const TELEMETRY_OFF_ENV = { CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' } as const

/** Start `cua-driver mcp` over stdio. It exits when the connection closes. */
export const connectDriver: DriverConnector = async driverPath => {
  // The SDK passes only a few variables by default; the driver needs the
  // desktop session's (DISPLAY, DBUS_SESSION_BUS_ADDRESS, WAYLAND_DISPLAY…).
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    ...TELEMETRY_OFF_ENV,
  }
  const transport = new StdioClientTransport({ command: driverPath, args: ['mcp'], env, stderr: 'ignore' })
  const client = new Client({ name: 'tnega', version: '0' })
  await client.connect(transport)
  return {
    async call(name, args, signal) {
      return readResult(await client.callTool({ name, arguments: args }, undefined, signal ? { signal } : {}))
    },
    async close() {
      await client.close()
    },
  }
}
