# 0016 电脑操作：computer 缝、cua-driver 与按应用的会话授权

> 状态：当前
> 取代关系：无
> 当前实现：`packages/computer/computer/README.md`、`packages/computer/computer-cua/README.md`、`packages/computer/tool-computer/README.md`

日期：2026-10-30

## 决策

新增电脑操作（computer use）能力缝，让 Agent 看屏幕并操作本机应用。第一版以 Windows 为目标平台、截图优先，安全层保持最薄。

- **Service Definition** `@tnega/computer`：拥有 `ctx.computer`。观察（`windows` / `screenshot` / `zoom`）无副作用；动作只经 `act()`，它先解析目标窗口，再派发 `computer/pre-action`（可改写、可 `deny`）与 `computer/action`。坐标一律是该窗口最近一次截图的像素。
- **Provider** `@tnega/computer-cua`：用 [cua-driver](https://cua.ai/docs/cua-driver)（MIT）经 MCP stdio 驱动系统，不自研驱动。Windows 上它走 UI Automation 与窗口消息、默认后台投递；某个表面只接受前台输入时（报 `background_unavailable`），Provider 以 `delivery_mode: foreground` 重试一次。驱动首次使用时启动、随插件停止；找不到驱动时一律抛 `COMPUTER_UNAVAILABLE` 并给出安装命令，不回退到其他输入方式。tnega 不打包驱动，查找顺序：配置 `computerDriverPath` → `TNEGA_CUA_DRIVER` → PATH → 安装器默认目录。驱动的遥测默认开启，tnega 启动它时设置 `CUA_DRIVER_RS_TELEMETRY_ENABLED=false` 关掉这一进程的遥测，不改用户保存的选择。
- **Consumer** `@tnega/tool-computer`：`computer_*` 工具（列窗口、启动应用、截图、局部放大、点击、输入、按键、滚动、拖拽、等待）。每个动作返回该窗口的新截图（图片附件），模型据此确认效果。
- **组合**：`packages/runtime` 的 `capability:computer` 挂 Provider 与 Consumer；Web 宿主与 `tnega run` 只在 System Config 的 `computerUse` 为真时传入。Project 线程不挂载（无人值守）。

## 授权

- 设置里的 **Computer use** 默认关闭；关闭时工具不注册，模型看不到。
- 工具定义新增通用的 `grant(input)`：返回一个 Session 级授权范围。审批宿主遇到带范围的调用时，若用户在本 Session 已允许该范围则直接放行，否则在审批卡上以 “Allow in this session” 询问，用户允许后记住该范围。自动审核的放行不记入范围。
- 电脑工具的范围是**拥有该窗口的应用**（`computer:app:<应用名>`）；列窗口与启动应用各有自己的范围。即每个应用每个 Session 问一次。`bypass` 权限下与其他工具一样不询问。

## 原因

- cua-driver 已经解决了后台投递、DPI、截图与坐标换算、UIPI（提权窗口直接拒绝）等平台细节，并以 MCP 暴露，作为 Provider 最省；换成别的驱动只换这一个包。
- 截图优先：DeepSeek V4 Flash 能读图并给出接近的坐标（实测 400×200 图上误差约 10 px），配合 `computer_zoom` 足以完成常见网页任务；V4 Pro 不接受图片，第一版不为它做文本树模式。

## 已验证（2026-10-30，Linux / Xvfb + openbox，Chromium，cua-driver 0.38.0，deepseek-v4-flash）

7 个真实任务全部完成：维基百科查生日、维基站内搜索、httpbin 表单填写并提交、长页面跳到 Z 段并列出条目、新开标签查 Python 版本再关闭、启动 xterm 运行命令并关闭、TodoMVC 添加三项并勾选一项。每个任务 5–22 次工具调用。Windows 实机尚未验证。

## 后果与后续

- 尚未做：按应用分级（只读 / 只点击 / 完整）、按签名识别应用、密码框保护、危险按钮确认、用户正在操作时暂停、单 Agent 互斥、全局停止热键、工作台里的 Computer 标签。这些都应挂在 `computer/pre-action` 上，以独立插件加入。
- 截图会发给模型提供方；授权文案写明 “see and use”。
- 授权范围记在宿主进程内存里，重启宿主后重新询问。
