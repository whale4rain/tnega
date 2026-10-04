# Windows sandbox: why child-process pipes fail, and how to fix it

Date: 2026-10-04. Status: research and recommendation. Related code:
`packages/sandbox/sandbox-windows-acl`, `packages/sandbox/execution-sandbox`,
`packages/tools/src/escalation.ts`.

## 1. The finding

> On Windows, npm / Node uses libuv to create or access named pipes for
> child-process stdio. The ACL on these pipes does not include the sandbox's
> restricted SID, so the restricted token fails the access check when trying
> to use the pipe. Windows then denies the operation, which surfaces in Node
> as `spawn EPERM`.
> — owner's diagnosis, 2026-10-04

Sources:

- openai/codex [#47868](https://github.com/openai/codex/issues/47868),
  *Windows: Node.js spawn fails with EPERM when using stdio pipes inside
  Codex*. `spawnSync(process.execPath, ['--version'], { encoding: 'utf8' })`
  fails inside the Codex Windows sandbox and succeeds outside it;
  `stdio: 'inherit'` / `'ignore'` work. It blocks dev servers. Open, no fix.
- DeepSeek Harness, `packages/sandbox/sandbox-windows-acl/README.md`,
  [*Piped stdio capture is impossible for confined grandchildren*](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md#:~:text=Piped%20stdio%20capture%20is%20impossible%20for%20confined%20grandchildren):
  libuv's pipe stdio uses named pipes whose client-end open asks for write
  access that no restricting SID is granted — the Win32 default security
  descriptor template applies, not the token's default DACL. Inherited and
  ignored stdio work; PowerShell pipelines (anonymous pipes) work because the
  token's default DACL carries a restricting-SID ACE.

## 2. Mechanism

1. Our runner starts the command with a `WRITE_RESTRICTED` restricted token.
   Every *write-type* access is checked twice: once against the token's
   normal groups, once against its restricting SIDs (logon SID, Everyone,
   the workspace and temp capability SIDs). Both must pass.
2. `child_process.spawn` with `stdio: 'pipe'` (the default for `exec`,
   `execSync`, `spawnSync` with `encoding`, and therefore npm scripts that
   start vite, esbuild, tsx, most test runners) makes libuv create a named
   pipe with `CreateNamedPipeW(..., NULL security)` and open it read/write.
3. With `NULL` security, NPFS gives the pipe its documented default DACL:
   full control to SYSTEM, Administrators and the **creator owner**, read to
   Everyone and Anonymous. It does *not* use the token's default DACL.
4. The owner is the token's user — the real signed-in user — which is not a
   restricting SID. Everyone is, but only with read. The restricting pass
   fails for `WRITE_DAC` on creation and for the write open → `ERROR_ACCESS_DENIED`
   → Node reports `spawn EPERM` (or `listen EACCES` for a pipe server).

### What `stdio: 'inherit'` fixes, and what it cannot

DSH spawns the confined command with inherited stdio
(`sandbox.spawn({ command, args, stdio: 'inherit', … })`), so the sandbox
never has to create a pipe for the command's own output. Tnega does the same:

- Tnega (unrestricted) starts the runner with pipes
  (`packages/execution`, `stdio: [stdin, 'pipe', 'pipe']`). Those pipes are
  created outside the sandbox.
- The runner passes those handles to the confined command
  (`STARTF_USESTDHANDLES`, inherited stdio; `runner.ts`). No pipe is created
  under the restricted token, and the command's output reaches Tnega.

That solves the **first hop**: `cmd /c echo`, `npm --version` or a test that
prints directly all work and are captured. It cannot solve the **next hop**: when
the confined program itself spawns children with piped stdio (npm → vite →
esbuild, `execSync` in a build script), *that program* creates the named pipe
under the restricted token, and we do not control how third-party tools spawn.
This is exactly the case the DSH README limits its "impossible" statement to:
"confined **grandchildren**". Option C below (change how children are spawned)
is the same idea applied one level down, and is equally limited to code we own.

## 3. Our reproduction (2026-10-04)

Run through the real runner (`resolveRunnerCommand()`), workspace-write mode:

| Probe inside the sandbox | Result |
| --- | --- |
| `cmd /c echo` | ok |
| node `spawnSync(node, …, { stdio: 'inherit' })` / `'ignore'` | ok |
| node `spawnSync(node, …, { stdio: 'pipe' })` | `EPERM` |
| node `execSync('echo …')` | `EPERM` |
| node `net.createServer().listen('\\\\.\\pipe\\x')` | `EACCES` |
| `npm run dev` → `node parent.js` (npm itself uses inherit) | parent runs, its piped children fail |
| .NET `NamedPipeServerStream` / `AnonymousPipeServerStream` (PowerShell) | ok — no `WRITE_DAC`, owner-only use |

Experiments that did **not** help, which rule out the obvious token tweaks:

- adding Authenticated Users (S-1-5-11) to the restricting list — so the pipe
  namespace root is not the blocker;
- merging full-control ACEs for every restricting SID (logon, Everyone,
  capability SIDs) into the token's default DACL — so the pipe does not use it.

The only SID that satisfies the check is the pipe owner. For our token that
is the user's own SID, and putting it in the restricting list would let the
"sandbox" write wherever the user can: the write fence would be gone.

## 4. How others handle it

### Codex (OpenAI)

Two Windows sandboxes ([docs](https://learn.chatgpt.com/docs/windows/windows-sandbox)):

- **Unelevated** (fallback): a restricted token derived from the current
  user, ACL boundaries. Same design as ours; the pipe failure is open
  ([#47868](https://github.com/openai/codex/issues/47868)).
- **Elevated** (preferred): commands run as **dedicated lower-privilege local
  sandbox users**, with filesystem permission boundaries, per-user firewall
  rules and local policy changes. Setup needs one administrator approval
  (create users and groups, firewall rules, logon rights).
  [PR #20270](https://github.com/openai/codex/pull/20270) fixed named pipes
  there by adding the *sandbox user's* SID to the restricting list: the pipe
  owner is then a restricting SID, so owner-scoped pipes pass. It "does not
  broaden" access because the sandbox user has no file ACLs beyond what the
  capability SIDs already grant. The unelevated path was intentionally left
  unchanged, and still fails.
- Commands that still need more can be escalated per call through the
  approval policy.

### DeepSeek Harness

- Same restricted-token design (`WRITE_RESTRICTED`, capability SIDs, logon +
  Everyone keep-alive, low integrity label). Documents piped stdio for
  confined grandchildren as impossible.
- Remedy is **per-command escalation**: the shell tool tells the model to
  retry the exact same command once with `sandbox_permissions:
  "danger-full-access"` and a one-sentence justification; that needs
  approval and applies to that call only. Other routes: change the spawn to
  `stdio: 'inherit' | 'ignore'`, use PowerShell pipelines, or (community
  plugin) run Git Bash outside the sandbox.
- Lessons from its issue tracker: models attach `sandbox_permissions` to
  every call unless told to use it only after a real denial (#3806, #4294,
  #6869); backend failures (missing temp dir, ACL grant failure) must not be
  mistaken for policy denials, or agents escalate needlessly; and the
  escalation path itself must not be reachable without approval
  (CVE-2026-82533).

## 5. Options for Tnega

| | A. Per-command escalation (today) | B. Dedicated sandbox user (Codex elevated) | C. Change how children are spawned |
| --- | --- | --- | --- |
| Fixes `npm run dev` inside the fence | No — it runs **outside** the sandbox after approval | **Yes** — pipes work, writes stay fenced | Only for code we control |
| Setup | None | One admin approval: create a local user/group, grant logon right, store its credential, grant it read on the user's tools and read/write on workspaces | None |
| Security | Approved command is fully unconfined (writes anywhere, all network) | Stronger than today: also no access to the user's profile, keys and tokens unless granted; per-user firewall possible | Unchanged |
| Approvals | Every blocked build/dev-server run needs approval | None for ordinary commands | — |
| Failure modes | Approval fatigue; models over-escalate (DSH) | Enterprise policy can forbid user creation; credential storage; tools installed per-user (nvm, pnpm in `%AppData%`) need read grants; files the sandbox user creates are owned by it | Third-party tools spawn as they like |
| Effort | Done (v0.4.11+ unreleased) | Large: new Provider mode, setup flow, credential vault, grants, tests on a clean VM | Small, partial |

Not viable: adding the user's SID to the restricting list (removes the fence);
AppContainer (breaks reading the user's toolchains and most of the disk);
proxying pipes (they are created inside the confined process, not by us).

## 6. Recommendation

1. **Keep A as the baseline** and make it cheap and safe — already partly in
   place (stderr hint, `escalate` + `justification`, approval required,
   project threads reviewed for the coordinator). Add what DSH learned:
   - only accept `escalate` after a real sandbox denial for the same command
     (no pre-emptive escalation); treat backend failures as not escalatable;
   - let the user approve a command prefix for the session ("always allow
     `npm run dev` outside the sandbox here"), so a dev loop does not prompt
     every time;
   - prefer `process_start` for dev servers so one approval covers the
     long-running process.
2. **Build B as the real fix, opt-in**: a "Strong sandbox (needs administrator
   once)" setting in Settings → Tools & shell, implemented as a second mode
   of the `sandbox-windows-acl` Provider, mirroring Codex elevated: a local
   `TnegaSandbox` user, its SID in the restricting list, capability-SID grants
   as today, and the user's toolchain directories granted read. When B is
   active, the pipe hint and escalation become rare exceptions instead of the
   normal path for builds. Fall back to A (fail closed, never silently
   unconfined) when setup is declined or blocked by policy.
3. Do not do C beyond our own code; it cannot cover npm, vite or esbuild.

Next step if accepted: a design note for B (account lifecycle, credential
storage via DPAPI / Credential Manager, grant set for common toolchains,
uninstall), then a spike on a clean Windows VM to confirm `npm run dev` with
piped children works under the sandbox user before any product work.
