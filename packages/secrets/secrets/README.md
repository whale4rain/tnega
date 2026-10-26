# `@tnega/secrets`

Service Definition of the secrets seam: owns `ctx.secrets` (`SecretStore`),
the name rules (`secretNameProblem`) and the masking helpers
(`maskSecrets`, `maskSecretsDeep`, `createStreamMasker`). It registers nothing;
a Provider subclasses `SecretStore`. See `../README.md`.
