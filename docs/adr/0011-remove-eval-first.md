# 0011 移除 eval-first 设计

日期：2026-10-01

## 决策

删除 `@tnega/eval`、`@tnega/evolve`、`@tnega/benchmark` 三个包，以及 `tnega eval *`、
`tnega evolve run` 命令、`tnega/eval` 与 `tnega/evolve` 子路径导出和 `examples/` 下的评测任务。
Tnega 不再把 Eval 作为与 Agent Loop、Tools 平级的一等能力，也不再以「自进化」作为产品方向。

## 原因

- 产品重心已经转向桌面端的 coding / work 会话、Project 协作和面向前端开发的 in-app 浏览器；
  评测与自进化闭环没有被这些形态使用，却仍然约束着核心术语、公共导出与发布体积。
- `tnega eval` 的 coding candidate 复制了一份 runtime 组装逻辑，是 composition 层之外的第二条
  路径，维护成本高于收益。

## 后果

- 库使用者若依赖 `tnega/eval`、`tnega/evolve` 或 `evalApi` / `evolveApi` 聚合导出，需要固定到
  0.4.x 版本。
- `.tnega/runs/`、`.tnega/experiments/` 等既有产物不再被读取，可以手动删除。
- 质量验证依赖仓库内的 Vitest 行为测试与端到端测试；ADR 0008 中「Eval 与 Review」的表述
  保留为历史记录。
