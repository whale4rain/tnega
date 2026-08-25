# 真实 LLM 内置工具调用端到端测试

日期：2026-08-25

## 目的

验证 `tnega run` 挂载的内置工具能被真实 DeepSeek 真正调用，而不只是注册在 runtime 里。覆盖 `calculator`、`read_file` 与 `shell` 三条路径，并确认 tool-call / tool-result 写入 session。

## 运行方式

真实 LLM 冒烟测试：`test/deepseek-tools.smoke.test.ts`。API key 只从环境变量读取，不写入代码或仓库：

```powershell
$env:OPENCODE_GO_API_KEY = "sk-***"
pnpm vitest run test/deepseek-tools.smoke.test.ts
```

未设置 key 时测试自动跳过。另外 `packages/cli/test/tools-e2e.test.ts` 用 mock OpenAI 端点确定性验证同一管线，不依赖真实模型。

## 测试用例

- `calculator`：真实 LLM 调用 `calculator` 计算 `2 + 3 * 4`，工具返回 `14`，模型随后输出最终答案。
- `read_file`：在 cwd 内写入 `note.txt`，真实 LLM 调用 `read_file` 读取并回复文件内容。
- `shell`：启用 `--allow-shell` 后，真实 LLM 调用 `shell` 执行 `echo tnega-tool-shell-ok`。

## 实验结果

```text
Test Files  1 passed (1)
Tests       3 passed (3)
Duration    34.78s
```

每次真实工具调用都会在 session JSONL 中产生 `tool-call` 与 `tool-result` 事件，session 文件不含 API key。

mock 端到端测试同时验证：路径沙箱拒绝 `../` 越界、`http_get` 仅在 `allowNetwork` 时注册并执行、`shell` 仅在 `allowShell` 时注册并执行。
