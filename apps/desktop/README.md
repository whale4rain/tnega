# Tnega desktop

The desktop client is an Electron host for the local Tnega console. It uses the
same React UI, Session data, Workspace history, and System Config as `tnega web`.

## Development

```bash
pnpm --filter @tnega/desktop dev
```

The command first builds the CLI runtime and Web UI, then launches Electron.

After building, verify the sandboxed preload, window button clearance and drag
region with a hidden window and isolated fixture data:

```bash
pnpm --filter @tnega/desktop exec electron scripts/verify-chrome.cjs
```

The main process is bundled as ESM; the sandboxed preload is bundled as CommonJS
without the main process's `node:module` compatibility banner.

Verify that Browser attachment, new tabs and reconnection preserve system,
light and dark themes with an isolated hidden Electron host:

```bash
pnpm --filter @tnega/desktop exec electron scripts/verify-browser-theme.cjs
```

Window controls share the existing header; its empty space can drag the window,
while buttons remain clickable. Minimizing keeps the window in the taskbar;
maximizing toggles between maximized and restored sizes. Closing hides the window
from the taskbar while the local runtime continues running in the notification
area. Click the tray icon or choose **Show Tnega** to restore it. Choose
**Exit Tnega** from the tray menu to shut down the local runtime.

Session completion plays a soft two-note chime from the app itself (not the
system "ding"). When the window is not focused, Windows shows a small weather
badge on the taskbar icon: rain drops for a ready reply, lightning for a failed
run and a snowflake when a question waits. The button does not flash. Focusing
the window clears the badge. Cancelled runs and intermediate Goal rounds do not
notify. The chime follows the system volume. Rebuild the small overlays with
`node apps/desktop/scripts/render-completion-icons.mjs`.

## Packaging

For a public release, follow [docs/publish](../../docs/publish/README.md) and push
the prepared version tag. GitHub Actions builds and publishes the installer with
its matching stable/preview update feed; `pnpm release desktop` is a manual fallback.
Packaged clients from 0.4.6 onward check at startup and every four hours, download
updates in the background and offer Update / Restart to update in the UI.
Settings also provides Check for updates. Development builds do not self-update.
Settings → Update channel selects Stable (default) or Preview (pre), persisted
in `update-preferences.json` under Electron userData. Preview follows beta
releases and newer stable releases. Switching back does not downgrade; it also
invalidates any previously downloaded update. Switching is disabled during
checks/downloads.

```bash
pnpm --filter @tnega/desktop package
```

`electron-builder` is configured for Windows NSIS, macOS DMG, and Linux AppImage.
The desktop build ships the Windows ACL runner beside `out/main.js`, with
`koffi` retained as a native runtime dependency. The sandbox launches the runner
using Electron's Node mode without changing the application's environment.
For a quick Windows artifact validation without an installer, run:

```bash
pnpm --filter @tnega/desktop exec electron-builder --dir
```

## Security boundary

Electron runs the Web UI with context isolation, sandboxing, and Node integration
disabled. The preload bridge only provides native folder selection, revealing a
Workspace, and the app version. The Agent Runtime stays behind the existing
loopback HTTP/SSE API. It continues to enforce Workspace path boundaries and
requires users to choose network and Shell Tool Permissions for every Agent Run.
