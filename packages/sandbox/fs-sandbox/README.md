# `@tnega/fs-sandbox`

fs 侧路径围栏的**唯一实现**：什么算「工作区之内」、什么算「可写」，整个仓库只有这一份。

## 为什么它必须只有一份

改动前 `packages/tools/src/path.ts` 自己实现 `resolveInside`，而 Windows 沙箱机制另需
一套「可写根」判定。两份实现的漂移会直接表现为用户可见的不对称：`write_file` 写不进去，
而 shell 能写；或者反过来，`read_file` 认为某条路径在工作区内，而 ACL 授权没覆盖它。

现在：

```
@tnega/fs-sandbox ──→ @tnega/sandbox（模式词汇 + writableRoots）
        ↑                                   ↑
@tnega/tools（转发）              @tnega/sandbox-local（mount / ACL 授权）
```

`packages/tools/src/path.ts` 退化成 `export { PathSandboxError, resolveInside } from '@tnega/fs-sandbox'`，
既有导入路径与错误文案都不变。

## 包含判定

`isPathUnder(path, root, caseSensitive?)` 两段：

1. **词法快路径**：相等，或 `root + sep` 前缀。非大小写敏感平台先小写化；`root` 已经以
   `sep` 结尾（卷根 `C:\` 或 `/`）时不重复加分隔符。
2. **身份回退**：从目标沿 `dirname` 上溯，逐个 `stat` 比较 `dev` + `ino`，直到卷根。这
   识别 Windows 的 8.3 短名、大小写别名与目录 junction，而不需要用「文本近似」放宽包含
   性 —— 放宽包含性等于放宽围栏。

根不存在时返回 `false`：判不出来时按不包含处理（fail closed）—— 这只在词法比较已经失败、需要
身份回退时才生效。路径里夹了一个普通文件（`ENOTDIR`）在身份回退里算「未知」，继续向上找祖先；
词法包含是纯字符串性质，与文件系统形态无关，真正打开时由内核以 `ENOTDIR` 拒绝。

## `resolveInside`

在包含判定之外，还沿**最深的已存在祖先**逐个 `realpath`：词法判定看不出「父目录是
symlink，指向工作区之外」这种逃逸，因为它比较的是拼写而不是真身。返回值是词法目标
（不是 realpath）—— 调用方要的是可打开的那条路径，验证用的是它的真身。

## 写判定

`isWritablePath(target, policy)` / `assertWritablePath(target, policy)`：

- `read-only` → 一律拒绝，错误码 `FS_SANDBOX_DENIED`；
- `workspace-write` → 只允许 `writableRoots(policy)` 之内（含临时区）；
- `bypass` → 一律允许（「不沙箱」是调用方的选择，不是围栏的判断）。

**当前工具层不使用它做硬拒绝**：`read-only` 下 `write_file` 仍走
`ToolGuard` + `ApprovalBroker` 的逐次批准路径。把 fs 围栏改成硬拒绝会与既有审批语义打架，
那是产品决定而不是这次重构（见 `docs/adr/0008-sandbox-seam.md` 的「后果」一节）。

## 已知限制

这是**受信代码上的策略围栏，不是内核边界**：检查与写入之间仍有一个 TOCTOU 窗口（重解析
之后、syscall 之前祖先被换掉）。内核级隔离归 `ctx.sandbox` 的机制。

## 测试

`test/containment.test.ts`：词法包含、共享前缀（`work` 与 `work-other`）、身份回退
（junction 别名）、根不存在、普通文件段。
`test/fs-sandbox.test.ts`：`resolveInside` 的 `..` / 绝对路径 / symlink 逃逸、按模式的
可写判定、symlink 别名下的写拒绝。
