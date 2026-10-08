# Model Discovery and Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch models using the selected account or API credentials, distinguish model providers from third-party endpoints, and add models directly from the Session and Project model picker.

**Architecture:** The CLI server owns credentials and authenticated model discovery. Web clients receive model identifiers and capabilities, reuse the existing route editor and compact picker, and never receive stored secrets. Existing routes remain compatible; discovery does not modify configuration until a model is added.

**Tech Stack:** TypeScript strict, Node, React, Vitest, existing local browser E2E.

**Spec:** User request in this task, 2026-10-08: authenticated getmodel, provider/third-party grouping, direct add from the model selector like Cursor.

## Global Constraints

- Preserve existing configuration, model routes, Session and Project formats.
- Use existing tokens and UI components; keep added controls compact.
- Credentials stay on the server; typed errors must not expose tokens or upstream response bodies.
- Use live authenticated discovery rather than pretend fetched static lists.
- Keep manual model entry when discovery is unavailable.
- Local implementation E2E remains outside CI.
- Commit independently verifiable changes immediately; publish the next `0.4.19-beta.N` after checks.

### Task 1: Authenticated discovery and credential reuse

**Files:** `packages/cli/src/model-discovery.ts`, `config.ts`, `server.ts`, adjacent `packages/cli/test/` and README.

**Interfaces:**

```ts
type ModelSource = 'provider' | 'third-party'
interface DiscoverInput {
  routeId?: string
  auth?: 'chatgpt'
  protocol?: 'openai' | 'anthropic'
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
}
interface DiscoveredModel {
  id: string
  name: string
  contextWindow?: number
  vision?: boolean
}
// POST /api/config/models/discover
interface DiscoveryResult {
  source: ModelSource
  models: DiscoveredModel[]
}
// Existing model route save input also accepts:
interface DiscoveryRouteInput {
  sourceRouteId?: string
  source?: ModelSource
}
```

- [ ] Add failing behavior tests using HTTP fixtures: authenticated discovery, provider pagination, malformed/failed responses, saved-key reuse, and login-required errors.
- [ ] Run the focused tests and confirm the missing behavior fails.
- [ ] Implement OpenAI-compatible and Anthropic listing, existing ChatGPT auth refresh, bounded requests, safe errors and route source classification.
- [ ] Implement `sourceRouteId` saving without leaking stored credentials, reject unknown source routes, preserve explicit replacement keys.
- [ ] Run focused tests and strict typecheck; update README and Unreleased, commit the backend feature.

### Task 2: Model management and picker entry point

**Files:** `apps/web/src/components/ModelRoutes.tsx`, `Composer.tsx`, related model UI, `lib/api.ts`, `lib/types.ts`, adjacent tests and `apps/web/e2e/`.

**Consumes:** Task 1 HTTP contracts. **Produces:** Provider/third-party model groups, authenticated discovery, searchable add choices and refreshed per-session selection.

- [ ] Write failing user-behavior tests: fetch from saved account, choose a fetched model, copy source route credentials by identifier, manual add, failures and grouping.
- [ ] Run focused tests and observe missing UI behavior.
- [ ] Extend API/types and reuse the existing route editor for fetching and selecting model IDs; keep errors and empty states visible.
- [ ] Add an Add model action in Session and Project selectors; successful saving refreshes available models and selects the new route without discarding prompt/settings.
- [ ] Verify existing effort/default selection, cancel and duplicate handling with focused tests.
- [ ] Add local E2E for the end-to-end selector/add/refresh flow, update README and Unreleased, commit the UI feature.

### Task 3: Review, verify and release

- [ ] Review interface agreement, stored-key behavior, endpoint classification, accessibility and compatibility.
- [ ] Run minimal related tests, root and desktop typecheck, lint, build and local E2E.
- [ ] Confirm beta.2 publication already in progress; preserve its tagged bytes.
- [ ] Prepare the next preview version and audit all commits since beta.2.
- [ ] Run the full release test/package gate, commit version notes, tag, push and verify GitHub artifacts/update feed plus npm preview.
