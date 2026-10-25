"""Rebuild per-task and aggregate stats for the tnega Terminal-Bench 4.0 run
from the durable tnega session logs plus Harbor's verifier output.
Writes results/tasks.json, results/tasks.csv and results/summary.json.
"""
import collections
import csv
import json
import statistics
import tomllib
from pathlib import Path

BENCH = Path("/home/user/bench")
import os
JOBS = Path(os.environ.get("BENCH_JOBS_DIR", str(BENCH / "jobs" / "full")))
PREFIX = os.environ.get("BENCH_PREFIX", "")
TASKS = BENCH / "tb4" / "terminal-bench"
OUT = BENCH / "results"


# Grading fixes found after the run (see report "How this was run").
OVERRIDES = {
    # verifier could not install its pinned deps (no proxy CA in the verifier image); regraded with the CA baked in
    "vba-userform-port": {"reward": 0.0, "grade_note": "regraded with CA in verifier image"},
    # same problem; the regrade still could not install deps, so no valid grade
    "payments-pipeline-fix": {"reward": None, "grade_note": "verifier could not install its dependencies"},
}


def rates(ts_ms: int) -> tuple[float, float, float]:
    import datetime as dt
    d = dt.datetime.fromtimestamp(ts_ms / 1000, dt.timezone.utc)
    peak = d.weekday() < 5 and (1 <= d.hour < 4 or 6 <= d.hour < 10)
    m = 2 if peak else 1
    return 0.15 * m, 0.003 * m, 0.6 * m


def analyze_session(path: Path) -> dict:
    s = collections.Counter()
    tools = collections.Counter()
    tool_err = collections.Counter()
    bytes_by_type = collections.Counter()
    prompt_sizes = []
    llm_ms = tool_ms = 0
    shell_nonzero = shell_timeouts = 0
    first_ts = last_ts = None
    finish = None
    turn_end_reason = None
    cost = {"miss": 0.0, "hit": 0.0, "out": 0.0}
    for line in path.open():
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        bytes_by_type[t] += len(line)
        ts = e.get("ts")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts
        p = e.get("payload") or {}
        if t == "assistant/message":
            u = p.get("usage") or {}
            pt, ct, ot = u.get("promptTokens", 0), u.get("cachedTokens", 0), u.get("completionTokens", 0)
            s["calls"] += 1
            s["prompt"] += pt
            s["cached"] += ct
            s["output"] += ot
            s["reasoning"] += u.get("reasoningTokens", 0)
            prompt_sizes.append(pt)
            llm_ms += p.get("durationMs") or 0
            miss, hit, out = rates(ts or 0)
            cost["miss"] += (pt - ct) * miss / 1e6
            cost["hit"] += ct * hit / 1e6
            cost["out"] += ot * out / 1e6
            if not p.get("toolCalls"):
                s["text_only"] += 1
        elif t == "tool/call":
            tools[p.get("name")] += 1
        elif t == "tool/result":
            name = p.get("name")
            tool_ms += p.get("durationMs") or 0
            if p.get("ok") is False:
                tool_err[name] += 1
            out = p.get("output")
            if name == "shell" and isinstance(out, dict):
                if out.get("exitCode") not in (0, None):
                    shell_nonzero += 1
                if out.get("timedOut") or "timed out" in json.dumps(out)[:400].lower():
                    shell_timeouts += 1
        elif t == "step/end":
            s["steps"] += 1
        elif t == "turn/end":
            finish = p.get("finishReason")
            turn_end_reason = (p.get("reason") or {}).get("kind")
        elif t and "compact" in t:
            s["compactions"] += 1
    return {
        "llm_calls": s["calls"],
        "steps": s["steps"],
        "prompt_tokens": s["prompt"],
        "cached_tokens": s["cached"],
        "uncached_tokens": s["prompt"] - s["cached"],
        "output_tokens": s["output"],
        "reasoning_tokens": s["reasoning"],
        "total_tokens": s["prompt"] + s["output"],
        "cache_hit_rate": s["cached"] / s["prompt"] if s["prompt"] else 0,
        "peak_context": max(prompt_sizes) if prompt_sizes else 0,
        "mean_context": statistics.mean(prompt_sizes) if prompt_sizes else 0,
        "cost_usd": sum(cost.values()),
        "cost_parts": cost,
        "llm_seconds": llm_ms / 1000,
        "tool_seconds": tool_ms / 1000,
        "session_seconds": ((last_ts - first_ts) / 1000) if first_ts else 0,
        "tool_calls": dict(tools),
        "tool_errors": dict(tool_err),
        "n_tool_calls": sum(tools.values()),
        "shell_nonzero": shell_nonzero,
        "shell_timeouts": shell_timeouts,
        "text_only_replies": s["text_only"],
        "compactions": s["compactions"],
        "finish": finish,
        "turn_end": turn_end_reason,
        "session_bytes": path.stat().st_size,
        "bytes_by_type": dict(bytes_by_type),
    }


def main() -> None:
    OUT.mkdir(exist_ok=True)
    rows = []
    for task_dir in sorted(p for p in TASKS.iterdir() if (p / "task.toml").exists()):
        cfg = tomllib.loads((task_dir / "task.toml").read_text())
        meta = cfg.get("metadata", {})
        row = {
            "task": task_dir.name,
            "category": meta.get("category"),
            "subcategory": meta.get("subcategory"),
            "expert_hours": meta.get("expert_time_estimate_hours"),
            "gpus": cfg.get("environment", {}).get("gpus", 0),
            "has_sidecars": (task_dir / "environment" / "docker-compose.yaml").exists(),
            "status": "not_run",
            "reward": None,
        }
        trial = next((JOBS / task_dir.name).glob("*/result.json"), None) if (JOBS / task_dir.name).exists() else None
        if trial:
            tdir = trial.parent
            row["trial_dir"] = str(tdir.relative_to(BENCH))
            reward_file = tdir / "verifier" / "reward.txt"
            reward_json = tdir / "verifier" / "reward.json"
            if not reward_file.exists() and reward_json.exists():
                try:
                    row["reward"] = float(json.loads(reward_json.read_text()).get("reward"))
                except Exception:
                    pass
            if reward_file.exists():
                try:
                    row["reward"] = float(reward_file.read_text().strip())
                except ValueError:
                    pass
            row["exception"] = (tdir / "exception.txt").read_text().strip().splitlines()[-1][:300] if (tdir / "exception.txt").exists() else None
            run = tdir / "agent" / "bench-run.json"
            if run.exists():
                r = json.loads(run.read_text())
                row["stop_reason"] = r.get("stopReason") or ("exit_" + str(r.get("exitCode")) if r.get("exitCode") else "finished")
                row["wall_seconds"] = r.get("wallMs", 0) / 1000
                row["cap_usd"] = r.get("capUsd")
            sess = tdir / "agent" / "session.jsonl"
            if sess.exists():
                row.update(analyze_session(sess))
            txt = tdir / "agent" / "tnega.txt"
            if txt.exists():
                tail = txt.read_text(errors="replace").strip().splitlines()[-3:]
                row["cli_tail"] = " | ".join(tail)[:300]
            override = OVERRIDES.get(task_dir.name)
            if override and JOBS.name == "full":
                row.update(override)
            row["status"] = "passed" if row["reward"] == 1 else ("failed" if row["reward"] is not None else "error")
        rows.append(row)
    (OUT / f"{PREFIX}tasks.json").write_text(json.dumps(rows, indent=1))
    keys = ["task", "category", "status", "reward", "stop_reason", "cost_usd", "llm_calls", "steps", "n_tool_calls",
            "prompt_tokens", "cached_tokens", "output_tokens", "reasoning_tokens", "peak_context", "wall_seconds",
            "llm_seconds", "tool_seconds", "shell_nonzero", "gpus", "has_sidecars", "exception"]
    with (OUT / f"{PREFIX}tasks.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    ran = [r for r in rows if r["status"] != "not_run"]
    passed = [r for r in rows if r["status"] == "passed"]
    tools = collections.Counter()
    for r in ran:
        tools.update(r.get("tool_calls", {}))
    stop = collections.Counter(r.get("stop_reason") for r in ran)
    by_cat = collections.defaultdict(lambda: [0, 0])
    for r in ran:
        by_cat[r["category"]][1] += 1
        by_cat[r["category"]][0] += r["status"] == "passed"

    def tot(k):
        return sum(r.get(k, 0) or 0 for r in ran)

    summary = {
        "n_tasks": len(rows),
        "n_run": len(ran),
        "n_passed": len(passed),
        "pass_at_1": len(passed) / len(rows),
        "pass_at_1_ran": len(passed) / len(ran) if ran else 0,
        "errors": [r["task"] for r in rows if r["status"] == "error"],
        "passed_tasks": [r["task"] for r in passed],
        "total_cost_usd": tot("cost_usd"),
        "cost_parts": {k: sum((r.get("cost_parts") or {}).get(k, 0) for r in ran) for k in ("miss", "hit", "out")},
        "total_prompt_tokens": tot("prompt_tokens"),
        "total_cached_tokens": tot("cached_tokens"),
        "total_output_tokens": tot("output_tokens"),
        "total_reasoning_tokens": tot("reasoning_tokens"),
        "total_llm_calls": tot("llm_calls"),
        "total_tool_calls": tot("n_tool_calls"),
        "total_wall_hours": tot("wall_seconds") / 3600,
        "llm_seconds": tot("llm_seconds"),
        "tool_seconds": tot("tool_seconds"),
        "stop_reasons": dict(stop),
        "tools": dict(tools.most_common()),
        "by_category": {k: {"passed": v[0], "ran": v[1]} for k, v in sorted(by_cat.items(), key=lambda x: str(x[0]))},
        "session_bytes": tot("session_bytes"),
        "bytes_by_type": dict(sum((collections.Counter(r.get("bytes_by_type", {})) for r in ran), collections.Counter())),
        "median_cost": statistics.median([r.get("cost_usd", 0) for r in ran]) if ran else 0,
        "median_calls": statistics.median([r.get("llm_calls", 0) for r in ran]) if ran else 0,
        "median_wall_min": statistics.median([r.get("wall_seconds", 0) / 60 for r in ran]) if ran else 0,
        "shell_nonzero": tot("shell_nonzero"),
    }
    (OUT / f"{PREFIX}summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k not in ("bytes_by_type", "tools")}, indent=1))


if __name__ == "__main__":
    main()
