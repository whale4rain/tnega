/**
 * The vocabulary of agent-rendered UI: a small subset of the A2UI basic
 * catalog (https://a2ui.org), sent whole in one message.
 *
 * Like A2UI, a surface is a flat list of components that refer to each other
 * by id, a root to start from, and a data model the inputs bind to. Unlike
 * the full protocol there is no streaming of updates and no nested data:
 * a surface arrives once, every input binds to one top-level key, and a
 * button sends the whole data model back as a user message.
 *
 * Pure TypeScript, no Node or DOM: the `show_ui` tool validates with it and
 * the clients render with it, so both read a surface the same way.
 */

export const A2UI_COMPONENTS = ['Column', 'Row', 'Card', 'Text', 'Image', 'Divider', 'TextField', 'CheckBox', 'ChoicePicker', 'Button'] as const
export type A2uiComponentName = typeof A2UI_COMPONENTS[number]

export type A2uiTextVariant = 'title' | 'subtitle' | 'body' | 'caption'

export interface A2uiOption { label: string; value: string }

export type A2uiComponent =
  | { id: string; component: 'Column' | 'Row' | 'Card'; children: string[] }
  | { id: string; component: 'Text'; text: string; variant: A2uiTextVariant }
  /** `src` is a workspace-relative image path. */
  | { id: string; component: 'Image'; src: string; alt?: string }
  | { id: string; component: 'Divider' }
  | { id: string; component: 'TextField'; label?: string; path: string; placeholder?: string; multiline: boolean }
  | { id: string; component: 'CheckBox'; label: string; path: string }
  | { id: string; component: 'ChoicePicker'; label?: string; path: string; options: A2uiOption[]; multiple: boolean }
  | { id: string; component: 'Button'; label: string; action: string; variant: 'primary' | 'secondary' }

export type A2uiValue = string | boolean | string[]

export interface A2uiSurface {
  title?: string
  root: string
  /** Every component reachable from `root`, keyed by id. */
  components: Readonly<Record<string, A2uiComponent>>
  /** The initial data model: one value per bound key. */
  data: Readonly<Record<string, A2uiValue>>
}

export class A2uiError extends Error {
  override name = 'A2uiError'
}

export const A2UI_LIMITS = { components: 80, depth: 8, text: 4000, options: 20 } as const

const TEXT_VARIANTS: readonly A2uiTextVariant[] = ['title', 'subtitle', 'body', 'caption']

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, field: string, max: number = A2UI_LIMITS.text): string {
  if (typeof value !== 'string') throw new A2uiError(`${field} must be a string`)
  if (value.length > max) throw new A2uiError(`${field} is longer than ${max} characters`)
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field, 400)
}

/** A data binding: `"/plan"` (A2UI's JSON-pointer form) or `"plan"`, one level deep. */
function bindingKey(value: unknown, field: string): string {
  const raw = isRecord(value) && 'path' in value ? value.path : value
  const key = text(raw, field, 80).replace(/^\//, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new A2uiError(`${field} must name one top-level key such as "/plan"`)
  return key
}

/** A2UI writes a literal as `{ literalString: "..." }`; plain strings are accepted too. */
function literal(value: unknown): unknown {
  return isRecord(value) && 'literalString' in value ? value.literalString : value
}

function children(value: unknown, field: string): string[] {
  const list = isRecord(value) && 'explicitList' in value ? value.explicitList : value
  if (!Array.isArray(list)) throw new A2uiError(`${field} must be a list of component ids`)
  return list.map((id, index) => text(id, `${field}[${index}]`, 120))
}

function component(value: unknown, index: number): A2uiComponent {
  if (!isRecord(value)) throw new A2uiError(`components[${index}] must be an object`)
  const id = text(value.id, `components[${index}].id`, 120)
  if (!id) throw new A2uiError(`components[${index}].id must not be empty`)
  const at = `component "${id}"`
  const name = value.component
  if (typeof name !== 'string' || !(A2UI_COMPONENTS as readonly string[]).includes(name)) {
    throw new A2uiError(`${at} has unknown component ${JSON.stringify(name)}; use one of ${A2UI_COMPONENTS.join(', ')}`)
  }
  switch (name as A2uiComponentName) {
    case 'Column':
    case 'Row':
    case 'Card': {
      const kids = value.children ?? (value.child === undefined ? undefined : [value.child])
      return { id, component: name as 'Column' | 'Row' | 'Card', children: children(kids, `${at}.children`) }
    }
    case 'Text': {
      const variant = value.variant ?? value.usageHint ?? 'body'
      const known = typeof variant === 'string' && (TEXT_VARIANTS as readonly string[]).includes(variant)
        ? variant as A2uiTextVariant
        : variant === 'h1' || variant === 'h2' ? 'title' : variant === 'h3' || variant === 'h4' ? 'subtitle' : 'body'
      return { id, component: 'Text', text: text(literal(value.text), `${at}.text`), variant: known }
    }
    case 'Image': {
      const src = text(literal(value.src ?? value.url), `${at}.src`, 1000)
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) {
        throw new A2uiError(`${at}.src must be a workspace file path, not a URL`)
      }
      const alt = optionalText(literal(value.alt), `${at}.alt`)
      return { id, component: 'Image', src, ...(alt !== undefined ? { alt } : {}) }
    }
    case 'Divider':
      return { id, component: 'Divider' }
    case 'TextField': {
      const label = optionalText(literal(value.label), `${at}.label`)
      const placeholder = optionalText(literal(value.placeholder), `${at}.placeholder`)
      return {
        id, component: 'TextField',
        path: bindingKey(value.path ?? value.text, `${at}.path`),
        multiline: value.multiline === true || value.textFieldType === 'longText',
        ...(label !== undefined ? { label } : {}),
        ...(placeholder !== undefined ? { placeholder } : {}),
      }
    }
    case 'CheckBox':
      return { id, component: 'CheckBox', label: text(literal(value.label), `${at}.label`, 400), path: bindingKey(value.path ?? value.value, `${at}.path`) }
    case 'ChoicePicker': {
      if (!Array.isArray(value.options) || value.options.length === 0) throw new A2uiError(`${at}.options must list at least one option`)
      if (value.options.length > A2UI_LIMITS.options) throw new A2uiError(`${at}.options has more than ${A2UI_LIMITS.options} options`)
      const options = value.options.map((option: unknown, position: number): A2uiOption => {
        if (typeof option === 'string') return { label: option, value: option }
        if (!isRecord(option)) throw new A2uiError(`${at}.options[${position}] must be an object`)
        const label = text(literal(option.label), `${at}.options[${position}].label`, 400)
        return { label, value: option.value === undefined ? label : text(option.value, `${at}.options[${position}].value`, 400) }
      })
      const label = optionalText(literal(value.label), `${at}.label`)
      return {
        id, component: 'ChoicePicker', options,
        path: bindingKey(value.path ?? value.selections, `${at}.path`),
        multiple: value.multiple === true || value.variant === 'multipleSelection',
        ...(label !== undefined ? { label } : {}),
      }
    }
    case 'Button': {
      const rawAction = isRecord(value.action) ? value.action.name : value.action
      const action = text(rawAction, `${at}.action`, 80)
      if (!action) throw new A2uiError(`${at}.action must name the action, e.g. "submit"`)
      return {
        id, component: 'Button',
        label: text(literal(value.label), `${at}.label`, 120),
        action,
        variant: value.variant === 'secondary' || value.primary === false ? 'secondary' : 'primary',
      }
    }
  }
}

function dataValue(value: unknown, key: string): A2uiValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  throw new A2uiError(`data.${key} must be a string, a boolean or a list of strings`)
}

/**
 * Read a surface the model sent. Throws `A2uiError` with a message the model
 * can act on; the clients call it on durable tool arguments and show nothing
 * for a surface that does not parse.
 */
export function parseSurface(input: unknown): A2uiSurface {
  if (!isRecord(input)) throw new A2uiError('input must be an object')
  if (!Array.isArray(input.components) || input.components.length === 0) throw new A2uiError('components must list at least one component')
  if (input.components.length > A2UI_LIMITS.components) throw new A2uiError(`components has more than ${A2UI_LIMITS.components} entries`)
  const all = new Map<string, A2uiComponent>()
  input.components.forEach((value: unknown, index: number) => {
    const parsed = component(value, index)
    if (all.has(parsed.id)) throw new A2uiError(`component id "${parsed.id}" is used twice`)
    all.set(parsed.id, parsed)
  })
  const root = input.root === undefined ? input.components.length === 1 ? [...all.keys()][0]! : 'root' : text(input.root, 'root', 120)
  if (!all.has(root)) throw new A2uiError(`root "${root}" is not one of the components`)

  // Keep what the root reaches; each component appears once in the tree.
  const reached: Record<string, A2uiComponent> = {}
  const visit = (id: string, depth: number, from: string): void => {
    const found = all.get(id)
    if (!found) throw new A2uiError(`${from} refers to unknown component "${id}"`)
    if (reached[id]) throw new A2uiError(`component "${id}" appears twice in the tree`)
    if (depth > A2UI_LIMITS.depth) throw new A2uiError(`the tree is deeper than ${A2UI_LIMITS.depth} levels`)
    reached[id] = found
    if ('children' in found) for (const child of found.children) visit(child, depth + 1, `component "${id}"`)
  }
  visit(root, 1, 'root')

  const data: Record<string, A2uiValue> = {}
  if (input.data !== undefined) {
    if (!isRecord(input.data)) throw new A2uiError('data must be an object of initial values')
    for (const [key, value] of Object.entries(input.data)) data[key] = dataValue(value, key)
  }
  const title = input.title === undefined ? undefined : text(input.title, 'title', 200)
  return { root, components: reached, data, ...(title ? { title } : {}) }
}

/** Whether the surface waits for the person: it has a button to press. */
export function isInteractive(surface: A2uiSurface): boolean {
  return Object.values(surface.components).some(each => each.component === 'Button')
}

/** The data model a surface starts with: given values, else empty ones per input. */
export function initialValues(surface: A2uiSurface): Record<string, A2uiValue> {
  const values: Record<string, A2uiValue> = {}
  for (const each of Object.values(surface.components)) {
    if (each.component === 'TextField') values[each.path] = ''
    if (each.component === 'CheckBox') values[each.path] = false
    if (each.component === 'ChoicePicker') values[each.path] = each.multiple ? [] : ''
  }
  return { ...values, ...surface.data }
}

// ---------------------------------------------------------------------------
// The action a button sends back
// ---------------------------------------------------------------------------

/** A button press, sent to the agent as the text of a user message. */
export interface A2uiAction {
  /** The `show_ui` call that showed the surface. */
  surface: string
  action: string
  /** The button's words, so the transcript can say what was pressed. */
  label: string
  values: Record<string, A2uiValue>
}

export const A2UI_ACTION_PREFIX = '[ui-action] '

export function formatAction(action: A2uiAction): string {
  return `${A2UI_ACTION_PREFIX}${JSON.stringify(action)}`
}

/** The action in a user message, or undefined for any other text. */
export function parseAction(text: string): A2uiAction | undefined {
  if (!text.startsWith(A2UI_ACTION_PREFIX)) return undefined
  try {
    const value: unknown = JSON.parse(text.slice(A2UI_ACTION_PREFIX.length))
    if (!isRecord(value) || typeof value.surface !== 'string' || typeof value.action !== 'string' || !isRecord(value.values)) return undefined
    const values: Record<string, A2uiValue> = {}
    for (const [key, entry] of Object.entries(value.values)) {
      try { values[key] = dataValue(entry, key) } catch { /* A value the UI never sends is left out. */ }
    }
    return { surface: value.surface, action: value.action, label: typeof value.label === 'string' ? value.label : value.action, values }
  } catch {
    return undefined
  }
}
