# `@tnega/artifact-store`

产物内容存储能力的 **Service Definition**：拥有 `ctx.artifacts`。

## 这是一条缝的哪一个角色

本包是能力缝三角色里的 **Service Definition**。它是一条**抽象 Cordis `Service`**，
不是 TypeScript `interface` —— 抽象类才能拥有 `ctx.artifacts` 这个键，也才能让
Provider 通过 `extends` 完成注册。

```
@tnega/artifact-local (Service Provider) ─┐
                                          ├─→ @tnega/artifact-store (ctx.artifacts)
@tnega/tool-blackboard (Consumer)       ──┘
```

## 契约

- **只存内容，不建索引**。标题、来源、归属、版本都属于 Blackboard 的 `artifact` 记录；
  本缝只回答「这段内容在不在、拿出来是什么」。因此同内容 `put` 两次得到同一个
  `ArtifactRef`，重复发布不会产生第二份内容。
- **内容寻址**。`hash` 由 Provider 计算（sha256 十六进制小写），调用方不得自报；
  `ArtifactRef` 因此可以安全地写进 Blackboard 与消息信封。
- **只增不改**。没有 `delete` 与 `update`：内容一旦落盘，语义上不再变化。
- **拒绝，不静默降级**。超过上限以 `ARTIFACT_INVALID` 拒绝，不去截断内容。

## 为什么它不在 Blackboard 里

Blackboard 的 `FactKind` 记录上限是 256 KiB，而产物是任意大小的文件；把内容塞进版本
记录会让每次折叠都把大文件读进内存，也让「不复制对话、只存引用」的取舍失效。所以
Blackboard 只存 `ArtifactRef`，内容由本缝按哈希保管。
