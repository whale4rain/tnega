import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionLog } from '@tnega/session'
import { effectiveLlmConfig, type SystemConfig } from './config.js'
import { workspaceSessionDir, workspaceStateDir } from './home-paths.js'
import { workspaceProjectStateRoot } from './state-storage.js'
import { ensureSessionDir, isSessionId } from './store.js'
import { summarizeUsage, workspaceUsageFromSummaries, type SessionUsageSummary, type UsageTotals, type WorkspaceUsage } from './usage.js'

interface CachedLog {
  fingerprint: string
  summary: SessionUsageSummary
  pricingKey: string
  usage: WorkspaceUsage
  days: { timestamp: number; totals: UsageTotals }[]
  cacheBases: { total: number; models: Record<string, number>; days: Record<string, number> }
}
interface UsageCache { version: 1; logs: Record<string, CachedLog> }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function validTotals(value: unknown): value is UsageTotals {
  return record(value) && ['responses', 'promptTokens', 'completionTokens', 'cachedTokens', 'reasoningTokens'].every(key => number(value[key]))
    && (value.cacheHitRate === undefined || number(value.cacheHitRate))
    && (value.cost === undefined || (Array.isArray(value.cost) && value.cost.every(cost => record(cost) && number(cost.amount) && typeof cost.currency === 'string')))
}
function validSummary(value: unknown): value is SessionUsageSummary {
  return record(value) && typeof value.title === 'string' && Array.isArray(value.responses) && value.responses.every(response => {
    if (!record(response) || typeof response.modelId !== 'string' || !number(response.timestamp) || !record(response.usage)) return false
    const usage = response.usage
    return number(usage.promptTokens) && number(usage.completionTokens)
      && ['cachedTokens', 'reasoningTokens', 'totalTokens'].every(key => usage[key] === undefined || number(usage[key]))
  })
}
function validUsage(value: unknown): value is WorkspaceUsage {
  return record(value) && validTotals(value.total) && validTotals(value.today) && validTotals(value.week) && number(value.sessions)
    && Array.isArray(value.byModel) && value.byModel.every(model => validTotals(model) && record(model) && typeof model.modelId === 'string' && typeof model.name === 'string' && typeof model.priced === 'boolean')
    && Array.isArray(value.responses) && value.responses.every(response => validTotals(response) && record(response)
      && typeof response.sessionId === 'string' && typeof response.sessionTitle === 'string' && number(response.timestamp) && typeof response.modelId === 'string')
}
function validLog(value: unknown): value is CachedLog {
  return record(value) && typeof value.fingerprint === 'string' && typeof value.pricingKey === 'string' && validSummary(value.summary) && validUsage(value.usage)
    && Array.isArray(value.days) && value.days.every(day => record(day) && number(day.timestamp) && validTotals(day.totals))
    && record(value.cacheBases) && number(value.cacheBases.total) && record(value.cacheBases.models) && Object.values(value.cacheBases.models).every(number)
    && record(value.cacheBases.days) && Object.values(value.cacheBases.days).every(number)
}
async function readCache(file: string): Promise<UsageCache> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (record(value) && value.version === 1 && record(value.logs)) {
      const logs: Record<string, CachedLog> = {}
      for (const [key, log] of Object.entries(value.logs)) if (validLog(log)) Object.defineProperty(logs, key, { value: log, enumerable: true, writable: true, configurable: true })
      return { version: 1, logs }
    }
  } catch { /* Cache damage or absence never prevents rebuilding from Session facts. */ }
  return { version: 1, logs: {} }
}
async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}
async function fingerprint(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    return info.isFile() ? JSON.stringify([info.size, info.mtimeMs, info.ctimeMs, info.ino]) : undefined
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
function dayStart(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Merge cached aggregates without repricing or walking historical responses. */
function mergeTotals(values: readonly UsageTotals[], bases?: readonly number[]): UsageTotals {
  const sum: UsageTotals = { responses: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
  let cacheBase = 0
  const cost = new Map<string, number>()
  for (const [index, value] of values.entries()) {
    sum.responses += value.responses
    sum.promptTokens += value.promptTokens
    sum.completionTokens += value.completionTokens
    sum.cachedTokens += value.cachedTokens
    sum.reasoningTokens += value.reasoningTokens
    if (bases) cacheBase += bases[index] ?? 0
    else if (value.cacheHitRate !== undefined) cacheBase += value.cacheHitRate > 0 ? value.cachedTokens / value.cacheHitRate : value.promptTokens
    for (const item of value.cost ?? []) cost.set(item.currency, (cost.get(item.currency) ?? 0) + item.amount)
  }
  if (cacheBase > 0) sum.cacheHitRate = sum.cachedTokens / cacheBase
  if (cost.size) sum.cost = [...cost].map(([currency, amount]) => ({ currency, amount }))
  return sum
}

/** The composition layer locates Session and Project Thread histories and caches usage facts. */
export async function storedWorkspaceUsage(workspace: string, config: SystemConfig): Promise<WorkspaceUsage> {
  const dir = await ensureSessionDir(workspace)
  workspaceProjectStateRoot(workspace)
  const cacheFile = join(workspaceStateDir(workspace), 'usage-cache.json')
  const cache = await readCache(cacheFile)
  const defaultModel = effectiveLlmConfig(config).modelId
  const pricingKey = createHash('sha256').update(JSON.stringify({
    defaultModel,
    models: config.models?.map(model => ({ id: model.id, name: model.name, pricing: model.pricing })),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: new Date().getTimezoneOffset(),
  })).digest('hex')
  const files: { id: string; file: string; projectId?: string; threadId?: string }[] = []
  for (const entry of await entries(dir)) {
    if (entry.isFile() && entry.name.endsWith('.jsonl') && isSessionId(entry.name.slice(0, -6))) files.push({ id: entry.name.slice(0, -6), file: join(dir, entry.name) })
  }
  const projects = join(workspaceSessionDir(workspace), 'projects')
  for (const project of await entries(projects)) {
    if (!project.isDirectory()) continue
    const agents = join(projects, project.name, 'agents')
    for (const thread of await entries(agents)) {
      if (thread.isDirectory()) files.push({ id: `${project.name}/${thread.name}`, file: join(agents, thread.name, 'session.jsonl'), projectId: project.name, threadId: thread.name })
    }
  }
  const next: UsageCache = { version: 1, logs: {} }
  let changed = false
  const included: CachedLog[] = []
  for (const source of files) {
    await SessionLog.flushLive(source.file)
    const before = await fingerprint(source.file)
    if (!before) continue
    let cached = Object.hasOwn(cache.logs, source.id) ? cache.logs[source.id] : undefined
    if (!cached || cached.fingerprint !== before) {
      changed = true
      const log = new SessionLog(source.file)
      try {
        await log.init()
        const summary = summarizeUsage(await log.read())
        cached = { fingerprint: before, summary, pricingKey: '', usage: workspaceUsageFromSummaries([], config), days: [], cacheBases: { total: 0, models: {}, days: {} } }
      } catch (error) {
        // Session listings have always skipped invalid histories; Thread failures stay explicit.
        if (source.projectId) throw error
        continue
      } finally { await log.close() }
      // Do not reuse a snapshot if a concurrent writer changed its source while it was read.
      if (await fingerprint(source.file) !== before) cached.fingerprint = ''
    }
    if (cached.pricingKey !== pricingKey) {
      changed = true
      cached.usage = workspaceUsageFromSummaries([cached.summary], config, 0, [source.id])
      cached.usage.responses = cached.usage.responses.map(response => ({ ...response, ...(source.projectId ? { projectId: source.projectId, threadId: source.threadId } : {}) }))
      const days = new Map<number, UsageTotals[]>()
      for (const response of cached.usage.responses) {
        const timestamp = dayStart(response.timestamp)
        const group = days.get(timestamp) ?? []
        group.push(response)
        days.set(timestamp, group)
      }
      cached.days = [...days].map(([timestamp, values]) => ({ timestamp, totals: mergeTotals(values) }))
      cached.cacheBases = { total: 0, models: {}, days: {} }
      for (const response of cached.summary.responses) {
        if (response.usage.cachedTokens === undefined) continue
        const base = response.usage.promptTokens
        const modelId = response.modelId || defaultModel
        const day = String(dayStart(response.timestamp))
        cached.cacheBases.total += base
        const previous = Object.hasOwn(cached.cacheBases.models, modelId) ? cached.cacheBases.models[modelId] ?? 0 : 0
        Object.defineProperty(cached.cacheBases.models, modelId, { value: previous + base, enumerable: true, writable: true, configurable: true })
        cached.cacheBases.days[day] = (cached.cacheBases.days[day] ?? 0) + base
      }
      cached.pricingKey = pricingKey
    }
    Object.defineProperty(next.logs, source.id, { value: cached, enumerable: true, writable: true, configurable: true })
    if (!source.projectId || cached.summary.responses.length > 0) included.push(cached)
  }
  if (changed || Object.keys(next.logs).length !== Object.keys(cache.logs).length) {
    const temporary = `${cacheFile}.${randomUUID()}.tmp`
    try {
      await mkdir(workspaceStateDir(workspace), { recursive: true })
      await writeFile(temporary, JSON.stringify(next), 'utf8')
      await rename(temporary, cacheFile)
    } catch { /* Reports remain available when an optional cache cannot be persisted. */ }
    finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }
  const today = dayStart(Date.now())
  const weekDate = new Date(today)
  weekDate.setDate(weekDate.getDate() - 6)
  const week = weekDate.getTime()
  const range = (start: number): UsageTotals => {
    const values: UsageTotals[] = []
    const bases: number[] = []
    for (const log of included) for (const day of log.days) {
      if (day.timestamp < start) continue
      values.push(day.totals)
      bases.push(log.cacheBases.days[String(day.timestamp)] ?? 0)
    }
    return mergeTotals(values, bases)
  }
  const models = new Map<string, { name: string; priced: boolean; totals: UsageTotals[]; bases: number[] }>()
  for (const log of included) for (const model of log.usage.byModel) {
    const group = models.get(model.modelId) ?? { name: model.name, priced: model.priced, totals: [], bases: [] }
    group.totals.push(model)
    group.bases.push(log.cacheBases.models[model.modelId] ?? 0)
    models.set(model.modelId, group)
  }
  return {
    total: mergeTotals(included.map(log => log.usage.total), included.map(log => log.cacheBases.total)),
    today: range(today),
    week: range(week),
    byModel: [...models].map(([modelId, group]) => ({ modelId, name: group.name, priced: group.priced, ...mergeTotals(group.totals, group.bases) })).sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens)),
    sessions: included.length,
    responses: included.flatMap(log => log.usage.responses).sort((a, b) => b.timestamp - a.timestamp),
  }
}
