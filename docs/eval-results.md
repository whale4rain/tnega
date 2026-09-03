# 真实 benchmark 评测结果

## 2026-09-02 有效结果汇总

数据源与任务规模：

- BigCodeBench v0.1.4：导入 stdlib-only 全量 274 个，金标准可判 250 个，24 个在本机平台不可判。
- HumanEval：导入 164 个，官方解法与金标准 164/164 通过。
- MBPP full test：导入 500 个，金标准可判 499 个，其中 7 个真实运行在 LLM 请求阶段超时，未得到有效 verdict。
- SWE-bench Verified：导入全量 500 个，按官方 test_patch 做 base/gold 校验后，本机 Python 3.11 下 54 个可判；
  已完成的有效运行 28 个，剩余 26 个因 OpenCode Go 周额度 429 / 链路中断未取得干净结果，本轮按用户要求不再续跑。

评测口径：`check` 以真实测试命令结果为准；`trace` 按会话事件评分。
已完成运行只统计没有基础设施错误（429、超时、子进程失败）且金标准可判的任务。

| dataset | 金标准可判 | 已得有效结果 | check 通过 | check 通过率 | trace 通过 | trace 通过率 | 平均分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BigCodeBench | 250 | 250 | 243 | 97.2% | 250 | 100.0% | 0.958 |
| HumanEval | 164 | 164 | 164 | 100.0% | 164 | 100.0% | 0.984 |
| MBPP | 499 | 492 | 492 | 100.0% | 492 | 100.0% | 0.978 |
| SWE-bench | 54 | 28 | 18 | 64.3% | 21 | 75.0% | 0.709 |
| 总计 | 967 | 934 | 917 | 98.2% | 927 | 99.3% | - |

说明：

- BigCodeBench 24 个不可判是平台差异（子进程 / 外部命令 / mock 行为），不计入通过率。
- MBPP 剩余 7 个不是代码失败，run 中记录为 `LLM request timed out after 180000ms`，`turns=0`。
- SWE 的 26 个未完成实例与剩余评测均已停止；已有 28 个有效结果来自可复现的 run JSON 与 trace。
- 原始 run JSON 与 trace 在 `data/benchmarks/runs/` 和 `.tnega/runs/`（gitignored）。
