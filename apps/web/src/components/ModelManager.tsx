import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/hooks'
import type { ConfigSnapshot } from '../lib/types'
import { Dialog } from './Dialog'
import { ModelBrowser } from './ModelBrowser'

export function ModelManager({ config, onChanged, onAdded, onClose }: {
  config?: ConfigSnapshot
  onChanged?: (config: ConfigSnapshot) => void
  onAdded: (id: string) => void
  onClose: () => void
}) {
  const [current, setCurrent] = useState(config)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (config) return
    let alive = true
    void api.config().then(next => { if (alive) setCurrent(next) }, reason => { if (alive) setError(errorText(reason)) })
    return () => { alive = false }
  }, [config])
  const load = () => api.config().then(setCurrent, reason => setError(errorText(reason)))
  return <Dialog title="Add model" width={620} onClose={onClose}>
    {current ? <ModelBrowser config={current} onCancel={onClose} onSaved={(next, id) => { setCurrent(next); onChanged?.(next); onAdded(id); onClose() }} />
      : <>{error ? <><div className="notice notice-error" role="alert">{error}</div><button type="button" className="button secondary small" onClick={() => void load()}>Retry loading connections</button></> : <p className="muted small" role="status">Loading connections…</p>}</>}
  </Dialog>
}
