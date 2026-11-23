import { KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { confirmDialog } from '../lib/dialogs'
import { errorText } from '../lib/hooks'
import type { SecretInfo } from '../lib/types'
import { SettingsCard } from './SettingsCard'

/**
 * Secrets the agent can use in the open session: the ones typed for this
 * session and the ones saved for the workspace. Names only; a value never
 * leaves the server. New ones are added by answering the agent's question.
 */
export function SecretsSettings({ workspace, sessionId }: { workspace: string | undefined; sessionId?: string | undefined }) {
  const [secrets, setSecrets] = useState<SecretInfo[]>()
  const [error, setError] = useState<string>()
  const [removing, setRemoving] = useState<string>()

  useEffect(() => {
    setSecrets(undefined)
    setError(undefined)
    if (!workspace) return
    const scope = new AbortController()
    api.secrets(workspace, sessionId, scope.signal).then(
      value => { if (!scope.signal.aborted) setSecrets(value.secrets) },
      reason => { if (!scope.signal.aborted) setError(errorText(reason)) },
    )
    return () => scope.abort()
  }, [workspace, sessionId])

  const remove = async (secret: SecretInfo) => {
    if (!workspace) return
    const confirmed = await confirmDialog({
      title: `Remove ${secret.name}?`,
      message: secret.remembered
        ? 'It is deleted from this computer. Every session in this workspace stops getting it, and the agent has to ask again.'
        : 'Commands in this session stop getting it, and the agent has to ask again.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!confirmed) return
    setRemoving(secret.name)
    setError(undefined)
    try { setSecrets((await api.removeSecret(workspace, secret.name, sessionId)).secrets) }
    catch (reason) { setError(errorText(reason)) }
    finally { setRemoving(undefined) }
  }

  const description = `Commands get each one as an environment variable, its value masked in what tools return; the agent only sees the name.${sessionId ? '' : ' Open a session to see the ones typed just for it.'}`
  if (!workspace) return <SettingsCard title="Secrets" description="Open a workspace to see its secrets." />
  return <SettingsCard title="Secrets for this workspace" description={description} className="secret-settings">
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    {secrets && secrets.length === 0 && <p className="settings-empty">No secrets yet. When the agent needs a key it asks for it, and you type it into a hidden field.</p>}
    {secrets && secrets.length > 0 && <ul className="secret-list" aria-label="Secrets">
      {secrets.map(secret => <li key={secret.name} className="secret-row">
        <KeyRound size={15} aria-hidden="true" />
        <span className="secret-text">
          <span className="secret-name">{secret.name}</span>
          <span className="secret-scope">{secret.remembered ? 'Saved for this workspace' : 'This session only'}</span>
        </span>
        <button type="button" className="button ghost small" aria-label={`Remove ${secret.name}`} disabled={removing !== undefined} onClick={() => void remove(secret)}>Remove</button>
      </li>)}
    </ul>}
  </SettingsCard>
}
