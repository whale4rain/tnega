/**
 * The typed service map.
 *
 * Every package that owns a `ctx` key augments this interface next to the
 * service it declares:
 *
 * ```ts
 * declare module '@tnega/core' {
 *   interface ServiceMap { tools: ToolsService }
 * }
 * ```
 *
 * `ctx.get(name)` resolves through it, so a service lookup is typed without a
 * hand-written assertion. The property form (`ctx.tools`) is declared next to
 * it and stays the way to read a service the plugin declares in `inject`.
 */
// The map is intentionally empty: every owning package augments it, and an
// interface (not a type alias) is what makes that declaration merging possible.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ServiceMap {}

/** Every registered service name; plugin `inject` lists are checked against it. */
export type ServiceName = keyof ServiceMap
