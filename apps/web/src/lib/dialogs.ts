/**
 * In-app replacements for `window.confirm` / `window.alert`: the browser's
 * native boxes look like the OS, not like Tnega, and block the renderer.
 * `ConfirmHost` (mounted once by the app) renders whatever is pending here.
 */
export interface ConfirmRequest {
  title: string
  message?: string
  /** Label of the confirming button; omitted for a notice with a single OK. */
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirming button as destructive. */
  danger?: boolean
  /** A notice has only an OK button and always resolves `true`. */
  notice?: boolean
}

export interface PendingDialog extends ConfirmRequest {
  id: number
  resolve: (value: boolean) => void
}

type Listener = (pending: readonly PendingDialog[]) => void

let queue: PendingDialog[] = []
let nextId = 1
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener(queue)
}

export function subscribeDialogs(listener: Listener): () => void {
  listeners.add(listener)
  listener(queue)
  return () => listeners.delete(listener)
}

export function settleDialog(id: number, value: boolean): void {
  const entry = queue.find(item => item.id === id)
  if (!entry) return
  queue = queue.filter(item => item.id !== id)
  emit()
  entry.resolve(value)
}

/** Ask the user to confirm; resolves `false` on cancel, Escape or a click outside. */
export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  return new Promise(resolve => {
    queue = [...queue, { ...request, id: nextId++, resolve }]
    emit()
  })
}

/** Show a message with a single OK button. */
export async function noticeDialog(title: string, message?: string): Promise<void> {
  await confirmDialog({ title, ...(message ? { message } : {}), notice: true })
}
