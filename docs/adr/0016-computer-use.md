# 0016 电脑操作：computer 缝、cua-driver 与按应用的会话授权

> 状态：当前
> 取代关系：无
> 当前实现：`packages/computer/computer/README.md`、`packages/computer/computer-cua/README.md`、`packages/computer/tool-computer/README.md`

日期：2026-10-30

## 决策

新增电脑操作（computer use）能力缝，让 Agent 看屏幕并操作本机应用。第一版以 Windows 为目标平台、截图优先，安全层保持最薄。

- **Service Definition** `@tnega/computer`：拥有 `ctx.computer`。观察（`windows` / `screenshot` / `zoom`）无副作用；动作只经 `act()`，它先解析目标窗口，再派发 `computer/pre-action`（可改写、可 `deny`）与 `computer/action`。坐标一律是该窗口最近一次截图的像素。
- **Provider** `@tnega/computer-cua`：用 [cua-driver](https://cua.ai/docs/cua-driver)（MIT）经 MCP stdio 驱动系统，不自研驱动。Windows 上它走 UI Automation 与窗口消息、默认后台投递；某个表面只接受前台输入时（报 `background_unavailable`），Provider 以 `delivery_mode: foreground` 重试一次。驱动投递了却无法确认效果时（`effect: unverifiable`）不重发——Chromium 这类表面会接受投递的事件，重发就成了重复输入——只在结果说明里提醒看截图再决定。驱动首次使用时启动、随插件停止；找不到驱动时一律抛 `COMPUTER_UNAVAILABLE` 并给出安装命令，不回退到其他输入方式。tnega 不打包驱动，查找顺序：配置 `computerDriverPath` → `TNEGA_CUA_DRIVER` → PATH → 安装器默认目录。驱动的遥测默认开启，tnega 启动它时设置 `CUA_DRIVER_RS_TELEMETRY_ENABLED=false` 关掉这一进程的遥测，不改用户保存的选择。
- **Consumer** `@tnega/tool-computer`：`computer_*` 工具（列窗口、启动应用、截图、局部放大、点击、输入、按键、滚动、拖拽、等待）。每个动作返回该窗口的新截图（图片附件），模型据此确认效果。启动应用的 `urls`：给的是应用名时，驱动把它们交给系统默认浏览器；给的是可执行文件全路径时，URL 作为该应用的参数，因此能指定用哪个浏览器。
- **组合**：`packages/runtime` 的 `capability:computer` 挂 Provider 与 Consumer；Web 宿主与 `tnega run` 只在 System Config 的 `computerUse` 为真时传入。Project 线程不挂载（无人值守）。
- **图片不进请求体**：截图默认上传到 `@tnega/llm` 的 Files API 通道，之后只用 file id 引用（chat/completions 用 `{type:"file"}`，responses 用 `input_image.file_id`，anthropic 用 `source.type:"file"` + `files-api-2025-04-14` beta）。实测同一张 1024 截图：上传 402 KiB 一次，请求体从 400 KiB 级降到 **138 字节**；按 SHA-256 去重后的 file id 跨轮稳定，图片窗口滑动再也不会因为字节改变而換掉前缀。
- **截图默认 1024 长边**：在 3200×1904 窗口上，1568 为 724 KiB / 约 950 图片 token，1024 为 402 KiB / 约 400 token；密集页面（arXiv 摘要页）在 1024 仍能读摘要、分类与 arXiv 编号，768 边缘（小字粘连、字段标签缺字），512 会丢信息（模型在 512 上把地址栏数字读成别的编号）。需要更细时用 `computer_zoom`，而不是把整图放大。

## 元素通道（2026-10-31）

像素点击是驱动所说的“盲落”，只有按元素操作驱动才能确认效果。`ctx.computer.tree()` 读窗口的无障碍树（只要树、不要图），工具 `computer_read_tree` 把它作为文本交给模型；点击、滚动、输入、单键都可以带 `element_token`（`<snapshot>:N`）。点击与滚动的元素和像素互斥，`act()` 派发前检查。令牌过期报 `COMPUTER_STALE_ELEMENT`，不自动重读——窗口变了可能有原因，要让模型看到。

已验证（Linux / Xvfb，Chromium，cua-driver 0.38.0）：12 个输入框按元素令牌逐个点击，页面自己的焦点读数 12/12 命中，全程 0 张截图；按元素输入文字落入目标框。deepseek-v4-flash 端到端任务“在 Field 9 输入 tnega 并报告焦点”用 6 次工具调用完成，全程用树和令牌，没有猜坐标。动作后仍返回截图，所以本次验证只覆盖能读图的模型（deepseek-v4-flash）；V4 Pro 等只收文本的模型要等“只用树”的模式（计划 A.4）。差异读取（`since`）里标 `-` 的行已删除、其行号属于旧快照，工具文案明确禁止对它们操作。

## 更多动作（2026-10-31）

- **悬停** `hover`：驱动在窗口范围内的 `move_cursor` 只移动它自己的叠加光标，应用收不到；实测 Chromium 的 `:hover` 与提示框只在桌面范围移动**真实指针**时出现。所以悬停是前台动作：先 `bring_to_front`，再把截图像素按窗口在桌面上的位置与截图尺寸换算成桌面坐标、移动真实指针。它会移动用户的鼠标，工具说明里写明。只按主显示器换算；不调用会缩放坐标的 `get_desktop_state`。
- **剪贴板** `clipboard-read` / `clipboard-write`：剪贴板是所有应用共享的，不属于任何窗口，因此不走按应用的授权，读写共用一个范围 `computer:clipboard`。仍经 `act()`，策略看得到（`window` 为空）。
- **应用列表** `apps()` / `computer_list_apps`：只保留能启动（有 `bundle_id` 或 `launch_path`）或有窗口的条目，过滤掉纯后台进程。`launch` 可带 `id`，Provider 用上一次列表里的 `bundle_id` / `launch_path` 启动该应用，这样“打开 Chrome”不必落到系统默认浏览器。范围 `computer:apps`。
- **菜单** `menu`：`invoke_menu` 按标签逐级解析原生菜单，缺失、歧义或禁用即拒绝，从不退回像素。它也是 XAML 目标上 `hotkey` 失效时的出路。本机 Linux 容器里没有能经 AT-SPI 访问菜单的应用，只有单元测试与驱动的拒绝路径验证过。
- **批量** `steps`：一个窗口内的点击、输入、按键、滚动、拖动、悬停，经一次 `run_steps` 执行，遇到第一个失败即停。`act()` 在任何一步执行前让 `computer/pre-action` **逐步**判断（任一步被拒则整批不执行；策略不能把步骤改成批里不能放的动作），执行后对每个已执行的步骤各发一次 `computer/action`，未执行的步骤不发。后台被拒的步骤由驱动单步前台重试（`foreground_fallback`），Provider 从不整批重发——前面的步骤已经发生。
- 授权范围：列应用 `computer:apps` 与剪贴板 `computer:clipboard` 各有自己的范围，不按应用授权；悬停只能落在窗口最近一次截图之内，越界即拒绝，免得真实指针悬停到未授权的应用上。
- 中断后的重试：只看不动的工具与悬停是 `retry`，剪贴板写、菜单、批量与其他动作是 `confirm`。

已验证（Linux / Xvfb，Chromium，cua-driver 0.38.0，经缝直接调用）：悬停让页面的提示框出现，移开后消失；四步批量（元素点击、`ctrl+a`、输入、悬停）一次调用完成并逐步审计；批量里按元素输入的文字落入输入框；剪贴板写后读回原文；应用列表 10 项。附带发现：Linux Chromium 上按元素的**点击**由驱动换算成真实指针点击，落点比输入框低几像素；按元素**输入**不受影响。

## 图片预算（2026-10-31）

截图在每次请求里都要重新计费，所以图片窗口 `maxImages` 现在可以配置：配置文件顶层，或某条模型路由上（路由优先），
宿主、`tnega run`、压缩与审批模型都按它组装请求。客户端默认仍是 8；实测（见 `packages/llm/README.md`）窗口开始滑动后，
每步要重付窗口里的全部图片（约 410 token 一张），所以电脑操作建议设 2。

## 只收文本的模型（2026-10-31）

工具集不变，变的是结果的形状。宿主给 Consumer 一个 `vision()`，问「下一步用的模型能不能读图」——按 Session 当前选中的路由（`EffectiveLlmConfig.vision`，即路由上配置的 `vision`，否则按模型名推断），每次要截图前都问，因为模型可以在运行中途切换。不能读图时根本不截图：动作的结果是动作说明加一行窗口描述（窗口、应用、标题、尺寸），`computer_screenshot` / `computer_zoom` / `computer_wait` 也只回这行描述，都指向 `computer_read_tree`；不计入截图预算。切回能读图的模型，下一次就重新带截图。`tnega run` 只用一个模型，开始时定下。

## 截图预算（2026-10-31）

长任务可能拿几百张截图，所以 `computerMaxScreenshots` 给一个 Session 的截图张数设上限。计数归 Consumer（`tool-computer`），因为截图是它附进结果的；计数从 durable Session 里重建（之前的 `computer_*` 结果的图片数），这样重启后不会重置。用完后观察退回文本：动作不带截图，看图的工具拒绝并指向 `computer_read_tree`。Provider 返回的截图超过 `maxImageDimension` 时记一条警告。

## 授权

- 设置里的 **Computer use** 默认关闭；关闭时工具不注册，模型看不到。
- 工具定义新增通用的 `grant(input)`：返回一个 Session 级授权范围。审批宿主遇到带范围的调用时，若用户在本 Session 已允许该范围则直接放行，否则在审批卡上以 “Allow in this session” 询问，用户允许后记住该范围。自动审核的放行不记入范围。
- 电脑工具的范围是**拥有该窗口的应用**（`computer:app:<应用名>`）；列窗口与启动应用各有自己的范围。即每个应用每个 Session 问一次。`bypass` 权限下与其他工具一样不询问。

## 原因

- cua-driver 已经解决了后台投递、DPI、截图与坐标换算、UIPI（提权窗口直接拒绝）等平台细节，并以 MCP 暴露，作为 Provider 最省；换成别的驱动只换这一个包。
- 截图优先：DeepSeek V4 Flash 能读图并给出接近的坐标（实测 400×200 图上误差约 10 px），配合 `computer_zoom` 足以完成常见网页任务；V4 Pro 不接受图片，第一版不为它做文本树模式（2026-10-31 起有了，见「只收文本的模型」）。

## 已验证（2026-10-30，Linux / Xvfb + openbox，Chromium，cua-driver 0.38.0，deepseek-v4-flash）

7 个真实任务全部完成：维基百科查生日、维基站内搜索、httpbin 表单填写并提交、长页面跳到 Z 段并列出条目、新开标签查 Python 版本再关闭、启动 xterm 运行命令并关闭、TodoMVC 添加三项并勾选一项。每个任务 5–22 次工具调用。

## 已验证（2026-11，Windows 11 26300，cua-driver 0.38.0，经缝直接调用）

列窗口（隐藏驱动自己的遮罩）、启动应用、截图、局部放大、UIA 点击、输入全部走通；在 Windows Terminal 上验证了前台重试确实把文字投进了 cmd。**已验证的坑**：Chromium 接受后台 PostMessage 的文字，驱动却报效果不可验证；拿到这种结果自动重发就会把文字打两遍（本机实测重现），所以现在只在明确拒绝时重试。

已知限制：现代 XAML / WinUI 目标（如 Windows 11 记事本）的 `hotkey` 只做 UIA AcceleratorKey 匹配、不走 SendInput，`ctrl+z` 这类组合在记事本上必然失败，`delivery_mode: foreground` 也无效；这类目标上的少量文字也常报效果不可验证（可能被丢掉）。没有模型的端到端任务尚未在 Windows 上跑。

### 坐标与精度

模型只给截图像素，换算全在驱动里，调用方不做 DPI 修正。在 3200×1904 窗口、Chrome 页面缩放 220%（dpr 2.2）上，用 35 个网格点拟合出：

- 截图是全窗口缩小版（1568×933）；驱动按 `窗口物理宽 / 截图像素宽` = 2.0408 乘回物理坐标，再除 dpr 得页面 CSS 坐标。
- 图片与页面 CSS 几乎 1:1：`css_x = 0.9276 × image_x`，`css_y = 0.9276 × image_y − 79.6`。常数项是窗口顶部浏览器界面的高度（标签栏 + 地址栏≈175 物理像素）——截图含浏览器界面，y 从窗口顶端算。
- 残差 ≤ 0.6 CSS 像素；另用 12 个 300×60 的输入框做验证，按上式换算后全部点中。精度约 ±1 图片像素，小目标靠 `computer_zoom` 瞄准。
- 曾把“点不中”误判成 DPI 偏移，实际是拿放大/带黑边的渲染图估坐标；模型看到的是原图，按原图像素给点就准。
- 最小化（图标化）窗口没有可渲染内容，驱动截不到图；Provider 先 `bring_to_front` 恢复再重截，恢复不了才报错。后台 `PostMessage` 点击会把焦点移到输入框，但文字落不落要看目标，所以输入后一律靠新截图确认。

## 后果与后续

- 尚未做：按应用分级（只读 / 只点击 / 完整）、按签名识别应用、密码框保护、危险按钮确认、用户正在操作时暂停、单 Agent 互斥、全局停止热键、工作台里的 Computer 标签。这些都应挂在 `computer/pre-action` 上，以独立插件加入。
- 截图会发给模型提供方；授权文案写明 “see and use”。
- 授权范围记在宿主进程内存里，重启宿主后重新询问。
