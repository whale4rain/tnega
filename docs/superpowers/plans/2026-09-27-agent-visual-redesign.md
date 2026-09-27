# Agent Studio Visual Redesign Implementation Plan

**Goal:** 统一 Astryx 工作台配色、排版、布局与可交互视觉校准稿。
**Architecture:** 使用 defineTheme 作为唯一色彩入口，旧视图 token 映射到同一主题；调整现有布局，不改变业务事件与数据。
**Tech Stack:** React、Astryx、TypeScript、Vite。
**Spec:** `docs/frontend-visual-design.md`

- [x] 从当前 main 建立独立设计分支，检查组件库文档与现有页面。
- [x] 建立 Studio 主题，连接 App，移除重复根配色。
- [x] 调整导航、标题、欢迎页、消息与输入区域的密度和层次。
- [x] 使用生产组件建立 `/design.html` 视觉校准页。
- [x] 检查深浅主题，运行 typecheck、build 和现有核心交互测试。
- [x] 审查并提交可独立验收的设计改动。

验证：Web build（包含 TypeScript 检查）通过；workbench、composer、projectExperience 三个文件共 13 项行为测试通过。新浏览器预览中已检查深浅主题与输入可发送状态。后端未启动，未执行真实模型端到端运行。
