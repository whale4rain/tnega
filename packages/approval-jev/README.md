# @tnega/approval-jev

Independent `ApprovalReviewer` Provider for TypeSafe Jev. Depends only on Core and the approval-review Service Definition.

Mount `approvalJev` with `{ apiKey }`; optional `model` defaults to `jev-latest`, `baseUrl` to `https://api.typesafe.ai/v1`, and `timeoutMs` to 30000. `fetch` supports local test transport injection. Keys are supplied explicitly; this package does not read credentials or invoke agent tools.

Sends the bounded action/evidence state as four named System One questions: risk, exact authorization, task alignment and conflict. Risk choice confidence and chosen probability must both reach 0.95. Confident high risk denies. Low risk allows with task alignment at least 0.8 and conflict at most 0.2; exact-command authorization is not required for these bounded actions. Medium risk still requires exact authorization at least 0.95 and conflict at most 0.05. All allows require human task evidence and complete context. Missing, malformed, failed or cancelled reviews ask. Dispose aborts in-flight requests.

Decisions include structured `scores` (risk confidence, selected probability, authorization, task alignment, conflict and context truncation). Auto Approval persists these in `approval/review` audit metadata. Ask reasons name the failed condition, observed score and threshold; HTTP failures retain their status without recording credentials or raw response bodies. Jev supplies probabilities, not generated explanations. Existing audit events remain readable, but only new reviews have scores.

The configured endpoint receives action input, schema and supplied evidence. `baseUrl` accepts an API prefix or the complete `/systemone` endpoint. Review does not override tools policy or sandbox enforcement.

Protocol references: [official OpenAPI](https://api.typesafe.ai/openapi.json), [model catalog](https://docs.typesafe.ai/models). This adapter follows the repository MIT license; remote API access follows TypeSafe service terms. No provider SDK is bundled.
