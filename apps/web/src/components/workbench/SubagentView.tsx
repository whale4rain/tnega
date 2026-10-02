import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { errorText } from '../../lib/hooks'
import { fromEvents, type Entry } from '../../lib/timeline'
import { AgentAvatar } from '../AgentAvatar'
import { Timeline } from '../Timeline'

/** A Workbench document tab with a subagent's transcript. */
export function SubagentView({
  workspace,
  id,
  label,
  onOpenSubagent,
}: {
  workspace: string
  id: string
  label: string
  onOpenSubagent: (id: string, label: string) => void
}) {
  const [entries, setEntries] = useState<Entry[] | undefined>()
  const [error, setError] = useState<string | undefined>()

  const load = useCallback(() => {
    setError(undefined)
    api.subagent(workspace, id).then(result => setEntries(fromEvents(result.events)), reason => setError(errorText(reason)))
  }, [workspace, id])

  useEffect(() => {
    setEntries(undefined)
    load()
  }, [load])

  return (
    <div className="wb-view" aria-label={`Subagent ${label}`}>
      <div className="wb-toolbar">
        <AgentAvatar id={id} size={22} rerollable />
        <span className="wb-toolbar-title">{label} <span className="muted small mono">{id.slice(0, 8)}</span></span>
        <button type="button" className="icon-button small" onClick={load} aria-label="Refresh" title="Refresh"><RefreshCw size={14} /></button>
      </div>
      <div className="wb-card wb-scroll subagent-card">
        {error && <div className="error-banner">{error}</div>}
        {!entries && !error && <div className="skeleton"><div className="skeleton-line w90" /><div className="skeleton-line w60" /></div>}
        {entries && entries.length === 0 && <p className="muted">This subagent hasn't produced anything yet.</p>}
        {entries && <Timeline entries={entries} running={false} actions={{ onOpenSubagent }} agent={{ id }} />}
      </div>
    </div>
  )
}
