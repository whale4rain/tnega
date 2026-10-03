# `apps/web`

Tnega 本地 Web UI（React 19 + Vite + TypeScript）。`pnpm build` 将生产产物放入
`dist/web`，由 `tnega web` 托管静态资源与 `/api`；桌面端复用同一界面。

## 开发

```bash
pnpm tnega web --port 3080
pnpm --filter @tnega/web dev
```

Vite 默认代理 `/api` 到 `127.0.0.1:3080`；`TNEGA_API=http://host:port` 可改目标。
用户功能与安装见[中文指南](../../docs/zh-CN.md)，发布见
[docs/publish](../../docs/publish/README.md)。

## 界面能力

- **工作区与 Session**：切换工作区，搜索、重命名、分支、删除会话；首次发送才创建 Session。支持 General、Coding、Work，Coding 提供 Auto / Plan / Goal。
- **Timeline**：流式回复、工具活动组、子代理、文件改动摘要、压缩与错误信息；完成的 Run 展示最终回复，过程可展开。支持编辑重发、重试与从消息处分支。
- **工作台**：右侧统一容纳 Files、Changes、Terminal、Browser，以及文档预览和子代理记录标签。Ctrl+J 开关，Ctrl+` 打开终端。
- **Files / Changes**：文件树、代码编辑器与 Ctrl+S 保存（检测磁盘并发修改）；Git 文件列表与统一 / 并排 diff。
- **Terminal / Browser**：多个 PTY 终端；应用内多标签浏览器、可调面板和元素选择器。Web 使用实时画面，桌面使用原生视图。
- **输入与产物**：斜杠补全、`@` 文件引用、图片附加 / 粘贴 / 拖放；Office、图片和 PDF 在工作台预览，支持适用文件的缩放和下载。
- **运行控制**：权限与模型选择、上下文占用和用量、后台任务停止、持久化问题、人工或自动审批，以及可选 CodeMode。
- **设置与主题**：编辑 System Config；API Key 只写不读。浅 / 深 / 系统主题，天气表达 Agent 状态。打包后的桌面端显示版本、检查更新和更新重启操作。

## Projects

侧栏在 Sessions / Projects 间切换，项目与 Thread 路由分别为
`#p/<project>`、`#p/<project>/<thread>`。项目中与协调者持续对话，Thread 卡片显示状态与回报，
可直接留言。项目面板提供 Overview、Memory、Library 和 Settings；支持回复关系、归档与删除。
行为与接口见[Project 指南](../../docs/project/README.md)与
[Web 契约](../../docs/project/web-contract.md)。

## 结构

| 模块 | 职责 |
| --- | --- |
| `src/App.tsx` | 工作区、Session / Project 路由、对话框与工作台状态 |
| `src/components/Conversation.tsx` | Session 加载、流式运行、审批、Plan、Goal |
| `src/components/Timeline.tsx` | 持久事件投影的用户界面 |
| `src/components/Composer.tsx`、`PromptBox.tsx` | 运行设置、输入、补全与附件 |
| `src/components/workbench/` | 工作台与 Files / Changes / Terminal / Browser / 子代理视图 |
| `src/components/files/`、`preview/` | 文件树、编辑器与产物预览 |
| `src/components/project/` | Project、Thread、Memory、Library 和设置 |
| `src/lib/api.ts`、`workbench-api.ts`、`project-api.ts` | REST / SSE 客户端 |
| `src/lib/timeline.ts`、`workbench.ts`、`project-model.ts` | 纯函数投影与状态 |
| `src/styles/tokens.css` | 浅 / 深主题 token |
| `src/styles/app.css`、`project.css`、`workbench.css` | 各界面样式 |

## 约定

改动界面前阅读[设计规范](../../docs/design/tnega-design.md)和
[天气状态语言](../../docs/design/weather-language.md)。优先复用现有组件；颜色只引用 token，
深浅主题同步并满足 `contrast.test.ts` 的对比度底线。文件、改动、终端、浏览器和文档统一进入工作台。

Timeline 与状态推导保持纯函数；测试与 Web 源文件同目录，由根 Vitest 发现。
事件与领域词汇沿用 `CONTEXT.md` 的 Agent Run、Session、Workspace 和 Stream Event。
