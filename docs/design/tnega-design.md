# Tnega 设计规范

日期：2026-10-02，2026-10-09 起扩充为前端开发的强制规范。本文是 Tnega 界面与交互设计的唯一规范，取代 Astryx 迁移时期的青绿配色规范（历史正文可从 Git 获取）。天气状态语言的细节与扩展方向见 [`weather-language.md`](weather-language.md)；浏览器能力的工程取舍见 [ADR 0012](../adr/0012-agent-browser.md)。

## 0. 怎样使用本文

**`apps/web` 与 `apps/desktop` 渲染层的每一处改动都以本文为准。** 动手前读相关章节，提交前过一遍 [§11 清单](#checklist)。本文与代码不一致时，以本文的意图为准修代码；确实要改变设计时，在同一次改动里先改本文、再改代码，并在 PR 描述里写明改了哪条规则、为什么。

| 你要做的事 | 先读 |
| --- | --- |
| 改颜色、加状态色、做新调色板 | §3 色彩 |
| 表达 Agent 在做什么 | §4 天气 与 `weather-language.md` |
| 改对话、输入区、工作台、侧栏、Project | §5 主要界面 |
| 改字号、行高、控件高度、内容宽度 | §5.5 密度、§6 字号与显示偏好 |
| 新的列表、卡片、表格、数字、时间、空态 | §7 信息显示原则 |
| 新按钮、菜单、对话框、表单 | §8 组件与样式复用 |
| 新的设置项 | §9 设置 |

规则里写“必须 / 不得”的是硬性要求（大多有测试守着）；写“优先 / 默认”的是可以有理由偏离的默认做法，偏离时在代码注释里写理由。

## 1. 设计主张

Tnega 是一个让人长时间和 Agent 一起工作的地方。界面要**安静**：导航退后，对话与产物居中；状态要**一眼可辨**：Agent 在想、在做、在等你还是出了错，不读文字也能看出来；能力要**就在手边**：图片能直接贴进来，Agent 打开的网页就在旁边的面板里。

## 2. 标识：云

- 品牌标志是一朵带两只白眼睛的**云**：在 Tnega 里工作的 Agent 本身，与会话主 Agent、Project 协调者的头像同形（`AgentAvatar` 的 `cloud`）。扁平、单色、无描边；天气发生在云的周围。
- 2026-10-05 起取代原先「方块上歇着一朵云」：方块加云在任务栏上与天气角标叠成了两朵云，也不如单独的云可爱。
- 任务栏角标（`apps/desktop/build/completion-*.png`，由 `scripts/render-completion-icons.mjs` 生成）只画天气本身——雨滴、闪电、雪花，放在小深色圆片上——不再画云，任务栏上始终只有一朵云。桌面通知不闪烁任务栏按钮（Windows 把它画成橙红色，像警报），提示音是应用自己合成的两声轻音，不用系统提示音。
- 来源：
  - 品牌标志：`apps/web/src/styles/app.css` 的 `--brand-cloud`（云形遮罩）与 `--brand-eyes`（白眼睛），云用当前调色板的 `--accent` 填色；favicon 与安装包图标保持 Sky 蓝。
  - favicon：`apps/web/index.html`。
  - 安装包图标：`apps/desktop/build/icon.svg`，用 `node apps/desktop/scripts/render-icon.mjs` 生成 `icon.png` 与多尺寸 `icon.ico`。
- 会话主 Agent 画成强调色的云；会话里的子 Agent 保留随机的形状和颜色（圆、软方、斜方、软糖、云、水滴），便于区分。
- **Project 里不画 Agent 头像**（2026-10-09 起）：Project 是任务驱动的，协调者只负责转派，Thread 用标题和状态灯辨认，不用头像（§5.7）。

## 3. 色彩：模式 × 调色板

所有颜色只来自 `apps/web/src/styles/tokens.css`，组件**不得**写裸色值（`#hex`、`rgb()`、命名色）。唯一的例外是 `tokens.css` 本身、品牌 SVG 数据 URL 里的白眼睛，以及需要具体颜色值的第三方库——它们在运行时从 token 读取（终端 `TerminalView.themeFromTokens`、桌面标题栏 `desktop-chrome.ts`）。

### 3.1 两个独立的轴

| 轴 | 根元素属性 | 取值 | 谁决定 |
| --- | --- | --- | --- |
| 模式 | `data-theme` | `light` / `dark` | 设置里的 System / Light / Dark；System 跟随 `prefers-color-scheme`（`useTheme`，`lib/hooks.ts`） |
| 调色板 | `data-palette` | `sky`（默认）/ `sand` / `forest` / `graphite` | 设置 → Appearance → Colour palette（`useDisplay`，`lib/display.ts`） |

- 模式决定明暗，调色板在该模式内换**中性色、强调色、状态色与语法色**。两者自由组合，共 8 种外观，每一种都必须通过 [§3.6](#contrast) 的底线。
- 选择器写法：Sky 是 `:root, [data-theme="light"]` 与 `[data-theme="dark"]`；其他调色板是 `[data-palette="x"][data-theme="light|dark"]`，特异度更高，所以只需覆盖颜色 token。
- 这些属性可以挂在**任何元素**上，属性下的子树就用那套颜色——设置里的调色板色样正是这样画的（每半块各自带 `data-palette` 与 `data-theme`）。需要预览某种外观时用这个办法，不要在 JS 里复制色值。
- `index.html` 在首帧前从 localStorage 套用模式与全部显示偏好，页面不会闪。新增根属性时同步改那段脚本。
- 依赖颜色的非 CSS 代码（xterm、标题栏）必须同时监听 `data-theme` 与 `data-palette` 的变化。

### 3.2 语义 token 与用法

按**角色**取 token，不按“看起来像什么颜色”取。

| 角色 | token | 用于 | 不得用于 |
| --- | --- | --- | --- |
| 页面底 | `--bg` | 应用最底层、工作台外框 | 卡片、输入框 |
| 侧栏 | `--bg-sidebar` | 左侧栏 | 其他区域 |
| 工作面 | `--surface` | 卡片、输入框、对话框正文、文档 | — |
| 抬升面 | `--surface-raised` | 菜单、浮层、Project 气泡 | 大面积底色 |
| 凹陷面 | `--surface-sunken` | 代码、空态、只读区、进度条底 | 可点击的主要控件 |
| 悬停 / 按下 | `--surface-hover` / `--surface-active` | 行与按钮的悬停、按下 | 选中态（选中用 `--accent-soft`） |
| 分隔线 / 强分隔线 | `--border` / `--border-strong` | 卡片边、分隔 / 输入框边、悬停时加强 | 文字 |
| 焦点 | `--border-focus` | 焦点环 | 装饰 |
| 正文 | `--text` | 标题、正文、主要数值 | — |
| 次级文字 | `--text-2` | 说明、标签、次要按钮文字 | 正文段落 |
| 三级文字 | `--text-3` | 元数据（时间、计数、路径）、占位、静止图标 | 唯一的重要信息 |
| 反色文字 | `--text-inverse` | 强调色、危险色实底上的文字 | 普通底色 |
| 强调 | `--accent` | 主按钮底、选中描边、链接下划线、品牌云 | 大段文字（用 `--accent-text`） |
| 强调文字 | `--accent-text` | 链接、选中项文字 | 底色 |
| 强调浅底 | `--accent-soft` | 选中项、当前标签、焦点光晕 | 警示 |
| 成功 = 晴 / 警告 = 太阳 / 危险 = 雷暴 | `--success` `--warn` `--danger`（及 `-soft`） | 状态文字、状态点、diff 增删、危险按钮 | 装饰、品牌 |
| 代码 | `--code-bg` / `--code-border` / `--syntax-*` | 代码块、编辑器、终端、diff | 普通卡片 |
| 用量色阶 | `--usage-0…4` | 用量热力图 | 其他图表的系列色 |
| 天气 | `--wx-*` | 只用于天气图形（§4） | 状态色、按钮、品牌 |

- 颜色从不单独承载含义：状态色旁边总有文字或图标（§10）。
- 需要中间色时用 `color-mix(in srgb, var(--a) N%, var(--b))`，两端都必须是 token；`--usage-*` 就是这样派生的，它们会自动跟随调色板。
- 阴影（`--shadow-sm/md/lg`）只给浮层；深色模式下层级靠明度（§3.5）。

### 3.3 Sky（默认调色板）

浅色是白昼的天，深色是同一片天的夜晚。

| 角色 | token | 浅色 · 白昼 | 深色 · 夜空 |
| --- | --- | --- | --- |
| 页面底 | `--bg` | `#f4f6f8` | `#0f131a` |
| 侧栏 | `--bg-sidebar` | `#eceff3` | `#0c1016` |
| 工作面 | `--surface` | `#ffffff` | `#171c26` |
| 抬升面 | `--surface-raised` | `#ffffff` | `#1f2531` |
| 凹陷面 | `--surface-sunken` | `#eef1f5` | `#12161e` |
| 分隔线 / 强分隔线 | `--border` / `--border-strong` | `#dfe4ea` / `#bcc5d1` | `#2a3240` / `#3b4659` |
| 正文 | `--text` | `#1b2330` | `#e8ebf1` |
| 次级文字 | `--text-2` | `#4f5a68` | `#b0b9c7` |
| 三级文字 | `--text-3` | `#626d7c` | `#8d98aa` |
| 强调 | `--accent` | `#2f6fd0` 晴空蓝 | `#8ab4f8` 月光蓝 |
| 强调文字 | `--accent-text` | `#2259ad` | `#a8c7fa` |
| 成功 = 晴 | `--success` | `#2c7a55` | `#7dcfa0` |
| 警告 = 太阳 | `--warn` | `#955c0a` | `#ecbc6b` |
| 危险 = 雷暴 | `--danger` | `#bd3f3a` | `#f28b82` |

### 3.4 其他调色板

每个调色板有一个明确的用途；新调色板必须说得出与已有几个的区别。

| 调色板 | 用途 | 中性色 | 强调色（浅 / 深） |
| --- | --- | --- | --- |
| Sky | 默认；清爽、通用 | 冷蓝灰 | `#2f6fd0` / `#8ab4f8` |
| Sand | 长时间阅读；暖、低眩光 | 暖纸色与墨色 | 赤陶 `#a84f28` / `#e9a47e` |
| Forest | 偏好绿色系、与蓝色工具区分 | 绿灰 | 深青 `#146b64` / `#6fd2c0` |
| Graphite | 信息最密、对比最强 | 纯中性灰（`#111111` 正文） | 靛紫 `#4a44c2` / `#aaa6ff` |

关键值（完整值以 `tokens.css` 为准）：

| 调色板 · 模式 | `--bg` | `--surface` | `--text` | `--text-3` | `--accent-text` | `--success` / `--warn` / `--danger` |
| --- | --- | --- | --- | --- | --- | --- |
| Sand 浅 | `#f6f3ee` | `#fffdf9` | `#27221b` | `#6a6155` | `#93441f` | `#3b7340` / `#8a5a0c` / `#b2382f` |
| Sand 深 | `#15130f` | `#1e1b16` | `#eee8de` | `#a29788` | `#efb593` | `#9fcf8a` / `#e7c06e` / `#f2907f` |
| Forest 浅 | `#f2f5f2` | `#ffffff` | `#17231b` | `#5a6a5f` | `#0f5f58` | `#3a7326` / `#8d5b08` / `#b33a37` |
| Forest 深 | `#0e1411` | `#151e19` | `#e4ede7` | `#8a9c91` | `#86dbcb` | `#a8d681` / `#e8c06a` / `#f1907f` |
| Graphite 浅 | `#f4f4f4` | `#ffffff` | `#111111` | `#545454` | `#403aaf` | `#24713f` / `#855400` / `#b5302b` |
| Graphite 深 | `#111111` | `#1a1a1a` | `#f2f2f2` | `#a2a2a2` | `#bab7ff` | `#84d4a2` / `#eec070` / `#f58e86` |

- **强调色不得与成功色同色相。** Forest 的强调是青、成功是黄绿，就是为了让“选中”和“成功”分得开。
- **天气色不随调色板变。** `--wx-*` 只按模式区分，一种天气在任何调色板里都是同一个颜色、同一个含义。
- **品牌云随调色板变**（用 `--accent` 填色，§2），favicon 与安装包图标不变。

### 3.5 深色模式的原则

- **低饱和中性色。** 中性色是低饱和的灰（Sky 蓝灰、Sand 暖灰、Forest 绿灰、Graphite 纯灰），长时间阅读不刺眼，也让强调色和天气色有空间。
- **用明度表达层级，不靠阴影。** `bg < surface < raised`，每一级都有可测的差（≥1.08:1 与 ≥1.15:1）。阴影只留给浮层。
- **强调色两用。** 作文字时 ≥4.5:1；作按钮底色时承载深色的 `--text-inverse` ≥4.5:1。
- **`-soft` 用半透明。** 深色下的 `--accent-soft`、`--success-soft` 等是 13–14% 的 rgba，叠在任何面上都成立。
- **天气色单独调过。** 夜里降水更亮、云更暗、太阳偏暖（`--wx-*` 的深色值）。

### 3.6 对比度底线 {#contrast}

每个调色板的两种模式都必须满足下面的底线，由 `apps/web/src/styles/contrast.test.ts` 直接解析 `tokens.css` 检查（调色板会合并到 Sky 之上再检查，并要求每个调色板在两种模式下都自己定义面、文字与强调色）：

- 正文在每个面上 ≥ 7:1；
- 次级文字、三级文字、强调文字、成功/警告/危险色在 `bg`、`surface`、`surface-raised`、`surface-sunken` 上都 ≥ 4.5:1（WCAG AA）；
- 语法色在 `code-bg`、`surface`、`surface-raised` 上 ≥ 4.5:1；
- 强调色、危险色作按钮底时，反色文字 ≥ 4.5:1；
- 分隔线 ≥ 1.25:1，强分隔线 ≥ 1.6:1；
- 深色层级：`surface` 对 `bg` ≥ 1.08:1，`raised` 对 `bg` ≥ 1.15:1。

改颜色时先跑 `pnpm exec vitest run apps/web/src/styles/contrast.test.ts`。测试解析的是 `--token: #rrggbb;` 形式，调色板里需要被检查的颜色必须写成六位十六进制。

### 3.7 新增或修改调色板的步骤

1. 在 `tokens.css` 末尾的调色板区，照现有块写 `[data-palette="x"][data-theme="light"]` 与 `…="dark"]` 两块，**覆盖同一组颜色 token**：面（`bg`、`bg-sidebar`、`surface*`）、悬停与按下、边框与焦点、四级文字、强调四件套、三种状态色及 `-soft`、代码三件套、七个语法色。不写 `--wx-*`、字号、尺寸。
2. 起点：先定中性色的色相，再从 `--text` 开始往下调到刚好过线，最后挑强调色并检查它作文字与作底色两种用法。
3. 在 `lib/display.ts` 的 `PALETTES` 里加 `{ id, label, description }`；描述是一句话，说用途而不是颜色名。
4. 跑对比度测试；在真实页面里按两种模式各截一张（对话、设置、工作台的 Changes），看 diff 增删色、状态点和链接。
5. 在本节的表里补上它，并更新 `CHANGELOG.md` 的 Unreleased。

## 4. 状态语言：天气

Agent 周围的天在做什么，就是 Agent 在做什么。每种天气只有一个含义，并且总有文字标签（`WEATHER_LABEL`，也是头像的无障碍名称）。

| 天气 | 含义 |
| --- | --- |
| 晴 | 就绪 |
| 多云 | 思考（模型在生成） |
| 小雨 / 大雨 | 一个 / 多个工具或子 Agent 在运行 |
| 雪 | 等你：审批或问题待回答 |
| 雨夹雪 | 瞬时失败后在重试 |
| 雷暴 | 出错 |
| 雾 | 上下文将满 |
| 彩虹 | 刚刚成功完成（约 3 秒） |
| 红色精灵 | 正在派出子 Agent |

优先级：等你 > 出错 > 正在发生的事 > 环境 > 余韵。角色只缩小以让出天空，形状、颜色、眼睛不变；表情只做微调（雪时抬眼、雷暴眯眼、彩虹笑眼）。动效在 `prefers-reduced-motion` 下全部停止。实现：`lib/weather.ts`、`components/WeatherLayer.tsx`、`components/AgentAvatar.tsx`；开发服务的 `/weather.html` 是校准页。

## 5. 主要界面

### 5.1 对话

- 普通 Session 不使用气泡：用户消息靠右，Agent 回复靠左，左侧是带天气的头像。Project 里只有**用户**的消息是气泡（靠右、无描边无阴影、底色 `--surface-raised`、上方一行时间）；协调者与 Thread 的回复是铺满对话列的普通正文，**没有头像、没有气泡、没有作者行**，把空间留给内容；连续消息之间留 4–6px，不把多条消息拼成一大段。
- 进行中的回合保留 Agent 的叙述文字，连续的工具调用折叠成一行，行上写当前步骤（"Reading c.ts · 3 steps"），点开才看每一步。
- 回合结束后，最终答复之前的过程（叙述与工具）一起折叠成一行（"Used 4 tools"），只留最终答复、改动文件与需要你处理的警告。
- 全应用使用同一字号阶梯（§6.1）：常规界面 13.5px，对话正文与输入 14.5px、1.6 行高，工具详情 12.5px，元数据 11.5px；标题 19 / 25px。Project、Session 和工作台沿用同一套 token：工作台里的 Thread 与 Agent 通信用和主对话**相同**的正文字号，不再缩小一号。
- **转派气泡**（2026-10-09 起）：Thread 对话与「Messages with …」里，启动这个 Thread 的 Agent（通常是协调者）发给它的消息画在**用户一侧**：靠右、`--border-strong` **虚线**描边、无底色、文字 `--text-2`，上方一行是发送者名字与时间（`ChatRun` 的 `side="relay"`）。它和你的消息一样是给 Thread 的指令，但不是你写的，所以用虚线而不是实心气泡区分。派工消息本身就是 Brief，显示了派工气泡时不再另放折叠的 Brief；Thread 发给协调者的汇报仍只在「Messages with …」里。
- Project 主对话里，协调者把工作交给 Thread（或 Thread 第一次回话）的地方是一张 **Thread 链接卡**：状态灯 · 标题 · 状态 · 箭头，点开在工作台打开该 Thread；每个 Thread 只在它第一次出现的地方放一张卡，卡上的状态是实时的。协调者在正文里提到 Thread 时写成 `[标题](#thread:<id>)`，渲染为带状态灯的链接，同样打开 Thread。Thread 与协调者之间的往来在 Thread 工具栏的「Messages with …」里查看（工作台的通信标签，按发送者分组，只有名字没有头像）；文档标签不跨重载保留，通信内容从 Box 快照恢复。
- 消息中的 Markdown 文件引用、带目录的裸文件路径与文件型行内代码可打开工作台；文本进 Files，图片、PDF 与 Office 文件进预览。本地开发地址进 Browser，公开网站作为外链打开。代码块保留原文。

### 5.2 输入区与图片

- Project 输入区只显示一个主按钮：有内容时是发送（异步消息）；内容为空时，只有收件方正在运行才是停止，空闲时是禁用的发送——不显示一个用不了的停止按钮。`Ctrl+Enter` 可停止当前运行并发送改向消息，`Esc` 停止当前运行。

- 输入区是主要抬升面。图片可以点按钮添加、粘贴或拖入；先缩到长边 1568px 再上传（大图转 JPEG），每条消息最多 8 张。
- 缩略图在输入框上方，悬停出现删除。所选模型被配置为不接收图片时，缩略图旁会提示。
- 图片的取舍属于模型层，界面不做猜测：除已知纯文本模型外，一律把图片发给模型；提供方拒绝时，适配器去掉图片重试一次，之后对这条路由只发文字说明。System Config 的 `vision`（顶层或单条路由）可以显式指定。

### 5.3 工作台（Workbench）

对话是**谈论**工作的地方，工作台是工作**本身**所在的地方。Agent 和你共同操作的一切——工作区文件、改动、终端、浏览器，以及从对话里打开的文档和子 Agent 记录——都在右侧同一个面板里，不再各自开抽屉。

- **Project 产物例外**：从消息或 Library 打开的产物保留弹窗预览，左侧产物、右侧生成它的 Thread，复用现有预览与 ThreadPanel。弹窗几乎占满窗口：标题行只出现一次（类型图标 · 标题 · `类型 · 大小 · v版本 · Thread`），整件产物的动作放在标题行右侧（引用选中文字、查看最新版本、下载）；左侧是 `--surface-sunken` 的舞台，文档画成居中的「纸」（`--surface`、`--reading-width`、正文 `--text-lg`），页面类产物铺满舞台并可切换「Page preview / Select from source」；右侧 Thread 栏宽 `clamp(360px, 32%, 520px)`，不再重复显示产物条。一个 Thread 可以维护多个产物；修订沿用产物身份和归属。打开不触发模型请求。两侧独立滚动，关闭恢复焦点。文本、Markdown、代码可以引用实际选中的原文；HTML 可切换源码引用，不扩大 iframe 权限。引用可取消，仅在用户发送时连同所见版本提交。
- **入口**：会话顶栏只有一个工作台按钮（面板图标），角标是相对上次提交改动的文件数。`Ctrl+J` 开关工作台，`` Ctrl+` `` 直接打开终端。Agent 开始用浏览器时自动切到 Browser；对话里"N files changed"卡片上的每个文件点开即是它的 diff；Office 文件卡片点开是预览标签。
- **一种形状**：每个视图都是 **标签栏 → 工具栏行 → 圆角卡片**。标签栏先是固定的工具（Files · Changes · Terminal · Browser），竖线之后是可关闭的文档标签（文件预览、子 Agent 记录），同一文档不会开两次。工具栏行左边是上下文（路径、分支、会话），右边是动作；工具内部的多实例（浏览器页面、多个终端）用同一种**子标签胶囊**。内容一律放进圆角卡片：代码、终端与 diff 用 `--code-bg`，文档与页面用 `--surface`。**Project 的面板是阅读面**（Thread、Agent 通信、Board、Library、Routines、Project 设置）：内容用 `.wb-card.wb-flow` 从工具栏下的一条分隔线开始铺满面板，底色 `--bg`，不再套第二层带边框的卡片——和旁边的对话连成一片（2026-10-09 起）。
- **底色与层级**：工作台外框用和对话相同的 `--bg`（不是侧栏灰），与对话之间只有一条 `--border` 竖线。工具栏标题是 `--text` + 600（Thread 名用 `--text-lg` + 650）；面板内的区块标题是句首大写的 `--text-md` + 650 + `--text`，数量跟在后面用 `--text-3`，**不用全大写的小号灰字**；Board 以项目名（`--text-xl` + 700）和一句天气（带状态灯）开头。
- **左右分栏**：Files 与 Changes 用同一种布局——左边列表（目录树 / 改动文件），右边详情（编辑器 / diff），选中项用 `--accent-soft`。
- **Files**：懒加载目录树（headless-tree）+ CodeMirror 6 编辑器，`Ctrl+S` 保存；磁盘上的文件在打开后被改过（比如 Agent 改了）时拒绝覆盖。
- **Changes**：相对 HEAD 的改动，状态字母（M 警告色、A/U 成功色、D 危险色、R 强调色）与 `+n −n`；diff 用 `@codemirror/merge`，可切换合并 / 并排视图，长段未改动内容折叠；增删着色只用 `--success-soft` / `--danger-soft`。可见时每 5 秒刷新，Agent 的改动随写随现。非 git 工作区给出说明而不是空白。
- **Terminal**：你自己的 shell（Windows 上优先 PowerShell 7），跑在真实 PTY 上（node-pty + xterm.js），不经沙箱、不是 Agent 工具。切换标签不会断开，重新连接时回放最近的输出。终端配色从 token 读取，随深浅主题切换。
- **Browser**：见 5.4。
- **标签栏就是标题栏那一行**：高 `--header-h`，与会话顶栏、侧栏顶部和桌面端原生窗口按钮在同一条中线上；工作台顶部不留内边距。标签多到放不下时用滚轮或触控板横向滚动，选中的标签自动滚入视野；**不显示滚动条**（Windows 上的原生横向滚动条会撑高这一行，把标签挤离中线）。
- **记忆与宽度**：开关状态与当前工具在重载后保留，文档标签不保留。左边缘可拖动调整宽度并被记住（最窄 420px，最宽为窗口的 72%，默认 `--workbench-default` = `clamp(420px, 40vw, 760px)`，在 1920px 宽的窗口里和对话列差不多宽；旧版本保存的更窄宽度在读取时抬到 420px）；工具标签只显示图标，选中的那个显示名称（见 5.5）；窗口窄于 1100px 时工作台浮在对话之上。

### 5.4 Agent 浏览器

- 浏览器是工作台里的 Browser 工具。工具栏行是页面子标签（标题、关闭、新建；Agent 也能用 `browser_tabs` 开关与切换标签），其下是导航行（后退、前进、刷新、居中的地址胶囊、元素选择器），页面放在**圆角卡片**里。你可以和 Agent 同时浏览同一组标签。
- **元素选择器**（光标图标）：在页面上悬停会描出元素边框，点击后把这个元素作为一个上下文 chip 和一张裁剪截图放进输入区；发送时 chip 的描述（URL、标签、文本、选择器、HTML 片段）随消息交给模型，时间线里以同样的 chip 显示。选择时的点击不会触发页面上的按钮，Esc 取消。
- **桌面端**：每个标签是一个原生视图，叠在卡片上并带同样的圆角。菜单、对话框、图片查看器盖到面板上时，视图会暂时让开。
- **网页端**：服务端的浏览器以 headless 运行，页面按卡片的实际尺寸渲染，用 CDP screencast 把画面推到面板里；点击、滚轮、键盘与粘贴回传到页面。System Config 设 `browser.headless: false` 可以改回独立窗口。
- 两端都不弹出独立的浏览器窗口。


### 5.5 密度

2026-10-08 起界面默认使用紧凑密度（设计稿：[`redesign.html`](redesign.html)），用户可在设置里改成 Comfortable（§6）。尺寸只来自 `tokens.css` 的密度 token，组件**不得**写裸高度，否则不会随密度设置变化：

| token | Compact（默认） | Comfortable | 用于 |
| --- | --- | --- | --- |
| `--header-h` | 32px | 32px（不变） | 会话顶栏、工作台标签栏；等于桌面端 `TITLE_BAR_HEIGHT`，原生窗口按钮正好落在顶栏里 |
| `--toolbar-h` | 28px | 32px | 工作台工具栏行、代码块头 |
| `--control-lg` / `--control` / `--control-sm` | 32 / 26 / 22px | 36 / 30 / 26px | 大输入框 / 常规按钮、输入框 / 小按钮、chip、工具行 |
| `--row-h` | 26px | 32px | 会话、菜单、项目列表行 |
| `--icon` / `--icon-sm` | 14 / 12px | 15 / 12px | 图标只有这两种尺寸（侧栏除外）；空态插图 18px |
| `--nav-row-h` / `--nav-icon` | 30 / 16px | 34 / 17px | 只用于左侧栏：会话与项目行、搜索、顶部与底部按钮的图标 |

- 图标是 lucide 细线（描边 1.75），静止时用三级文字色，颜色只表达状态；工具行图标不再垫底色方块。
- 头像：对话回合 18px；Project 不画头像（§2）。
- 顶栏只有一行：标题 · 工作区。顶栏贴着窗口右上角时用 `.window-controls-header` 给原生按钮让位。
- 工作台的工具标签只显示图标，选中的那个显示名称；名称始终在提示和无障碍标签里。

### 5.6 侧栏：按工作区组织

- 侧栏宽 `--sidebar-width` = 264px，是一眼扫过的导航，所以比其他界面大一号（2026-10-09 起）：行高 `--nav-row-h`，图标 `--nav-icon`（lucide 的 `size` 只是默认值，尺寸由 CSS 统一设定），会话与项目标题用 `--text-lg`，当前项 600；工作区分组名 `--text-md` + 650；时间 `--text-xs` + `--text-3`。搜索框与底部按钮高 `--control-lg`。

- 侧栏是工作区树：每个工作区一个可折叠分组，组内先列项目（看板图标，强调色），再按最近时间列会话；默认显示 8 条会话，其余与已归档项目收在 “N more” 里。折叠状态存在 `tnega.sidebar.collapsed`。
- 没有工作区切换卡片，也没有 Sessions / Projects 切换：点开任何分组里的会话或项目，就切到它所在的工作区并打开它。当前工作区的列表来自应用本身（实时）；其他展开的工作区在打开时各自加载。
- 工作区行悬停时出现“新建项目 / 新建会话 / 更多（移出列表）”；“Add workspace”在侧栏底部，与设置、主题并排，只显示图标（名称在提示与无障碍标签里），侧栏再窄也不会压到主题切换。
- 搜索同时过滤所有工作区的项目与会话，搜索时折叠的分组也会展开。

### 5.7 Project 屏幕的密度

- 房间里的 Thread 卡片是一行（约 30px）：状态灯 · 标题 · 状态 / 当前步骤 · 箭头，悬停在卡片右侧出现「回复」。当前步骤优先取 Thread 的清单；没有清单时用它最近一次工具调用的几个字（“Editing count.mjs”“Running node --test”）。
- **状态灯**（`components/StatusLight.tsx`，`threadLight` / `projectLight`）是天气的最小形态，一种颜色只有一个含义：等你或被阻塞（雪）= `--warn` 带光晕；出错（雷暴）= `--danger` 带光晕；工作中（雨）= `--accent` 缓慢明灭（减弱动效时静止）；有你还没打开的结果 = `--success`；其余为 `--border-strong` 的灰点。灯总带文字（无障碍名称与提示）。用在：房间的 Thread 卡、正文里的 Thread 链接、Board 卡片与 Today 行、侧栏的项目行——侧栏只在有 Thread 等你、失败或工作中时亮灯（优先级同 §4），数据来自 `GET /api/projects` 的 `threads` 摘要。
- **推送与 PR 卡**（`project/GitCard.tsx`）：Thread 用 shell 执行 `git push` 或 `gh pr create` 后，服务端按命令输出记一条带 `git` 的 Library 资源，界面画成一行卡片：图标（分支 / PR）· 标题（“Pushed feature-x”“Pull request #12”）· 仓库 · Thread · 时间 · 状态胶囊（Pushed / Opened 成功色，Up to date 中性，Rejected / Failed 危险色，失败时元数据换成错误行）· 「Open」在浏览器打开（PR、建 PR 的页面或分支页；本地或代理远端没有网页就不显示）。同一分支再推送更新同一张卡。卡片出现在主对话里（按最近变化的时间）、该 Thread 的产物区与 Library 的「Pushes and pull requests」。状态只反映命令本身的结果，不查询代码托管平台。
- 协调者与 Thread 的消息完整显示，不使用 “Show more” 或行数裁切；简洁表达由 Agent 的沟通指令负责，不由界面隐藏消息。
- Board（2026-10-10 起，`project/Board.tsx`）从上到下：项目名与一句天气 → **形状条**（每个 Thread 一段，颜色同它的状态灯：Resolved `--text-3`、Idle `--border-strong`、Ready `--success`、Working `--accent` 缓慢明灭、Needs you `--warn`，失败 `--danger`；已完成的从左边填起，右侧写 `n of m done`）→ 一行无边框的 Today：started · finished · outputs · tokens → 泳道 Needs you / Working / Ready（标题前带状态点；宽面板并排时空泳道写一句“Nothing waiting on you / No thread running / No new results”）→ Idle 与 Resolved 收成一行，点开一起显示 → **Recently**：最近 4 件事（started / reported / finished / asked / got blocked / failed / added / pushed / opened pull request），一行一件，图标 + Thread 名 + 动词 + 灰色摘要 + 时间，点击打开该 Thread。
- Board 卡片：状态灯 · 标题（整张卡的点击区）· 进展一行（Needs you 的问题或失败原因给两行，其他一行）· **分段清单**（每步一段：完成为强调色、当前步淡强调色且只在 Working 时明灭、未做为凹陷色；超过 12 步退回一条进度条）`n/m` · **产物 chip**（最新 3 个，含推送与 PR；产物点开预览，推送 / PR 在浏览器打开，其余收成 `+N` 打开 Thread）· 底部 `动词 + 时间`（Asked / Failed / Updated / Reported / Resolved）· 活跃时长 · tokens。不加头像、不加新的状态色。

## 6. 字号与信息显示偏好

### 6.1 字号阶梯

字号只来自 `--text-*`。新代码**不得**写裸 `font-size: Npx`（相对单位 `em` 用于 Markdown 内的标题与行内代码可以）；已有的裸像素值在碰到时顺手换成最近的 token。

| token | Small | Default | Large | 用于 |
| --- | --- | --- | --- | --- |
| `--text-xs` | 11px | 11.5px | 12.5px | 元数据：时间、计数、徽标 |
| `--text-sm` | 12px | 12.5px | 13.5px | 工具详情、表单说明、表格 |
| `--text-md` | 12.5px | 13.5px | 15px | 常规界面：按钮、列表、菜单 |
| `--text-lg` | 13.5px | 14.5px | 16px | 对话正文与输入（行高 1.6）、侧栏行 |
| `--text-xl` | 19px | 19px | 21px | 区块标题 |
| `--text-2xl` | 25px | 25px | 27px | 页面标题、欢迎页 |

**界面字体是 Nunito**（`--font-sans`，可变字重，由 `@fontsource-variable/nunito` 随应用打包，桌面端离线与各操作系统显示一致；中文回落到系统字体）。它是圆润、字怀开阔的无衬线体，小字号也好读；同字号下比 Inter 略小，所以 2026-10-09 起字号阶梯整体上调半档。Nunito 的常规字重在屏幕上偏细，`body` 用 450。

字重以 450 / 500 / 600 为主；700 只留给极小的徽标数字。等宽字体（`--font-mono`）只给代码、路径、命令、哈希与对齐的数字列。

### 6.2 显示偏好

“信息显示”的设置都是根元素属性，由 `lib/display.ts` 写入、`tokens.css` 映射到 token，组件不需要知道当前选了什么：

| 设置 | 属性 | 取值（默认加粗） | 改变的 token |
| --- | --- | --- | --- |
| Colour palette | `data-palette` | **sky** / sand / forest / graphite | 颜色（§3） |
| Density | `data-density` | **compact** / comfortable | `--toolbar-h`、`--control*`、`--row-h`、`--icon` |
| Text size | `data-text-size` | small / **default** / large | `--text-*` |
| Conversation width | `data-reading` | narrow 660 / **standard 780** / wide 1000 / full | `--reading-width` |

- 存储键是 `tnega.palette`、`tnega.density`、`tnega.textSize`、`tnega.readingWidth`，按设备保存，不进 System Config。
- 要让新界面响应这些偏好，**只需用对 token**：高度用密度 token，字号用 `--text-*`，阅读列宽用 `--reading-width`。不要在组件里读 `useDisplay()` 再分支。
- 新的显示偏好按同样的方式加：`display.ts` 的类型、`DISPLAY_OPTIONS`、`DISPLAY_KEYS`，`tokens.css` 的属性块，`index.html` 的首帧脚本，设置面板的 `ChoiceField`，以及 `display.test.ts`。偏好只调 token，不改信息的有无。

## 7. 信息显示原则

Tnega 的界面上同时有很多 Agent、很多步骤、很多文件。目标是**一眼看到要紧的事，需要时一步看到细节**。

### 7.1 层级

- 每一块界面先回答一个问题（“它在做什么”“要我做什么”“结果是什么”），答案放在最显眼处：`--text` + 500/600 字重。其余是元数据，用 `--text-3` + `--text-xs`/`--text-sm`，排在同一行的末尾或下一行。
- 一行只放一个主信息。标题一行、进展一行，超出用省略号截断，完整内容放在 `title` 提示里（路径、长标题都这样做）。
- 需要用户处理的东西（审批、问题、错误）永远排在最前，并有天气或状态色 + 文字双重标识；“等你”优先于“出错”优先于“进行中”（与 §4 的优先级一致）。

### 7.2 渐进展开

- 过程默认折叠，结论默认展开：工具调用折成一行并写当前步骤，回合结束后过程折成 “Used N tools”（§5.1）；协调者与 Thread 消息始终完整显示（§5.7）。
- 折叠行必须告诉人里面有什么（步骤名、数量），而不是只写 “Details”。展开状态不需要跨重载保留。
- 列表默认显示有限条数（侧栏 8 条），其余收进 “N more”；数量写在按钮上。

### 7.3 数字、时间与单位

- 用现成的格式化函数，不要各写一份：`formatTokens`、`formatDuration`（`lib/timeline.ts`），`formatCount`、`formatActive`、`formatBytes`（`lib/project-model.ts`），`formatElapsed`（`lib/background-tasks.ts`），`relativeTime`（`lib/hooks.ts`）。
- 会变化或要对齐的数字加 `font-variant-numeric: tabular-nums`，避免跳动。
- 近期时间用相对时间（“3m ago”），完整时间放在提示里；计数大于 999 用 k/M 缩写。
- 数字与单位之间用窄格式：`12k tokens`、`3/5`、`+12 −4`。

### 7.4 状态与空态

- 状态 = 颜色 + 形状/图标 + 文字，三者至少两个，文字必不可少（可以只在无障碍标签里）。
- 加载用骨架或细进度，不用整页转圈；超过约 1 秒的操作要有文字说明在做什么。
- 空态说明“这里会出现什么、怎么让它出现”，并给一个直接的动作；非错误的空态不用危险色。
- 错误写清发生了什么与下一步，用 `.notice-error` 或 `.form-error`，不弹 alert。

### 7.5 宽度与密度

- 阅读内容（对话、文档）用 `--reading-width` 限宽；表格、diff、终端、日志不限宽，让它们用满可用空间并可横向滚动。
- 不为了“好看”加大留白：间距只用 `--space-*`，同类元素之间的间距保持一致。

## 8. 组件与样式复用

前端实现优先复用已有组件与类；没有直接适用的，沿用最相近页面的结构和行为，**不新造一套视觉**。

| 需要 | 用 |
| --- | --- |
| 按钮 | `.button` + `.primary` / `.secondary` / `.ghost` / `.danger`，尺寸 `.small` / `.large`；只有图标时用 `.icon-button`（`.small` / `.tiny` / `.active`），并写 `aria-label` |
| 菜单、下拉、单选列表 | `components/Menu.tsx` 的 `Menu`、`Choice`、`SectionChoice`、`choiceSection` |
| 对话框 | `components/Dialog.tsx`；确认用 `lib/dialogs.ts` 的 `confirmDialog`，不用 `window.confirm` |
| 表单 | `.form-grid` 两列 + `.field`（`.span-2` 占满）+ `.field-label`；说明文字 `.muted.small`；复选 `.field-check` |
| 少量互斥选项（2–4 个） | 设置里的 `ChoiceField`（`.settings-choice-row` + `.settings-choice`，`role="radiogroup"`）；更多选项用 `<select>` |
| 键值摘要 | `.effective-card` + `.effective-row` |
| 提示条 | `.notice` + `.notice-info` / `.notice-warn` / `.notice-error` |
| 小标签、过滤器 | `.chip`（`.chip-danger`）、`.pill`（`.pill-danger`） |
| 空态 | `.empty-state` |
| 头像与状态 | 会话里用 `components/AgentAvatar.tsx` + `WeatherLayer.tsx`；Project 里用 `components/StatusLight.tsx`（§5.7），不再另画其他状态点 |
| 新的文件 / 改动 / 终端 / 浏览器 / 文档类视图 | 工作台的工具或文档标签（§5.3），不开新抽屉 |

- 图标只用 lucide，尺寸取 `--icon` / `--icon-sm` 对应的 14 / 12，描边 1.75。
- 交互元素必须能用键盘到达，有可见焦点，有可读的名字（文字或 `aria-label`）；互斥选项用 `role="radio"` + `aria-checked`。
- 新样式写进对应文件：通用控件进 `app.css`，Project 进 `project.css`，工作台进 `workbench.css`；类名用组件前缀（`.palette-card`、`.bg-task-*`）。

## 9. 设置

设置对话框（`components/SettingsDialog.tsx`）左侧是分区，右侧是面板。

- 新选项放进它所配置的那个分区；全新的一类设置是 `SECTIONS` 里多一项加一个面板，分区描述一句话说清它管什么。
- **两种保存方式，不要混用：** 写入 System Config 的选项（模型、审批、工具）进表单状态，由 “Save changes” 一起保存；只影响本设备显示的选项（模式、调色板、密度、字号、宽度、更新）立即生效、存 localStorage，不经过 Save。
- 选项的标签用名词（“Text size”），选项值用短词（“Large”）；后果写在下方一行 `.muted.small` 说明里。
- 每个新设置至少有一个测试（`SettingsDialog.test.ts` 或对应 lib 的测试）覆盖“选了之后发生什么”。

## 10. 动效与无障碍

- 动效是轻微、循环的状态提示：天气、思考中的浮动、眨眼。不用动效表达唯一的信息。
- 所有动效遵循 `prefers-reduced-motion`；过渡时长只用 `--duration-fast` / `--duration-med` 与 `--ease-out`。
- 焦点必须可见：`--border-focus` 加 `--accent-soft` 光晕。
- 颜色之外总有文字或形状区分状态。
- 在 Large 字号与 Comfortable 密度下界面不得出现文字重叠或被裁掉的控件；在 Small 字号下正文仍可读。

## 11. 改动前后清单 {#checklist}

动手前：

1. 读本文相关章节（§0 的表）与要改的模块及其测试。
2. 找到最相近的现有界面，决定复用哪些组件和类（§8）。
3. 新状态先问：它是不是已有的某种天气？不要给同一种天气赋第二个含义（§4）。

提交前：

1. 没有裸色值、裸字号、裸控件高度；颜色只改 `tokens.css`，**所有调色板的两种模式**同步，并跑对比度测试。
2. 在真实页面里至少看过：浅色与深色；Sky 与另一个调色板；Large 字号 + Comfortable 密度。截图与校准用 `/weather.html` 和真实页面，不用脱离实现的效果图。
3. 新图形沿用扁平语言：实心色块、无描边、16px 可辨。
4. 改标志时同步改 `--brand-cloud` / `--brand-eyes`、favicon 与 `apps/desktop/build/icon.svg`，并重新生成安装包图标。
5. 测试与源文件同目录，覆盖用户可见的行为；跑 `pnpm exec vitest run apps/web`。
6. 用户可见的变化写进 `CHANGELOG.md` 的 Unreleased；改变了设计规则的，同一次改动里更新本文。
