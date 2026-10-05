# 0012 Agent 浏览器：浏览器缝、Playwright 与桌面内嵌视图

日期：2026-10-01

## 决策

新增浏览器能力缝，让 Agent 能打开、操作并检查网页，首要场景是前端开发的「改代码 → 开页面 → 看效果 → 查 console」闭环。

- **Service Definition** `@tnega/browser`：拥有 `ctx.browser`。动作只经 `act()`，它派发 `browser/pre-action`（可改写、可 `deny`）与 `browser/action`；观察（快照、截图、console、网络）无副作用。
- **Service Provider** `@tnega/browser-playwright`：用 `playwright-core` 驱动页面。快照是 `page.ariaSnapshot({ mode: 'ai' })`，元素以 `aria-ref=eN` 定位——与 Playwright MCP 相同的机制，不自研 DOM 提取与等待逻辑。页面来源可替换：
  - `launchPageSource`：自己启动系统 Edge / Chrome（全新 profile），`tnega web` 使用；
  - `cdpPageSource`：经 CDP 附着到另一个 Chromium 中已存在的页面，只驱动指定 target id 的那一页。
- **Consumer** `@tnega/tool-browser`：`browser_*` 工具，工具集参照 Playwright MCP；动作结果自带新快照与本次出现的 console 错误；截图以图片附件交给模型（依赖多模态消息）。
- **桌面端**：`WebContentsView` 放在独立分区 `persist:tnega-browser`，主进程开启只监听 127.0.0.1 的 DevTools 端点，Playwright 经它附着到该视图。渲染进程的 Browser 面板只负责告诉主进程视图的位置。
- **后台进程**：执行边界增加可选的 `startShell` / `startProcess`，沙箱装饰器对其做与前台命令相同的 `confine`；Agent 用 `job_start({tool:'shell'})` 把命令作为后台进程启动（最初是独立的 `process_*` 工具，2026-10 并入 jobs），起 dev server 再去浏览器验证。

## 原因

- Playwright 已经解决了可操作性检查、导航等待、iframe、过期引用等最难的稳定性问题，且 1.5x 起把 AI 快照与 `aria-ref` 作为公开 API；自研只会重走一遍。
- 用 CDP 附着而不是 `webContents.debugger` 自己实现协议，是为了复用 Playwright 的全部能力；代价是要开一个本机 DevTools 端点（见「安全」）。

## 已验证（2026-10-01，Electron 44 / Playwright 1.63 / Windows 11）

- `connectOverCDP` 连接约 40 ms；按 target id 精确找到内嵌视图，应用界面页不会被选中。
- 视图可见时 Playwright 截图与点击正常；**视图未挂载或窗口隐藏时 Chromium 不出帧，截图与点击会一直等到超时**。因此 Provider 每次动作前调用 `prepare()`，桌面端借此让渲染进程打开 Browser 面板并等待视图就位。
- `browser.close()` 对 CDP 连接只是断开，Electron 窗口不受影响，可以重新连接。
- 上一次运行残留的 `DevToolsActivePort` 会指向已失效的端口，启动前必须删除。

## 安全

- DevTools 端点只监听 127.0.0.1；Chromium 默认拒绝带网页 Origin 的 DevTools WebSocket 连接（未设置 `--remote-allow-origins`），所以网页——包括 Agent 浏览的页面——无法连到它。能连上的只有本机进程，这与它们本来就拥有的用户权限相当。
- 权限规则（`packages/cli/src/permissions.ts`）：观察、导航、滚动、悬停、等待、调整视口总是放行；点击、输入、选择、按键、`browser_evaluate` 在本地开发页（loopback、`*.localhost`、`*.test`）上于 `workspace-write` 放行，其余情况需要批准；后台进程由 `job_start` 发起，内部的 `shell` 调用照常经过 `shell` 的守卫。
- 网页内容是不可信输入。工具结果只是数据，Agent 的指令来源仍然只有用户。

## 修订：标签、面板尺寸与元素选择（2026-10-02）

- 浏览器缝增加标签：`BrowserTab`、`tabs()` 与 `tab_new` / `tab_select` / `tab_close` 动作，模型可见 `browser_tabs`。Host 维护有序标签与唯一的活动标签，动作、观察与 screencast 都跟随活动标签；`target=_blank` 与 `window.open` 打开的页面成为新标签。桌面端每个标签对应一个 `WebContentsView`。
- Web 端按面板卡片的尺寸设置所有标签的 viewport（`/api/browser/viewport`），画面不再缩放留白。
- 元素选择器（`/api/browser/pick`）在页面里注入一段脚本：描出指针下的元素，吞掉点击，返回元素描述并裁剪截图。它是用户动作，不经过 `browser/pre-action`。

## 后果

- `playwright-core` 成为运行期依赖，在两个 bundle 中都是 external。
- 非桌面环境下浏览器以 headless 运行，用 CDP `Page.startScreencast` 把画面推到 Web UI 的 Browser 面板，用户的点击、滚轮、键盘回传为输入（`/api/browser/live`、`/api/browser/input` 等），不弹出独立窗口（2026-10-02 修订）。System Config 的 `browser` 可设 `channel`、`executablePath`、`headless`（设为 `false` 恢复独立窗口）。
- 后台进程由 Web server 按工作区持有（`ProcessRegistry`），跨 Agent Run 保留，随 server 关闭而终止（2026-10-02 修订）。
