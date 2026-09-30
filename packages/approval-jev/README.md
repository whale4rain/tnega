# @tnega/approval-jev

Independent `ApprovalReviewer` Provider for TypeSafe Jev. Depends only on Core and the approval-review Service Definition.

Mount `approvalJev` with `{ apiKey }`; optional `model` defaults to `jev-latest`, `baseUrl` to `https://api.typesafe.ai/v1`, and `timeoutMs` to 30000. `fetch` supports local test transport injection. Keys are supplied explicitly; this package does not read credentials or invoke agent tools.

Sends the bounded action/evidence state as three named System One questions. Risk choice confidence and chosen probability must both reach 0.95. Confident high risk denies; other risks allow only with authorization at least 0.95, conflict at most 0.05 and complete context. Missing, malformed, failed or cancelled reviews ask. Reasons describe threshold outcomes locally: Jev supplies probabilities, not generated explanations. Dispose aborts in-flight requests.

The configured endpoint receives action input, schema and supplied evidence. `baseUrl` is an API prefix, with `/systemone` appended. Review does not override tools policy or sandbox enforcement.

Protocol references: [official OpenAPI](https://api.typesafe.ai/openapi.json), [model catalog](https://docs.typesafe.ai/models). This adapter follows the repository MIT license; remote API access follows TypeSafe service terms. No provider SDK is bundled.
