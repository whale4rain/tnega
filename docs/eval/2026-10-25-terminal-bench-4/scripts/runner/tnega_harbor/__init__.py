"""Harbor adapter for tnega, run as an external agent.

tnega runs on the host (where the session's network access lives). Its shell
commands run inside the task container through runner/shim/bash, and its file
tools see the container's workspace because the workspace is a docker volume
that is bind-mounted at the same path inside a private mount namespace.
"""
import asyncio
import json
import os
import shlex
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.environments.docker.docker import _sanitize_docker_compose_project_name
from harbor.models.agent.context import AgentContext

RUNNER = Path("/home/user/bench/runner")


async def sh(cmd: str) -> str:
    proc = await asyncio.create_subprocess_shell(cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd} failed: {out.decode()[-2000:]}")
    return out.decode().strip()


class TnegaAgent(BaseAgent):
    capabilities = AgentCapabilities(skills=True)

    @staticmethod
    def name() -> str:
        return "tnega"

    def version(self) -> str | None:
        return os.environ.get("TNEGA_BENCH_VERSION", "0.5.3")

    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        project = _sanitize_docker_compose_project_name(environment.session_id)
        container = await sh(
            f"docker ps -q --filter label=com.docker.compose.project={project} "
            f"--filter label=com.docker.compose.service=main | head -1"
        )
        if not container:
            raise RuntimeError(f"main container for {project} not found")
        workdir = await sh(f"docker inspect -f '{{{{.Config.WorkingDir}}}}' {container}") or "/app"
        root = "/" + workdir.strip("/").split("/")[0]
        volume = await sh(
            f"docker inspect -f '{{{{range .Mounts}}}}{{{{if eq .Destination \"{root}\"}}}}{{{{.Source}}}}{{{{end}}}}{{{{end}}}}' {container}"
        )
        if not volume:
            raise RuntimeError(f"no workspace volume mounted at {root}")
        logs = Path(self.logs_dir).resolve()
        logs.mkdir(parents=True, exist_ok=True)
        (logs / "instruction.md").write_text(instruction)
        (logs / "bench-target.json").write_text(json.dumps({"container": container, "workdir": workdir, "root": root, "volume": volume}))
        home = logs / "tnega-home"
        home.mkdir(exist_ok=True)
        inner = (
            f"mkdir -p {root} && mount --bind {shlex.quote(volume)} {root} && "
            + (f"mkdir -p {home}/skills && cp -r {shlex.quote(self.skills_dir)}/. {home}/skills/ ; " if self.skills_dir else "")
            + f"cd {shlex.quote(workdir)} && "
            f"exec node {RUNNER}/run-tnega.mjs {logs}/instruction.md {logs}/session.jsonl {logs}"
        )
        env = {
            **os.environ,
            "TNEGA_BENCH_CONTAINER": container,
            "TNEGA_SHELL": str(RUNNER / "shim" / "bash"),
            "TNEGA_HOME": str(home),
            "DEEPSEEK_API_KEY": "proxy-injected",
            "NODE_USE_ENV_PROXY": "1",
            "NODE_NO_WARNINGS": "1",
        }
        with open(logs / "tnega.txt", "wb") as out:
            proc = await asyncio.create_subprocess_exec(
                "unshare", "-m", "--propagation", "private", "sh", "-c", inner,
                stdout=out, stderr=asyncio.subprocess.STDOUT, env=env,
            )
            try:
                await proc.wait()
            except asyncio.CancelledError:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), 15)
                except Exception:
                    proc.kill()
                raise
        await self._snapshot(logs, container, root, volume)
        self._populate(context)

    async def _snapshot(self, logs: Path, container: str, root: str, volume: str) -> None:
        """Keep the agent's final state as an image so a capped run can be continued later."""
        task = os.environ.get("TNEGA_BENCH_TASK")
        if os.environ.get("TNEGA_BENCH_SNAPSHOT") != "1" or not task:
            return
        try:
            stop = json.loads((logs / "bench-run.json").read_text()).get("stopReason")
        except Exception:
            stop = None
        if stop not in ("cost_cap", "wall_cap"):
            return
        tag = f"bench-snap/{task}"
        ctx = logs.parent / "snap-ctx"
        ctx.mkdir(exist_ok=True)
        try:
            # Blank out compose labels: `compose down --rmi local` removes images that carry the project label.
            labels = (await sh(f"docker inspect -f '{{{{range $k,$v := .Config.Labels}}}}{{{{$k}}}} {{{{end}}}}' {container}")).split()
            blank = " ".join(f'{k}=""' for k in labels if k.startswith("com.docker.compose."))
            await sh(f"docker commit --change {shlex.quote(f'LABEL {blank} bench.snap=1')} {container} {tag}:base")
            await sh(f"tar -cf {ctx}/ws.tar -C {shlex.quote(volume)} .")
            (ctx / "Dockerfile").write_text(f"FROM {tag}:base\nLABEL bench.snap=1\nADD ws.tar {root}/\n")
            await sh(f"docker build -q -t {tag}:1 {ctx}")
            (logs / "snapshot.json").write_text(json.dumps({"image": f"{tag}:1", "root": root}))
        except Exception as exc:
            (logs / "snapshot-error.txt").write_text(str(exc))
        finally:
            await sh(f"rm -rf {ctx}")

    def _populate(self, context: AgentContext) -> None:
        logs = Path(self.logs_dir).resolve()
        session = logs / "session.jsonl"
        if session.exists():
            n_in = n_cache = n_out = 0
            with session.open() as fh:
                for line in fh:
                    if '"assistant/message"' not in line:
                        continue
                    try:
                        usage = json.loads(line)["payload"].get("usage")
                    except Exception:
                        continue
                    if usage:
                        n_in += usage.get("promptTokens", 0)
                        n_cache += usage.get("cachedTokens", 0)
                        n_out += usage.get("completionTokens", 0)
            context.n_input_tokens = n_in
            context.n_cache_tokens = n_cache
            context.n_output_tokens = n_out
        run = logs / "bench-run.json"
        if run.exists():
            meta = json.loads(run.read_text())
            context.cost_usd = meta.get("costUsd")
            context.metadata = meta
