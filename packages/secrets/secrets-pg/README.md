# `@tnega/secrets-pg`

服务端保存「记住」的 secret：`docs/plans/v2-server-mvp.md` §3.2 的 `secret` 表，按 §4.6 用 AES-256-GCM 在服务端的主密钥（`TNEGA_MASTER_KEY`）下加密。它是 `@tnega/secrets-local` 的 `SecretVault` 的 `RememberedSecrets` 存储；只在本 Session 有效的 secret 仍只在服务端内存里。

- 数据库里没有明文。每行密文 = 12 字节 IV + 16 字节 tag + 密文；附加数据绑定 `账户 + 行名`，把一行的密文拷到另一行打不开。
- `key_id` 是主密钥的指纹（不泄露主密钥）：主密钥换了，旧行明确报 `SECRET_FAILED`「在另一个主密钥下加密」，不会当作空的。
- 行名是 `<工作区存储键>/<NAME>`（secret 名不能含 `/`），所以「记住」仍按工作区区分，与本机文件一致。
- `parseMasterKey` 只接受 32 字节（base64，如 `openssl rand -base64 32`，或 64 位十六进制）。
- 宿主用 `TNEGA_SESSION_STORE=postgres` + `DATABASE_URL` + `TNEGA_MASTER_KEY` 打开（`@tnega/runtime` 的 `openSecretVault`）；没有主密钥时仍用本机的 owner-only 文件。

测试：`test/secrets-pg.test.ts` 用 PGlite。
