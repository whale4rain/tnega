# `@tnega/office`

读写 Office 文件（xlsx / docx / pptx）的纯库，供 `@tnega/tool-office` 暴露给模型。

## 这不是一条缝

本包没有 ctx key，与 `@tnega/execution` 同类。只有一份实现时不抽象 Service；以后若要接
Univer 等后端，再在本包之上加 Service Definition。

## 语义

- 输入是结构化描述，输出是字节或纯数据；本包不碰文件系统，路径围栏由调用方负责。
- 编辑是批量的：`editWorkbook` / `editDocument` / `editPresentation` 按顺序应用，任何一步失败都
  reject，不产出文件。docx 与 pptx 是**原地**编辑：只改目标节点与引用到的部件，样式、版式、
  母版、图片与未建模的内容原样保留。
- 主题 `Theme { font, headingFont, accent }` 三种格式共用：字体落到正文与标题，强调色用于标题、
  表头与图表配色。
- 错误统一为 `OfficeError`：`OFFICE_INVALID`（请求或文件不合法）、`OFFICE_UNSUPPORTED`
  （例如编辑会丢掉无法重建的图表时拒绝）。

## 公式

公式以 `{ formula }` 写入。保存时由 `WorkbookEvaluator` 重算并写入缓存结果，让不做计算的读者
（预览器、图表缓存）也能看到数值；同时设置 `fullCalcOnLoad`，Excel 打开时以它的重算为准。
求值是近似的：自有解析器处理引用、运算符与优先级，函数交给 formulajs。命名区域、整列引用、
数组公式等不支持的写法求值为错误码（`#NAME?` 等），不抛错。读取时优先使用文件里的缓存结果。

## 图表

| 格式 | 实现 | 数据 |
| --- | --- | --- |
| xlsx | `xlsx-chart.ts` 在 exceljs 保存后直接写入图表部件、绘图锚点、关系与内容类型 | 引用单元格区域，缓存值来自公式求值 |
| docx | `docx/charts` 的 `ChartRun` | 内嵌工作簿，可在 Word 中编辑数据 |
| pptx | pptxgenjs `addChart` | 内嵌工作簿 |

exceljs 重新保存时会丢掉图表，所以 `editWorkbook` 先把已有图表读回成规格，编辑后再写回；
工作表改名会同步改写图表引用。遇到无法如实重建的图表（类型或引用不受支持）时拒绝编辑。

## 当前范围

| 类型 | 生成 | 检查 / 读取 | 编辑 |
| --- | --- | --- | --- |
| xlsx | 单元格、公式、样式（字体/颜色/边框/对齐/换行/数字格式）、合并、行高列宽、冻结、筛选、图表 | 大纲（含图表）；区域读取带公式求值 | 以上全部，含增删图表与 sheet |
| docx | 标题、段落、列表、表格、分页、图表；主题、页面、页眉页脚、页码 | 大纲；段落、表格与图表按块读取 | 跨 run 替换（含页眉页脚）、改写段落与单元格、插入与删除块 |
| pptx | 封面、标题 + 正文/要点/表格/图表、备注；主题、背景、页码 | 大纲；按页读取形状文本、表格、图表与备注 | 跨 run 替换、改写形状文字、按原尺寸与版式插入新页、删除与移动页 |

docx 由 `docx` 生成；读取直接解析 OOXML（jszip + xmldom），标题级别按样式名识别。pptx 由
`pptxgenjs` 生成，形状以 `Title` / `Body` / `Bullets` / `Table` / `Chart` 命名。原地插入的内容
用同一套生成器渲染，再连同样式、编号、图表与关系搬进目标文件（`package.ts`）。
