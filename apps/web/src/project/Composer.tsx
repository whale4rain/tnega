import { Button, TextArea } from '@radix-ui/themes'
import { Send } from 'lucide-react'

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder: string
  disabled?: boolean
  busy?: boolean
  /** 这一轮会看到什么：文件夹与权限。是信息，不是可点的控件。 */
  context: string
  models: ReadonlyArray<{ id: string; name: string }>
  model?: string
  onModel?: (model: string) => Promise<void> | void
  reasoningEffort?: 'default' | 'low' | 'medium' | 'high'
  onReasoningEffort?: (effort: 'default' | 'low' | 'medium' | 'high') => Promise<void> | void
}

const EFFORTS = ['default', 'low', 'medium', 'high'] as const

/**
 * 主对话与 Thread 面板各自的输入区。骨架与会话屏的 ComposerFrame 一致
 * （`.composer-surface` / `.composer-dock` / `.composer-toolbar`）。
 *
 * 模型与思考强度写的是这台机器的默认配置（和设置里是同一件事），不是每个 Project 一份的
 * 副本 —— Project 的 Agent 用的就是这个默认值。上下文入口显示这轮实际会看到的文件夹与
 * 权限，而不是一个点不动的回形针。
 */
export function Composer(props: ComposerProps) {
  const send = (): void => {
    if (props.disabled || props.busy || !props.value.trim()) return
    props.onSubmit()
  }
  return (
    <div className="composer-surface">
      <section className="composer-dock" aria-label="Message composer">
        <div className="composer-context flex items-center gap-2">
          <span className="truncate" title={props.context}>{props.context}</span>
          <span className="ml-auto text-xs">Project folder</span>
        </div>
        <div className="composer">
          <TextArea
            value={props.value}
            placeholder={props.placeholder}
            disabled={props.disabled}
            onChange={event => props.onChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                send()
              }
            }}
          />
        </div>
        <div className="composer-toolbar flex items-center gap-3">
          {!!props.models.length && props.onModel && (
            <select
              className="composer-select"
              aria-label="Model"
              value={props.model ?? ''}
              onChange={event => void props.onModel?.(event.target.value)}
            >
              {props.models.map(entry => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          )}
          {props.onReasoningEffort && (
            <select
              className="composer-select"
              aria-label="Reasoning effort"
              value={props.reasoningEffort ?? 'default'}
              onChange={event =>
                void props.onReasoningEffort?.(event.target.value as 'default' | 'low' | 'medium' | 'high')}
            >
              {EFFORTS.map(effort => (
                <option key={effort} value={effort}>
                  {effort === 'default' ? 'default effort' : effort}
                </option>
              ))}
            </select>
          )}
          <Button
            className="ml-auto"
            size="1"
            onClick={send}
            disabled={props.disabled || props.busy || !props.value.trim()}
          >
            <Send size={13} aria-hidden="true" />
            Send
          </Button>
        </div>
      </section>
    </div>
  )
}
