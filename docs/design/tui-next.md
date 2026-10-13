# 终端界面下一阶段（设计稿）

状态：**已确认方向，逐步实现中**（见 §6；路线图里打 ✓ 的已完成）。按「路线图」逐个 PR 实现；每个 PR 先把定稿的规则写进 `tnega-design.md` §5.8，再改代码。本文不改变现有行为。

## 1. 现状与目标

v0.5.0 的 `tnega tui`（`packages/tui`）已经覆盖日常对话：会话列表、流式回复与工具折叠、多行输入与 `/` `@` 补全、停止与改向、审批与问题、模型选择、设置、用量与 diff。它是 `@tnega/client` 的又一个客户端，规则见 §5.8。

还缺的，按用户会先撞上的顺序：

1. **入口说不清**：`tnega --help`、`tnega help`、裸 `tnega` 都只报 `unknown command`，帮助里没有 `tui`。
2. **第一次用没有引导**：没有模型或密钥时，TUI 照常打开，第一次发送才失败；要配模型只能 `/web`。
3. **改动只看到文件名**：结束的回合已经列出 `Changed N files` 和每个文件的加删行数，但没有总数，也不提示 `/diff`；`Ctrl+O` 展开后编辑工具行也看不到改了哪几行。
4. **回看困难**：滚动区只追加，`Ctrl+O` 只能整屏重印；打开旧会话只印最近 80 条，更早的要去 Web。
5. **后台工作不可见**：后台 shell、job 与子 Agent 在 TUI 里没有入口，也停不掉。
6. **输入区按键全靠记**：框下面没有任何提示，Enter、Ctrl+O、Esc 能做什么要看 `/help`；模式要敲 `/plan` `/auto` 切换；历史只能逐条翻；不能附图；长文不能交给 `$EDITOR`。
7. **不能回退**：Web 能从某条消息分叉或重发，TUI 不能。
8. **离开终端就不知道它在等你**：没有铃声或系统通知。

目标仍然是「同一个服务端的终端客户端」：服务端已有的 API（`jobs`、`processes`、`subagents`、`forkSession`、`truncate`、`discoverModels`、`saveModelRoute`、图片 `attachments`）都够用，本阶段**不改服务端协议**。Project 继续不进 TUI（终端里用 `/web`）。

## 2. 设计原则（在 §5.8 之上补充）

- **滚动区仍然只追加**。需要回看、展开、搜索时进入**全屏查看器**（终端的备用屏幕，退出后滚动区原样恢复），而不是改写已打印的内容。
- **一次只有一个面板**。审批、问题、选择列表、设置都替换输入框的位置；「等你」的面板优先，其他面板在它出现时让位。
- **状态色仍只有绿、黄、红**，加删行数用绿 / 红，其余元数据 `dim`；选中项反色；不加新颜色。
- **每个按键只有一个意思**，并在面板末行写出来；不新增需要记忆的组合键，除非它和主流终端 Agent 一致（`Shift+Tab`、`Ctrl+R`、`Ctrl+T`、`Esc Esc`）。
- **能在终端做好的做完，做不好的明确交给 `/web`**（浏览器 screencast、Office 与图片预览、Project）。

## 3. 屏幕与交互

下面的示意是 80 列；彩色版截图在项目文件 `screenshots/tui/next-*.png`。

### 3.1 命令行帮助

`tnega --help` / `tnega help` / `tnega -h` 打印总帮助；`tnega <命令> --help` 打印该命令的全部选项；`-v` / `--version` 打印版本。帮助走 stdout、退出码 0；未知命令仍是退出码 2，并附一行 `Run tnega --help for the commands.`。

```
$ tnega --help
tnega 0.5.0 · an agent harness that works in your folder

Usage
  tnega                     open the terminal client here (same as tnega tui)
  tnega tui [options]       terminal client for this folder
  tnega web [options]       start the local web app
  tnega run "<prompt>"      run one prompt and print the answer

Common options
  --cwd <dir>               folder to work in (default: here)
  --config <file>           config file (default: ~/.tnega/config.json)
  --profile <name>          plugin profile; --no-plugins for none
  -h, --help                help; tnega tui --help lists its own options
  -v, --version             print the version
```

**裸 `tnega`**（已定）：在交互终端里等同 `tnega tui`（与 Claude Code、Codex 一致）；stdin / stdout 不是 TTY 时打印帮助并返回 2。

### 3.2 第一次打开：连接模型

启动时 `config` 里没有任何可用模型（`apiKeySet` 全为假，且没有 ChatGPT 登录）时，不显示输入框，而是显示「Connect a model」面板：

```
tnega  ~/code/demo

╭──────────────────────────────────────────────────────────────────────────────╮
│ Connect a model                                                              │
│ tnega needs one model before it can work. The key is saved in                │
│ ~/.tnega/config.json and never leaves this machine except to the provider.   │
│                                                                              │
│ › DeepSeek              api.deepseek.com                                     │
│   OpenAI-compatible     any base URL: OpenRouter, Ollama, vLLM…              │
│   Anthropic             api.anthropic.com                                    │
│   ChatGPT sign-in       use your ChatGPT plan; opens a browser               │
│                                                                              │
│ ↑↓ move · enter choose · esc quit                                            │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ DeepSeek  api.deepseek.com                                                   │
│                                                                              │
│ API key  ••••••••••••••••••••3f9a                                            │
│ ✓ Key works. 2 models: deepseek-chat, deepseek-reasoner                      │
│                                                                              │
│ enter save and start · esc back                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- 第一步是提供方列表（`Picker` 的样子，放在 `dim` 圆角框里）；第二步输入密钥，输入时只显示 `•` 和末 4 位，粘贴即可。
- 回车先用 `discoverModels` 验证：成功写 `✓ Key works` 和找到的模型，再回车用 `saveModelRoute` 保存并进入对话；失败用红色写服务端返回的原因，停在这一步。
- ChatGPT sign-in 打开浏览器走现有登录流程，终端里显示「Waiting for the browser…」与可复制的链接。
- 以后要改模型路由，`/settings` 里新增一行 `Model routes`（列出、增加、删除，同样的两步面板）；编辑高级字段（推理强度表、上下文窗口）仍然 `/web`。

### 3.3 回合结束：改了什么

结束的回合已有改动列表（服务端的 file-edits 事件，`Changed N files` 加每个文件的加删行数）。本阶段补：标题行加总加删行数与 `· /diff to review`；文件超过 6 个时只列前 5 个，加 `… N more`；以及下面的行内 diff。

`Ctrl+O` 展开时，编辑类工具行下面直接显示该次编辑的前 8 行 diff（行号 `dim`，删行红、加行绿），多出的写 `… N more lines · /diff <path>`。

```
› Rename fetchUser to loadUser and update the callers.

  Used 6 tools · Ctrl+O to show

  Renamed it in 3 files. The tests pass (42 passed).

  Changed 3 files  +9 −9  · /diff to review
    src/user.ts           +3 −3
    src/api/routes.ts     +4 −4
    test/user.test.ts     +2 −2

(the same turn after Ctrl+O)

  ✓ Searched "fetchUser"  7 matches  40ms
  ✓ Edited src/user.ts  +3 −3
      12 - export async function fetchUser(id: string) {
      12 + export async function loadUser(id: string) {
      … 4 more lines · /diff src/user.ts
  ✓ Ran pnpm test  exit 0 · 42 passed  4.1s

╭──────────────────────────────────────────────────────────────────────────────╮
│ ›  Reply…                                                                    │
╰──────────────────────────────────────────────────────────────────────────────╯
○ Ready  deepseek-chat · coding · workspace-write            18% context · $0.01
```

数据来源：工具参数里有替换前后的文本时用它算 diff（复用 `diffLines`）；没有（例如整文件写入）就只写加删行数，不在行内放 diff。

### 3.4 全屏查看器（`Ctrl+T`）

`Ctrl+T`（或 `/transcript`）打开当前会话的全屏查看器，进入终端备用屏幕；`q` / `Esc` 退出，滚动区与输入框原样恢复。它取代「更早的去 `/web` 看」。

```
Transcript  Rename fetchUser                               turn 4 of 4 · 38 rows

› Rename fetchUser to loadUser and update the callers.

  ✓ Searched "fetchUser"  7 matches
› ✓ Edited src/user.ts  +3 −3
      12 - export async function fetchUser(id: string) {
      12 + export async function loadUser(id: string) {
      31 -   return fetchUser(session.userId)
      31 +   return loadUser(session.userId)
  ✓ Edited src/api/routes.ts  +4 −4  ▸
  ✓ Edited test/user.test.ts  +2 −2  ▸
  ✓ Ran pnpm test  exit 0  4.1s  ▸

  Renamed it in 3 files. The tests pass (42 passed).


j k move · enter fold · [ ] turns · / search · o $PAGER · q back
```

- 一行一个条目；工具行可 `Enter` 展开 / 折叠（展开后显示参数、输出末 40 行或 diff）；`▸` 表示可展开。
- `j` `k` / 方向键移动，`PgUp` `PgDn` `g` `G` 翻页与首尾，`[` `]` 跳上一个 / 下一个回合，`/` 搜索（`n` `N` 下一个 / 上一个），`o` 把当前条目的完整内容交给 `$PAGER`（默认 `less -R`），`y` 复制当前条目（OSC 52，终端不支持时提示）。
- 进行中的回合也能看：查看器跟随新内容，除非用户已经往上移。
- 同一个查看器也用来看后台任务输出（3.5）和子 Agent 的过程。

### 3.5 后台任务与子 Agent

状态行在模型等信息后面加 `N running`（只在 N > 0 时出现）。`/tasks`（或在空输入框按 `↓` 到底后再按一次）打开后台列表：

```
› Start the dev server and review the API folder in the background.

  Started the dev server on localhost:5173 and asked a reviewer to go
  through src/api. I will tell you when the review is back.

Background  type to filter
› ⠋ pnpm dev                  shell · 3m 12s · localhost:5173
  ⠋ Reviewer                  subagent · reading src/api/routes.ts
  ✓ pnpm test                 shell · exit 0 · 41s
↑↓ move · enter output · x stop · esc close

⠙ Running a tool  deepseek-chat · coding · 2 running         41% context · $0.03
```

- 合并 `jobs`、`processes` 与 `subagents`（与 Web 的 `mergeTasks` 同一规则，挪进 `@tnega/client` 共用）；运行中的转圈，结束的写 `✓` / `✕` 与退出码。
- `Enter` 在查看器里看输出（跟随末尾）或子 Agent 的过程；`x` 停止，停止前在末行问一次 `Stop pnpm dev? y / n`。
- 后台任务结束时，在滚动区追加一行 `dim` 的 `✓ pnpm test finished · exit 0`，不打断正在输入的内容。

### 3.6 回退与分叉（`Esc Esc`）

输入框为空且没有运行时，连按两次 `Esc`（或 `/rewind`）打开本会话的用户消息列表：

```
Rewind  type to filter
› Rename fetchUser to loadUser and update the callers.          4 min ago
  Add a test for the empty id case.                             12 min ago
  Look at src/user.ts and tell me what it does.                 15 min ago
enter edit and resend from here · f fork into a new session · esc close
Files the agent changed after this point stay as they are; /diff shows them.
```

- `Enter`：用 `truncate` 回到这条消息之前，把它的文字放回输入框供修改后重发；滚动区按新的会话重印（同打开会话）。
- `f`：用 `forkSession` 从这条消息分叉出新会话并切过去，原会话不变。
- 末行说明：回退不撤销文件改动（与 Web 一致）。

### 3.7 输入区

输入区是最常看的地方，现在只有一个框和一行状态，按键全靠记。改为四层，从上到下：排队行（有排队时）、输入框、**按键提示行**、状态行。

```
(1) new session, empty
╭──────────────────────────────────────────────────────────────────────────────╮
│ ›  Ask tnega to do something                                                 │
╰──────────────────────────────────────────────────────────────────────────────╯
  enter send · shift+enter new line · / commands · @ files · ? all keys
○ Ready  deepseek-chat · coding · read-only                           0% context

(2) typing after a turn
╭──────────────────────────────────────────────────────────────────── 2 lines ─╮
│ ›  Also add a test for the empty id case,                                    │
│    and run the suite once more.▏                                             │
╰──────────────────────────────────────────────────────────────────────────────╯
  enter send · shift+enter new line · ctrl+o show the last 6 steps · ? all keys
○ Ready  deepseek-chat · coding · read-only                  18% context · $0.01

(3) while the agent works, in plan mode, one message queued
  ⠋ Running pnpm test · 4 steps

  queued  also run lint afterwards                          ↑ edit · ctrl+x drop
╭─────────────────────────────────────────────────────────────────────── plan ─╮
│ ›  Steer the agent                                                           │
╰──────────────────────────────────────────────────────────────────────────────╯
  esc stop · enter steer now · tab queue for later · ctrl+o show steps
⠙ Thinking  deepseek-chat · coding · plan                    41% context · $0.03
```

- **按键提示行**（新）：输入框下面一行 `dim` 文字，只列此刻最有用的 4–5 个键，随状态变化：
  - 空闲且为空：`enter send · shift+enter new line · / commands · @ files · ? all keys`；上一回合有折叠的步骤时，`@ files` 换成 `ctrl+o show the last N steps`
  - 换行键按终端能力写：启动时探测 kitty 键盘协议，支持时写 `shift+enter`，否则写 `ctrl+j`（不支持的终端里 Shift+Enter 等于 Enter，会直接发送）
  - 正在输入：把 `/` `@` 换成与上一回合有关的键，例如 `ctrl+o show the last 6 steps`（数字取自上一回合折叠的步数）
  - 运行中：`esc stop · enter steer now · tab queue for later · ctrl+o show steps`
  - 补全列表打开：`↑↓ choose · tab complete · enter run · esc close`
  - 等你（审批、问题）：提示行由面板自己的末行取代，不重复
  - 终端窄时从右往左丢项，`? all keys` 最后丢。
- **占位文字**说清此刻 Enter 会做什么：新会话 `Ask tnega to do something`，回复中 `Reply…`，运行中 `Steer the agent`。
- **框的右上角**写 `dim` 的状态标签，只在非默认时出现：多行时 `2 lines`，非默认模式 `plan` / `auto`，有附图时 `1 image`；多个用 ` · ` 连接。框最多长到 8 行，再多在框内滚动。
- **`?`**（输入框为空时）把提示行展开成完整按键表，`?` 或 `Esc` 收起；`/help` 仍列命令。按键表只列已经实现的键，后续步骤加键时同步加行。

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ›  Ask tnega to do something                                                 │
╰──────────────────────────────────────────────────────────────────────────────╯

  Keys
  enter          send; steer while it runs              ctrl+o  fold or show steps
  shift+enter    new line (also ctrl+j)                 esc     stop · close
  tab            queue while it runs (also alt+enter)   ctrl+x  drop a queued message
  shift+tab      auto · plan · goal                     ctrl+c  clear · twice quits
  ↑ ↓            earlier prompts; a queued message      ctrl+d  quit on an empty box
  ctrl+a ctrl+e  line start · end                       y  n    allow · deny a tool
  ctrl+u ctrl+k  delete to start · end                  /help   every command
  ctrl+w         delete a word
  /  @           commands · files
  ? or esc to close
○ Ready  deepseek-chat · coding · read-only                           0% context
```

- **补全列表**紧贴输入框下方，选中项反色，右侧 `dim` 写说明；不需要参数的命令 Enter 直接执行（不变）。

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ›  /co▏                                                                      │
╰──────────────────────────────────────────────────────────────────────────────╯
  › /compact      summarise the conversation to free context
    /codemode     on · off
    /continue     resume a run that stopped mid-turn
  ↑↓ choose · tab complete · enter run · esc close
○ Ready  deepseek-chat · coding · read-only                          18% context
```

- **`Shift+Tab` 切换模式**：auto → plan → goal → auto（auto 是默认），状态行里非默认的模式加粗，框右上角同时显示；与 `/auto` `/plan` `/goal` 同一个设置；运行中不切换。
- **排队（已定）**：运行中 Enter 仍是立即改向；`Tab` 或 `Alt+Enter` 把消息排到本轮结束后自动发送（Windows Terminal 把 Alt+Enter 留给全屏，所以提示行写 `tab`）。排队的消息显示在输入框上方（`dim` 的 `queued` 加正文，右侧 `↑ edit · ctrl+x drop`），可以在空输入框按 `↑` 取回修改、`Ctrl+X` 丢弃；多条排队合成一条发送。本轮被停止或失败时不自动发送，提示「Enter 发送、↑ 修改」，空输入框按 Enter 即发送。空闲时 `Alt+Enter` 仍是换行、`Tab` 不做事。
- **`Ctrl+R` 搜索历史**：输入框换成 `history›` 行，边打边匹配，`Ctrl+R` 找更早的，`Enter` 采用，`Esc` 取消。

```
› Run the tests and fix any failures.

  All 42 tests pass now. The failure was a stale snapshot.

╭──────────────────────────────────────────────────────────────────────────────╮
│ ›  look at @src/user.ts and the screenshot @shots/login.png                  │
│     [image] login.png 1280×800                                               │
╰──────────────────────────────────────────────────────────────────────────────╯
○ Ready  deepseek-chat · coding · plan              shift+tab mode · 18% context

╭──────────────────────────────────────────────────────────────────────────────╮
│ history› test▏  Run the tests and fix any failures.                          │
╰──────────────────────────────────────────────────────────────────────────────╯
ctrl+r older match · enter use · esc cancel
```

- **附图**：`@` 补全到图片文件（png / jpg / gif / webp）时，发送前读成 `attachments`，输入框下面写一行 `dim` 的 `[image] 名称 尺寸`；也接受从文件管理器拖进终端的路径。超过服务端限制时在提示行说明，不发送。
- **`Ctrl+G` 用 `$EDITOR` 写长文**：退出编辑器后内容回到输入框，不自动发送。

### 3.8 通知与细节

- **等你时提醒**：出现审批或问题、或一轮在 30 秒以上后结束时，若终端不在前台（焦点上报 `CSI ?1004`），发 OSC 9 / OSC 777 桌面通知；终端不支持则响一次铃（`BEL`）。`TNEGA_NOTIFY=off` 关闭。
- **`NO_COLOR`**：设置时不输出颜色，状态靠符号与文字表达（天气符号本来就配文字）。
- **窄终端**：小于 60 列时状态行只留天气与上下文占比，Picker 隐藏详情列；小于 40 列提示「终端太窄」。
- **`Ctrl+L`** 清屏并重印当前会话（同 `Ctrl+O` 的重印方式）。

## 4. 按键总表（新增标 ★）

| 位置 | 按键 | 作用 |
| --- | --- | --- |
| 输入框 | Enter / Shift+Enter 等 | 发送（运行中为改向）/ 换行（不变） |
| 输入框 | ★ Tab / Alt+Enter（运行中） | 排队到本轮结束后发送 |
| 输入框 | ★ Shift+Tab | 切换模式：auto → plan → goal |
| 输入框 | ★ Ctrl+R | 搜索历史 |
| 输入框 | ★ Ctrl+G | 用 `$EDITOR` 编辑 |
| 输入框 | ★ Esc Esc（空且空闲） | 回退 / 分叉 |
| 输入框 | ★ ?（空时） | 完整按键表 |
| 排队行 | ★ ↑ / Ctrl+X | 取回修改 / 丢弃 |
| 全局 | Esc | 停止运行；关闭面板（不变） |
| 全局 | Ctrl+O | 展开 / 折叠全部（不变） |
| 全局 | ★ Ctrl+T | 全屏查看器 |
| 全局 | ★ Ctrl+L | 清屏重印 |
| 全局 | Ctrl+C / Ctrl+D | 清空 / 退出（不变） |
| 查看器 | ★ j k ↑ ↓ PgUp PgDn g G [ ] / n N Enter o y q | 见 3.4 |
| 后台列表 | ★ Enter / x | 看输出 / 停止 |

注意：`Alt+Enter` 现在是换行的备选键之一。改为排队后，换行仍有 Shift+Enter、Ctrl+J 与行尾 `\`；只在运行中改义，空闲时仍是换行。裸 `tnega` 后面跟选项（`tnega -c`）等同 `tnega tui` 的选项。

## 5. 路线图（每步一个 PR）

每个 PR 都：先更新 §5.8 的对应规则；补 `packages/tui/test` 的行为测试（`ink-testing-library` + `fake-server`）；跑 typecheck、lint、相关测试，并用真实 DeepSeek 在 pty 里手测一遍、附截图。不改 `CHANGELOG.md`。

| # | PR | 内容 | 验收 |
| --- | --- | --- | --- |
| 1 ✓ | `feat(cli): help, version and bare tnega` | 3.1；README 与 `packages/cli/README.md` 同步 | `tnega --help` 列出 tui；各命令 `--help`；裸 `tnega` 在终端里打开 TUI，管道里打印帮助；未知命令退出码 2 |
| 2 ✓ | `feat(tui): input area with key hints` | 3.7 的提示行、占位文字、框标签、`?` 按键表、`Shift+Tab`、`Tab` / `Alt+Enter` 排队 | 各状态的提示行正确；`?` 开合；三种模式循环；排队消息在本轮后发出，可取回、可丢弃 |
| 3 | `feat(tui): connect a model on first run` | 3.2 与 `/settings` 的 Model routes | 空配置启动能配好 DeepSeek 并直接对话；坏密钥停在第二步并说明 |
| 4 | `feat(tui): inline edit diffs` | 3.3：改动列表的总数与提示、Ctrl+O 下的行内 diff | 编辑 3 个文件的回合显示总数；Ctrl+O 显示每次编辑的 diff |
| 5 | `feat(tui): full-screen transcript viewer` | 3.4；打开旧会话不再提示去 Web | 200 条的会话可翻到开头；搜索、展开、`$PAGER`；退出后滚动区不乱 |
| 6 | `feat(tui): background tasks and subagents` | 3.5；`mergeTasks` 等挪进 `@tnega/client`，Web 改为 re-export | 后台 dev server 可看输出、可停止；子 Agent 过程可看 |
| 7 | `feat(tui): history search, images, $EDITOR` | 3.7 余下三项 | Ctrl+R；附一张 png 并被模型看到；Ctrl+G 往返 |
| 8 | `feat(tui): rewind and fork` | 3.6 | 回退后重发生效；分叉后两个会话都在列表里 |
| 9 | `feat(tui): notifications and small terminals` | 3.8；Windows Terminal / conhost、macOS Terminal、iTerm2、kitty 手测清单写进 `packages/tui/README.md` | 失焦时等你能收到通知；`NO_COLOR` 与 50 列下可用 |

1、2 先做（入口与输入区天天用到）；3、4 收益其次；5、6 共用查看器，5 先做；7、8、9 相互独立。

## 6. 已定（2026-10-13）

1. 裸 `tnega` 在交互终端里打开 TUI；非 TTY 打印帮助。
2. 没有可用模型时，在 TUI 里显示「Connect a model」两步面板（3.2）；已配置时不出现。
3. 运行中 `Alt+Enter`（以及 `Tab`）排队到本轮结束后发送（3.7）。
4. 输入区加按键提示行与 `?` 按键表（3.7），作为第 2 步先做。

## 7. 不做

- Project 与线程（按你之前的要求）。
- 浏览器 screencast、Office / 图片预览、文件树编辑：终端里做不好，继续 `/web`。
- 鼠标操作与终端内的图片显示（sixel / kitty graphics）：终端支持参差，收益小。
- 自定义按键：先把默认键做对。
