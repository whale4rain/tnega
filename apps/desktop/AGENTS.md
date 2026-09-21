# Desktop 开发指南

本目录是 Tnega 的 Electron 宿主；它加载 `dist/web`，并通过本地 loopback
server 复用 CLI runtime。改动前阅读同目录 `README.md`，再阅读相关的
`src/`、`scripts/` 或 `test/`。

## 边界

- Renderer 保持 context isolation、sandbox 开启、Node integration 关闭；只通过
  `src/preload.ts` 暴露经验证的最小 IPC bridge。
- 主进程在 `src/main.ts` 组装本地 server 与窗口生命周期。涉及关闭、IPC 或路径
  边界的改动，同时更新相邻测试。
- 打包配置的唯一来源是 `electron-builder.yml`；Windows 图标使用
  `build/icon.ico`，必须保留方形多尺寸图层和透明圆角。

## 命令

- 开发：`pnpm --filter @tnega/desktop dev`
- 类型检查：`pnpm --filter @tnega/desktop typecheck`
- 快速 Windows 解包验证：`pnpm --filter @tnega/desktop exec electron-builder --dir`
- 生成 Windows 安装包：从仓库根运行 `pnpm package:desktop`；安装包输出到
  `apps/desktop/release/`。

## 完成标准

- 修改打包配置、图标或根打包脚本时，运行
  `pnpm exec vitest run apps/desktop/test/package.test.ts`。
- 修改 main 或 preload 时，运行对应的 `apps/desktop/test/` 测试；发布产物变动再
  运行 `pnpm package:desktop`，确认 `release/` 中出现新的安装包。
- `out/` 与 `release/` 均为生成物，不纳入提交。
