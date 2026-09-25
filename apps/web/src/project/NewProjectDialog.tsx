import { useState } from 'react'
import { Button, Dialog, TextField } from '@radix-ui/themes'
import { hasDesktopWorkspacePicker, pickDesktopWorkspace } from '../desktopBridge'

export interface NewProjectInput {
  name: string
  folder: string
  goal?: string
}

/**
 * 建 Project：名称 + 文件夹。
 *
 * 文件夹就是它的工作位置 —— 共享事实、Agent 文件夹、产物都会放在那个目录下，所以这里是
 * 「选或新建一个目录」，而不是给一个名字然后在别处补设置。
 */
export function NewProjectDialog({
  open,
  defaultFolder,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  defaultFolder?: string | undefined
  onOpenChange: (open: boolean) => void
  onCreate: (input: NewProjectInput) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState(defaultFolder ?? '')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(): Promise<void> {
    if (!name.trim() || !folder.trim()) return
    setBusy(true)
    setError('')
    try {
      await onCreate({
        name: name.trim(),
        folder: folder.trim(),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      })
      onOpenChange(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={next => {
        onOpenChange(next)
        if (next) {
          setName('')
          setFolder(defaultFolder ?? '')
          setGoal('')
          setError('')
        }
      }}
    >
      <Dialog.Content maxWidth="480px">
        <Dialog.Title>New project</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          Pick the folder this project works in. Its memory, threads and artifacts live there, and
          its agents run there.
        </Dialog.Description>
        {error && <p role="alert" className="danger">{error}</p>}
        <form
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-3">
            <TextField.Root
              aria-label="Project name"
              placeholder="Project name"
              value={name}
              onChange={event => setName(event.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <TextField.Root
                aria-label="Project folder"
                placeholder="Folder to work in"
                value={folder}
                onChange={event => setFolder(event.target.value)}
              />
              {hasDesktopWorkspacePicker() && (
                <Button
                  type="button"
                  variant="soft"
                  disabled={busy}
                  onClick={() => {
                    void pickDesktopWorkspace().then(selected => {
                      if (selected) setFolder(selected)
                    })
                  }}
                >
                  Browse…
                </Button>
              )}
            </div>
            <TextField.Root
              aria-label="Project goal"
              placeholder="What is it for? (optional)"
              value={goal}
              onChange={event => setGoal(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-3 mt-4">
            <Dialog.Close>
              <Button variant="soft" color="gray">Cancel</Button>
            </Dialog.Close>
            <Button type="submit" disabled={busy || !name.trim() || !folder.trim()}>
              Create project
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  )
}
