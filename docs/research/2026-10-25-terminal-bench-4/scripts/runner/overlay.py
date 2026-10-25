"""Write the docker compose overlay for one task.

The main container's top-level workspace directory becomes a named docker
volume (docker fills it from the image on first use) so the host-side agent can
see the same files, and the session CA bundle is mounted read-only so package
installs to allowed hosts verify. Networking is left exactly as the task set it.
argv: image_workdir out_path
"""
import sys
from pathlib import Path

import yaml


def write_overlay(workdir: str, out: Path) -> str:
    root = "/" + (workdir.strip("/").split("/")[0] or "app")
    data = {
        "services": {
            "main": {
                "volumes": [
                    f"benchws:{root}",
                    "/home/user/bench/agentroot/ca.crt:/opt/bench-ca.crt:ro",
                ]
            }
        },
        "volumes": {"benchws": {}},
    }
    out.write_text(yaml.safe_dump(data, sort_keys=False))
    return root


if __name__ == "__main__":
    print(write_overlay(sys.argv[1], Path(sys.argv[2])))
