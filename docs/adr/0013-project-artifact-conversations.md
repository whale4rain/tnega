# 0013 — 产物修订沿用生成 Thread

> 状态：已采纳并实现
> 取代关系：修订 `docs/design/tnega-design.md` 原产物工作台展示约定；不改变普通文件工作台
> 当前实现：`packages/project/tool-blackboard/src/index.ts`、`packages/cli/src/project-artifacts.ts`、`apps/web/src/components/project/Artifacts.tsx`

日期：2026-10-09。

## 背景

用户要求产物在弹窗左侧预览，右侧保留生成 Thread 会话，支持引用所选内容修改。用户明确选择一个 Thread 可以管理多个产物，不为每个产物创建新会话。原内容哈希同时作为 Library 身份，导致修订生成新卡片、生成者信息可能因相同内容去重混淆。

## 决策

- Library artifact ID 保持稳定，`data.hash` 标识某版不可变字节；修订保留记录历史，要求 `artifact_id`、`expected_version` 以及同一生成者身份。
- `data.threadId` 绑定实际调用者，旧数据以 `author` 作为生成者。一个 Thread 可以生成多个产物。同一 Thread 重复发布同内容复用记录；不同 Thread 可共享字节存储，但保留各自 Library 记录。
- 打开弹窗只查找已有生成者，不创建 Thread、不唤醒模型。缺少生成者的旧数据明确报告无法关联。
- 用户发送时携带 artifact ID、所见 hash 和可选引用文本。服务端核对该 hash 属于该产物历史，路由到生成者；旧版本引用明确提示先读取当前版本，不使用旧版本直接覆盖。
- Box 产物引用增加可选 `artifactId`；hash 继续表示该消息产生时的字节快照。UI 通过稳定身份关联产物，历史字节仍可读取。
- HTML 继续使用不带同源能力的 sandbox iframe，不为跨框选文放宽隔离。不能获得可靠显示行号的格式不伪造行号。

## 后果

旧 hash ID 和旧消息引用仍能读取；新引用字段可被旧客户端忽略，但旧客户端对修订后的卡片关联不完整。Artifact Store 的字节寻址不变，Blackboard 的记录版本承担修订历史。打开行为不产生模型成本，只有用户实际发送才继续 Thread。

## 验证

行为覆盖：旧版本字节保留、稳定 Library 身份、异线程禁止覆盖、版本冲突、同内容不同生成者、打开不唤醒、发送引用正确路由及错误hash拒绝。UI 验证弹窗/会话同屏、选择与取消、发送失败保留输入、主题与密度布局。
