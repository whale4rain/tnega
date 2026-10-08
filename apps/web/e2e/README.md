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

`pnpm --filter @tnega/web test:e2e:models` runs the incremental model picker flow independently. Its six checks cover provider / third-party groups, saved connection discovery without reading a key, searching and duplicate prevention, model addition and automatic Session selection with the draft preserved, empty catalogs, unsigned ChatGPT and manual fallback, and adding a model directly from Project role settings. Both themes are checked; fixtures never contact a model provider. This series stays outside CI.
