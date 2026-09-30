# Computer Use 与 Cowork 实现评估

调研日期：2026-09-30。将 compute use 理解为 Computer Use，将 univers 理解为 Univer；Cowork 指面向资料、办公产物和人机协作的工作模式。以下路线、风险和排期均是工程判断，不是已经完成的验证。

## 建议

优先实现 Cowork 的表格产物闭环，同时接入受控浏览器作为取数能力；全桌面控制放到后续。Cowork 是产品工作流，Computer Use 是执行能力，可以组合。首个场景：上传销售 CSV → 清洗与汇总 → 生成带公式的工作簿和报告 → 用户检查并修改 → 发布新版本。

## 仓库基础与缺口

- `CONTEXT.md`：Project / Thread / Box / Blackboard 已有协作词汇；Agent 历史仍以 Session 为真源。
- `packages/coding-agent/README.md`：已有 stdio MCP 接入和插件 dispose 子进程清理，适合浏览器工具原型。但 MCP 当前属于 coding 插件，需要让 Cowork 在 composition 层也能组装它，避免把办公能力绑定为 coding。
- `packages/session/src/index.ts`：`ModelMessage.content` 为 string。视觉控制需要端到端多模态链路：持久事件、媒体引用、历史折叠、压缩、token 估算、LLM adapter 与工具结果投影。截图路径本身不能让模型看见图片；Session 格式变更需明确迁移。
- `packages/project/artifact-store/src/index.ts`：已有内容寻址、只增不改的二进制存储，单份上限 16 MiB。适合发布文档快照，但不是可变编辑状态；大工作簿、图片和长期截图需要容量与保留策略。
- `apps/web/src/components/project/ProjectPanels.tsx`：当前产物查看为 Markdown/代码文本。Office 预览需要二进制传输、按类型加载编辑器和下载通道。
- `apps/desktop/README.md`：renderer 无 Node 权限。桌面操作应由 runtime 的受控辅助进程提供，不能直接开放 preload 的任意系统操作。
- 当前 Sandbox 只限制文件写。浏览器或桌面点击产生的外部副作用，不受 Workspace 路径围栏保护。

## Computer Use

### 库与选型

| 路线 | 库 | 适用性与代价 |
| --- | --- | --- |
| 浏览器结构化操作 | [Playwright](https://github.com/microsoft/playwright)、[Playwright MCP](https://github.com/microsoft/playwright-mcp) | Node/TS 适配好；MCP 以 accessibility snapshot 定位元素；先做原型，产品化后用 Provider 管理 session、权限、取消和资源 |
| 带模型辅助的浏览器动作 | [Stagehand](https://stagehand.dev/) | MIT；act / observe / extract 可逐步调用。适合局部使用，需计入额外模型调用与追踪 |
| 完整浏览器 Agent | [browser-use](https://github.com/browser-use/browser-use) | MIT、Python 路线；可作对照或有界子任务，但不要默认替换 Tnega Agent Loop，以免历史、重试、取消与 Eval 分裂 |
| Windows 语义控制 | [FlaUI](https://github.com/FlaUI/FlaUI) | .NET UIA2/UIA3；通过辅助进程暴露有界动作。不覆盖所有 Canvas/自绘控件 |

浏览器不等于整个电脑。Windows 之外还需要各平台 accessibility 与输入/截图实现；输入库只解决执行，模型还必须完成观察、目标定位和结果验证。

### 接入路径

遵循现有能力缝：Browser Service Definition → Playwright Provider → browser 工具 Consumer；未来独立 Desktop Definition / Provider / Consumer。Consumer 不枚举具体 Provider；Provider 选择放在 composition 层。Fiber dispose 关闭 BrowserContext、页面、辅助进程和监听；不要退出用户的整个浏览器。

第一阶段用独立 BrowserContext、文字观察和语义定位。暴露导航、观察、点击、填写、下载等有界工具，每个动作返回更新后的状态。第二阶段加入截图和视觉目标定位。第三阶段只支持 Windows 少量目标应用，并提供人工接管与紧急停止。

### 工程挑战

1. 权限：navigate/click 不是纯读取；需要区分观察、编辑、外部提交，授权绑定具体目标和动作。已有 read-only/workspace-write 不足以表达发邮件、下订单等语义。
2. 安全：网页内容属于不可信输入；控制域名、文件上传下载、localhost/私网访问和跳转。MCP 服务不能因为已连接就默认可信。
3. 稳定性：页面变化、过期元素引用、iframe、弹窗、验证码、焦点、DPI、多屏与用户抢鼠标。采用观察 → 动作 → 验证，限制重试；提交失败不能盲目重放。
4. 可恢复性：记录动作意图与结果不代表能恢复登录态或撤销外部操作。重启后重新观察；未知提交结果先核查，不能重复执行。
5. 评测：固定本地站点和测试账号，验证最终页面/业务状态，统计完成率、误操作、延迟和 token，不能以工具返回成功代替任务完成。

## Cowork 与 Univer

[Univer 官方仓库](https://github.com/dream-num/univer)提供 Apache-2.0 核心和 OSS 插件，支持浏览器与 Node headless、结构化 Facade API。高级能力属于独立 Pro 层；Office 文件交换、实时协作、历史以及部分图表/Slides 功能要逐项核对包和许可。不能以主仓库 license 推断整套产品均免费。参见[文件交换说明](https://docs.univer.ai/guides/sheets/features/import-export)。

[Univer CLI](https://github.com/dream-num/univer-cli)提供本地办公 Agent 工作流，含隔离草稿、结构检查、渲染与 Viewer 审阅；适合快速验证体验。CLI 开源不自动解除其 Pro runtime 的许可要求；应将其当可替换 Provider 原型。

### 两条实现路径

- 快速验证：Tnega 编排任务 → 有界 Univer CLI 执行 → Viewer 审阅 → 导出后发布 Artifact。先实测 Windows、离线性、许可证、进程清理、取消和路径限制，不先投入完整内嵌 UI。
- 产品集成：新增 Office Service Definition、Univer headless Provider 和结构化工具 Consumer，Web 按需挂载编辑器。工具操作范围、公式、段落等业务对象，避免向模型暴露任意代码执行。

### 状态与发布

编辑中的文档是可变工作状态；发布产物是不可变快照。执行前读版本，应用批量 patch，计算/校验后保存新快照，再用 Blackboard 条件提交更新当前版本引用。导出的 xlsx/docx/pptx 是交付格式，内部 snapshot 是编辑格式；两者要标注关联，避免双重真源。

第一版按文档串行写入；Agent 在草稿中修改，用户审阅后发布。先有版本冲突拒绝、变更预览、恢复旧快照，再考虑实时多人编辑。Blackboard 的 CAS 只能保护版本发布，不能自动合并单元格、段落和公式引用。

### 工程挑战

1. Office 兼容：格式可导入不等于无损往返。合并单元格、日期/精度、公式、外链、字体、分页、母版、图表和宏都要建立具体支持矩阵。
2. 计算与结果：保存公式不等于完成重算。验证公式错误、汇总值和数据类型；报告检查依据与数据来源；视觉输出检查溢出与分页。
3. 生命周期与部署：固定协调版本的 SDK 插件；前端懒加载；后台任务可取消；崩溃不能丢草稿。文件转换服务是否本地运行、联网和收集数据需要实测。
4. 许可与维护：按必需能力列出 OSS/Pro 依赖、服务要求及发行限制；用 Office 能力缝降低将来替换成本。
5. Eval：固定输入文件，检查业务答案、公式与导出可重开；像素截图仅作为布局补充。记录人改与 Agent 改冲突、失败保存、超限产物和恢复行为。

## 分阶段范围与粗估

以下按一名熟悉仓库的全职工程师、单平台、无复杂企业登录估算；未经过 spike，不能作为交付承诺。

| 范围 | 粗估 | 验收门槛 |
| --- | --- | --- |
| 浏览器 MCP 原型 | 3–7 工作日 | 固定站点任务、可取消、dispose 无残留、基础权限 |
| CSV → Univer 表格 → 审阅发布原型 | 1–2 周 | 正确计算、保存重开、版本冲突可拒绝、产物可取回 |
| 一个可用 Cowork 场景 | 4–8 周 | 任务编排、稳定编辑、失败恢复、导出与 Eval；取决于选定转换方案 |
| 受控浏览器产品能力 | 4–8 周 | 状态跟踪、权限、人接管、恢复、多场景 Eval |
| Windows 全桌面控制 | 8–16 周起 | 指定应用与显示配置通过稳定性测试；跨平台另估 |

建议先做两个 spike：受控浏览器读取一个页面，以及 CSV 生成可编辑表格、用户修改、重新发布。根据真实完成率、产物质量、许可与本地部署成本，再决定完整 Computer Use 与 Office 套件范围。
