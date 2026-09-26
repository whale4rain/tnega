# `@tnega/tool-blackboard`

Blackboard 与 Artifact Store 的 **Consumer**：模型可见的 `read_project`、`write_memory`、
`publish_artifact`、`read_artifact`、`index_resource`。只依赖两份 Service Definition，
不 import 任何 Provider。

```
@tnega/blackboard      (ctx.blackboard) ─┐
                                         ├─→ @tnega/tool-blackboard
@tnega/artifact-store  (ctx.artifacts)  ─┘
```

## 契约

- **读写的是当前 Project 的那一个 Blackboard**。没有「选一个 Project」的参数：作用域里
  挂的是哪个 Provider，读写的就属于哪个 Project。
- **记忆是条件提交**。改一条已存在的记忆必须带上读到的版本号。版本不符时工具不覆盖，
  而是把当前内容一起返回，让模型重新读取后再决定 —— 这条路径是设计稿「不能最后写入
  覆盖」在模型侧的唯一出口。
- **产物按内容寻址**。`publish_artifact` 先落内容再写索引；同一份内容发布两次复用同一个
  哈希，不会产生第二条记录。`read_artifact` 默认只回 64 KiB，模型要更长内容得显式提高
  上限 —— 大文件不该悄悄塞满上下文。
- **资料与产物分开**。`index_resource` 只记「东西在哪」（路径、URL），`publish_artifact`
  记「内容是什么」。前者引用外部，后者归项目所有。
- **署名来自作用域**。每条写入的 `author` 是调用工具的那个 Agent，模型不能自报身份。
