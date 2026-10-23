# @tnega/run-settings

Run settings that can change while a turn runs: the model, its reasoning
effort and the permission level.

A change made mid-turn never touches the step that is already talking to the
model; it applies from the next step boundary, the way DSH's model selection
does:

- `runSettings` snapshots the selection when a step is admitted
  (`agent/pre-step`) and writes it into that step's request options
  (`agent/request`), so every attempt of a step uses one selection and the
  agent's `request/header` records a `change` the first step it differs.
- At the same boundary it appends the permission notice (a `system/message`
  named `plugin:permission`) when the level changed since the model was last
  told, and adds it to the step's messages, so the live request and the
  replayed Session stay the same.
- `routedAdapter` sends each call to the route its options name, so the agent
  keeps one adapter while its model changes.

The host supplies the selection (from the Session's settings) and the notice
text; the plugin only acts for the agents the `session` callback returns, so
subagents keep the settings they were spawned with.
