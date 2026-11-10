# Accounts

Sign-in for a tnega server: people, the devices they signed in from, and the
codes that let a new person or device in (`docs/plans/v2-server-mvp.md` §4.6).
Local mode mounts none of it. How to run a server: [`docs/guide/server.md`](../../docs/guide/server.md).

```
@tnega/accounts-pg (Provider) ──→ @tnega/accounts (ctx.accounts) ←── @tnega/accounts-routes (Consumer: HTTP)
                                                                 ←── tnega server (CLI: init, user, invite, pair)
```

- `@tnega/accounts` — the Definition: `AccountService`, roles (`owner`, `admin`,
  `member`), `mayManage` (who may change whom), code and login formats.
- `@tnega/accounts-pg` — the Postgres Provider. Adds a login, role and scrypt
  password hash to the plan's `account` row; `device` is the plan's table;
  codes are single-use rows in `auth_code`; every change goes to `audit`.
- `@tnega/accounts-routes` — `/api/auth/*` and the request guard: no token,
  401; owners and admins pass; members only reach workspace routes inside
  `<membersRoot>/<login>` and may not turn the sandbox off (it sets the
  request's `sandboxRequired`); daemon tokens are refused on this API.

The host does not import these: `packages/runtime`'s `accountsCapability`
mounts them when `tnega server start` asks, and the guard hooks into the web
server's generic `registerGuard`.
