# 真实 benchmark 评测结果

## 2026-09-02 首批批次

- 候选：`deepseek` @ 0.2.0
- 模型：`deepseek-v4-flash`
- 数据：BigCodeBench（stdlib-only 子集）与 SWE-bench Verified（sympy / requests / seaborn）
- 策略：`check`（真实测试命令）与 `trace`（会话事件评分）

| task | check | trace | score | turns | tokens |
| --- | --- | --- | --- | --- | --- |
| BigCodeBench/0 | pass | pass | 0.930 | 9 | 1792 |
| BigCodeBench/1 | pass | pass | 0.970 | 4 | 1104 |
| BigCodeBench/2 | pass | pass | 0.980 | 7 | 1266 |
| BigCodeBench/4 | pass | pass | 0.970 | 4 | 1561 |
| BigCodeBench/5 | pass | pass | 0.920 | 6 | 1941 |
| BigCodeBench/6 | pass | pass | 0.970 | 4 | 1333 |
| BigCodeBench/7 | pass | pass | 0.970 | 4 | 1574 |
| sympy__sympy-20916 | fail | pass | 0.460 | 9 | 11111 |
| sympy__sympy-23413 | fail | pass | 0.440 | 9 | 10940 |
| sympy__sympy-23824 | pass | pass | 0.950 | 9 | 12431 |
| sympy__sympy-23950 | fail | fail | 0.330 | 9 | 1508 |
| sympy__sympy-24443 | fail | fail | 0.300 | 9 | 6980 |

汇总：

- BigCodeBench check 通过率：7 / 7（100%）
- SWE-bench check 通过率：1 / 5（20%）
- SWE-bench trace 通过率：3 / 5（60%）
- 两策略合计 check 通过率：8 / 12（66.7%）

说明：

- `check` 以真实测试结果为准；`trace` 分数包含工具使用质量，存在比 check 宽松的情况，
  例如 sympy-20916 / sympy-23413 trace 通过但 check 失败。
- SWE 样例均来自金标准校验中 base-fail / gold-pass 的实例，失败判定为模型未修复 bug，
  不是 fixture 或 Python 3.11 环境问题。
- 原始 run JSON 与 trace 落盘在 `data/benchmarks/runs/`（gitignored，可复现导入后重跑）。
