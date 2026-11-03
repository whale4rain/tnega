# `@tnega/a2ui`

Agent 渲染界面（A2UI 子集）的词汇：`parseSurface` 把模型给的 surface 读成扁平组件表（只保留从 root 可达的组件，拒绝重复 id、环与未知组件，错误文案给模型看），`initialValues` 给出数据模型初值，`formatAction` / `parseAction` 是按钮回传给 Agent 的用户消息格式。

组件：`Column` / `Row` / `Card`（`children` 按 id 引用）、`Text`、`Image`（工作区图片路径，不接受 URL）、`Divider`、`TextField`、`CheckBox`、`ChoicePicker`、`Button`。输入通过 `path`（`"/key"`，只有一层）绑定到数据模型；也接受 A2UI 原文里的 `literalString`、`explicitList`、`usageHint` 写法。
