# Changelog

User-visible changes reconstructed from Git tags and commit history. Dates are
the tag commits' recorded dates. Version sections describe what shipped at that
point; historical capabilities may have since been removed. There are no Git
tags for 0.2.0, 0.4.3 or 0.4.4. Their development changes are included in the
next actual tag's range; missing tags alone do not prove no package was published.

## Audited history boundaries

Each release covers all commits reachable from its tag but not the preceding
actual tag, including merged branches. Entries summarize user-visible changes
and compatibility, rather than repeat every commit. Update Unreleased as each
feature or fix lands, and move entries into a version only when it ships.

| Version | Audited range | Commits |
| --- | --- | ---: |
| 0.4.24 | [`v0.4.23...v0.4.24`](https://github.com/whale4rain/tnega/compare/v0.4.23...v0.4.24) | 10 |
| 0.4.23 | [`v0.4.22...v0.4.23`](https://github.com/whale4rain/tnega/compare/v0.4.22...v0.4.23) | 7 |
| 0.4.22 | [`v0.4.21...v0.4.22`](https://github.com/whale4rain/tnega/compare/v0.4.21...v0.4.22) | 9 |
| 0.4.21 | [`v0.4.20...v0.4.21`](https://github.com/whale4rain/tnega/compare/v0.4.20...v0.4.21) | 10 |
| 0.4.20 | [`v0.4.19...v0.4.20`](https://github.com/whale4rain/tnega/compare/v0.4.19...v0.4.20) | 2 |
| 0.4.19 | [`v0.4.19-beta.2...v0.4.19`](https://github.com/whale4rain/tnega/compare/v0.4.19-beta.2...v0.4.19) | 10 |
| 0.4.19-beta.2 | [`v0.4.19-beta.1...v0.4.19-beta.2`](https://github.com/whale4rain/tnega/compare/v0.4.19-beta.1...v0.4.19-beta.2) | 5 |
| 0.4.19-beta.1 | [`v0.4.18...v0.4.19-beta.1`](https://github.com/whale4rain/tnega/compare/v0.4.18...v0.4.19-beta.1) | 8 |
| 0.4.18 | [`v0.4.17...v0.4.18`](https://github.com/whale4rain/tnega/compare/v0.4.17...v0.4.18) | 9 |
| 0.4.17 | [`v0.4.16...v0.4.17`](https://github.com/whale4rain/tnega/compare/v0.4.16...v0.4.17) | 2 |
| 0.4.16 | [`v0.4.15...v0.4.16`](https://github.com/whale4rain/tnega/compare/v0.4.15...v0.4.16) | 10 |
| 0.4.15 | [`v0.4.14...v0.4.15`](https://github.com/whale4rain/tnega/compare/v0.4.14...v0.4.15) | 18 |
| 0.4.14 | [`v0.4.13...v0.4.14`](https://github.com/whale4rain/tnega/compare/v0.4.13...v0.4.14) | 22 |
| 0.4.13 | [`v0.4.12...v0.4.13`](https://github.com/whale4rain/tnega/compare/v0.4.12...v0.4.13) | 8 |
| 0.4.12 | [`v0.4.11...v0.4.12`](https://github.com/whale4rain/tnega/compare/v0.4.11...v0.4.12) | 35 |
| 0.4.11 | [`v0.4.10...v0.4.11`](https://github.com/whale4rain/tnega/compare/v0.4.10...v0.4.11) | 5 |
| 0.4.10 | [`v0.4.9...v0.4.10`](https://github.com/whale4rain/tnega/compare/v0.4.9...v0.4.10) | 9 |
| 0.4.9 | [`v0.4.8...v0.4.9`](https://github.com/whale4rain/tnega/compare/v0.4.8...v0.4.9) | 7 |
| 0.1.1 | Repository start through `v0.1.1` | 93 |
| 0.3.0 | [`v0.1.1...v0.3.0`](https://github.com/whale4rain/tnega/compare/v0.1.1...v0.3.0) | 159 |
| 0.4.0 | [`v0.3.0...v0.4.0`](https://github.com/whale4rain/tnega/compare/v0.3.0...v0.4.0) | 55 |
| 0.4.1 | [`v0.4.0...v0.4.1`](https://github.com/whale4rain/tnega/compare/v0.4.0...v0.4.1) | 4 |
| 0.4.2 | [`v0.4.1...v0.4.2`](https://github.com/whale4rain/tnega/compare/v0.4.1...v0.4.2) | 53 |
| 0.4.5 | [`v0.4.2...v0.4.5`](https://github.com/whale4rain/tnega/compare/v0.4.2...v0.4.5) | 157 |
| 0.4.6 | [`v0.4.5...v0.4.6`](https://github.com/whale4rain/tnega/compare/v0.4.5...v0.4.6) | 56 |
| 0.4.7 | [`v0.4.6...v0.4.7`](https://github.com/whale4rain/tnega/compare/v0.4.6...v0.4.7) | 10 |
| 0.4.8 | [`v0.4.7...v0.4.8`](https://github.com/whale4rain/tnega/compare/v0.4.7...v0.4.8) | 6 |

Use `git log <previous-actual-tag>..<release-tag>` for the full changelog audit;
compare links provide a convenient browser view of the boundaries.

## Unreleased

### Features

- The interface now uses Nunito, a rounded, open typeface bundled with the app so every system renders it the same; the type ramp sits half a step larger to match.
- The left sidebar is wider, with taller rows, 16px icons and conversation-sized titles, so projects and sessions are easier to scan.
- The Workbench opens about as wide as the conversation (default `clamp(420px, 40vw, 760px)`, minimum 420px) and shares its background. Project panels (Thread, Agent messages, Board, Library, Routines, settings) run edge to edge instead of sitting in a second framed card, with clearer headings, the conversation's own text size and a project title on the Board.
- Opening a Project artifact shows it as a page on a near full-window sheet beside its Thread: one header with type, size, version and author, quote and download actions, and no repeated outputs strip.
- What the coordinator sends a thread now appears in that thread's chat as a dashed bubble on the user side, labelled with the sender; it replaces the folded brief when it carries it.
- A session whose run was cut off by a crash or restart picks up where it stopped when you open it, as long as no interrupted tool call may already have taken effect. Otherwise a notice names the uncertain tools and offers Resume; the agent then checks their results before repeating anything.
- Project threads a crash cut off no longer stay "working" forever after a restart. A thread that can safely continue picks its run up again and reports to its parent as usual. One with a tool call that may already have taken effect turns blocked, and its parent is told once.
- Only one process writes a session at a time. A second process (say the CLI while the desktop app is running the same session) gets a clear error instead of interleaving writes, and it no longer "repairs" the other process's live turn. The lock (`<session>.jsonl.lock`) is refreshed while held. If its process has exited, or it hasn't been refreshed for 30 seconds, the next writer takes it over.

### Fixes

- Reopening a crashed session no longer rewrites the whole log: repair cuts only a torn tail and appends the closing events, so a second crash during repair cannot empty the session. A log damaged in the middle keeps a `.corrupt-<time>` copy beside it, and `flush()` now syncs the file to disk.
- After a crash, the model is told whether an interrupted tool call never started (safe to call again) or may already have taken effect. Built-in read-only tools (file reads, listings, `glob`, `grep`, `http_get`, browser observation) are marked safe to repeat; `write_file`, `shell` and browser actions ask the model to check the current state first.

## [0.4.25-beta.1](https://github.com/whale4rain/tnega/releases/tag/v0.4.25-beta.1) — 2026-10-09

### Other

- 将 Project 协作升级的预览版本目标纠正为 0.4.25；包含 0.4.24-beta.1 的全部功能与下列修复。

### Fixes

- Windows Thread 恢复使用文件系统实际路径识别已有 worktree，兼容短路径、大小写和 Git 路径输出，避免误判后重复创建目录。
- 记忆抽取的不修改 Session 测试先等待已有事件落盘，避免把异步缓冲写入误判为抽取修改。

## [0.4.24-beta.1](https://github.com/whale4rain/tnega/releases/tag/v0.4.24-beta.1) — 2026-10-09

### Features

- Project artifact 恢复弹窗预览，右侧常驻生成 Thread 会话，支持选文引用后继续修改；一个 Thread 可管理多个产物。修订保留稳定身份与历史内容，并校验生成者和版本。Coordinator 消息完整显示，所有 Agent 默认简短交流。

- Git Project 的 Thread 使用独立 worktree 和分支并行写入，文件、搜索和嵌套工具沿用各自目录；代码经 `deliver_thread` 创建或更新同一个 PR，未交付改动或远程失败会保持阻塞。Coordinator 只协调，重叠改动由执行 Thread 处理。

- Project 支持完成工作后的异步记忆整理：复用原请求前缀，延迟抽取使用可配置模型；所有 Project 共用调用次数与 token 预留额度，自动记忆标记为待核实候选，保留来源且不覆盖用户修订。

## [0.4.24](https://github.com/whale4rain/tnega/releases/tag/v0.4.24) — 2026-10-09

### Fixes

- Project 产物在工作台文档标签中预览，Library 可跳转到来源消息；Memory 编辑使用打开时的版本校验，并发冲突时保留草稿，避免覆盖他人的更新。

- Project 暂停会持久保存并停止派工与定时任务，明确恢复后继续队列；重连同步完整快照与实际运行状态，避免遗漏事实更新或残留运行标记。

- Thread 的并发状态与清单更新按身份串行处理，避免审批等待与 Run 状态竞争导致误拒绝；恢复失败回报不再覆盖用户后来 Resolve / Reopen 的决定。

- Thread 依据持久化的 Agent Run 结束事件回报执行失败，重启可补发，用户取消不会误报失败；协调者只有在全部请求成功处理后才隐藏收尾叙述，失败审批后的求助会保留。

- Blackboard 损坏尾行不再吞掉恢复后的新提交，批量提交按完整事务恢复并同步落盘。新版本兼容读取旧日志；写入新事务格式后不支持直接降级或与旧版混写。

- Project 并发首次打开共用同一运行作用域；挂载失败会清理部分资源，关闭变化流会解除 Session 监听，避免重复调度和重连后的资源泄漏。

- Project 协调者改为明确的协调工具白名单：调查、执行和产物制作只交给 Thread，直接调用与 Code Mode 嵌套调用使用同一职责边界。

## [0.4.23](https://github.com/whale4rain/tnega/releases/tag/v0.4.23) — 2026-10-09

### Features

- Project 改为任务驱动的主对话：你的消息仍是靠右的气泡，协调者的回复改为铺满对话列的正文，不再有头像和气泡；Project 里各处（房间、Thread、Board、欢迎页）都不再画 Agent 头像。
- 协调者交出去的每个 Thread 在主对话里是一张链接卡（状态灯 · 标题 · 状态），点开在工作台打开 Thread；协调者在正文里提到 Thread 时写成可点击的 Thread 链接。Thread 与协调者的往来改从 Thread 工具栏的「Messages with Coordinator」查看。
- 状态灯：Thread 等你或被阻塞时亮琥珀灯、失败亮红灯、工作中是缓慢明灭的强调色灯；侧栏的项目行也会亮灯，不用打开项目就知道哪里在等你。`GET /api/projects` 的每项新增 `threads: { waiting, failed, working }` 摘要（向后兼容：旧前端忽略它，新前端在旧服务器上不显示灯）。

- Thread 推送代码或开 PR 后，主对话、Thread 产物区和 Library 里会出现一张卡片：推了哪个分支 / 第几号 PR、仓库、状态（Pushed / Opened / Up to date / Rejected / Failed），点「Open」在浏览器里打开 PR 或建 PR 的页面。同一分支再推送会更新同一张卡。

### Fixes

- 工作台里的 Thread 对话与 Agent 通信改用和主对话相同的底色（深色下更暗），不再像一张浅色文档卡片。
- 桌面端顶部一行对齐：侧栏、会话顶栏与工作台标签都落在标题栏那一行的中线上，与原生窗口按钮齐平；工作台标签放不下时不再出现 Windows 原生横向滚动条（滚轮 / 触控板仍可横向滚动，选中的标签自动滚入视野）。
- Project 与 Thread 的输入框在内容为空、也没有运行中的工作时显示（禁用的）发送按钮，不再显示一个用不了的停止按钮；只有确实在运行时才显示停止。

## [0.4.22](https://github.com/whale4rain/tnega/releases/tag/v0.4.22) — 2026-10-09

### Features

- 设置 → Appearance 新增调色板：除默认的 Sky 外，还有 Sand（暖纸墨、赤陶强调色）、Forest（绿灰、深青）与 Graphite（纯中性灰、对比最强），每个都有浅色与深色两份，并通过同一套对比度底线。左上角的云标志随调色板的强调色变化；天气状态色不随调色板改变。
- 新增信息显示选项：密度（Compact / Comfortable）、字号（Small / Default / Large）与对话宽度（Narrow / Standard / Wide / Full width）。即时生效，按设备记住，页面首帧前就会套用，不会闪烁。

### Fixes

- 自动审批（LLM 审查）在 DeepSeek 官方 API 上不再生成隐藏推理：项目 Thread 里每次 shell 调用都要等这次审查，实测中位耗时由约 1.8 秒降到约 1.0 秒，也不再出现约 1/10 的审查推理写满 4096 token、约 20 秒后判为无效并转交协调者的情况。其他模型路由不变。

### Other

- README 重写为项目介绍：先讲 Tnega 是什么、为什么用、能做什么和快速开始；会话、权限、数据位置、内置技能与更新等细节移到新的 [使用指南](docs/guide/README.md)。

## [0.4.21](https://github.com/whale4rain/tnega/releases/tag/v0.4.21) — 2026-10-08

### Features

- 界面整体改为紧凑密度：控件、列表行与工具行变矮（行高 26px、工具行 22px），会话标题与工作区合为一行、顶栏与桌面标题栏同高（32px），圆角变小，侧栏变窄；图标统一为 14 / 12px 细线，工具行去掉底色方块；工作台的工具标签只在选中时显示名称。配色、天气状态与对比度不变。
- 侧栏改为按工作区组织：每个工作区是一个可折叠的分组，先列项目、再按最近时间列会话（默认 8 条，其余与已归档项目收在“N more”里）；取消顶部的工作区切换卡片与 Sessions / Projects 切换。点开其他工作区的会话或项目会直接切换到该工作区；悬停工作区行可新建项目或会话，“Add workspace”移到侧栏底部。折叠状态会被记住。
- 项目里的 Agent 按角色只拿到需要的工具：协调者只负责派工与读写项目知识（不再有 shell、写文件、后台任务等，直接调用会被拒绝并提示派给 Thread），Thread 不再看到定时任务工具，到达深度上限的 Thread 不再看到 `spawn_thread`；项目里也不再挂 `echo` / `calculator` / `json`。每次请求的工具定义更少、前缀更稳定，便于缓存。
- 项目协作更省：协调者派工后用一句话结束，不再在本轮里轮询等待 Thread、也不再复查 Thread 已验证的文件；Thread 默认自己完成工作，只为大块且独立的分支开子 Thread。Thread 的长报告进入协调者上下文时只保留结论部分（约 1200 字符），完整内容仍在 Thread 里，可用 `list_threads` 的 `thread_id` 取回。`spawn_thread` 新增 `on_report`：协调者确有下一步要依赖结果时写明，报告到达时才会唤醒它。用 DeepSeek 实测同一任务：总提示 token 由约 235k 降到约 89k，耗时由约 150 秒降到约 43 秒。
- Project 屏幕更紧凑（紧凑重设计第 3 阶段）：Board 顶部改为一行 Today（started / finished / outputs / tokens），泳道收为 Needs you / Working / Ready 并带状态点，Idle 与 Resolved 折叠为泳道下方的一行；卡片更矮、进展只占一行、进度条 3px。房间里的 Thread 卡片改为一行并带头像。没有清单的 Thread 在卡片和 Board 上显示它正在做的步骤（如 “Editing count.mjs”），来自新的 `activity` 实时事件。协调者的长消息在房间里默认折叠，可展开。

### Fixes

- 侧栏底部 “Add workspace” 改为图标按钮，窄侧栏里不再压住主题切换。
- 发给用户的项目气泡（`send_project_message`）限制在 600 字符内，超出时提示改用 `publish_artifact`，避免房间被长报告占满。
- 自动审批在思考型模型（如 DeepSeek）上不再总是失败：审批请求的输出上限从 512 提高到 4096 token，并能读出被代码块或说明文字包住的 JSON 决定。此前每次越权调用都会转给父 Agent 或用户决定。
- 主对话更安静：协调者代 Thread 处理审批或给正在工作的 Thread 补充指示时，不再在主对话里发一条旁白或一张新的派工卡片；这些内容留在 Thread 与执行详情里。需要用户决定的问题照常出现。

## [0.4.20](https://github.com/whale4rain/tnega/releases/tag/v0.4.20) — 2026-10-08

### Fixes

- ChatGPT 登录模型不再携带全局 temperature；未设置思考强度时也可正常发送，避免 `Unsupported parameter: temperature` 导致 HTTP 400。已有配置和会话无需迁移。

### Other

- 按用户要求仅做相关回归验证，不跑全量测试；发布流程保留类型、风格、构建与产物完整性检查。

## [0.4.19](https://github.com/whale4rain/tnega/releases/tag/v0.4.19) — 2026-10-08

### Features

- Open compact Agent-message receipts as pair conversations in the Workbench;
  follow nested exchanges, restored history and clickable file or website links.
  Coordinators and Threads are guided to send short messages on one topic.
- Discover models from a saved provider or third-party connection, or the current
  ChatGPT login, with real authenticated catalogs and paginated Anthropic results.
  Add discovered models by copying the connection on the server without exposing
  credentials to the browser; existing routes keep working without migration.
  Inherited endpoints follow the active runtime configuration and are pinned when
  copying a route, keeping each connection's key attached to the same gateway.
- Add models directly from the Session and Project model selectors. Search an
  authenticated catalog, reuse a saved connection, or enter a model manually;
  saving refreshes the choices and selects the new model without losing the
  draft. Model providers and third-party connections have separate groups.
  Manual ChatGPT models keep their login and show no API credential fields;
  cancelling an in-flight save refreshes saved models without changing the
  current selection.
  Existing top-level API configurations also appear as saved connections.

### Fixes

- Reduce shared typography and spacing throughout Sessions, Projects and the
  Workbench. Ordinary Sessions use plain messages; Projects retain bubbles.
- Scroll long Agent conversations and crowded Workbench tabs. Center participant
  names, widen their trailing padding, and retain native Windows control space.
- Use one Project action: empty input shows Stop, content shows Send; Ctrl+Enter
  interrupts and sends a correction, and Esc stops the current Run.
- Suppress Windows startup cursor feedback for built-in restricted tool workers,
  preserving complete output, stdin EOF, exit codes and process-tree cleanup.

### Other

- Six local browser E2E checks cover model discovery, connection reuse, grouping,
  adding and draft retention in both themes. These checks remain outside CI.
- Publish this stable batch without another full-suite run at the maintainer's
  request; completed targeted checks and local E2E accompany build and artifact
  verification. Other releases retain the usual full-suite gate.

## [0.4.19-beta.2](https://github.com/whale4rain/tnega/releases/tag/v0.4.19-beta.2) — 2026-10-08

### Fixes

- Windows desktop restricted shell/search workers suppress process startup cursor
  feedback, while preserving output, stdin EOF, exit codes and process cleanup.
  Ordinary programs and custom sandbox runners retain their existing launch path.

- Project Agent exchanges center their participant header, add space after names
  and scroll long histories. Workbench tabs support ordinary mouse-wheel scrolling
  and a visible horizontal scrollbar.
- Ordinary Sessions use plain messages again; chat bubbles remain in Projects.
- Project composers use one action: Stop when empty and Send with content.
  Ctrl+Enter retains immediate correction while running.
- Desktop Workbench tabs scroll independently of window drag regions and native
  window controls; the close button stays reachable while tabs scroll.

### Other

- Local browser E2E covers long exchange histories, crowded tabs and plain
  Session messages. New local Electron E2E verifies restricted workers, complete
  large output, stdin EOF and descendant cleanup; these checks stay outside CI.

## [0.4.19-beta.1](https://github.com/whale4rain/tnega/releases/tag/v0.4.19-beta.1) — 2026-10-08

### Features

- Project Agent communication appears as compact Messaged receipts. Open an
  exchange in the Workbench to read both participants' messages, including nested
  Threads and restored history. Participant avatars open their Thread chats.
- Project, Thread, Agent exchanges and ordinary Session user messages support
  file and website references. File paths open the Workbench, local websites open
  Browser, and external websites retain normal link behavior.
- Project coordinators and Threads are guided to send one topic per message,
  usually in 1–3 sentences. Assignments, changed constraints, findings, blockers
  and verified outcomes include concise context and useful references.

### Fixes

- Smaller typography is shared across Projects, Sessions and the Workbench.
  Conversation bubbles use softer backgrounds, tighter spacing and separate
  short messages; hidden reply controls no longer leave an empty row.

### Other

- Optional local browser E2E checks cover Project and ordinary Session messages,
  Agent exchanges, references, reloads, themes and narrow windows. These checks
  are available through the Web package and are not part of CI.

## [0.4.18](https://github.com/whale4rain/tnega/releases/tag/v0.4.18) — 2026-10-06

### Features

- Project conversations use separate user-right and Agent-left chat bubbles.
  Agents can publish meaningful messages while working with send_project_message;
  Thread chat is restored from Box after reload and execution details stay folded.
- Ordinary Sessions accept text and image steering messages during an active Run,
  including Sessions running in another client. Messages persist in the next-step
  inbox and enter at a safe step boundary; Stop remains a separate control.

### Fixes

- Settings navigation keeps its full labels and button height in narrow or short
  windows. Instruction panels wrap long text without horizontal overflow.
- Desktop tray Exit immediately closes native windows and shuts down the runtime
  and embedded Browser. Cleanup failures and stalled shutdown or update installers
  cannot leave the client running without its tray; shutdown has a ten-second deadline.
- Project coordinators are guided to start or reuse Threads before investigation,
  implementation and multi-step deliverables. Agents proactively delegate useful
  independent work while keeping small or tightly coupled tasks in one context.
- Project and Thread composers keep asynchronous sending available during a run,
  alongside a separate Stop button and Interrupt and send for immediate corrections.
  Replies to a Thread control that Thread rather than the coordinator.
- Explicit Project corrections are saved through Box and enqueued before cancelling
  the current Agent Run, preserving pending input and preventing old queued messages
  from restarting work without the correction. Only direct user messages can interrupt.

### Other

- Question Web tests retry transient Windows directory locks and drain every
  cleanup once even after an error, preventing stale server closers from causing
  cascading failures in later tests.

## [0.4.17](https://github.com/whale4rain/tnega/releases/tag/v0.4.17) — 2026-10-06

### Fixes

- ChatGPT OAuth token exchange, refresh and Responses requests follow the
  configured proxy, environment proxy or desktop network transport. Proxy POST
  requests retain their method and body; provider 403 errors remain visible.

## [0.4.16](https://github.com/whale4rain/tnega/releases/tag/v0.4.16) — 2026-10-06

### Other

- Workspace Usage persists token-only Session and Project Thread summaries and daily/model aggregates in the home workspace state directory. Unchanged histories reuse cached aggregates; log edits, deletion, pricing and timezone changes rebuild affected data. Damaged caches rebuild automatically without changing Session history.

### Fixes

- Ordinary request-context rewrites no longer appear as "Context compacted";
  real compaction summaries remain visible. Memory and Workspace instructions
  share a request header without duplicating Memory across tool steps.

- ChatGPT sign-in sends the required JSON request body, fixing the HTTP 415
  rejection before OAuth starts while preserving cross-site request checks.

- Workspace instructions use a full-width stacked layout, and the usage calendar
  fits the available width. Selecting a day shows combined input, output, cache,
  reasoning, response count and cost instead of a response-by-response table.

## [0.4.15](https://github.com/whale4rain/tnega/releases/tag/v0.4.15) — 2026-10-06

### Features

- The usage calendar includes Project coordinator and Thread responses, with
  their Project/Thread identities and detailed token accounting.

- Workspace instructions also apply to Project coordinators and Threads;
  clearing the setting removes it from their subsequent requests.

- New Sessions generate a concise name from the first completed reply's intent,
  instead of truncating the user's message. Names persist across reloads;
  manual names always win. A failed or timed-out naming request keeps the default.

- Settings → Instructions saves or clears one custom system prompt per
  Workspace. Subsequent model requests reload it alongside built-in instructions,
  including resident Sessions, without restarting the application.

- Workspace usage includes a daily calendar heatmap with keyboard-accessible
  cells, intensity legend and dated Session/model/input/output/cache details.
  The view uses local calendar dates and supports both themes and narrow screens.

- Completion sounds on Web and desktop are silent while the application is
  visible and focused. Background notices play a soft chime; simultaneous notices
  are coalesced so sounds do not overlap.

### Fixes

- Interrupted-call repair also handles tool call IDs reused in later steps,
  without mistaking a completed earlier invocation for the current one.

- Usage accounting follows model switches made in Session settings, including
  the per-response model attribution and route pricing.

- Desktop completion sounds use the native application window's focus state,
  so focusing the embedded Browser panel also keeps the application silent.

- Reopening an interrupted Session closes all assistant-declared tool calls,
  including calls not yet started, with visible failures instead of leaving
  unresolved model history. Tools may declare retry or confirmation guidance;
  recovery never automatically replays side effects and repeated reopen is stable.

- Tool calls now reject invalid array members, undeclared properties when forbidden,
  and declared numeric/string/array bounds before execution. Failures remain visible
  in the Session and model context so the model can correct the next call.

### Other

- Agent loop tests dispose Contexts and flush Session logs before removing
  temporary directories, fixing a Windows CI cleanup race.

- The README uses the current blue cloud app icon.

- Changelog entries use Features, Fixes and Other consistently, including
  historical versions; publishing guidance defines the grouping rules.

## [0.4.14](https://github.com/whale4rain/tnega/releases/tag/v0.4.14) — 2026-10-05

### Features

- New app icon and brand mark: the Tnega cloud with two eyes replaces the
  squircle with a cloud on top.

- Desktop notices are quieter: the taskbar badge shows only the weather
  (drops, lightning or a snowflake), so it no longer stacks a second cloud on
  the icon; the taskbar button no longer flashes orange; and the Windows
  system "ding" is replaced by a soft two-note chime.

- The workbench terminal copies with Ctrl+C when text is selected (Ctrl+C
  still interrupts otherwise), pastes with Ctrl+V, and has a right-click menu
  with Copy, Paste, Select all and Clear.

- Sign in with ChatGPT (Settings → Models) to use a ChatGPT plan instead of
  an API key, the way the Codex CLI does: OAuth with PKCE, a local callback
  on port 1455, tokens kept in `~/.tnega/auth/chatgpt.json` and refreshed
  automatically, and a new `chatgpt` model route (default `gpt-5-codex`)
  that talks to the Codex backend through a new OpenAI Responses API adapter.
  Covered by tests against mocked endpoints; not yet tried with a live
  ChatGPT account.

- CodeMode under the sandbox is covered end to end: every tool a `run_code`
  script calls still asks for approval under Workspace write, a denial reaches
  the script as an error it can handle, the call stays inside the Windows
  sandbox, and an approved `escalate: true` call runs outside it. Approval
  cards now say when a call came from a CodeMode script, and an approval
  nobody answered within two minutes tells the agent so instead of reading
  like a refusal.

- Long Web sessions compact themselves: past 75% of the context window the
  agent first asks the model whether the run is about to finish; if it is,
  the full context is kept until 90% so the answer is not written from a
  summary, otherwise the session compacts at once, keeping the newest 16% of
  the conversation word for word. Automatic compaction (also in the CLI) now
  keeps the user's new message after the summary; before, a compaction at
  the start of a run dropped it from that run's requests.

- Skill installs and web requests work behind a proxy and with fake-IP DNS:
  the HTTP tools follow `HTTPS_PROXY` / `HTTP_PROXY` (and, in the desktop
  app, the system proxy) or a proxy set in Settings → Tools & shell →
  Network, and hosts on the new Allowed hosts list (GitHub, npm and PyPI by
  default) are trusted even when DNS answers with a reserved address such as
  a proxy's `198.18.x.x`. Failures now say which address a name resolved to,
  that DNS failed, or that the host could not be reached and how to fix it.
  `skill_install` also accepts a GitHub page link and fetches the raw file.

- Usage and cost: Settings has a Usage section with input, cached and output
  tokens and the cache (KV cache) hit share for today, the last seven days and
  all time, split by model; the session's context meter now also shows cached
  and reasoning tokens, responses and the session's estimated cost. Costs use
  per-million-token prices you set on each model (input, cached input,
  output, currency); models without prices show no cost.

- Links in replies open where they belong: links to workspace files
  (including `path:line`, which used to lose its link) and inline code that
  names a file such as `src/app.ts` open in the Workbench's Files view; local
  dev server URLs open in the Workbench browser; other sites open in a new tab.

- While a reply is being written, the agent's own words stay in view and only
  its tool calls fold, behind one line naming the current step; when the turn
  ends, everything before the final message folds into one line.

- The Background tasks list is easier to scan: running work first with what
  it is (command, agent or tool), how long it has run and its local URLs as
  links; finished work folds below with how long it took and why it failed.
  A row opens its output in place and follows new lines while it runs.

### Fixes

- Clicking Update in the desktop app now shows an "Updating to Tnega x.y.z"
  card at once while the app closes, installs and reopens; before, the window
  stayed as it was with no sign that anything was happening. The Update pill
  also loses the detached focus ring that floated around it.

- The agent's browser click now waits for menus and dropdowns that open a
  moment after the click, so the returned snapshot shows them. Clicking a
  native `<select>` lists its options and points to `browser_select_option`
  instead of opening an OS popup the agent cannot see.

- An agent that ends its turn mid-task, saying what it will do next ("Let me
  run the tests:") or answering nothing, is reminded once or twice in the
  same turn to continue or give its final answer, instead of stopping with
  the job half done. The reminder folds into the turn's process.

- Anthropic-protocol usage now counts cache reads and writes as prompt
  tokens, as the Messages API reports them separately from `input_tokens`.
  Before, cached prompts made the context meter read far too low and the
  cache hit rate could exceed 100%.

- Failed tool calls tell the model why: the reason follows the error's cause
  chain (`fetch failed: getaddrinfo ENOTFOUND host` instead of `fetch
  failed`), keeps system codes, and is never empty or `[object Object]`. An
  unknown tool name suggests the closest real one; bad arguments name the
  tool, each problem (including arguments that were not valid JSON) and the
  expected call shape; a timeout says the call was stopped and how to retry.

- npm publication retries now honor their scheduled delays instead of always
  waiting five seconds, preserving the advertised 34-minute visibility window.

- Release publication now uses the draft creation response directly, avoiding
  failures when GitHub's Release list has not yet reflected the new draft.

### Other

- The `process_start` / `process_output` / `process_list` / `process_stop`
  tools are gone: long-running commands are background jobs. `job_start` with
  `tool: "shell"` starts a dev server or watcher without a deadline, returns
  once it runs with its first output (and, with `wait_for_url_ms`, its local
  URL); `job_output` reads only new output plus URLs; `job_kill` stops it.
  In the Web app a server keeps running in the workspace when its session's
  runtime is rebuilt (a settings change), and can still be stopped there.

- Verified desktop releases and update feeds now publish independently of npm
  validation or registry propagation; npm failures do not hide desktop updates.

## [0.4.13](https://github.com/whale4rain/tnega/releases/tag/v0.4.13) — 2026-10-05

### Features

- Project Threads now automatically route undecided tool permission requests
  to their direct parent. The parent can approve the exact waiting call once,
  deny it, or forward it to the user; cancellation, expiry and Project shutdown
  invalidate the request. Decisions are audited without changing permission
  presets or treating agent messages as human authorization.
  Human escalation preserves the full input, and shell approval cards also
  display working-directory and other execution parameters.

- Background Tasks now also shows workspace long-lived processes in chats and
  Projects: live status, start time, refreshing logs, local URLs opening in the
  Browser workbench, and a direct Stop control that terminates the process tree.
  Stopped process output remains available; process records are in-memory and
  require the matching server version for the new controls.

### Fixes

- Session queries keep reporting a run as active when it finishes during the
  history read, so reconnecting clients poll again instead of missing its final reply.

- Restore the desktop Browser after its last tab closes. Agent attachment and
  address-bar navigation now create a live replacement instead of using the
  closed page, which left navigation stuck without opening a website.

- Release publication now waits for npm registry propagation before making
  the verified GitHub draft public, avoiding premature failures while a newly
  accepted npm version is not yet visible.

## [0.4.12](https://github.com/whale4rain/tnega/releases/tag/v0.4.12) — 2026-10-05

### Features

- Projects work like a team room. Every run of messages shows its author and
  time, days are separated, and the coordinator "is typing" while it writes.
  Hovering a thread card lets you reply to that thread directly. Agents now
  receive who is speaking and which message a reply answers.

- The project panel is the same Workbench a session uses: Board, Library and
  Routines lead its tabs, threads and project settings open as tabs, and it
  resizes and toggles with Ctrl+J. Files, Changes and Terminal stay available.

- The **Board** replaces Overview. It shows today's activity under the
  project's weather (threads opened, finished, outputs, tokens) and lanes for
  Needs you, Working, Ready and Idle threads, each card with its step or
  question, checklist progress, outputs, active time and tokens. Resolve a
  thread when you have taken its result; resolved threads fold away and
  reopen when they get a new message.

- **Routines** put recurring work on a schedule (daily, weekdays, weekly or
  every few minutes). Create them from the Routines tab or by asking the
  coordinator; each run goes to the routine's own thread.

- Threads can publish workspace files — Word, PowerPoint, Excel, PDF,
  images — as artifacts. The Library filters by type and previews them with
  the same viewers as workspace files.

- Project memory moves into project settings. The room and threads share a
  one-line message box that grows as you type.

- Project threads no longer ask you for permission. Their tool calls are
  reviewed automatically for the coordinator, with your requests in the room
  as evidence; what is not approved goes back to the thread, which asks its
  coordinator, and the coordinator asks you only when the decision is yours.

- Tool calls fold behind one line while a turn runs ("Running npm test"),
  and a finished turn sums them up ("Used 6 tools: 3 reads, 2 commands")
  instead of listing every call.

- Settings → Models: register several chat models, edit or remove them,
  and choose the default; sessions still switch from the composer. Your
  existing model is kept as the first entry. Approval reviewers such as
  TypeSafe Jev stay under Approvals.

- Each project's coordinator has its own colour, so projects no longer look
  alike in the sidebar.

- Selects have an inset chevron and themed options.

### Fixes

- Agent runs now continue and save their reply when the browser's SSE
  connection closes; stopping a run still requires the Stop action.

- Windows sandbox: commands that start child processes and read their output
  (`npm run dev`, vite, esbuild, most test runners) fail inside the write
  sandbox because it cannot allow named pipes without lifting the write fence.
  Such failures now explain this, and `shell` / `process_start` can ask to
  run outside the sandbox with `escalate` and a justification; once that call
  is approved it really runs unsandboxed (approved calls used to stay
  confined). A confined dev server can look ready and fail its first request
  later; `process_start` now says so, `process_output` points at escalation
  once `spawn EPERM` appears, and the approval card shows when a call asks to
  leave the sandbox and why.

- PowerShell progress records no longer leak into captured output as a
  `#< CLIXML` block.

- The agent browser keeps the address you typed and shows a loading bar
  until the page arrives.

### Other

- Publish npm and the Windows desktop update source automatically when a
  prepared version tag is pushed. Stable and preview channels remain separate;
  fixed artifact checks and staged GitHub drafts make failed uploads retryable.

## [0.4.11](https://github.com/whale4rain/tnega/releases/tag/v0.4.11) — 2026-10-03

### Features

- Projects are redesigned as a calm group chat. The main conversation holds
  what you said, what the coordinator said and one card per thread with only
  its title and status. Thread results stay in their thread: you get an
  unread dot and a desktop notification, and the coordinator no longer
  restates them. It speaks up only when a thread needs a decision you have to
  make, or when you ask. Messages you send to a thread no longer add notices
  to the main conversation.

- Threads keep a live checklist (`update_checklist`). The card shows the step
  in progress, and the thread view leads with the checklist, its outputs and
  its answers; the brief and every internal step fold away.

- Artifacts appear as cards on the message that produced them and in the
  Library. They open in place, and HTML artifacts run as interactive pages in
  a sandboxed frame. The server now serves artifact content and can stop one
  thread or every running agent in a project.

## [0.4.10](https://github.com/whale4rain/tnega/releases/tag/v0.4.10) — 2026-10-03

### Features

- The `shell` and `process_start` tools run commands in the system shell
  (PowerShell 7, then Windows PowerShell, Git Bash or cmd on Windows; `$SHELL`
  elsewhere) instead of always going through `cmd.exe`, and tell the model
  which syntax to use. Sandboxed Windows commands no longer open a console
  window. Git Bash cannot run inside the Windows sandbox and is rejected with
  a reason. PowerShell output is plain UTF-8 text (no CLIXML or colour codes),
  and output from programs that cannot switch to UTF-8 — including PowerShell
  under the read-only sandbox — is decoded with the system code page instead
  of turning into replacement characters. Killing a timed-out command also
  stops children the shell was still starting.

- Every finished reply has a visible **Fork from here** action that starts a
  new session continuing from that reply; the header menu's whole-session fork
  is now labelled "Fork entire session". Forking from a reply keeps the
  session's agent type, mode, model and title instead of falling back to a
  General session.

- Workbench Files can hide its file tree from the toolbar to give the editor
  the full width; the choice is remembered.

- Deleting a session or project, forgetting memory, discarding unsaved edits
  and error notices use the app's own dialog instead of the browser's native
  boxes.

- Ordinary tool errors the agent handles itself (a 404, a missing file,
  invalid input) no longer show as red failures; they fold into the completed
  process and their detail reads "Returned to the agent". Only failures a
  person must act on (sandbox, permissions, missing tool or credentials) stay
  flagged. The model still receives every error unchanged.

- Tool calls stream as a flat list while a turn runs instead of a folder that
  opens and closes around each call; they fold once when the turn finishes.

- Settings is reorganized into sections (Model, Approvals, Tools & shell,
  Appearance, About & updates) with a side navigation, so new options get a
  home without crowding one page. A failed save opens the section that needs
  fixing. Tools & shell adds a **Shell** choice (saved as `shell` in
  `config.json`); Appearance repeats the theme switch.

- When the agent asks a question or needs an approval, the desktop client
  sounds once, flashes the taskbar and shows a snow badge until you return to
  the window.

## [0.4.9](https://github.com/whale4rain/tnega/releases/tag/v0.4.9) — 2026-10-03

### Features

- Desktop sessions play one system sound when a run finishes. Unfocused Windows
  clients show a rain taskbar badge for a ready reply or lightning for a failed
  run; returning to the window clears it. Cancelled runs do not notify.

- Settings use a wider, responsive two-column layout with separate model and
  approval sections, keeping save actions visible while the content scrolls.

- Ship twelve offline skills for research, documents, planning, data processing,
  coding, debugging, review, TDD, DDD, Tnega usage and skill management. Install missing files in user home
  on startup, preserve user edits, and honor Workspace overrides. General,
  coding and Project agents discover short descriptions and load instructions
  on demand; no network download or additional tool permissions are required.

- Add guarded `skill_create` / `skill_install` tools and coding `/skills create`
  / `/skills install` commands, with live discovery after changes. Install from
  Workspace files or HTTPS raw Markdown; preserve existing files, enforce write
  permissions and do not execute downloaded content or copy companion assets.

## [0.4.8](https://github.com/whale4rain/tnega/releases/tag/v0.4.8) — 2026-10-03

### Fixes

- Preserve the desktop's theme when Browser attaches, opens tabs or reconnects;
  CDP connections no longer apply Playwright defaults to the host UI.

- Fix packaged Windows desktop sandbox execution: ship the ACL runner beside
  the main bundle and launch it in Electron's Node mode, with native koffi
  dependencies retained. Keep sandbox enforcement fail closed.

### Other

- Document user-run npm publishing, registry propagation delays, duplicate
  release recovery and transient Windows shortcut warnings during installation.

## [0.4.7](https://github.com/whale4rain/tnega/releases/tag/v0.4.7) — 2026-10-03

### Features

- Let desktop users choose Stable or Preview (pre) updates in Settings, persist
  the choice across restarts and prevent pending updates from the old channel
  being installed. Switching to Stable does not downgrade an installed preview.

### Fixes

- Resolve desktop PTC worker and QuickJS WASM from the shipped runtime resources
  for ordinary sessions, resident Agents and Project Threads, fixing missing
  `app.asar/out/worker.mjs` execution failures.

- Exclude generated Session logs and spill files from turn-level edited files
  and workbench Changes, while keeping project configuration, memory and skills
  visible. Correct edit paths for workspaces inside a larger Git repository.

- Ensure every desktop release carries its `latest.yml` update feed, including
  recovery for an installer built without publishing.

### Other

- Store default desktop/Web/CLI Sessions, subagent and Project Thread histories
  in `~/.tnega`, partitioned by Workspace path, with `TNEGA_HOME` overrides.
  Import legacy project records on first access without overwriting conflicts;
  retain backups and detect continued writes by old clients. Project configuration,
  memory, skills and artifacts stay in the Workspace; Session formats are unchanged.

- Support `x.y.z-beta.N` release preparation, `beta.yml` preview feeds, GitHub
  prerelease validation and explicit npm `preview` publication guidance.

- Reorganize English and Chinese guides, refresh screenshots, add this changelog
  and consolidate release instructions under `docs/publish/`.

- Audit all adjacent release tags, record historical Session format changes and
  define continuous changelog maintenance and stable/preview version policy.

- Ignore local `.pnpm-store/` and `data/` directories.

## [0.4.6](https://github.com/whale4rain/tnega/releases/tag/v0.4.6) — 2026-10-03

### Features

- Unify Files, Changes, Terminal, Browser, document previews and subagent
  transcripts in the right-hand Workbench, including image and PDF previews.

- Add a workspace file tree and syntax-aware editor with Ctrl+S and detection
  of concurrent disk changes; add unified/side-by-side Git diffs with live refresh
  and multiple PTY terminals. Ctrl+J toggles the panel; Ctrl+` opens the terminal.

- Add application-contained agent browsing in desktop and Web, browser tabs,
  a resizable viewport, screenshots and an element picker.

- Accept image attachments on messages and tool results; route them to vision
  models with a fallback for unsupported models.

- Add background commands and jobs with visible progress and stop controls;
  keep background workspace processes alive across Agent Runs.

- Load external plugins from profile files and hot-reload without restarting.

- Add a slash command to enable CodeMode.

- Improve project coordination and Thread reporting, including waiting for
  user decisions; show context compaction progress.

- Introduce the sky palette, measured dark theme, weather states and
  cloud-on-cube identity; simplify conversation controls.

- Add packaged desktop self-update from GitHub Releases, background downloads,
  an Update action and manual checks in Settings.

- Keep closed desktop windows running in the tray; ship the terminal's
  platform binaries in installers and refuse saves over invalid config files.

### Other

- **Breaking:** remove eval, evolve and benchmark packages and public exports.
  Session format remains v10. See [release notes](docs/releases/v0.4.6.md) and
  [ADR 0011](docs/adr/0011-remove-eval-first.md).

## [0.4.5](https://github.com/whale4rain/tnega/releases/tag/v0.4.5) — 2026-10-01

### Features

- Add Projects with a coordinator, parallel Threads, shared Memory and an
  artifact Library, including project archive and deletion.

- Add Work Sessions and Office tools to create, inspect and edit DOCX, XLSX
  and PPTX, including formatting, themes, native charts and cached Excel formula
  evaluation.

- Show generated Office files as conversation cards with side-panel previews,
  zoom and downloads; add slash commands across Session types and `@` mentions.

- Add fail-closed local sandbox providers for Linux, macOS and Windows, and
  persist Session tool permission choices.

- Add scoped automatic approval plugins, durable user questions and CodeMode
  orchestration with QuickJS; expose nested tool progress.

- Persist completed-run final answers and collapse intermediate activity.

- Configure model context windows, list only configured routes, show edited-file
  line counts after runs (also outside Git), and honor `.gitignore` in glob/grep.

- Redesign the local UI and desktop window controls; add tray restoration and
  fix CommonJS sandboxed preloads and Session writer ownership.

### Other

- Session format remains v10. See [release notes](docs/releases/v0.4.5.md).

## [0.4.2](https://github.com/whale4rain/tnega/releases/tag/v0.4.2) — 2026-09-24

### Features

- Add the Electron desktop host, native workspace selection and desktop
  packaging; revise the conversation and activity interface.

- Add durable subagents and inbox tools, persistent Goal mode and permission
  presets, with child-task progress in the UI.

- Add persistent user/workspace memory and tool-output spill to keep large
  results manageable.

- Add multiple model routes, capabilities and thinking levels;
  show provider usage and cache metrics.

- Improve context compaction rendering.

- Group Sessions by Workspace, keep Settings inside the app, switch configured
  models per Session, fix root-level glob matches and truncate oversized reads
  instead of failing.

## [0.4.1](https://github.com/whale4rain/tnega/releases/tag/v0.4.1) — 2026-09-14

### Fixes

- Preserve transcript lifecycle ordering after compaction.

- Honor explicit Anthropic credentials and attach failed Agent Runs to their
  user messages in the Web UI.

## [0.4.0](https://github.com/whale4rain/tnega/releases/tag/v0.4.0) — 2026-09-13

### Features

- Persist assistant attempt ownership, including reconnectable streams and
  forks.

### Fixes

- Harden durable inbox claims, live Agent scheduling, cancellation and retry
  settlement; preserve same-turn steering order.

- Resolve inherited prompts, tools and events in the Agent's scope; await
  request middleware and expose admitted step batches.

- Normalize non-streaming JSON responses in native stream adapters.

### Other

- Prefer `TNEGA_API_KEY` for the default model credential.

- **Breaking:** Session format becomes v10; incompatible older logs are rejected
  rather than migrated in place.

## [0.3.0](https://github.com/whale4rain/tnega/releases/tag/v0.3.0) — 2026-09-09

### Features

- Add Coding Sessions, Plan mode, skills, MCP and slash command pickers.

- Add durable turn/step events, append-only context compaction and a projected
  model surface while retaining compacted history in the human transcript.

- Add library subpath exports and isolated evaluation/benchmark workflows.

- Add resident multi-turn Agents with durable inboxes, profile-based startup,
  dynamic prompt variables and service seams. Evaluation importers support
  HumanEval, MBPP, BigCodeBench and SWE-bench.

### Fixes

- Align stream retries, cancellation causes, inbox steering and tool execution
  middleware; persist partial streams and show interrupted-run recovery.

### Other

- **Breaking:** Session format becomes v7 and the SessionProjector seam is
  removed. Old logs are not automatically migrated.

## [0.1.1](https://github.com/whale4rain/tnega/releases/tag/v0.1.1) — 2026-09-01

### Features

- Establish the plugin lifecycle core, Agent Loop, JSONL Sessions, tool execution
  pipeline, LLM adapters, CLI and React/Vite local Web interface.

- Add library/runtime composition and public domain exports.

- Support OpenAI-compatible and Anthropic providers, streaming replies,
  cancellation, refresh recovery, forks, edited-message resubmission and context
  compaction while retaining the human transcript; add dark mode.

- Expose declarative AgentDefinition and tool validation, authorization and
  truncation policies. Early eval/evolve tooling was later removed in 0.4.6.

### Other

- Switch the default model route for this release and prepare npm distribution.
