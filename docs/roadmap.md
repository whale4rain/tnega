# Roadmap and open problems

Problems we know about and directions we intend to take, with what is in
place today. Each entry links to the research or design that backs it. When
an item ships, move it to the CHANGELOG and delete it here.

## Open problems

### Windows sandbox: confined programs cannot pipe their own children

- **Problem.** Under the Windows write sandbox, a program that starts child
  processes with captured output (npm → vite → esbuild, webpack, jest,
  `execSync` in a build script) gets `spawn EPERM`. libuv's named pipes get
  NPFS's default DACL, which only lets the owner write, and the owner (the
  signed-in user) is not a restricting SID. Inherited stdio already covers the
  command Tnega itself starts; it cannot reach the program's own children.
- **Today.** The failure is explained where it shows up (`shell` stderr,
  background-job start note, `job_output` hint), and `shell` (foreground or as a job)
  can retry with `escalate: true` and a justification: after approval that one
  call runs outside the sandbox. Verified with a real `npm run dev` → vite →
  esbuild chain (confined: `main.js` 500 `spawn EPERM`; escalated: 200).
- **Direction: opt-in dedicated sandbox user** (Codex "elevated" mode). A
  local `TnegaSandbox` account, set up once with administrator approval; its
  SID joins the restricting list, so pipes it owns pass while writes stay
  fenced to the capability SIDs. Also stronger than today: no access to the
  user's profile, keys and tokens unless granted. Costs: an admin prompt that
  policy can block, a stored credential, read grants for per-user toolchains
  (nvm, pnpm in `%AppData%`). Falls back to escalation, never to an
  unconfined run.
- **Before building:** a design note (account lifecycle, credential storage
  via DPAPI or Credential Manager, the grant set, uninstall) and a spike on a
  clean Windows VM proving `npm run dev` with piped children works under that
  account.
- **Also worth doing on the escalation path** (lessons from DeepSeek
  Harness): accept `escalate` only after a real denial of the same command;
  never escalate on sandbox backend failures; let the user approve a command
  for the session ("always run `npm run dev` outside the sandbox here").
- Research: [2026-10-04-windows-sandbox-named-pipes.md](research/2026-10-04-windows-sandbox-named-pipes.md).

### Routines run only while their project is open

Routines live on the project Blackboard and run from the project host, so a
run happens only while Tnega is running and the project has been opened since
it started; a missed run happens once on the next tick. A background scheduler
that mounts projects with due routines would remove the second condition.
Design: [projects-design.md §5.3](project/projects-design.md).

## Projects, phase 2

From [projects-design.md §7](project/projects-design.md):

- Several people in one room: user identities, per-person unread and
  notifications, `@mentions`, attribution, presence.
- Threads that sleep when idle (release the live Agent, keep the Session),
  and a git worktree per thread for parallel code work, with a merge-back
  story.
- Budgets: a per-project token cap and a visible live-thread limit.
- Routine triggers beyond time (a file changes, a pull request updates).
- Suggested threads the coordinator proposes and a person starts in one click.
- Per-role models for the coordinator and threads (the Settings fields exist
  but the server does not store them yet).
