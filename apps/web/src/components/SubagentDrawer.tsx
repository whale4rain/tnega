import { RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import { fromEvents, type Entry } from '../lib/timeline'
import { AgentAvatar } from './AgentAvatar'
import { Timeline } from './Timeline'

export function SubagentDrawer({
  workspace,
  id,
  label,
  onClose,
  onOpenSubagent,
}: {
  workspace: string
  id: string
  label: string
  onClose: () => void
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="drawer" aria-label={`Subagent ${label}`}>
      <header className="drawer-header">
        <AgentAvatar id={id} size={32} rerollable />
        <div className="drawer-titles">
          <div className="drawer-title">{label}</div>
          <div className="drawer-sub mono">{id.slice(0, 8)}</div>
        </div>
        <button type="button" className="icon-button" onClick={load} aria-label="Refresh"><RefreshCw size={15} /></button>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </header>
      <div className="drawer-body">
        {error && <div className="error-banner">{error}</div>}
        {!entries && !error && <div className="skeleton"><div className="skeleton-line w90" /><div className="skeleton-line w60" /></div>}
        {entries && entries.length === 0 && <p className="muted">This subagent hasn't produced anything yet.</p>}
        {entries && <Timeline entries={entries} running={false} actions={{ onOpenSubagent }} agent={{ id }} />}
      </div>
    </aside>
  )
}
