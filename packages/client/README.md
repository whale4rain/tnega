# @tnega/client

The tnega server's client side, shared by every front end: the web app
(`apps/web`) and the terminal UI (`packages/tui`).

- `api.ts`: `createClient({ baseUrl })` returns the HTTP API, `streamRun` (the
  `POST /runs` SSE stream) and file downloads. The web app uses an empty base
  URL (same origin); the TUI points it at its in-process server.
- `types.ts`: the wire contract with `packages/cli/src/server.ts`.
- `timeline.ts`: the Timeline view model, rebuilt from durable Session events
  (`fromEvents`) and advanced by live Stream Events (`applyStream`).
- `tools.ts`, `weather.ts`, `completion.ts`, `usage.ts`: presentation rules
  that do not depend on a renderer (tool verbs, the weather state language,
  slash-command parsing and ranking, cost formatting).

Nothing here may import React, the DOM or Node-only modules: both the browser
and Node load it.
