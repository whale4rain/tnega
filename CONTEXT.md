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

**Timeline**:
一个 Agent Run 的可视化事件序列，展示消息、工具调用与工具结果。
_Avoid_: log view

**System Config**:
独立于工作区、位于用户主目录的模型配置，包含 apiKey、model、baseUrl 与 temperature。
_Avoid_: settings file, preferences

**Recent Workspace**:
由 Web UI 维护的系统级工作区访问历史，不是某个 Session 的属性。
_Avoid_: workspace list（那是当前可用工作区）
