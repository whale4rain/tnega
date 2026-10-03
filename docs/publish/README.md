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

## What ships where

| Artifact | Destination | Consumers |
| --- | --- | --- |
| `tnega` npm package (`dist/`) | npm registry | `npm install -g tnega` |
| `Tnega-Setup-<v>.exe` + `.blockmap` | GitHub release `v<v>` on `whale4rain/tnega` | new installs |
| `latest.yml` | same GitHub release | installed clients: `electron-updater` reads it to find, download and verify the new installer |

The update feed is configured once in `apps/desktop/electron-builder.yml`
(`publish: github whale4rain/tnega`). electron-builder bakes `app-update.yml`
into the installed app; the app checks the latest release on start and every
four hours, downloads in the background, and shows **Update** in the sidebar
footer when it is ready. Clicking it shuts the runtime down, runs the installer
silently and relaunches; quitting with an update downloaded installs it without
relaunching. Settings shows the version and a **Check for updates** button.

A client only sees a release that is **published** (not draft) and contains
`latest.yml`. The version it compares is `apps/desktop/package.json`.

## Prerequisites

- On `main`, up to date with `origin/main`, clean working tree.
- `GH_TOKEN`: a GitHub token with `contents: write` on `whale4rain/tnega`
  (fine-grained) or `repo` scope (classic). Ask the user for it in their own
  shell; never write it into a file or a command shown in chat.
- npm: the user is logged in (`npm whoami`) and has the OTP ready if 2FA is on.
- Network: electron-builder downloads Electron and NSIS from GitHub. The release
  script defaults to the npmmirror mirrors (see `apps/desktop/AGENTS.md`).

## Steps

1. **Decide the version.** Patch for fixes, minor for features. Check the last
   tag: `git tag --sort=-v:refname` (the first entry is the newest version).

2. **Bump and write notes.**

   ```bash
   pnpm release version 0.4.6
   ```

   This sets `package.json` and `apps/desktop/package.json` to the same version
   and creates `docs/releases/v0.4.6.md` from the template. Fill in the notes in
   the style of earlier files: user-visible changes first, one line each, then
   the Install section. Summarize from `git log v<previous>..HEAD --oneline`.
   Update the root `CHANGELOG.md`: move shipped entries out of Unreleased into
   the new version, with its date and release link.

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
   git commit -am "chore(release): bump version to 0.4.6"
   git tag v0.4.6
   git push origin main v0.4.6
   ```

   `pnpm release check` must now print `v0.4.6 is ready to publish`.

5. **Publish the npm package.** `prepublishOnly` builds and runs
   `test/publish.test.ts`.

   ```bash
   npm publish
   ```

6. **Publish the desktop client and update feed.**

   ```bash
   pnpm release desktop
   ```

   This re-runs the readiness check, builds the runtime, web and desktop
   bundles, and has electron-builder upload `Tnega-Setup-0.4.6.exe`, its
   blockmap and `latest.yml` to the `v0.4.6` release, with the notes file as the
   release body. If packaging fails midway, delete
   `apps/desktop/release/win-unpacked.tmp` and run it again.

7. **Confirm the release.** `pnpm release desktop` ends with this check; run
   it again any time:

   ```bash
   pnpm release verify
   ```

   It fails unless `latest.yml` is on the release, describes this version and
   points at an installer of the declared size that downloads.

   The release must be published (not draft) and list the `.exe`, the
   `.exe.blockmap` and `latest.yml`. An installed older client should show
   **Update** within a few minutes of **Check for updates** in Settings.

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

- **Draft release:** electron-builder found an existing draft. Publish it with
  `gh release edit v<v> --draft=false`.
- **Clients see nothing:** `latest.yml` is missing, the release is a draft or a
  prerelease, or the desktop version was not bumped.
- **Bad release:** do not delete the tag clients already downloaded. Fix
  forward with a new patch version; the updater only moves forward.
- **Code signing:** builds are unsigned, so Windows SmartScreen warns on a
  fresh install. Updates still apply because `electron-updater` only verifies
  signatures when `publisherName` is set.
