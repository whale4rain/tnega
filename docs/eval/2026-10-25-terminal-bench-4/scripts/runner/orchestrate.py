"""Run tnega on every Terminal-Bench 4.0 task through Harbor, a few at a time,
with a per-task cost cap and a global budget guard. Safe to re-run: finished
tasks (with a result.json) are skipped.
"""
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import threading
import time
import tomllib
from pathlib import Path

BENCH = Path("/home/user/bench")
TASKS = BENCH / "tb4" / "terminal-bench"
JOBS = Path(os.environ.get("BENCH_JOBS_DIR", str(BENCH / "jobs" / "full")))
OVERLAYS = BENCH / "overlays"
LOG = Path(os.environ.get("BENCH_LOG", str(BENCH / "orchestrate.log")))
BUDGET = float(os.environ.get("BENCH_BUDGET_USD", "5.6"))
CAP = float(os.environ.get("BENCH_TASK_CAP_USD", "0.09"))
WALL_MIN = os.environ.get("BENCH_WALL_MIN", "60")
CONCURRENCY = int(os.environ.get("BENCH_CONCURRENCY", "3"))

lock = threading.Lock()


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    try:
        with lock, LOG.open("a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    print(line, flush=True)


pull_lock = threading.Lock()
MIN_FREE = 16 * 1024**3


def wait_for_disk(task: str) -> None:
    import shutil
    waited = 0
    while shutil.disk_usage("/").free < MIN_FREE and waited < 3 * 3600:
        if waited % 600 == 0:
            log(f"DISK wait {task}: free={shutil.disk_usage('/').free/1e9:.1f}GB")
        subprocess.run(["docker", "image", "prune", "-af", "--filter", "label!=bench.snap"], capture_output=True)
        time.sleep(30)
        waited += 30


def spent() -> float:
    total = 0.0
    for f in JOBS.glob("*/*/agent/bench-run.json"):
        try:
            total += json.loads(f.read_text()).get("costUsd", 0)
        except Exception:
            pass
    return total


def running_reserve(active: int) -> float:
    return active * CAP


def done(task: str) -> bool:
    if not (JOBS / task / "result.json").exists():
        return False
    if any((JOBS / task).glob("*/agent/session.jsonl")):
        return True
    import shutil
    shutil.rmtree(JOBS / task)
    return False


def images_of(task_dir: Path) -> list[str]:
    cfg = tomllib.loads((task_dir / "task.toml").read_text())
    imgs = [cfg["environment"].get("docker_image")]
    imgs.append(((cfg.get("verifier") or {}).get("environment") or {}).get("docker_image"))
    compose = task_dir / "environment" / "docker-compose.yaml"
    if compose.exists():
        for line in compose.read_text().splitlines():
            if line.strip().startswith("image:"):
                imgs.append(line.split("image:", 1)[1].strip())
    return [i for i in imgs if i]


RESUME_DIR = os.environ.get("BENCH_RESUME_DIR")


def resume_source(task: str):
    """Session and snapshot image of the previous capped attempt, if continuing."""
    if not RESUME_DIR:
        return None
    for snap in Path(RESUME_DIR).glob(f"{task}/*/agent/snapshot.json"):
        return snap.parent / "session.jsonl", json.loads(snap.read_text())["image"]
    return None


def patched_task(task: str, image: str) -> Path:
    import shutil
    dst = BENCH / "cont-tasks" / task
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(TASKS / task, dst)
    toml = dst / "task.toml"
    cfg = toml.read_text()
    old = tomllib.loads(cfg)["environment"]["docker_image"]
    toml.write_text(cfg.replace(f'"{old}"', f'"{image}"', 1))
    return dst


def run_task(task: str, cap: float, retry: bool = False) -> None:
    task_dir = TASKS / task
    src = resume_source(task)
    if src:
        task_dir = patched_task(task, src[1])
    cfg = tomllib.loads((task_dir / "task.toml").read_text())
    env_image = cfg["environment"]["docker_image"]
    gpus = cfg["environment"].get("gpus", 0)
    t0 = time.time()
    with pull_lock:
      wait_for_disk(task)
      for img in images_of(task_dir):
        if img.startswith("bench-snap/"):
            continue
        for attempt in range(4):
            r = subprocess.run(["docker", "pull", "-q", img], capture_output=True, text=True, timeout=3600)
            if r.returncode == 0:
                break
            log(f"PULL retry {task} {img[:60]}: {r.stderr.strip()[-200:]}")
            time.sleep(60 * (attempt + 1))
    workdir = subprocess.run(
        ["docker", "image", "inspect", "-f", "{{.Config.WorkingDir}}", env_image],
        capture_output=True, text=True,
    ).stdout.strip() or "/app"
    overlay = OVERLAYS / f"{task}.yaml"
    subprocess.run([str(BENCH / "hv/bin/python"), str(BENCH / "runner/overlay.py"), workdir, str(overlay)], check=True, capture_output=True)
    cmd = [
        str(BENCH / "hv/bin/harbor"), "run", "-p", str(task_dir),
        "-a", "tnega_harbor:TnegaAgent", "-m", "deepseek/deepseek-v4-flash",
        "--extra-docker-compose", str(overlay), "-o", str(JOBS), "--job-name", task,
        "-n", "1", "-y", "-q",
    ]
    if gpus:
        cmd += ["--override-gpus", "0"]
    if cfg["environment"].get("cpus", 1) > 4 or ((cfg.get("verifier") or {}).get("environment") or {}).get("cpus", 1) > 4:
        cmd += ["--override-cpus", "4"]
    if cfg["environment"].get("memory_mb", 0) > 12288:
        cmd += ["--override-memory-mb", "12288"]
    env = {
        **os.environ,
        "PYTHONPATH": str(BENCH / "runner"),
        "TNEGA_BENCH_CAP_USD": f"{cap:.4f}",
        "TNEGA_BENCH_WALL_MIN": WALL_MIN,
        "TNEGA_BENCH_TASK": task,
        "TNEGA_BENCH_SNAPSHOT": os.environ.get("BENCH_SNAPSHOT", "0"),
        **({"TNEGA_BENCH_RESUME_FROM": str(src[0])} if src else {}),
    }
    log(f"START {task} cap=${cap:.3f} workdir={workdir} gpus={gpus} pull={time.time()-t0:.0f}s")
    out = BENCH / "harbor-logs"
    out.mkdir(exist_ok=True)
    with (out / f"{task}.log").open("w") as fh:
        proc = subprocess.run(cmd, stdout=fh, stderr=subprocess.STDOUT, env=env, timeout=4 * 3600)
    reward = None
    for r in (JOBS / task).glob("*/verifier/reward.txt"):
        reward = r.read_text().strip()
    trial = next((JOBS / task).glob("*/"), None)
    if trial and not (trial / "agent" / "session.jsonl").exists() and (trial / "exception.txt").exists() and not retry:
        log(f"RETRY {task}: no agent session, harbor exception")
        import shutil
        shutil.rmtree(JOBS / task)
        return run_task(task, cap, retry=True)
    log(f"END   {task} rc={proc.returncode} reward={reward} took={time.time()-t0:.0f}s spent=${spent():.3f}")
    for img in images_of(task_dir):
        if not img.startswith("bench-snap/"):
            subprocess.run(["docker", "rmi", "-f", img], capture_output=True)
    subprocess.run(["docker", "volume", "prune", "-f"], capture_output=True)


def main() -> None:
    JOBS.mkdir(parents=True, exist_ok=True)
    OVERLAYS.mkdir(exist_ok=True)
    tasks = sorted(p.name for p in TASKS.iterdir() if (p / "task.toml").exists())
    if len(sys.argv) > 1:
        tasks = [t for t in tasks if t in sys.argv[1:]]
    if RESUME_DIR:
        tasks = [t for t in tasks if resume_source(t)]
    gpu = [t for t in tasks if tomllib.loads((TASKS / t / "task.toml").read_text())["environment"].get("gpus", 0)]
    if gpu and os.environ.get("BENCH_SKIP_GPU", "1") == "1":
        log(f"SKIP gpu tasks (no GPU here, images exceed sandbox disk): {gpu}")
        tasks = [t for t in tasks if t not in gpu]
    todo = [t for t in tasks if not done(t)]
    log(f"tasks={len(tasks)} todo={len(todo)} spent=${spent():.3f} budget=${BUDGET}")
    active: set[str] = set()
    with cf.ThreadPoolExecutor(CONCURRENCY) as pool:
        futures = {}
        queue = list(todo)
        while queue or futures:
            while queue and len(futures) < CONCURRENCY:
                remaining = BUDGET - spent() - running_reserve(len(futures))
                if remaining < 0.02:
                    log(f"BUDGET stop: spent=${spent():.3f}, {len(queue)} tasks not started")
                    queue.clear()
                    break
                task = queue.pop(0)
                cap = min(CAP, remaining)
                futures[pool.submit(run_task, task, cap)] = task
            if not futures:
                break
            finished, _ = cf.wait(futures, return_when=cf.FIRST_COMPLETED)
            for f in finished:
                task = futures.pop(f)
                if f.exception():
                    log(f"ERROR {task}: {f.exception()!r}")
    log(f"ALL DONE spent=${spent():.3f}")


if __name__ == "__main__":
    main()
