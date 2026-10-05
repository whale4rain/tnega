# Tag-triggered release implementation plan

> **For agentic workers:** Use executing-plans to implement this plan task by task.

**Goal:** Pushing a version tag validates and publishes npm and the Windows updater artifacts automatically.

**Architecture:** A read-only Windows job tests and builds fixed artifacts. An isolated Ubuntu publisher verifies their manifest, uses npm OIDC and keeps a single GitHub release draft until all assets pass verification.

**Tech Stack:** Node 24, pnpm 11.19.0, Vitest JSON, electron-builder, GitHub Actions and npm Trusted Publishing.

**Spec:** `docs/publish/README.md`; user authorization on 2026-10-05: start the complete release on a new tag.

## Global constraints

- Versions are `x.y.z` or `x.y.z-beta.N`; stable and preview channels stay separate.
- No real release or tag is created while implementing this automation.
- Existing published bytes must never be replaced on a retry.
- Match only the named historical test failures; new failures block publication.

## Task 1: Release gates and workflow

Files: `.github/workflows/release.yml`, `scripts/release-ci.mjs`, `scripts/release-publish.mjs`, `docs/publish/test-baseline.json`, `test/release-ci.test.mjs`.

- [x] Write executable tests for test failure matching, runtime errors, version ordering, artifact tampering and release retry decisions; run `node --test test/release-ci.test.mjs` and observe failure before implementation.
- [x] Implement exported `checkReport(report, baseline, root)`, `compareVersions(a, b)`, `verifyBundle(dir, version, commit)` and `checkAssets(assets, manifest)`; wire CLI commands `check`, `test`, `bundle`, `verify` and the publisher to these gates.
- [x] Add push-tag workflow with read-only build permissions, fixed artifact transfer and OIDC/write permissions only in the publisher. Build with `--publish never`; upload a draft and verify SHA256 before publishing.
- [x] Run the helper tests, targeted existing release/package tests, typecheck, lint and workflow validation. Run no publishing commands.

## Task 2: Runbook and delivery

Files: `docs/publish/README.md`, `README.md`, `apps/desktop/README.md`, `CHANGELOG.md`.

- [x] Document tag preparation, one-time npm Trusted Publisher setup, immutable retries and the exact legacy failure allowance. Retain manual publication as an emergency fallback.
- [x] Review the final diff; deliver with `feat(release): automate publication on version tags`, integrated into main and pushed without a new tag.

## Validation evidence

- 12 offline release safeguard tests passed; 20 existing release/package/desktop artifact tests passed.
- Root and desktop typechecks and lint passed.
- The real full-suite gate completed: 1319 tests, 1294 passed, 19 exact historical failures, 6 skipped; all 12 package artifact tests passed, no unhandled errors.
- actionlint 1.7.12 passed except its documented unsupported `concurrency.queue` key; that single diagnostic was excluded after checking GitHub's official reference.
- No tag, npm publication or GitHub release was created to test this change. Hosted OIDC publication remains untested until the user configures npm and pushes the next prepared tag.
