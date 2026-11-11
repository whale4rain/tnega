# @tnega/side-chat

The temporary chat behind `/btw` and the sidebar's **Temporary chat**: quick
questions on the side, answered by the model without tools, never saved.

- `POST /api/side-chat?workspace=…` with `{ messages, session?, model? }`
  streams the answer as SSE frames: `side/delta` (text), then `side/done`
  (finish reason) or `side/error` (message).
- `messages` are the side turns so far, the question last. The client holds
  them; the server keeps nothing between requests.
- With `session`, the request carries the newest part of that session's
  model-visible history (folded from its durable events, as a transcript,
  ~60k characters) so the model can answer about it. Nothing is appended to
  the session and its running agent is neither interrupted nor told.
- The composition layer picks the model (`resolveAdapter`): the host answers
  with the session's model and effort, or the default route without one.
  Hidden reasoning is turned off where the route allows, since side answers
  should be quick.

The host mounts it as a plugin (`sideChatRoutes`).
