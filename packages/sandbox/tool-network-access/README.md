# `@tnega/tool-network-access`

模型可见的 `request_network_access`：命令被沙箱的命令网络拦下（stderr 里有
`tnega sandbox blocked host:port`）时，Agent 用它向人要域名，人在常规的审批卡片上决定。

- **决定权在人**：工具不在任何免审批名单里，总是经过 permission guard（人工，或用户选定的
  自动审批）；执行时还要求 `approvedElevation`，没有 guard 的宿主上它什么也不放行（fail closed）。
- **作用范围**：批准后对本 Session 的后续命令生效；`remember: true` 还经宿主的 `remember`
  回调写进 System Config 的允许表（设置里的 Command network）。
- **只在 `allowlist` 下有意义**：`open` 不需要；`off` 是人的选择，审批不能把它打开；拒绝表里的
  域名也不放行，只有人能在设置里改。`"*"` 永不授予。
- **可重放**：授予记录就是 Session 里这个工具的 `tool/result`。`NetworkGrants` 在第一次用到时从
  Session 读一次，恢复的 Session 保留授予。

它是沙箱缝的 Consumer：只依赖 `@tnega/sandbox` 的词汇，不认识任何 Provider。composition
（`packages/runtime` 的 `sandboxCapability`）只在宿主给出可写的网络设置（`SandboxNetworkSettings`）
时挂它，并用 `withGrants` 把授予并入每次执行的策略。
