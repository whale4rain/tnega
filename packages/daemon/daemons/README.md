# `@tnega/daemons`

`ctx.daemons` 的 Service Definition（也是它唯一的实现：一张内存里的登记表）。服务器上此刻连着的 daemon，按**服务器发的设备 id**（`device` 表的行）登记，不信 daemon 自己报的 id。

- 接受连接的一方（`@tnega/daemon-gateway`）`add` 一条链接；要用机器的一方（box 池、将来让人选自己电脑的 run）`get` 或 `wait` 它。
- 每个设备只有一条活链接：同一设备再连上来，旧链接被关掉，新链接接管（断网重连立刻生效）。链接关闭时从表里删掉。
- `disconnect(deviceId, reason)` 关掉一个设备的链接（撤销的 token、停掉的 box）。作用域 dispose 时关掉所有链接。

测试：`test/daemons.test.ts`。
