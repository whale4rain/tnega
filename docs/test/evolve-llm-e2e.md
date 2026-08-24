# 自进化闭环真实 LLM 端到端实验

日期：2026-08-24

## 目的

把自进化闭环接上真实 DeepSeek：Agent Loop 与候选提案都由真实 LLM 驱动，跑完 baseline 评测 → LLM 提案 → 候选评测 → gate 选择 → 持久化。

## 运行方式

真实 LLM 冒烟测试文件：`test/evolve-llm.smoke.test.ts`。API key 只从环境变量读取，不写入代码或仓库：

```powershell
$env:OPENCODE_GO_API_KEY = "sk-***"
$env:TNEGA_EVOLVE_ARTIFACT_DIR = ".tnega/evolve-llm-e2e"
pnpm vitest run test/evolve-llm.smoke.test.ts
```

未设置 `OPENCODE_GO_API_KEY` 时该测试自动跳过。

## 实验配置

任务文件内容（测试内动态生成）：

```yaml
outputDir: .tnega/experiments
tasks:
  - id: fixed-reply
    inputText: Reply with exactly: tnega-evolve-ok
    assertion:
      expect: tnega-evolve-ok
evolve:
  maxIterations: 1
```

运行参数：

```text
baseline system: Always answer with exactly: wrong
maxIterations: 1
maxTurns: 1
maxSteps: 2
maxTokens: 512
cache: false
model: deepseek-v4-flash
endpoint: https://opencode.ai/zen/go/v1
```

## 实验结果

一轮完整闭环成功执行，共 3 次真实 LLM 调用：

1. baseline 评测：candidate `baseline`，score `1.000`，verdict `pass`。
2. LLM 提案：生成 candidate `stable-v1`，系统提示词改为中文稳定性约束。
3. 候选评测：candidate `stable-v1`，score `1.000`，verdict `pass`。

选择结果：

```text
decision rejected
delta 0.000
reason 1 gates failed: min-delta
```

baseline 与候选分数相同，`minDelta=0.001` 拒绝接受，experiment log 的 `baselineId` 保持不变。`evolve run` 在 `maxIterations=1` 结束后返回 `no-candidate (maxIterations reached: 1)`。

产物位置：

```text
.tnega/evolve-llm-e2e/.tnega/experiments/log.json
.tnega/evolve-llm-e2e/.tnega/experiments/runs/<run-id>.json
```

log 与 run 文件中不含 API key。

## 观察

闭环本身已完整打通：baseline 评测、LLM 提案、候选评测、gate 选择、实验树持久化全部由真实 LLM 驱动。该任务上模型直接遵循用户指令输出 `tnega-evolve-ok`，baseline 没有失败，因此提案只增加了稳定性约束，没有产生可度量提升，被 `min-delta` 正确拒绝。这说明 gate 避免了无实际收益的替换；要看到接受路径，需要构造 baseline 必然失败、候选能修复的任务，或允许“无退化稳定化”的接受策略。
