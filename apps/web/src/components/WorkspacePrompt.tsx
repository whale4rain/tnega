import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'

export function WorkspacePrompt({ workspace }: { workspace: string | undefined }) {
  const [prompt, setPrompt] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setLoaded(false)
    setSaved(false)
    setError(undefined)
    if (!workspace) return
    const scope = new AbortController()
    api.workspacePrompt(workspace, scope.signal).then(value => {
      if (!scope.signal.aborted) { setPrompt(value.prompt); setLoaded(true) }
    }, reason => { if (!scope.signal.aborted) setError(errorText(reason)) })
    return () => scope.abort()
  }, [workspace])
  const save = async (value: string) => {
    if (!workspace) return
    setSaving(true)
    setError(undefined)
    setSaved(false)
    try { const result = await api.saveWorkspacePrompt(workspace, value); setPrompt(result.prompt); setSaved(true) }
    catch (reason) { setError(errorText(reason)) }
    finally { setSaving(false) }
  }
  if (!workspace) return <p className="muted small">Open a workspace to set its instructions.</p>
  return <div className="workspace-instructions">
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    <label className="field"><span className="field-label">Workspace instructions</span><textarea rows={8} maxLength={32000} disabled={!loaded || saving} value={prompt} onChange={event => { setPrompt(event.target.value); setSaved(false) }} /></label>
    <p className="muted small">Added to the system prompt alongside built-in instructions for subsequent requests in this workspace. Clear to remove.</p>
    <div className="workspace-instructions-actions"><button type="button" className="button primary" disabled={!loaded || saving} onClick={() => void save(prompt)}>Save instructions</button><button type="button" className="button ghost" disabled={!loaded || saving} onClick={() => void save('')}>Clear instructions</button></div>
    {saved && <p role="status" className="muted small">Instructions saved.</p>}
  </div>
}
