# Publishing a release

The runbook for cutting a Tnega release: the npm package (`tnega` CLI) and the
Windows desktop client, whose installed copies update themselves from the
GitHub release. Follow it in order; every step names its check.

Desktop 0.4.6 and later already support in-app updates. Users install an
update-capable client once; later upgrades happen through Settings → Check for
updates or the sidebar's Update action. Maintainers still build and publish
each new version with its update feed. Routine documentation and development
changes do not require packaging a new installer. CLI installations update
through npm.

## Version and changelog policy

- Update root `CHANGELOG.md` / Unreleased with each user-visible feature, fix or
  compatibility change, in the same commit. Describe behavior and migration,
  not internal refactors with no user effect.
- Audit `git log <previous-actual-tag>..<new-tag>` including merged branches.
  Gaps in version numbers do not create gaps in coverage. A preview's notes
  describe its changes; final stable notes include the whole batch since the
  previous stable tag, including all intervening previews.
- Commit independently verifiable changes promptly using Conventional Commits.
  Releases combine several stable new features into a tested delivery batch;
  do not bump or package on every commit.
- The agent may choose/increment patch `x.y.z` autonomously. Major `x` and minor
  `y` require the user's decision, including previews targeting those numbers.
- Preview versions use `x.y.z-beta.N`; increment N within the planned version.
  Stable promotion uses `x.y.z`, not a second patch increment. Publish previews
  as GitHub prereleases and npm `--tag preview`; stable npm uses `latest`.
- Stable clients follow `latest.yml`; preview clients follow `beta.yml` and may
  also move to a newer stable release. Returning to Stable changes future
  updates; it does not downgrade an installed preview. Wait for an equal-target
  stable release or a newer version.

## What ships where

| Artifact | Destination | Consumers |
| --- | --- | --- |
| `tnega` npm package (`dist/`) | npm registry | `npm install -g tnega` |
| `Tnega-Setup-<v>.exe` + `.blockmap` | GitHub release `v<v>` on `whale4rain/tnega` | new installs |
| `latest.yml` | same GitHub release | installed clients: `electron-updater` reads it to find, download and verify the new installer |
| `beta.yml` | GitHub prerelease `v<x.y.z-beta.N>` | clients that selected Preview (pre) |

The update feed is configured once in `apps/desktop/electron-builder.yml`
(`publish: github whale4rain/tnega`). electron-builder bakes `app-update.yml`
into the installed app; the app checks the latest release on start and every
four hours, downloads in the background, and shows **Update** in the sidebar
footer when it is ready. Clicking it shuts the runtime down, runs the installer
silently and relaunches; quitting with an update downloaded installs it without
relaunching. Settings shows the version and a **Check for updates** button.

A client only sees a release that is **published** (not draft) and contains
its channel's feed. Stable requires `latest.yml` on a non-prerelease;
Preview uses `beta.yml` on beta prereleases and can move to a newer stable
release. The version it compares is `apps/desktop/package.json`.
Settings → Update channel persists Stable / Preview per desktop installation.

## Prerequisites

- On `main`, up to date with `origin/main`, clean working tree.
- `GH_TOKEN`: a GitHub token with `contents: write` on `whale4rain/tnega`
  (fine-grained) or `repo` scope (classic). Ask the user for it in their own
  shell; never write it into a file or a command shown in chat.
- npm: the user is logged in (`npm whoami`) and has the OTP ready if 2FA is on.
- Network: electron-builder downloads Electron and NSIS from GitHub. The release
  script defaults to the npmmirror mirrors (see `apps/desktop/AGENTS.md`).

## Steps

1. **Decide the version.** Apply the policy above: patch batches are autonomous,
   major/minor require the user's decision. Check the last
   tag: `git tag --sort=-v:refname` (the first entry is the newest version).

2. **Bump and write notes.**

   ```bash
   pnpm release version 0.4.7
   # For a preview of the next patch:
   # pnpm release version 0.4.7-beta.1
   ```

   This sets `package.json` and `apps/desktop/package.json` to the same version
   and creates `docs/releases/v0.4.7.md` from the template. Fill in the notes in
   the style of earlier files: user-visible changes first, one line each, then
   the Install section. Summarize from `git log v<previous>..HEAD --oneline`.
   Update the root `CHANGELOG.md`: move shipped entries out of Unreleased into
   the new version, with its date and release link. `pnpm release check` rejects
   a version without its own changelog section. For previews, retain the batch
   history so the final stable section covers all intervening previews.

3. **Verify.** Resolve failures introduced by the release. Record any remaining
   pre-existing failures explicitly before deciding whether to publish:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm exec vitest run apps/desktop/test
   ```

4. **Commit, tag, push.**

   ```bash
   git add package.json apps/desktop/package.json CHANGELOG.md docs/releases/v0.4.7.md
   git commit -m "chore(release): bump version to 0.4.7"
   git tag v0.4.7
   git push origin main v0.4.7
   ```

   `pnpm release check` must now print `v0.4.7 is ready to publish`.

5. **Publish the npm package.** `prepublishOnly` builds and runs
   `test/publish.test.ts`.

   ```bash
   npm publish --tag latest
   # Preview version only: npm publish --tag preview
   ```

6. **Publish the desktop client and update feed.**

   ```bash
   pnpm release desktop
   ```

   This re-runs the readiness check, builds the runtime, web and desktop
   bundles, and has electron-builder upload `Tnega-Setup-0.4.7.exe`, its
   blockmap and `latest.yml` to the `v0.4.7` release, with the notes file as the
   release body. If packaging fails midway, delete
   `apps/desktop/release/win-unpacked.tmp` and run it again.

   For `x.y.z-beta.N`, the same command uses GitHub `releaseType=prerelease`
   and uploads `beta.yml`. Stable uses `releaseType=release` and `latest.yml`.
   A preview must never replace npm `latest` or the stable update feed.

7. **Confirm the release.** `pnpm release desktop` ends with this check; run
   it again any time:

   ```bash
   pnpm release verify
   ```

   It selects `latest.yml` / `beta.yml` from the version and checks the feed,
   installer size and download, and GitHub's draft/prerelease metadata.

   The release must be published (not draft) and list the `.exe`, the
   `.exe.blockmap` and `latest.yml`. An installed older client should show
   **Update** within a few minutes of **Check for updates** in Settings.
   For a beta release, verify with a client on Preview (pre); the prerelease
   must contain `beta.yml` and must not appear to Stable clients.

## When something goes wrong

- **Never upload an installer by hand.** electron-builder writes `latest.yml`
  only while publishing, so a `pnpm package:desktop` build uploaded through the
  GitHub page gives a release that clients see but cannot install ("Cannot find
  latest.yml in the latest release artifacts"). If it already happened, write
  the feed for that exact installer and upload it beside it, then verify:

  ```bash
  pnpm release feed
  gh release upload v<v> apps/desktop/release/latest.yml apps/desktop/release/Tnega-Setup-<v>.exe.blockmap -R whale4rain/tnega --clobber
  pnpm release verify
  ```

  For beta versions, use `beta.yml` in the upload command instead of
  `latest.yml`; `pnpm release feed` writes the appropriate file automatically.

- **Draft release:** electron-builder found an existing draft. Publish it with
  `gh release edit v<v> --draft=false`.
- **Clients see nothing:** the selected channel's feed is missing, the release
  is a draft, its stable/prerelease metadata is wrong, the user chose Stable
  for a preview release, or the desktop version was not bumped.
- **Bad release:** do not delete the tag clients already downloaded. Fix
  forward with a new patch version; the updater only moves forward.
- **Code signing:** builds are unsigned, so Windows SmartScreen warns on a
  fresh install. Updates still apply because `electron-updater` only verifies
  signatures when `publisherName` is set.
