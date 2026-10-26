# `@tnega/tool-secrets`

Consumer of `ctx.secrets`: masks secret values in tool results
(`tools/post-execute`, prepended so spill and other policies only see masked
text) and in live `progress` output (`tools/pre-execute`). See `../README.md`.
