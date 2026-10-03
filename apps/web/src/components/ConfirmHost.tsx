import { useEffect, useState } from 'react'
import { settleDialog, subscribeDialogs, type PendingDialog } from '../lib/dialogs'
import { Dialog } from './Dialog'

/** Renders the oldest pending `confirmDialog` / `noticeDialog` in the app's own dialog style. */
export function ConfirmHost() {
  const [pending, setPending] = useState<readonly PendingDialog[]>([])
  useEffect(() => subscribeDialogs(setPending), [])
  const current = pending[0]
  if (!current) return null
  const cancel = () => settleDialog(current.id, current.notice === true)
  return (
    <Dialog
      key={current.id}
      title={current.title}
      width={440}
      onClose={cancel}
      footer={current.notice ? (
        <button type="button" className="button primary" onClick={() => settleDialog(current.id, true)}>OK</button>
      ) : (
        <>
          <button type="button" className="button ghost" onClick={cancel}>{current.cancelLabel ?? 'Cancel'}</button>
          <button
            type="button"
            className={`button ${current.danger ? 'danger' : 'primary'}`}
            onClick={() => settleDialog(current.id, true)}
          >
            {current.confirmLabel ?? 'Confirm'}
          </button>
        </>
      )}
    >
      {current.message && <p className="confirm-message">{current.message}</p>}
    </Dialog>
  )
}
