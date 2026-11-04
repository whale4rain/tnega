/** The protocol version this build speaks. A peer accepts this one and the one before. */
export const PROTOCOL_VERSION = 1
/** The oldest version a runtime still accepts (N-1). */
export const MIN_PROTOCOL_VERSION = PROTOCOL_VERSION - 1

export function isSupportedVersion(version: unknown): version is number {
  return typeof version === 'number' && Number.isInteger(version)
    && version >= MIN_PROTOCOL_VERSION && version <= PROTOCOL_VERSION
}

/** Largest single message either side sends or accepts, in bytes of JSON text. */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024
/** Largest byte payload in one message (before base64). */
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024

/** Seconds between heartbeats, and how long silence lasts before a peer is lost. */
export const HEARTBEAT_INTERVAL_MS = 10_000
export const HEARTBEAT_TIMEOUT_MS = 30_000

/**
 * JSON-RPC error codes. The standard ones, then this protocol's own.
 *
 * - `CALL_FAILED`: the method ran and threw; `data` carries the error's
 *   `name` and string `code` (`ENOENT`, `FS_EXISTS`, `SANDBOX_UNAVAILABLE` …)
 *   so the caller can rebuild what it would have seen locally.
 * - `VERSION_REFUSED`: the handshake's version is outside N and N-1.
 * - `WORKSPACE_DENIED`: the call names a workspace the daemon did not announce.
 * - `CONNECTION_LOST`: the connection closed (or went silent) with the call in
 *   flight; the call may or may not have run.
 * - `REQUEST_CANCELLED`: the caller cancelled with `$/cancel`.
 */
export const RpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  CALL_FAILED: -32000,
  VERSION_REFUSED: -32001,
  WORKSPACE_DENIED: -32002,
  CONNECTION_LOST: -32003,
  NOT_INITIALIZED: -32004,
  REQUEST_CANCELLED: -32800,
} as const

export type RpcErrorCode = typeof RpcErrorCode[keyof typeof RpcErrorCode]

export interface RpcErrorData {
  /** The thrown error's `name` (`PathSandboxError`, `FsError`, `SandboxUnavailableError` …). */
  name?: string
  /** The thrown error's string `code`, if it had one. */
  code?: string
}

/**
 * An error that came over the wire. It keeps the remote error's `name` and
 * string `code`, so `error.code === 'ENOENT'` and name checks work as they
 * would have locally; `rpcCode` is the protocol's own code.
 */
export class RemoteError extends Error {
  override name: string
  readonly code: string | undefined

  constructor(message: string, readonly rpcCode: number, data: RpcErrorData = {}) {
    super(message)
    this.name = data.name ?? 'RemoteError'
    this.code = data.code
  }
}

/** Whether a failure means the connection went away, not that the call failed. */
export function isConnectionLost(error: unknown): boolean {
  return error instanceof RemoteError && error.rpcCode === RpcErrorCode.CONNECTION_LOST
}

export function encodeBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new RemoteError(`payload of ${bytes.byteLength} bytes exceeds the protocol limit of ${MAX_PAYLOAD_BYTES}`, RpcErrorCode.INVALID_PARAMS)
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

export function decodeBytes(text: string): Buffer {
  return Buffer.from(text, 'base64')
}

/** What a daemon can do; the runtime only mounts remote Providers the daemon has. */
export interface DaemonCapabilities {
  fs?: boolean
  process?: boolean
  http?: boolean
  /** The `shell` tool's sentence about this machine's shell syntax. */
  shell?: string
  /** `process.platform` of the daemon's machine. */
  platform?: string
  /** Sandbox mechanisms the daemon can enforce; empty when it can confine nothing. */
  sandbox?: string[]
}

export interface DaemonWorkspace {
  /** Stable id every call names; the daemon refuses ids it did not announce. */
  id: string
  /** Absolute path on the daemon's machine. */
  path: string
}

export interface InitializeParams {
  protocolVersion: number
  deviceId: string
  capabilities: DaemonCapabilities
  workspaces: DaemonWorkspace[]
}

export interface InitializeResult {
  protocolVersion: number
  serverTime: string
}

/** Every workspace-bound call carries the id the daemon announced. */
export interface WorkspaceParams {
  workspaceId: string
}

/**
 * Mutating calls carry an id the daemon remembers for a while: a retry with
 * the same id (after a reconnect, when the caller cannot tell whether the
 * first one ran) gets the first answer instead of running twice.
 */
export interface IdempotentParams {
  callId?: string
}

export interface FsStatResult {
  kind: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtimeMs: number
  mode: number
}

/** Sandbox mode and network the runtime decided for one command; the daemon enforces it. */
export interface SandboxParams {
  mode: 'read-only' | 'workspace-write' | 'bypass'
  sessionId?: string
  /** A `SandboxNetworkRequest`, as JSON. */
  network?: unknown
}

export interface ProcessCallParams extends WorkspaceParams, IdempotentParams {
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  maxBuffer?: number
  sandbox?: SandboxParams
  /** Ask for `process/output` notifications tagged with this call's id. */
  stream?: boolean
}

export interface ShellCallParams extends ProcessCallParams {
  command: string
  unsandboxed?: boolean
}

export interface ArgvCallParams extends ProcessCallParams {
  argv: string[]
}

export interface ProcessCallResult {
  exitCode: number
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
}

export interface StartParams extends WorkspaceParams, IdempotentParams {
  cwd: string
  env?: Record<string, string>
  sandbox?: SandboxParams
  command?: string
  argv?: string[]
  unsandboxed?: boolean
}

export interface StartResult {
  handle: string
  pid?: number
  sandboxed?: boolean
}

export interface OutputNotification {
  /** The `callId` of a streaming run, or the `handle` of a background process. */
  id: string
  stream: 'stdout' | 'stderr'
  /** Base64 of the raw chunk. */
  data: string
}

/** The latest output tail of a background process (combined, at most `BACKGROUND_OUTPUT_LIMIT` characters). */
export interface TailNotification {
  handle: string
  output: string
}

export interface ExitNotification {
  handle: string
  exitCode: number | null
}

export interface HttpFetchParams {
  url: string
  headers?: Record<string, string>
  maxBytes?: number
  allowPrivate?: boolean
}

/**
 * The method table: name → params and result. Requests flow runtime → daemon,
 * except `initialize`, which the daemon sends first.
 */
export interface DaemonMethods {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'fs/realRoot': { params: WorkspaceParams; result: string }
  'fs/resolve': { params: WorkspaceParams & { path: string }; result: string }
  'fs/stat': { params: WorkspaceParams & { path: string }; result: FsStatResult | null }
  'fs/read': { params: WorkspaceParams & { path: string; start?: number; end?: number }; result: string }
  'fs/write': { params: WorkspaceParams & IdempotentParams & { path: string; data: string; mode?: 'replace' | 'create' | 'append' }; result: null }
  'fs/list': { params: WorkspaceParams & { path: string }; result: Array<{ name: string; kind: FsStatResult['kind'] }> }
  'fs/mkdir': { params: WorkspaceParams & IdempotentParams & { path: string }; result: null }
  'fs/remove': { params: WorkspaceParams & IdempotentParams & { path: string; recursive?: boolean }; result: null }
  'fs/rename': { params: WorkspaceParams & IdempotentParams & { from: string; to: string }; result: null }
  'process/shell': { params: ShellCallParams; result: ProcessCallResult }
  'process/run': { params: ArgvCallParams; result: ProcessCallResult }
  'process/start': { params: StartParams; result: StartResult }
  'process/kill': { params: { handle: string }; result: null }
  'http/fetch': { params: HttpFetchParams; result: { status: number; ok: boolean; headers: Record<string, string>; body: string; truncated: boolean } }
}

export type DaemonMethod = keyof DaemonMethods
export type ParamsOf<M extends DaemonMethod> = DaemonMethods[M]['params']
export type ResultOf<M extends DaemonMethod> = DaemonMethods[M]['result']

/** Notifications either side may send. */
export interface DaemonNotifications {
  '$/heartbeat': Record<string, never>
  '$/cancel': { id: number }
  'process/output': OutputNotification
  'process/tail': TailNotification
  'process/exit': ExitNotification
}

/** Methods whose effect must not happen twice; they carry a `callId`. */
export const MUTATING_METHODS: ReadonlySet<DaemonMethod> = new Set<DaemonMethod>([
  'fs/write', 'fs/mkdir', 'fs/remove', 'fs/rename', 'process/shell', 'process/run', 'process/start',
])
