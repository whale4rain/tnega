import type { Context } from '@tnega/core'
import { createStreamMasker, maskSecrets, maskSecretsDeep } from '@tnega/secrets'
import type { ToolRequest, ToolStagePayload } from '@tnega/tools'

/**
 * `ctx.secrets` Consumer: keeps secret values out of what tools hand back.
 *
 * - `tools/post-execute`: masks every string in a result's output and error
 *   message. It is prepended, so it runs before any other post-execute policy
 *   (spill writes the full output to disk, which must already be masked).
 * - `tools/pre-execute`: wraps the call's `progress` stream, whose tail the
 *   host keeps durably, so live output is masked too.
 *
 * Masking catches a value and its common encodings. It keeps keys out of the
 * transcript and the model in ordinary use; it is not a wall against a
 * command written to leak one.
 */
export const toolSecrets = {
  name: 'tool-secrets',
  inject: ['tools', 'secrets'],
  apply(ctx: Context): void {
    const store = ctx.secrets
    ctx.on('tools/pre-execute', async (request: ToolRequest, next: () => unknown) => {
      const progress = request.options.progress
      if (progress) {
        const entries = await store.entries()
        if (entries.length > 0) {
          const masker = createStreamMasker(entries)
          request.options = {
            ...request.options,
            progress: output => {
              const safe = masker.push(output)
              if (safe) progress(safe)
            },
          }
        }
      }
      return next()
    }, { prepend: true })

    ctx.on('tools/post-execute', async (payload: ToolStagePayload, next: () => unknown) => {
      const entries = await store.entries()
      if (entries.length > 0) {
        const { result } = payload
        if (result.output !== undefined) result.output = maskSecretsDeep(result.output, entries)
        if (result.error) {
          const { stack } = result.error
          result.error = {
            ...result.error,
            message: maskSecrets(result.error.message, entries),
            ...(stack === undefined ? {} : { stack: maskSecrets(stack, entries) }),
          }
        }
      }
      return next()
    }, { prepend: true })
  },
}
