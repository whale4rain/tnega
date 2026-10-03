# Version policy and desktop update channels

日期：2026-10-03。状态：已完成。

## Scope

Audit every adjacent actual Git tag, including merged branch commits. Document
the audited ranges in CHANGELOG; refresh README, AGENTS and docs/publish with
continuous changelog maintenance and user-authorized patch release policy.
No external publishing is part of this implementation.

## Tasks

1. Correct changelog coverage and version ownership from the tag audit. Define
   stable `x.y.z` and preview `x.y.z-beta.N`, with autonomous patch decisions
   after several stable features; major/minor decisions require the user.
   Verify local document links and commit the documentation unit.
2. Test then implement desktop channel persistence and selection. Extend
   UpdateController with `setChannel('stable' | 'preview')`, default stable;
   configure electron-updater's `latest` / `beta` feeds and disallow downgrade.
   Changing a channel invalidates a downloaded update; switching is blocked
   during a check/download. Persist to Electron userData, validate IPC input,
   expose the setting through preload and the existing Settings update row.
   Test channel selection, pending-update invalidation, busy behavior, persisted
   preferences and renderer selection. Run desktop/Web focused tests,
   typechecks and build before committing this feature with its changelog entry.
3. Test then implement stable/preview release metadata in scripts/release.mjs:
   preview feeds are `beta.yml`, GitHub releaseType is `prerelease`, npm uses
   `--tag preview`; stable feeds remain `latest.yml`. Use a small release-version
   helper shared by version validation/feed/release checks. Exercise the script
   against temporary fixture repositories and installer files, without external
   publication. Run focused release tests, syntax checks and commit with docs.

## Completion

All audited tag ranges accounted for, user-visible channel survives restart,
stable installations exclude prereleases, preview installs can return to a later
stable version without downgrading, and release metadata matches the version.

## Validation

Adjacent-tag commit counts verified with `git rev-list --count`; documentation
links checked. Desktop/renderer/release tests passed, as did root, desktop and
Web typechecks, lint, production Web/runtime build, Electron main/preload build,
and `pnpm test:package` (11 consumer tests). Independent review found no critical
or important issues. No version bump, tag, push or external publication occurred.
