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
| 改终端界面（`packages/tui`） | §5.8 终端界面 |

规则里写“必须 / 不得”的是硬性要求（大多有测试守着）；写“优先 / 默认”的是可以有理由偏离的默认做法，偏离时在代码注释里写理由。

## 1. 设计主张

Tnega 是一个让人长时间和 Agent 一起工作的地方。界面要**安静**：导航退后，对话与产物居中；状态要**一眼可辨**：Agent 在想、在做、在等你还是出了错，不读文字也能看出来；能力要**就在手边**：图片能直接贴进来，Agent 打开的网页就在旁边的面板里。

## 2. 标识：云

- 品牌标志是一朵带两只白眼睛的**云**：在 Tnega 里工作的 Agent 本身，与会话主 Agent、Project 协调者的头像同形（`AgentAvatar` 的 `cloud`）。扁平、单色、无描边；天气发生在云的周围。
- 2026-10-05 起取代原先「方块上歇着一朵云」：方块加云在任务栏上与天气角标叠成了两朵云，也不如单独的云可爱。
- 任务栏角标（`apps/desktop/build/completion-*.png`，由 `scripts/render-completion-icons.mjs` 生成）只画天气本身——雨滴、闪电、雪花，放在小深色圆片上——不再画云，任务栏上始终只有一朵云。桌面通知不闪烁任务栏按钮（Windows 把它画成橙红色，像警报），提示音是应用自己合成的两声轻音，不用系统提示音。
- 来源：
  - 品牌标志：`apps/web/src/styles/app.css` 的 `--brand-cloud`（云形遮罩）与 `--brand-eyes`（眼睛），云用当前调色板的 `--accent` 填色，眼睛从云上镂空（`mask-composite: exclude`），露出背后的底色，所以在任何调色板和明暗下都看得见；favicon 与安装包图标（2026-10-12 起）是深色圆角方块上的白云，眼睛同样是方块的底色。
  - favicon：`apps/web/index.html`。
  - 安装包图标：`apps/desktop/build/icon.svg`，用 `node apps/desktop/scripts/render-icon.mjs` 生成 `icon.png` 与多尺寸 `icon.ico`。
- 会话主 Agent 画成强调色的云；会话里的子 Agent 保留随机的形状和颜色（圆、软方、斜方、软糖、云、水滴），便于区分。
- **Project 里不画 Agent 头像**（2026-10-09 起）：Project 是任务驱动的，协调者只负责转派，Thread 用标题和状态灯辨认，不用头像（§5.7）。

## 3. 色彩：模式 × 调色板

所有颜色只来自 `apps/web/src/styles/tokens.css`，组件**不得**写裸色值（`#hex`、`rgb()`、命名色）。唯一的例外是 `tokens.css` 本身、品牌 SVG 数据 URL 里的白眼睛，以及需要具体颜色值的第三方库——它们在运行时从 token 读取（终端 `TerminalView.themeFromTokens`、桌面标题栏 `desktop-chrome.ts`、Mermaid 图的 `--pele-*`）。

### 3.1 两个独立的轴

| 轴 | 根元素属性 | 取值 | 谁决定 |
| --- | --- | --- | --- |
| 模式 | `data-theme` | `light` / `dark` | 设置里的 System / Light / Dark；System 跟随 `prefers-color-scheme`（`useTheme`，`lib/hooks.ts`） |
| 调色板 | `data-palette` | `carbon`（默认，2026-10-12 起）/ `sky` / `sand` / `forest` / `graphite` | 设置 → Appearance → Colour palette（`useDisplay`，`lib/display.ts`） |

- 模式决定明暗，调色板在该模式内换**中性色、强调色、状态色与语法色**。两者自由组合，共 10 种外观，每一种都必须通过 [§3.6](#contrast) 的底线。
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
| 强调 | `--accent` | 主按钮底、链接下划线、品牌云、小的状态点 | 大段文字（用 `--accent-text`）；选中项与悬停的描边、拖动条（见下） |
| 强调文字 | `--accent-text` | 链接、选中项文字 | 底色 |
| 强调浅底 | `--accent-soft` | 选中项、当前标签、焦点光晕 | 警示 |
| 成功 = 晴 / 警告 = 太阳 / 危险 = 雷暴 | `--success` `--warn` `--danger`（及 `-soft`） | 状态文字、状态点、diff 增删、危险按钮 | 装饰、品牌 |
| 代码 | `--code-bg` / `--code-border` / `--syntax-*` | 代码块、编辑器、终端、diff | 普通卡片 |
| 用量色阶 | `--usage-0…4` | 用量热力图 | 其他图表的系列色 |
| 图表系列色 | `--series-system/tools/user/injected/assistant/results/output/other` | 上下文构成与耗时的环图、堆叠条、趋势柱（Context 工具、Context insights） | 状态、按钮、文字；它们借用 `--syntax-*`，随调色板与明暗自动变化，不另写色值 |
| 天气 | `--wx-*` | 只用于天气图形（§4） | 状态色、按钮、品牌 |

- 颜色从不单独承载含义：状态色旁边总有文字或图标（§10）。
- **选中不描强调色**（2026-10-12 起）：选中的卡片或选项（打开中的 Thread 卡、默认模型路由、调色板、设置选项、问题选项）用 `--border-strong` 描边加 `--accent-soft` 底；工作台的拖动条悬停时是 `--border-strong` 细线。Carbon 的 `--accent` 是墨色（深色下近白），一圈强调色描边读作粗白框 / 粗黑框，压过了内容。焦点环仍用 `--border-focus`。
- 需要中间色时用 `color-mix(in srgb, var(--a) N%, var(--b))`，两端都必须是 token；`--usage-*` 就是这样派生的，它们会自动跟随调色板。
- 阴影（`--shadow-sm/md/lg`）只给浮层；深色模式下层级靠明度（§3.5）。
- **浮层外壳是玻璃**（2026-10-16 起）：菜单、`/` 面板、上下文用量气泡、表情菜单，以及对话框遮罩，用 `--glass-surface`（`--surface-raised` 以 `--glass-alpha` = 0.8 叠在底下）+ `backdrop-filter: blur(12px) saturate(1.4)`（`--glass-blur` / `--glass-saturate`），背后的画面透上来但不挡住内容。α 就是这笔交易的价码：0.8 时材质一眼可见，而且**对着本应用自己会画在浮层后面的每一张面**（`bg`、`bg-sidebar`、`surface`、`surface-raised`、`surface-sunken`、`code-bg`）正文仍 ≥7:1、其余角色仍 ≥4.5:1，由 `apps/web/src/styles/glass.test.ts` 逐个调色板检查。代价写在这里不藏起来：浮层压在一张照片、浏览器视图或别的窗口上时，正文可能降到约 6.5:1、三级文字约 2.7:1。
- 玻璃只用在**外壳**上：正文所在的卡片、对话、侧栏与工作台保持不透明（`glass.test.ts` 也检查这一点）；浮层里的滚动条与吸顶标头（如 `/` 面板的标题行）用不透明底，否则滚动的行会透过来。唯一例外是 `full` 模式下的对话阅读面：它让出底色，见下一条。
- 系统偏好 `prefers-reduced-transparency: reduce` 时全部玻璃退回不透明（`app.css` 的 Glass 段）。新增玻璃浮层要同时加进那份清单，否则 `glass.test.ts` 会失败。
- 设置 → 外观 → **玻璃**（display.ts 的 `glass`，写在 `<html data-glass>` 上）决定材质铺多广：
  - `floating`（默认）：只有浮层是玻璃，正文面保持不透明；
  - `full`：应用的整套外壳（侧栏、对话顶栏、输入框卡片、工作台卡片）也换成 `--glass-surface` + 同一套 blur/saturate。它铺在普通的页面底色上，**不画背景光晕**（2026-10-21 起）：之前 `body::before` 的三段径向渐变在深色 Carbon 上读作窗口边缘的暗角，也让原生窗口按钮和旁边的顶栏不同色，按用户决定去掉。玻璃顶栏把材质画在 `::before` 上（见下），桌面端工作台上方的标题条（`.wb-titlebar`）用同一层玻璃，和左边的顶栏是同一条栏；`lib/desktop-chrome.ts` 取窗口按钮颜色时也算上这层 `::before`，按钮因此与它所在的栏同色。玻璃顶栏底部的细线画在顶栏**下面**（`box-shadow: 0 1px 0 var(--border)`，不用 `border-bottom`，2026-10-23 起）：原生窗口按钮条和顶栏一样高，画在顶栏里面的线（以及玻璃盖不住的透明边框那一行）会在 – ☐ ✕ 下面断掉，让按钮看起来像单独的一块。
    - 对话阅读面（`.conversation`）在这个模式下让出底色，否则它会盖住那层渐变，整个模式看起来仍是纯色；
    - 输入区（`.conv-dock`）不是一条独立的玻璃带（2026-10-20 起）：它和默认主题一样没有底色、没有分隔线，只有输入框卡片是玻璃；默认主题在输入框上方把正文淡入 `--bg`，这里改为给 `.conv-scroll` 底部 22px 加遮罩，让正文自己淡出，透出背后的底色；
    - 工作台同理（2026-10-20 起）：`.workbench` 的底和工作台里本身就是对话或 Project 视图的面板（`.wb-card.wb-flow`：Thread、交流、Board、Library、Routines）也让出底色，工作台卡片的玻璃才看得见；文件、改动等框起来的卡片保持不透明；
    - 对话框不做玻璃（2026-10-20 起）：它已经压在磨砂的遮罩上，再叠一层玻璃会把浅色对话框染成灰色（Sky 浅色下三级文字跌到约 4.2:1），白色输入框在灰底上也显得斑驳。对话框在所有模式下都是不透明的 `--surface-raised`；
    - 顶栏的玻璃画在 `::before` 上：顶栏一旦自己成为 backdrop root，它里面的菜单既失去模糊，又会在 Chrome 里被排在带动画的正文行下面；弹出层在玻璃外壳内改用不透明的 `--surface-raised`，保证任何合成路径下都可读；
  - `off`：整个应用不透明（等同于系统「降低透明度」的结果）。
- `glass.test.ts` 守住这些不变量：每个 `--glass-surface` 规则都必须带 blur；每一条玻璃规则都必须出现在「降低透明度」的退回清单里；默认模式下正文所在的表面仍然不透明，`[data-glass="full"]` 之外的规则不得给它们上材质；对话框在任何模式下都不是玻璃；`full` 模式下对话、工作台与其对话类面板让出底色。对比度底线的「背后的面」也包括选中项底色 `--accent-soft`。
- 桌面端标题栏颜色随 `data-glass` 一起重算（`lib/desktop-chrome.ts`），切换玻璃模式后窗口控制区不会留着旧底色；取色始终取顶栏（窗口按钮所在的那条栏），面板折叠途中不会先闪成页面底色（2026-10-24 起）。


### 3.3 Sky（基础调色板）

Sky 写在基础选择器里，是其他调色板覆盖的底；2026-10-12 起默认调色板是 Carbon（见 3.4），没有存过选择的设备在首次绘制前（`index.html`）就用 Carbon。

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
| Carbon | 默认；安静、现代：纯中性灰，没有任何色偏，强调色就是墨色（浅色近黑、深色近白），只有状态（绿 / 琥珀 / 红）带颜色 | 中性灰（深色 `#191919` 底、`#ededec` 正文） | 墨 `#1d1d1c` / `#e8e8e6` |
| Sky | 清爽、通用，带一点天蓝的中性色 | 冷蓝灰 | `#2f6fd0` / `#8ab4f8` |
| Sand | 长时间阅读；暖、低眩光 | 暖纸色与墨色 | 赤陶 `#a84f28` / `#e9a47e` |
| Forest | 偏好绿色系、与蓝色工具区分 | 绿灰 | 深青 `#146b64` / `#6fd2c0` |
| Graphite | 信息最密、对比最强 | 纯中性灰（`#111111` 正文） | 靛紫 `#4a44c2` / `#aaa6ff` |

关键值（完整值以 `tokens.css` 为准）：

| 调色板 · 模式 | `--bg` | `--surface` | `--text` | `--text-3` | `--accent-text` | `--success` / `--warn` / `--danger` |
| --- | --- | --- | --- | --- | --- | --- |
| Carbon 浅 | `#f7f7f6` | `#ffffff` | `#161616` | `#5e5e5c` | `#2a2a29` | `#24713f` / `#855400` / `#b5302b` |
| Carbon 深 | `#191919` | `#212121` | `#ededec` | `#9c9c9a` | `#dededc` | `#84d4a2` / `#eec070` / `#f58e86` |
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
- 玻璃浮层另有一份底线（对着本应用自己的每一张面，正文 ≥7:1、其余角色 ≥4.5:1），由 `apps/web/src/styles/glass.test.ts` 检查，见 §3.2；
- 深色层级：`surface` 对 `bg` ≥ 1.08:1，`raised` 对 `bg` ≥ 1.15:1。

改颜色时先跑 `pnpm exec vitest run apps/web/src/styles/contrast.test.ts`。测试解析的是 `--token: #rrggbb;` 形式，调色板里需要被检查的颜色必须写成六位十六进制。

### 3.7 新增或修改调色板的步骤

1. 在 `tokens.css` 末尾的调色板区，照现有块写 `[data-palette="x"][data-theme="light"]` 与 `…="dark"]` 两块，**覆盖同一组颜色 token**：面（`bg`、`bg-sidebar`、`surface*`）、悬停与按下、边框与焦点、四级文字、强调四件套、三种状态色及 `-soft`、代码三件套、七个语法色。不写 `--wx-*`、字号、尺寸。
2. 起点：先定中性色的色相，再从 `--text` 开始往下调到刚好过线，最后挑强调色并检查它作文字与作底色两种用法。
3. 在 `lib/display.ts` 的 `PALETTES` 里加 `{ id, label, description }`；描述是一句话，说用途而不是颜色名。
4. 跑对比度测试；在真实页面里按两种模式各截一张（对话、设置、工作台的 Changes），看 diff 增删色、状态点和链接。
5. 在本节的表里补上它。`CHANGELOG.md` 由发布准备 PR 统一写入，功能 PR 不改（见 `AGENTS.md`「发布」）。

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

- **用户的消息是气泡**（2026-10-25 起普通 Session 也是）：靠右、无描边无阴影、底色 `--surface-raised`、圆角 `--radius-lg`（右下角 `--radius-xs`），最宽约 620px；Agent 回复靠左，Session 里左侧是带天气的头像。气泡里的 Markdown 用 `Markdown` 的 `breaks`：输入时的每个换行都是换行，段落与列表之间只留 0.45em，**不用 `white-space: pre-wrap`**（它会把块之间的换行画成大段空行）。Project 里用户气泡上方再有一行时间；协调者与 Thread 的回复是铺满对话列的普通正文，**没有头像、没有气泡、没有作者行**，把空间留给内容；连续消息之间留 4–6px，不把多条消息拼成一大段。
- 进行中的回合保留 Agent 的叙述文字；两段叙述之间**连续的思考与工具调用**（2026-10-23 起思考也算在内）折叠成一行：有步骤在跑时写当前步骤（“Running pnpm test · 12 steps”，后跟转圈），跑完写做了什么（“Searched 3 times, ran a command”，`@tnega/client` 的 `summarizeSteps`）与总用时，点开才看每一步。只有一个工具调用时就是那一行本身；**正在写的思考**不并入，单独一行流式显示，写完再并入。
- **步骤的样式**（2026-10-23 起，取代带框的 “Used N steps” 卡片）：思考、单个工具调用、折叠的一串步骤和回合的过程折叠，**用同一种行**：图标 · 做了什么（`--text-2`，字重 500）· 次要信息（目标、步数、用时，`--text-3`）· 箭头。行**无框、无底色**，宽度贴合文字（箭头跟在文字后面，不推到最右），悬停或展开时文字变为 `--text`，不加底色；键盘焦点用全局 `:focus-visible`。展开的内容（一串步骤、思考全文、工具详情）一律挂在图标下方的**一条 1px `--border` 竖线**上，不再套卡片；过程折叠点开后，叙述照常显示，叙述之间连续的思考与工具调用**再折成一行**（与进行中的回合同一规则，2026-10-25 起）；整个过程只有一串步骤时（叙述之间没有字），点开后思考逐条显示，**两次思考之间连续的工具调用折成一行**（“Read 2 files, ran a command”，2026-10-26 起）；只有工具调用、没有思考时直接逐条列出，不再二次折叠。折叠行有完整的 `aria-label`（Windows 上按名称找按钮的测试依赖它）。实现：`Timeline` 的 `StepGroup`、`ProcessHead`、`Thought`，样式在 `app.css` 的 “steps” 一节。
- **过程的开关**（2026-10-15 起）：回合在跑时，它自己的末尾放一行 **Process output** 下拉（`components/Menu.tsx` 的 `Choice`，类名 `.turn-process`，`Timeline` 的 `AgentTurn`）：默认 **Steps**（上一行的行为——叙述、思考与工具调用逐步流出），也可以选 **Answer only**——只留那一行进度，答复在回合结束时出现，过程仍可点开。它跟着这个回合走（回合结束就消失），只决定流式过程显示多少，不改变回合结束后「过程折叠、结论展开」的规则。按设备记住（`tnega.processView`，`lib/process-view.ts`），不进 System Config；只影响 Web 与桌面端，终端界面另有自己的显示方式（§5.8）。
- 回合结束后，最终答复之前的过程（叙述、思考与工具）一起折叠成同样的一行（“Read 3 files, ran a command · 12s”），只留最终答复、改动文件与需要你处理的警告。
- **审批卡的会话授权**（2026-10-30 起）：工具给出可覆盖整个 Session 的授权范围时（如电脑操作按应用授权），审批卡首行写 “The agent wants to <范围说明>”，右侧主按钮写 **Allow in this session**，左侧小字写本次触发的工具名；其余审批仍是 “Allow once”。终端界面同理：问句写 “Let the agent <范围说明>?”，`y` 的说明写 “allow in this session”。
- **设置行**（2026-10-23 起）：对话开始后改模型、推理强度、权限或审批方式，时间线里留一行安静的字（`SlidersHorizontal` 图标、`--text-3`、`--text-xs`，无框无底色，不是 `.notice`）：“Effort set to high”，多项合成一行。回合进行中改的，这一行落在该回合的步骤之间，后面加 “· applies from the next step”，回合结束后它留在答复旁、不随过程折叠；两个回合之间改的，是横贯对话列的一条细分隔线（两侧 `--border` 渐隐线，文字居中）。会话开始前选的设置不出现。终端界面里是 `dim` 的一行（回合之间画成分隔线）。
- **思考**（模型暴露的推理文本，2026-10-10 起）：画成与工具调用相同的步骤行（灯泡图标 · "Thinking" / "Thought for 6.4s" · 箭头），不加卡片和底色。模型思考时它展开，正文用 `--text-3`、`--text-sm`、挂在步骤竖线上，只保留最新约 6 行；答复一开始就自动收成一行，点开才看全文，展开状态不跨重载保留。最终答复的思考留在答复上方；中间工具步骤的思考随过程一起折叠。不另造“思考中”的天气，沿用多云。
- 全应用使用同一字号阶梯（§6.1）：常规界面 13px，对话正文与输入 14px、1.6 行高，工具详情 12px，元数据 11px；标题 18.5 / 24px。Project、Session 和工作台沿用同一套 token：工作台里的 Thread 与 Agent 通信用和主对话**相同**的正文字号，不再缩小一号。
- **转派便条**（2026-10-13 起，取代 2026-10-09 的虚线转派气泡）：Thread 对话里，启动这个 Thread 的 Agent（通常是协调者）发给它的消息收成**一行**靠左的弱化文字：“Message from Coordinator ⌄”（派工本身写 “Brief from Coordinator”）+ 时间，`--text-3`、`--text-sm`，无框无底色（`ThreadMessages` 的 `RelayNote`）。点开在下方缩进显示便条：`--border-strong` **虚线**圆角框、无底色、文字 `--text-2`，上面一行小字写发送者。它是给 Thread 的指令而不是给你的消息，所以默认收起，Thread 对话读起来就是你和这个 Thread 的往来。派工便条在时不再另放折叠的 Brief。「Messages with …」里的完整往来仍用虚线气泡（`ChatRun` 的 `side="relay"`）；Thread 发给协调者的汇报只在那里出现。
- Project 主对话里，协调者把工作交给 Thread（或 Thread 第一次回话）的地方是一张 **Thread 链接卡**：状态灯 · 标题 · 状态 · 箭头，点开在工作台打开该 Thread；每个 Thread 只在它第一次出现的地方放一张卡，卡上的状态是实时的。协调者在正文里提到 Thread 时写成 `[标题](#thread:<id>)`，渲染为带状态灯的链接，同样打开 Thread。Thread 与协调者之间的往来在 Thread 工具栏的「Messages with …」里查看（工作台的通信标签，按发送者分组，只有名字没有头像）；文档标签不跨重载保留，通信内容从 Box 快照恢复。
- 消息中的 Markdown 文件引用、带目录的裸文件路径与文件型行内代码可打开工作台（2026-10-22 起按类型分流，`lib/file-open.ts`）：**HTML 在 Browser 里作为页面打开**（`file://`，同目录的 CSS、脚本与图片照常加载；没有浏览器时退回 Files）；**Markdown 在 Files 里渲染显示**；其余文本进 Files，图片、PDF 与 Office 文件进预览。本地开发地址进 Browser，公开网站作为外链打开。代码块保留原文；`mermaid` 代码块画成图（卡片头写 `mermaid`，`Source` 一切换回原文并可复制，图内链接与正文链接去向相同；图与代码块同用 `--pele-*` → token 映射，随模式与调色板变化；画不出来时回退成原来的代码块）。

- **密钥问题**（2026-10-26 起）：Agent 用 `ask_user_question` 的 `secret`（环境变量名，如 `GITHUB_TOKEN`）要密钥时，问题卡里是一行**隐藏输入**（复用 `.input-with-icon`：`KeyRound` 图标 · `password` 输入框，等宽字体 · 显示 / 隐藏的 `.icon-button.tiny`，`aria-pressed`），没有选项与补充文本框。下面一行 `.muted.small` 写去向（“只在这个会话里使用……命令里用 `$NAME` 读取”），右侧是 **记住** 按钮（`.button.ghost.small`，`aria-pressed`，按下时 `--accent-soft` 底、`--accent-text` 字）：按下则保存到这个工作区（重启后同一工作区的会话都能用），说明文字随之改写。值只交给宿主的密钥库，不进 Session、不回到时间线；Agent 只知道名字。设置里的 **Secrets** 分区（§9）列出名字并可移除。

### 5.2 输入区与图片

- Project 输入区只显示一个主按钮：有内容时是发送（异步消息）；内容为空时，只有收件方正在运行才是停止，空闲时是禁用的发送——不显示一个用不了的停止按钮。`Ctrl+Enter` 可停止当前运行并发送改向消息，`Esc` 停止当前运行。

- **排队与改向是两段**（2026-10-20 起，会话输入区）：Agent 运行时，Enter 默认**排队**——消息收进输入框上方的 `QueuedMessages` 卡片（与计划卡同形：`--surface`、`--border`、圆角、`--shadow-sm`；首行 `--text-3` 小字写 “Queued · sent when this run ends”，每条一行，正文单行截断（再长的一条也只截断正文，Steer now / 编辑 / 移除始终留在卡片内可见），带图时写图片数），不打断这一轮。每条可以 **Steer now**（`.button.ghost.small`，作为改向消息交给正在跑的 Agent，下一步读到）、编辑（放回输入框）或移除；`Ctrl+Enter`（Mac 上 `Cmd+Enter`）跳过排队直接改向。本轮自然结束时，排队的消息合成一条作为下一条消息发送；被停止或失败时留着，首行改写 “Queued · waiting for you”，按钮变成 **Send**，由用户决定。运行中占位文字写 “Queue a message for after this run… (Ctrl+Enter steers now)”。队列按会话保存在本页内存里，不跨重载。Project 输入区不变（异步消息 + `Ctrl+Enter` 停止并改向）。
- 输入框下方的工具行只放**模型**与**推理强度**两个下拉（2026-10-25 起）：强度是模型旁边独立的 `Gauge` 下拉（Default 加上该模型支持的档位，如 Low / Medium / High effort，各带一句说明），所选模型没有强度档位时不出现；档位由 LLM 缝按模型给出（DeepSeek V4 是 Low / High），保存的模型路由未写 `reasoningEfforts` 时按模型名推断。**没有 Auto / Plan / Goal 模式按钮**：Plan 与 Goal 由 `/plan`、`/goal` 打开，`/auto` 关回；打开时工具行末尾多一个小签（“Plan mode ×”），点它回到 Auto，Auto 时什么都不显示。**回合进行中仍可改**模型、强度，以及标题栏 Access 里的权限与审批方式：改动从正在运行的回合的下一步起生效（见 §5.1 设置行）；Agent 类型与模式影响整个回合，运行中保持禁用。
- **输入框边写边显示 Markdown**（2026-10-25 起，`lib/markdown-input.ts`）：Shift+Enter 在列表项里接着列表（`1. a` → `2. `，`- a` → `- `，`- [x]` → `- [ ] `），在空的列表项上结束列表；Tab / Shift+Tab 让列表项缩进或提出一级（缩进的编号从 1 开始），不在列表里时 Tab 照常移动焦点。textarea 自己的字是透明的，下面一层（`.composer-highlight`）画同样的字：列表符号、`#`、`>`、`**` 等标记用 `--text-3`，行内代码与代码块用 `--code-bg` 底与 `--accent-text`。**只改颜色，不改字重、字号或字体**，两层才能逐字对齐、同样换行。Session、Project 与 Thread 的输入框都一样。
- 输入区是主要抬升面。图片可以点按钮添加、粘贴或拖入；先缩到长边 1568px 再上传（大图转 JPEG），每条消息最多 8 张。
- **其他文件**（2026-10-25 起，会话输入区）：docx、md、csv、PDF 等非图片文件同样可以拖入、粘贴或用回形针按钮（`Paperclip`，“Attach files”）选取。文件先存进工作区的 `.tnega/uploads/`（重名不覆盖，写成 `notes (2).md`；单个最多 25 MB；不进 Changes 列表），输入框上方显示一个文件签（与选中元素签同形：图标 · 文件名 · 删除），保存中是小转圈，存好前不能发送；存不了的签变成 `--danger` 色、写 “· not attached”，不随消息发出。发送时消息开头每个文件一行 `[Attached file: <路径>]`，Agent 用自己的工具去读；时间线里这些行画回文件签，点开在工作台打开。Project 输入区暂不接收文件（Thread 可能在别的 worktree 里，读不到主工作区的文件）。
- 缩略图在输入框上方，悬停出现删除。所选模型被配置为不接收图片时，缩略图旁会提示。
- 图片的取舍属于模型层，界面不做猜测：除已知纯文本模型外，一律把图片发给模型；提供方拒绝时，适配器去掉图片重试一次，之后对这条路由只发文字说明。System Config 的 `vision`（顶层或单条路由）可以显式指定。

### 5.3 工作台（Workbench）

对话是**谈论**工作的地方，工作台是工作**本身**所在的地方。Agent 和你共同操作的一切——工作区文件、改动、终端、浏览器，以及从对话里打开的文档和子 Agent 记录——都在右侧同一个面板里，不再各自开抽屉。

- **Project 产物例外**：从消息或 Library 打开的产物保留弹窗预览，左侧产物、右侧生成它的 Thread，复用现有预览与 ThreadPanel。弹窗几乎占满窗口：标题行只出现一次（类型图标 · 标题 · `类型 · 大小 · v版本 · Thread`），整件产物的动作放在标题行右侧（引用选中文字、查看最新版本、下载）；左侧是 `--surface-sunken` 的舞台，文档画成居中的「纸」（`--surface`、`--reading-width`、正文 `--text-lg`），页面类产物铺满舞台并可切换「Page preview / Select from source」；右侧 Thread 栏宽 `clamp(360px, 32%, 520px)`，不再重复显示产物条。一个 Thread 可以维护多个产物；修订沿用产物身份和归属。打开不触发模型请求。两侧独立滚动，关闭恢复焦点。文本、Markdown、代码可以引用实际选中的原文；HTML 可切换源码引用，不扩大 iframe 权限。引用可取消，仅在用户发送时连同所见版本提交。
- **入口**：会话顶栏只有一个工作台按钮（面板图标），角标是相对上次提交改动的文件数。`Ctrl+J` 开关工作台，`` Ctrl+` `` 直接打开终端。Agent 开始用浏览器时自动切到 Browser；对话里"N files changed"卡片上的每个文件点开即是它的 diff；Office 文件卡片点开是预览标签。
- **一种形状**：每个视图都是 **标签栏 → 工具栏行 → 圆角卡片**。标签栏先是固定的工具（Files · Changes · Terminal · Browser · Context），竖线之后是可关闭的文档标签（文件预览、子 Agent 记录），同一文档不会开两次。工具栏行左边是上下文（路径、分支、会话），右边是动作；工具内部的多实例（浏览器页面、多个终端）用同一种**子标签胶囊**。内容一律放进圆角卡片：代码、终端与 diff 用 `--code-bg`，文档与页面用 `--surface`。**Project 的面板是阅读面**（Thread、Agent 通信、Board、Library、Routines、Project 设置）：内容用 `.wb-card.wb-flow` 从工具栏下的一条分隔线开始铺满面板，底色 `--bg`，不再套第二层带边框的卡片——和旁边的对话连成一片（2026-10-09 起）。
- **底色与层级**（2026-10-12 起，参照 Claude 的侧边面板）：工作台是一张**卡片**（`.wb-frame`）：`--surface` 底、`--border` 细边、`--radius-xl` 圆角，与窗口右、下边缘留 6px 空隙（网页端顶部也留 6px），和对话之间不再画竖线，卡片的边框就是分界；卡片里的阅读面（`.wb-flow`）同样用 `--surface`，选中的标签用 `--surface-active`。工具栏标题是 `--text` + 600（Thread 名用 `--text-lg` + 650）；面板内的区块标题是句首大写的 `--text-md` + 650 + `--text`，数量跟在后面用 `--text-3`，**不用全大写的小号灰字**；Board 以项目名（`--text-xl` + 700）和一句天气（带状态灯）开头。
- **左右分栏**：Files 与 Changes 用同一种布局——左边列表（目录树 / 改动文件），右边详情（编辑器 / diff），选中项用 `--accent-soft`。
- **Files**：懒加载目录树（headless-tree）+ CodeMirror 6 编辑器，`Ctrl+S` 保存；磁盘上的文件在打开后被改过（比如 Agent 改了）时拒绝覆盖。Markdown 文件默认渲染成文档（`.files-markdown`：`--surface` 底、`--text-lg` 正文、`--reading-width` 一栏），工具栏的 `.segmented` 单选（眼睛 / 代码图标，`role="radio"`）切到源码编辑，选择按设备记住（`tnega.markdownView`）；HTML 文件在工具栏多一个「Open in browser」（地球图标）。
- **文件右键菜单**（2026-10-22 起，`components/FileMenu.tsx` 的 `useFileMenu`）：对话里的文件链接、改动卡片的行、Office 文件卡片与 Files 目录树上的文件，右键（或菜单键 / `Shift+F10`）都出现同一个菜单：先是点击会做的事（Open in browser / Open preview / Open in Files），HTML 与 Markdown 多一项 Edit in Files；桌面端再有 **Open with default app**（交给系统为这种文件登记的应用，比如代码进 VS Code）与 **Show in Finder / Explorer / folder**；最后是 Copy path / Copy relative path。菜单就是 `Menu` 的 `.menu-popover` + `.menu-item`，放在指针处（`.menu-at-point`，渲染到 `<body>`，在对话框之上），方向键移动、Esc 关闭并把焦点还给文件。系统会直接运行的类型（`.exe`、`.bat`、Windows 上的 `.js`、`.app`、`.command`、`.desktop` 等，见 `apps/desktop/src/open-file.ts`）不会被「Open with default app」启动，而是在文件管理器里显示出来；工作区之外的路径一律拒绝。
- **Changes**：相对 HEAD 的改动，状态字母（M 警告色、A/U 成功色、D 危险色、R 强调色）与 `+n −n`；diff 用 `@codemirror/merge`，可切换合并 / 并排视图，长段未改动内容折叠；增删着色只用 `--success-soft` / `--danger-soft`。可见时每 5 秒刷新，Agent 的改动随写随现。非 git 工作区给出说明而不是空白。
- **Terminal**：你自己的 shell（Windows 上优先 PowerShell 7），跑在真实 PTY 上（node-pty + xterm.js），不经沙箱、不是 Agent 工具。切换标签不会断开，重新连接时回放最近的输出。终端配色从 token 读取，随深浅主题切换。
- **Browser**：见 5.4。
- **Context**（2026-10-21 起，参照 dsh-context 的 Context 标签）：当前会话的上下文由什么构成、怎样长到现在。卡片里自上而下是 **Context stats**（轮次、模型请求数、工具调用、tokens、缓存命中、估算费用）、**Current context**（与 composer 上下文气泡同一个数：上次请求的 provider prompt 大小，对着模型窗口的一条堆叠条，`--text-3` 竖线标出自动压缩起点 75%）、**Context trend**（每个请求一根堆叠柱，Step / Turn 切换；柱子是按钮，悬停或聚焦时下方一行写这次请求的发送量、输出、缓存与占比最大的三类，点一下固定；压缩过的请求上方有剪刀图标）、**Token stats**（计费 tokens 按构成拆分的环图 + 图例，加输出）、**Timing**（活跃时间分成等待首字、思考、回答、工具运行、其他）。构成分六类：系统提示、工具 schema、用户消息、注入上下文（之后的 system 消息、插件代写的带名字的用户消息、压缩摘要）、助手回复、工具结果；按会话自己的估算规则（`estimateMessageTokens`，工具结果经 `renderToolResult`）估出比例，再缩放到 provider 报告的 prompt 数。**不列单个工具的明细**。区块之间用留白和一条 `--border` 细线分开，不嵌套卡片。只在会话里出现，Project 屏幕不显示这个工具；可见时每 5 秒刷新。数据来自 `@tnega/context-insights` 插件的 `GET /api/context`。
- **标签栏与标题栏**：网页端标签栏是卡片的第一行，高 `--header-h`。**桌面端**（2026-10-10 起）工作台最上面一行让给原生窗口按钮（最小化 / 最大化 / 关闭），是一条可拖动的标题栏（`.wb-titlebar`），标签栏放在它**下面**一行，拿到面板的全部宽度。工作台打开时，左边会话或项目顶栏右侧的动作按钮（`.conv-header-actions`）移到这条标题栏里，右对齐、紧挨窗口按钮左边（2026-10-12 起），这一行就不再是空的。这些按钮**钉在窗口上**而不是跟着面板走（`.wb-titlebar-actions`，2026-10-22 起）：位置与它们在顶栏里时完全相同（窗口按钮宽度 + 16px），工作台滑入滑出时一动不动；收起时先留在标题条里，等面板滑完、顶栏让出位置后才回到顶栏。侧栏收起时顶栏的 Show sidebar 按钮随侧栏一起展开宽度，标题平滑移动而不是跳一下。这一行算窗口标题栏而不是面板的一部分，工作台卡片从它下面开始，卡片的圆角边框就是分界；工作台关闭时按钮回到顶栏，顶栏照常给窗口按钮让位。顶栏给窗口按钮让的位子跟着面板一起收放（2026-10-24 起）：`lib/desktop-chrome.ts` 量出顶栏末端离窗口边还有多远（`--window-controls-gap`），CSS 只让出「窗口按钮还压在这一段上」的那部分，所以工作台滑入滑出时标题区随面板连续变窄变宽，不会在某一帧突然跳掉一个按钮宽度（以前那样会闪一下）。同一处修正了窗口按钮的取色：颜色取「顶栏本身」（面板打开时是它的标题条），不再取角落命中的元素——折叠途中那里常常是面板边缘的空隙或 inert 的外框，读出来是页面底色，于是按钮先闪成错的底色再改回来。这是「原生按钮融进已有顶栏、不加额外一行」的唯一例外。标签多到放不下时用滚轮或触控板横向滚动，选中的标签自动滚入视野；**不显示滚动条**（Windows 上的原生横向滚动条会撑高这一行，把标签挤离中线）。
- **浮层与窗口按钮**（2026-10-12 起）：对话框（`Dialog` 渲染到 `<body>` 末尾）、图片查看器和菜单在桌面端标为不可拖动，否则下面顶栏的拖动区会吞掉它们的点击（关闭按钮点了没反应）；它们从原生窗口按钮那一行下方开始，自己的关闭按钮不和 – ☐ ✕ 挤在一起；遮罩盖住窗口按钮时，按钮底色取遮罩叠在页面上的颜色，和页面一起变暗。
- **记忆与宽度**：开关状态与当前工具在重载后保留，文档标签不保留。左边缘可拖动调整宽度并被记住（悬停稍停后才显示一条 `--border-strong` 细线，桌面端从卡片顶部开始，不画强调色）（最窄 420px，最宽为窗口的 72%，默认 `--workbench-default` = `clamp(420px, 40vw, 760px)`，在 1920px 宽的窗口里和对话列差不多宽；旧版本保存的更窄宽度在读取时抬到 420px）；工具标签只显示图标，选中的那个显示名称（见 5.5）；窗口窄于 1100px 时工作台浮在对话之上（`lib/panels.ts` 的 `WORKBENCH_OVERLAY_QUERY`），用不透明的 `--bg` 底；桌面端浮起的工作台从标题栏**下面**开始，顶栏保持整条、动作按钮留在顶栏里紧挨窗口按钮，面板的边不会切过标题栏。
- **展开与收起**（2026-10-21 起）：工作台和侧栏打开过一次后就一直挂载，收起只是滑出窗口边缘（`.is-closed`，滑完后 `visibility: hidden` + `inert`），再打开不重建内容：文件树的展开、终端、Board 与侧栏的搜索都保留，不闪、不重新加载。应用外框始终是三列（侧栏 · 视图 · 工作台），收起的面板那一列宽 0；面板自身宽度不变（侧栏贴列尾、工作台贴列头），所以只有中间的视图重新排版。列宽只在开关的那一下用 `--duration-panel`（220ms）+ `--ease-out` 过渡（`.app.panels-moving`，`usePanelMotion`），改窗口大小和拖动工作台边缘仍是即时的。浮起的工作台和手机宽度的侧栏用 `transform` 滑入滑出。浏览器在收起时照样卸载，桌面端的原生页面视图因此离开屏幕；Changes 的轮询在收起时停下。

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
- 顶栏右侧的控件分两组（运行设置、会话工具），组与组之间只靠间距分开，**不画胶囊外框**（2026-10-10 起）：外框把一排图标切成几块，显得拥挤。
- 工作台的工具标签只显示图标，选中的那个显示名称；名称始终在提示和无障碍标签里。

### 5.6 侧栏：按工作区组织

- 侧栏宽 `--sidebar-width` = 264px，是一眼扫过的导航，所以比其他界面大一号（2026-10-09 起）：行高 `--nav-row-h`，图标 `--nav-icon`（lucide 的 `size` 只是默认值，尺寸由 CSS 统一设定），会话与项目标题用 `--text-lg`，当前项 600；分组名 `--text-md` + 650。搜索框与底部按钮高 `--control-lg`。
- **一行只放一个点和一个标题**（2026-10-10 起）：字号已经够大，拥挤来自每行塞的东西太多，所以减少每行的内容，而不是缩小字号。会话行是一个安静的小圆点（`--border-strong`，当前项 `--accent`）加标题；项目行（2026-10-12 起）在同一位置放项目图标（`FolderKanban`，`--text-3`，当前项 `--accent`），一眼就能和会话分开，行尾只在有话要说时放状态灯（§5.7）和拉取请求标记（见下）。不显示时间、数量、分叉图标；时间、分叉与项目所在的工作区都在提示里。

- 侧栏分两部分：最上面是 **Pinned**，列出所有工作区的全部项目（按最近更新），不显示项目所属的工作区；它和工作区分组一样可以折叠，默认显示 8 个，其余收在 “N more” 里（打开着的项目与有 Thread 等你或失败的项目总在视野内），已归档的收在 “N archived” 里。项目行悬停时的「更多」菜单里有归档 / 恢复与删除（删除先确认）。下面是工作区树：每个工作区一个可折叠分组，只放会话，按最近时间排列；默认显示 8 条，其余收在 “N more” 里；折叠后也不显示条数。**分组按各自最新会话的时间排列**，最近用过的工作区在最上面，不按添加顺序或字母顺序。折叠状态存在 `tnega.sidebar.collapsed`（Pinned 用一个不会是路径的键）。
- **拉取请求标记**（2026-10-12 起）：项目的 Thread 开过拉取请求时，项目行尾显示一个 12px 的 git 图标，图标与颜色跟随状态：打开 `--success`、草稿 `--text-3`、已合并 `--accent`、已关闭 `--danger`；有打开或草稿的就显示它，否则显示最新那个的状态，提示里逐个列出。数据来自 `GET /api/projects` 的 `pullRequests`：服务端用用户自己的 `gh` 查询状态并缓存，查不到时退回到开 PR 时记录的状态。Board 的输出小片与 git 卡片用同一套图标与颜色。
- **切换不闪**：点开别的工作区里的项目时，侧栏继续显示已有的列表直到新列表到达，不清空重排；重新打开看过的项目先显示上次的内容，再换成最新快照。
- **顶部两行入口**（2026-10-20 起）：品牌行下面是两行与会话行同样大小的文字入口 **New session** 与 **New project**（图标 + 名称，`--text-lg` / 500，悬停 `--surface-hover`），不再藏在图标按钮或工作区悬停里。New session 在默认位置开新会话（`Ctrl+Shift+O`）；New project 在当前工作区开新建对话框，对话框里有 Folder 下拉（“No folder” 与各工作区），可以换到别的文件夹再创建。品牌行只留收起侧栏的按钮。
- **打开即刷新**（2026-10-20 起）：侧栏每次打开、窗口重新获得焦点或从后台回到前台时（两次之间至少 3 秒），所有工作区的会话与项目列表都重新加载；当前工作区经应用刷新，其他工作区由侧栏自己刷新。终端或别的窗口里开的会话不必等 20 秒轮询。刷新时保留已有列表，不闪空。
- **批量删除**（2026-10-20 起）：会话行菜单的 “Select”、工作区菜单的 “Select sessions”，或 `Ctrl/Cmd + 点击` 会话行，进入选择状态：行首的状态灯换成复选框（`role="checkbox"`），点行是勾选而不是打开，`Shift + 点击` 勾选一段；分组头的悬停按钮换成 “Select all / Clear”。侧栏底部（设置一行上方）出现选择条：“N selected”、Cancel、红色 Delete。选择可以跨工作区；删除前用一次 `confirmDialog` 列出前三个标题与 “and N more”，取消则保留选择；`Esc` 退出选择。正在运行的会话删不掉时，用一条提示说明有几条没删。
- **没有选文件夹时的默认位置**：服务端在 tnega 主目录里准备一个 `scratch` 文件夹（`~/.tnega/scratch`，`GET /api/workspaces` 的 `defaultWorkspace`），侧栏把它显示为 “No folder” 分组，不能移出列表。侧栏顶部的 New session 与 `Ctrl+Shift+O` 都在这里开新会话；要在某个工作区里开，用该分组悬停时的按钮。用子文件夹而不是 `~/.tnega` 本身，是因为主目录里有配置与登录凭据，Agent 的工作区不能包含它们。
- 没有工作区切换卡片，也没有 Sessions / Projects 切换：点开任何分组里的会话或项目，就切到它所在的工作区并打开它。当前工作区的列表来自应用本身（实时）；其他展开的工作区在打开时各自加载。
- 工作区行悬停时出现“新建项目 / 新建会话 / 更多（Select sessions、移出列表）”；“Add workspace”在侧栏底部，与设置、主题并排，只显示图标（名称在提示与无障碍标签里），侧栏再窄也不会压到主题切换。
- 搜索同时过滤所有工作区的项目与会话，搜索时折叠的分组也会展开。标题即时过滤；输入两个字符以上时，还按会话里用户与助手说过的话查找（`GET /api/sessions/search`，每个会话取最新的一处匹配），只因内容命中的行在标题下多一行 `--text-sm` / `--text-3` 的匹配片段（最多两行），命中的字用 `--accent-soft` 底标出。这是搜索结果里唯一允许的第二行。查找中显示 “Searching messages…”，没有结果时直说 “Nothing matches …”。`Ctrl/Cmd+K` 打开侧栏并聚焦搜索框，`Esc` 清空。

### 5.7 Project 屏幕的密度

- 房间里的 Thread 卡片是一行（约 36px）：状态灯 · 标题 · 状态 / 当前步骤 · 箭头，悬停在卡片右侧出现「回复」。
- **对话里的卡片照 Claude 的样子**（2026-10-12 起）：Thread 卡与推送 / PR 卡按内容收窄（`width: fit-content`，不铺满对话列），`--radius-lg` 圆角、`--surface` 底、1px `--border`；标题 500 字重，状态文字 500 字重、`--text-3`（等你与失败仍用状态色）。多张卡纵向叠放、左对齐、间距 6px。当前步骤优先取 Thread 的清单；没有清单时用它最近一次工具调用的几个字（“Editing count.mjs”“Running node --test”）。
- **状态灯**（`components/StatusLight.tsx`，`threadLight` / `projectLight`）是天气的最小形态，一种颜色只有一个含义：等你或被阻塞（雪）= `--warn` 带光晕；出错（雷暴）= `--danger` 带光晕；工作中（雨）= `--accent` 缓慢明灭（减弱动效时静止）；有你还没打开的结果 = `--success`；其余为 `--border-strong` 的灰点。灯总带文字（无障碍名称与提示）。用在：房间的 Thread 卡、正文里的 Thread 链接、Board 卡片与 Today 行、侧栏的项目行——侧栏只在有 Thread 等你、失败或工作中时亮灯（优先级同 §4），数据来自 `GET /api/projects` 的 `threads` 摘要。
- **推送与 PR 卡**（`project/GitCard.tsx`）：Thread 用 shell 执行 `git push` 或 `gh pr create` 后，服务端按命令输出记一条带 `git` 的 Library 资源，界面画成一行卡片：图标（分支 / PR）· 标题（“Pushed feature-x”“Pull request #12”）· 仓库 · Thread · 时间 · 状态胶囊（Pushed / Opened 成功色，Up to date 中性，Rejected / Failed 危险色，失败时元数据换成错误行）· 「Open」在浏览器打开（PR、建 PR 的页面或分支页；本地或代理远端没有网页就不显示）。同一分支再推送更新同一张卡。卡片出现在主对话里（按最近变化的时间）、该 Thread 的产物区与 Library 的「Pushes and pull requests」。状态只反映命令本身的结果，不查询代码托管平台。
- 协调者与 Thread 的消息完整显示，不使用 “Show more” 或行数裁切；简洁表达由 Agent 的沟通指令负责，不由界面隐藏消息。Thread 一轮结束时的最终答复就是它的**汇报**：像同事在聊天里回一句话，2–4 句说做完了什么或发现了什么、在哪（PR、文件、产物的链接）、需要你做或决定什么；不复述步骤、尝试过的办法、跑过的命令和逐文件改动清单——过程留在清单与 Execution details 里（`THREAD_SYSTEM_PROMPT`）。
- **表情回应**（2026-10-13 起，`project/Reactions.tsx`）：主对话与 Thread 对话里的每条消息都能加表情。只有一小组意思明确的表情（👍 👀 🎉 ❤️ 🙏 😄 ✅ 🤔，与 `@tnega/box` 的 `REACTIONS` 一致），不提供整张表情键盘。悬停消息时在右上角（你的气泡则在它左侧）出现一个浮起的 `SmilePlus` 小按钮，点开是一行表情；已有的回应是消息下方的小胶囊：表情 + 数字，`--surface` 底、1px `--border`、`--radius-full`、`--text-xs`，你加过的用 `--accent` 描边 + `--accent-soft` 底，点胶囊加上或撤回你的那一个，提示里写谁回应了。协调者与 Thread 也能用 `react_to_message` 给你最近的一条消息加表情（例如道谢或告知只需要一个 👍 时，用表情代替一句回话）。回应只是装饰：不发通知、不唤醒任何 Agent、不进入谁的 Session。
- Board（2026-10-10 起，`project/Board.tsx`）从上到下：**问候**（2026-10-12 起取代项目名、天气行、彩色形状条与 Today 统计行：大块颜色和图案是陷阱，留白更重要）——`greeting()` 生成一句按时间的问候（Good morning / Lunchtime（午间且没有等你的事）/ Good afternoon / Good evening / Working late），用 `--font-display`；下面一句人话说现在的情况（谁在等你、谁有结果、谁还在做；什么都没有就说 Nothing needs you，午间说可以去吃饭），再一句 `--text-3` 的简短回顾（上午回顾昨天，之后回顾今天到目前为止：完成、产物、tokens），没有发生什么就不写 → 泳道 Needs you / Working / Ready（**段头是一条柔和的色带**：`--surface-hover` 底、`--radius-md`、`--text-sm` 500 字重 `--text-2`，前面的状态点带颜色，数字 `--text-3`；Idle / Resolved 折叠行与 Recently 用同一种段头；宽面板并排时空泳道写一句“Nothing waiting on you / No thread running / No new results”）→ Idle 与 Resolved 收成一行，点开一起显示 → **Recently**：最近 4 件事（started / reported / finished / asked / got blocked / failed / added / pushed / opened pull request），一行一件，图标 + Thread 名 + 动词 + 灰色摘要 + 时间，点击打开该 Thread。
- Board 卡片是段头下的**平铺行**（2026-10-12 起）：无边框、无底色，悬停才铺 `--surface-hover`；Needs you 不再加琥珀描边，靠状态灯与段头的点表达；标题 `--text-md` 500 字重，进展 `--text-sm`，产物 chip 底色 `--surface-hover`。内容：状态灯 · 标题（整张卡的点击区）· 进展一行（Needs you 的问题或失败原因给两行，其他一行）· **分段清单**（每步一段：完成为强调色、当前步淡强调色且只在 Working 时明灭、未做为凹陷色；超过 12 步退回一条进度条）`n/m` · **产物 chip**（最新 3 个，含推送与 PR；产物点开预览，推送 / PR 在浏览器打开，其余收成 `+N` 打开 Thread）· 底部 `动词 + 时间`（Asked / Failed / Updated / Reported / Resolved）· 活跃时长 · tokens。不加头像、不加新的状态色。

### 5.8 终端界面（TUI）

`tnega tui`（`packages/tui`，Ink）是同一个服务端的又一个客户端：在进程内启动服务端（`--url` 可接到已运行的），用 `@tnega/client` 的 API、Timeline 与天气规则，所以状态、折叠与命名和 Web 一致。Project 不在 TUI 里实现；终端放不下的（浏览器 screencast、图片与 Office 预览、模型路由与网络设置的编辑）用 `/web` 打开 Web 界面。

- **颜色只表达状态**：正文与背景用终端自己的前景、背景，元数据用 `dim`，结构靠字重与留白，不加色块、不加彩色边框；状态色只有命名 ANSI 色——绿（完成、新增行）、黄（等你：审批与问题的圆角框、雪）、红（失败、删除行）——跟随用户终端的明暗主题，不探测、不写 RGB。唯一的例外是状态行的天气条（见下），它用全彩画天空。
- **滚动区只追加**：会话开头一行 `tnega` + 文件夹 + 会话标题，之后每个结束的条目用 `<Static>` 打印一次进终端的滚动区，长对话不重绘（打开会话时只打印最近 80 条，更早的用 `/web` 看）。只有进行中的回合、等你的面板、输入框与状态行是活动区，活动区的高度不超过终端：回复太长时只显示末尾若干行，结束后完整写入滚动区。
- **折叠同 §5.1**：进行中的回合保留叙述，连续工具调用折成一行写当前步骤（`Reading a.ts · 3 steps`，前面是转圈）；结束的回合只留答复、改动文件与需要处理的失败，过程折成 `Used N tools · Ctrl+O to show`。`Ctrl+O` 清屏后按全部展开或折叠重新打印（终端里已打印的内容收不回，所以是整屏重绘而不是就地展开）。思考同 §5.1：进行中是 `dim` 斜体、左侧竖线、最近 6 行；结束后一行 `Thought for 6.4s`。
- **用户消息** 前面是 `dim` 的 `›`，正文加粗；不画气泡。条目之间空一行，回合内的块之间空一行。
- **输入框** 是一个 `dim` 圆角框，`›` 提示符，可多行：Enter 发送（运行中则排到本轮结束后，与 Web 相同的两段），Shift+Enter（支持 kitty 键盘协议的终端）/ Alt+Enter / Ctrl+J / 行尾 `\` 换行；运行中 Esc 停止，`Tab` 或 `Alt+Enter` 跳过排队、把输入的文字作为改向消息立即交给 Agent，输入框为空时把排队的消息合成一条改向；`Shift+Tab` 循环 auto → plan → goal。占位文字说明此刻 Enter 做什么（`Ask tnega to do something` / `Reply…` / `Queue a message`）。框的上边框右端是 `dim` 标签，只写非默认的事：多行时的行数、非 auto 的模式。终端光标停在插入点，中文输入法的候选框跟着光标；编辑按字素进行，宽字符按两格计算换行与光标位置（`string-width`）。`/` 补全命令（与 Web 共用 `CLIENT_COMMANDS` 加 TUI 的 `/new` `/sessions` `/usage` `/diff` `/settings` `/web` `/help` `/quit`），`@` 补全文件；不需要参数的命令在列表里按 Enter 直接执行。
- **按键提示行** 紧贴输入框下方，一行 `dim`，只列此刻最有用的几个键并随状态变（空闲、输入中、运行中、补全中），放不下时从右往左丢，`? all keys` 最后丢；换行键按启动时探测到的终端能力写 `shift+enter` 或 `ctrl+j`。空输入框按 `?` 展开完整按键表（两列，键名正文色、说明 `dim`），`?` 或 Esc 收起；表里只列已实现的键。等你的面板出现时由面板末行代替提示行。
- **排队的消息** 在输入框上方，每条一行：`dim` 的 `queued` 加正文，最后一条右侧写 `tab steer now · ↑ edit · ctrl+x drop`（没有运行时首项是 `enter send`）。本轮自然结束时合成一条发送；被停止或失败时留着，等用户 Enter 或修改。
- **等你** 的审批与问题替换输入框，黄色圆角框首行写 “Waiting for you”，状态行同时是雪；审批只认 `y` / `n`（Esc 也拒绝），回车不批准，避免把给输入框的回车误当成同意。
- **会话开头** 是品牌云（与 `apps/desktop/build/icon.svg` 同形，10×8 像素，半块字符两像素一格，眼睛是留空），晴天时太阳在右后方；云用终端前景色，太阳黄色，云和太阳同格时云优先。它只打印一次、不动，右侧是 `tnega`、工作区与会话标题。终端窄于约 47 列时不画云。
- **状态行** 在最底一行：天气条 · `WEATHER_LABEL` 文字 · 模型 · Agent 类型 · 非默认的模式与权限；右侧是上下文占比与花费。天气条固定 6 格宽（空闲的太阳只占 1 格），不加行、只画天气不画云，用粗的块字符和颜色（`packages/tui/src/weather.tsx`）：晴是黄色太阳、思考是灰白的雾霭飘动、一个工具是稀疏的蓝雨、多个工具是满格的蓝雨、等你是白与青的雪、重试是雨夹雪、失败是雨里的黄色闪电、上下文将满是雾条、完成是一条彩虹、启动助手是升起的品红与青色小块。标签文字跟随天气色（雨蓝、等你黄、失败红、完成绿、助手品红）。活动天气每 400ms 换一帧；`TNEGA_REDUCED_MOTION=1` 让天气条与转圈都静止（终端没有 `prefers-reduced-motion`）。
- **密钥问题** 在等你的框里是一行掩码输入：每个字画成 `•`（最多 40 个），不回显原文；下面一行 `dim` 写 `Commands read it as $NAME` 与 `[ ] this session only` / `[x] remember for this workspace`，Tab 切换记住，Enter 发送。
- 列表类面板（会话、模型、改动文件）共用 `Picker`：标题一行、可输入过滤、`›` 与反色标出选中项、当前项前有 `•`，末行是按键提示；面板高度受终端行数限制，超出时滚动。

下一阶段（帮助、首次连接模型、全屏查看器、后台任务、回退与分叉等）的设计稿见 [tui-next.md](tui-next.md)；定稿的规则在实现时并入本节。

## 6. 字号与信息显示偏好

### 6.1 字号阶梯

字号只来自 `--text-*`。新代码**不得**写裸 `font-size: Npx`（相对单位 `em` 用于 Markdown 内的标题与行内代码可以）；已有的裸像素值在碰到时顺手换成最近的 token。

| token | Small | Default | Large | 用于 |
| --- | --- | --- | --- | --- |
| `--text-xs` | 10.5px | 11px | 12px | 元数据：时间、计数、徽标 |
| `--text-sm` | 11.5px | 12px | 13px | 工具详情、表单说明、表格 |
| `--text-md` | 12px | 13px | 14.5px | 常规界面：按钮、列表、菜单 |
| `--text-lg` | 13px | 14px | 15.5px | 对话正文与输入（行高 1.6）、侧栏行 |
| `--text-xl` | 18.5px | 18.5px | 20.5px | 区块标题 |
| `--text-2xl` | 24px | 24px | 26.5px | 页面标题、欢迎页 |

**界面字体是 Geist + Noto Sans SC，代码用 JetBrains Mono**（2026-10-12 起；三者都由 `@fontsource-variable/*` 随应用打包，桌面端离线与各操作系统显示一致）。`--font-sans` 里 Geist 在前：拉丁字母、数字和标点总由 Geist 显示；Geist 没有中文字形，中文落到 Noto Sans SC，两者不会争同一个字符，混排不会忽大忽小或换来换去。Noto Sans SC 按 unicode-range 分片，只有出现中文时才加载需要的分片。`body` 字重 400。

**展示衬线 `--font-display` = Fraunces**（2026-10-12 起，`@fontsource-variable/fraunces` 的 opsz 轴：大字号时自动变成高对比衬线）。它只给几句表达情绪的字：Board 的问候语、新会话空白页的问候语（“Good afternoon. What are we building?”）与首次打开的欢迎标题，`--text-2xl`、500 字重；正文、标题栏、按钮与列表永远不用它。中文落到 Noto Sans SC。

字重以 400 / 500 / 600 为主；700 只留给极小的徽标数字。等宽字体（`--font-mono`）只给代码、路径、命令、哈希与对齐的数字列。

### 6.2 显示偏好

“信息显示”的设置都是根元素属性，由 `lib/display.ts` 写入、`tokens.css` 映射到 token，组件不需要知道当前选了什么：

| 设置 | 属性 | 取值（默认加粗） | 改变的 token |
| --- | --- | --- | --- |
| Colour palette | `data-palette` | **carbon** / sky / sand / forest / graphite | 颜色（§3） |
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

- 过程默认折叠，结论默认展开：工具调用折成一行并写当前步骤，回合结束后过程折成一行写做了什么（“Read 3 files, ran a command”，§5.1）；进行中的过程默认逐步流出，可用对话里的 **Process output** 收成一行进度（§5.1）；协调者与 Thread 消息始终完整显示（§5.7）。
- 折叠行必须告诉人里面有什么（步骤名、数量），而不是只写 “Details”。展开状态不需要跨重载保留。
- **跟随与停手**（2026-10-16 起）：对话视口在离底部 40px 内跟随新内容；用户一旦自己滚动（滚轮、触摸、方向键 / 翻页键，输入框里不算），150ms 内程序不再移动视口，往上滚一点点不会被流式输出拽回去（`lib/scroll.ts`，`useScrollPinning`）。离开底部超过容差时出现「跳到底部」按钮。
- **滚动边缘渐隐**：长列表滚出视野的边缘不再硬切，用 7 档非线性不透明度遮罩渐隐（`.scroll-fade` + `--scroll-fade` 28px，`lib/scroll.ts` 决定哪个边渐隐；触顶 / 触底时该边归零，短列表不挂遮罩）。目前用在侧栏会话列表的**下**边缘；对话的上边缘不渐隐（吸顶元素会让遮罩下的标题发灰）。
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
| 文件的右键菜单 | `components/FileMenu.tsx` 的 `useFileMenu`（§5.3），不另做右键菜单 |
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
- **Secrets**（2026-10-26 起）：打开的会话与当前工作区的密钥，**只列名字**：每行 `KeyRound` · 名字（等宽）· “This session only” / “Saved for this workspace”（`.muted.small`）· Remove（`.button.ghost.small`，`aria-label` 写 “Remove NAME”，先 `confirmDialog`）。没有时一行 `.muted.small` 说明密钥从哪来。这里不能新增或查看值：新增只能回答 Agent 的密钥问题（§5.1）。
- **Context insights**（2026-10-21 起，取代原 Usage 分区，保留它的按模型表）：当前工作区所有会话与 Project Thread 的上下文概览。右上角是范围（Today / Last 7 days / Last 30 days / All，按设备记住，`tnega.insightsRange`，默认 30 天）；依次是 Overview 数字、Last 7 days 柱（中性 `--text-3`，下面写当天费用）与 12 周 Activity 热力图（`--usage-*`，点某天筛选下方会话）、Token stats、Timing、Sessions 卡片（构成小环图、窗口占比、轮次 / 步数、tokens、费用、最后一条你写的消息；可搜索，按最近 / tokens / 当前上下文排序，有 Thread 时可按类型筛选；点卡片关闭设置并打开那个会话或 Thread），最后是 By model。不做 dsh-context 的 Context Browser 及其下方各块。

## 10. 动效与无障碍

- 动效是轻微、循环的状态提示：天气、思考中的浮动、眨眼。不用动效表达唯一的信息。
- 所有动效遵循 `prefers-reduced-motion`；过渡时长只用 `--duration-fast` / `--duration-med` 与 `--ease-out`。
- 焦点必须可见：`--border-focus` 加 `--accent-soft` 光晕。
- 颜色之外总有文字或形状区分状态。
- 系统的「降低透明度」偏好开启时，浮层的毛玻璃退回不透明；上面的对比度底线不因此变化。
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
5. 测试与源文件同目录，覆盖用户可见的行为；跑 `pnpm exec vitest run apps/web`。改了颜色跑 `contrast.test.ts`，改了玻璃或新增浮层跑 `glass.test.ts`。
6. 用户可见的变化写在 PR 描述里，不改 `CHANGELOG.md`（由发布准备 PR 统一写入）；改变了设计规则的，同一次改动里更新本文。
