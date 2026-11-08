# `@tnega/blobs`

大块字节的存储缝的 **Service Definition**：`ctx.blobs`。图片、过大的工具输出这类不该塞进 Session 事件的字节，按内容哈希（SHA-256，小写十六进制）存一份。本机 Provider 是 `@tnega/blobs-local`，v2 服务端是一个目录或对象存储。

- `put(bytes, mediaType)` 返回 `{ hash, size, mediaType }`；同样的字节再存一次不会多存，返回同一个哈希。
- 存进去的字节不再变。`get(hash)` 会核对字节和哈希，对不上时抛 `BLOB_FAILED`。
- 没有的哈希不算错：`get` 返回 `undefined`，`has` 返回 `false`。

接下来（P3 第三步）：Session 事件里的新图片只记哈希，读日志时再从这里取回。
