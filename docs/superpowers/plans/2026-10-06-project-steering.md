# Project delegation and steering implementation plan

**Goal:** Make the Project coordinator delegate execution proactively and let users stop or redirect an active coordinator or Thread.

**Architecture:** Keep Box as the durable message channel and normal messages asynchronous. An explicit interrupt cancels the addressed Agent Run while retaining its inbox, then sends the correction through the existing Box delivery path. Reuse PromptBox controls with opt-in concurrent sending so ordinary Session composers keep their current behavior.

**Constraints:** Preserve user messages and Session formats; never turn Agent messages into user authorization. Stopping the coordinator must leave other Threads running. Simple questions should not require delegation.

## Work

- [x] Clarify coordinator/Thread and ordinary subagent delegation responsibilities in the existing prompts and tool descriptions. Validate relevant prompt and lifecycle tests; commit independently.
- [x] Add a failing ProjectHost regression covering ordinary asynchronous messages, explicit cancellation and durable correction delivery for both coordinator and child Thread. Add the optional boolean `interrupt` to the two message HTTP routes and host methods. Cancel only the addressed Agent with `keepInbox: true`; preserve existing delivery receipts. Validate host and route behavior; commit with the changelog entry.
- [x] Connect coordinator and Thread stop controls to the existing single-Thread API. Let Project composers send while running, with separate Stop and Interrupt and send actions. Preserve default PromptBox behavior. Verify the actual composer interactions and request bodies; commit independently.
- [x] Run the affected test files and typecheck, then build the Web/runtime artifacts. Review the complete diff and report the behavioral and model-compliance limits.

## Evidence and adjustment

The original host-level cancel-before-send attempt failed the coordinator regression:
an older queued input started before the correction arrived. The final implementation
adds an optional trusted-user `BoxEnvelope.interrupt` field and `LiveAgent.interrupt`,
which inserts the correction in the same inbox mutation before cancellation. Ordinary
messages retain their existing path; historic envelopes without the field need no migration.

Validation: ProjectHost/HTTP/Box/LiveAgent tests: 68 passed; Project Loop tests passed;
front-end control/API tests: 8 passed; prompt protocol tests: 4 passed. Typecheck,
targeted ESLint and production build passed. Prompt compliance has not been validated
against a real model. Cancellation cannot undo an already completed tool effect.
