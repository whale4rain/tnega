# Web 前端采用 React + Vite，浅色 manpage 风格

用户点名用 `npx getdesign@latest add opencode.ai` 生成的 DESIGN.md（OpenCode 浅色 manpage 风）作为视觉规范；经确认它只生成设计规范而非项目模板，因此不购买 $199 kit。前端选择 React + Vite + TypeScript，放在 `apps/web`，生产 dist 打进 npm 包并由 CLI 用原生 `node:http` 托管，服务端保持零运行时依赖。
