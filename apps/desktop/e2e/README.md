# Windows process integration

Run from the repository root, with its Node.js 22+ dependencies installed:

```sh
pnpm --filter @tnega/desktop exec electron e2e/verify-process-launcher.mjs
```

The script starts a hidden Electron host and tests the native utility launcher,
unchanged argv and child-only environment, 256 KB on each output stream with
same-tick exit and complete tails, a real read-only ACL runner, stdin EOF,
background process IDs, complete descendant termination and cancellation
before the utility PID exists. It is deliberately outside the test/CI scripts.

Electron 44.4.3 removes listeners from its output PassThroughs at exit. The
adapter connects the native Socket upstream to owned capture streams; the
large-output and final-tail checks guard this behavior during Electron upgrades.
No timing delay determines output completeness: completion waits for the
actual native pipe EOF/close.

Temporary worker files are kept under ignored `.artifacts/` and removed after
the checks. The script does not open a window or modify a user's Workspace.
