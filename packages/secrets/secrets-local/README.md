# `@tnega/secrets-local`

Provider of `ctx.secrets`. A host keeps one `SecretVault` (session secrets in
memory, remembered ones in `<tnega home>/secrets.json`, mode 0600) and the
composition layer mounts `secretsLocal` into each Agent scope with that scope's
workspace and Session. `secretRoutes` serves `GET` / `DELETE /api/secrets`
(names only). See `../README.md`.
