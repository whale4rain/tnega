# `@tnega/blackboard-local`

`ctx.blackboard` 的本地 Provider：一条只增的 JSONL 日志，内存里折叠出当前版本。

## 落盘形状

```
<root>/                     # 约定为 <project>/.tnega/projects/<projectId>/blackboard
  journal.jsonl             # 每次提交（含整批 records）一行
```

`root` 由组合层给出。Provider 自己**不解析 Project id**，也就不存在把它拼进路径的风险。
新写入的一行是 `{ "type": "blackboard/transaction", "version": 1, "records": [...] }`。
`records` 包含这次 `commit` 或 `commitAll` 的全部 `FactRecord`；末尾换行是提交边界。
只有完整、带换行且所有记录都合法的事务才会整体进入内存，避免消息信封存在而投递记录缺失。
写入完成后同步文件，再发布内存状态；写入失败则按原来的字节长度截断并同步文件。
回滚失败后该 Provider 拒绝继续读写，需要重新打开以恢复日志。

启动时将未完成的尾部按字节截断并同步后才允许追加，包含截断在 UTF-8 字符中间的情况。
恢复过程中再次退出也不会损坏之前的完整提交。完整但非法的行沿用旧行为忽略。

兼容旧版每行一条 `FactRecord` 的日志，历史记录无需迁移或重写；旧记录没有末尾换行时
先补齐换行再继续追加。无法追溯恢复旧版多行批次的事务边界，也无法补回历史上已丢失的投递。
**旧版无法读取新事务行，会忽略其中的全部事实，因此写入新格式后不支持直接降级或混用旧版写入。**
需要降级时应恢复升级前备份；仅回退程序版本会丢失新提交的可见性。

## 取舍

- **一条 journal，而不是每种 kind 一个文件**。`commitAll` 的恢复原子性来自完整事务的
  换行边界，而不是假设一次 `appendFile` 不会部分写入；信封与投递记录必须一起出现。
  同一个 journal 只允许一个 Provider 写入，不提供跨进程写锁。
- **读全量、常驻内存**。Project 的共享事实是索引级数据（记忆条目、Agent 关系、产物
  引用、消息信封），不含对话与文件正文；与 `SessionLog` 读整份 JSONL 的取舍一致。
- **同一批内同一 kind/id 只允许出现一次**。两条记录都基于同一个「当前版本」判断，
  第二条会静默压掉第一条，因此直接以 `BLACKBOARD_INVALID` 拒绝，而不是猜调用者的意图。
- **`seq` 是变更流游标**。`list(kind, { after })` 返回**当前版本** `seq` 大于游标的
  记录，按 `seq` 升序；更新过的记录会移到流的尾部。UI 与 Project Loop 靠它追赶。
- **没有压实（compaction）**。journal 只增；`delivery` 状态每次变更都会追加一行。
  本地单机场景下这是可接受的代价，换来的是每个投递状态都可追溯。
