# 时空可组合极端压力测试记录

日期：2026-08-23

范围：M1 core 时空语义（Context / Fiber / Effect / Event / Registry / Reflect）

测试文件：`packages/core/test/space-time.extreme.test.ts`

## 目标

对时空可组合做真实压力验证，覆盖热插拔风暴、依赖级联、scope 风暴、并发卸载、热更新合并与失败回滚的极端路径。

## 用例清单

| 用例 | 规模 | 验证点 | 结果 |
| --- | --- | --- | --- |
| 100 次热插拔 | 100 轮 mount / unmount | 监听器、service、disposer 均无残留 | 通过 |
| 20 代 provider 热替换 | 20 代 | dependent 每代恰好 reload 一次 | 通过 |
| 128 插件依赖级联 | 128 层链 | 根 provider 消失后整链失活，重新提供后整链激活 | 通过 |
| 64 个 sibling scope | 64 个隔离 scope | 同名 service 互不污染，只清理自身 key | 通过 |
| 64 fiber 同插件并发风暴 | 64 个并发 fiber | 同时挂载 / 卸载后 registry 清零 | 通过 |
| 65 次健康检查拨动 | 65 次 notify | 最终失活且无监听残留 | 通过 |
| 100 次 update 风暴 | 100 次连续 update | 合并为最终 config，旧 listener 不残留 | 通过 |
| 嵌套插件生命周期 | 父插件 + 子插件 | 父 disposer 先执行，子插件完全卸载后父卸载完成 | 通过 |
| disposer 抛错 | 两个 disposer | 一个抛错不影响另一个执行，fiber 到达 disposed | 通过 |
| 同类 scope 卸载风暴 | 两个 sibling scope | 卸载一个不干扰另一个和其他 scope | 通过 |

## 执行命令与结果

```text
pnpm typecheck
通过

pnpm vitest run packages/core/test/space-time.extreme.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)

pnpm test
Test Files  18 passed | 1 skipped (19)
Tests       192 passed | 1 skipped (193)

pnpm lint
通过
```

其中 core 包当前共 94 个测试。

## 测试过程中的发现

第一轮极端断言暴露 4 个失败，逐一复现后确认均为测试预期问题，不是 core 实现缺陷：

- 20 代 provider 替换需要先卸载上一代，不能同时堆叠同 scope 同名 provider。
- scope 隔离同名 service 时，本地 provider 卸载后 `scope.get()` 不回落父级，这是 isolate 语义，不是泄漏。
- 65 次健康检查拨动才能保证最终状态为 pending；64 次会结束在 active。
- 128 插件级联重新激活是异步传播的，等待最终 fiber 时需要使用轮询 `waitForState`，不能只 `await` 一次。

## 结论

时空可组合在极端规模下保持无残留、依赖联动、scope 隔离与失败回滚。未发现需要修改 core 语义的实现缺陷。

相关提交：`a8cd087`、`fb7ddc2`
