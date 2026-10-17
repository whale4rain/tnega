# packages/cli 拆分计划

目标：把 `packages/cli` 从 50 个文件、约 11.8k 行，收敛成只负责「命令行入口 + 宿主装配」的约 600 行；
其余能力按依赖方向下沉为独立包，Project 家族补全到 `packages/project/*`。

## 现状

`packages/cli/src` 的内部依赖图是两层：

- **叶子**（无本地依赖）：`goal` `work` `web-search` `terminals` `folder-picker` `yaml` `help`
  `project-routines` `project-git` `project-pr-state` `project-activity` `session-title`
  `compaction-*` `ptc-observation` `runtime-files`
- **枢纽**：`server.ts`（2661 行，import 33 个本地模块）、`project-host.ts`（916 行，import 13 个）、
  `commands.ts`（373 行，被 `profile` / `profile-file` 反向 import）

必须先解开的三个结（Phase 0）：

| # | 结 | 现状 | 解法 |
|---|---|---|---|
| 1 | `commands` ↔ `profile` / `profile-file` | 只为 `AgentRuntimeOptions` 类型互相 import | 类型下沉到 `@tnega/runtime` |
| 2 | `home-paths` → `@tnega/coding-agent` | 底层路径工具反向依赖 Agent 包（`resolveTnegaHome`） | 下沉到 `@tnega/home`，coding-agent 改为依赖它 |
| 3 | `project-artifacts` → `project-host` | 不是环，是单向依赖 `ProjectHost` 类 | 保持同阶段拆：`@tnega/project/http` 依赖 `@tnega/project-host` |

## 目标包

`@tnega/cli` 最终只剩：`bin.ts` `entry.ts` `help.ts` `index.ts`（argv）`tui-command.ts`
`runAgentCommand`（约 60 行）与兼容 re-export。

| 阶段 | 包 | 目录 | 迁出文件 | 行数 |
|---|---|---|---|---|
| 1 | `@tnega/goal` | `packages/goal` | `goal.ts` | 123 |
| 1 | `@tnega/persona` | `packages/persona` | `work.ts` | 28 |
| 1 | `@tnega/workspace-prompt` | `packages/workspace-prompt` | `workspace-prompt.ts` | 68 |
| 1 | `@tnega/tool-web-search` | `packages/web/tool-web-search` | `web-search.ts` | 68 |
| 1 | `@tnega/terminal` | `packages/terminal` | `terminals.ts` | 166 |
| 1 | `@tnega/directory-picker` | `packages/directory-picker` | `folder-picker.ts` | 118 |
| 1 | `@tnega/compaction` | `packages/compaction` | `auto-compaction.ts` `compaction-prompt.ts` `compaction-observation.ts` `session-title.ts` | 257 |
| 1 | `@tnega/workspace-files` | `packages/workspace-files` | `files.ts` `workspace-files.ts` `file-search.ts` `file-edits.ts` `changes.ts` `runtime-files.ts` | 665 |
| 2 | `@tnega/home` | `packages/home` | `home-paths.ts` `state-storage.ts` + `resolveTnegaHome` | 152 |
| 2 | `@tnega/config` | `packages/config` | `config.ts` `yaml.ts` `model-discovery.ts` | 985 |
| 2 | `@tnega/auth-chatgpt` | `packages/auth-chatgpt` | `chatgpt-auth.ts` | 307 |
| 2 | `@tnega/session-store` | `packages/session-store` | `store.ts` | 768 |
| 2 | `@tnega/usage` | `packages/usage` | `usage.ts` `usage-store.ts` | 417 |
| 3 | `@tnega/runtime` | `packages/runtime` | `compose.ts` + `createAgentRuntime` + runtime 类型 | ~560 |
| 3 | `@tnega/profile` | `packages/profile` | `profile.ts` `profile-file.ts` | 285 |
| 3 | `@tnega/plugin-host` | `packages/plugin-host` | `plugin-hmr.ts` `plugin-dev.ts` | 460 |
| 3 | `@tnega/approval-host` | `packages/approval-host` | `approval.ts` `permissions.ts` `thread-approval.ts` | 479 |
| 4 | `@tnega/project-worktrees` | `packages/project/worktrees` | `project-worktrees.ts` `project-git.ts` `project-pr-state.ts` | 471 |
| 4 | `@tnega/project-routines` | `packages/project/routines` | `project-routines.ts` | 346 |
| 4 | `@tnega/project-memory` | `packages/project/memory` | `project-memory.ts` | 283 |
| 4 | `@tnega/project-host` | `packages/project/host` | `project-host.ts` `project-activity.ts` `project-tool-scope.ts` | 1064 |
| 4 | `@tnega/project-http` | `packages/project/http` | `project-routes.ts` `project-artifacts.ts` | 443 |
| 5 | `@tnega/host` | `packages/host` | `server.ts` 拆成模块 | 2661 |

### 不拆的部分

- `project-host` + `project-activity` + `project-tool-scope` 同包：共享 `roles` / `permissions` 两张内存表。
- `server.ts` 先拆成 `@tnega/host` 内的模块，不拆成八个微包。
- `approval.ts` / `permissions.ts` / `thread-approval.ts` 同包：审批策略与 broker 是一体。

## 阶段

### Phase 0 · 脚手架（主 agent，串行）

1. 建 23 个空包（`package.json` + `src/index.ts`），接入 `pnpm-workspace.yaml`（新增 `packages/web/*`）。
2. `packages/cli/package.json` 一次性声明全部新依赖（避免并行时争抢同一个文件）。
3. `scripts/build.mjs`：给分组包补 `packageDirs`（`web/tool-web-search`、`project/{host,http,worktrees,routines,memory}`）。
4. 解三个结（见上表）。

验收：`pnpm install`、`pnpm typecheck`、`pnpm build`。

### Phase 1 · 叶子包（8 个子 agent 并行）

每个 agent 的边界固定为三处，互不重叠：

1. 把源文件移进自己的新包，改成包内相对 import；
2. 把 `packages/cli/src/<file>.ts` 改成 `export * from '@tnega/<pkg>'` 的 shim；
3. 把自己的测试移到新包 `test/`，改 import。

禁止改：根 `package.json`、`scripts/build.mjs`、`pnpm-workspace.yaml`、其他包。

验收：`pnpm test -- packages/<pkg>` + 主线 `pnpm typecheck`。

### Phase 2 · 数据层（顺序：home → config/auth → session-store → usage）

`home` 必须先，其余三包可并行；`usage` 依赖 `config` 与 `session-store`。

### Phase 3 · 组合层

`runtime` 单做（依赖所有能力包）；随后 `profile`、`plugin-host`、`approval-host` 可并行。
拆 `approval-host` 时修一个缝的违例：`permissions.ts` 不应 import `@tnega/tool-browser` 的常量，
「哪些浏览器工具只读」应属于 browser seam。

### Phase 4 · Project 家族（补全 `packages/project/*`）

顺序：`worktrees`（含 git/pr-state）→ `routines` → `memory` → `host` → `http`。

### Phase 5 · Host

`server.ts` 拆成：`http/router.ts`（method + pattern → handler）、`http/sse.ts`、`http/static.ts`、
`http/json.ts`、`routes/{sessions,files,config,plugins,projects,browser,terminals}.ts`、
`resident.ts`、`server.ts`（只剩 `startWebServer` 与 `ServerContext`）。

### Phase 6 · 收尾

删除全部 shim、改 import、更新根 `exports` 与 `scripts/build.mjs` 的 `libraryEntries`、
更新 `AGENTS.md` 代码布局与本 README。`./cli/runtime` 保留一个版本，指向 `@tnega/runtime`。

## 并行安全：shim 策略

迁移期 `packages/cli/src/<file>.ts` 一律保留为 re-export shim，因此：

- `server.ts` / `project-host.ts` 在 Phase 5 之前**一行都不用改**；
- 每个子 agent 只碰自己的新包、自己那一行 shim、自己的测试；
- 共享文件（根 `package.json`、`build.mjs`、workspace 配置）只在 Phase 0 与 Phase 6 由主线修改。

## 验收命令

| 范围 | 命令 |
|---|---|
| 单包 | `pnpm test -- packages/<pkg>` |
| 跨包类型 | `pnpm typecheck` |
| 代码风格 | `pnpm lint` |
| 发布入口 / 打包 | `pnpm build`，必要时 `pnpm test:package` |
| 全量 | `pnpm test`（注意 `tools-e2e` 会受本机 `codeMode` 配置影响） |

## 风险

1. `server.ts` 是枢纽，shim 在 Phase 5 前不能删。
2. 测试搬迁是主要 churn：`approval-api` / `web` / `project-*` 等同时 import `server` 与 `store` 的测试跟随宿主包走。
3. 公开导出兼容：桌面端依赖 `startWebServer` / `defaultHotProfile` / `WebServer`，根 `exports` 的
   `./cli/runtime` 继续可用一个版本。
4. `permissions.ts` 对 `tool-browser` 的依赖、`home-paths` 对 `coding-agent` 的反向依赖，是拆包时顺手要修的层次问题。

## 进度

已完成 Phase 0–4、6：

- Phase 0 `c5663c1`：23 个目标包脚手架，`@tnega/runtime` 与 `@tnega/home` 先解开两个类型环。
- Phase 1–2 `ecb8143`、`a8a5ed3`、`a69430c`、`f013a5a`：叶子包与数据层（goal、terminal、tool-web-search、directory-picker、home、compaction、persona、workspace-prompt、workspace-files、config、auth-chatgpt、session-store、usage、profile、plugin-host、approval-host）。
- Phase 3 `1f1f56f`：`@tnega/runtime` 接管 compose 与 `createAgentRuntime`。
- Phase 4 `33f0332`：Project 家族（host、http、routines、memory、worktrees）。
- Phase 5 的机械部分 `20e32e4`：`server.ts` 与 `ptc-observation` 移入 `@tnega/host`。
- Phase 6 `01dd3da`：删除全部 shim，`packages/cli` 只剩 6 个文件、711 行，依赖 79 → 13。

待办：

- Phase 5 的结构部分已完成：`server.ts` 从 2,547 行降到 193 行，只保留 Host 生命周期
  （`startWebServer`、`handleRequest`、关闭流程）。其余按职责拆成
  `http.ts`（传输，`c4bce20`）、`support.ts`（会话/路由小工具，`f231e61`）、
  `context.ts` + `runs.ts`（Host 上下文与两条 run 管线，`facec3a`）、
  `routes.ts`（路由面：`handleApi`、浏览器与终端端点、配置快照、压缩端点，`fbcd1d5`）。
- 路由表（按 dsh 的 `WebServer` 形状）已落地：`web-server.ts` 提供 exact / prefix /
  upgrade 三类具名路由与唯一 fallback 席位，匹配顺序固定为「精确 → 最长前缀 → 回退」，
  重复路径与第二个 fallback 都直接抛错，注册返回 disposer；`handleRequest` 改走该表
  （`47aea53`）。`/api` 的传输策略（`x-tnega-client`、JSON content-type）提升为分发边界检查，
  `GET /api/health`、`GET /api/plugins`、`POST /api/plugins/reload`、
  `POST /api/folder-picker` 已迁为表项作为样板。剩余工作：把 `handleApi` 其余域按同样形状
  逐步注册（sessions/runs、files、config、browser、terminals、projects），每迁一域删除对应 if 块。
- Phase 6 的发布收尾：根 `package.json` 的 `exports` 与 `scripts/build.mjs` 的 `libraryEntries`
  是否需要为新的宿主/运行时包增加子路径（当前它们只被打进 `dist/bin.js` 与 `dist/cli-runtime.js`）。

