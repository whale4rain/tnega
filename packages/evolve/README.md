# `@tnega/evolve`

自进化循环：用 core 的安全变异 + eval 的可靠评估，实现候选生成、比较、选择与持久化。

## 流程

```
baseline 评测 → LLM/规则 propose 候选 → 候选隔离评测 → gate 选择 → 持久化
```

- `propose`：诊断失败模式并生成候选（`diagnose.ts`）。`createLlmProposeRule` 让真实
  LLM 返回 JSON 候选并校验字段。
- `ExperimentLog`（`log.ts`）：实验树，记录 candidate + verdicts + parent baseline，
  可 fork / 回放。
- `select`（`select.ts` / `service.ts`）：compare baseline vs candidate，gate 决策 ——
  safety 必过、regression 阈值、显著性规则。接受后成为新 baseline，拒绝保留旧 baseline。
- 人工审批 seam：`eval/run-end` 事件可暂停闭环，等待外部批准。

## 关键保证

候选在隔离 scope 加载与评测，失败不影响主 runtime。

## 测试

`packages/evolve/test/`：接受/拒绝路径、退化拦截、预算中止、审批暂停与恢复、
LLM 提案解析。真实闭环实验见 `docs/test/evolve-llm-e2e.md`。
