import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@tnega/core'
import {
  SpillError,
  SpillStore,
  type SaveTextSpill,
  type SpillRef,
} from '@tnega/spill'

/** 本地文件系统后端的配置。 */
export interface Config {
  /** 工作区根；定位符优先给出相对它的路径，便于直接用 `read_file` 读回。 */
  cwd?: string
  /** 存储根目录，默认 `<cwd>/.tnega/spill`。 */
  root?: string
}

const DEFAULT_SPILL_DIR = join('.tnega', 'spill')

/** 模型取回产物时该怎么做；与挂载了哪些工具无关，只说路径怎么用。 */
const RETRIEVAL_HINT =
  'Read it with the read_file tool (raise maxBytes or use offset/limit for a '
  + 'specific window), or grep this path to search inside it.'

/**
 * 把 `suggestedName` 压成一个安全的路径片段。
 *
 * 只保留字母、数字、点、下划线和连字符，去掉开头的点，并截断长度 —— 建议名来自
 * 调用方（最终来自工具名），不能拿它当路径用。
 */
function safeSegment(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80)
  return cleaned || fallback
}

/**
 * 产物文件名：工具名 + 调用 id + 建议名。
 *
 * 调用 id 让同一工具被反复调用时各自留档，而不是互相覆盖。
 */
function artifactName(request: SaveTextSpill): string {
  const suggested = safeSegment(request.suggestedName, 'output.txt')
  const source = safeSegment(
    `${request.source.toolName}-${request.source.callId}`,
    'tool',
  )
  return `${source.slice(0, 96)}-${suggested}`.slice(0, 160)
}

/**
 * 把溢出文本落到本地文件。
 *
 * 定位符在存储根位于 `cwd` 之内时是相对 `cwd` 的路径，这样 `read_file` 的沙箱
 * 直接接受它；否则退回绝对路径（`cwd` 之外的文件需要绝对路径才能打开）。
 */
export class LocalSpillStore extends SpillStore {
  private readonly cwd: string
  private readonly root: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.cwd = resolve(config.cwd ?? process.cwd())
    this.root = resolve(config.root ?? join(this.cwd, DEFAULT_SPILL_DIR))
  }

  override async saveText(request: SaveTextSpill): Promise<SpillRef> {
    if (typeof request?.content !== 'string') {
      throw new SpillError('spill content must be a string', 'SPILL_INVALID')
    }
    const directory = request.owner?.sessionId
      ? join(this.root, safeSegment(request.owner.sessionId, 'session'))
      : this.root
    const file = join(directory, artifactName(request))
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(file, request.content, 'utf8')
    } catch (error) {
      throw new SpillError(
        `could not write spill file ${file}: ${String((error as Error)?.message ?? error)}`,
        'SPILL_FAILED',
        { cause: error },
      )
    }
    return {
      locator: this.locate(file),
      bytes: Buffer.byteLength(request.content, 'utf8'),
      retrievalHint: RETRIEVAL_HINT,
    }
  }

  /** 存储根在工作区内就给相对路径，否则给绝对路径。 */
  private locate(file: string): string {
    const rel = relative(this.cwd, file)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return file
    return rel.split(sep).join('/')
  }
}

export const spillLocal = {
  name: 'spill-local',
  apply(ctx: Context, config: Config = {}): void {
    new LocalSpillStore(ctx, config)
  },
}
