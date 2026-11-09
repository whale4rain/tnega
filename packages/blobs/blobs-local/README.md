# `@tnega/blobs-local`

`ctx.blobs` 的本机 **Provider**：`~/.tnega/blobs/<aa>/<hash>` 放字节，`<hash>.json` 记大小和媒体类型（`aa` 是哈希的前两位，免得一个目录太大）。两个文件都先写临时文件再改名，读的人只会看到完整的文件。

```ts
await ctx.plugin(blobsLocal)            // 或 { root } 指定目录
```
