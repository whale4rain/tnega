# File plugin configuration

Goal: Load external plugins and their configuration from existing JSON/YAML profiles.

Reference: DSH vendor/loader/src/config/entry.ts and vendor/loader/src/index.ts.
Keep module resolution in the CLI composition layer and registration owned by Fibers.
Keep existing programmatic Plugin[] interfaces and built-in profile names compatible.
No Lua, file watcher, automatic installation, or module cache invalidation.

- Add failing behavior tests for local modules, package resolution, configuration,
  disabled entries, invalid exports, and lifecycle cleanup.
- Normalize serializable module references, resolve from the profile directory,
  import and validate exports, and adapt configured plugins to existing bundles.
- Document external package usage and trusted host-code execution.
- Run focused tests, typecheck, build/package checks; inspect and commit only this work.

Completed: configuration loading, ESM package resolution, parameters/disabled entries,
and cleanup on plugin or later PTC startup failure. Final relevant and publication
suite: 37 passing tests, including a native Node external Service plugin check.
