# @tnega/context-insights

What a session's context is made of, and how a workspace spends its tokens.

- `GET /api/context?workspace=…&session=…` returns one session's report: stats,
  the billed tokens split by what the prompt held (system prompt, tool schemas,
  user messages, injected context, assistant replies, tool results) plus output,
  where active time went, the current context against the model's window, and
  one entry per model request for the trend chart.
- `GET /api/context-insights?workspace=…&range=today|7d|30d|all` rolls those
  reports up across the workspace's sessions and Project threads.

Everything is folded from the durable session log, so a replayed session reports
what the live one did. The prompt makeup is estimated with the session's own
token rule (`estimateMessageTokens`, which reads tool results through
`renderToolResult`) and scaled to the provider's reported prompt size; costs use
the prices set on each model route, as `@tnega/usage` does.

The host mounts it as a plugin (`contextInsightsRoutes`); the plugin owns an
in-memory report cache keyed by each log's size and modification time.
