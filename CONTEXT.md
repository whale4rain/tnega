# Tnega

Tnega 是一个自研核心的 Agent Harness：Agent = Model + Harness，Harness 负责模型之外的一切，并把 Eval 提升为一等公民。

## Language

**Agent**:
一次完整的模型交互闭环，包含 LLM 调用、工具执行与消息持久化。
_Avoid_: bot, assistant

**Agent Run**:
一次由用户消息触发的 Agent 执行，属于且仅属于一个 Session，通过流式事件实时上报。
_Avoid_: turn（turn 在代码中指 Agent Loop 内部的迭代）

**Eval Run**:
一次评测运行，持久化为工作区 `.tnega/runs/*.json`。
_Avoid_: eval（动词保留为动作）

**Session**:
一个工作区内以 JSONL 持久化的对话事件日志，是消息历史的真源。
_Avoid_: conversation file, chat log

**Workspace**:
一个绝对路径目录；会话、工具沙箱与 eval/evolve 产物都归属其下。
_Avoid_: project, repo

**Fork**:
复制一个 Session 的事件日志得到的新 Session，二者此后独立演进。
_Avoid_: duplicate, clone

**Stream Event**:
Web 与 Agent 之间传输的归一化流式事件，只承载增量；最终状态以 Session 持久化内容为准。
_Avoid_: delta message, wire frame

**Tool Permission**:
每次 Agent Run 开始时选择的网络与 Shell 权限开关，运行期间不可修改。
_Avoid_: capability flag

**能力缝 (Seam)**:
一个可替换能力的完整三角色：Service Definition、Service Provider、Consumer。单指其中任一
角色时按角色称呼，不叫「缝」。例：`@tnega/search`（Definition）/ `@tnega/search-ripgrep`
（Provider）/ `@tnega/tool-search`（Consumer）构成搜索缝；`@tnega/spill` / `@tnega/spill-local`
/ `@tnega/tool-spill` 构成工具输出溢出缝。
_Avoid_: capability、capability flag、extension point

**Service Definition**:
拥有 `ctx.<key>` 的抽象 Cordis `Service`，承载词汇类型、稳定错误码与能力级默认值。不是
TypeScript `interface`。
_Avoid_: interface、service contract

**Service Provider**:
提供某个 Service Definition 一份实现的插件。注册能力，不注册模型可见的工具。
_Avoid_: backend、adapter、impl

**Consumer**:
程序化使用某个能力的插件，通常是模型可见的工具。只 import Service Definition，不 import
具体 Provider，也不枚举 Provider 或探测可用性。
_Avoid_: client、caller

**溢出 (Spill)**:
把过大的文本存到上下文之外、换回一个可检索定位符的动作。工具输出溢出缝在工具结果进入模型
上下文前按字节上限判断，超出时整份落盘、模型只看到头尾预览加定位符。完整原文只存在于溢出
文件里，日志与前端看到的都是预览（见 `docs/adr/0007-tool-output-spill.md`）。
_Avoid_: truncate、trim、dump

**Memory**:
跨 Session 的少量持久信息。全局 `~/.tnega/memory.md` 存用户明确要求记住的偏好；
Workspace `.tnega/memory.md` 在压缩时整理长期有效的项目约定。每次 Agent Run 使用的
快照进入请求记录；它不是 Session 的对话历史或压缩摘要。

**Timeline**:
一个 Agent Run 的可视化事件序列，展示消息、工具调用与工具结果。
_Avoid_: log view

**System Config**:
独立于工作区、位于用户主目录的模型配置，包含 apiKey、model、baseUrl 与 temperature。
_Avoid_: settings file, preferences

**Recent Workspace**:
由 Web UI 维护的系统级工作区访问历史，不是某个 Session 的属性。
_Avoid_: workspace list（那是当前可用工作区）
