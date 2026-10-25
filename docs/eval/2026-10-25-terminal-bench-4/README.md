# Terminal-Bench 4.0 run (2026-10-24/25)

We ran tnega on all 66 tasks of Terminal-Bench 4.0 through the Harbor framework, using DeepSeek `deepseek-v4-flash`, with a total budget of about $7. This folder holds the findings, the three HTML reports, the data and the scripts, so the run can be compared or repeated.

> **Read this first: what was measured.** The runs used a bare `tnega run` (CLI). On 2026-10-25 that path, built with `createAgentRuntime`, did **not** load the continuation nudge, the loop guard, auto compaction (context budget) or the coding-agent plugin. The web and desktop host mounts these in `packages/host/src/runs.ts` and the Project host in `project-host.ts`. The score below is for a bare agent loop, not for the app as users run it. Before the next benchmark, check that the entry point loads the same plugins as the app.

## Results

| | Passed | Rate |
|---|---|---|
| Main run, all 66 tasks ($0.09 and 60 min cap per task) | 6 / 66 | **9.1 %** |
| Counting the bigger-budget retries ($0.25 to $0.50) | 8 / 66 | 12.1 % |
| Main run, only tasks that were not capped and got a grade | 3 / 24 | 12.5 % |
| Main run, only runs that ended with a final answer | 3 / 17 | 17.6 % |

For comparison, the same model scored 42.3 % in Claude Code and 31.8 % in mini-SWE-agent on the public leaderboard (`data/tb4-leaderboard.json`).

**How the 66 main runs ended:**
- 17 gave a final answer (3 passed).
- 33 hit the cost cap (3 passed anyway, 3 could not be graded).
- 6 ended on a broken stream, 3 hit the wall-clock cap, 1 hit the output limit and 1 crashed.
- 5 were not run (GPU tasks or disk limits).

**Spend:** $4.30 for the main run, $1.35 for the first rerun of 7 capped tasks, and $1.44 for round 2 (continuing 6 failed tasks from snapshots). Total is about $7.17.

Most wrong final answers were near misses, such as 45 of 47 hidden checks or 22 of 24. Budget stopped being the limit at about $0.25: in round 2, 6 of 7 runs ended by themselves under budget.

## Harness findings

These were handed to people to fix on 2026-10-25.

1. **Broken streams are treated as finished.** In `packages/llm/src/openai.ts`, `toFinishReason` returns `'stop'` when a stream ends without `finish_reason` and without content. A stream that ends after reasoning only, with no usage block, therefore counts as a finished reply. This happened 10 times and ended 8 runs. The continuation nudge's `looksUnfinished` would have caught them, but it isn't loaded in the CLI (see above).
2. **Old reasoning is resent every step.** `openai.ts` sends `reasoning_content` back for every assistant message after the last user message. A `tnega run` is one turn, so all reasoning is resent: about 53 % of the context by characters.
3. **No edit tool.** `write_file` can only overwrite or append, so a small fix means rewriting the whole file. The agent rewrote 34 files 44 times, used `sed -i` 47 times, and once called an `edit_file` tool that doesn't exist.
4. **The shell timeout is short.** 89 shell calls hit the 15 s timeout, and 24 % of package installs failed.
5. **The prompt is heavy for what is used.** 24 tool schemas take about 16k characters, against about 3.4k for the system prompt. Only 14 tools were ever called, and 79 % of all calls went to `shell`. The prompt also mentions a `wait` tool that isn't offered.
6. **Retry, done-check and the CLI plugin bundle.** There's no retry after a partially received stream, and no check before accepting "done". The CLI and the hosts should share one standard plugin bundle.

## Per-tool data (main run: 61 runs with session logs, 3,458 steps)

Token counts are estimated at 3 characters per token. "Carry" is how much of the input that tool's results took up over later steps.

| Tool | Calls | Share of input (carry) | Failure rate | Notes |
|---|---|---|---|---|
| shell | 2,903 | 43 % | 9 % | Used for nearly everything. About 100 timeouts, and 8.2 h of tool time. |
| write_file | 371 | 8 % | 5 % | About 28 % of all output tokens. 19 of the failures were path-fence refusals, mostly writes to `/tmp`. |
| read_file | 140 | 4 % | 6 % | Used half as often as reading through the shell (`sed -n`, `cat`, `head`: 269 calls). It has no line-range option. |
| job_start / job_output | 106 / 87 | under 1 % | 8 % / 0 | `job_output` was used as a wait: 0.55 h. |
| list_dir | 26 | under 1 % | 15 % | |
| Others (office, http_get, skills_list, now, calculator) | 1 to 3 each | ~0 | | Never used: json, glob, grep, office_create/edit, skill_read/create/install, remember_global. |

**Shell calls by kind:**

| Kind | Calls | Share of input | Failure rate | Timeouts |
|---|---|---|---|---|
| inline Python (`python3 -c`) | 1,003 | 11 % | 7 % | 23 |
| other | 400 | 6 % | 11 % | 16 |
| writing files through the shell | 324 | 6 % | 15 % | 18 |
| search and list (`ls`, `find`, `grep`) | 311 | 4 % | 5 % | 0 |
| reading files (`cat`, `sed -n`, `head`) | 269 | 10 % | 4 % | 1 |
| running a script | 229 | 4 % | 9 % | 7 |
| system and network | 181 | 1 % | 18 % | 22 |
| installing packages | 51 | 0.2 % | 24 % | 9 |
| editing in place (`sed -i`) | 47 | 0.4 % | 15 % | 1 |
| running tests | 36 | 0.1 % | 3 % | 1 |

**Patterns in how the agent works:**
- **Looking around repeatedly.** 630 steps were look-around steps (`ls`, `cat`, `find`), and 325 of them came straight after another one. Batching them into one call would save a step each time.
- **Throwaway Python probes.** 768 steps (22 %) were probes, at about 1,685 output tokens per step. Of the 1,003 inline Python calls, 795 re-import modules and 596 reload the same data. See [#53](https://github.com/whale4rain/tnega/issues/53).
- **Little testing.** Only 36 steps ran a test runner, which matches the near-miss failures.
- **Scratch files in the workspace.** 87 of 327 files the agent wrote were scratch files left in the workspace. 29 writes to `/tmp` were refused by the path fence.
- **Waiting by sleeping.** `sleep` was called 55 times, for a total of 1.8 h.

**Suggested next improvements,** beyond the fixes listed above:
- Allow batched look-arounds.
- Add line ranges to `read_file`.
- Offer a `wait` tool.
- Provide a scratch directory outside the workspace.
- Cap reading output at about 8k characters.
- Cut the default tool list to a small core plus one `tools_load` meta-tool for the office, skills, jobs, http and memory groups.

## Files

- [`report.html`](report.html): the main report, with scores, cost, comparison and endings.
- [`deep-dive.html`](deep-dive.html): token use, context growth, time, and failure analysis.
- [`tool-report.html`](tool-report.html): cost and usefulness per tool, and agent patterns.
- `data/results/`: per-task results for each batch (`tasks.csv`, `summary.json`, `rerun*.json`, `round2.json`).
- `data/*.json`: the analysis outputs (`stats`, `tools`, `steps`, `fail`, `endings`, `report_data`) and the leaderboard snapshot.
- `scripts/runner/`: the Harbor runner.
  - `orchestrate.py` and `analyze.py`.
  - The `tnega_harbor` external-agent adapter.
  - `run-tnega.mjs`.
  - The `shim/bash` that runs shell calls in the task container with `docker exec`.
- `scripts/analysis/`: the scripts that build `data/*.json` and the HTML reports from session logs.

Session logs are not committed because they are too large (about 310 MB). They were kept outside the repo.

## How the run was set up

- tnega ran on the host. A shell shim ran each shell call inside the task container with `docker exec`. The workspace was shared through a docker named volume, bind-mounted inside `unshare -m`.
- DeepSeek prices per 1M tokens: $0.15 for a cache miss, $0.003 for a cache hit, $0.60 for output (off-peak).
- Docker Hub rate limits were avoided with the `mirror.gcr.io` registry mirror. GPU tasks were skipped for disk space.
- **Continuing a capped run.** The runner snapshots the container with `docker commit` and resumes from it.
  - The `com.docker.compose.*` labels must be blanked first, or `compose down --rmi local` deletes the snapshot image.
  - The resume used a patched CLI that passes the old session's projected events back in as messages. `tnega run --session <existing>` does **not** reload history.
- The scripts contain the absolute paths of the machine they ran on, so adjust those before running them again.
