# 系统级 API 配置替代仅环境变量

> 状态：当前
> 取代关系：取代 M5 的“仅环境变量”约定
> 当前实现：`packages/cli/src/config.ts`；Windows 使用 `%USERPROFILE%\.tnega\config.json`，`%APPDATA%\tnega\config.json` 仅用于旧配置迁移

M5 曾规定 key 只从环境变量读取；Web UI 需要在浏览器里维护自己的模型配置，无法要求每次启动都设置环境变量，因此改为系统级配置文件（Windows `%USERPROFILE%\.tnega\config.json`，macOS/Linux `~/.config/tnega/config.json`）保存 `apiKey`、`baseUrl`、`model` 与 `temperature`，环境变量仍然优先。API 只返回 `apiKeySet` 布尔值，绝不把 key 回传浏览器。旧版 Windows `%APPDATA%\tnega\config.json` 仅用于迁移。
