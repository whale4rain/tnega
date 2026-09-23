# `@tnega/search-ripgrep`

`ctx.search` 的 **Service Provider**：用 ripgrep 实现工作区搜索。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Service Provider**。它 `extends SearchService`（Service
Definition），构造时由基类完成 `ctx.search` 注册；它只依赖 `@tnega/search` 与
`@tnega/execution`，**不依赖 `@tnega/tool-search`**。

一次组合只挂一个 Provider：同作用域注册第二个同名服务会由 core 直接抛出。

```
@tnega/search-ripgrep (本包) ─┐
                              ├─→ @tnega/search
@tnega/tool-search           ─┘
```

本包只实现机制：`resolveFindFiles` / `resolveSearchText` 落定默认值，
`runFindFiles` / `runSearchText` 落进程。`search/pre-search`、`search/post-search`、
`search/result`、`search/error` 由 Service Definition 的模板方法统一派发。
**这里不出现任何事件名** —— 事件面对 Provider 是透明的（也正因此不可绕过）。

## 机制

`rg` 永远以固定 argv 向量启动（`@tnega/execution` 的 `runProcess`，`shell: false`），
模型可控的值都是独立参数，中间没有引号层。几个不显眼但必要的地方：

- `--no-config` 打头：宿主的 `RIPGREP_CONFIG_PATH` 否则可以注入 `--pre`，让 ripgrep
  对它遍历的每个文件执行任意预处理器。
- `--no-require-git`：ripgrep 默认只在 git 仓库里应用 `.gitignore`，这个标志让
  「尊重 .gitignore」在非 git 工作区也成立（实测确认过）。
- 每个排除目录一条取反 `--glob=!**/<name>`：遍历时剪掉该目录，但把该目录显式作为
  搜索根时仍然可用。
- 搜索进程的 stdin 由 `@tnega/execution` 指向 `/dev/null`：没有显式路径时 ripgrep 会把
  非 TTY 的 stdin 当作输入源，一个打开的 stdin 管道会让它永远等下去。
- 退出码 1（无匹配）是正常结果；其它非零退出按 stderr 分类成
  `SEARCH_INVALID_PATTERN` 或 `SEARCH_FAILED`；输出被 `maxOutputBytes` 截断一律
  `SEARCH_OUTPUT_OVERFLOW` 拒绝，绝不把半截结果当成完整结果。

## 配置

`cwd` / `ripgrepPath` / `respectGitignore` / `excludes` / `timeoutMs` /
`maxOutputBytes` / `maxResults` / `execution`。未给的字段取 `@tnega/search` 导出的能力
默认值（`DEFAULT_SEARCH_*`）。

## 文件

`binary.ts` 二进制解析（显式路径 → `PATH`，按配置值 memoize）、`argv.ts` argv 构造、
`parse.ts` `--json` 解析与退出码分类、`index.ts` 服务实现。
