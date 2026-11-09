# Try the v2 pieces together, for real

> Status: a hand test for the v2 daemon (M1) and state layer (P3) together.
> Box parts (E2B) are in [try-boxes.md](try-boxes.md).

`pnpm try:v2` (`scripts/try-v2.ts`) runs, on one machine:

- a runtime that accepts daemons over WebSocket (a minimal server in the script, standing in for the M3 server);
- a real `tnega daemon` child process dialling it, with `--browser`;
- an agent on DeepSeek whose files, commands and browser are on that daemon;
- the Session kept by the JSONL store, its images in the blob store.

Each check prints `ok`, `FAIL` or `skip` (with the reason). The script exits 1 when any check failed.

```sh
pnpm try:v2                        # all of it
pnpm try:v2 --no-browser           # no browser on the daemon
pnpm try:v2 --sandbox read-only    # the agent's command sandbox (default workspace-write)
```

It needs `DEEPSEEK_API_KEY`, or a proxy that adds the key. Node's `fetch`
ignores `HTTPS_PROXY` unless you start it with `NODE_USE_ENV_PROXY=1`, so
behind a proxy run `NODE_USE_ENV_PROXY=1 pnpm try:v2`. Otherwise the model
call hangs. It writes only to temporary folders, its own `TNEGA_HOME`
included, and removes them at the end.

## What it checks

| Check | Covers |
|---|---|
| handshake | `tnega daemon`, `connectWebSocket`, `acceptDaemon`, protocol version, services announced |
| agent on DeepSeek | `createAgentRuntime` with `machine.link`: `write_file` / `list_dir` through `fs-remote`, `shell` through `process-remote`, `browser_*` through `browser-remote` |
| shell under the sandbox | the daemon runs the command in the sandbox; on a host with no sandbox mechanism it must refuse (`skip`, fails closed) |
| Session format 11 | `BlobImagesBackend`: image bytes in `ctx.blobs`, only the hash in the log |
| replay | a new `SessionLog` on the store's backend derives the same model messages, images included |
| snapshot, summary, search | `ctx.sessionStore` reads that clients and the sidebar use |
| terminal | `terminal-remote`: a PTY on the daemon runs a command |
| reconnect | a dropped socket: the daemon dials again and answers calls |

## Result, 2026-11-09 (Linux cloud container, Node 22, DeepSeek)

Every check passed, except the shell check, which was skipped. The container
has no working bubblewrap, so the daemon refused the command (fails closed,
as it must). The agent wrote the file, listed the folder and read the heading
from the daemon's browser. The log held only the image hash, and the replay
matched the live run.

Two bugs were found and fixed with this run:

- A terminal opened in a folder that does not exist spawned a shell that died
  with `chdir(2) failed`. The daemon now refuses it as invalid params.
- Views of a long Session read every screenshot blob again. The store now
  shares a byte-bounded cache of restored images.

The egress proxy and the environment setup ran on the same machine with
`pnpm try:boxes proxy` and `pnpm try:boxes setup`:

- example.com was allowed;
- github.com was blocked;
- a wrong box token was refused;
- the key header was added for httpbin.org;
- the setup secret printed as `[secret]`.

Not run here: a real E2B box (`pnpm try:boxes template|box`). It needs an
E2B API key, and self-hosting needs KVM, which cloud containers lack.
