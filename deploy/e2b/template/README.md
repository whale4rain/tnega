# tnega box template for E2B

The box an agent works in when tnega runs on a server: a Firecracker microVM on
E2B's runtime, self-hosted or E2B's cloud ([ADR 0018](../../../docs/adr/0018-microvm-box-layer.md)).
`@tnega/machine-e2b` starts boxes from this template.

## Build

From the repository root, with an E2B API key (`E2B_API_KEY`):

```sh
pnpm try:boxes template            # E2B's cloud; add --api-url for a self-hosted runtime
```

It runs `pnpm build` and `pnpm pack` when no `tnega-*.tgz` is here yet, then
builds this Dockerfile with E2B's template build v2 (`buildBoxTemplate` in
`@tnega/machine-e2b`). The old `e2b template build` command stopped working
on 1 August 2026.

CPU and memory are fixed per template on E2B (2 CPUs and 4 GB here), so a
workspace that needs a bigger box gets its own template.

## What starts in the box

The template has no start command. E2B runs a start command once, at build
time, and every box resumes from that snapshot, so it could not carry a box's
own daemon token. Instead, each `start` of the Machine Provider runs
`start.sh` as root through E2B's command API, unless the daemon already runs.
The daemon's settings travel in that one command's environment, so the
agent's commands do not inherit the token through the box's environment.

`start.sh` runs `tnega daemon`, which dials the server with the one-time token.
For a box with the `egress` network it also writes the egress proxy's CA to
`/etc/ssl/certs` and points Node, curl, git, pip, npm and Python requests at
it, so HTTPS through the proxy verifies.

Nothing secret is built into the template. The environment's setup step
(`.tnega/environment.toml` `[setup]`) runs through the daemon at the first
start, with the approved secrets in that one command's environment only.
