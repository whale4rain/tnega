# `@tnega/core`

Tnega 的运行时内核：把 DSH / Cordis 的时空可组合语义收进一个自研实现。
没有特权核心 —— agent loop、tools、session、llm 全都是挂在这个内核上的插件。

## 五个概念

| 概念 | 文件 | 解决的问题 |
|---|---|---|
| `Context` | `context.ts` | 按名字存取服务的容器。`ctx` 是 Proxy，读属性被拦截并转给服务解析器，所以同一名字在不同子作用域可以指向不同实现 |
| `Service` + `inject` | `service.ts` / `registry.ts` | 有名字、有生命周期的能力单元 + 依赖声明。加载顺序由 `inject` 依赖图决定，不是配置行序 |
| event（五种派发） | `events.ts` | 不改循环加逻辑的扩展点 |
| `Fiber` + effect | `fiber.ts` | 一次挂载 + 可撤销的注册。`ctx.effect(setup)` 收集清理函数，卸载时按逆序执行 |
| plugin | `registry.ts` | 以上一切的打包单位（函数 / Service 类 / 带 `apply` 的对象） |

## 事件派发方式

`ctx.emit / parallel / serial / bail / waterfall / waterfallAsync`。最重要的控制流是
`waterfall`（中间件/洋葱模型）：监听者调 `next(...)` 把参数交给下一层，不调则短路。

## 关键 API

- `ctx.plugin(plugin, config)` → fiber（Promise-like，`await` 等启动完成，卸载用 `fiber.dispose()`）
- `ctx.on(name, listener)` — 注册即 effect，fiber 卸载自动移除
- `ctx.provide(name, value, check?)` — 注册服务，同名重复注册在同一作用域直接失败
- `ctx.isolate(name)` / `ctx.extend(meta)` — 子作用域，服务沿父链查找，可覆盖
- `Service` 基类 — 构造时 `super(ctx, name)` 即完成注册，属当前 fiber
- `InvariantRegistry`（`invariant.ts`）— 每包可注册运行时关系检查器（见各包 `./invariant`）

## 语义纪律

- **registration is an effect**：插件的注册归本次挂载的 fiber 所有，卸载即撤销。
- **同名服务响亮失败**：不静默覆盖。
- **必需依赖写进 `inject`**：声明过的才能 `ctx.<name>`；可选服务用 `ctx.get(name)`。
- **空导出也有原因**：纯工具包没有 invariant 时也要说明为什么（见 DSH 风格）。

## 测试

`packages/core/test/`。重点看 `space-time.extreme.test.ts`（热插拔风暴、依赖级联、
scope 隔离、并发卸载），它把时空语义压到极限。
