# npm / pnpm 发布准备验证

日期：2026-08-25

## 目的

验证 `tnega` 可以作为单个自包含 CLI 包通过 npm 与 pnpm 安装，而不是依赖未发布的 `@tnega/*` workspace 包。

## 发布配置

- 根包：`tnega@0.1.0`，`private: false`，MIT
- `bin.tnega`：`./dist/bin.js`
- `files`：`["dist"]`，tarball 只包含 `dist / LICENSE / package.json / README.md`
- 构建：esbuild 把 `packages/cli/src/bin.ts` 与 `index.ts` 打成自包含 ESM，内部 `@tnega/*` 全部内联
- 发布前：`prepublishOnly` 自动运行 `pnpm test:package`
- 子包：`@tnega/*` 维持 `private: true`，不作为 npm 包发布

## 打包验证

```text
pnpm pack --pack-destination .
```

`tnega-0.1.0.tgz` 内容：

```text
dist/bin.js
dist/bin.js.map
dist/index.js
dist/index.js.map
LICENSE
package.json
README.md
```

## npm 安装冒烟

```powershell
npm install D:\task\tnega\tnega-0.1.0.tgz --no-audit --no-fund
node node_modules\tnega\dist\bin.js no-such-command
```

输出 `error: unknown command: no-such-command`，退出码 2，说明 bin 在 npm 安装环境中可执行。

## pnpm 安装冒烟

```powershell
pnpm add D:\task\tnega\tnega-0.1.0.tgz
node node_modules\tnega\dist\bin.js no-such-command
```

同样的输出与退出码，pnpm 安装环境验证通过。

## 自动化测试

`test/publish.test.ts` 覆盖：

- 根包发布元数据（name / private / license / bin / files / engines）
- bin 源码入口存在且带 shebang
- `dist/bin.js` 可运行并正确报错
- `dist/index.js` 不包含 `from "@tnega/..."` 外部 import

全量结果：

```text
Test Files  22 passed | 3 skipped (25)
Tests       225 passed | 5 skipped (230)
```

`pnpm typecheck` 与 `pnpm lint` 均通过。5 个 skipped 是未设置 API key 的真实 LLM 冒烟测试。

## 尚未执行

尚未真正上传 registry。发布前需要：

```powershell
npm login
# 或
pnpm login
npm publish
# 或
pnpm publish
```
