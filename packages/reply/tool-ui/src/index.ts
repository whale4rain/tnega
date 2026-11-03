import type { Context } from '@tnega/core'
import { A2uiError, A2UI_ACTION_PREFIX, A2UI_COMPONENTS, isInteractive, parseSurface } from '@tnega/a2ui'
import { ToolInputError, type ToolDefinition } from '@tnega/tools'

export const UI_TOOL_NAME = 'show_ui'

const DESCRIPTION = [
  'Show the user a small interface in the chat, built from A2UI components: a form to fill in, choices to pick, a summary card.',
  'Use it when a few clicks beat typing (pick options, confirm details, fill fields); write plain text for anything else.',
  'components is a flat list; each has an id and a component name, and layouts list their children by id. root names the top component (default "root").',
  `Components: Column/Row/Card {children: [ids]}; Text {text, variant: title|subtitle|body|caption}; Image {src: workspace image path, alt}; Divider; TextField {label, path, placeholder, multiline}; CheckBox {label, path}; ChoicePicker {label, path, options: [{label, value}], multiple}; Button {label, action, variant: primary|secondary}.`,
  'Inputs bind to a key of data with path, e.g. "/plan"; data gives initial values.',
  `When the user presses a button you receive a user message starting with ${A2UI_ACTION_PREFIX.trim()} holding the action name and every value. A surface with a button ends your turn: say what you need in text before the call, then wait.`,
].join(' ')

/** Model-facing consumer: validates a surface; the clients render it from the durable call. */
export const toolUi = {
  name: 'tool-ui',
  inject: ['tools'],
  apply(ctx: Context): void {
    const definition: ToolDefinition = {
      schema: {
        name: UI_TOOL_NAME,
        description: DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Optional heading above the surface.' },
            root: { type: 'string', description: 'Id of the top component. Defaults to "root".' },
            components: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  component: { type: 'string', enum: [...A2UI_COMPONENTS] },
                  children: { type: 'array', items: { type: 'string' } },
                  text: { type: 'string' },
                  variant: { type: 'string' },
                  src: { type: 'string' },
                  alt: { type: 'string' },
                  label: { type: 'string' },
                  path: { type: 'string' },
                  placeholder: { type: 'string' },
                  multiline: { type: 'boolean' },
                  multiple: { type: 'boolean' },
                  options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label'] } },
                  action: { type: 'string' },
                },
                required: ['id', 'component'],
              },
            },
            data: { type: 'object', description: 'Initial values of the bound keys, e.g. {"plan": "pro"}.' },
          },
          required: ['components'],
        },
      },
      metadata: { readOnly: true },
      isConcurrencySafe: () => false,
      execute(input, options) {
        let surface
        try {
          surface = parseSurface(input)
        } catch (error) {
          if (error instanceof A2uiError) throw new ToolInputError(error.message)
          throw error
        }
        const waits = isInteractive(surface)
        // A form is a question: the turn ends and the answer arrives as the next user message.
        if (waits) options.concludesTurn = true
        return {
          shown: true,
          ...(options.callId ? { surface: options.callId } : {}),
          components: Object.keys(surface.components).length,
          note: waits ? 'Shown to the user. Wait for their action; it arrives as the next user message.' : 'Shown to the user.',
        }
      },
    }
    ctx.tools.register(definition)
  },
}
