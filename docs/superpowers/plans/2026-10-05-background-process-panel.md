# Background process panel implementation plan

**Goal:** Show workspace long-lived processes beside Jobs in Background Tasks, with logs, local URLs and direct Stop controls.

**Architecture:** Keep ProcessRegistry separate from JobRegistry. Expose bounded process snapshots and stop operations through workspace-scoped HTTP endpoints. Share the workspace registry with Project composition and reuse the existing Background Tasks panel in sessions and Projects.

**Validation:** Registry tests cover non-consuming output, exit status and stopping; HTTP tests cover workspace isolation and direct user control; UI tests cover live processes, logs, URLs and Stop. Run relevant tests, typecheck and build, update Unreleased, then commit the feature.

- [x] Add failing registry and panel tests.
- [x] Implement process snapshots and workspace list/read/stop endpoints.
- [x] Share the registry with Project runtimes.
- [x] Display processes in Background Tasks and open local URLs in Browser.
- [x] Verify, update documentation and commit.

Validation: six related test files / 18 tests passed, final panel and registry
checks passed after test cleanup, root typecheck and build passed, and ESLint
passed for all changed TypeScript files. The HTTP test uses a real long-lived
process and verifies workspace isolation, Windows path casing and retained logs.
