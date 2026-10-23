/**
 * A link to a session that can be pasted into a chat, where the agent's
 * session tools read it: `tnega://session/<id>?workspace=<path>`. The same
 * format as `formatSessionLink` in `@tnega/session-search`.
 */
export function sessionLink(workspace: string, sessionId: string): string {
  return `tnega://session/${encodeURIComponent(sessionId)}?workspace=${encodeURIComponent(workspace)}`
}

