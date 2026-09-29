import { FolderSearch } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import { Dialog } from './Dialog'

export function WorkspaceDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (path: string, all: string[]) => void }) {
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const add = async (value = path) => {
    if (!value.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.addWorkspace(value.trim())
      onAdded(result.path, result.workspaces)
      onClose()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  const browse = async () => {
    setError(undefined)
    try {
      const picked = await api.pickFolder()
      if (picked) {
        setPath(picked)
        await add(picked)
      }
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  return (
    <Dialog
      title="Open a workspace"
      description="A workspace is a folder the agent works in. Sessions, tool access and sandboxing are all scoped to it."
      onClose={onClose}
      width={500}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" onClick={() => void add()} disabled={busy || !path.trim()}>Open</button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Folder path</span>
        <span className="input-row">
          <input
            value={path}
            onChange={event => setPath(event.target.value)}
            onKeyDown={event => event.key === 'Enter' && void add()}
            placeholder="D:\\projects\\my-app  or  ~/code/my-app"
            spellCheck={false}
          />
          <button type="button" className="button secondary" onClick={() => void browse()}>
            <FolderSearch size={15} /> Browse…
          </button>
        </span>
      </label>
    </Dialog>
  )
}
