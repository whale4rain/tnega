# Local Project chat E2E

Run from the repository root:

```sh
pnpm --filter @tnega/web test:e2e
```

This optional implementation check starts Vite on a free local port and uses the installed Chrome or Edge through the existing `playwright-core` dependency. It requires no backend, model key, browser download, or new dependency, and is not included in CI. To select another installed Chromium browser, set `TNEGA_E2E_BROWSER` to its executable path.

`project-chat.mjs` loads the real App with `#p/project` and explicitly intercepts the backend endpoints in `fixtures.mjs`. Unknown API requests and unhandled browser errors fail the run. External reference navigation uses a local fixture; no external service is contacted.

The connected flow checks short independent bubbles, computed text sizes, grouped Agent receipts, conversation pair isolation, late SSE arrival and duplicate suppression, reconnect cursor, durable exchange history after reload and reopening, routed Thread restoration, participant navigation, close chat, workspace file links, external web links, local preview navigation into Browser, and narrow layouts in both themes. Document tabs follow the existing Workbench rule and are reopened after reload. Screenshots are saved under `.artifacts/` for visual review and ignored by Git.

These fixtures verify UI behavior and the incremental wire flow, not real provider communication, server persistence, desktop native Browser rendering, or screenshot pixel similarity. Add corresponding backend or desktop checks when those boundaries change.

The same run opens an ordinary General Session in each theme, checks body/user/Agent typography and plain message backgrounds, and opens both user and Agent file/web references. Long exchange fixtures verify scrolling to the first message, centered participants, ordinary mouse-wheel access to crowded tabs, and the Project composer's single Stop/Send action. It saves Session and tab-scroll screenshots alongside the Project captures. The full run has 16 checks.

`pnpm --filter @tnega/web test:e2e:models` runs the incremental model picker flow independently. Its six checks cover provider / third-party groups, saved connection discovery without reading a key, searching and duplicate prevention, model addition and automatic Session selection with the draft preserved, empty catalogs, unsigned ChatGPT and manual fallback, manual API connections without ChatGPT auth, and adding a model directly from Project role settings. Both themes are checked; fixtures never contact a model provider. This series stays outside CI.

`pnpm --filter @tnega/web test:e2e:artifacts` runs the artifact dialog, Library and memory checks across palettes and text sizes.

## Release readiness

`pnpm --filter @tnega/web test:e2e:release` walks the flows a person goes through after installing a stable version, in both themes, and saves screenshots under `.artifacts/release/`. Run it, together with the three suites above, before a stable release:

- First run: the welcome screen asks for a folder; adding one opens a new session that greets in the display serif.
- A session with a live run: the run stream is held open from the page, so the checks see each step. A long shell command stays inside its row with an ellipsis, shows in full on hover, and wraps when expanded; the finished run folds into one "Used N tools" line and survives a reload.
- The Workbench: Files opens a file, Changes and Browser switch, and dragging the left edge resizes it. The resize line is a `--border-strong` hairline, never the accent, and it clears on release.
- Settings: every palette can be chosen and shows as selected with a quiet border, the default model route is marked the same way, and the sidebar's theme buttons switch light, dark and system.
- Projects: the Board greets and lists what needs you; an opened thread's card is marked without an accent ring; Back returns to the Board; replying targets the thread; an artifact dialog renders last in `<body>` and its close button closes it.
- Desktop title bar, emulated through the `tnegaDesktop` bridge the Electron preload exposes: the header actions sit beside the window controls with nothing underneath them, dialogs start below the controls and are not drag areas, and the controls dim with the scrim and recover after it closes.
- A phone-width window fits sessions and projects without horizontal scrolling.

Set `TNEGA_E2E_GLASS=full` to walk the same flows with Settings → Appearance → Glass set to everywhere; screenshots then go to `.artifacts/release-glass-full/`, so the two runs can be compared side by side.

Like the other suites it needs no backend or model key and fails on any unhandled API route or browser error. It cannot drive the real Electron window: native drag regions, the native controls and installers still need a manual check on each platform.
