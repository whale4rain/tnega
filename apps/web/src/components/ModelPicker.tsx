import { Cpu, Gauge } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ConfigSnapshot, ModelOption, SessionEffort } from '../lib/types'
import { SectionChoice, choiceSection, type ChoiceOption, type ChoiceSection } from './Menu'
import { ModelManager } from './ModelManager'

export function modelOptions(models: ModelOption[], defaultModelId: string | undefined): Array<ChoiceOption<string>> {
  return [
    { value: '', label: 'Default model', description: defaultModelId ? `Currently ${defaultModelId}` : 'Use the configured default', icon: <Cpu size={14} /> },
    ...models.map(model => ({ value: model.id, label: model.name || model.id,
      description: `${model.protocol}${model.contextWindow ? ` · ${Math.round(model.contextWindow / 1000)}k context` : ''}${model.apiKeySet ? '' : ' · no API key'}`, icon: <Cpu size={14} /> })),
  ]
}

const EFFORT: Record<SessionEffort, string> = { default: 'Default effort', low: 'Low effort', medium: 'Medium effort', high: 'High effort' }
const EFFORT_HINT: Record<SessionEffort, string> = {
  default: 'Whatever the model does by default',
  low: 'Answer quickly with little reasoning',
  medium: 'Balance speed and depth',
  high: 'Think longest before answering',
}

const EFFORT_SHORT: Record<SessionEffort, string> = { default: '', low: 'Low', medium: 'Medium', high: 'High' }

/**
 * Shared Session / Project model menu, with adding available even before any
 * model exists. With `showEffort`, the reasoning effort is a section of the
 * same menu whenever the chosen model has effort levels; `sections` adds more
 * (the composer adds the mode), so one quiet word holds them all.
 */
export function ModelPicker({ model, reasoningEffort = 'default', onChange, models, defaultModelId, config, onConfigChanged, disabled = false, label = 'Model', showEffort = true, side = 'top', align = 'start', plain = false, sections: extra = [] }: {
  model?: string | undefined
  reasoningEffort?: SessionEffort
  onChange: (patch: { model?: string | undefined; reasoningEffort?: SessionEffort }) => void
  models: ModelOption[]
  defaultModelId?: string | undefined
  config?: ConfigSnapshot | undefined
  onConfigChanged?: ((config: ConfigSnapshot) => void) | undefined
  disabled?: boolean
  label?: string
  showEffort?: boolean
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  /** The composer's model word: no icon, no chip. */
  plain?: boolean
  /** More settings in the same menu, after the models and effort. */
  sections?: readonly ChoiceSection[]
}) {
  const [adding, setAdding] = useState(false)
  const [local, setLocal] = useState<ConfigSnapshot>()
  useEffect(() => { setLocal(undefined) }, [config, models])
  const available = local?.models ?? models
  const options = modelOptions(available, local?.effective.modelId ?? defaultModelId)
  const active = available.find(option => option.id === (model || local?.effective.modelId || defaultModelId))
  const efforts: SessionEffort[] = showEffort && active?.reasoningEfforts.length ? ['default', ...active.reasoningEfforts] : []
  const current = options.find(option => option.value === (model ?? '')) ?? options[0]
  const select = (value: string) => onChange({ model: value || undefined })
  const effort = efforts.includes(reasoningEffort) ? reasoningEffort : 'default'
  const effortOptions: Array<ChoiceOption<SessionEffort>> = efforts.map(value => ({ value, label: EFFORT[value], description: EFFORT_HINT[value], icon: <Gauge size={14} /> }))
  const sections: ChoiceSection[] = [
    choiceSection('default', 'Model', options.slice(0, 1), model ?? '', select),
    ...(['provider', 'third-party'] as const).flatMap(source => {
      const choices = options.slice(1).filter(option => (available.find(entry => entry.id === option.value)?.source ?? 'third-party') === source)
      return choices.length ? [choiceSection(source, source === 'provider' ? 'Model providers' : 'Third-party', choices, model ?? '', select)] : []
    }),
    ...(effortOptions.length ? [choiceSection('effort', 'Reasoning effort', effortOptions, effort, value => onChange({ reasoningEffort: value }))] : []),
    ...extra,
  ]
  const name = current?.label ?? 'Default model'
  const summary = EFFORT_SHORT[effort] ? `${name} · ${EFFORT_SHORT[effort]}` : name
  return <>
    <SectionChoice label={label} summary={summary} icon={<Cpu size={14} />} sections={sections} disabled={disabled} side={side} align={align} plain={plain} action={{ label: 'Add model…', onSelect: () => setAdding(true) }} />
    {adding && <ModelManager config={local ?? config} onClose={() => setAdding(false)} onChanged={next => { setLocal(next); onConfigChanged?.(next) }} onAdded={id => onChange({ model: id })} />}
  </>
}
