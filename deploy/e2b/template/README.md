# tnega box template for E2B

The box an agent works in when tnega runs on a server: a Firecracker microVM on
E2B's runtime, self-hosted or E2B's cloud ([ADR 0018](../../../docs/adr/0018-microvm-box-layer.md)).
`@tnega/machine-e2b` starts boxes from this template.

## Build

From the repository root, with the E2B CLI signed in to your runtime
(`E2B_DOMAIN` for a self-hosted one):

```sh
pnpm build
pnpm pack --pack-destination deploy/e2b/template
e2b template build -p deploy/e2b/template -d e2b.Dockerfile -n tnega-box \
  -c /usr/local/bin/tnega-box-start --cpu-count 2 --memory-mb 4096
```

CPU and memory are fixed per template on E2B, so a workspace that needs a
bigger box gets its own template.

## What starts in the box

`start.sh` runs `tnega daemon`, which dials the server with the one-time token
the Machine Provider put in the box. For a box with the `egress` network it
also writes the egress proxy's CA to `/etc/ssl/certs` and points Node, curl,
git, pip, npm and Python requests at it, so HTTPS through the proxy verifies.

Nothing secret is built into the template. The environment's setup step
(`.tnega/environment.toml` `[setup]`) runs through the daemon at the first
start, with the approved secrets in that one command's environment only.
