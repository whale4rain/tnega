# `@tnega/environment`

工作区的 `.tnega/environment.toml`：box 用哪个模板与资源、setup 脚本与它可用的 secret 和主机、agent 阶段的网络白名单、哪些主机由 egress proxy 加 key、空闲多久暂停。

- `parseEnvironment` 严格解析：未知键、通配主机上的 key、写死在文件里的 key、`open` 与白名单混用都会被拒。
- `approvalHash` 覆盖人需要批准的部分（setup 脚本、secret、setup 主机、白名单、key 去向、`open`），资源和空闲时间改了不必重新批准。
- `runSetup` 经 daemon 的 `runShell` 在 box 里跑 setup，secret 只进这一条命令的环境，输出里的 secret 被遮去。setup 不在模板构建时跑，所以模板与磁盘镜像里没有 secret。
