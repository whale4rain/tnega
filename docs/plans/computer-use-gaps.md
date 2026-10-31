# Computer use: remaining gaps

Implementation spec for whoever picks this up. Written against the tree at commit
`5c7f383` (computer use shipped, Files API + Responses chaining landed). Driver is
`cua-driver` 0.38.0, Windows x64, installed locally at
`.tnega/cua-driver/bin/cua-driver.exe` (git-ignored).

Three buckets, in priority order: **A. element pathway**, **B. action coverage**,
**C. cost and observability**. Each section states current behaviour, what the driver
already offers, the change, and the checks that prove it.

---

## Current shape (read this first)

| Layer | File | What it owns |
| --- | --- | --- |
| Service Definition | `packages/computer/computer/src/index.ts` | `ComputerService` abstract class, `ctx.computer`, `act()` dispatch |
| Vocabulary | `packages/computer/computer/src/types.ts` | `ComputerAction`, `ComputerWindow`, `ComputerScreenshot`, `ComputerRegion`, `ComputerActionResult`, `ComputerCallOptions`, error codes |
| Provider | `packages/computer/computer-cua/src/index.ts` | `CuaComputer`; `driverCall()` maps actions to driver tools |
| Driver link | `packages/computer/computer-cua/src/driver.ts` | MCP stdio to `cua-driver mcp`, `readResult()` |
| Consumer (tools) | `packages/computer/tool-computer/src/index.ts` | the model-visible `computer_*` tools |
| Composition | `packages/runtime/src/compose.ts` | `computerCapability` mounts provider + consumer |
| Decision record | `docs/adr/0016-computer-use.md` | rationale, measured numbers, known limits |

Contract that must not regress:

- Every action goes through `act()`, which resolves the target window, fires
  `computer/pre-action` (waterfall: may rewrite or `deny`, may not move to another
  window) and then `computer/action` for every outcome. Providers only implement
  `runAction`, so they cannot bypass policy or audit.
- Observation (`windows` / `screenshot` / `zoom`) sends no input.
- Points are pixels of the window's latest screenshot; conversion is the driver's job.
- Fail closed: no driver means `COMPUTER_UNAVAILABLE`, never a silent fallback.
- Input delivery: background first; retry in front only when the driver *refuses*
  (`background_unavailable`). An `effect: unverifiable` result is never resent.

---

## A. Element pathway (highest value)

### Why it is the top gap

`CuaComputer.capture()` hardcodes `include_accessibility_tree: false`, and every tool
takes only `window_id` + `x, y`. So the agent is permanently stuck on the pixel rung,
which the driver itself calls "lands blindly". The element rung is the only one the
driver can verify (`effect: confirmed`), it removes coordinate guessing (this repo
already burned a day on a mis-diagnosed "DPI offset" that was really thumbnail-space
estimate error), and it is a prerequisite for text-only models (see A.4).

### What the driver already provides (verified with `cua-driver describe`)

`get_window_state` returns **both** the tree and the screenshot, and accepts:

| Parameter | Meaning |
| --- | --- |
| `tree_format` | `markdown` (default) rows tagged `[N]`, or `elements` (structured) |
| — | each row/element carries `element_token`, formatted `<snapshot_id>:N` |
| `snapshot_id` | returned per read; a newer read invalidates the old tokens |
| `query` | case-insensitive substring projection, keeps matches + ancestor chain, original indices preserved |
| `since` | pass an earlier `snapshot_id` for a diff read: `+` added, `~` changed, `-` removed |
| `max_elements` | default 250 (5000 with `full_output`); truncation is reported via `truncated` + `total_element_count` |
| `max_depth`, `timeout_ms` | bound the walk (timeout default 1000 ms) |
| `include_accessibility_tree: false` | screenshot-only fast path (what we use today) |

Action tools accepting `element_token`: `click`, `double_click`, `right_click`,
`type_text`, `press_key`, `scroll`, `set_value`. `invoke_menu` takes a menu path
instead. `type_text` with `element_index`/`element_token` on a XAML/WinUI host routes
through UIA `ValuePattern.SetValue` and confirms by reading the value back — this is
exactly the path that fixes the Notepad dropped-keystrokes failure recorded in the ADR.

`verify_state({pid, window_id, expect})` evaluates 1–8 AND-combined predicates and
answers `satisfied` / `unsatisfied` / `unknown` (`unknown` never means success).

### A.1 Vocabulary

Add element addressing to `packages/computer/computer/src/types.ts` without breaking
the pixel form:

- `ComputerElement`: `{ token: string; role?: string; name?: string; actions?: readonly string[] }`
  (mirror only what the driver reports; do not invent a11y vocabulary).
- `ComputerSnapshot`: `{ windowId: number; snapshotId: string; format: 'markdown' | 'elements';
  markdown?: string; elements?: ComputerElement[]; total?: number; truncated?: boolean;
  takenAt: number }`.
- New observation on the service: `tree(windowId, options?: { query?: string; since?: string;
  maxElements?: number; maxDepth?: number; format?: 'markdown' | 'elements'; withImage?: boolean })`
  returning `{ snapshot, screenshot? }`. It is side-effect free like `screenshot`.
- `ComputerAction`: give every non-`launch` variant an optional `element?: ComputerElement`
  (or `elementToken?: string`). Exactly one of `element` / (`x` and `y`) may be present;
  reject both-present and neither-present with a `TypeError` before dispatch
  (`computer_tools` already validates input that way).
- `ComputerActionResult`: add `verified?: boolean` and `effect?: 'confirmed' | 'unverifiable'
  | 'suspected_noop' | 'partial' | 'refused'` so the model can tell "landed" from "maybe".

### A.2 Provider

In `packages/computer/computer-cua/src/index.ts`:

- `capture()` keeps its screenshot fast path for pure observation, but stop hardcoding
  `include_accessibility_tree: false` in a way that makes the tree unreachable: extract a
  `readState(window, options)` that takes `includeAccessibilityTree`, `query`, `since`,
  `max_elements`, `max_depth`, `tree_format`.
- Implement `tree()` against `get_window_state`; map rows defensively (never trust shape —
  the file already has `toWindow` / `isRecord` / `num` helpers to copy).
- `driverCall()`: when an action carries an element, emit `element_token` and omit `x`/`y`.
  Keep `count`/`button` mapping as it is.
- The `_captured` set exists because the driver refuses pixel input on a never-read window.
  Element actions do not need that precondition; keep the set for the pixel path only.
- Stale tokens: the driver answers with an explicit stale error naming current snapshots.
  Map it to a `ComputerError` with a message telling the caller to read the tree again —
  do not retry automatically (the snapshot may have changed for a real reason).

### A.3 Tools

In `packages/computer/tool-computer/src/index.ts`:

- New `computer_read_tree` (observe, `grant` reused from screenshot): args
  `window_id`, optional `query`, `since`, `max_elements`, `max_depth`, `format`.
  Returns the markdown by default — no image, no attachment — so it costs only text.
- `computer_click` / `computer_type` / `computer_key` / `computer_scroll` gain an optional
  `element_token` (schema: `{ type: 'string', pattern: '^s[0-9a-f]{8}:[0-9]+$' }`), with the
  description stating the precedence rule: **element first, pixels only when the tree has no
  entry for the target** (canvas, video, WebGL, custom-drawn).
- Drop the pixel-only wording where it is now wrong: `X`/`Y` descriptions should say
  "ignored when element_token is given".
- Screenshot tool descriptions already say the image is the whole window including the app's
  own title bar / browser chrome; keep that, and add to `computer_read_tree` that the tree
  covers only the window's content while the image includes chrome — the two frames differ.
- After an element action, still return a fresh screenshot (existing `act()` path) — the tree
  says what to click, the picture says what happened.

### A.4 Text-only models

`deepseek-v4-pro` has `input_modalities: ["text"]`, and the ADR currently says the first
version does not serve it. With `tree()` in place, add a path where the tools run
without images: `computer_read_tree` only, and screenshot results degrade to a short text
note (`window, title, size, action note`) instead of an attachment. Gate it on the existing
`vision` capability (`packages/llm/src/models.ts` `supportsVision`, already honoured by
`prepareImages`) so it needs no new config: if the route is text-only, the tool registry
mounts the text variants of the result shape.

### A.5 Verification for A

- Unit (`packages/computer/computer-cua/test/cua.test.ts`, fake driver): tree read maps
  rows and tokens; element action sends `element_token` and no `x`/`y`; stale-token error is
  surfaced with a re-read hint; `query`/`since`/`max_elements` are forwarded verbatim.
- Unit (`packages/computer/tool-computer/test/tools.test.ts`): element and pixel forms are
  mutually exclusive; `computer_read_tree` returns text with no attachment.
- Live (needs desktop access; run with escalation): on the calibration page from the earlier
  session (`.tnega/coord/cal.html`, 12 inputs with known ids), click by element token and
  assert the page's own focus readout matches the intended id — 12/12, with **no** image
  requests. Then repeat with the pixel path to prove both still work.
- Live: `type_text` by element into Windows 11 Notepad and read the value back —
  the case that silently dropped characters on the pixel path.

---

## B. Action coverage

Driver tools exist for everything below; today the seam exposes only
`launch/click/type/key/scroll/drag` plus observation.

| Gap | Driver tool | Work |
| --- | --- | --- |
| Hover | `move_cursor` | `{ op: 'hover' }`: needed for menus, tooltips, drag handles |
| Clipboard transfer | `clipboard_read`, `clipboard_write` | `{ op: 'clipboard-read' }` / `{ op: 'clipboard-write', text }`; move text between apps without keystroke synthesis. **Requires its own `grant` scope** (`computer:clipboard`) — the clipboard is global, not per-app |
| App discovery | `list_apps` | `computer_list_apps` (observe). Fixes "open chrome" opening the default browser: the model can see real names/AUMIDs first |
| Menu invocation | `invoke_menu` | `{ op: 'menu', path: string[] }` for native menu paths (File ▸ Save As). This is also the workaround for the XAML `hotkey` limit |
| Right / double click as first-class | `right_click`, `double_click` | Already expressible via `click` + `button`/`count`; keep as is, but document that element form supports them too |
| Batch steps | `run_steps` | `{ op: 'steps', steps: ComputerAction[] }` — one round trip instead of N, and the driver stops at the first failure. Must still fire `pre-action`/`action` **per step** so policy sees each one |
| Desktop / multi-monitor scope | `get_desktop_state`, targets `{kind:'desktop', display_id}` | New observation `desktop()` + actions with a desktop target. Foreground-only per driver contract; needs a decision on whether the app-level grant covers it (see ADR "authorization") |
| Direct value set | `set_value` | Expose as `{ op: 'set-value', element, value }` for sliders/combos where typing is wrong |

Each new op needs: vocabulary entry (`types.ts`), provider mapping (`driverCall`),
tool + schema + `grant` (`tool-computer`), a unit test, and one live check.

Also fix while in there: `COMPUTER_ACT_TOOLS` / `COMPUTER_OBSERVE_TOOLS` drive the
`interruption` policy (`retry` vs `confirm`). Classify the new ops explicitly — hover,
clipboard-read, list_apps, read_tree are `retry`; clipboard-write, menu, steps, set-value
are `confirm`.

---

## C. Cost and observability

### C.1 Image budget is hardcoded

`packages/llm/src/shared.ts` has `DEFAULT_MAX_IMAGES = 8`; no config field reaches it
(`packages/config/src` has no matching key). With Files API references the *body* problem is
solved, but eight historic images still cost tokens on every request.

- Add `maxImages` to the route/profile config (`packages/config/src/config.ts`, next to
  `pricing` / `contextWindow`) and thread it into `LlmConfig` (`packages/llm/src/types.ts`
  already has the field). Default: keep 8 for tests, recommend 2 in user-facing docs.
- Measure before choosing the default: run two consecutive screenshot steps in one session
  and read `usage.input_tokens` / `input_tokens_details.cached_tokens` at `maxImages` 8, 2
  and 1. The sliding window rewrites one old message from image to text note, so the cache
  prefix breaks at that message; smaller windows move the break closer to the tail.

### C.2 No per-task budget

Nothing stops a long computer-use run from taking hundreds of screenshots.

- Add `computer.maxScreenshots` (host config) and a per-Session counter in the Consumer.
  When exhausted, the tools return a clear refusal (`screenshot budget exhausted`) instead of
  another image, and observation degrades to `computer_read_tree`.
- Also cap per-image bytes (`maxImageDimension` already exists, default 1024) and log a warning
  when a screenshot exceeds it.

### C.3 No attribution

`packages/session/src` folds `usage` per session (`foldUsage`), and `packages/usage` prices
it — but nothing attributes cost to computer use. So "what did this desktop task cost" cannot
be answered.

- Emit the existing `computer/action` event with added `usage`-adjacent fields? No — the event
  fires per action, and usage arrives per model response. Instead have the Consumer record a
  lightweight `computer/step` summary: `{ windowId, op, imageBytes?, imageWidth/Height?,
  elementVsPixel: 'element' | 'pixel', durationMs, ok }`, and let `packages/usage` join it with
  the following assistant message's `usage`. Keep it out of the model's context.
- Report in the session metrics: `computerActions`, `computerScreenshots`, `screenshotBytes`,
  `elementActions`, `pixelActions`. The Web usage panel already renders `SessionMetrics`; add
  the fields there rather than a new screen.

### C.4 Pricing is unset

`~/.tnega/config.json` routes have `pricing: null`, so `packages/usage/src/usage.ts`
(`responseCost`) never produces a number — only tokens are stored. To get money:
fill `pricing` per route (`input`, `output`, `cachedInput`, `currency`) and re-run the
aggregate; the store re-prices from tokens, so no history is lost
(`packages/usage/src/usage-store.ts` keys its cache on a pricing fingerprint).
Measure the real image token price with a controlled pair: same request with and without one
image, `input_tokens` delta. Reference numbers from this repo's session (1024-px dense page):
227 tokens for a 512-px shot, ~400 for 1024, 944 for 1568.

---

## Out of scope here (driver-side or policy work)

- `hotkey` on XAML/WinUI targets only matches UIA accelerator keys, so `ctrl+z` / `ctrl+s`
  cannot work on Windows 11 Notepad; `delivery_mode: foreground` does not help. Emit a clear
  hint pointing at `invoke_menu` instead (B.6).
- Security tiers (read-only / click-only / full), app identity by signature, password-field
  protection, confirmation for dangerous controls, pause when the user is interacting,
  single-agent mutex, global stop hotkey, a Computer tab in the workbench. All belong on
  `computer/pre-action` as separate plugins, not in the provider.

## Suggested order

1. A.1/A.2/A.3 — element pathway end to end with `computer_read_tree` (ship together; the tree
   is useless without the actions and vice versa).
2. B: hover + clipboard + `list_apps` (cheap, high value), then menu + `steps`.
3. C.1 + C.3 (config + attribution), then C.2 (budget), then C.4 (pricing) once C.3 exists.
4. A.4 (text-only models), desktop scope, and the security tiers last.

## Checks that must pass for any of the above

```
pnpm vitest run packages/computer packages/llm --pool=threads
pnpm tsc -p tsconfig.json
pnpm eslint packages/computer packages/llm --max-warnings 0
```

Live probes need desktop access and the driver in `.tnega/cua-driver/bin`; note that this
sandbox denies desktop control unless the command is escalated. Keep probe scripts out of
the committed tree — write them under `.tnega/`, run them, delete them.
