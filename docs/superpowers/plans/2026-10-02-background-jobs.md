# Background jobs implementation plan

Goal: Background long-running registered tools and bounded Subagent work using
the DSH job lifecycle, without bypassing the existing execution or permission pipeline.

Reference: D:/task/deepseek-harness/packages/jobs/{jobs,jobs-local,tool-jobs}.

Architecture: packages/jobs/jobs defines ctx.jobs, jobs-local owns the in-process
registry, tool-jobs exposes job_start/list/output/kill. The registry retains work
across Agent Runs and cancels/awaits it on exact owner or service disposal.
Tools still execute via ToolsService, with separate signals and audit metadata.
Subagents retain their durable Sessions and existing permission/depth limits.
Completion notices enter the owner's durable inbox; no persistence format change.

- Write behavioral tests for immediate return, state/output, timeout vs cancel,
  ownership, admission limits, cancellation and teardown.
- Implement the Definition, local Provider and tool Consumer; test registered
  tool guards/audit and real Subagent completion/cancellation.
- Mount jobs in headless and resident compositions, publish package exports,
  and document configuration and process-local limitations.
- Run focused and composition tests, typecheck/lint, publication build/tests.
- Independently review lifecycle/permission behavior; fix issues and commit.

Scope: final output only (existing ToolExecutor has no stream protocol), no new
Web UI, process restart recovery, Lua, or arbitrary executable code evaluation.

Completed: all implementation steps and independent lifecycle review. Verification:
50 focused/composition tests and 11 publication tests passed; build, typecheck,
ESLint and diff whitespace checks passed. The older Web suite has six failures
reproduced with the composition files restored to HEAD; unrelated failures remain
outside this change. Subagent output rewriting and post-execution failures are
covered to ensure cancellation still releases the actual child.
