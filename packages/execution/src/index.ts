/**
 * @deprecated The execution boundary is now the `ctx.process` seam: types and
 * the Service Definition live in `@tnega/process`, the local implementation in
 * `@tnega/process-local`. This package re-exports both for one release.
 */
export * from '@tnega/process'
export * from '@tnega/process-local'

export const name = '@tnega/execution'
