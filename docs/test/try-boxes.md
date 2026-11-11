# Try the v2 box layer by hand

> Status: a hand test for milestone 2 (`packages/machine/*`, `deploy/e2b/template`).
> What it cannot show yet: an agent working in a box. That needs the server
> (milestone 3), which accepts the daemon's connection and routes a session to a box.

Everything runs from the repository root with `pnpm try:boxes <part>`
(`scripts/try-boxes.ts`). The parts are independent; do them in order of effort.

| Part | Needs | Shows |
|---|---|---|
| 0. Unit tests | Node 22, pnpm | every package's behaviour against fakes |
| 1. `proxy` | curl | the egress proxy: allow-list, blocked hosts, keys added only for a box that trusts the proxy's CA |
| 2. `setup` | nothing | `.tnega/environment.toml` parsing, the approval hash, the setup step with secrets hidden |
| 3. `template` | E2B account and API key | the box template builds on E2B |
| 4. `box` | the template from 3 | a real microVM: start, daemon started inside, pause, resume, refusal of a changed environment, stop |

Windows works for every part: use `curl.exe` in PowerShell, and set variables
with `$env:E2B_API_KEY = "..."`. Parts 3 and 4 run on E2B's cloud, so your
computer needs no KVM. Self-hosting E2B's runtime needs a Linux host with KVM
(bare metal or a VM with nested virtualisation) and is not covered here.

## 0. Unit tests

```sh
pnpm install
npx vitest run packages/machine
```

Expect all tests to pass (52 at the time of writing).

## 1. Egress proxy

```sh
pnpm try:boxes proxy
```

It starts the proxy on `127.0.0.1:8899` with one box token (`try-agent`)
whose policy allows `example.com` and adds a header for `httpbin.org`, writes
the proxy's CA to `.tnega-try/egress-ca.pem`, and prints five curl commands.
Run them in another terminal; the proxy logs each decision.

| Command | Expect |
|---|---|
| `https://example.com` with the token | `200`, real certificate |
| `https://github.com` with the token | `CONNECT tunnel failed, response 403` |
| `https://httpbin.org/headers` with the token and `--cacert` | JSON with `"X-Tnega-Try": "added-by-the-egress-proxy"` |
| the same without `--cacert` | certificate error |
| `https://example.com` without a token | `403` |

The third row is how a box gets an API key without ever holding it: the
proxy opens the TLS for hosts with a key and adds the header on the way out.

## 2. Environment file and setup

```sh
pnpm try:boxes setup              # a built-in sample file
pnpm try:boxes setup path/to/repo # your repo's .tnega/environment.toml
```

It prints the parsed file and its approval hash, then runs `[setup]` on your
computer (in a box it runs through the daemon). Secrets named in
`setup.secrets` come from your environment, or a made-up value when unset.

Look for: the script's output shows `[secret]` where the secret's value was.
Change the setup script, a secret, a host or the template, and the approval
hash changes; change only `[resources]` or `[idle]`, and it stays the same.
A broken file is refused with the line that is wrong.

## 3. Build the box template on E2B

1. Make an account at e2b.dev and copy an API key from the dashboard.
2. Build:

   ```sh
   E2B_API_KEY=e2b_... pnpm try:boxes template
   ```

   The first run builds and packs tnega (`pnpm build`, `pnpm pack`) into
   `deploy/e2b/template/`, then E2B builds the image. Expect several minutes
   and a final line naming the template (`tnega-box`). To rebuild after a code
   change, delete `deploy/e2b/template/tnega-*.tgz` first.

## 4. A real box

```sh
E2B_API_KEY=e2b_... pnpm try:boxes box --template tnega-box
```

Each step prints its result and how long it took:

| Step | Expect |
|---|---|
| start a new box and its daemon | a sandbox id; a few seconds |
| status | `running` |
| start again | the same id: a second start finds the box |
| pause, status | `paused` |
| start again (resumes it) | the same id, `running`; usually faster than the first start |
| start with a changed environment | `refused with MACHINE_SPEC_CHANGED` |
| stop, status | `missing` |

Add `--keep` to leave the box running and look inside with the E2B CLI
(`npm i -g @e2b/cli`, then `e2b auth login`):

```sh
e2b sandbox connect <sandbox id>
ps aux | grep "tnega daemon"     # one daemon, as root
tail /var/log/tnega-daemon.log   # it keeps retrying: there is no server yet
env | grep TNEGA                 # empty: the token is not in the box's environment
curl -m 5 https://example.com    # fails: no DNS in a box without network
curl -m 5 http://1.1.1.1         # fails: the firewall allows only the server's address
exit
e2b sandbox kill <sandbox id>
```

The host-layer test does steps 4's start, pause, resume and stop without the
printout:

```sh
TNEGA_E2B_API_URL=https://api.e2b.app TNEGA_E2B_API_KEY=e2b_... TNEGA_E2B_TEMPLATE=tnega-box \
  npx vitest run --config vitest.host.config.ts packages/machine/machine-e2b
```

## 5. A gVisor box (a host without KVM)

On a Linux host without `/dev/kvm` (a cloud VM with no nested
virtualization), boxes run in gVisor instead (issue #85). As root:

```sh
# gVisor: copy runsc and the whole gvisor-bin/ directory, not runsc alone
tar -xjf gvisor.tar.bz2 && cp -r runsc gvisor-bin /usr/local/bin/
apt install debootstrap iproute2 nftables
npm pack                                   # tnega-<version>.tgz
UBUNTU_MIRROR=http://mirrors.aliyun.com/ubuntu NODE_MIRROR=https://npmmirror.com/mirrors/node \
  deploy/gvisor/build-rootfs.sh tnega-*.tgz  # mirrors only where the defaults are slow
pnpm try:boxes gvisor                      # host check, then start, pause, resume, stop
pnpm try:boxes gvisor --keep               # leave it running and look inside
```

The first lines say whether `/dev/kvm` exists and what is missing for gVisor;
nothing starts until all of it is there. A box's own output goes nowhere (a pipe would
kill it once the caller exits); when a start fails, the error quotes runsc's
log, `/var/lib/tnega/machines/boxes/<id>/runsc.log`. A `microvm` box must be refused with
`SANDBOX_UNAVAILABLE`. The host-layer test runs the same checks plus "the
host's `/home` is not in the box" and "a direct connection fails":

```sh
TNEGA_GVISOR_TEMPLATE=tnega-box npx vitest run --config vitest.host.config.ts packages/machine/machine-gvisor
```

## 6. Boxes behind the server (milestone 3)

The pool, the daemon door and a real gVisor box together, as root, with the
template built from this branch (`npm pack` first, so the daemon in the box
knows `TNEGA_DAEMON_ALLOW_WS`):

```sh
TNEGA_GVISOR_TEMPLATE=tnega-box npx vitest run --config vitest.host.config.ts packages/runtime/test/boxes.e2e.test.ts
```

It checks, in order: `uname -a` says gVisor, `/home` is empty, the hostname
is `tnega-box`, no `DEEPSEEK_API_KEY` / master key / database URL / daemon
token in the box's environment, a file in the box's `/tmp` is not on the host,
a file in `/workspace` is in the server folder; a direct connection to
`1.1.1.1` fails, `example.com` works through the proxy and another host is
refused; after the server scope is disposed and opened again, the same box's
daemon dials back with the same device; after a pause, a background `sleep`
is still running. It prints how long the start and the resume took. Set
`TNEGA_BOX_ADDRESS` when the host's first private IPv4 is not the one to use,
and `TNEGA_BOX_TEST_UID=1001` to give the member folder to a non-root owner
(the box must then run as that uid and still write `/workspace`).

Then the whole server, by hand:

```sh
TNEGA_MACHINE=gvisor TNEGA_BOX_TEMPLATE=tnega-box tnega server start
```

Sign in as the owner, open a session in a member's folder (or the owner's), and
ask the agent to run `uname -a`, `ls /home` and `env`. Stop the server with
Ctrl+C and start it again: the next message in the same session continues in
the same box.

## Not testable yet

- A box with the `egress` network on E2B's cloud: the box must reach the
  egress proxy at a public IPv4 address, so the proxy has to run on a server,
  not behind a home router.
- Subagents and MCP servers in a box.
