# `@tnega/blackboard-local`

`ctx.blackboard` 的本地 Provider：一条只增的 JSONL 日志，内存里折叠出当前版本。

## 落盘形状

```
<root>/                     # 约定为 <project>/.tnega/projects/<projectId>/blackboard
  journal.jsonl             # 每个提交版本一行
```

`root` 由组合层给出。Provider 自己**不解析 Project id**，也就不存在把它拼进路径的风险。
一行就是一条 `FactRecord`（`kind` / `id` / `seq` / `version` / `data` / `author` /
`source` / `createdAt` / `updatedAt` / `deleted`），形状不完整的行在加载时被丢弃 ——
这正好覆盖「进程在写入中间被杀」留下的半截行。

## 取舍

- **一条 journal，而不是每种 kind 一个文件**。`commitAll` 的原子性靠一次 `appendFile`
  写入；跨文件做不到，而信封与它的收件人投递记录必须一起出现。
- **读全量、常驻内存**。Project 的共享事实是索引级数据（记忆条目、Agent 关系、产物
  引用、消息信封），不含对话与文件正文；与 `SessionLog` 读整份 JSONL 的取舍一致。
- **同一批内同一 kind/id 只允许出现一次**。两条记录都基于同一个「当前版本」判断，
  第二条会静默压掉第一条，因此直接以 `BLACKBOARD_INVALID` 拒绝，而不是猜调用者的意图。
- **`seq` 是变更流游标**。`list(kind, { after })` 返回**当前版本** `seq` 大于游标的
  记录，按 `seq` 升序；更新过的记录会移到流的尾部。UI 与 Project Loop 靠它追赶。
- **没有压实（compaction）**。journal 只增；`delivery` 状态每次变更都会追加一行。
  本地单机场景下这是可接受的代价，换来的是每个投递状态都可追溯。
