import { useEffect, useRef, useState } from 'react'
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
  useEffect(() => { if (config) setCurrent(config) }, [config])
  const [error, setError] = useState<string>()
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const close = () => { active.current = false; onClose() }
  useEffect(() => {
    if (config) return
    let alive = true
    void api.config().then(next => { if (alive) setCurrent(next) }, reason => { if (alive) setError(errorText(reason)) })
    return () => { alive = false }
  }, [config])
  const load = () => api.config().then(setCurrent, reason => setError(errorText(reason)))
  return <Dialog title="Add model" width={620} onClose={close}>
    {current ? <ModelBrowser config={current} onCancel={close} onPersisted={next => { if (active.current) setCurrent(next); onChanged?.(next) }} onSaved={(_next, id) => { if (active.current) { onAdded(id); close() } }} />
      : <>{error ? <><div className="notice notice-error" role="alert">{error}</div><button type="button" className="button secondary small" onClick={() => void load()}>Retry loading connections</button></> : <p className="muted small" role="status">Loading connections…</p>}</>}
  </Dialog>
}
