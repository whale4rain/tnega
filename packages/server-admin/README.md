# @tnega/server-admin

服务器管理页的 API（`/api/admin/`），只给 owner 与 admin：

- `GET /api/admin/overview`：所有人、每个人的设备（标出此刻连着的 daemon、哪些是 box 的 daemon）、box 列表与状态。
- `POST /api/admin/boxes/pause?id=`、`POST /api/admin/boxes/stop?id=`：暂停或停掉一个 box（经 `ctx.machinePool`）。
- `DELETE /api/admin/devices?account=&id=`：撤销一台设备并断开它的 daemon；admin 只能动 member 和自己的设备。

它只是 Consumer：读 `ctx.accounts`，有 box 时再读 `ctx.daemons` 与 `ctx.machinePool`，不持有状态。谁在请求由 `accounts-routes` 的守卫写进 `web.attributes(req).principal`。由 `packages/runtime` 的 `accountsCapability` 挂载，只在 `tnega server start` 下出现。界面在 Web 设置的「Server」一节。
