# Tnega desktop

The desktop client is an Electron host for the local Tnega console. It uses the
same React UI, Session data, Workspace history, and System Config as `tnega web`.

## Development

```bash
pnpm --filter @tnega/desktop dev
```

The command first builds the CLI runtime and Web UI, then launches Electron.

## Packaging

```bash
pnpm --filter @tnega/desktop package
```

`electron-builder` is configured for Windows NSIS, macOS DMG, and Linux AppImage.
For a quick Windows artifact validation without an installer, run:

```bash
pnpm --filter @tnega/desktop exec electron-builder --dir
```

## Security boundary

Electron runs the Web UI with context isolation, sandboxing, and Node integration
disabled. The preload bridge only provides native folder selection, revealing a
Workspace, and the app version. The Agent Runtime stays behind the existing
loopback HTTP/SSE API. It continues to enforce Workspace path boundaries and
requires users to choose network and Shell Tool Permissions for every Agent Run.
