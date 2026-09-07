# `@tnega/benchmark`

公开真实 benchmark 导入器与金标准校验产物，供 `tnega eval` 跑真实评测与自进化闭环。

## 数据集

| 数据集 | 导入 | 金标准（本机可判） |
|---|---|---|
| BigCodeBench | stdlib-only 全量 274 | 250 通过，24 本机不可判 |
| HumanEval | 164 | 164/164 |
| MBPP | full test 500 | 499/500（MBPP/180 官方解法自身不过测） |
| SWE-bench Verified | 500 | 54 满足 base-fail/gold-pass |

清单文件 `data/benchmarks/manifest.json` 记录双数据源版本与数量；物化 fixture 与
`tasks.json` 见 `data/benchmarks/`。

## 导入器

各数据集子模块（`bigcodebench` / `humaneval` / `mbpp` / `swebench`）从公开数据集
构造本地可复现任务，尽量只依赖标准库执行以避免隐式 pip 依赖。`parquet` /
`stdlib` 是读取与过滤辅助。

## CLI

`tnega eval import-benchmark --subset / --repo / --ids / --version / --mirror / --force`，
按 dataset 合并 `tasks.json`。随后 `tnega eval run --task <id>` 可从合并清单过滤单个
真实任务。

## 评测与回流

- 金标准校验产物 `verified-bigcodebench.json` / `verified-swebench.json` /
  `verified-humaneval.json` / `verified-mbpp.json` 记录哪些官方解法本机可判。
- 真实评测结果见 `docs/eval-results.md`。
- 失败会话可回流成 draft task（`extract-failed-runs.mjs --valid`），审阅后合并回
  `tasks.json`。

## 测试

`packages/benchmark/test/`：各导入器结构、manifest 合并、stdlib 过滤。
