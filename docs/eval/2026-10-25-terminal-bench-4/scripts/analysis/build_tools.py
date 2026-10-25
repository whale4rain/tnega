"""Per-tool report: what each tool and action costs, how well it works, and what to change."""
import json, html
from pathlib import Path

B = Path("/home/user/bench")
G = json.loads((B / "deep/steps.json").read_text())
T = json.loads((B / "deep/tools.json").read_text())
head = (B / "deep/style.css.part").read_text()
esc = html.escape
groups = {g["group"]: g for g in G["groups"]}
TOTAL_STEPS = sum(g["steps"] for g in G["groups"])

VERDICT = {
    "probe with inline python": ("Works, costly", "warn"),
    "look around": ("Works, wasteful", "warn"),
    "run code": ("Works", "ok"),
    "write file (write_file)": ("Most expensive action", "bad"),
    "write file (shell)": ("Workaround", "warn"),
    "background job": ("Works", "ok"),
    "edit file (python)": ("Workaround", "warn"),
    "wait/process/network": ("Wastes time", "bad"),
    "install": ("Fails often", "bad"),
    "edit file (sed)": ("Workaround", "warn"),
    "reply without tools": ("Final answer", "ok"),
    "run tests": ("Rarely used", "warn"),
}
LABEL = {
    "probe with inline python": "Probe data or code with inline Python",
    "look around": "Look around (cat, grep, ls, read_file, list_dir)",
    "run code": "Run a program or script",
    "write file (write_file)": "Write a file with write_file",
    "write file (shell)": "Write a file through the shell (cat > f <<EOF)",
    "background job": "Background job (start, poll, kill)",
    "edit file (python)": "Edit a file with a Python string replace",
    "wait/process/network": "Sleep, check processes, curl",
    "install": "Install packages",
    "edit file (sed)": "Edit a file with sed -i",
    "reply without tools": "Reply without tools (final answer)",
    "run tests": "Run a test runner (pytest, cargo test, ...)",
}
order = ["write file (write_file)", "probe with inline python", "look around", "run code", "write file (shell)",
         "edit file (python)", "background job", "wait/process/network", "install", "edit file (sed)", "run tests",
         "reply without tools"]
rows = []
for k in order:
    g = groups[k]
    v, cls = VERDICT[k]
    out = g["reason_per_step"] + g["vis_per_step"]
    rows.append(
        f'<tr><td>{esc(LABEL[k])}</td><td class="num">{g["steps"]:,}</td><td class="num">{g["steps"]/TOTAL_STEPS*100:.0f}%</td>'
        f'<td class="num">{out:,.0f}</td><td class="num">{g["reason_per_step"]:,.0f}</td>'
        f'<td class="num">{g["model_s_per_step"]:.1f}</td><td class="num">{g["tool_s_per_step"]:.1f}</td>'
        f'<td class="num">{g["res_tok_per_step"]:,.0f}</td><td class="num">{g["out_share"]*100:.0f}%</td>'
        f'<td class="num">{g["carry_share"]*100:.1f}%</td><td class="num">{g["bad_rate"]*100:.0f}%</td>'
        f'<td><span class="pill {cls}">{v}</span></td></tr>')
action_rows = "".join(rows)

# phases
PH_ORDER = [("look around", "s1"), ("probe with inline python", "s2"), ("write file (write_file)", "s3"),
            ("write file (shell)", "s3"), ("edit file (python)", "s3"), ("edit file (sed)", "s3"),
            ("run code", "s4"), ("run tests", "s4"), ("background job", "s5"), ("wait/process/network", "s5"), ("install", "s5")]
BUCKET = {"Look around": ["look around"], "Probe with Python": ["probe with inline python"],
          "Write or edit files": ["write file (write_file)", "write file (shell)", "edit file (python)", "edit file (sed)"],
          "Run code or tests": ["run code", "run tests"],
          "Jobs, waiting, installs": ["background job", "wait/process/network", "install"]}
COLORS = dict(zip(BUCKET, ["s1", "s2", "s3", "s4", "s5"]))
phase_rows = []
names = ["First fifth", "Second", "Third", "Fourth", "Last fifth"]
for i in range(5):
    ph = G["phase"][str(i)]
    tot = sum(ph.values())
    segs = []
    for b, members in BUCKET.items():
        v = sum(ph.get(m, 0) for m in members)
        segs.append(f'<div class="seg {COLORS[b]}" style="flex:{v/tot:.4f}" title="{esc(b)}: {v/tot*100:.0f}%"><span>{v/tot*100:.0f}%</span></div>')
    phase_rows.append(f'<div class="phrow"><span class="phlab">{names[i]}</span><div class="stack tall">{"".join(segs)}</div></div>')
phase_legend = "".join(f'<li><span class="sw {c}"></span>{esc(b)}</li>' for b, c in COLORS.items())

# shell categories table
SH = {x["name"]: x for x in T["shell"]}
sh_rows = "".join(
    f'<tr><td>{esc(x["name"])}</td><td class="num">{x["calls"]:,}</td><td class="num">{x["res_tok"]/x["calls"]:,.0f}</td>'
    f'<td class="num">{x["carry_share"]*100:.1f}%</td><td class="num">{x["time_h"]:.2f}</td><td class="num">{x["med_s"]:.2f}</td>'
    f'<td class="num">{x["bad_rate"]*100:.0f}%</td><td class="num">{x["timeouts"]}</td></tr>'
    for x in sorted(T["shell"], key=lambda x: -x["calls"]))

g = groups
page = f"""<title>tnega Tool Report</title>
{head}
.seg.s4, .sw.s4 {{ background: var(--seg4); }} .seg.s5, .sw.s5 {{ background: var(--seg5); }}
:root {{ --seg4: #dfe3dc; --seg5: #b48a3c; --warn: #8a6414; --warn-bg: #f6eedc; --ok: var(--pass); --ok-bg: var(--pass-bg); }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --seg4: #3a4038; --seg5: #9c7a3a; --warn: #e2c770; --warn-bg: #332c17; }} }}
:root[data-theme="dark"] {{ --seg4: #3a4038; --seg5: #9c7a3a; --warn: #e2c770; --warn-bg: #332c17; }}
.pill.ok {{ background: var(--ok-bg); color: var(--ok); }} .pill.warn {{ background: var(--warn-bg); color: var(--warn); }} .pill.bad {{ background: var(--fail-bg); color: var(--fail); }}
.stack.tall {{ height: 26px; flex: 1; }}
.stack.tall .seg {{ display: flex; align-items: center; justify-content: center; font: 11px var(--font-mono); color: var(--bg); overflow: hidden; }}
.stack.tall .seg.s4 span {{ color: var(--fg); }}
.phrow {{ display: flex; align-items: center; gap: 12px; }}
.phlab {{ width: 84px; font-size: 0.82rem; color: var(--muted); flex: none; }}
.tool {{ background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 20px; display: grid; gap: 12px; min-width: 0; }}
.tool h3 {{ display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 1.1rem; }}
.facts {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }}
.facts div {{ display: grid; gap: 2px; }}
.facts b {{ font-size: 1.15rem; font-variant-numeric: tabular-nums; }}
.facts span {{ font-size: 0.8rem; color: var(--muted); line-height: 1.3; }}
.tool p {{ max-width: 76ch; }}
.do {{ border-left: 3px solid var(--accent); padding: 4px 0 4px 12px; max-width: 76ch; }}
.next {{ display: grid; gap: 12px; counter-reset: n; }}
.next .tool h3::before {{ counter-increment: n; content: counter(n); font-family: var(--font-mono); color: var(--accent); font-size: 0.85rem; }}
</style>
<div class="wrap">
<header>
  <div class="eyebrow">Terminal-Bench 4.0 · tnega 0.5.3 · DeepSeek V4.1 Flash · 61 runs, 3,458 steps, 3,660 tool calls</div>
  <h1>What each tool costs, how well it works, and what to change</h1>
  <p class="lede">The shell is tnega's whole workbench: it handles 79% of tool calls. Most of the cost is not in running tools. It is in the model writing code into tool calls and re-reading results that stay in context. The biggest wins are for reading, probing and waiting. The fixes you already assigned are not repeated here.</p>
</header>

<section>
  <h2>Every action, side by side</h2>
  <p class="prose muted">Each model step is grouped by the first tool it called. "Output tokens" is what the model generated for that step, reasoning included. "Context share" is how much of all input tokens over the run came from that action's arguments and results, because each one is re-sent on every later step. Shell commands are sorted by what they actually do.</p>
  <div class="scroll"><table>
    <thead><tr><th>Action</th><th class="num">Steps</th><th class="num">of steps</th><th class="num">Output tok / step</th><th class="num">of which reasoning</th><th class="num">Model s / step</th><th class="num">Tool s / step</th><th class="num">Result tok / step</th><th class="num">Share of output</th><th class="num">Context share</th><th class="num">Failed</th><th>Verdict</th></tr></thead>
    <tbody>{action_rows}</tbody>
  </table></div>
  <p class="prose muted">Token counts are reported by DeepSeek. Result and context tokens are estimated at 3 characters per token. Context shares cover tool arguments and results only; old reasoning, about half the context, is shown in the deep-dive report.</p>
</section>

<section>
  <h2>How the agent works through a task</h2>
  <p class="prose">Each run is split into fifths by step. The agent spends its first fifth mostly looking around, then settles into a steady loop: probe with Python, write a file, run it, look again. It rarely runs a test suite: only 36 steps used a test runner, against 768 steps of ad-hoc Python probes. It checks its work by printing values, not by running tests, which matches how its wrong answers failed on hidden edge cases.</p>
  <div class="card" style="display:grid;gap:10px">{"".join(phase_rows)}<ul class="legend" style="margin-top:6px">{phase_legend}</ul></div>
  <ul class="plain prose">
    <li><b>Serial looking.</b> Of {g['look around']['steps']} look-around steps, 325 came straight after another look-around step. Each one is a full model round trip ({g['look around']['model_s_per_step']:.1f} s and {g['look around']['reason_per_step']:.0f} reasoning tokens) to read one more file. Only 218 of 3,458 steps called more than one tool at once.</li>
    <li><b>Five ways to change a file.</b> write_file ({g['write file (write_file)']['steps']} steps), shell heredocs ({g['write file (shell)']['steps']}), Python string replace ({g['edit file (python)']['steps']}), and sed -i ({g['edit file (sed)']['steps']}). The workarounds fail more often (9 to 15%) than write_file (5%).</li>
    <li><b>Scratch scripts in the workspace.</b> 87 of 327 files written were throwaway probes like <code>sift2.py</code>, <code>step2.py</code> and <code>t19.py</code>. The path fence refused 29 attempts to write to <code>/tmp</code>, so scratch work lands next to the deliverables.</li>
    <li><b>Waiting by sleeping.</b> 55 commands start with <code>sleep N</code> to wait for a background process. Together they took 1.8 hours, 10% of all agent time.</li>
    <li><b>Few repeats.</b> Only 9 shell commands were exact repeats, and 29 files were read more than once. The agent does not loop. It just takes many small serial steps.</li>
  </ul>
</section>

<section>
  <h2>Tool by tool</h2>

  <div class="tool">
    <h3><code>shell</code> <span class="pill warn">Works, but carries too much</span></h3>
    <div class="facts">
      <div><b>2,903</b><span>calls in 59 of 61 runs (79% of all calls)</span></div>
      <div><b>43%</b><span>of all input tokens come from shell commands and their output staying in context</span></div>
      <div><b>8.3 h</b><span>of runtime, median 0.36 s per call</span></div>
      <div><b>9%</b><span>non-zero exit or error; about 100 hit the 15 s timeout</span></div>
    </div>
    <p>It works: commands rarely fail for tool reasons. The problem is what it is used for. Shell is the reader, the editor, the Python console and the process manager, and every output stays in context until the run ends.</p>
    <div class="scroll"><table>
      <thead><tr><th>What the command does</th><th class="num">Calls</th><th class="num">Result tok / call</th><th class="num">Context share</th><th class="num">Hours</th><th class="num">Median s</th><th class="num">Failed</th><th class="num">Timeouts</th></tr></thead>
      <tbody>{sh_rows}</tbody>
    </table></div>
    <p class="do"><b>Change:</b> cap reading commands (<code>cat</code>, <code>grep</code>, <code>find</code>, <code>head</code>) at about 8k characters in context, with a pointer to the full output. Reading results average {SH['read/inspect']['res_tok']/SH['read/inspect']['calls']:,.0f} tokens per call and take {SH['read/inspect']['carry_share']*100:.1f}% of all input tokens. Spill only starts at 50k characters today.</p>
  </div>

  <div class="tool">
    <h3><code>write_file</code> <span class="pill bad">Most expensive action</span></h3>
    <div class="facts">
      <div><b>{g['write file (write_file)']['steps']}</b><span>steps (371 calls, 46 runs)</span></div>
      <div><b>{g['write file (write_file)']['reason_per_step']+g['write file (write_file)']['vis_per_step']:,.0f}</b><span>output tokens per step: {g['write file (write_file)']['vis_per_step']:,.0f} of file content plus {g['write file (write_file)']['reason_per_step']:,.0f} reasoning</span></div>
      <div><b>{g['write file (write_file)']['out_share']*100:.0f}%</b><span>of all output tokens, the biggest share of any action</span></div>
      <div><b>{g['write file (write_file)']['model_s_per_step']:.1f} s</b><span>model time per write, 3 times a look-around step</span></div>
    </div>
    <p>It is reliable: 5% of calls failed, mostly the path fence refusing <code>/tmp</code>. Across all ways of writing, a write followed by a failing run happened 35 times, against 309 clean runs. It is costly because every change resends the whole file.</p>
    <p class="do"><b>Change:</b> the edit tool is already assigned. Two things to add for it. Let <code>write_file</code> write to a session scratch folder outside the workspace, so the 87 throwaway scripts stop landing next to deliverables. And put one line in the tool description: "for changes to an existing file, use edit_file".</p>
  </div>

  <div class="tool">
    <h3><code>read_file</code> <span class="pill warn">Under-used</span></h3>
    <div class="facts">
      <div><b>140</b><span>calls, against 269 reading commands in the shell</span></div>
      <div><b>{T['tools'][2]['res_tok']/140:,.0f}</b><span>tokens per result on average (whole files up to 256 KB)</span></div>
      <div><b>4.0%</b><span>of all input tokens</span></div>
      <div><b>6%</b><span>failed: path fence or binary file</span></div>
    </div>
    <p>It works, but it only reads from the start of a file with a byte limit (<code>maxBytes</code>). It has no line range and no line numbers. To read the middle of a log or source file, the agent has to use <code>sed -n</code>, <code>head</code> or <code>tail</code> in the shell.</p>
    <p class="do"><b>Change:</b> add <code>offset</code> and <code>limit</code> in lines, return line numbers, and for big files return the first 200 lines plus the total line count by default. This lets reading move out of the shell and keeps each result small.</p>
  </div>

  <div class="tool">
    <h3>Inline Python through the shell <span class="pill warn">Works, costly</span></h3>
    <div class="facts">
      <div><b>{g['probe with inline python']['steps']}</b><span>probe steps, the most common action (22% of steps)</span></div>
      <div><b>{g['probe with inline python']['reason_per_step']+g['probe with inline python']['vis_per_step']:,.0f}</b><span>output tokens per probe ({g['probe with inline python']['vis_per_step']:.0f} of code)</span></div>
      <div><b>{g['probe with inline python']['out_share']*100:.0f}%</b><span>of all output tokens</span></div>
      <div><b>{g['probe with inline python']['model_s_per_step']:.1f} s</b><span>model time per probe; 2.1 s to run</span></div>
    </div>
    <p>The agent investigates data, images and code by writing small Python programs. Each probe starts from nothing. Of 1,003 inline Python calls, 795 begin with imports and 596 load a file again, such as an image, a JSON file or a CSV, before printing a few values. Separately, 198 steps used a Python script to edit a file with <code>.replace()</code>.</p>
    <p class="do"><b>Change:</b> add a persistent Python tool, a REPL that keeps its variables between calls inside the task container. Loaded data and helpers stay in memory, so each probe is a few lines instead of a whole script. It also gives the model a clean place to run checks.</p>
  </div>

  <div class="tool">
    <h3>Waiting: <code>sleep</code>, <code>job_output</code> <span class="pill bad">Wastes time</span></h3>
    <div class="facts">
      <div><b>55</b><span><code>sleep N</code> commands to wait for something</span></div>
      <div><b>1.8 h</b><span>spent sleeping, 10% of agent time</span></div>
      <div><b>87</b><span><code>job_output</code> polls for 106 started jobs</span></div>
      <div><b>19%</b><span>of process and network commands failed</span></div>
    </div>
    <p>Background jobs work: 8% of <code>job_start</code> calls had bad arguments, and the rest ran. But the agent cannot wait for a job, a port or a file to be ready. It guesses a sleep length, so it waits too long or too short and checks again. The system prompt even says "use wait only when blocked", but no <code>wait</code> tool is offered.</p>
    <p class="do"><b>Change:</b> add the <code>wait</code> tool the prompt already names. It should wait until a job finishes, a port opens, a file appears or a log line matches, with a timeout. It returns as soon as the condition is true, instead of after a fixed sleep.</p>
  </div>

  <div class="tool">
    <h3>Installing packages <span class="pill bad">Fails often</span></h3>
    <div class="facts">
      <div><b>51</b><span>install commands in 20 runs</span></div>
      <div><b>24%</b><span>failed; most were killed by the 15 s shell timeout</span></div>
      <div><b>6.3 s</b><span>median install time when it worked</span></div>
    </div>
    <p>Examples: <code>pip install opencv-python-headless scipy</code>, <code>pip install rapidocr-onnxruntime</code> and <code>apt-get install tesseract-ocr</code> were all killed at 15 s. The agent then tried again with a longer timeout or gave up on that approach.</p>
    <p class="do"><b>Change:</b> raising the shell default is already assigned. As a cheap extra, recognise install commands and give them a longer timeout automatically.</p>
  </div>

  <div class="tool">
    <h3><code>list_dir</code>, jobs, Office, skills and the rest <span class="pill ok">Fine, rarely needed</span></h3>
    <p><code>list_dir</code>: 26 calls, 15% refused by the path fence. The agent prefers <code>ls</code> and <code>find</code>. Office tools: 6 calls, which fits the few Office tasks. These were never called: <code>glob</code>, <code>grep</code>, <code>json</code>, <code>office_create</code>, <code>office_edit</code>, <code>skill_read</code>, <code>skill_create</code>, <code>skill_install</code> and <code>remember_global</code>. That includes <code>glob</code> and <code>grep</code>, even though <code>search/list</code> shell commands ran 311 times.</p>
    <p class="do"><b>Change:</b> either drop <code>glob</code> and <code>grep</code> from the default set, or make the shell <code>grep</code>/<code>find</code> results go through the same output cap as above. The agent will not switch on its own.</p>
  </div>
</section>

<section>
  <h2>Next improvements, by expected payoff</h2>
  <p class="prose muted">New items only. The seven fixes from the earlier reports are already assigned. The estimates come from these 61 runs.</p>
  <div class="next">
    <div class="tool"><h3>Batch look-around steps</h3><p>325 look-around steps came straight after another one. Add one line to the system prompt ("read related files in one step with parallel tool calls") and keep parallel reads fast. Payoff: up to about 34 minutes and 290k output tokens across these runs.</p></div>
    <div class="tool"><h3>Line ranges and line numbers in <code>read_file</code></h3><p>This moves reading out of the shell and keeps results small. Reading results take about 14% of all input tokens today ({SH['read/inspect']['carry_share']*100:.1f}% from shell reads plus 4.0% from read_file).</p></div>
    <div class="tool"><h3>A <code>wait</code> tool</h3><p>It replaces guessed sleeps. Payoff: up to 1.8 hours of the 17.7 here, and it fixes a prompt that already names a missing tool.</p></div>
    <div class="tool"><h3>A persistent Python tool</h3><p>It targets the most common action (768 steps, 25% of output tokens). The saving is hard to predict, so measure it on a small rerun of the Python-heavy tasks, such as the image, audio and data tasks.</p></div>
    <div class="tool"><h3>A scratch folder outside the workspace</h3><p>It keeps 87 throwaway scripts out of the deliverables and removes 29 path-fence refusals. It is a small change in the path fence and in <code>write_file</code>.</p></div>
    <div class="tool"><h3>Cap reading output in context at about 8k characters</h3><p>The cap applies to cat, grep, find and similar. The full output stays available through the existing spill pointer.</p></div>
  </div>
</section>

<section>
  <h2>Data</h2>
  <p class="prose muted">This report covers the 61 main-run sessions (3,458 steps). The scripts <code>deep/tools.py</code> and <code>deep/steps.py</code>, and their output <code>deep/tools.json</code> and <code>deep/steps.json</code>, are in <code>reports/tnega-terminal-bench-4/</code> in the project files.</p>
</section>
</div>
"""
out = Path("/mnt/project-files/reports/tnega-terminal-bench-4/tool-report.html")
out.write_text(page)
print("ok", len(page))
