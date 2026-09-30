# @tnega/approval-openai

Independent `ApprovalReviewer` Provider using OpenAI Responses. Depends only on Core and the approval-review Service Definition.

Mount `approvalOpenAI` with `{ apiKey }`; optional `model` defaults to `gpt-6.1-sol`, `baseUrl` to `https://api.openai.com/v1`, and `timeoutMs` to 30000. `fetch` supports local test transport injection. Credentials are supplied explicitly.

Each action uses a separate Responses call containing the approval policy and supplied action/evidence state. Tools are empty, storage is disabled, reasoning effort is low, and output uses a strict decision/risk/reason JSON schema. Only a completed response with one completed output text is accepted. Refusal, incomplete output, malformed decisions, API failures, timeout or disposal ask. Truncated evidence cannot allow. Review does not override tools policy or sandbox enforcement.

The configured endpoint receives action input, schema and supplied evidence. `baseUrl` is an API prefix, with `/responses` appended. `store:false` disables Responses storage; service data processing remains governed by the account's OpenAI terms.

Protocol references: [Responses API](https://developers.openai.com/api/docs/guides/text), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol). This adapter follows the repository MIT license; API use follows OpenAI service terms. No SDK is bundled.
