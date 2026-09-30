# @tnega/tool-ptc

Independent `run_code` Consumer. Mount after `tools` and a `ptcRuntime` Provider.

- `mode: 'both'` (default) exposes native tools and `run_code`.
- `mode: 'ptc'` exposes `run_code` only and denies direct native dispatch.
- `mode: 'native'` registers no PTC tool.

Scripts call `await tools[name](input)`; tools are not global functions.
`ALL_TOOLS` entries contain `name` and `description`, with JSON input schemas
embedded in the description. Inspect unfamiliar tools before calling them.
The promise resolves directly to the tool output, without an extra result
wrapper: JSON stringify and now return strings, list_dir returns an array whose
directory entries have `type: "directory"`. Inspect small results before guessing
fields. Child failures reject and can be handled with try/catch. Child dispatch always passes through the original
`ctx.tools.execute` permission, validation, timeout and postprocessing pipeline.
Agent identity and cancellation propagate. `run_code` itself has no direct
external effects; composition can approve the orchestration boundary while
retaining all child approvals. Recursive `run_code` binding is excluded.

This initial implementation serializes child calls, including `Promise.all`, to
preserve permission order and avoid mutations racing. It does not automatically
retry a script after partial effects. Child errors are thrown into JavaScript and
can be caught. A child's `concludesTurn` propagates to the outer result.

Composition supplies `resolveSession(agentId)` for durable audit. Each child
writes `meta` kinds `ptc/dispatch-start` before executing and `ptc/dispatch` after,
with unique child and parent IDs. These are audit facts, never standalone model
tool-result messages. Results and audit payloads are bounded using Session's
canonical `renderToolResult`; oversized values become explicit previews.

`maxCodeChars` defaults to 32,000 and `maxResultChars` to 64,000. Cancelled and
unawaited work drains before the outer result closes; effects already completed
remain recorded. Tests verify approval preservation, sequencing, PTC-only mode,
recursive exclusion and child conclusions.
