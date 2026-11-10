# Secrets

Keys the user gives the agent: the agent asks with `ask_user_question` and a
`secret` name, the user types the value into a hidden field, and the agent's
commands get it as an environment variable. The value never enters a Session,
an event, or the model's context.

```
@tnega/secrets-pg ─→ RememberedSecrets (sealed rows on a server)
@tnega/secrets-local (Provider) ─┐
                                 ├─→ @tnega/secrets (ctx.secrets)
@tnega/execution-secrets ────────┤   (Consumer: command environment)
@tnega/tool-secrets ─────────────┘   (Consumer: masks values in tool results)
```

`@tnega/user-questions` also consumes `ctx.secrets`: it hands a secret answer
to the store and keeps only `{ name, remembered }` in the Session.

## Lifecycle

- One store per Agent scope (one Session); subagents in that scope share it.
- A session secret lives in the host's memory until the Session is deleted, the
  secret is removed, or tnega exits.
- A remembered secret is saved for the workspace in `<tnega home>/secrets.json`
  (owner-only) and comes back after a restart, for every Session there. A
  server keeps it in Postgres instead, sealed with AES-256-GCM under
  `TNEGA_MASTER_KEY` (`@tnega/secrets-pg`, a `RememberedSecrets` store).
- A background process keeps the environment it started with.
- A value a command was given stays masked in this scope's tool output even
  after the secret is removed: masking covers the current values plus every
  value a command could have read.

## Limits

Masking replaces a value and its base64, base64url and URL-encoded forms with
`[secret: NAME]`. It keeps keys out of transcripts and the model in normal use;
it is not a wall against a command written to send a key somewhere.

## In a box (v2)

Keys never enter a box. The workspace's `.tnega/environment.toml` names which
secret goes to which host (`[[network.credentials]]`); `egressCredentials` in
`@tnega/environment` fills those headers from the user's secrets for the
egress proxy, and the box's commands get only a placeholder
(`proxiedSecretPlaceholder`, `tnega-egress-adds-NAME`) through
`secretEnvExecution(ctx, inner, { proxied, withholdOthers: true })`, so a tool
that sends a key only when the variable is set still sends the request and
the proxy puts the real key on it. A scope on a person's own daemon keeps
today's behaviour: values as variables.
