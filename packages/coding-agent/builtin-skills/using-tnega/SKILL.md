---
name: using-tnega
description: Use when a user asks about Tnega Sessions, Workspace boundaries, permissions, Browser or code mode, skills, MCP, or desktop update channels.
---

# Using Tnega

Follow the user's instructions and Workspace rules. A skill grants no additional permissions; use the current tool catalog.

## Sessions and permissions

A Session belongs to a Workspace and persists its history. An Agent Run is triggered by a user message. A Fork copies history into an independent Session. Default logs live under `~/.tnega/sessions/<workspace hash>`; `TNEGA_HOME` overrides the home directory. An explicit CLI Session file can use another path. Deliverables stay in the Workspace.

Session permissions are `read-only`, `workspace-write`, and `bypass`. Public network reading can be allowed in read-only mode. Writes, shell execution, outside paths, and external actions follow their guards and approvals. Tool availability and permission are separate. An unavailable sandbox fails closed; bypass explicitly disables that sandbox.

## Browser and code mode

The Agent Browser appears in the workbench Browser tool. Use exposed `browser_*` tools; obtain a fresh `browser_snapshot` and use its element refs for interaction. It controls a page, not the entire desktop.

When code mode exposes `run_code`, scripts call `await tools[name](input)` and inspect `ALL_TOOLS` for schemas. Tool output is returned directly. The QuickJS runtime has no Node.js imports, direct files, network, or subprocesses; child calls retain tool permissions. Its `store` and `load` last only within one execution. Check existing effects before retrying a partly completed script.

## Skills, MCP, and updates

Use `skills_list` and `skill_read`, or coding Session `/skills`, to discover effective instructions. Built-ins are bundled offline and installed into Tnega home's `skills` directory on desktop/Web startup or first default CLI use. Existing user files are preserved; upgrading the application adds missing skills but does not replace installed instructions. Workspace `.tnega/skills/<name>/SKILL.md` overrides the same name in global `~/.tnega/skills` (or `TNEGA_HOME/skills`). Workspace MCP uses `.tnega/mcp.json` with `mcpServers`; entries specify `command` and optional `args`, `env`, and `cwd`. Connected stdio tools are named `mcp__<server>__<tool>`.

Packaged desktop Settings offers Stable or Preview (pre), Check for updates, and Restart to update. Stable is the default; Preview includes beta releases. Switching back waits for a newer stable version without downgrading. Development builds cannot self-update. CLI installation and browser-only Web usage do not use the desktop update control.
