# `@tnega/office`

读写 Office 文件（xlsx / docx / pptx）的纯库，供 `@tnega/tool-office` 暴露给模型。

## 这不是一条缝

本包没有 ctx key，与 `@tnega/execution` 同类。只有一份实现时不抽象 Service；以后若要接
Univer 等后端，再在本包之上加 Service Definition。

## 语义

- 输入是结构化描述，输出是字节或纯数据；本包不碰文件系统，路径围栏由调用方负责。
- 编辑是批量的：`editWorkbook(bytes, ops)` 按顺序应用，任何一步失败都 reject，不产出文件。
- 公式以 `{ formula }` 写入，读出时带最近一次求值结果；保存时设置 `fullCalcOnLoad`，
  Excel 打开时会重算。
- 错误统一为 `OfficeError`：`OFFICE_INVALID`（请求或文件不合法）、`OFFICE_UNSUPPORTED`。

## 当前范围

| 类型 | 生成 | 检查 / 读取 | 编辑 |
| --- | --- | --- | --- |
| xlsx | ✓ | ✓ | 单元格、公式、样式、列宽、sheet 增删改 |
