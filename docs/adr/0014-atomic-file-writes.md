# ADR 0014：文件写入用 staging + 原子发布，覆盖受读后写约束

> 状态：已采纳（2026-10）
> 相关：`docs/adr/0008-sandbox-seam.md`、`docs/plans/tool-surface-and-fs-alignment.md` 阶段 B

## 背景

`write_file` 原本是 `writeFile(target, content)`：直接截断目标再写。
两个后果：

1. 写到一半崩溃，目标文件**永久截断**，旧内容没了。
2. 任何读者（另一个 agent、编辑器、构建进程、文件监视器）都能在窗口期读到半个文件。

同时 `write_file` 没有任何「我读过吗」的概念，覆盖一个从未读过的文件是允许的。
实测数据（本仓库一次真实会话）：`write_file` 566 次、`read_file` 162 次 ——
也就是说大量写入发生在「没有先读」的情况下。

## 决策

### 1. 原子发布照参考实现的形状

同目录私有 staging 目录（`0700`）→ 独占创建临时文件（`wx` / `0600`）→ 写入并 `sync` →
按情况发布：

- 目标**已知不存在**：`link(temp, target)`。原子**且不覆盖**，并发创建以 `EEXIST` 暴露；
- 目标**已存在**：`rename(temp, target)`（Windows 上 libuv 走 `MoveFileEx` + `REPLACE_EXISTING`）。

最后删 staging。崩溃留下的是旧文件加一些 staging 残渣，而不是截断的目标。

**没有实现 `ReplaceFileW` 与 DACL 复制**：那需要 Win32 FFI，而 FFI 属于
`packages/sandbox/sandbox-windows-acl`。临时文件建在工作区内的 staging 目录里，
因此继承工作区的 ACE。这条差异写在计划的「对齐差异」表里，不是遗漏。

### 2. 读后写：`fsGuard` 三档

按 `agentId + 绝对路径` 记录 `sha256`（或「确认不存在」），不持久化。覆盖时比对：

| 档位 | 行为 |
|---|---|
| `off` | 不校验 |
| `warn`（默认） | 记录并写入，结果里附一句提示 |
| `enforce` | 未读过 → 拒绝并提示先读；被外部改过 → 拒绝并给出新哈希要求重读 |

新建文件不受约束：读一个还不存在的东西不是创建它的前置条件。

**默认 `warn` 而不是 `enforce`**：`read_file` 162 次对 `write_file` 566 次是实测，
直接强制等于凭空多出几百次读。先观察一周的拒绝率与误伤，再决定是否收紧。
CLI 用 `--fs-guard=`，设置面板里标「实验性」。

`edit_file` 的唯一命中校验**不受档位影响**：那是编辑正确性，不是并发策略。

### 3. 按路径串行化

`Map<path, Promise>`。原子发布解决**可见性**（读者看不到半个文件），
不解决**读-改-写丢更新**（两个调用读同一版、各写一个改动，第二个静默覆盖第一个）。
两者互补，都需要。子 Agent 并行编辑同一文件是这套锁的常规场景。

## 为什么版本用 sha256 而不是 mtime

仓库已有实测：Windows 上文件 mtime 可比 `Date.now()` 超前约 8ms。
用 mtime 判「是否被外部改过」会产生假 stale，把正常的写入变成拒绝。
sha256 按内容判定，没有这个问题；代价是每次覆盖前完整读一次目标文件（有上限，
超过 8MB 的文件改为前缀读取，且那次读**不**授权后续覆盖）。

## 已知限制

- 观测记录不持久化：恢复的会话必须重读才能通过 `enforce`。参考实现同样接受这一点。
- `edit_file` 的 `edits` 是「一起定位、一起应用、不许重叠」，不是「依次应用」：
  每条 `old_string` 都在原始内容里定位。这样避免「前一条改完后一条再也匹配不上」的连锁失败。
- 读取的正文不带行号。给正文加行号会让模型把行号一起复制进 `old_string`
  （另一个参考实现就有这个坑，它靠提示词让模型自己剥）。行号改由错误信息提供。

## 后果

- 文件工具在文件域自己的包 `packages/fs/tool-fs`（read / write / edit / list /
  observed / atomic / guards）；按路径锁 `withPathLock` 留在 `@tnega/tools`，因为
  Windows ACL 授权也用它。观测记录属于挂载这组工具的插件实例，不再是进程级全局表。
- 发布保留目标原有的权限位（可执行脚本仍可执行），symlink 写穿到它指向的文件而不是被
  替换成普通文件；Windows 上目标被别的程序占用时重试，仍失败则退回原地写入；没有硬链接
  的文件系统（exFAT、部分网络盘）上新建文件退回 `rename`。
- `approval-host`、`host/runs.ts` 的 preimage 守卫、`workspace-files` 的变更统计、
  `auto-approval` 的证据摘要都学会认 `edit_file`。
- `node_modules` 之外的所有原子写（如 office）仍是各自的临时文件 + rename，
  未统一到 `atomic.ts`：office 的写入是整包二进制，与文本工具的路径解析不同，
  合并会引入不必要的耦合。
