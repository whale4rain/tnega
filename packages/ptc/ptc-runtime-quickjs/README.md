# @tnega/ptc-runtime-quickjs

QuickJS Provider using the standalone MIT-licensed
`@earendil-works/pi-codemode@0.99.1` library. No Pi agent runtime is required.

`ptcRuntimeQuickjs` defaults: 300 seconds per script (including approval and user
question waits), 64 MiB VM memory, 100 host calls, 64,000 output characters.
The worker also enforces hard ceilings of 64,000 output characters / 1,024 items,
100 calls and 64,000 characters per serialized call input before crossing into
the host. `maxOutputChars` and `maxCalls` can tighten these ceilings.

Scripts have no filesystem, network, subprocess, imports or timers. They receive
`tools`, `ALL_TOOLS`, `text`, `console`, `exit`, and ephemeral `store` / `load`.
Only registered bindings can cross the execution boundary. Each call starts a
fresh worker and VM. Cancellation and deadlines terminate the worker and cancel
its outstanding host calls. Images are not rendered by this text-only Provider.

For a bundled deployment, build `src/worker.mjs` as adjacent `ptc-worker.js` and
copy `quickjs-wasi/quickjs.wasm` as adjacent `quickjs.wasm`. The Provider detects
these assets; when running source it uses its own worker and Pi's installed WASM.
`workerUrl` and `wasmPath` allow explicit deployment overrides.

Tests execute the actual QuickJS VM, including capability isolation, cancellation,
deadlines, output ceilings and repeated-call limits.
