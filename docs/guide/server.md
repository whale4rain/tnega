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
```

There is always one owner who can sign in: the last one cannot be demoted or
disabled.

### What protects what

- Passwords are scrypt hashes; device tokens and codes are stored as SHA-256.
- Browsers keep the token in an `HttpOnly`, `SameSite=Strict` cookie
  (`Secure` behind HTTPS). Every API request also needs the `x-tnega-client`
  header, which a page on another site cannot send.
- Five failed sign-ins or code exchanges a minute from one address lock it out
  for five minutes.
- Members reach only the workspace routes, and only with a folder inside their
  own; a link that leads out of it is refused. They cannot turn the sandbox
  off. Their Sessions belong to their account in the database.
- `tnega server start` removes `DATABASE_URL` and `TNEGA_MASTER_KEY` from its
  own environment before any agent runs, so commands do not inherit them.

**Limits today.** Members' agents run on the server host: the sandbox limits
what their commands write, not what they read. Until each member's work runs in
a box of its own (`@tnega/machine-e2b`, or `@tnega/machine-gvisor` where there
is no KVM), invite only people you would trust with read access to the host.
The daemon connection (`tnega daemon --server`) is not served by
`tnega server start` yet; `pair --daemon` codes are for when it is.
