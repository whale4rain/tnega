# `@tnega/terminal-local`

`ctx.terminals` 的本机 **Provider**：`TerminalManager` 在真实 PTY（`@lydell/node-pty`，首次使用时才加载）上开终端，每个终端保留有上限的 scrollback；`terminalLocal` 插件把它注册为 `ctx.terminals`，插件 dispose 时关掉所有终端。

Daemon 用同一个 `TerminalManager` 在它的机器上提供终端（`@tnega/daemon` 的 `exposeTerminals`）。
