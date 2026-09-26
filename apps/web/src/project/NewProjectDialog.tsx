import { useState } from 'react'
import { Banner } from '@astryxdesign/core/Banner'
import { Button } from '@astryxdesign/core/Button'
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog'
import { Stack } from '@astryxdesign/core/Stack'
import { TextInput } from '@astryxdesign/core/TextInput'
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
    <Dialog
      isOpen={open}
      onOpenChange={next => {
        onOpenChange(next)
        if (next) {
          setName('')
          setFolder(defaultFolder ?? '')
          setGoal('')
          setError('')
        }
      }}
      width={480}
    >
      <DialogHeader
        title="New project"
        subtitle="Pick the folder this project works in. Its memory, threads and artifacts live there, and its agents run there."
        onOpenChange={() => onOpenChange(false)}
      />
      <Stack direction="vertical" gap={3} padding={3}>
        {error && <Banner status="error" title={error} collapsible={false} />}
        <form
          onSubmit={event => {
            event.preventDefault()
            void submit()
          }}
        >
          <Stack direction="vertical" gap={3}>
            <TextInput
              label="Project name"
              isLabelHidden
              placeholder="Project name"
              value={name}
              onChange={setName}
              hasAutoFocus
            />
            <Stack direction="horizontal" gap={2} align="end">
              <TextInput
                label="Project folder"
                isLabelHidden
                placeholder="Folder to work in"
                value={folder}
                onChange={setFolder}
                width="100%"
              />
              {hasDesktopWorkspacePicker() && (
                <Button
                  label="Browse…"
                  variant="secondary"
                  isDisabled={busy}
                  onClick={() => {
                    void pickDesktopWorkspace().then(selected => {
                      if (selected) setFolder(selected)
                    })
                  }}
                />
              )}
            </Stack>
            <TextInput
              label="Project goal"
              isLabelHidden
              placeholder="What is it for? (optional)"
              value={goal}
              onChange={setGoal}
            />
            <Stack direction="horizontal" gap={3} justify="end">
              <Button label="Cancel" variant="secondary" onClick={() => onOpenChange(false)} />
              <Button
                label="Create project"
                type="submit"
                isDisabled={busy || !name.trim() || !folder.trim()}
              />
            </Stack>
          </Stack>
        </form>
      </Stack>
    </Dialog>
  )
}
