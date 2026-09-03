# Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `packages/eval` 实现 coding-agent 评测 harness：Task schema 扩展、权限沙箱、完整 trace、多 trial 聚合与 CLI 支持，并用内置冒烟任务验证。

**Architecture:** 在 eval 内新增 coding runtime 组合器（session + tools policy + builtinTools + defineAgent + coding-agent），每个 `task x trial` 使用私有临时 workspace 和独立 session trace；评分由新增 `check` / `trace` strategy 完成，runner 负责 trial 聚合。

**Tech Stack:** TypeScript / Node 22 / vitest / pnpm workspaces

**Spec:** [docs/superpowers/specs/2026-09-02-eval-self-evolution-design.md](../../superpowers/specs/2026-09-02-eval-self-evolution-design.md)

## Global Constraints

- 本计划只覆盖 M1（eval harness）；M2 self-evolution、M3 benchmark、M4 真实评测另行出计划。
- 不引入 Docker；权限通过工具层强制。
- `packages/coding-agent` 只允许新增可选 `systemPrompt` / `planPrompt` 参数，默认值不变，不重构内部。
- 每个任务结束时运行 `pnpm test` 对应文件、`pnpm typecheck`、`pnpm lint`。
- 提交信息使用 Conventional Commits，主题 <= 72 字符。

---

### Task 1: coding-agent 可选 prompt 注入

**Files:**
- Modify: `packages/coding-agent/src/codingAgent.ts`
- Modify: `packages/coding-agent/src/plan.ts`
- Test: `packages/coding-agent/test/promptOptions.test.ts`

**Interfaces:**
- Consumes: `CodingAgentOptions`（现有）
- Produces:
  - `CodingAgentOptions.systemPrompt?: string`
  - `CodingAgentOptions.planPrompt?: string`
  - `generatePlan(adapter, messages, signal?, prompt?)` 第四个可选参数

- [ ] **Step 1: 写失败测试**

`packages/coding-agent/test/promptOptions.test.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { session } from '@tnega/session'
import { tools } from '@tnega/tools'
import type { LLMAdapter } from '@tnega/agent'

import { createCodingAgentPlugin, type CodingService } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tnega-prompt-opts-'))
  dirs.push(dir)
  return dir
}

describe('coding agent prompt options', () => {
  it('uses custom plan prompt', async () => {
    const dir = await tempDir()
    const root = new Context()
    await root.plugin(session, { file: join(dir, 'plan.jsonl') })
    await root.plugin(tools)
    await root.plugin(createCodingAgentPlugin({
      cwd: dir,
      planPrompt: 'CUSTOM_PLAN_MARKER',
    }))
    const coding = root.get('coding') as CodingService
    const adapter: LLMAdapter = {
      async complete(messages) {
        expect(messages[0]?.content).toContain('CUSTOM_PLAN_MARKER')
        return {
          finishReason: 'stop',
          content: JSON.stringify({ items: [{ title: 'one' }] }),
        }
      },
    }
    await coding.generatePlan(adapter, [])
  })

  it('keeps default system prompt when registerAgent is on', async () => {
    const dir = await tempDir()
    const root = new Context()
    await root.plugin(session, { file: join(dir, 'agent.jsonl') })
    await root.plugin(tools)
    const fiber = await root.plugin(createCodingAgentPlugin({ cwd: dir }))
    const loop = root.get('agentLoop') as (input: { text?: string }) => Promise<unknown>
    expect(typeof loop).toBe('function')
    await fiber.dispose()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/coding-agent/test/promptOptions.test.ts`
Expected: `planPrompt` 不存在，TS/运行时失败。

- [ ] **Step 3: 实现**

`packages/coding-agent/src/plan.ts`：`generatePlan` 增加可选参数：

```ts
export async function generatePlan(
  adapter: LLMAdapter,
  messages: readonly ModelMessage[],
  signal?: AbortSignal,
  prompt = PLAN_GENERATION_PROMPT,
): Promise<Plan> {
  // 内部使用 prompt 替代 PLAN_GENERATION_PROMPT
}
```

`packages/coding-agent/src/codingAgent.ts`：

```ts
export interface CodingAgentOptions {
  cwd: string
  mode?: SessionMode
  setMode?: (mode: SessionMode) => void | Promise<void>
  skills?: boolean
  mcp?: boolean
  planTools?: boolean
  registerAgent?: boolean
  systemPrompt?: string
  planPrompt?: string
}
```

在 `apply` 中：`const systemPrompt = options.systemPrompt ?? CODING_SYSTEM_PROMPT`；
`defineAgent` 的 `system` 使用 `systemPrompt`；
`ctx.provide('coding', { generatePlan: (adapter, messages, signal) => generatePlan(adapter, messages, signal, options.planPrompt), ... })`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/coding-agent/test/promptOptions.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/coding-agent/src/codingAgent.ts packages/coding-agent/src/plan.ts packages/coding-agent/test/promptOptions.test.ts
git commit -m "feat(coding-agent): allow system and plan prompt injection"
```

---

### Task 2: eval 类型扩展

**Files:**
- Modify: `packages/eval/src/types.ts`
- Test: `packages/eval/test/types.test.ts`

**Interfaces:**
- Produces（全部从 `@tnega/eval` 导出）：
  - `EvalWorkspaceFixture`、`EvalShellPolicy`、`TaskPermissions`
  - `Task.fixture/setup/check/teardown/trials/permissions/split`
  - `TrialTrace`、`TrialEvidence`、`TrialSummary`
  - `Evidence.trials`、`EvalRun.trialSummaries`
  - `CodingEvalAgentConfig`、`CodingEvalCodingConfig`、`CodingEvalConfig`
  - `EvalRunOptions.coding`

- [ ] **Step 1: 写失败测试**

`packages/eval/test/types.test.ts` 验证类型形状（用 `satisfies` 编译期断言即可，运行期只做对象构造）：

```ts
import { describe, expect, it } from 'vitest'
import type { EvalRunOptions, Evidence, Task } from '../src/index.js'

describe('eval types', () => {
  it('accepts coding task fields', () => {
    const task: Task = {
      id: 'py-fib',
      inputText: 'implement fib',
      fixture: { root: 'fixtures/py-math' },
      check: 'python -m unittest discover -s . -p "test_*.py"',
      trials: 3,
      split: 'val',
      permissions: {
        shell: { enabled: true, allow: ['python'], deny: ['rm'] },
        network: false,
      },
    }
    expect(task.trials).toBe(3)
  })

  it('accepts coding run options', () => {
    const options: EvalRunOptions = {
      candidate: { name: 'deepseek', plugin: () => {} },
      tasks: [],
      coding: {
        llm: {
          async complete() {
            return { finishReason: 'stop' }
          },
        },
        agent: { systemPrompt: 'custom' },
        coding: { skills: false, planTools: true, mcp: false },
      },
    }
    expect(options.coding?.agent?.systemPrompt).toBe('custom')
  })

  it('builds evidence with trials', () => {
    const evidence: Evidence = {
      task: { id: 't' },
      messages: [],
      artifacts: {},
      strategyOutputs: {},
      trials: [],
    }
    expect(evidence.trials).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/eval/test/types.test.ts`
Expected: TS 编译失败（字段不存在）。

- [ ] **Step 3: 实现**

按 spec 第 4、7、9 节添加类型；注意 `exactOptionalPropertyTypes`：可选字段赋值时用展开判断。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/eval/test/types.test.ts && pnpm typecheck`

- [ ] **Step 5: 提交**

```bash
git add packages/eval/src/types.ts packages/eval/test/types.test.ts
git commit -m "feat(eval): extend task, evidence and run types for coding"
```

---

### Task 3: workspace fixture 与 setup/check/teardown

**Files:**
- Create: `packages/eval/src/workspace.ts`
- Test: `packages/eval/test/workspace.test.ts`

**Interfaces:**
- Consumes: `Task`、`EvalWorkspaceFixture`（Task 2）
- Produces:
  - `createTaskWorkspace(task, fixtureRoot?): Promise<TaskWorkspace>`
  - `interface TaskWorkspace { dir: string; dispose(): Promise<void> }`
  - `runWorkspaceCommand(cwd, command, options?): Promise<{ exitCode: number; stdout: string; stderr: string }>`，`options` 含 `timeoutMs?`、`maxBuffer?`、`signal?`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createTaskWorkspace, runWorkspaceCommand } from '../src/workspace.js'
import type { Task } from '../src/types.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('task workspace', () => {
  it('copies fixture root and explicit files', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'tnega-fixture-'))
    dirs.push(fixtureRoot)
    await writeFile(join(fixtureRoot, 'math.py'), 'VALUE = 1\n', 'utf8')
    const task: Task = {
      id: 't',
      fixture: {
        root: fixtureRoot,
        files: [{ path: 'extra.txt', content: 'extra' }],
      },
    }
    const workspace = await createTaskWorkspace(task)
    dirs.push(workspace.dir)
    expect(await readFile(join(workspace.dir, 'math.py'), 'utf8')).toContain('VALUE = 1')
    expect(await readFile(join(workspace.dir, 'extra.txt'), 'utf8')).toBe('extra')
    await workspace.dispose()
  })

  it('runs a command and returns exit code', async () => {
    const workspace = await createTaskWorkspace({ id: 't' })
    dirs.push(workspace.dir)
    const result = await runWorkspaceCommand(workspace.dir, 'node -e "process.exit(3)"')
    expect(result.exitCode).toBe(3)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/eval/test/workspace.test.ts`
Expected: 模块不存在。

- [ ] **Step 3: 实现**

`createTaskWorkspace`：`mkdtemp(join(tmpdir(), 'tnega-eval-ws-'))`；`fixture.root` 用 `cp(root, dir, { recursive: true })` 复制（Node 22 `fs/promises.cp`）；`files` 逐个写入；没有 fixture 时只建空目录。

`runWorkspaceCommand`：`spawn(command, { cwd, shell: true, windowsHide: true })`，按 `timeoutMs`（默认 30s）、`maxBuffer`（默认 256 KiB）与 `signal` 截断/取消，参考 `packages/tools/src/builtins.ts` 的 `runShellCommand` 实现；超时 `killProcessTree` 并返回 exitCode 124。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/eval/test/workspace.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/eval/src/workspace.ts packages/eval/test/workspace.test.ts
git commit -m "feat(eval): add isolated task workspaces and command runner"
```

---

### Task 4: trace 指标

**Files:**
- Create: `packages/eval/src/trace.ts`
- Test: `packages/eval/test/trace.test.ts`

**Interfaces:**
- Consumes: `SessionEvent`（`@tnega/session`）
- Produces:
  - `readTrace(file: string): Promise<SessionEvent[]>`
  - `deriveTraceMetrics(file: string, startedAt: number, endedAt: number): Promise<TrialTrace>`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { deriveTraceMetrics } from '../src/trace.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('trace metrics', () => {
  it('derives tool, retry and recovery metrics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-trace-'))
    dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    const events = [
      { id: '1', seq: 1, ts: 1, type: 'turn/start', payload: {} },
      { id: '2', seq: 2, ts: 2, type: 'tool/call', payload: { name: 'read_file', id: 'a', input: {} } },
      { id: '3', seq: 3, ts: 3, type: 'tool/result', payload: { ok: false, name: 'read_file', id: 'a', input: {}, startedAt: 2, durationMs: 1, error: { name: 'ToolInputError', message: 'bad' } } },
      { id: '4', seq: 4, ts: 4, type: 'llm/retry-started', payload: { attempt: 1 } },
      { id: '5', seq: 5, ts: 5, type: 'tool/call', payload: { name: 'shell', id: 'b', input: { command: 'pytest' } } },
      { id: '6', seq: 6, ts: 6, type: 'tool/result', payload: { ok: true, name: 'shell', id: 'b', input: { command: 'pytest' }, startedAt: 5, durationMs: 10 } },
      { id: '7', seq: 7, ts: 7, type: 'turn/end', payload: { steps: 2 } },
    ]
    await writeFile(file, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    const trace = await deriveTraceMetrics(file, 1, 7)
    expect(trace.metrics.toolCalls).toBe(2)
    expect(trace.metrics.toolErrors).toBe(1)
    expect(trace.metrics.invalidToolCalls).toBe(1)
    expect(trace.metrics.retries).toBe(1)
    expect(trace.metrics.recoveredAfterError).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/eval/test/trace.test.ts`
Expected: 模块不存在。

- [ ] **Step 3: 实现**

`readTrace`：按行 `JSON.parse`，跳过空行。
`deriveTraceMetrics`：

```ts
const events = await readTrace(file)
let toolCalls = 0
let toolErrors = 0
let invalidToolCalls = 0
let retries = 0
let steps = 0
let turns = 0
let sawError = false
let recoveredAfterError = false
for (const event of events) {
  if (event.type === 'tool/call') toolCalls += 1
  else if (event.type === 'tool/result') {
    const ok = event.payload.ok === true
    if (!ok) {
      toolErrors += 1
      const name = event.payload.error?.name ?? ''
      if (name === 'ToolInputError' || name === 'ToolNotFoundError' || name === 'ToolAuthorizationError') {
        invalidToolCalls += 1
      }
      sawError = true
    } else if (sawError) {
      recoveredAfterError = true
      sawError = false
    }
  } else if (event.type === 'llm/retry-started' || event.type === 'llm/retry') {
    retries += 1
  } else if (event.type === 'step/end') {
    steps += 1
  } else if (event.type === 'turn/end') {
    turns += 1
  }
}
```

返回 `{ file, startedAt, endedAt, durationMs, metrics: { steps, turns, toolCalls, toolErrors, invalidToolCalls, retries, tokens, cost, recoveredAfterError } }`；`tokens/cost` 由调用方填入，默认 0。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/eval/test/trace.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/eval/src/trace.ts packages/eval/test/trace.test.ts
git commit -m "feat(eval): derive trial trace metrics from session logs"
```

---

### Task 5: 评测工具策略（白名单 + shell + 截断）

**Files:**
- Create: `packages/eval/src/policy.ts`
- Test: `packages/eval/test/policy.test.ts`

**Interfaces:**
- Consumes: `TaskPermissions`、`ToolPolicy`（`@tnega/tools`）
- Produces:
  - `createEvalToolPolicy(options: { workspace: string; permissions?: TaskPermissions; maxOutputBytes?: number }): ToolPolicy`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@tnega/tools'

import { createEvalToolPolicy } from '../src/policy.js'
import type { TaskPermissions } from '../src/types.js'

function tool(name: string): ToolDefinition {
  return {
    schema: { name, description: name },
    execute: () => ({}),
  }
}

describe('eval tool policy', () => {
  const policy = createEvalToolPolicy({
    workspace: 'C:\\ws',
    permissions: {
      shell: { enabled: true, allow: ['pytest', 'python'], deny: ['rm'] },
      network: false,
    },
    maxOutputBytes: 8,
  })

  it('allows whitelisted tools', async () => {
    const ok = await policy.authorizer?.({ tool: tool('read_file'), name: 'read_file', input: {}, options: {}, startedAt: 0 })
    expect(ok).toBe(true)
  })

  it('denies shell when command is not allowed', async () => {
    const ok = await policy.authorizer?.({ tool: tool('shell'), name: 'shell', input: { command: 'rm -rf /' }, options: {}, startedAt: 0 })
    expect(ok).toBe(false)
  })

  it('allows shell when command matches allow prefix', async () => {
    const ok = await policy.authorizer?.({ tool: tool('shell'), name: 'shell', input: { command: 'pytest -q' }, options: {}, startedAt: 0 })
    expect(ok).toBe(true)
  })

  it('truncates oversized output', async () => {
    const result = await policy.truncator?.(
      { ok: true, name: 'read_file', input: {}, output: 'abcdefghij', startedAt: 0, durationMs: 1 },
      { tool: tool('read_file'), name: 'read_file', input: {}, options: {}, startedAt: 0 },
    )
    expect(String(result?.output)).toBe('abcdefgh')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/eval/test/policy.test.ts`
Expected: 模块不存在。

- [ ] **Step 3: 实现**

```ts
const DEFAULT_TOOL_WHITELIST = ['calculator', 'json', 'read_file', 'write_file', 'list_dir', 'glob', 'grep']

export function createEvalToolPolicy(options): ToolPolicy {
  const permissions = options.permissions ?? {}
  const whitelist = permissions.tools ?? DEFAULT_TOOL_WHITELIST
  const shellPolicy = permissions.shell
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024
  return {
    async authorizer(request) {
      if (request.name === 'http_get') return permissions.network === true
      if (request.name === 'shell') {
        if (!shellPolicy?.enabled) return false
        const command = typeof (request.input as { command?: unknown })?.command === 'string'
          ? (request.input as { command: string }).command
          : ''
        const matches = (list: string[] | undefined) => list?.some(
          prefix => command === prefix || command.startsWith(`${prefix} `) || command.startsWith(`${prefix}\n`),
        ) ?? false
        return matches(shellPolicy.allow) && !matches(shellPolicy.deny)
      }
      return whitelist.includes(request.name)
    },
    async truncator(result) {
      if (typeof result.output !== 'string' || result.output.length <= maxOutputBytes) return result
      return { ...result, output: result.output.slice(0, maxOutputBytes), meta: { ...(result as { meta?: object }).meta, truncated: true } }
    },
  }
}
```

注意 `ToolResult` 没有 `meta` 字段，truncator 返回 `{ ...result, output }` 即可；测试中的 `meta` 断言相应调整或省略。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/eval/test/policy.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/eval/src/policy.ts packages/eval/test/policy.test.ts
git commit -m "feat(eval): enforce tool whitelist and shell allowlist"
```

---

### Task 6: coding runtime 组合器

**Files:**
- Create: `packages/eval/src/codingRuntime.ts`
- Test: `packages/eval/test/codingRuntime.test.ts`

**Interfaces:**
- Consumes: `CodingEvalConfig`（Task 2）、`TaskPermissions`、`ToolPolicy`
- Produces:
  - `createCodingEvalRuntime(options: { cwd: string; sessionFile: string; config: CodingEvalConfig; toolPolicy: ToolPolicy }): Promise<CodingEvalRuntime>`
  - `interface CodingEvalRuntime { root: Context; loop: AgentLoop; dispose(): Promise<void> }`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentLoop, LLMAdapter } from '@tnega/agent'
import { readFile } from 'node:fs/promises'

import { createCodingEvalRuntime } from '../src/codingRuntime.js'
import { createEvalToolPolicy } from '../src/policy.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('coding runtime', () => {
  it('runs a coding agent and persists a session trace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-coding-run-'))
    dirs.push(dir)
    const adapter: LLMAdapter = {
      async complete(messages) {
        const last = messages.at(-1)
        return {
          finishReason: 'stop',
          content: `reply to: ${last?.role ?? ''}`,
        }
      },
    }
    const runtime = await createCodingEvalRuntime({
      cwd: dir,
      sessionFile: join(dir, '..', 'trial.jsonl'),
      toolPolicy: createEvalToolPolicy({ workspace: dir }),
      config: {
        llm: adapter,
        agent: { systemPrompt: 'You are a test coding agent.' },
        coding: { skills: false, planTools: false, mcp: false },
      },
    })
    try {
      const loop = runtime.loop
      const result = await loop({ text: 'hello' })
      expect(result.output.length).toBeGreaterThan(0)
      const trace = await readFile(join(dir, '..', 'trial.jsonl'), 'utf8')
      expect(trace).toContain('user/message')
    } finally {
      await runtime.dispose()
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/eval/test/codingRuntime.test.ts`
Expected: 模块不存在。

- [ ] **Step 3: 实现**

```ts
export async function createCodingEvalRuntime(options): Promise<CodingEvalRuntime> {
  const root = new Context()
  await root.plugin(session, { file: options.sessionFile })
  await root.plugin(tools, options.toolPolicy)
  await root.plugin(builtinTools, {
    cwd: options.cwd,
    allowNetwork: false,
    allowShell: false, // shell 注册由 policy 控制时保持关闭；如需 shell 工具存在，由 coding config 决定
    disabled: [],
  })
  await root.plugin(defineAgent({
    name: 'coding-eval',
    system: options.config.agent?.systemPrompt ?? 'You are a coding agent.',
  }), {
    llm: options.config.llm,
    maxTurns: options.config.agent?.maxTurns,
    maxSteps: options.config.agent?.maxSteps,
  })
  await root.plugin(createCodingAgentPlugin({
    cwd: options.cwd,
    skills: options.config.coding?.skills ?? false,
    planTools: options.config.coding?.planTools ?? true,
    mcp: false,
    registerAgent: false,
    planPrompt: options.config.coding?.planPrompt,
  }))
  const loop = root.get('agentLoop') as AgentLoop
  return { root, loop, dispose: () => root.fiber.dispose() }
}
```

注意：shell 工具注册按 `config.coding` 是否允许 shell 决定；本计划统一在 runner 层通过 `builtinTools.allowShell` 开关，Task 5 的 authorizer 只负责拒绝。测试中不启用 shell。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/eval/test/codingRuntime.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/eval/src/codingRuntime.ts packages/eval/test/codingRuntime.test.ts
git commit -m "feat(eval): compose isolated coding runtime"
```

---

### Task 7: runner 多 trial 与 coding 路径

**Files:**
- Modify: `packages/eval/src/runner.ts`
- Test: `packages/eval/test/codingRunner.test.ts`

**Interfaces:**
- Consumes: Task 2-6 的类型与工厂
- Produces：`EvalRunner.run()` 在 `options.coding` 存在时执行 coding 路径

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { Context } from '@tnega/core'
import { agent } from '@tnega/agent'
import { session } from '@tnega/session'
import { tools } from '@tnega/tools'
import type { LLMAdapter } from '@tnega/agent'

import { evalPlugin, EvalService, type EvalRunOptions, type Task } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function setup(outputDir: string): Promise<{ service: EvalService; dispose: () => Promise<void> }> {
  const root = new Context()
  await root.plugin(session, { file: join(outputDir, 'root.jsonl') })
  await root.plugin(tools)
  await root.plugin(agent)
  await root.plugin(evalPlugin, { outputDir })
  return { service: root.get('eval') as EvalService, dispose: () => root.fiber.dispose() }
}

describe('coding eval runner', () => {
  it('runs trials, writes traces and aggregates verdicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-coding-eval-'))
    dirs.push(dir)
    const outputDir = join(dir, 'runs')
    const fixtureDir = join(dir, 'fixture')
    await writeFile(join(fixtureDir, 'task.txt'), 'x', 'utf8')
    const tasks: Task[] = [{
      id: 'write-answer',
      inputText: 'write answer.txt containing ok',
      fixture: { root: fixtureDir },
      check: 'node -e "require(\'fs\').readFileSync(\'answer.txt\',\'utf8\').includes(\'ok\') || process.exit(1)"',
      trials: 2,
      permissions: { shell: { enabled: true, allow: ['node'] } },
    }]
    const llm: LLMAdapter = {
      async complete(messages, toolDefs) {
        const last = messages.at(-1)
        if (last?.role === 'user') {
          const call = toolDefs.find(t => t.schema.name === 'write_file')
          if (call) {
            return {
              finishReason: 'tool_calls',
              toolCalls: [{
                id: 'call-1',
                name: 'write_file',
                arguments: { path: 'answer.txt', content: 'ok' },
              }],
            }
          }
        }
        return { finishReason: 'stop', content: 'done' }
      },
    }
    const ctx = await setup(outputDir)
    try {
      const run = await ctx.service.run({
        candidate: { name: 'coding-test', plugin: () => {} },
        tasks,
        strategyNames: ['check'],
        coding: {
          llm,
          agent: { maxTurns: 2, maxSteps: 4 },
          coding: { skills: false, planTools: false, mcp: false },
        },
      } satisfies EvalRunOptions)
      expect(run.trialSummaries[0]?.passRate).toBe(1)
      expect(run.summary.passed).toBe(1)
      expect(run.verdicts[0]?.score).toBe(1)
    } finally {
      await ctx.dispose()
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/eval/test/codingRunner.test.ts`
Expected: coding 路径不存在，run 缺 trialSummaries。

- [ ] **Step 3: 实现**

`runner.ts` 关键改动：

```ts
private async _runCodingTask(
  runScope: Context,
  task: Task,
  options: EvalRunOptions,
  run: EvalRun,
  controller: AbortController,
  usage: BudgetUsage,
): Promise<Evidence> {
  const coding = options.coding
  if (!coding) throw new Error('coding config required')
  const trials = Math.max(1, task.trials ?? 3)
  const trialEvidence: TrialEvidence[] = []
  for (let trial = 1; trial <= trials; trial += 1) {
    if (controller.signal.aborted) break
    const workspace = await createTaskWorkspace(task, this._fixtureRoot(task))
    const sessionFile = join(this._tracesDir(run.id), `${task.id}-${trial}.jsonl`)
    const toolPolicy = createEvalToolPolicy({
      workspace: workspace.dir,
      permissions: task.permissions,
    })
    let runtime: CodingEvalRuntime | undefined
    const startedAt = Date.now()
    try {
      runtime = await createCodingEvalRuntime({
        cwd: workspace.dir,
        sessionFile,
        toolPolicy,
        config: {
          llm: coding.llm,
          agent: {
            systemPrompt: coding.agent?.systemPrompt,
            maxTurns: task.budget?.maxTurns ?? coding.agent?.maxTurns,
            maxSteps: task.budget?.maxSteps ?? coding.agent?.maxSteps,
          },
          coding: {
            skills: task.permissions?.skills ?? coding.coding?.skills,
            planTools: coding.coding?.planTools,
            mcp: false,
            planPrompt: coding.coding?.planPrompt,
          },
        },
      })
      const agentResult = await runtime.loop({ text: task.inputText, messages: task.messages }, { signal: controller.signal })
      const check = await this._runCheck(task, workspace.dir, agentResult, controller.signal)
      const trace = await deriveTraceMetrics(sessionFile, startedAt, Date.now())
      trialEvidence.push({
        trial,
        verdicts: check ? [{ taskId: task.id, strategy: 'check', status: check.ok ? 'pass' : 'fail', score: check.ok ? 1 : 0, reason: check.reason, output: check.output }] : [],
        trace,
        agentResult,
        artifacts: {},
      })
      usage.turns += agentResult.steps.length
      usage.tokens += this._tokens(agentResult)
      usage.cost += this._cost(agentResult)
    } finally {
      await runtime?.dispose()
      await workspace.dispose()
    }
    usage.timeMs = Date.now() - run.createdAt
  }
  return {
    task,
    messages: [],
    artifacts: {},
    strategyOutputs: {},
    trials: trialEvidence,
  }
}
```

runner 流程调整：

- `run()` 开头：`const coding = options.coding !== undefined`；coding 时不把 `candidate.plugin` 应用到 runScope。
- task 循环中：coding 时调用 `_runCodingTask`，否则走原 `_runTask`。
- coding task 的 `strategyNames` 缺省为 `['check', 'trace']`。
- task 结束后：`trialSummaries.push(aggregateTrial(task, evidence.trials))`；`_summarize` 汇总 verdicts。
- `_cacheKey` 增加 `coding` 配置、`trials`、`fixture`、`permissions`。
- `_createTaskScope` 保持原逻辑（非 coding）。

`_runCheck` 实现：

```ts
private async _runCheck(task, cwd, agentResult, signal) {
  if (typeof task.check === 'function') {
    const ok = await task.check({ task, agentResult, messages: [], artifacts: {}, strategyOutputs: {} }, cwd)
    return { ok, reason: ok ? 'check passed' : 'check failed', output: undefined }
  }
  if (typeof task.check === 'string') {
    const result = await runWorkspaceCommand(cwd, task.check, { signal })
    return {
      ok: result.exitCode === 0,
      reason: result.exitCode === 0 ? 'command passed' : `command exited ${result.exitCode}`,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 4000),
    }
  }
  return undefined
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/eval/test/codingRunner.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/eval/src/runner.ts packages/eval/test/codingRunner.test.ts
git commit -m "feat(eval): run coding tasks with trials and traces"
```

---

### Task 8: check / trace strategy

**Files:**
- Modify: `packages/eval/src/strategies.ts`
- Test: `packages/eval/test/strategies-coding.test.ts`

**Interfaces:**
- Consumes: `Evidence.trials`（Task 2）
- Produces：注册 `checkStrategy(options)`、`traceStrategy(options)`，并加入 `defaultStrategyDefinitions()`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'

import { checkStrategy, traceStrategy } from '../src/strategies.js'
import type { Evidence } from '../src/types.js'

describe('coding strategies', () => {
  const task = { id: 't' }

  it('aggregates per-trial check verdicts into pass rate', async () => {
    const evidence: Evidence = {
      task,
      messages: [],
      artifacts: {},
      strategyOutputs: {},
      trials: [
        { trial: 1, verdicts: [{ taskId: 't', strategy: 'check', status: 'pass', score: 1 }], trace: { file: 'a', startedAt: 0, endedAt: 1, durationMs: 1, metrics: { steps: 1, turns: 1, toolCalls: 1, toolErrors: 0, invalidToolCalls: 0, retries: 0, tokens: 0, cost: 0, recoveredAfterError: false } }, artifacts: {} },
        { trial: 2, verdicts: [{ taskId: 't', strategy: 'check', status: 'fail', score: 0 }], trace: { file: 'b', startedAt: 0, endedAt: 1, durationMs: 1, metrics: { steps: 1, turns: 1, toolCalls: 1, toolErrors: 0, invalidToolCalls: 0, retries: 0, tokens: 0, cost: 0, recoveredAfterError: false } }, artifacts: {} },
      ],
    }
    const verdict = await checkStrategy().evaluate({ ctx: {} as never, run: {} as never }, task, evidence)
    expect(verdict.score).toBe(0.5)
    expect(verdict.status).toBe('fail')
  })

  it('scores trace metrics', async () => {
    const evidence: Evidence = {
      task,
      messages: [],
      artifacts: {},
      strategyOutputs: {},
      trials: [{
        trial: 1,
        verdicts: [],
        trace: { file: 'a', startedAt: 0, endedAt: 1, durationMs: 1, metrics: { steps: 2, turns: 1, toolCalls: 2, toolErrors: 1, invalidToolCalls: 1, retries: 0, tokens: 0, cost: 0, recoveredAfterError: true } },
        artifacts: {},
      }],
    }
    const verdict = await traceStrategy().evaluate({ ctx: {} as never, run: {} as never }, task, evidence)
    expect(verdict.score).toBeGreaterThan(0)
    expect(verdict.score).toBeLessThan(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/eval/test/strategies-coding.test.ts`
Expected: `checkStrategy` / `traceStrategy` 不存在。

- [ ] **Step 3: 实现**

`checkStrategy`：无 `evidence.trials` 时回退到现有 `assert` 判定；有 trials 时 `passed/trials` 作为 score，status 为 `passRate >= (options.passRate ?? 1) ? 'pass' : 'fail'`。

`traceStrategy`：

```ts
export interface TraceStrategyOptions {
  passThreshold?: number
  weights?: { toolErrors?: number; invalidToolCalls?: number; retries?: number }
}

function scoreTrial(trace: TrialTrace): number {
  const m = trace.metrics
  if (m.toolCalls === 0 && m.steps === 0) return 0
  const calls = Math.max(1, m.toolCalls)
  const penalty = (m.invalidToolCalls / calls) * 0.5 + (m.toolErrors / calls) * 0.3 + Math.min(1, m.retries / Math.max(1, m.steps)) * 0.2
  return Math.max(0, 1 - penalty)
}
```

score = trials 均值，status 用 `passThreshold ?? 0.7`。`defaultStrategyDefinitions()` 加入两者。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/eval/test/strategies-coding.test.ts`

- [ ] **Step 5: 提交**

```bash
git add packages/eval/src/strategies.ts packages/eval/test/strategies-coding.test.ts
git commit -m "feat(eval): add check and trace scoring strategies"
```

---

### Task 9: CLI tasks.yml 扩展与 coding candidate

**Files:**
- Modify: `packages/cli/src/commands.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/tasks-file.test.ts`

**Interfaces:**
- Consumes: `createCodingCandidatePlugin` 相关类型（实际 eval runner 使用 `EvalRunOptions.coding`）
- Produces：
  - `RunCommandOptions.model/baseUrl/maxTokens/temperature/maxTurns/maxSteps/timeoutMs/maxRetries/retryDelayMs`
  - `tasks.yml` task 支持新字段；candidate 支持 `coding: true` 与 `model/baseUrl`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadTasksFile } from '../src/commands.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('tasks file coding fields', () => {
  it('parses fixture, check, trials, permissions and split', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tnega-tasks-'))
    dirs.push(dir)
    const file = join(dir, 'tasks.yml')
    await writeFile(file, [
      'tasks:',
      '  - id: py-fib',
      '    inputText: implement fib',
      '    fixture:',
      '      root: fixtures/py-math',
      '    check: python -m unittest discover',
      '    trials: 2',
      '    split: val',
      '    permissions:',
      '      shell:',
      '        enabled: true',
      '        allow: [python]',
      'candidates:',
      '  deepseek:',
      '    coding: true',
      '    model: deepseek-v4-flash',
      'defaultCandidate: deepseek',
    ].join('\n'), 'utf8')
    const parsed = loadTasksFile(file)
    expect(parsed.tasks[0]?.trials).toBe(2)
    expect(parsed.tasks[0]?.split).toBe('val')
    expect(parsed.tasks[0]?.permissions?.shell?.allow).toEqual(['python'])
    expect(parsed.tasks[0]?.fixture?.root).toBe(join(dir, 'fixtures', 'py-math'))
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/cli/test/tasks-file.test.ts`
Expected: 新字段未解析。

- [ ] **Step 3: 实现**

`toTask` 增加字段解析；`fixture.root` 相对 tasks 文件目录 `resolve(dirname(file), root)`（`loadTasksFile` 把 `file` 传给 `toTask`）。

`runCommand`：

```ts
const candidateEntry = candidates[candidateName]
const runOptions: EvalRunOptions = { candidate, tasks, cache, strategyNames }
if (isCodingCandidate(candidateEntry)) {
  const apiKey = ... // 与 runAgentCommand 相同的 env/system config 解析
  const adapter = createLlmAdapter({ apiKey, model, baseUrl, ... })
  runOptions.coding = {
    llm: adapter,
    agent: { maxTurns, maxSteps },
    coding: { skills: true, planTools: true, mcp: false },
  }
  if (!runOptions.strategyNames) runOptions.strategyNames = ['check', 'trace']
}
```

`packages/cli/src/index.ts` 的 `run` 参数解析增加 `--model/--base-url/--max-turns/--max-steps` 并透传。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run packages/cli/test/tasks-file.test.ts && pnpm typecheck`

- [ ] **Step 5: 提交**

```bash
git add packages/cli/src/commands.ts packages/cli/src/index.ts packages/cli/test/tasks-file.test.ts
git commit -m "feat(cli): support coding eval tasks and candidates"
```

---

### Task 10: 内置冒烟任务与端到端验证

**Files:**
- Create: `examples/eval/tasks.yml`
- Create: `examples/eval/fixtures/py-math/math.py`
- Create: `examples/eval/fixtures/py-math/test_math.py`
- Create: `examples/eval/fixtures/write-only/.keep`

- [ ] **Step 1: 写冒烟任务**

`examples/eval/tasks.yml`：

```yaml
outputDir: .tnega/runs
candidates:
  deepseek:
    coding: true
    model: deepseek-v4-flash
defaultCandidate: deepseek
tasks:
  - id: py-fib
    name: implement fibonacci
    inputText: |
      实现 math.py 中的 fib(n)（n>=0，返回第 n 个斐波那契数），
      并通过全部单元测试。不要修改 test_math.py。
    fixture:
      root: fixtures/py-math
    check: python -m unittest discover -s . -p "test_*.py" -v
    trials: 3
    split: val
    permissions:
      shell:
        enabled: true
        allow: [python]
  - id: write-answer
    name: write a file
    inputText: |
      在 workspace 中创建 answer.txt，内容只包含一行：ok
    check: python -c "assert open('answer.txt', encoding='utf-8').read().strip() == 'ok'"
    trials: 3
    split: val
    permissions:
      shell:
        enabled: true
        allow: [python]
```

`fixtures/py-math/math.py`：

```python
def fib(n: int) -> int:
    raise NotImplementedError
```

`fixtures/py-math/test_math.py`：

```python
import unittest

from math import fib


class FibTest(unittest.TestCase):
    def test_small(self):
        self.assertEqual(fib(0), 0)
        self.assertEqual(fib(1), 1)
        self.assertEqual(fib(5), 5)
        self.assertEqual(fib(10), 55)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 本地不联网验证 fixture**

Run: `python -m unittest discover -s examples/eval/fixtures/py-math -p "test_*.py"`
Expected: FAIL（`NotImplementedError`），证明 check 可判定失败。

- [ ] **Step 3: 跑全量校验**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

- [ ] **Step 4: 提交**

```bash
git add examples/eval
git commit -m "feat(examples): add coding eval smoke tasks"
```

---

## Self-Review

- Spec 4 节 Task schema：Task 2、Task 9。
- Spec 5 节权限：Task 5、Task 6、Task 7。
- Spec 6 节 coding runtime：Task 1、Task 6。
- Spec 7 节 trace：Task 4、Task 7。
- Spec 8 节评分：Task 8。
- Spec 9 节多 trial 聚合：Task 7。
- Spec 13 节 CLI：Task 9。
- Spec 14.1 内置冒烟：Task 10。
- M2/M3/M4 不在本计划内，由后续计划承接。
