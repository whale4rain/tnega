/**
 * The terminal UI's state and actions, kept apart from Ink so the behaviour
 * (streaming, steering, approvals, recovery) is testable without a terminal.
 * It follows the web app's `Conversation` component: durable Session events
 * have the final word, live Stream Events only advance the view meanwhile.
 */
import {
  ApiError,
  applyStream,
  beginRun,
  CLIENT_COMMANDS,
  fromEvents,
  mergeCommands,
  noteSettingChange,
  parseCommand,
  settingChangeText,
  type AgentType,
  type ApprovalMode,
  type Client,
  type CommandSpec,
  type ConfigSnapshot,
  type ContextUsage,
  type Entry,
  type GoalState,
  type PendingQuestionRequest,
  type Permission,
  type PlanPayload,
  type QuestionAnswerItem,
  type SessionDetail,
  type SessionEffort,
  type SessionEvent,
  type SessionMetrics,
  type SessionMode,
  type SessionSummary,
  type SlashCommand,
  type StreamEvent,
  type UsageTotals,
} from '@tnega/client'

export interface RunSettings {
  agentType: AgentType
  mode: SessionMode
  permission: Permission
  approvalMode: ApprovalMode
  model?: string
  reasoningEffort: SessionEffort
}

export interface Approval {
  id: string
  tool: string
  input: string
  /** Set when a CodeMode script made the call. */
  via?: 'run_code'
}

export interface Notice {
  tone: 'info' | 'warn' | 'error'
  text: string
}

export interface TuiState {
  workspace: string
  config?: ConfigSnapshot | undefined
  sessions: SessionSummary[]
  /** The open session; undefined for a new conversation not sent yet. */
  session?: SessionSummary | undefined
  entries: readonly Entry[]
  context?: ContextUsage | undefined
  metrics?: SessionMetrics | undefined
  usage?: UsageTotals | undefined
  plan?: PlanPayload | undefined
  goal?: GoalState | null | undefined
  /** This client is streaming a run. */
  running: boolean
  /** A run started elsewhere (the web app, another terminal) is going. */
  remoteRunning: boolean
  approvals: Approval[]
  questions: PendingQuestionRequest[]
  /** The coding agent's own slash commands (skills, MCP). */
  serverCommands: SlashCommand[]
  /** Settings for the next new session. */
  draft: RunSettings
  notice?: Notice | undefined
  /** A short description of a blocking step (creating a session, compacting). */
  busy?: string | undefined
  /**
   * Bumped whenever the transcript is replaced rather than appended to
   * (another session opened, a compaction), so the view can redraw it.
   */
  epoch: number
  /** The last run settled at this time; the weather shows a brief rainbow. */
  finishedAt?: number | undefined
  /** Messages held back until the current run ends, oldest first. */
  queued: string[]
}

export interface ControllerOptions {
  /** How long live Stream Events are batched before the view updates. */
  flushMs?: number
  /** Poll interval for a run started elsewhere. */
  remotePollMs?: number
  /** Poll interval for pending questions while a run is going; idle polls are four times slower. */
  questionPollMs?: number
  draft?: Partial<RunSettings>
}

const DEFAULT_DRAFT: RunSettings = {
  agentType: 'coding',
  mode: 'auto',
  permission: 'read-only',
  approvalMode: 'manual',
  reasoningEffort: 'default',
}

type Listener = (state: TuiState) => void

export class TuiController {
  state: TuiState
  private readonly listeners = new Set<Listener>()
  private readonly flushMs: number
  private readonly remotePollMs: number
  private readonly questionPollMs: number
  private abort: AbortController | undefined
  /** Session id the local stream is writing into. */
  private streamingFor: string | undefined
  private queue: StreamEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private remoteTimer: ReturnType<typeof setInterval> | undefined
  private questionTimer: ReturnType<typeof setTimeout> | undefined
  private questionAbort: AbortController | undefined
  private readonly answered = new Set<string>()
  private readonly autoRecovered = new Set<string>()
  private disposed = false
  private stopRequested = false

  constructor(private readonly client: Client, workspace: string, options: ControllerOptions = {}) {
    this.flushMs = options.flushMs ?? 33
    this.remotePollMs = options.remotePollMs ?? 1500
    this.questionPollMs = options.questionPollMs ?? 1000
    this.state = {
      workspace,
      sessions: [],
      entries: [],
      running: false,
      remoteRunning: false,
      approvals: [],
      questions: [],
      serverCommands: [],
      draft: { ...DEFAULT_DRAFT, ...options.draft },
      epoch: 0,
      queued: [],
    }
  }

  get api() {
    return this.client.api
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<TuiState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  private fail(reason: unknown): void {
    this.set({ notice: { tone: 'error', text: errorText(reason) } })
  }

  info(text: string): void {
    this.set({ notice: { tone: 'info', text } })
  }

  clearNotice(): void {
    if (this.state.notice) this.set({ notice: undefined })
  }

  /** Settings of the open session, or the draft for a new one. */
  get settings(): RunSettings {
    const { session, draft, config } = this.state
    if (!session) return draft
    return {
      agentType: session.agentType ?? 'general',
      mode: session.mode ?? 'auto',
      permission: session.permission ?? 'read-only',
      approvalMode: session.approvalMode ?? config?.config.approvalReview?.defaultMode ?? 'manual',
      ...(session.model ? { model: session.model } : {}),
      reasoningEffort: session.reasoningEffort ?? 'default',
    }
  }

  /** The name the model picker shows for a route id. */
  private modelName(id: string): string {
    return this.state.config?.models.find(model => model.id === id)?.name || id
  }

  /** Id and display name of the model the next turn uses. */
  get model(): { id: string; name: string } | undefined {
    const config = this.state.config
    const id = this.settings.model ?? config?.effective.modelId
    if (!id) return undefined
    const option = config?.models.find(model => model.id === id)
    return { id, name: option?.name || id }
  }

  get live(): boolean {
    return this.state.running || this.state.remoteRunning
  }

  /** Commands the composer completes: the client's own plus the coding agent's. */
  get commands(): CommandSpec[] {
    return mergeCommands(this.state.serverCommands)
  }

  // --- loading --------------------------------------------------------------

  async start(sessionId?: string): Promise<void> {
    const { workspace } = this.state
    await Promise.all([
      this.loadConfig(),
      // Register the folder so the web app's sidebar lists it too.
      this.api.addWorkspace(workspace).catch(() => undefined),
    ])
    await this.refreshSessions()
    if (sessionId === 'last') {
      const latest = this.state.sessions[0]
      if (latest) await this.openSession(latest.id)
    } else if (sessionId) {
      await this.openSession(sessionId)
    }
  }

  async loadConfig(): Promise<void> {
    try {
      this.set({ config: await this.api.config() })
    } catch (reason) {
      this.fail(reason)
    }
  }

  async refreshSessions(): Promise<void> {
    try {
      const { sessions } = await this.api.sessions(this.state.workspace)
      this.set({ sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt) })
    } catch (reason) {
      this.fail(reason)
    }
  }

  private applyDetail(detail: SessionDetail, replace: boolean): void {
    this.set({
      session: detail.summary,
      entries: fromEvents(detail.events, { modelName: id => this.modelName(id) }),
      context: detail.context,
      metrics: detail.metrics,
      usage: detail.usage,
      plan: latestPlan(detail.events),
      remoteRunning: detail.running && this.streamingFor !== detail.summary.id,
      ...(replace ? { epoch: this.state.epoch + 1 } : {}),
    })
    this.syncRemotePoll()
    if (detail.recovery?.safe && !this.live && !this.autoRecovered.has(detail.summary.id)) {
      this.autoRecovered.add(detail.summary.id)
      this.info('Continuing the run that stopped when the app closed.')
      void this.resumeInterrupted(detail.summary.id)
    } else if (detail.recovery && !detail.recovery.safe && !this.live) {
      const calls = detail.recovery.uncertainCalls.join(', ')
      this.set({ notice: { tone: 'warn', text: `The last run stopped mid-turn${calls ? ` while running ${calls}` : ''}. Send /continue to pick it up.` } })
    }
  }

  private async reload(id: string, replace = false): Promise<SessionDetail> {
    const detail = await this.api.session(this.state.workspace, id)
    this.applyDetail(detail, replace)
    return detail
  }

  async openSession(id: string): Promise<void> {
    if (this.state.running) {
      this.set({ notice: { tone: 'warn', text: 'Stop the current run (Esc) before switching sessions.' } })
      return
    }
    this.resetSessionView()
    this.set({ busy: 'Opening session…' })
    try {
      const detail = await this.reload(id, true)
      if (detail.summary.mode === 'goal') void this.loadGoal(id)
      void this.loadServerCommands()
      this.pollQuestions()
    } catch (reason) {
      this.fail(reason)
    } finally {
      this.set({ busy: undefined })
    }
  }

  /** Start a fresh conversation; the session is created by the first send. */
  newSession(): void {
    if (this.state.running) {
      this.set({ notice: { tone: 'warn', text: 'Stop the current run (Esc) before starting a new session.' } })
      return
    }
    this.resetSessionView()
    this.set({ session: undefined, entries: [], epoch: this.state.epoch + 1 })
  }

  private resetSessionView(): void {
    this.stopPolling()
    this.set({
      approvals: [],
      questions: [],
      notice: undefined,
      plan: undefined,
      goal: null,
      serverCommands: [],
      remoteRunning: false,
      context: undefined,
      metrics: undefined,
      usage: undefined,
      finishedAt: undefined,
      queued: [],
    })
  }

  private async loadGoal(id: string): Promise<void> {
    try {
      const { goal } = await this.api.goal(this.state.workspace, id)
      if (this.state.session?.id === id) this.set({ goal })
    } catch {
      // The goal line is optional.
    }
  }

  private async loadServerCommands(): Promise<void> {
    const session = this.state.session
    if (!session || this.settings.agentType !== 'coding') return
    try {
      const { commands } = await this.api.slashCommands(this.state.workspace, session.id)
      if (this.state.session?.id === session.id) this.set({ serverCommands: commands })
    } catch {
      // Completion falls back to the client commands.
    }
  }

  // --- polling --------------------------------------------------------------

  private syncRemotePoll(): void {
    const id = this.state.session?.id
    if (this.state.remoteRunning && id) {
      if (this.remoteTimer) return
      this.remoteTimer = setInterval(() => {
        this.reload(id).then(detail => {
          if (detail.running) return
          void this.refreshSessions()
          this.settleQueue(false)
        }, () => undefined)
      }, this.remotePollMs)
    } else if (this.remoteTimer) {
      clearInterval(this.remoteTimer)
      this.remoteTimer = undefined
    }
  }

  private pollQuestions(): void {
    this.questionAbort?.abort()
    if (this.questionTimer) clearTimeout(this.questionTimer)
    const id = this.state.session?.id
    if (!id) return
    const controller = new AbortController()
    this.questionAbort = controller
    const poll = async () => {
      try {
        const result = await this.api.questions(this.state.workspace, id, controller.signal)
        if (controller.signal.aborted) return
        const pending = result.questions.filter(request => !this.answered.has(request.requestId))
        if (pending.length || this.state.questions.length) this.set({ questions: pending })
      } catch {
        // A failed poll retries on the next tick.
      }
      if (!controller.signal.aborted) {
        this.questionTimer = setTimeout(() => void poll(), this.live ? this.questionPollMs : this.questionPollMs * 4)
      }
    }
    void poll()
  }

  private stopPolling(): void {
    if (this.remoteTimer) clearInterval(this.remoteTimer)
    this.remoteTimer = undefined
    this.questionAbort?.abort()
    this.questionAbort = undefined
    if (this.questionTimer) clearTimeout(this.questionTimer)
    this.questionTimer = undefined
  }

  // --- running --------------------------------------------------------------

  private onStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'approval/request':
        this.set({ approvals: [...this.state.approvals, { id: event.id, tool: event.tool, input: event.input, ...(event.via ? { via: event.via } : {}) }] })
        return
      case 'plan/start':
        this.set({ plan: { items: [], status: 'pending' } })
        return
      case 'plan/items':
      case 'plan/done':
        this.set({ plan: event.plan })
        return
      case 'plan/item': {
        const plan = this.state.plan
        if (plan) this.set({ plan: { ...plan, items: plan.items.map(item => item.id === event.item.id ? event.item : item) } })
        break
      }
      default:
        break
    }
    this.queue.push(event)
    this.flushTimer ??= setTimeout(() => this.flush(), this.flushMs)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const events = this.queue
    if (!events.length) return
    this.queue = []
    this.set({ entries: events.reduce(applyStream, this.state.entries) })
  }

  private async run(id: string, prompt: string, resumeQueued = false): Promise<void> {
    const controller = new AbortController()
    this.abort = controller
    this.streamingFor = id
    this.set({
      running: true,
      notice: undefined,
      finishedAt: undefined,
      ...(resumeQueued ? {} : { entries: beginRun(this.state.entries, prompt) }),
    })
    this.pollQuestions()
    // One id for every attempt below: a retry never queues the same message twice.
    const requestId = resumeQueued ? undefined : crypto.randomUUID()
    let failed = false
    // The run's stream can end normally after the turn itself failed (e.g. the model call).
    let turnFailed = false
    this.stopRequested = false
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.client.streamRun(this.state.workspace, id, prompt, event => {
            if (event.type === 'error') turnFailed = true
            this.onStreamEvent(event)
          }, controller.signal, resumeQueued, [], requestId)
          break
        } catch (reason) {
          // A previous run can take a moment to release the session.
          if (reason instanceof ApiError && reason.status === 409 && attempt < 10 && !controller.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 400))
            continue
          }
          throw reason
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        failed = true
        this.fail(reason)
      }
    } finally {
      this.flush()
      this.streamingFor = undefined
      this.abort = undefined
      this.set({ approvals: [] })
      // The durable log replaces the live view in the same update that ends the run.
      try {
        const detail = await this.api.session(this.state.workspace, id)
        this.applyDetail(detail, false)
      } catch {
        // Keep the live view when the reload fails.
      }
      this.set({ running: false, ...(failed ? {} : { finishedAt: Date.now() }) })
      void this.refreshSessions()
      this.settleQueue(failed || turnFailed)
    }
  }

  /**
   * A run that ended on its own takes the queue as the next prompt; a stopped
   * or failed one leaves it waiting, since what was queued may no longer apply.
   */
  private settleQueue(failed: boolean): void {
    if (!this.state.queued.length) return
    if (failed || this.stopRequested) this.info('Your queued message is still waiting: Enter sends it, ↑ edits it.')
    else void this.sendQueued()
  }

  /** Hold a message until the current run ends; with nothing running, send it now. */
  async enqueue(text: string): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed) return false
    if (!this.state.running) return this.send(trimmed)
    this.set({ queued: [...this.state.queued, trimmed], notice: undefined })
    return true
  }

  /** Take the newest queued message back, e.g. to edit it. */
  unqueue(): string | undefined {
    const last = this.state.queued.at(-1)
    if (last !== undefined) this.set({ queued: this.state.queued.slice(0, -1) })
    return last
  }

  /** Send everything queued as one prompt. */
  async sendQueued(): Promise<boolean> {
    const queued = this.state.queued
    if (!queued.length || this.live) return false
    this.set({ queued: [] })
    const sent = await this.send(queued.join('\n\n'))
    if (!sent) this.set({ queued: [...queued, ...this.state.queued] })
    return sent
  }

  /**
   * Hand a message to the running agent at its next step. With `text` that
   * message goes now; without, everything queued goes as one. With nothing
   * running there is nothing to steer, so it is sent as the next prompt.
   */
  async steer(text?: string): Promise<boolean> {
    const typed = text?.trim()
    const queued = typed ? [] : this.state.queued
    const message = typed || queued.join('\n\n')
    if (!message) return false
    if (!this.live) return typed ? this.send(typed) : this.sendQueued()
    const id = this.streamingFor ?? this.state.session?.id
    if (!id) return false
    if (queued.length) this.set({ queued: [] })
    try {
      await this.api.steer(this.state.workspace, id, message)
      this.info('Steering sent. The agent reads it at the next step.')
      return true
    } catch (reason) {
      if (queued.length) this.set({ queued: [...queued, ...this.state.queued] })
      this.fail(reason)
      return false
    }
  }

  /** Auto → Plan → Goal → Auto, as /plan, /goal and /auto. */
  async cycleMode(): Promise<void> {
    if (this.live) {
      this.set({ notice: { tone: 'warn', text: 'Change the mode once this run ends.' } })
      return
    }
    const order: SessionMode[] = ['auto', 'plan', 'goal']
    const next = order[(order.indexOf(this.settings.mode) + 1) % order.length]!
    await this.changeSettings({ mode: next })
  }

  private async resumeInterrupted(id: string): Promise<void> {
    try {
      const { resumeQueued } = await this.api.recover(this.state.workspace, id)
      if (resumeQueued && !this.live) await this.run(id, '', true)
    } catch (reason) {
      this.fail(reason)
    }
  }

  /**
   * Send what the composer holds: a client command, a coding-agent command or
   * a new prompt. While a run goes it is queued for after the run instead;
   * `steer` hands it to the running agent now.
   */
  async send(text: string): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed) return false
    this.set({ notice: undefined })
    if (this.live) {
      this.set({ queued: [...this.state.queued, trimmed] })
      return true
    }
    const handled = await this.runClientCommand(trimmed)
    if (handled !== undefined) return handled
    return this.sendPrompt(trimmed, this.settings)
  }

  private async sendPrompt(text: string, settings: RunSettings): Promise<boolean> {
    let id = this.state.session?.id
    try {
      if (!id) {
        this.set({ busy: 'Starting session…' })
        const created = (await this.api.createSession(this.state.workspace, { agentType: settings.agentType, mode: settings.mode })).session
        const patch = {
          approvalMode: settings.approvalMode,
          ...(settings.permission !== 'read-only' ? { permission: settings.permission } : {}),
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.reasoningEffort !== 'default' ? { reasoningEffort: settings.reasoningEffort } : {}),
        }
        const session = (await this.api.patchSession(this.state.workspace, created.id, patch)).summary
        id = session.id
        this.set({ session })
        void this.loadServerCommands()
        void this.refreshSessions()
      }
      const slash = parseCommand(text)
      if (slash && settings.agentType === 'coding' && this.commands.some(command => command.source === 'server' && command.name === slash.name)) {
        this.set({ busy: `Running ${slash.name}…` })
        const { result } = await this.api.runSlash(this.state.workspace, id, slash.name, slash.rest ? slash.rest.split(/\s+/) : [])
        await this.reload(id)
        if (result.kind === 'text' && result.text.trim()) this.info(result.text.trim())
        void this.refreshSessions()
        return true
      }
    } catch (reason) {
      this.fail(reason)
      return false
    } finally {
      this.set({ busy: undefined })
    }
    void this.run(id, text)
    return true
  }

  /** Commands every session understands; undefined when `text` is not one. */
  private async runClientCommand(text: string): Promise<boolean | undefined> {
    const parsed = parseCommand(text)
    const spec = parsed && CLIENT_COMMANDS.find(command => command.name === parsed.name)
    if (!parsed) return undefined
    const { name, rest } = parsed
    if (name === '/continue') {
      const id = this.state.session?.id
      if (!id) return this.reject('There is no run to continue.')
      await this.resumeInterrupted(id)
      return true
    }
    if (!spec) return undefined
    if (name === '/codemode') {
      const option = rest.trim().toLowerCase()
      if (option && option !== 'on' && option !== 'off') return this.reject('Use /codemode on or /codemode off.')
      try {
        this.set({ busy: 'Saving CodeMode…' })
        const saved = await this.api.saveConfig({ codeMode: option !== 'off' })
        this.set({ config: saved })
        this.info(saved.config.codeMode ? 'CodeMode enabled (PTC).' : 'CodeMode disabled.')
        return true
      } catch (reason) {
        this.fail(reason)
        return false
      } finally {
        this.set({ busy: undefined })
      }
    }
    if (name === '/plan' || name === '/goal' || name === '/auto') {
      const mode = name === '/plan' ? 'plan' : name === '/goal' ? 'goal' : 'auto'
      await this.changeSettings({ mode })
      // "/plan add a chart" switches mode and sends the request in one go.
      if (rest && mode !== 'auto') return this.sendPrompt(rest, { ...this.settings, mode })
      this.info(`${mode[0]!.toUpperCase()}${mode.slice(1)} mode.`)
      return true
    }
    if (name === '/model') {
      const needle = rest.toLowerCase()
      const model = (this.state.config?.models ?? []).find(each => each.id.toLowerCase() === needle || (each.name ?? '').toLowerCase() === needle)
      if (!model) return this.reject(rest ? `No model called "${rest}".` : 'Pick a model with /model and a name.')
      await this.changeSettings({ model: model.id })
      this.info(`Using ${model.name || model.id}.`)
      return true
    }
    if (name === '/compact') {
      if (!this.state.session) return this.reject('There is nothing to compact yet.')
      await this.compact()
      return true
    }
    if (name === '/rename') {
      if (!this.state.session || !rest) return this.reject(this.state.session ? 'Give the new title after /rename.' : 'Start the conversation before renaming it.')
      await this.rename(rest)
      return true
    }
    return undefined
  }

  private reject(text: string): false {
    this.set({ notice: { tone: 'error', text } })
    return false
  }

  async stop(): Promise<void> {
    const id = this.streamingFor ?? this.state.session?.id
    if (!id || !this.live) return
    this.stopRequested = true
    const controller = this.abort
    try {
      await this.api.stop(this.state.workspace, id)
    } catch {
      // Falling back to disconnecting is enough to cancel the run.
    }
    setTimeout(() => controller?.abort(), 2500).unref?.()
    this.info('Stopping…')
    if (this.state.remoteRunning) void this.reload(id).catch(() => undefined)
  }

  async approve(approval: Approval, allow: boolean): Promise<void> {
    const id = this.streamingFor ?? this.state.session?.id
    if (!id) return
    this.set({ approvals: this.state.approvals.filter(item => item.id !== approval.id) })
    try {
      await this.api.approve(this.state.workspace, id, approval.id, allow)
    } catch (reason) {
      this.fail(reason)
    }
  }

  async answer(request: PendingQuestionRequest, answers: QuestionAnswerItem[]): Promise<void> {
    const id = this.state.session?.id
    if (!id) return
    try {
      const result = await this.api.answerQuestions(this.state.workspace, id, request.requestId, answers)
      if (!result.accepted) throw new Error('This question has already ended or been answered.')
      this.answered.add(request.requestId)
      this.set({ questions: this.state.questions.filter(item => item.requestId !== request.requestId) })
      if (result.resumeQueued && !this.live) void this.run(id, '', true)
    } catch (reason) {
      this.fail(reason)
    }
  }

  async changeSettings(patch: Partial<RunSettings>): Promise<void> {
    const session = this.state.session
    if (!session) {
      this.set({ draft: { ...this.state.draft, ...patch } })
      return
    }
    // Agent type, permission and approvals carry over to the next new session too.
    this.set({
      draft: {
        ...this.state.draft,
        ...(patch.agentType ? { agentType: patch.agentType } : {}),
        ...(patch.permission ? { permission: patch.permission } : {}),
        ...(patch.approvalMode ? { approvalMode: patch.approvalMode } : {}),
      },
    })
    try {
      const { model, ...rest } = patch
      const body = { ...rest, ...(model ? { model } : {}) }
      if (!Object.keys(body).length) return
      const before = this.settings
      const result = await this.api.patchSession(this.state.workspace, session.id, body)
      this.set({ session: result.summary })
      // Same line the durable log shows on reload; mid-turn it applies from the next step.
      const text = settingChangeText({
        ...(model && model !== before.model ? { model } : {}),
        ...(patch.reasoningEffort && patch.reasoningEffort !== before.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}),
        ...(patch.permission && patch.permission !== before.permission ? { permission: patch.permission } : {}),
        ...(patch.approvalMode && patch.approvalMode !== before.approvalMode ? { approvalMode: patch.approvalMode } : {}),
      }, id => this.modelName(id))
      if (text && this.state.entries.some(entry => entry.kind === 'agent')) {
        this.set({ entries: noteSettingChange(this.state.entries, `setting-${Date.now()}`, text, this.live) })
      }
      if (patch.mode === 'goal') void this.loadGoal(session.id)
      if (patch.mode && patch.mode !== 'goal') this.set({ goal: null })
    } catch (reason) {
      this.fail(reason)
    }
  }

  async compact(): Promise<void> {
    const id = this.state.session?.id
    if (!id) return
    try {
      this.set({ busy: 'Compacting context…' })
      await this.api.compact(this.state.workspace, id)
      await this.reload(id, true)
      this.info('Context compacted.')
    } catch (reason) {
      this.fail(reason)
    } finally {
      this.set({ busy: undefined })
    }
  }

  async rename(title: string): Promise<void> {
    const id = this.state.session?.id
    if (!id || !title.trim()) return
    try {
      const result = await this.api.patchSession(this.state.workspace, id, { title: title.trim() })
      this.set({ session: result.summary })
      void this.refreshSessions()
    } catch (reason) {
      this.fail(reason)
    }
  }

  async deleteSession(id: string): Promise<void> {
    try {
      await this.api.deleteSession(this.state.workspace, id)
      if (this.state.session?.id === id) this.newSession()
      await this.refreshSessions()
    } catch (reason) {
      this.fail(reason)
    }
  }

  dispose(): void {
    this.abort?.abort()
    this.stopPolling()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.disposed = true
    this.listeners.clear()
  }
}

/** Client-side commands the TUI adds on top of the shared ones. */
export const TUI_COMMANDS: readonly CommandSpec[] = [
  { name: '/new', description: 'Start a new session.', source: 'client' },
  { name: '/sessions', description: 'Open another session in this folder.', source: 'client' },
  { name: '/continue', description: 'Continue a run that stopped mid-turn.', source: 'client' },
  { name: '/usage', description: 'Show token use and spend for this folder.', source: 'client' },
  { name: '/diff', description: 'Show the files changed in this folder.', source: 'client' },
  { name: '/settings', description: 'Show the model routes and settings in use.', source: 'client' },
  { name: '/web', description: 'Open this session in the web app.', source: 'client' },
  { name: '/help', description: 'Show keys and commands.', source: 'client' },
  { name: '/quit', description: 'Leave the TUI.', source: 'client' },
]

export function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function latestPlan(events: readonly SessionEvent[]): PlanPayload | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type === 'plan') return event.payload
  }
  return undefined
}
