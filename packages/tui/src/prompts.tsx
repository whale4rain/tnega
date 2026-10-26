/**
 * Things the agent is waiting on you for: tool approvals and questions.
 * They take the keyboard from the composer until answered (design guide:
 * "waiting for you" comes first), and they are marked with the snow
 * weather's colour and a text label, never colour alone.
 */
import type { PendingQuestionRequest, QuestionAnswerItem, UserQuestion } from '@tnega/client'
import { Box, Text, useInput, usePaste } from 'ink'
import { useState } from 'react'
import type { Approval } from './controller.js'
import { color } from './theme.js'
import { truncate } from './width.js'

export function ApprovalPanel({ approval, more, onAnswer, width }: {
  approval: Approval
  /** Further approvals queued behind this one. */
  more: number
  onAnswer: (allow: boolean) => void
  width: number
}) {
  useInput((input, key) => {
    const choice = input.toLowerCase()
    // Only an explicit y allows: a stray Enter meant for the composer must not.
    if (choice === 'y') onAnswer(true)
    else if (choice === 'n' || key.escape) onAnswer(false)
  })
  const preview = previewInput(approval.input)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.warn} paddingX={1} width={width} marginTop={1}>
      <Text><Text color={color.warn}>Waiting for you</Text><Text dimColor> · approval{more ? ` (${more} more)` : ''}</Text></Text>
      <Text bold>Allow {approval.tool}{approval.via === 'run_code' ? ' from a CodeMode script' : ''}?</Text>
      {preview && <Text dimColor>{firstLines(preview, 8)}</Text>}
      <Text><Text bold>y</Text><Text dimColor> allow · </Text><Text bold>n</Text><Text dimColor> or esc deny</Text></Text>
    </Box>
  )
}

function firstLines(text: string, count: number): string {
  const lines = text.split('\n')
  return lines.length > count ? `${lines.slice(0, count).join('\n')}\n… ${lines.length - count} more lines` : text
}

/** Tool input as readable text: a shell command or path on its own, JSON otherwise. */
function previewInput(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of ['command', 'path', 'url', 'code']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
      return JSON.stringify(parsed, null, 2)
    }
  } catch {
    // Not JSON: show as is.
  }
  return input.trim()
}

/**
 * One question request, one question at a time. Options are picked with the
 * arrows (Space toggles when several may be chosen); the last row takes a
 * typed answer.
 */
export function QuestionPanel({ request, onAnswer, width }: {
  request: PendingQuestionRequest
  onAnswer: (answers: QuestionAnswerItem[]) => void
  width: number
}) {
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<QuestionAnswerItem[]>([])
  const question = request.questions[step]
  if (!question) return null
  const finish = (answer: QuestionAnswerItem | undefined) => {
    const next = answer ? [...answers, answer] : answers
    if (step + 1 >= request.questions.length) onAnswer(next)
    else {
      setAnswers(next)
      setStep(step + 1)
    }
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.warn} paddingX={1} width={width} marginTop={1}>
      <Text>
        <Text color={color.warn}>Waiting for you</Text>
        <Text dimColor> · question{request.questions.length > 1 ? ` ${step + 1} of ${request.questions.length}` : ''}</Text>
      </Text>
      {question.secret !== undefined
        ? <SecretStep key={question.id} question={question} name={question.secret} onDone={finish} />
        : <QuestionStep key={question.id} question={question} onDone={finish} width={width - 4} />}
    </Box>
  )
}

/**
 * A secret the agent asked for: typed into a masked line, never echoed.
 * Tab toggles Remember (save it for this workspace instead of this session).
 */
export function SecretStep({ question, name, onDone }: {
  question: UserQuestion
  name: string
  onDone: (answer: QuestionAnswerItem | undefined) => void
}) {
  const [text, setText] = useState('')
  const [remember, setRemember] = useState(false)
  usePaste(value => setText(current => current + value.replace(/\r?\n/g, '')))
  useInput((input, key) => {
    if (key.escape && question.optional) return onDone(undefined)
    if (key.tab) return setRemember(value => !value)
    if (key.return) {
      const typed = text.trim()
      if (!typed) {
        if (question.optional) onDone(undefined)
        return
      }
      onDone({ questionId: question.id, text: typed, ...(remember ? { remember: true } : {}) })
      return
    }
    if (key.backspace || key.delete) return setText(Array.from(text).slice(0, -1).join(''))
    if (!key.ctrl && !key.meta && input) setText(text + input)
  })
  const length = Array.from(text).length
  return (
    <Box flexDirection="column">
      <Text bold>{question.question?.trim() || `Needs ${name}`}</Text>
      <Text>› {length ? '•'.repeat(Math.min(length, 40)) : <Text dimColor>type or paste; it is not shown</Text>}<Text inverse> </Text></Text>
      <Text dimColor>
        Commands read it as ${name}; the agent never sees it. {remember ? '[x] remember for this workspace' : '[ ] this session only'}
      </Text>
      <Text dimColor>enter send · tab remember{question.optional ? ' · esc skip' : ''}</Text>
    </Box>
  )
}

function QuestionStep({ question, onDone, width }: {
  question: UserQuestion
  onDone: (answer: QuestionAnswerItem | undefined) => void
  width: number
}) {
  const options = question.options ?? []
  const typedRow = options.length
  const [index, setIndex] = useState(0)
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set())
  const [text, setText] = useState('')
  const typing = index === typedRow

  usePaste(value => {
    if (typing) setText(current => current + value.replace(/\r?\n/g, ' '))
  })
  useInput((input, key) => {
    if (key.upArrow) return setIndex(Math.max(0, index - 1))
    if (key.downArrow) return setIndex(Math.min(typedRow, index + 1))
    if (key.escape && question.optional) return onDone(undefined)
    if (key.return) {
      const selected = question.multiple ? [...chosen].sort().map(i => options[i]!.label) : typing ? [] : [options[index]!.label]
      const typed = text.trim()
      if (!selected.length && !typed) {
        if (question.optional) onDone(undefined)
        return
      }
      onDone({ questionId: question.id, ...(selected.length ? { selected } : {}), ...(typed ? { text: typed } : {}) })
      return
    }
    if (typing) {
      if (key.backspace) return setText(Array.from(text).slice(0, -1).join(''))
      if (!key.ctrl && !key.meta && !key.tab && input) setText(text + input)
      return
    }
    if (question.multiple && input === ' ') {
      const next = new Set(chosen)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      setChosen(next)
      return
    }
    const number = Number(input)
    if (Number.isInteger(number) && number >= 1 && number <= options.length) setIndex(number - 1)
  })

  return (
    <Box flexDirection="column">
      {question.question && <Text bold>{question.question}</Text>}
      {options.map((option, i) => {
        const active = i === index
        const mark = question.multiple ? (chosen.has(i) ? '[x]' : '[ ]') : `${i + 1}.`
        return (
          <Text key={option.label} inverse={active}>
            {active ? '›' : ' '} {mark} {truncate(option.label, width - 8)}
            {option.description ? <Text dimColor={!active}>  {truncate(option.description, Math.max(0, width - option.label.length - 10))}</Text> : null}
          </Text>
        )
      })}
      <Text inverse={typing}>
        {typing ? '›' : ' '} {options.length ? 'Other: ' : ''}{text || <Text dimColor>{typing ? 'type an answer' : '…'}</Text>}{typing ? <Text inverse> </Text> : null}
      </Text>
      <Text dimColor>
        ↑↓ move{question.multiple ? ' · space choose' : ''} · enter {question.multiple || typing ? 'send' : 'pick'}{question.optional ? ' · esc skip' : ''}
      </Text>
    </Box>
  )
}
