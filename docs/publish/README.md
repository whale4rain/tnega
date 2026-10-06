# Publishing a release

The default release path is GitHub Actions: push a new version tag to publish
the npm package (`tnega` CLI) and the Windows desktop installer/update feed.
Prepare the version and notes first; no local packaging or OTP is needed after
the one-time npm Trusted Publisher configuration below.

Desktop 0.4.6 and later already support in-app updates. Users install an
update-capable client once; later upgrades happen through Settings → Check for
updates or the sidebar's Update action. Maintainers still build and publish
each new version with its update feed. Routine documentation and development
changes do not require packaging a new installer. CLI installations update
through npm.

## Version and changelog policy

When shipping the home-storage change, include its migration note: close older
desktop/CLI processes before first use. Workspace logs are imported into
`~/.tnega` (or `TNEGA_HOME`), with legacy backups retained and conflicts reported.
Location migration does not convert unsupported Session formats. Keep project
configuration, custom Workspace skills, memory and artifacts in the Workspace.
Bundled skills install offline into `~/.tnega/skills` on startup; existing user
files are preserved, so upgrades only add missing instructions.

- Update root `CHANGELOG.md` / Unreleased with each user-visible feature, fix or
  compatibility change, in the same commit. Describe behavior and migration,
  not internal refactors with no user effect.
- Group Unreleased and version sections consistently under **Features**, **Fixes**,
  and **Other**, omitting empty groups. Features introduce user capabilities or
  deliberate behavior changes; Fixes correct failures or regressions; Other covers
  performance, compatibility/migration, publishing and internal/documentation work.
  For mixed entries choose the primary user effect. Preserve historical wording
  when grouping, and do not rewrite historical entries merely to change style.
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

## Automatic tag releases

The workflow is [release.yml](../../.github/workflows/release.yml). It runs when
a `v[0-9]*` tag is pushed, then rejects any tag other than `vx.y.z` or
`vx.y.z-beta.N`. The tag must match both package versions, have release notes
and a released changelog section, and point at a commit reachable from
`origin/main`. Ordinary pushes and documentation changes do not publish.

### One-time npm configuration

In [tnega's npm settings](https://www.npmjs.com/package/tnega/access), add a
**GitHub Actions Trusted Publisher** using:

| Field | Value |
| --- | --- |
| Organization or user | `whale4rain` |
| Repository | `tnega` |
| Workflow filename | `release.yml` |
| Environment | leave empty |
| Allowed actions | explicitly enable **npm publish** |

The Ubuntu publisher job uses `id-token: write` and npm 11.21.0 to obtain a
short-lived OIDC identity, with provenance enabled. Do not add `NPM_TOKEN`, an
OTP, or a token-based `.npmrc`. GitHub release uploads use the job's
`GITHUB_TOKEN` with `contents: write`; no personal token is needed. This works
on GitHub-hosted runners. See [npm's Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/).

### Cut a release

1. Apply the version policy above and audit the complete previous-tag range.
   Run `pnpm release version <version>`, finish `docs/releases/v<version>.md`,
   and move the shipped changes from Unreleased into `CHANGELOG.md`.
2. Commit the version and notes on main, then push main and the tag:

   ```bash
   git tag v0.4.13
   git push origin main
   git push origin v0.4.13
   ```

   This example is a future release; use the version actually prepared. To
   exercise the new workflow on `v0.4.12`, move that unpublished tag to the
   fully validated commit containing the workflow and push the updated tag.
3. Follow the **Release** run in GitHub Actions. Windows checks versions,
   typechecks, lints and runs the full suite. It explicitly downloads the
   Electron test runtime (its postinstall is not globally allowed by pnpm).
   `test/publish.test.ts` builds the
   root runtime/Web/declarations and checks all 12 npm artifact tests; a missing
   or failed package check blocks packaging. The desktop is built separately
   and packaged with `--publish never`; its feed is generated from the exact
   installer, and npm is packed with `--ignore-scripts` from the checked build.
4. The job retains fixed tarball/installer/blockmap/feed bytes with a manifest
   containing the tag commit, sizes, SHA256 and npm SHA512 integrity. The
   isolated Ubuntu job verifies them, creates/reuses one GitHub **draft**, and
   verifies every uploaded desktop asset's size and SHA256 digest. It then
   publishes the verified desktop draft independently, then publishes npm
   (`latest` stable, `preview` beta) and waits for registry visibility.
   A final check verifies the public update
   source. Beta releases contain `beta.yml` and never become GitHub latest.

Releases are serialized across tags using a GitHub concurrency queue (up to
100 queued runs), so publisher requests cannot race. Attempts to downgrade an
npm channel or a newer stable desktop release fail before the corresponding
channel publication.

### Validation baseline and retries

The 19 historical test failures audited at 0.4.11 have been resolved. The
release gate now requires a fully passing suite; any failed test, hook/collection
error, unhandled runtime error, interrupted run or incomplete package report
blocks publication. No step uses `continue-on-error`. JSON validation reports
are retained even on failure.

GitHub's Windows service runner cannot initialize workspace-write restricted
children without an interactive console (`STATUS_DLL_INIT_FAILED`). The 13
live Windows ACL tests therefore run on an interactive Windows host and skip
on GitHub Actions; their unit/failure-path tests still run in CI. Verify the
live suite locally before cutting a release. Shell permission and spill tests
use explicit bypass because their assertions concern composition, not ACLs.
The workflow installs ripgrep for the search integration tests.

After `npm publish` accepts the verified tarball, the publisher remains running
while npm makes the version and its channel visible in the public registry. It
checks at 5, 10, 20 and 40 seconds, then every 30 seconds for about 34 minutes;
the publisher job has a 45-minute ceiling. The verified desktop release and
update feed are already public during this wait. If that upper bound expires,
choose **Re-run failed jobs**, which
reuses the original build artifact for 14 days. Do not choose **Re-run all jobs**
after any external publication: installers can change bytes between builds.
An already published npm version is skipped only when its integrity matches;
published GitHub assets must match and are never overwritten. Draft assets may
be repaired. A delayed registry channel does not hide the desktop release; after
the wait ceiling, wait for the registry and rerun only the failed job. An npm authentication failure
requires correcting the Trusted Publisher fields/allowed action, then the same
retry. There is no automatic deletion of published versions or tags.

If the original build artifact has expired, preserve/download the original
assets and tarball and verify their hashes, or fix forward with a new version.
Do not rebuild and silently replace published bytes. After a failed final
public verification, inspect the existing release and retry; do not create a
second release. Older tags whose commits predate this workflow do not acquire
it retroactively.

## Manual fallback prerequisites

- On `main`, up to date with `origin/main`, clean working tree.
- `GH_TOKEN`: a GitHub token with `contents: write` on `whale4rain/tnega`
  (fine-grained) or `repo` scope (classic). Ask the user for it in their own
  shell; never write it into a file or a command shown in chat.
- npm: the user is logged in (`npm whoami`) and has the OTP ready if 2FA is on.
- Network: electron-builder downloads Electron and NSIS from GitHub. The release
  script defaults to the npmmirror mirrors (see `apps/desktop/AGENTS.md`).

## Manual fallback steps

Use these only when the automatic workflow cannot be used. Do not run a local
publisher concurrently with a tag-triggered workflow. In this fallback the user
still enters `npm publish` in their own terminal; the OIDC workflow above is the
authorized automatic path.

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

5. **Prepare the npm package; the user publishes it.** The agent runs the
   package checks and prepares the exact tarball, then gives the user its
   absolute path and the appropriate tag. The user enters `npm publish` in
   their own terminal, including an OTP there if npm requires it. Never ask
   them to send an OTP or token in chat, and do not run npm publishing on
   their behalf.

   ```bash
   pnpm test:package
   npm pack --ignore-scripts --pack-destination .tnega
   # User runs this with the prepared tarball's absolute path:
   npm publish /absolute/path/tnega-0.4.7.tgz --tag latest
   # Add --otp=<code> locally if required. For previews use --tag preview.
   ```

   `pnpm test:package` builds and runs `test/publish.test.ts`. Publishing an
   already checked tarball keeps the prepared bytes fixed. After the user
   reports success, check the official registry; visibility can take several
   minutes. Wait and query again before treating an initial 404 or old tag as
   failure. Do not blindly publish the same version again.

   ```bash
   npm view tnega@0.4.7 version --registry=https://registry.npmjs.org
   npm view tnega dist-tags --json --registry=https://registry.npmjs.org
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

- **Workflow validator version lag:** actionlint 1.7.12 does not recognize
  `concurrency.queue`, although GitHub supports `queue: max` with
  `cancel-in-progress: false`. When checking locally, ignore only that exact
  unknown-key diagnostic; keep every other check enabled. The workflow uses
  [GitHub's documented concurrency syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).
- **Record blockers:** when a release encounters a reproducible failure or
  needs a recovery step, add its symptom, cause when known, recovery and
  verification here. Do not record credentials. Documentation-only runbook
  changes do not require a version bump or a new release.
- **Concurrent validation contention (0.4.9):** running the full suite, separate
  desktop tests and package builds concurrently caused package-build timeouts,
  browser/Electron frame timeouts and a temporary-directory cleanup error.
  Wait for builds to finish, then rerun affected tests serially. The standalone
  package check, Agent retry and all 33 desktop / 6 browser tests passed after
  isolation. Compare failure names against the prior release baseline; record
  the original full-suite result rather than calling the full suite green.
- **npm EOTP / delayed visibility (0.4.7):** npm required the user's dynamic
  code. The user published the checked tarball locally; the official registry
  initially returned 404 and `latest=0.4.6`, then exposed `0.4.7` after several
  minutes. Keep authentication in the user's terminal and verify both the
  version and channel tag after propagation.
- **Interrupted desktop upload (0.4.7):** the release contained `latest.yml`
  and the blockmap but lacked the installer after the publishing run. Inspect
  all release assets even if the builder logs say "published". If the generated
  feed and blockmap are already uploaded, verify the original local installer's
  name, size and SHA512 against that feed, then upload that exact installer
  with `gh release upload`. Do not rebuild or substitute different bytes under
  the existing feed. Verify all three assets and compare the uploaded asset's
  SHA256 digest with the local file.
- **Only an orphan blockmap (0.4.11):** the published release had no installer
  or update feed, and this checkout did not have the original installer. Reuse
  the existing release record and exact Git tag. Build locally with publishing
  disabled, generate `latest.yml` with `pnpm release feed`, and verify the
  packaged version and local installer/feed hashes. Upload the installer first,
  replace the orphan blockmap with the rebuilt installer's matching blockmap,
  and upload the feed last. Compare all remote asset sizes and SHA256 digests
  to local files and run `pnpm release verify`. This recovery applies only when
  no published installer/feed needs preserving; otherwise follow the exact-byte
  recovery above or fix forward. npm already had 0.4.11 and was not republished.
- **Duplicate GitHub releases (0.4.7):** concurrent publisher requests created
  two release records for the same tag; one contained only the installer.
  List all releases rather than relying only on the tag endpoint. Compare
  asset digests, retain the complete release, and delete only the redundant
  record by its release ID through the API, preserving the Git tag. Confirm
  exactly one release remains and the latest stable release has all assets.
  For subsequent releases, create a single draft before starting the parallel
  publisher (`gh release create v<v> --draft --verify-tag --notes-file
  docs/releases/v<v>.md`), or reuse the existing draft. Keep it a draft until
  all three generated assets are uploaded and verified, then publish with
  `gh release edit v<v> --draft=false` and re-run release verification. The
  automatic verification at the end of `pnpm release desktop` can report a
  draft during this staged workflow; do not publish until asset checks pass.
- **Node fetch network failure (0.4.7):** `pnpm release verify` encountered
  `ECONNRESET` and `UND_ERR_CONNECT_TIMEOUT` accessing GitHub. This alone does
  not establish a bad release. If a retry still fails, use `curl --fail
  --location` to download the public feed and `curl --fail --head --location`
  for the installer; check its HTTP status and content length. Match the
  downloaded feed's version, path, size and SHA512 to the installer, and use
  `gh api` to confirm published draft/prerelease metadata and the latest stable
  release. Record the alternate verification instead of claiming the original
  command passed.
- **Do not publish an installer without its matching feed.** Recovery of an
  interrupted upload above must preserve the exact generated bytes.
  electron-builder writes `latest.yml`
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
- **Temporary broken-shortcut prompt during an update (0.4.7):** clicking a
  desktop/taskbar shortcut while the installer replaces the application can
  make Windows report that `Tnega.exe` was moved or changed. Choose **No** to
  keep the shortcut and wait for installation and automatic restart to finish.
  The reported shortcut worked again after the update. If it still fails after
  installation, inspect its target and the installed executable before treating
  it as this temporary condition; do not delete a working shortcut or change
  installer settings based only on the transient prompt.
- **Windows ACL runner missing (0.4.7):** bundling the desktop main process
  moved the mechanism's module-relative lookup into `app.asar/out`, while the
  runner existed only in the separate runtime `dist`. The desktop build must
  ship `sandbox-windows-acl-runner.js` beside the main bundle and retain koffi
  as an external native dependency. Electron must start this runner in Node
  mode for both capability probes and execution, with that mode removed from
  the restricted target's environment. Verify the actual packaged executable:
  runner discovery, a successful read-only command, a rejected write, and
  unchanged host environment. Source-checkout tests alone do not cover this.
  Ship the correction in a new patch; do not replace published 0.4.7 assets.
- **Bad release:** do not delete the tag clients already downloaded. Fix
  forward with a new patch version; the updater only moves forward.
- **Code signing:** builds are unsigned, so Windows SmartScreen warns on a
  fresh install. Updates still apply because `electron-updater` only verifies
  signatures when `publisherName` is set.
