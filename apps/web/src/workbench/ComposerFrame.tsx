import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { Button } from '@astryxdesign/core/Button'
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatSendButton,
  type ChatComposerInputHandle,
} from '@astryxdesign/core/Chat'
import { IconButton } from '@astryxdesign/core/IconButton'
import { Popover } from '@astryxdesign/core/Popover'
import { Selector } from '@astryxdesign/core/Selector'
import { Slider } from '@astryxdesign/core/Slider'
import { Stack } from '@astryxdesign/core/Stack'
import { Text } from '@astryxdesign/core/Text'
import { Token } from '@astryxdesign/core/Token'
import { ChevronLeft, ChevronRight, Paperclip, Shield, SlidersHorizontal } from 'lucide-react'

interface Props {
  /** 斜杠菜单这类浮在输入框上方的 Tnega 内容，和附件行共用 ChatComposer 的 drawer 槽。 */
  drawer?: ReactNode
  accessory?: ReactNode
  model?: string
  models: Array<{ id: string; name: string; reasoningEfforts: Array<'low' | 'medium' | 'high'> }>
  reasoningEffort: 'default' | 'low' | 'medium' | 'high'
  onModel: (model: string) => Promise<void>
  onReasoningEffort: (effort: 'default' | 'low' | 'medium' | 'high') => Promise<void>
  apiKeySet: boolean
  onSettings: () => void
  permission: 'read-only' | 'workspace-write' | 'bypass'
  /** 不给就是这一层改不了权限：只显示提示，不摆一个点不动的选择器。 */
  onPermission?: (value: 'read-only' | 'workspace-write' | 'bypass') => void
  disabled: boolean
  /** 不给就是这一层没有模式可切：不摆模式选择器。 */
  mode?: 'auto' | 'plan' | 'goal'
  onMode?: (value: 'auto' | 'plan' | 'goal') => Promise<void>
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  canSend: boolean
  /** 每个屏的输入区提示语不一样，留一个口子。 */
  placeholder?: string
  /** 有取消接口的屏才给 onStop；不给就不摆停止按钮。 */
  onStop?: () => void
  running?: boolean
  /** 上下文压缩期间禁掉输入区；运行中仍可继续打字，草稿不会丢。 */
  compacting?: boolean
  /** 给调用方留一个把焦点收回输入框的把手。 */
  inputHandleRef?: Ref<ChatComposerInputHandle>
}

/** 权限各档的说明。放进下拉项里，控制行就不用再排一长串提示文字。 */
const PERMISSION_OPTIONS = [
  { value: 'read-only', label: 'Read only', description: 'Read workspace · public web search' },
  { value: 'workspace-write', label: 'Workspace write', description: 'Write workspace · shell access' },
  { value: 'bypass', label: 'Bypass', description: 'Full access · no approval prompts' },
] as const

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ComposerFrame(props: Props) {
  const selectedModel = props.models.find(item => item.id === props.model)
  const models = props.models
  const selectedIndex = Math.max(0, models.findIndex(item => item.id === props.model))
  const [previewIndex, setPreviewIndex] = useState(selectedIndex)
  const [previewEffortIndex, setPreviewEffortIndex] = useState(0)
  useEffect(() => setPreviewIndex(selectedIndex), [selectedIndex, models.length])
  const effort = props.reasoningEffort !== 'default' && selectedModel?.reasoningEfforts.includes(props.reasoningEffort)
    ? props.reasoningEffort : 'default'
  const previewModel = models[Math.min(previewIndex, models.length - 1)]
  const effortChoices: Array<'default' | 'low' | 'medium' | 'high'> = ['default', ...(previewModel?.reasoningEfforts ?? [])]
  const selectedEffortIndex = Math.max(0, effortChoices.indexOf(effort))
  useEffect(() => setPreviewEffortIndex(selectedEffortIndex), [selectedEffortIndex, previewModel?.id, effortChoices.length])
  const previewEffort = effortChoices[Math.min(previewEffortIndex, effortChoices.length - 1)] ?? 'default'
  const selectModel = (index: number) => {
    const next = models[index]
    if (!next) return
    setPreviewIndex(index)
    if (next.id !== props.model) void props.onModel(next.id)
  }
  // 附件目前只是输入区的摆设：能挑、能移除、能被粘贴或拖进来，但 run 请求里不带它们，
  // 发送后即清空。等后端接住附件再把这层状态提上去。
  const [attachments, setAttachments] = useState<File[]>([])
  const filePicker = useRef<HTMLInputElement | null>(null)
  const addAttachments = (files: File[]) => {
    if (!files.length) return
    setAttachments(current => [...current, ...files])
  }
  const removeAttachment = (index: number) => {
    setAttachments(current => current.filter((_, at) => at !== index))
  }

  return <section className={`composer-dock${props.accessory ? ' has-plan' : ''}`} aria-label="Message composer">
    {props.accessory}
    {!props.apiKeySet && <Stack direction="horizontal" align="center" gap={2} className="config-notice">
      <Text type="body">Connect a model to start a conversation.</Text>
      <Button label="Open settings" variant="ghost" size="sm" onClick={props.onSettings} />
    </Stack>}
    <input
      ref={filePicker}
      type="file"
      multiple
      hidden
      onChange={event => {
        addAttachments([...(event.target.files ?? [])])
        event.target.value = ''
      }}
    />
    <ChatComposer
      value={props.value}
      onChange={props.onChange}
      onSubmit={() => {
        setAttachments([])
        props.onSubmit()
      }}
      onStop={props.onStop}
      isStopShown={!!props.running}
      isDisabled={!!props.compacting}
      density="compact"
      placeholder={props.placeholder ?? 'Ask Tnega to build, fix, or explore…'}
      drawer={attachments.length > 0 || props.drawer ? <>
        {attachments.length > 0 && <ChatComposerDrawer count={attachments.length} label="Attachments">
          <Stack direction="horizontal" gap={1} wrap="wrap">
            {attachments.map((file, index) => (
              <Token
                key={`${file.name}-${file.lastModified}-${index}`}
                label={file.name}
                size="sm"
                icon={<Paperclip size={12} aria-hidden="true" />}
                description={`${file.name}, ${formatSize(file.size)}`}
                onRemove={() => removeAttachment(index)}
              />
            ))}
          </Stack>
        </ChatComposerDrawer>}
        {props.drawer}
      </> : undefined}
      headerActions={<IconButton
        label="Attach files"
        tooltip="Attach files"
        icon={<Paperclip size={16} aria-hidden="true" />}
        variant="ghost"
        size="sm"
        isDisabled={props.disabled}
        onClick={() => filePicker.current?.click()}
      />}
      input={<ChatComposerInput
        label="Message Tnega"
        handleRef={props.inputHandleRef}
        onFiles={addAttachments}
        // The input clears its own draft the moment Enter reaches it, whether
        // or not the send is accepted. Swallow Enter while a send would be
        // refused so a draft survives an unconfigured model or a run in
        // flight, instead of vanishing on the keystroke.
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !props.canSend)
            event.preventDefault()
        }}
      />}
      footerActions={<Stack direction="horizontal" align="center" gap={2} className="composer-toolbar" wrap="nowrap">
        {props.onPermission && <Selector
          label="Tool permissions"
          isLabelHidden
          variant="ghost"
          size="sm"
          startIcon={<Shield size={14} />}
          value={props.permission}
          isDisabled={props.disabled}
          options={[...PERMISSION_OPTIONS]}
          onChange={value => {
            if (value === 'read-only' || value === 'workspace-write' || value === 'bypass') props.onPermission?.(value)
          }}
        />}
        <Popover placement="above" alignment="start" label="Model and thinking settings" isEnabled={!props.disabled && !!props.model} content={<Stack direction="vertical" gap={3} className="model-slider-panel">
          <Text type="body">Model · {models.length ? `${previewIndex + 1} / ${models.length}` : '—'}</Text>
          <Stack direction="horizontal" align="center" gap={2}>
            <IconButton label="Previous model" tooltip="Previous model" icon={<ChevronLeft size={18} />} variant="ghost" size="sm" isDisabled={props.disabled || previewIndex <= 0} onClick={() => selectModel(previewIndex - 1)} />
            <Text type="body" maxLines={1}>{previewModel?.name ?? 'No model'}</Text>
            <IconButton label="Next model" tooltip="Next model" icon={<ChevronRight size={18} />} variant="ghost" size="sm" isDisabled={props.disabled || previewIndex >= models.length - 1} onClick={() => selectModel(previewIndex + 1)} />
          </Stack>
          <Slider label="Choose model" isLabelHidden min={0} max={Math.max(1, models.length - 1)} step={1} value={previewIndex} isDisabled={props.disabled || models.length < 2} onChange={(value: number) => setPreviewIndex(value)} onChangeEnd={(value: number) => selectModel(value)} />
          <Text type="body">Thinking · {previewEffort}</Text>
          <Slider label="Choose thinking effort" isLabelHidden min={0} max={Math.max(1, effortChoices.length - 1)} step={1} value={previewEffortIndex} isDisabled={props.disabled || previewModel?.id !== props.model || effortChoices.length < 2} onChange={(value: number) => setPreviewEffortIndex(value)} onChangeEnd={(value: number) => { const next = effortChoices[value]; if (next && next !== effort) void props.onReasoningEffort(next) }} />
          {effortChoices.length < 2 && <Text type="body">This model uses its own thinking default.</Text>}
        </Stack>}>
          <Button label="Model and thinking settings" icon={<SlidersHorizontal size={14} />} variant="ghost" size="sm" isDisabled={props.disabled || !props.model}>{selectedModel?.name ?? props.model ?? 'Select model'} · {effort}</Button>
        </Popover>
        {props.mode && <Selector label="Session mode" isLabelHidden variant="ghost" size="sm" value={props.mode} isDisabled={props.disabled} options={[{ value: 'auto', label: 'Auto' }, { value: 'plan', label: 'Plan' }, { value: 'goal', label: 'Goal' }]} onChange={value => { if (value === 'auto' || value === 'plan' || value === 'goal') void props.onMode?.(value) }} />}
      </Stack>}
      sendButton={<ChatSendButton isStopShown={!!props.running} isDisabled={props.running ? !!props.compacting : !props.canSend} onSend={props.onSubmit} onStop={props.onStop} />}
    />
  </section>
}
