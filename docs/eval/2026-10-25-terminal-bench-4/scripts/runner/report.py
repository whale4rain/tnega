"""Build the HTML report from results/*.json, the rerun results and the
official Terminal-Bench 4.0 leaderboard export."""
import html
import json
import statistics
from pathlib import Path

BENCH = Path("/home/user/bench")
rows = json.loads((BENCH / "results/tasks.json").read_text())
summ = json.loads((BENCH / "results/summary.json").read_text())
rerun = json.loads((BENCH / "results/rerun.json").read_text()) if (BENCH / "results/rerun.json").exists() else []
lb_raw = json.loads((BENCH / "compare/tb4-leaderboard.json").read_text())
lb = lb_raw if isinstance(lb_raw, list) else next(v for v in lb_raw.values() if isinstance(v, list))
extra = json.loads((BENCH / "results/extra.json").read_text())

esc = html.escape
N = len(rows)
ran = [r for r in rows if r.get("llm_calls")]
passed = [r for r in rows if r["status"] == "passed"]
pass1 = len(passed) / N * 100
cost_total = sum(r.get("cost_usd", 0) for r in ran)
cost_task = cost_total / len(ran)
tok_task = statistics.mean(r["total_tokens"] for r in ran) / 1e6
out_task = statistics.mean(r["output_tokens"] for r in ran) / 1e3
wall_task = statistics.mean(r.get("wall_seconds", 0) for r in ran) / 60
cache_rate = sum(r["cached_tokens"] for r in ran) / sum(r["prompt_tokens"] for r in ran) * 100
reason_share = sum(r["reasoning_tokens"] for r in ran) / sum(r["output_tokens"] for r in ran) * 100
parts = summ["cost_parts"]
ptot = sum(parts.values())


def lbrow(r):
    m, x = r["metadata"], r["metrics"]
    n = x["n_trials"]
    return {
        "agent": m["agent_display"]["label"], "model": m["model_display"]["label"],
        "effort": m.get("reasoning_effort") or "", "acc": x["accuracy"],
        "cost": (x.get("total_cost_usd") or 0) / n, "tok": (x.get("total_tokens") or 0) / n / 1e6,
        "out": (x.get("output_tokens") or 0) / n / 1e3, "dur": (x.get("avg_trial_duration_sec") or 0) / 60,
        "ci": x.get("accuracy_ci95_half_width"), "src": "Official TB 4.0 leaderboard (5 trials per task)",
    }


board = [lbrow(r) for r in lb]
# Best row per agent+model for the chart
seen, chart = set(), []
for b in sorted(board, key=lambda b: -b["acc"]):
    key = (b["agent"], b["model"])
    if key in seen:
        continue
    seen.add(key)
    chart.append(b)
pick = [c for c in chart if c["model"] in ("Opus 5.5", "GPT-6.1 Sol", "Fable 5.1", "GLM-5.3", "GLM-5.3-Flash", "Grok 4.7", "GPT-6 Luna", "Gemini 3.8 Flash", "Sonnet 5.5")]
ds = [
    {"agent": "Claude Code", "model": "DeepSeek V4.1 Flash", "acc": 42.3, "cost": None, "src": "DeepSeek, self-reported (llm-stats, Oct 17 2026)", "ref": True},
    {"agent": "mini-SWE-agent", "model": "DeepSeek V4.1 Flash", "acc": 31.82, "cost": None, "src": "vals.ai Terminal-Bench 4.0 board", "ref": True},
]
rr_pass = sum(1 for r in rerun if r.get("status") == "passed")
mine = {"agent": "tnega 0.5.3", "model": "DeepSeek V4.1 Flash", "acc": pass1, "cost": cost_task, "tok": tok_task,
        "out": out_task, "dur": wall_task, "src": "This run: 1 trial per task, capped at $0.09 and 60 min", "me": True}
_r2 = json.loads((BENCH / "results/round2.json").read_text()) if (BENCH / "results/round2.json").exists() else []
big_pct_early = (len(passed) + rr_pass + len({r["task"] for r in _r2 if r["status"] == "passed"})) / N * 100
mine_big = {"agent": "tnega + retries", "model": "DeepSeek V4.1 Flash", "acc": big_pct_early, "cost": None,
            "src": "Same run, with 13 failed tasks retried at $0.25 to $0.50", "me": True}
bars = sorted(pick + ds + [mine, mine_big], key=lambda b: -b["acc"])


def bar_chart(items):
    W, rowh, left, right = 760, 30, 250, 70
    h = rowh * len(items) + 34
    scale = (W - left - right) / 70
    out = [f'<svg viewBox="0 0 {W} {h}" role="img" aria-label="Terminal-Bench 4.0 accuracy by harness and model" class="chart">']
    for t in range(0, 71, 10):
        x = left + t * scale
        out.append(f'<line x1="{x:.1f}" y1="6" x2="{x:.1f}" y2="{h-22}" class="grid"/>')
        out.append(f'<text x="{x:.1f}" y="{h-6}" class="tick" text-anchor="middle">{t}%</text>')
    for i, b in enumerate(items):
        y = 8 + i * rowh
        cls = "me" if b.get("me") else ("ref" if b.get("ref") else "other")
        w = max(b["acc"] * scale, 2)
        label = f'{b["agent"]} · {b["model"]}'
        tip = f'{label}: {b["acc"]:.1f}%' + (f', ${b["cost"]:.2f} per task' if b.get("cost") else "") + f' ({b["src"]})'
        out.append(f'<g class="bar {cls}"><title>{esc(tip)}</title>')
        out.append(f'<text x="{left-10}" y="{y+16}" text-anchor="end" class="lab {cls}">{esc(label)}</text>')
        out.append(f'<rect x="{left}" y="{y+3}" width="{w:.1f}" height="18" rx="3"/>')
        out.append(f'<text x="{left+w+6:.1f}" y="{y+16}" class="val">{b["acc"]:.1f}%</text></g>')
    out.append("</svg>")
    return "\n".join(out)


def stack(items, total, label):
    segs, x = [], 0.0
    for name, val, cls in items:
        w = val / total * 100
        segs.append(f'<span class="seg {cls}" style="width:{w:.2f}%" title="{esc(name)}: {val}"></span>')
    legend = "".join(f'<li><span class="sw {cls}"></span>{esc(name)} <b>{val}</b></li>' for name, val, cls in items)
    return f'<div class="stack" role="img" aria-label="{esc(label)}">{"".join(segs)}</div><ul class="legend">{legend}</ul>'


# Outcome taxonomy over the 66 tasks
def outcome(r):
    s = r.get("stop_reason")
    if r["status"] == "not_run":
        return "Not run (needs a GPU)"
    if r.get("task") == "medical-claims-processing":
        return "Not run (needs an MCP browser server)"
    if s == "cost_cap":
        return "Stopped by $0.09 cap"
    if s == "wall_cap":
        return "Stopped by 60 min cap"
    if r.get("turn_end") == "max-tokens":
        return "Ended: output token limit"
    if s == "finished":
        return "Said done"
    return "Crashed / empty reply"


tax = {}
for r in rows:
    k = outcome(r)
    tax.setdefault(k, [0, 0])
    tax[k][0] += 1
    tax[k][1] += r["status"] == "passed"
tax_order = ["Said done", "Stopped by $0.09 cap", "Stopped by 60 min cap", "Ended: output token limit", "Crashed / empty reply", "Not run (needs a GPU)", "Not run (needs an MCP browser server)"]
tax_rows = "".join(
    f'<tr><td>{esc(k)}</td><td class="num">{tax[k][0]}</td><td class="num">{tax[k][1]}</td></tr>' for k in tax_order if k in tax
)

# Per-task table
def fmt_status(r):
    m = {"passed": ("pass", "Passed"), "failed": ("fail", "Failed"), "error": ("err", "No grade"), "not_run": ("skip", "Not run")}
    c, t = m[r["status"]]
    return f'<span class="pill {c}">{t}</span>'


task_rows = []
for r in sorted(rows, key=lambda r: (r["status"] != "passed", r["task"])):
    rr = next((x for x in rerun if x["task"] == r["task"]), None)
    rr_cell = fmt_status(rr) + f' <span class="muted">${rr.get("cost_usd", 0):.2f}</span>' if rr else ""
    task_rows.append(
        f'<tr><td class="mono">{esc(r["task"])}</td><td>{esc(str(r.get("category") or ""))}</td><td>{fmt_status(r)}</td>'
        f'<td>{esc(outcome(r))}</td><td class="num">{r.get("cost_usd", 0):.3f}</td><td class="num">{r.get("llm_calls", 0)}</td>'
        f'<td class="num">{r.get("total_tokens", 0)/1e6:.1f}</td><td class="num">{r.get("output_tokens", 0)/1e3:.0f}</td>'
        f'<td class="num">{r.get("peak_context", 0)/1e3:.0f}</td><td class="num">{r.get("wall_seconds", 0)/60:.0f}</td><td>{rr_cell}</td></tr>'
    )

cmp_rows = []
for b in sorted(board, key=lambda b: -b["acc"]):
    cmp_rows.append(
        f'<tr><td>{esc(b["agent"])}</td><td>{esc(b["model"])}</td><td>{esc(b["effort"])}</td><td class="num">{b["acc"]:.1f}</td>'
        f'<td class="num">{b["cost"]:.2f}</td><td class="num">{b["tok"]:.1f}</td><td class="num">{b["out"]:.0f}</td><td class="num">{b["dur"]:.0f}</td></tr>'
    )
cmp_rows.insert(0,
    f'<tr class="hl"><td>tnega 0.5.3</td><td>DeepSeek V4.1 Flash</td><td>default</td><td class="num">{pass1:.1f}</td>'
    f'<td class="num">{cost_task:.3f}</td><td class="num">{tok_task:.1f}</td><td class="num">{out_task:.0f}</td><td class="num">{wall_task:.0f}</td></tr>')

glm = next(b for b in board if b["model"] == "GLM-5.3-Flash")
R2_MIDPLAN = {"music-harmony", "pretrain-shard-corruption"}
round2 = json.loads((BENCH / "results/round2.json").read_text()) if (BENCH / "results/round2.json").exists() else []
r2_cost = sum(r["cost_usd"] for r in round2) + 0.019  # plus one run stopped at the start
r2_self = sum(1 for r in round2 if r["stop_reason"] == "finished")
r2_pass_tasks = {r["task"] for r in round2 if r["status"] == "passed"}
big_pass = len(passed) + rr_pass + len(r2_pass_tasks)
r2_rows = "".join(
    f'<tr><td class="mono">{esc(r["task"])}</td><td class="num">${r["cap"]:.2f}</td><td>{fmt_status(r)}</td>'
    f'<td>{"Stopped by cap" if r["stop_reason"] == "cost_cap" else ("Stopped mid-plan" if r["task"] in R2_MIDPLAN and r["status"] != "passed" else "Said done")}</td><td class="num">{r["cost_usd"]:.3f}</td>'
    f'<td class="num">{r["llm_calls"]}</td><td class="num">{r["wall_seconds"]/60:.0f}</td></tr>'
    for r in round2)
rr_n = len(rerun)
rr_cost = sum(r.get("cost_usd", 0) for r in rerun)
rr_capped = sum(1 for r in rerun if r.get("stop_reason") == "cost_cap")
x = extra
page = (BENCH / "runner/report_template.html").read_text()
subs = {
    "PASS1": f"{pass1:.1f}", "NPASS": str(len(passed)), "N": str(N), "NRAN": str(len(ran)),
    "COST_TOTAL": f"{cost_total:.2f}", "COST_TASK": f"{cost_task:.3f}", "TOK_TASK": f"{tok_task:.1f}",
    "OUT_TASK": f"{out_task:.0f}", "WALL_TASK": f"{wall_task:.0f}", "CACHE": f"{cache_rate:.1f}",
    "REASON": f"{reason_share:.0f}", "COST_OUT": f"{parts['out']/ptot*100:.0f}", "COST_MISS": f"{parts['miss']/ptot*100:.0f}",
    "COST_HIT": f"{parts['hit']/ptot*100:.0f}", "BAR_CHART": bar_chart(bars), "TAX_ROWS": tax_rows,
    "TASK_ROWS": "\n".join(task_rows), "CMP_ROWS": "\n".join(cmp_rows),
    "GLM_COST": f"{glm['cost']:.2f}", "GLM_DUR": f"{glm['dur']:.0f}", "GLM_OUT": f"{glm['out']:.0f}", "GLM_TOK": f"{glm['tok']:.1f}",
    "R2_N": str(len(round2)), "R2_TASKS": str(len({r["task"] for r in round2})), "R2_PASS": str(len(r2_pass_tasks)),
    "R2_COST": f"{r2_cost:.2f}", "R2_SELF": str(r2_self), "R2_ROWS": r2_rows,
    "BIG_PASS": str(big_pass), "BIG_PCT": f"{big_pass / N * 100:.1f}",
    "RR_N": str(rr_n), "RR_PASS": str(rr_pass), "RR_COST": f"{rr_cost:.2f}", "RR_CAPPED": str(rr_capped),
    "PASSED_LIST": ", ".join(r["task"] for r in passed),
    "SAID_DONE": str(tax.get("Said done", [0, 0])[0]), "SAID_DONE_PASS": str(tax.get("Said done", [0, 0])[1]),
    "CAPPED": str(tax.get("Stopped by $0.09 cap", [0, 0])[0]), "CAPPED_PASS": str(tax.get("Stopped by $0.09 cap", [0, 0])[1]),
    "SPEND_ALL": f"{x['spend_all']+rr_cost+r2_cost:.2f}",
    "PEAK_MED": f"{statistics.median(r['peak_context'] for r in ran)/1e3:.0f}",
    "PEAK_MAX": f"{max(r['peak_context'] for r in ran)/1e3:.0f}",
    "SHELL_TO": str(x["shell_timeouts_15s"]), "SHELL_CALLS": str(summ["tools"].get("shell", 0)),
    "WRITE_CALLS": str(summ["tools"].get("write_file", 0)), "WRITE_TOK": f"{x['write_tokens']/1e3:.0f}",
    "WRITE_SHARE": f"{x['write_tokens']/sum(r['output_tokens'] for r in ran)*100:.0f}",
    "FENCE": str(x["fence_errors"]), "SESSION_MB": f"{summ['session_bytes']/1e6/len(ran):.1f}",
    "SHRINK": "50",
    "PLAN_ONLY": str(len(extra["plan_only"])),
    "STREAM_SHARE": f"{min(99, extra['stream_bytes']/extra['session_total']*100):.0f}",
    "TOOLS_N": str(x["tools_offered"]), "TOOLS_USED": str(len(summ["tools"])),
    "SYS_TOK": str(x["first_prompt_median"]),
}
for k, v in subs.items():
    page = page.replace("{{" + k + "}}", v)
assert "{{" not in page, page[page.index("{{"):page.index("{{") + 40]
Path("/mnt/project-files/reports/tnega-terminal-bench-4/report.html").write_text(page)
print("ok", len(page))
