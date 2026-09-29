import { useState } from 'react'
import { errorText } from '../../lib/hooks'
import { projectApi } from '../../lib/project-api'
import type { ProjectRecord } from '../../lib/project-types'
import { Dialog } from '../Dialog'

/** Creating a project only needs a name; the goal can also be told to the coordinator later. */
export function NewProjectDialog({ workspace, onClose, onCreated }: { workspace: string; onClose: () => void; onCreated: (project: ProjectRecord) => void }) {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const { project } = await projectApi.create(workspace, { name: name.trim(), ...(goal.trim() ? { goal: goal.trim() } : {}) })
      onCreated(project)
      onClose()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="New project"
      description="A project is one ongoing conversation. A coordinator splits the work into parallel threads that share memory and a library."
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button type="button" className="button ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" onClick={() => void create()} disabled={busy || !name.trim()}>Create project</button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input value={name} onChange={event => setName(event.target.value)} onKeyDown={event => event.key === 'Enter' && void create()} placeholder="e.g. Q4 launch" maxLength={200} />
      </label>
      <label className="field">
        <span className="field-label">Goal <span className="muted">(optional)</span></span>
        <textarea className="field-textarea" rows={3} value={goal} onChange={event => setGoal(event.target.value)} placeholder="What does done look like? You can also just tell the coordinator." />
      </label>
    </Dialog>
  )
}
