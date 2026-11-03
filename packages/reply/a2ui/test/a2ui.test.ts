import { expect, it } from 'vitest'
import { A2uiError, formatAction, initialValues, isInteractive, parseAction, parseSurface } from '../src/index.js'

const form = {
  title: 'Pick a plan',
  components: [
    { id: 'root', component: 'Column', children: ['intro', 'plan', 'notes', 'go'] },
    { id: 'intro', component: 'Text', text: 'Which plan?' },
    { id: 'plan', component: 'ChoicePicker', label: 'Plan', path: '/plan', options: [{ label: 'Free', value: 'free' }, 'Pro'] },
    { id: 'notes', component: 'TextField', label: 'Notes', path: 'notes', multiline: true },
    { id: 'go', component: 'Button', label: 'Continue', action: 'submit' },
    { id: 'unused', component: 'Divider' },
  ],
  data: { plan: 'free' },
}

it('reads a surface into the components the root reaches, with its data', () => {
  const surface = parseSurface(form)
  expect(surface.root).toBe('root')
  expect(Object.keys(surface.components)).toEqual(['root', 'intro', 'plan', 'notes', 'go'])
  expect(surface.components.plan).toMatchObject({ component: 'ChoicePicker', path: 'plan', options: [{ label: 'Free', value: 'free' }, { label: 'Pro', value: 'Pro' }] })
  expect(surface.components.intro).toMatchObject({ variant: 'body' })
  expect(isInteractive(surface)).toBe(true)
  expect(initialValues(surface)).toEqual({ plan: 'free', notes: '' })
})

it('accepts the A2UI spellings of literals, children and actions', () => {
  const surface = parseSurface({
    root: 'card',
    components: [
      { id: 'card', component: 'Card', child: 'col' },
      { id: 'col', component: 'Column', children: { explicitList: ['h', 'b'] } },
      { id: 'h', component: 'Text', text: { literalString: 'Done' }, usageHint: 'h2' },
      { id: 'b', component: 'Button', label: 'OK', action: { name: 'ok' } },
    ],
  })
  expect(surface.components.h).toMatchObject({ text: 'Done', variant: 'title' })
  expect(surface.components.b).toMatchObject({ action: 'ok', variant: 'primary' })
})

it('tells the model what is wrong with a surface', () => {
  expect(() => parseSurface({ components: [{ id: 'root', component: 'Slider' }] })).toThrow(/unknown component "Slider".*Column/)
  expect(() => parseSurface({ components: [{ id: 'root', component: 'Column', children: ['x'] }] })).toThrow(/unknown component "x"/)
  expect(() => parseSurface({ components: [{ id: 'a', component: 'Divider' }, { id: 'a', component: 'Divider' }] })).toThrow(/used twice/)
  expect(() => parseSurface({ components: [{ id: 'root', component: 'Column', children: ['root'] }] })).toThrow(/appears twice/)
  expect(() => parseSurface({ components: [{ id: 'root', component: 'Image', src: 'https://example.com/a.png' }] })).toThrow(/workspace file path/)
  expect(() => parseSurface({ components: [{ id: 'root', component: 'TextField', path: '/a/b' }] })).toThrow(/one top-level key/)
  expect(() => parseSurface({ components: [] })).toThrow(A2uiError)
})

it('a surface without a button only shows', () => {
  expect(isInteractive(parseSurface({ components: [{ id: 'only', component: 'Text', text: 'Hi' }] }))).toBe(false)
})

it('round-trips the action a button sends, and ignores other text', () => {
  const text = formatAction({ surface: 'call-1', action: 'submit', label: 'Continue', values: { plan: 'pro', agree: true, tags: ['a'] } })
  expect(text.startsWith('[ui-action] ')).toBe(true)
  expect(parseAction(text)).toEqual({ surface: 'call-1', action: 'submit', label: 'Continue', values: { plan: 'pro', agree: true, tags: ['a'] } })
  expect(parseAction('Continue please')).toBeUndefined()
  expect(parseAction('[ui-action] not json')).toBeUndefined()
})
