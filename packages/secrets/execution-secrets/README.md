# `@tnega/execution-secrets`

Consumer of `ctx.secrets`: `secretEnvExecution(ctx, inner)` wraps an
`ExecutionProvider` so every shell command and process gets the scope's
secrets as environment variables, read at each call. It records what it handed
over (`noteInjected`), so `@tnega/tool-secrets` still masks those values once
session-only secrets are gone. Wrap the provider that spawns (the sandbox
decorator's `inner`). See `../README.md`.
