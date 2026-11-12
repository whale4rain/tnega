# Running a tnega server

A tnega server is tnega on Postgres that several people sign in to from a
browser. It is the v2 server MVP of
[`docs/plans/v2-server-mvp.md`](../plans/v2-server-mvp.md) with accounts on
top: Sessions live in Postgres, saved secrets are sealed with a master key,
and everyone signs in.

## Quick start with Docker

On a Linux host with Docker and its compose plugin:

```sh
npm install -g tnega
tnega server deploy --domain tnega.example.com --email you@example.com
```

`deploy` writes a Compose project to `~/.tnega/server/deploy/`, starts it,
waits for the server, and prints a link that creates the **owner** account.
Open it, choose a login and password, and you are in.

| Service | What it is |
| --- | --- |
| `postgres` | Sessions, accounts, devices, sealed secrets |
| `server` | `tnega server start`, built from `server.Dockerfile` (tnega from npm) |
| `caddy` | HTTPS for `--domain`, with a certificate from Let's Encrypt |

Without `--domain` there is no Caddy: the server is published on
`127.0.0.1:8765` only, and you reach it over an SSH tunnel
(`ssh -L 8765:127.0.0.1:8765 host`).

`.env` next to `compose.yaml` holds the Postgres password and
`TNEGA_MASTER_KEY`. **Back it up.** Every saved secret is sealed with that key;
without it they cannot be opened. A second `deploy` keeps both.

### Hosts in mainland China

Docker Hub, Debian and npm can be slow or unreachable. Point each at a mirror:

```sh
tnega server deploy --domain tnega.example.cn \
  --mirror <registry mirror>/library \
  --apt-mirror http://mirrors.aliyun.com \
  --npm-registry https://registry.npmmirror.com
```

`--mirror` replaces the Docker Hub prefix of the `postgres`, `node` and
`caddy` images. `--package tnega-x.y.z.tgz` installs a packed tnega
(`npm pack`) instead of the npm release, for trying a build before it is
published.

## Without Docker

With your own Postgres:

```sh
tnega server init --database-url postgresql://tnega:secret@db/tnega --public-url https://tnega.example.com --trust-proxy
tnega server start
```

`init` writes `~/.tnega/server/server.env` (owner-only), creates the tables,
and prints the owner's invite link. `start` listens on `127.0.0.1:8765`.
To listen on another address it needs HTTPS in front of it: `--trust-proxy`
at init when your own reverse proxy terminates TLS, or `TNEGA_ALLOW_HTTP=1`
if you accept plain HTTP. The environment wins over `server.env`.

## People

| Role | May |
| --- | --- |
| Owner | everything, including other owners |
| Admin | run the server (models, approvals, tools, plugins, terminals, every workspace) and manage members |
| Member | work in their own folder only (`<server dir>/members/<login>`), with the sandbox on |

Add people from **Settings → Account → People** (owners and admins), or on the
server host:

```sh
tnega server invite --role member      # prints a one-time link (3 days)
tnega server user list
tnega server user add mia --role admin # asks for a password
tnega server user set mia --disable    # signs her out everywhere
tnega server user passwd mia
tnega server pair mia --daemon         # pairing code for a daemon (10 minutes)
tnega server user devices mia          # her signed-in browsers and daemons
tnega server user revoke mia <id>      # sign one of them out
```

There is always one owner who can sign in: the last one cannot be demoted or
disabled.

### What protects what

- Passwords are scrypt hashes; device tokens and codes are stored as SHA-256.
- Browsers keep the token in an `HttpOnly`, `SameSite=Strict` cookie
  (`Secure` behind HTTPS). Every API request also needs the `x-tnega-client: 1`
  header, which a page on another site cannot send: without it the answer is
  `403` before the token is looked at; with it and no token, `401`.
- Five failed sign-ins or code exchanges a minute from one address lock it out
  for five minutes.
- Members reach only the workspace routes, and only with a folder inside their
  own; a link that leads out of it is refused. They cannot turn the sandbox
  off: in their folder `bypass` acts as `workspace-write`, and a command the
  agent asks to escalate still runs in the sandbox, even once approved. Their
  Sessions belong to their account in the database.
- `tnega server start` removes `DATABASE_URL` and `TNEGA_MASTER_KEY` from its
  own environment before any agent runs, so commands do not inherit them.

## Boxes: each person's work in a sandbox of its own

With boxes on, every signed-in person's sessions run in a box of their own,
one per person and workspace: commands, files and search go to the daemon
inside it, not to the server host. Turn them on in `server.env` (or the
environment) and restart:

```sh
TNEGA_MACHINE=gvisor          # gvisor (no KVM needed), e2b, or off (default)
TNEGA_BOX_TEMPLATE=tnega-box  # built with deploy/gvisor/build-rootfs.sh
```

| Setting | Default | What it does |
| --- | --- | --- |
| `TNEGA_BOX_NETWORK` | `egress` | `egress`: out only through the egress proxy, to allowed hosts; `none`: only the server; `open`: anywhere |
| `TNEGA_BOX_ADDRESS` | first private IPv4 | where boxes reach this host: the daemon door (`TNEGA_BOX_DAEMON_PORT`, 7779) and the egress proxy (`TNEGA_EGRESS_PORT`, 7778) listen here |
| `TNEGA_BOX_MAX` | `3` | boxes running at once; a new one pauses the least recently used idle box, or waits until one is free |
| `TNEGA_BOX_IDLE_MINUTES` | `10` | a box with no run pauses after this long (memory and processes kept) |
| `TNEGA_BOX_RECLAIM_DAYS` | `7` | a box unused this long is stopped and forgotten (a gVisor box's workspace is the person's folder, which stays) |
| `TNEGA_BOX_SERVER_URL` | see below | where a box's daemon dials |

**gVisor** (as root, on the server host): the box mounts the person's own
folder as `/workspace`, so the Workbench, change tracking and skills see the
same files. Its daemon dials `ws://<box address>:7779/daemon` over its own link
to this host; the box's firewall lets it reach only that address and the
egress proxy. Do not open ports 7778 and 7779 to the internet in your cloud
firewall. Rebuild the template after upgrading tnega, so the daemon in it
matches.

gVisor boxes need `tnega server start` to run as **root**: runsc, the
network namespaces, the nftables rules and the cgroups all need it. Rootless
runsc cannot put a box behind a firewall rule on the host, so tnega does not
use it. Run the server from a root systemd unit and keep the database and the
members' folders as they are:

```ini
# /etc/systemd/system/tnega.service
[Unit]
Description=tnega server
After=network-online.target postgresql.service

[Service]
Environment=TNEGA_SERVER_DIR=/home/tnega-server/.tnega/server
ExecStart=/usr/bin/tnega server start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Root is only the server's own process. A box runs as the owner of the folder
it mounts (for example `tnega-server`, uid 1001), with no capabilities, so
what an agent writes in `/workspace` belongs to that owner, and the box cannot
write anything else of the host's. A box is its own sandbox: commands in it
run without an inner sandbox at every Session permission, and approvals still
apply as they do on the host.

**E2B**: set `E2B_API_KEY` (and `E2B_API_URL` for a self-hosted runtime).
The box dials `wss://<TNEGA_PUBLIC_URL host>/daemon`, so the server must be on
HTTPS, and `TNEGA_BOX_ADDRESS` must be the server's public IPv4 for the egress
proxy. An E2B box has its own volume: the Workbench still shows the server
folder, not the box's files.

How it fits together:

- A box's daemon signs in with a daemon token minted for that box start; the
  token is revoked when a newer one replaces it or the box is stopped, and
  the server drops a connected daemon within a minute of its device being
  revoked or its account disabled.
- `machine` rows in the database remember each box (account, workspace,
  provider handle, state) and `machine_session` which Sessions used it, so a
  restarted server finds its boxes and their daemons dial back in by
  themselves.
- No secret values reach a box: keys the egress proxy adds stay with the
  proxy, and every other remembered secret is withheld from commands.
- Not in a box yet: subagents and a coding session's MCP servers. A run in a
  box goes without them for now.

## Your own computer as a daemon

`tnega daemon` serves folders on your own computer to the server. Ask an
owner or admin for a code (`tnega server pair <login> --daemon`, valid 10
minutes), then:

```sh
tnega daemon --server wss://tnega.example.com/daemon --pair ABCD-1234 --workspace ~/code/app
```

The token it gets is kept in `~/.tnega/daemon.token` (owner-only), so later
starts need only `--server`. To cut a daemon off, `tnega server user devices
<login>` lists the devices and `tnega server user revoke <login> <id>` revokes
one; a connected daemon is dropped within a minute.

**Limits today.** Without boxes, members' agents run on the server host: the
sandbox limits what their commands write, not what they read. Invite only
people you would trust with read access to the host, or turn boxes on.
