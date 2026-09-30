# `@tnega/tool-office`

模型可见的 Office 工具，基于纯库 `@tnega/office`。

| 工具 | 作用 | 权限 |
| --- | --- | --- |
| `office_inspect` | xlsx / docx / pptx 大纲 | 只读 |
| `office_read` | 读取单元格（公式带求值结果）、文档块、幻灯片 | 只读 |
| `office_create` | 按结构化描述生成文件；已存在时需 `overwrite: true` | 写工作区 |
| `office_edit` | 对 xlsx 批量修改；任何一步失败都不改动原文件 | 写工作区 |

- 路径经 `resolveInside` 限制在工作区内，按扩展名判断类型。
- 模型输入在 `src/input.ts` 中逐字段校验，错误信息带字段路径（如 `spec.sheets[0].rows[0][0]`）。
- 写入先落临时文件再改名；工具本身不做权限判定，由 composition 层的守卫按 `write_file` 同级处理。

挂载：`await ctx.plugin(toolOffice, { cwd })`。
